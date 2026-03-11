import * as fs from "fs";
import * as path from "path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const PDF_DIR = path.resolve("./PDFs");
const LLM_BASE_URL = process.env.LLM_URL || "http://localhost:1234/v1";
const LAST_PAGES = 10;
const MAX_TEXT_CHARS = 10_000;

interface BibliographyEntry {
  author: string | null;
  title: string | null;
  publisher: string | null;
  city: string | null;
  year: string | null;
}

interface BibliographyResult {
  _source: string;
  _extractedAt: string;
  _entriesFound: number;
  bibliography: BibliographyEntry[];
}

// ── PDF text extraction (last N pages — bibliography sits at the end) ──

async function extractTailTextFromPdf(
  pdfPath: string,
  lastPages: number = LAST_PAGES,
): Promise<string> {
  const buf = fs.readFileSync(pdfPath);
  const doc = await getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    verbosity: 0,
  }).promise;

  const startPage = Math.max(1, doc.numPages - lastPages + 1);
  const chunks: string[] = [];
  let totalLen = 0;

  for (let p = startPage; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = (content.items as Array<{ str?: string }>)
      .filter((i) => i.str && i.str.trim())
      .map((i) => i.str)
      .join(" ");
    chunks.push(text);
    totalLen += text.length;
    if (totalLen >= MAX_TEXT_CHARS) break;
  }

  return chunks.join("\n\n").substring(0, MAX_TEXT_CHARS);
}

// ── LM Studio API ──

async function checkLLMConnection(): Promise<boolean> {
  try {
    const res = await fetch(`${LLM_BASE_URL}/models`);
    if (!res.ok) return false;
    const data = (await res.json()) as { data?: unknown[] };
    console.log(
      `Connected to LM Studio. Available models: ${data.data?.length ?? 0}`,
    );
    return true;
  } catch {
    return false;
  }
}

