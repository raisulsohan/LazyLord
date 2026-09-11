// Build script for the LazyLord Figma plugin.
// Bundles src/code.ts -> dist/code.js and inlines src/ui.ts into dist/ui.html.
import { build, context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");
mkdirSync(dist, { recursive: true });

const watch = process.argv.includes("--watch");

const codeOptions = {
  entryPoints: [resolve(root, "src/code.ts")],
  outfile: resolve(dist, "code.js"),
  bundle: true,
  format: "iife",
  target: "es2017",
  logLevel: "info",
};

// Build the UI script to a string, then inline into an HTML shell so Figma
// (which only accepts a single HTML file) can load it.
const uiHtmlTemplate = readFileSync(resolve(root, "src/ui.html"), "utf8");

async function buildUi() {
  const result = await build({
    entryPoints: [resolve(root, "src/ui.ts")],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2017",
    logLevel: "silent",
  });
  const js = result.outputFiles[0].text;
  const html = uiHtmlTemplate.replace("/*__LAZYLORD_UI_JS__*/", () => js);
  writeFileSync(resolve(dist, "ui.html"), html);
  console.log("built dist/ui.html");
}

if (watch) {
  const ctx = await context(codeOptions);
  await ctx.watch();
  await buildUi();
  // esbuild has no simple multi-target watch here; rebuild UI on an interval.
  console.log("watching code.ts (rebuild ui with `npm run build` after ui edits)");
} else {
  await build(codeOptions);
  await buildUi();
  console.log("build complete");
}
