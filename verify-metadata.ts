import * as fs from "fs";
import * as path from "path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const PDF_DIR = path.resolve("./PDFs");
const LLM_BASE_URL = process.env.LLM_URL || "http://localhost:1234/v1";
const MAX_PAGES = 15;
const MAX_TEXT_CHARS = 12_000;

interface ThesisMetadata {
  id: string;
  title: string;
  autor: string;
  type: string;
  vedouci: string;
  oponent: string;
  inventarniCislo: string;
  rok: string;
  abstract: string | null;
  keywords: string[] | null;
  englishTitle: string | null;
}

interface LLMExtracted {
  title?: string;
  autor?: string;
  abstract?: string;
  keywords?: string[];
  englishTitle?: string;
  type?: string;
  rok?: string;
}

// ── PDF text extraction (reuses project pattern, limited to first N pages) ──

async function extractTextFromPdf(pdfPath: string): Promise<string> {
  const buf = fs.readFileSync(pdfPath);
  const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;

  const pagesToRead = Math.min(doc.numPages, MAX_PAGES);
  const chunks: string[] = [];
  let totalLen = 0;

  for (let p = 1; p <= pagesToRead; p++) {
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
    console.log(`Connected to LM Studio. Available models: ${data.data?.length ?? 0}`);
    return true;
  } catch {
    return false;
  }
}

async function queryLLM(pdfText: string): Promise<LLMExtracted> {
  const systemPrompt = `You are a metadata extraction assistant. You will receive the text content extracted from a university thesis PDF (first pages). Your job is to extract the following metadata fields from the text:

- title: the thesis title (in the original language, usually Czech/Polish/Slovak)
- autor: the author's full name
- abstract: the ENGLISH abstract only (not Czech/Slovak "abstrakt")
- keywords: an array of ENGLISH keywords only
- englishTitle: the English translation of the thesis title (if present in the PDF)
- type: the type of thesis (e.g. "Bakalářská práce", "Diplomová práce")
- rok: the year of submission

Respond ONLY with a valid JSON object containing these fields. If you cannot determine a field, set it to null. For keywords, use an array or null. Do not include any explanation, markdown fences, or extra text — only the raw JSON object.`;

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
      max_tokens: 2000,
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

  const jsonStr = raw.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    return JSON.parse(jsonStr) as LLMExtracted;
  } catch {
    throw new Error(`Failed to parse LLM JSON: ${jsonStr.substring(0, 200)}`);
  }
}

// ── Comparison ──

function normalizeStr(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function stringsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeStr(a) === normalizeStr(b);
}

