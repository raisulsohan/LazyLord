/*
 * Copy the shared stylesheet into the Adobe panel.
 *
 * The Figma plugin inlines packages/ui-kit/lazylord.css at build time, but a
 * CEP panel is loaded straight off disk from its own folder — a path pointing
 * outside it would break once the folder is linked into Adobe's extensions
 * directory. So the panel gets a copy, synced here and refreshed by
 * `npm run build`. The copy is generated, and git ignores it.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "packages/ui-kit/lazylord.css");
const outDir = resolve(root, "packages/adobe-cep/css");
const target = resolve(outDir, "lazylord.css");

const banner = [
  "/*",
  " * GENERATED — do not edit.",
  " * Copied from packages/ui-kit/lazylord.css by tools/sync-ui-css.mjs.",
  " * Edit the source and run `npm run build` (or `npm run sync:css`).",
  " */",
  "",
].join("\n");

mkdirSync(outDir, { recursive: true });
writeFileSync(target, banner + readFileSync(source, "utf8"));
console.log("synced packages/adobe-cep/css/lazylord.css");
