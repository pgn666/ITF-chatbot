import fetch from "node-fetch";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = "https://itf-new.slu.cz";
const MAIN_URL = `${BASE_URL}/sprava-studentu/zaverecneprace/`;
const PDF_DIR = path.resolve("./PDFs");
const PROGRESS_FILE = path.join(PDF_DIR, ".organized.json");

const CONCURRENCY = 3;
const REQUEST_DELAY_MS = 500;

interface ThesisMetadata {
  id: string;
  title: string;
  autor: string;
  type: string;
  vedouci: string;
  oponent: string;
  inventarniCislo: string;
  rok: string;
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

function scrapeMetadata($: cheerio.CheerioAPI, id: string): ThesisMetadata {
  const meta: ThesisMetadata = {
    id,
    title: "",
    autor: "",
    type: "",
    vedouci: "",
    oponent: "",
    inventarniCislo: "",
    rok: "",
  };

  const colDiv = $("div.col").first();
  if (!colDiv.length) return meta;

  const h3Text = colDiv.find("h3").first().text().trim();
  const colonIdx = h3Text.indexOf(":");
  if (colonIdx !== -1) {
    meta.title = h3Text.substring(colonIdx + 1).trim();
  } else {
    meta.title = h3Text;
  }

  const p = colDiv.find("p").first();
  if (!p.length) return meta;

  const html = p.html() ?? "";
  const lines = html
    .split(/<br\s*\/?>/)
    .map((line) => cheerio.load(line).text().trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith("Autor:")) {
      meta.autor = line.replace(/^Autor:\s*/, "").trim();
    } else if (line.startsWith("Vedoucí:")) {
      meta.vedouci = line.replace(/^Vedoucí:\s*/, "").trim();
    } else if (line.startsWith("Oponent:")) {
      meta.oponent = line.replace(/^Oponent:\s*/, "").trim();
    } else if (line.startsWith("Inventární číslo:")) {
      meta.inventarniCislo = line.replace(/^Inventární číslo:\s*/, "").trim();
    } else if (line.startsWith("Rok:")) {
      meta.rok = line.replace(/^Rok:\s*/, "").trim();
    } else if (
      !line.startsWith("Autor:") &&
      !line.startsWith("Vedoucí:") &&
      !line.startsWith("Oponent:") &&
      !line.startsWith("Inventární") &&
      !line.startsWith("Rok:")
    ) {
      // Lines without a label prefix are the thesis type
      if (!meta.type) meta.type = line;
    }
  }

  return meta;
}

async function processWorkDetail(
  workDetailPath: string,
  index: number,
  total: number,
  processed: Set<string>
): Promise<void> {
  if (processed.has(workDetailPath)) {
    console.log(`[${index}/${total}] Skipping (already organized): ${workDetailPath}`);
    return;
  }

  const idMatch = workDetailPath.match(/workdetail\/(\d+)$/);
  if (!idMatch) {
    console.warn(`[${index}/${total}] Cannot extract ID from: ${workDetailPath}`);
    return;
  }
  const id = idMatch[1];
  const url = `${BASE_URL}/${workDetailPath.replace(/^\//, "")}`;

  try {
    const html = await fetchPage(url);
    const $ = cheerio.load(html);

    const metadata = scrapeMetadata($, id);
    const targetDir = path.join(PDF_DIR, id);
    fs.mkdirSync(targetDir, { recursive: true });

    // Find the PDF download link and resolve the filename
    let pdfHref: string | null = null;
    $("a[href*='file-download']").each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        pdfHref = href.startsWith("http") ? href : `${BASE_URL}/${href.replace(/^\//, "")}`;
        return false;
      }
    });

    if (pdfHref) {
      await sleep(REQUEST_DELAY_MS);
      try {
        const head = await fetch(pdfHref, { method: "HEAD" });
        if (head.ok) {
          const disposition = head.headers.get("content-disposition");
          const fallback = sanitizeFilename(path.basename(pdfHref)) + ".pdf";
          const rawName = filenameFromDisposition(disposition, fallback);
          const filename = sanitizeFilename(rawName);

          const currentPath = path.join(PDF_DIR, filename);
          const newPath = path.join(targetDir, filename);

          if (fs.existsSync(currentPath) && !fs.existsSync(newPath)) {
            fs.renameSync(currentPath, newPath);
            console.log(`[${index}/${total}] Moved: ${filename} -> ${id}/${filename}`);
          } else if (fs.existsSync(newPath)) {
            console.log(`[${index}/${total}] PDF already in place: ${id}/${filename}`);
          } else {
            console.log(`[${index}/${total}] PDF not found locally: ${filename}`);
          }
        }
      } catch (err) {
        console.warn(`[${index}/${total}] Could not resolve PDF filename for ${id}: ${(err as Error).message}`);
      }
    } else {
      console.log(`[${index}/${total}] No PDF link on page: ${url}`);
    }

    // Save metadata
    const metaPath = path.join(targetDir, "metadata.json");
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf8");
    console.log(`[${index}/${total}] Saved metadata for ID ${id}: ${metadata.autor}`);

    processed.add(workDetailPath);
    saveProgress(processed);
  } catch (err) {
    console.error(`[${index}/${total}] Error processing ${url}: ${(err as Error).message}`);
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

async function main(): Promise<void> {
  fs.mkdirSync(PDF_DIR, { recursive: true });

  const processed = loadProgress();
  if (processed.size > 0) {
    console.log(`Resuming — ${processed.size} entries already organized.\n`);
  }

  console.log("Fetching main page...");
  const html = await fetchPage(MAIN_URL);
  const $ = cheerio.load(html);

  const workDetailPaths: string[] = [];

  $("h2").each((_, heading) => {
    const text = $(heading).text().trim();
    if (!text.includes("bakalářské")) return;

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

  const remaining = workDetailPaths.filter((p) => !processed.has(p));
  console.log(
    `Found ${workDetailPaths.length} thesis entries, ${remaining.length} remaining. Starting...\n`
  );

  const tasks = workDetailPaths.map(
    (workPath, idx) => () =>
      processWorkDetail(workPath, idx + 1, workDetailPaths.length, processed)
  );

  await runWithConcurrency(tasks, CONCURRENCY);

  console.log("\nDone! All theses organized in:", PDF_DIR);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