function keywordsMatch(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const sortedA = a.map((k) => k.trim().toLowerCase()).sort();
  const sortedB = b.map((k) => k.trim().toLowerCase()).sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

interface Difference {
  field: string;
  original: unknown;
  llm: unknown;
}

function findDifferences(existing: ThesisMetadata, llm: LLMExtracted): Difference[] {
  const diffs: Difference[] = [];

  const stringFields: Array<[keyof LLMExtracted, keyof ThesisMetadata]> = [
    ["title", "title"],
    ["autor", "autor"],
    ["abstract", "abstract"],
    ["englishTitle", "englishTitle"],
    ["type", "type"],
    ["rok", "rok"],
  ];

  for (const [llmKey, metaKey] of stringFields) {
    const llmVal = llm[llmKey];
    const metaVal = existing[metaKey];

    if (llmVal == null) continue;

    if (typeof llmVal === "string" && !stringsMatch(llmVal, metaVal as string)) {
      diffs.push({ field: metaKey, original: metaVal, llm: llmVal });
    }
  }

  if (llm.keywords != null && !keywordsMatch(existing.keywords, llm.keywords)) {
    diffs.push({ field: "keywords", original: existing.keywords, llm: llm.keywords });
  }

  return diffs;
}

// ── Results tracking ──

const RESULTS_PATH = path.resolve("./verify-results.json");

interface VerifyResults {
  lastRun: string;
  processed: string[];
  withDiffs: string[];
  matching: string[];
  skipped: string[];
  errors: { id: string; message: string }[];
}

function loadPreviousResults(): VerifyResults | null {
  if (!fs.existsSync(RESULTS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8")) as VerifyResults;
  } catch {
    return null;
  }
}

// ── Main ──

async function main(): Promise<void> {
  const errorsOnly = process.argv.includes("--errors-only");

  const connected = await checkLLMConnection();
  if (!connected) {
    console.error(
      `Cannot connect to LM Studio at ${LLM_BASE_URL}.\n` +
        "Make sure LM Studio is running with a model loaded.\n" +
        "You can override the URL with: LLM_URL=http://host:port/v1 pnpm verify-metadata"
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
    subdirs = prev.errors.map((e) => e.id).sort((a, b) => Number(a) - Number(b));
    console.log(`--errors-only: reprocessing ${subdirs.length} previously errored folders.\n`);
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

  const results: VerifyResults = {
    lastRun: new Date().toISOString(),
    processed: [],
    withDiffs: [],
    matching: [],
    skipped: [],
    errors: [],
  };

  // When running --errors-only, merge with previous results so we don't lose data
  const prevResults = errorsOnly ? loadPreviousResults() : null;
  if (prevResults) {
    results.processed = [...prevResults.processed];
    results.withDiffs = [...prevResults.withDiffs];
    results.matching = [...prevResults.matching];
    results.skipped = [...prevResults.skipped];
    // errors will be rebuilt from scratch for the retried folders
  }

  for (const dir of subdirs) {
    const dirPath = path.join(PDF_DIR, dir);
    const metaPath = path.join(dirPath, "metadata.json");
    const aiMetaPath = path.join(dirPath, "AI-metadata.json");

    if (!fs.existsSync(metaPath)) {
      console.log(`[${dir}] No metadata.json, skipping.`);
      if (!results.skipped.includes(dir)) results.skipped.push(dir);
      continue;
    }

    const pdfFiles = fs.readdirSync(dirPath).filter((f) => f.toLowerCase().endsWith(".pdf"));
    if (pdfFiles.length === 0) {
      console.log(`[${dir}] No PDF file, skipping.`);
      if (!results.skipped.includes(dir)) results.skipped.push(dir);
      continue;
    }

    if (fs.existsSync(aiMetaPath)) {
      console.log(`[${dir}] AI-metadata.json already exists, skipping.`);
      if (!results.skipped.includes(dir)) results.skipped.push(dir);
      continue;
    }

    const meta: ThesisMetadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const pdfPath = path.join(dirPath, pdfFiles[0]);

    try {
      console.log(`[${dir}] Extracting text from PDF…`);
      const pdfText = await extractTextFromPdf(pdfPath);

      console.log(`[${dir}] Querying LLM (${pdfText.length} chars)…`);
      const llmResult = await queryLLM(pdfText);

      const diffs = findDifferences(meta, llmResult);

      if (diffs.length > 0) {
        const aiMeta: Record<string, unknown> = {
          _source: "LLM verification",
          _verifiedAt: new Date().toISOString(),
          _differencesFound: diffs.length,
        };
        for (const d of diffs) {
          aiMeta[d.field] = d.llm;
        }

        fs.writeFileSync(aiMetaPath, JSON.stringify(aiMeta, null, 2), "utf8");
        results.withDiffs.push(dir);

        const fieldNames = diffs.map((d) => d.field).join(", ");
        console.log(`[${dir}] Differences found in: ${fieldNames} → wrote AI-metadata.json`);
      } else {
        results.matching.push(dir);
        console.log(`[${dir}] All metadata matches. No AI-metadata.json needed.`);
      }

      results.processed.push(dir);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[${dir}] Error: ${msg}`);
      results.errors.push({ id: dir, message: msg });
    }
  }

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2), "utf8");

  console.log(
    `\nDone! Processed: ${results.processed.length}, skipped: ${results.skipped.length}, ` +
      `with differences: ${results.withDiffs.length}, matching: ${results.matching.length}, ` +
      `errors: ${results.errors.length}`
  );
  console.log(`Results saved to ${RESULTS_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
