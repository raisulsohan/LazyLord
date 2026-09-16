/*
 * Fetch Adobe's ZXP signing tool into tools/vendor/.
 *
 *   node tools/get-zxpsigncmd.mjs
 *
 * ZXPSignCmd is a binary Adobe publishes in its own CEP-Resources repository.
 * It is not committed here — it is several megabytes of someone else's build,
 * and it is only needed when cutting a release. tools/vendor/ is git-ignored.
 *
 * Sign on the platform the package is for: Adobe's November 2024 note says a
 * package signed on one platform may fail to verify on the other.
 */
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "tools", "vendor");

const BASE = "https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3";
const BUILDS = {
  win32: { url: `${BASE}/x64/ZXPSignCmd.exe`, file: "ZXPSignCmd.exe" },
  darwin: { url: `${BASE}/macOS/ZXPSignCmd`, file: "ZXPSignCmd" },
};

const build = BUILDS[process.platform];
if (!build) {
  console.error(`[!] Adobe ships ZXPSignCmd for Windows and macOS only, not ${process.platform}.`);
  process.exit(1);
}

const target = join(vendor, build.file);
if (existsSync(target) && !process.argv.includes("--force")) {
  console.log(`Already here: ${target} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`);
  process.exit(0);
}

mkdirSync(vendor, { recursive: true });
console.log(`Downloading ${build.url}`);
const response = await fetch(build.url);
if (!response.ok) {
  console.error(`[!] Adobe's server answered ${response.status} ${response.statusText}.`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length < 1_000_000) {
  console.error(`[!] That download is only ${bytes.length} bytes — too small to be the tool.`);
  process.exit(1);
}
writeFileSync(target, bytes);
if (process.platform !== "win32") chmodSync(target, 0o755);
console.log(`Saved ${target} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
