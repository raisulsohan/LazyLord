/*
 * Photograph the LazyLord panel for docs/images.
 *
 *   node tools/docs-shots.mjs [outDir]
 *
 * The panel is a web page already. The only thing it has inside Photoshop,
 * Illustrator or After Effects that a browser does not is `window.__adobe_cep__`,
 * the object CEP injects; tools/docs-shot-server.mjs serves the real files
 * untouched and supplies that one object.
 *
 * So the pictures are the real panel doing real work: the real stylesheet, the
 * real layout, the real strings, and a real connection to a real bridge. Two
 * copies are served -- one reporting After Effects, one Photoshop -- so each
 * genuinely sees the other as a peer and offers to send to it, which is what a
 * user with both apps open sees.
 *
 * Needs Google Chrome (for the screenshots) and a built bridge
 * (packages/bridge/dist/server.js -- run install.bat once).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT = path.resolve(process.argv[2] || path.join(REPO, "docs", "images"));
const SERVER = path.join(HERE, "docs-shot-server.mjs");
const PANEL = path.join(REPO, "packages", "adobe-cep");
const BRIDGE = path.join(REPO, "packages", "bridge", "dist", "server.js");
const AE_PORT = 8899, PS_PORT = 8898;

const CHROMES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const CHROME = CHROMES.find((p) => fs.existsSync(p));

const kids = [];
function run(cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: "pipe" });
  p.stdout.on("data", () => {});
  p.stderr.on("data", () => {});
  kids.push(p);
  return p;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function up(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 800 }, (res) => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
async function waitUp(port, tries = 40) {
  for (let i = 0; i < tries; i++) { if (await up(port)) return true; await wait(250); }
  return false;
}

/*
 * Chrome's own --screenshot fires as soon as the page loads, which is before
 * the bridge answers and before the peer list arrives, so the panel would be
 * photographed half awake. --virtual-time-budget lets its clock and network run
 * on first. --window-size is in CSS pixels and the scale factor multiplies it,
 * so 520 wide at 2x writes a 1040px picture of a 520px panel. Below about 460
 * the panel's own layout starts running off the right edge; 520 is a realistic
 * dock width where everything fits.
 */
async function shoot(url, file, w, h, budget = 9000) {
  const out = path.join(OUT, file);
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawn(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      "--user-data-dir=" + path.join(process.env.TEMP || "/tmp", "lazylord-shot-profile"),
      "--window-size=" + w + "," + h,
      "--virtual-time-budget=" + budget,
      "--screenshot=" + out,
      url,
    ], { stdio: "pipe" });
    p.on("exit", () => resolve());
    p.on("error", reject);
  });
  const ok = fs.existsSync(out);
  console.log((ok ? "  wrote " : "  FAILED ") + file + (ok ? " (" + fs.statSync(out).size + " bytes)" : ""));
  return ok;
}

try {
  if (!CHROME) throw new Error("Google Chrome was not found; it takes the screenshots.");
  if (!fs.existsSync(BRIDGE)) throw new Error("The bridge is not built. Run install.bat first.");

  console.log("bridge…");
  /* The bridge refuses origins it does not know, which is why a web page cannot
     talk to it by accident. LAZYLORD_ALLOW_ORIGINS is its own supported way to
     let one in -- the same switch the Figma plugin needs. */
  run("node", [BRIDGE], {
    LAZYLORD_ALLOW_ORIGINS: [AE_PORT, PS_PORT]
      .flatMap((p) => ["http://localhost:" + p, "http://127.0.0.1:" + p]).join(","),
  });
  await wait(1500);

  console.log("panels…");
  run("node", [SERVER, PANEL, String(AE_PORT), "AEFT", "26.5"]);
  run("node", [SERVER, PANEL, String(PS_PORT), "PHXS", "26.0"]);
  if (!(await waitUp(AE_PORT)) || !(await waitUp(PS_PORT))) throw new Error("the panel servers did not come up");

  console.log("photoshop side");
  await shoot("http://localhost:" + PS_PORT + "/", "panel-photoshop.png", 520, 760);

  /* A second Photoshop client, left running, so After Effects has a real peer
     to offer while it is photographed. */
  const holder = spawn(CHROME, [
    "--headless=new", "--disable-gpu",
    "--user-data-dir=" + path.join(process.env.TEMP || "/tmp", "lazylord-holder"),
    "--window-size=520,760", "--virtual-time-budget=600000",
    "--screenshot=" + path.join(process.env.TEMP || "/tmp", "lazylord-holder.png"),
    "http://localhost:" + PS_PORT + "/",
  ], { stdio: "pipe" });
  kids.push(holder);
  await wait(4000);

  console.log("after effects side");
  await shoot("http://localhost:" + AE_PORT + "/", "panel.png", 520, 900);

  console.log("done — pictures in " + OUT);
} catch (err) {
  console.error(String(err.message || err));
  process.exitCode = 1;
} finally {
  for (const k of kids) { try { k.kill(); } catch {} }
  await wait(500);
  process.exit(process.exitCode || 0);
}
