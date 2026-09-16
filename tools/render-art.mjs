/*
 * Turn the brand SVGs into the PNGs Figma Community asks for.
 *
 *   node tools/render-art.mjs
 *
 * Figma's publish form takes a 128x128 icon and a 1920x1080 thumbnail, as PNG.
 * Rather than keep hand-exported copies that drift from the source, this
 * renders them from assets/*.svg with the copy of Chromium already on the
 * machine (Edge, or Chrome) and writes the PNGs next to them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");
const work = join(tmpdir(), "lazylord-art");

const BROWSERS = [
  process.env.CHROME,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);

const browser = BROWSERS.find((path) => existsSync(path));
if (!browser) {
  console.error("[!] No Chrome or Edge found to render with. Set CHROME to one.");
  process.exit(1);
}

/* Everything here is one straight line of work, so the wait is a real one. */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/*
 * `scale` draws the art that many times larger and shrinks the capture back by
 * the same amount. A window as small as the icon comes out clipped — the first
 * one was drawn down to about its top third — and the detour also gives the
 * small image its antialiasing. Anything already window-sized renders as it is.
 */
const ART = [
  { svg: "icon.svg", png: "icon.png", width: 128, height: 128, scale: 4 },
  { svg: "thumbnail.svg", png: "thumbnail.png", width: 1920, height: 1080, scale: 1 },
];

mkdirSync(work, { recursive: true });

for (const art of ART) {
  const scale = art.scale || 1;
  const drawW = art.width * scale;
  const drawH = art.height * scale;

  const svg = readFileSync(join(assets, art.svg), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    /* The viewBox does the fitting; only the drawn size changes. */
    .replace(/(<svg[^>]*?)width="\d+"([^>]*?)height="\d+"/, `$1width="${drawW}"$2height="${drawH}"`);

  /* A standalone SVG is centred on a white page with margins; wrapping it lets
     the window size and the image size be the same thing. */
  const page = join(work, art.png + ".html");
  writeFileSync(page, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>
${svg}`);

  const out = join(assets, art.png);
  rmSync(out, { force: true });
  execFileSync(browser, [
    /* The old --headless flag is gone from current Chromium builds. */
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--user-data-dir=${join(work, "profile")}`,
    "--hide-scrollbars",
    "--default-background-color=00000000",
    `--force-device-scale-factor=${1 / scale}`,
    `--screenshot=${out}`,
    `--window-size=${drawW},${drawH}`,
    `file:///${page.replace(/\\/g, "/")}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  /* Chromium hands the work to a child process and the first one exits, so the
     file lands a moment after the command returns — and lands in pieces. Wait
     for it to appear, then for it to stop growing. */
  const deadline = Date.now() + 30_000;
  while (!existsSync(out) && Date.now() < deadline) sleep(100);
  if (!existsSync(out)) {
    console.error(`[!] ${art.png} was not written. Is another copy of the browser already running?`);
    process.exit(1);
  }
  let size = -1;
  while (Date.now() < deadline) {
    const now = statSync(out).size;
    if (now > 0 && now === size) break;
    size = now;
    sleep(150);
  }

  const png = readFileSync(out);
  /* The size lives in the IHDR chunk 16 bytes in; IEND is the last chunk, and
     a file without it was read while it was still being written. */
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!png.subarray(-12).includes(Buffer.from("IEND"))) {
    console.error(`[!] ${art.png} is incomplete — it has no IEND chunk.`);
    process.exit(1);
  }
  if (width !== art.width || height !== art.height) {
    console.error(`[!] ${art.png} came out ${width}x${height}, not ${art.width}x${art.height}.`);
    process.exit(1);
  }
  console.log(`assets/${art.png}  ${width}x${height}  ${(png.length / 1024).toFixed(0)} KB`);
}

/* The browser keeps its profile locked for a moment after it exits; leaving a
   few kilobytes in the temp folder is better than failing the render. */
try { rmSync(work, { recursive: true, force: true }); } catch { /* it can wait */ }
console.log("\nUpload these two when publishing the plugin (see docs/figma-listing.md).");
