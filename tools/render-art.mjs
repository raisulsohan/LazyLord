/*
 * Turn the brand SVGs into the PNGs Figma Community asks for.
 *
 *   node tools/render-art.mjs
 *
 * Figma's listing takes a 128x128 icon and 1920x960 cover art, as PNG. Rather
 * than keep hand-exported copies that drift from the source, this renders them
 * from assets/*.svg with the copy of Chromium already on the machine (Edge, or
 * Chrome) and writes the PNGs next to them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const ART = [
  { svg: "icon.svg", png: "icon.png", width: 128, height: 128 },
  { svg: "banner.svg", png: "cover.png", width: 1920, height: 960 },
];

mkdirSync(work, { recursive: true });

for (const art of ART) {
  const svg = readFileSync(join(assets, art.svg), "utf8");
  /* A standalone SVG is centred on a white page with margins; wrapping it lets
     the window size and the image size be the same thing. */
  const page = join(work, art.png + ".html");
  writeFileSync(page, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>
${svg.replace(/<!--[\s\S]*?-->/g, "")}`);

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
    `--screenshot=${out}`,
    `--window-size=${art.width},${art.height}`,
    `file:///${page.replace(/\\/g, "/")}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  /* Chromium hands the work to a child process and the first one exits, so the
     file lands a moment after the command returns. Wait for it. */
  const deadline = Date.now() + 30_000;
  while (!existsSync(out) && Date.now() < deadline) sleep(100);
  if (!existsSync(out)) {
    console.error(`[!] ${art.png} was not written. Is another copy of the browser already running?`);
    process.exit(1);
  }
  /* PNG carries its size in the IHDR chunk, 16 bytes in. */
  const png = readFileSync(out);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== art.width || height !== art.height) {
    console.error(`[!] ${art.png} came out ${width}x${height}, not ${art.width}x${art.height}.`);
    process.exit(1);
  }
  console.log(`assets/${art.png}  ${width}x${height}  ${(png.length / 1024).toFixed(0)} KB`);
}

/* The browser keeps its profile locked for a moment after it exits; leaving
   a few kilobytes in the temp folder is better than failing the render. */
try { rmSync(work, { recursive: true, force: true }); } catch { /* it can wait */ }
console.log("\nUpload these two when publishing the plugin (see docs/figma-community.md).");
