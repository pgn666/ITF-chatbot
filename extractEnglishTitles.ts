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

function cleanText(raw: string): string {
  return raw
    .replace(/\n{2,}/g, " ")
    .replace(/([a-záčďéěíňóřšťúůýž])- ([a-záčďéěíňóřšťúůýž])/gi, "$1$2")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeCzechText(text: string): boolean {
  const czechSpecific = /[ěščřžůňďťĚŠČŘŽŮŇĎŤ]/g;
  const matches = text.match(czechSpecific);
  if (!matches) return false;
  const letters = text.replace(/[^a-záéíóúýàèìòùâêîôûäëïöüãõñåæøěščřžůňďťĚŠČŘŽŮŇĎŤ]/gi, "");
  return letters.length > 0 && matches.length / letters.length > 0.04;
}

function startsWithCzechWord(text: string): boolean {
  return /^(?:Tato|Tuto|Tento|Tyto|Tito|Smyslem|Cílem|Úvod)\s/i.test(text);
}

function extractEnglishTitle(
  pages: string[],
  czechTitle: string,
  authorName: string
): string | null {
  if (!czechTitle) return null;

  const searchText = pages.slice(0, 15).join("\n\n");

  // Strategy 1: explicit label in the assignment section
  // Handles both "Téma práce anglicky:" and "Název tématu anglicky:"
  const temaMatch = searchText.match(
    /(?:Téma\s+práce\s+anglicky|Název\s+tématu\s+anglicky)\s*:\s*/i
  );
  if (temaMatch) {
    const start = temaMatch.index! + temaMatch[0].length;
    const rest = searchText.substring(start);
    // Stop at the next assignment-section field (using (?:^|\s) because JS \b breaks on Unicode)
    const end = rest.search(
      /(?:^|\s)(?:Zadání|Literatura|Vedoucí|Oponent|Datum\s+zadání|Souhlasím|Prof\.|doc\.)/i
    );
    const raw = end !== -1 ? rest.substring(0, end) : rest.substring(0, 500);
    const cleaned = cleanText(raw);
    if (cleaned) return cleaned;
  }

  // Strategy 2: English title directly follows Czech title on a title page
  const titleRe = new RegExp(
    escapeRegex(czechTitle.trim()).replace(/\s+/g, "\\s+"),
    "i"
  );

  const authorParts = (authorName || "").trim().split(/\s+/).filter(Boolean);
  const authorRe =
    authorParts.length >= 2
      ? new RegExp(authorParts.map((p) => escapeRegex(p)).join("\\s+"), "i")
      : null;

  const stopPatterns: RegExp[] = [
    /(?:^|\s)(?:Teoretická|Bakalářská|Diplomová|Magisterská|Dizertační|Opava\s+\d|Praha\s+\d|Brno\s+\d)/i,
    /(?:^|\s)(?:vedoucí|Obor:|TÉMA|NÁZEV)/i,
    /(?:^|\s)(?:Ing\.|Mgr\.|MgA\.|doc\.|Prof\.|PhDr\.|RNDr\.)/i,
    /\b(?:19|20)\d{2}\b/,
  ];

  for (let i = 0; i < Math.min(pages.length, 5); i++) {
    const titleMatch = titleRe.exec(pages[i]);
    if (!titleMatch) continue;

    const afterTitle = pages[i].substring(
      titleMatch.index + titleMatch[0].length
    );

    let end = Math.min(afterTitle.length, 300);
    if (authorRe) {
      const am = authorRe.exec(afterTitle);
      if (am && am.index! < end) end = am.index!;
    }
    for (const pat of stopPatterns) {
      const m = afterTitle.match(pat);
      if (m && m.index! < end) end = m.index!;
    }

    const candidate = cleanText(afterTitle.substring(0, end));
    if (
      candidate &&
      candidate.split(/\s+/).length >= 3 &&
      candidate.toLowerCase() !== czechTitle.trim().toLowerCase() &&
      !looksLikeCzechText(candidate) &&
      !startsWithCzechWord(candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

async function main(): Promise<void> {
  const targetId = process.argv[2];

  let subdirs: string[];
  if (targetId) {
    const dirPath = path.join(PDF_DIR, targetId);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      console.error(`Folder PDFs/${targetId} does not exist.`);
      process.exit(1);
    }
    subdirs = [targetId];
    console.log(`Processing single folder: ${targetId}\n`);
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

  let processed = 0;
  let found = 0;
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

    if (meta.englishTitle !== undefined && meta.englishTitle !== null) {
      console.log(`[${dir}] Already has englishTitle, skipping.`);
      skipped++;
      continue;
    }

    const pdfPath = path.join(dirPath, pdfFiles[0]);

    try {
      const pages = await extractTextFromPdf(pdfPath);
      const englishTitle = extractEnglishTitle(pages, meta.title || "", meta.autor || "");

      meta.englishTitle = englishTitle;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

      if (englishTitle) found++;
      processed++;

      const preview = englishTitle ? `"${englishTitle}"` : "(not found)";
      console.log(`[${dir}] ${preview}`);
    } catch (err) {
      console.error(`[${dir}] Error: ${(err as Error).message}`);
      meta.englishTitle = null;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
      processed++;
    }
  }

  console.log(
    `\nDone! Processed: ${processed}, skipped: ${skipped}, found english title: ${found}`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
