import fetch from "node-fetch";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { pipeline } from "stream/promises";

const BASE_URL = "https://itf-new.slu.cz";
const MAIN_URL = `${BASE_URL}/sprava-studentu/zaverecneprace/`;
const PDF_DIR = path.resolve("./PDFs");
const PROGRESS_FILE = path.join(PDF_DIR, ".processed.json");

// Number of concurrent downloads
const CONCURRENCY = 3;
// Delay between requests in ms (to be polite to the server)
const REQUEST_DELAY_MS = 300;

type ThesisMode = "bachelor" | "master" | "all";

const MODE_HEADING_PATTERNS: Record<Exclude<ThesisMode, "all">, string> = {
  bachelor: "bakalářsk",
  master: "magistersk",
};

function parseMode(arg: string | undefined): ThesisMode {
  const valid: ThesisMode[] = ["bachelor", "master", "all"];
  const aliases: Record<string, ThesisMode> = { bc: "bachelor", mgr: "master" };
  const resolved = aliases[arg ?? ""] ?? arg ?? "all";
  if (!valid.includes(resolved as ThesisMode)) {
    console.error(`Unknown mode "${arg}". Valid modes: ${valid.join(", ")} (aliases: bc, mgr)`);
    process.exit(1);
  }
  return resolved as ThesisMode;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadProgress(): Set<string> {
  try {
    const raw = fs.readFileSync(PROGRESS_FILE, "utf8");
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveProgress(processed: Set<string>): void {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify([...processed], null, 2));
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

async function downloadPDF(
  pdfUrl: string,
  index: number,
  total: number
): Promise<void> {
  // Use a HEAD request first to get the filename without downloading the body
  const head = await fetch(pdfUrl, { method: "HEAD" });
  if (!head.ok) throw new Error(`HTTP ${head.status} (HEAD) for ${pdfUrl}`);

  const disposition = head.headers.get("content-disposition");
  const fallback = sanitizeFilename(path.basename(pdfUrl)) + ".pdf";
  const rawName = filenameFromDisposition(disposition, fallback);
  const filename = sanitizeFilename(rawName);
  const filepath = path.join(PDF_DIR, filename);

  if (fs.existsSync(filepath)) {
    console.log(`[${index}/${total}] Skipping (already exists): ${filename}`);
    return;
  }

  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${pdfUrl}`);
  if (!res.body) throw new Error(`No response body for ${pdfUrl}`);

  await pipeline(res.body, fs.createWriteStream(filepath));
  console.log(`[${index}/${total}] Downloaded: ${filename}`);
}

async function processWorkDetail(
  workDetailPath: string,
  index: number,
  total: number,
  processed: Set<string>
): Promise<void> {
  if (processed.has(workDetailPath)) {
    console.log(`[${index}/${total}] Skipping (already processed): ${workDetailPath}`);
    return;
  }

  const url = `${BASE_URL}/${workDetailPath.replace(/^\//, "")}`;
  try {
    const pdfUrl = await getPDFLinkFromWorkDetail(url);
    if (!pdfUrl) {
      console.warn(`[${index}/${total}] No PDF found at: ${url}`);
    } else {
      await sleep(REQUEST_DELAY_MS);
      await downloadPDF(pdfUrl, index, total);
    }
    // Mark as processed regardless of whether a PDF was found
    processed.add(workDetailPath);
    saveProgress(processed);
  } catch (err) {
    console.error(`[${index}/${total}] Error processing ${url}: ${(err as Error).message}`);
    // Don't mark as processed on error so it retries next run
  }
}

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<void> {
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

function collectWorkDetailPaths(
  $: cheerio.Root,
  mode: ThesisMode
): { label: string; paths: string[] } {
  const patterns =
    mode === "all"
      ? Object.values(MODE_HEADING_PATTERNS)
      : [MODE_HEADING_PATTERNS[mode]];

  const paths: string[] = [];
  const matchedSections: string[] = [];

  $("h2").each((_, heading) => {
    const text = $(heading).text().trim();
    if (!patterns.some((p) => text.includes(p))) return;

    matchedSections.push(text);
    const table = $(heading).next("table");
    table.find("a[href*='workdetail']").each((_, el) => {
      const href = $(el).attr("href");
      if (href) paths.push(href);
    });
  });

  const label = matchedSections.length > 0 ? matchedSections.join(" + ") : mode;
  return { label, paths };
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv[2]);
  console.log(`Mode: ${mode}\n`);

  fs.mkdirSync(PDF_DIR, { recursive: true });

  const processed = loadProgress();
  if (processed.size > 0) {
    console.log(`Resuming — ${processed.size} entries already processed.\n`);
  }

  console.log("Fetching main page...");
  const html = await fetchPage(MAIN_URL);
  const $ = cheerio.load(html);

  const { label, paths: workDetailPaths } = collectWorkDetailPaths($, mode);

  if (workDetailPaths.length === 0) {
    console.error("No work detail links found. The page structure may have changed.");
    process.exit(1);
  }

  const remaining = workDetailPaths.filter((p) => !processed.has(p));
  console.log(
    `Found ${workDetailPaths.length} entries for [${label}], ${remaining.length} remaining. Starting downloads...\n`
  );

  const tasks = workDetailPaths.map(
    (workPath, idx) => () => processWorkDetail(workPath, idx + 1, workDetailPaths.length, processed)
  );

  await runWithConcurrency(tasks, CONCURRENCY);

  console.log("\nDone! All PDFs saved to:", PDF_DIR);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