async function queryLLMForBibliography(
  pdfText: string,
): Promise<BibliographyEntry[]> {
  const systemPrompt = `You are a bibliography extraction assistant. You will receive text from the end pages of a Czech/Slovak/Polish university thesis PDF.

Your task:
1. Locate the bibliography/references section. It may be titled "BIBLIOGRAFIE", "Použitá literatura", "Seznam literatury", "SEZNAM LITERATURY", "Seznam použité literatury", "Literatura", "Zdroje", "Použité zdroje", "POUŽITÉ ZDROJE", "Prameny a literatura", "References", "Bibliography", or similar.
2. Extract EVERY bibliographic entry from that section into a structured JSON array.
3. For each entry, extract these fields (set to null if not determinable):
   - "author": Author name(s), e.g. "Barthes, R." or "Birgus, V., Vojtěchovský, M."
   - "title": The title of the book, article, or work
   - "publisher": The publisher name
   - "city": The city of publication
   - "year": The year of publication as a string

Important rules:
- Only extract entries from the bibliography/references section, NOT from footnotes, index of names, appendices, or body text.
- If the bibliography has subsections (e.g. "Knižní publikace", "Články z periodik", "Katalogy k výstavám", "Online zdroje"), include entries from ALL subsections.
- Skip pure URLs that are not part of a bibliographic entry.
- For journal articles, "publisher" should be the journal/periodical name.
- If no bibliography section is found at all, return an empty array.
- Respond ONLY with a valid JSON array of objects. No markdown fences, no explanation, no extra text — only the raw JSON array.`;

  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local-model",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: pdfText },
      ],
      temperature: 0.1,
      max_tokens: 8000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const raw = data.choices[0]?.message?.content?.trim();
  if (!raw) throw new Error("Empty LLM response");

  const jsonStr = raw
    .replace(/^```json?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      throw new Error("LLM response is not an array");
    }
    return parsed as BibliographyEntry[];
  } catch {
    throw new Error(`Failed to parse LLM JSON: ${jsonStr.substring(0, 300)}`);
  }
}

// ── Results tracking ──

const RESULTS_PATH = path.resolve("./bibliography-results.json");

interface ExtractResults {
  lastRun: string;
  processed: string[];
  withEntries: string[];
  empty: string[];
  skipped: string[];
  errors: { id: string; message: string }[];
}

function loadPreviousResults(): ExtractResults | null {
  if (!fs.existsSync(RESULTS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8")) as ExtractResults;
  } catch {
    return null;
  }
}

function saveResults(results: ExtractResults): void {
  results.lastRun = new Date().toISOString();
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2), "utf8");
}

// ── Main ──

async function main(): Promise<void> {
  const errorsOnly = process.argv.includes("--errors-only");
  const force = process.argv.includes("--force");

  const connected = await checkLLMConnection();
  if (!connected) {
    console.error(
      `Cannot connect to LM Studio at ${LLM_BASE_URL}.\n` +
        "Make sure LM Studio is running with a model loaded.\n" +
        "You can override the URL with: LLM_URL=http://host:port/v1 pnpm extract-bibliography",
    );
    process.exit(1);
  }

  let subdirs: string[];

  if (errorsOnly) {
    const prev = loadPreviousResults();
    if (!prev || prev.errors.length === 0) {
      console.log("No previous errors found. Nothing to reprocess.");
      return;
    }
    subdirs = prev.errors
      .map((e) => e.id)
      .sort((a, b) => Number(a) - Number(b));
    console.log(
      `--errors-only: reprocessing ${subdirs.length} previously errored folders.\n`,
    );
  } else {
    subdirs = fs
      .readdirSync(PDF_DIR)
      .filter((name) => {
        const full = path.join(PDF_DIR, name);
        return fs.statSync(full).isDirectory() && /^\d+$/.test(name);
      })
      .sort((a, b) => Number(a) - Number(b));
    console.log(`Found ${subdirs.length} thesis folders.\n`);
  }

  const results: ExtractResults = {
    lastRun: new Date().toISOString(),
    processed: [],
    withEntries: [],
    empty: [],
    skipped: [],
    errors: [],
  };

  const prevResults = errorsOnly ? loadPreviousResults() : null;
  if (prevResults) {
    results.processed = [...prevResults.processed];
    results.withEntries = [...prevResults.withEntries];
    results.empty = [...prevResults.empty];
    results.skipped = [...prevResults.skipped];
  }

  for (const dir of subdirs) {
    const dirPath = path.join(PDF_DIR, dir);
    const bibPath = path.join(dirPath, "AI-bibliography.json");

    const pdfFiles = fs
      .readdirSync(dirPath)
      .filter((f) => f.toLowerCase().endsWith(".pdf"));
    if (pdfFiles.length === 0) {
      console.log(`[${dir}] No PDF file, skipping.`);
      if (!results.skipped.includes(dir)) results.skipped.push(dir);
      saveResults(results);
      continue;
    }

    if (fs.existsSync(bibPath) && !force) {
      console.log(
        `[${dir}] AI-bibliography.json already exists, skipping. (use --force to re-extract)`,
      );
      if (!results.skipped.includes(dir)) results.skipped.push(dir);
      saveResults(results);
      continue;
    }

    const pdfPath = path.join(dirPath, pdfFiles[0]);

    try {
      console.log(`[${dir}] Extracting tail text from PDF…`);
      let pdfText = await extractTailTextFromPdf(pdfPath);

      if (pdfText.trim().length < 50) {
        console.log(
          `[${dir}] Too little extractable text (${pdfText.trim().length} chars), skipping.`,
        );
        if (!results.skipped.includes(dir)) results.skipped.push(dir);
        saveResults(results);
        continue;
      }

      console.log(
        `[${dir}] Querying LLM for bibliography (${pdfText.length} chars)…`,
      );
      let entries: BibliographyEntry[];
      try {
        entries = await queryLLMForBibliography(pdfText);
      } catch (firstErr) {
        const errMsg = (firstErr as Error).message;
        if (
          errMsg.includes("tokens to keep") ||
          errMsg.includes("context length")
        ) {
          const RETRY_PAGES = 5;
          console.log(
            `[${dir}] Context too long, retrying with last ${RETRY_PAGES} pages…`,
          );
          pdfText = await extractTailTextFromPdf(pdfPath, RETRY_PAGES);
          console.log(`[${dir}] Retrying LLM query (${pdfText.length} chars)…`);
          entries = await queryLLMForBibliography(pdfText);
        } else {
          throw firstErr;
        }
      }

      const output: BibliographyResult = {
        _source: "LLM bibliography extraction",
        _extractedAt: new Date().toISOString(),
        _entriesFound: entries.length,
        bibliography: entries,
      };

      fs.writeFileSync(bibPath, JSON.stringify(output, null, 2), "utf8");
      results.processed.push(dir);

      if (entries.length > 0) {
        results.withEntries.push(dir);
        console.log(
          `[${dir}] Extracted ${entries.length} bibliography entries → wrote AI-bibliography.json`,
        );
      } else {
        results.empty.push(dir);
        console.log(
          `[${dir}] No bibliography found → wrote AI-bibliography.json (empty)`,
        );
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[${dir}] Error: ${msg}`);
      results.errors.push({ id: dir, message: msg });
    }

    saveResults(results);
  }

  console.log(
    `\nDone! Processed: ${results.processed.length}, skipped: ${results.skipped.length}, ` +
      `with entries: ${results.withEntries.length}, empty: ${results.empty.length}, ` +
      `errors: ${results.errors.length}`,
  );
  console.log(`Results saved to ${RESULTS_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
