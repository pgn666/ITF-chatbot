import * as fs from "fs";
import * as path from "path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const PDF_DIR = path.resolve("./PDFs");

async function extractTextFromPdf(pdfPath: string): Promise<string[]> {
  const buf = fs.readFileSync(pdfPath);
  const uint8 = new Uint8Array(buf);
  const doc = await getDocument({ data: uint8, useSystemFonts: true }).promise;

  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = (content.items as Array<{ str?: string }>)
      .filter((i) => i.str && i.str.trim())
      .map((i) => i.str)
      .join(" ");
    pages.push(text);
  }

  return pages;
}

// JS \b doesn't handle Unicode word boundaries, so we use a lookahead instead
const STOP_HEADERS =
  /(?:^|\s)(ABSTRAKT|KLÍČOVÁ SLOVA|KEYWORDS|PROHLÁŠENÍ|PROHLASENI|SOUHLAS|PODĚKOVÁNÍ|PODEKOVANI|OBSAH|ÚVOD|UVOD|DECLARATION|TABLE OF CONTENTS|CONTENTS)(?:\s|:|$)/i;

function extractAbstractAndKeywords(pages: string[]): {
  abstract: string | null;
  keywords: string[] | null;
} {
  // Join all pages, using double-newline as page separator for clean splitting
  const fullText = pages.join("\n\n");

  // Match only the English headers — ABSTRACT (not ABSTRAKT) and KEYWORDS (not KLÍČOVÁ SLOVA)
  const abstractMatch = fullText.match(/(?:^|\s)ABSTRACT\s*:?\s*/i);
  const keywordsMatch = fullText.match(/(?:^|\s)KEYWORDS\s*:?\s*/i);

  let abstract: string | null = null;
  let keywords: string[] | null = null;

  if (abstractMatch) {
    const start = abstractMatch.index! + abstractMatch[0].length;
    const rest = fullText.substring(start);
    const end = rest.search(STOP_HEADERS);
    const raw = end !== -1 ? rest.substring(0, end) : rest.substring(0, 2000);
    abstract = cleanText(raw);
  }

  if (keywordsMatch) {
    const start = keywordsMatch.index! + keywordsMatch[0].length;
    const rest = fullText.substring(start);
    // Keywords never span pages, so also stop at page boundaries (double newline)
    const pageEnd = rest.indexOf("\n\n");
    const headerEnd = rest.search(STOP_HEADERS);
    const ends = [pageEnd, headerEnd].filter((e) => e !== -1);
    const end = ends.length ? Math.min(...ends) : 500;
    const raw = rest.substring(0, end);
    const cleaned = cleanText(raw);
    if (cleaned) {
      keywords = cleaned
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
    }
  }

  return { abstract: abstract || null, keywords: keywords?.length ? keywords : null };
}

function cleanText(raw: string): string {
  return raw
    .replace(/\n{2,}/g, " ")       // collapse page breaks
    .replace(/([a-záčďéěíňóřšťúůýž])- ([a-záčďéěíňóřšťúůýž])/gi, "$1$2") // rejoin hyphenated words
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function main(): Promise<void> {
  const subdirs = fs
    .readdirSync(PDF_DIR)
    .filter((name) => {
      const full = path.join(PDF_DIR, name);
      return fs.statSync(full).isDirectory() && /^\d+$/.test(name);
    })
    .sort((a, b) => Number(a) - Number(b));

  console.log(`Found ${subdirs.length} thesis folders.\n`);

  let processed = 0;
  let withAbstract = 0;
  let withKeywords = 0;
  let skipped = 0;

  for (const dir of subdirs) {
    const dirPath = path.join(PDF_DIR, dir);
    const metaPath = path.join(dirPath, "metadata.json");

    if (!fs.existsSync(metaPath)) {
      console.log(`[${dir}] No metadata.json, skipping.`);
      skipped++;
      continue;
    }

    const pdfFiles = fs.readdirSync(dirPath).filter((f) => f.toLowerCase().endsWith(".pdf"));
    if (pdfFiles.length === 0) {
      console.log(`[${dir}] No PDF file, skipping.`);
      skipped++;
      continue;
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

    if (meta.abstract !== undefined && meta.keywords !== undefined) {
      console.log(`[${dir}] Already processed, skipping.`);
      skipped++;
      continue;
    }

    const pdfPath = path.join(dirPath, pdfFiles[0]);

    try {
      const pages = await extractTextFromPdf(pdfPath);
      const { abstract, keywords } = extractAbstractAndKeywords(pages);

      meta.abstract = abstract;
      meta.keywords = keywords;

      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

      if (abstract) withAbstract++;
      if (keywords) withKeywords++;
      processed++;

      const preview = abstract ? abstract.substring(0, 80) + "…" : "(not found)";
      console.log(`[${dir}] ${preview}`);
    } catch (err) {
      console.error(`[${dir}] Error: ${(err as Error).message}`);
      meta.abstract = null;
      meta.keywords = null;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
      processed++;
    }
  }

  console.log(
    `\nDone! Processed: ${processed}, skipped: ${skipped}, with abstract: ${withAbstract}, with keywords: ${withKeywords}`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
