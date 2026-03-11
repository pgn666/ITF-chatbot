import fetch from "node-fetch";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { pipeline } from "stream/promises";

const BASE_URL = "https://itf-new.slu.cz";
const MAIN_URL = `${BASE_URL}/sprava-studentu/zaverecneprace/`;
const PDF_DIR = path.resolve("./PDFs");

// Number of concurrent downloads
const CONCURRENCY = 3;
// Delay between requests in ms (to be polite to the server)
const REQUEST_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_")
    .trim();
}

function filenameFromDisposition(disposition: string | null, fallback: string): string {
  if (disposition) {
    const match = disposition.match(/filename[^;=\n]*=(['"]*)(.*?)\1(?:;|$)/i);
    if (match) {
      const raw = match[2].trim();
      // HTTP headers are parsed as Latin-1; re-interpret as UTF-8 if the server
      // sent UTF-8 bytes (common for non-ASCII filenames outside RFC 5987 encoding).
      try {
        return Buffer.from(raw, "latin1").toString("utf8");
      } catch {
        return raw;
      }
    }
  }
  return fallback;
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function getPDFLinkFromWorkDetail(workDetailUrl: string): Promise<string | null> {
  const html = await fetchPage(workDetailUrl);
  const $ = cheerio.load(html);

  // PDF links follow the pattern: api/ItfModule-Students-Student/file-download/<id>
  let pdfHref: string | null = null;
  $("a[href*='file-download']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      pdfHref = href.startsWith("http") ? href : `${BASE_URL}/${href.replace(/^\//, "")}`;
      return false; // take first match
    }
  });

  return pdfHref;
}

async function downloadPDF(pdfUrl: string, index: number, total: number): Promise<void> {
  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${pdfUrl}`);

  const disposition = res.headers.get("content-disposition");
  const fallback = sanitizeFilename(path.basename(pdfUrl)) + ".pdf";
  const rawName = filenameFromDisposition(disposition, fallback);
  const filename = sanitizeFilename(rawName);
  const filepath = path.join(PDF_DIR, filename);

  if (fs.existsSync(filepath)) {
    console.log(`[${index}/${total}] Skipping (already exists): ${filename}`);
    return;
  }

  if (!res.body) throw new Error(`No response body for ${pdfUrl}`);
  await pipeline(res.body, fs.createWriteStream(filepath));
  console.log(`[${index}/${total}] Downloaded: ${filename}`);
}

async function processWorkDetail(
  workDetailPath: string,
  index: number,
  total: number
): Promise<void> {
  const url = `${BASE_URL}/${workDetailPath.replace(/^\//, "")}`;
  try {
    const pdfUrl = await getPDFLinkFromWorkDetail(url);
    if (!pdfUrl) {
      console.warn(`[${index}/${total}] No PDF found at: ${url}`);
      return;
    }
    await sleep(REQUEST_DELAY_MS);
    await downloadPDF(pdfUrl, index, total);
  } catch (err) {
    console.error(`[${index}/${total}] Error processing ${url}: ${(err as Error).message}`);
  }
}

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<void> {
  const results: Promise<T>[] = [];
  let i = 0;

  async function run(): Promise<void> {
    while (i < tasks.length) {
      const task = tasks[i++];
      await task();
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const workers = Array.from({ length: concurrency }, run);
  await Promise.all(workers);
}

async function main(): Promise<void> {
  fs.mkdirSync(PDF_DIR, { recursive: true });

  console.log("Fetching main page...");
  const html = await fetchPage(MAIN_URL);
  const $ = cheerio.load(html);

  // Find the "Teoretické bakalářské práce" section and collect its table's workdetail links
  const workDetailPaths: string[] = [];

  // Walk through h2 headings to find the bachelor theses section
  $("h2").each((_, heading) => {
    const text = $(heading).text().trim();
    if (!text.includes("bakalářské")) return;

    // The table immediately follows this h2
    const table = $(heading).next("table");
    table.find("a[href*='workdetail']").each((_, el) => {
      const href = $(el).attr("href");
      if (href) workDetailPaths.push(href);
    });
  });

  if (workDetailPaths.length === 0) {
    console.error("No work detail links found. The page structure may have changed.");
    process.exit(1);
  }

  const total = workDetailPaths.length;
  console.log(`Found ${total} bachelor thesis entries. Starting downloads...\n`);

  const tasks = workDetailPaths.map(
    (workPath, idx) => () => processWorkDetail(workPath, idx + 1, total)
  );

  await runWithConcurrency(tasks, CONCURRENCY);

  console.log("\nDone! All PDFs saved to:", PDF_DIR);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
