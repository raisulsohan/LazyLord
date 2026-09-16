/*
 * Package the LazyLord panel as a signed ZXP, and wrap it in a release folder
 * a user can unzip and install with one double-click.
 *
 *   node tools/package-zxp.mjs --cert     make the signing certificate (once)
 *   node tools/package-zxp.mjs            build, sign and package
 *   node tools/package-zxp.mjs --skip-build
 *
 * Adobe's own ZXPSignCmd does the signing; tools/get-zxpsigncmd.mjs fetches it.
 * Everything this writes lands in release/, which git ignores — the .p12 is a
 * signing key and must never be committed or shared.
 */
import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const VERSION = pkg.version;

const release = join(root, "release");
const staging = join(release, "staging", "com.lazylord.panel");
const payload = join(release, `LazyLord-${VERSION}`);
const zxpName = `LazyLord-${VERSION}.zxp`;
const zxp = join(release, zxpName);
const certDir = join(release, "cert");
const p12 = join(certDir, "lazylord.p12");
const pwFile = join(certDir, "password.txt");

/* Who the installer names as the publisher. */
const CERT = {
  country: "BD",
  state: "Dhaka",
  organisation: "LazyLord",
  commonName: "Raisul Sohan",
  validityDays: "3650",
};

/*
 * A timestamp is what keeps a signed extension working after the certificate
 * expires, so it is worth trying more than one server before giving up.
 */
const TIMESTAMP_SERVERS = [
  "http://timestamp.digicert.com",
  "http://time.certum.pl/",
  "http://timestamp.sectigo.com",
];

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

function log(step, message) {
  console.log(`${step}  ${message}`);
}

function fail(message) {
  console.error(`\n[!] ${message}\n`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the tool */

function signTool() {
  const named = process.env.ZXPSIGNCMD;
  const exe = process.platform === "win32" ? "ZXPSignCmd.exe" : "ZXPSignCmd";
  const candidates = [named, join(root, "tools", "vendor", exe), exe].filter(Boolean);
  for (const candidate of candidates) {
    try {
      /* Printing its usage is how ZXPSignCmd answers a call with no work to
         do, and it exits non-zero while doing it — so the test is the text. */
      execFileSync(candidate, ["-h"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return candidate;
    } catch (error) {
      const said = `${error.stdout || ""}${error.stderr || ""}`;
      if (said.includes("ZXPSignCmd -sign")) return candidate;
    }
  }
  fail(
    "ZXPSignCmd was not found. Run `node tools/get-zxpsigncmd.mjs` to download\n" +
    "    Adobe's signing tool into tools/vendor/, or set ZXPSIGNCMD to its path.",
  );
}

function run(tool, argv) {
  return execFileSync(tool, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/* -------------------------------------------------------- the certificate */

function password() {
  if (process.env.LAZYLORD_CERT_PASSWORD) return process.env.LAZYLORD_CERT_PASSWORD;
  if (existsSync(pwFile)) return readFileSync(pwFile, "utf8").trim();
  mkdirSync(certDir, { recursive: true });
  /* Letters and digits only: this is passed on a command line. */
  const made = randomBytes(32).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
  writeFileSync(pwFile, made + "\n");
  log("[cert]", `wrote a new password to ${pwFile} — keep it, and keep it out of git`);
  return made;
}

function makeCert(tool) {
  if (existsSync(p12) && !has("--force")) {
    fail(
      `${p12} already exists.\n` +
      "    Signing every release with the same certificate is what lets an update\n" +
      "    replace an installed panel, so this is not overwritten by accident.\n" +
      "    Pass --force if you really mean to start a new identity.",
    );
  }
  mkdirSync(certDir, { recursive: true });
  const pw = password();
  run(tool, [
    "-selfSignedCert",
    CERT.country, CERT.state, CERT.organisation, CERT.commonName,
    pw, p12,
    "-validityDays", CERT.validityDays,
  ]);
  if (!existsSync(p12)) fail("ZXPSignCmd did not produce the certificate.");
  log("[cert]", `${p12} — ${CERT.commonName}, ${CERT.organisation} (${CERT.validityDays} days)`);
  console.log(
    "\nBack up release/cert/ somewhere safe. Lose it and a future release cannot\n" +
    "update an installed LazyLord: users would have to remove the old one first.\n",
  );
}

/* ------------------------------------------------------------ the package */

function build() {
  log("[1/6]", "building core, the Figma plugin and the panel's bridge...");
  /* npm is a .cmd on Windows, and Node will not spawn one without a shell. */
  execSync("npm run build", { cwd: root, stdio: "inherit" });
}

/* Files that must never travel: debug ports, editor and OS litter. */
const SKIP = new Set([".debug", "node_modules", ".DS_Store", "__MACOSX", "Thumbs.db", ".git"]);

function count(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? count(join(dir, entry.name)) : 1;
  }
  return n;
}

/*
 * package.json holds the version; the panel's manifest and its ExtendScript
 * each carry a copy. Keep them in step here rather than asking a person to
 * remember three files — Adobe decides whether an install is an update by
 * comparing the manifest version, so a stale one ships as "already installed".
 */
function syncVersion() {
  const edits = [
    {
      file: join(root, "packages", "adobe-cep", "CSXS", "manifest.xml"),
      find: /(ExtensionBundleVersion|Extension Id="com\.lazylord\.panel" Version)="[\d.]+"/g,
      to: `$1="${VERSION}"`,
    },
    {
      file: join(root, "packages", "adobe-cep", "jsx", "lazylord.jsx"),
      find: /(LazyLord\.VERSION = )"[\d.]+"/,
      to: `$1"${VERSION}"`,
    },
    {
      file: join(root, "packages", "adobe-cep", "js", "main.js"),
      find: /(var PANEL_VERSION = )"[\d.]+"/,
      to: `$1"${VERSION}"`,
    },
  ];
  for (const edit of edits) {
    const before = readFileSync(edit.file, "utf8");
    const after = before.replace(edit.find, edit.to);
    if (after !== before) {
      writeFileSync(edit.file, after);
      log("[0/6]", `set ${VERSION} in ${edit.file.slice(root.length + 1)}`);
    }
  }
}

function stage() {
  syncVersion();
  rmSync(join(release, "staging"), { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(join(root, "packages", "adobe-cep"), staging, {
    recursive: true,
    filter: (src) => !SKIP.has(src.split(/[\\/]/).pop()),
  });

  /* Generated files the panel cannot run without. */
  for (const needed of ["css/lazylord.css", "js/select.js", "js/relay.js", "CSXS/manifest.xml"]) {
    if (!existsSync(join(staging, needed))) {
      fail(`${needed} is missing from the panel. Run the build first (drop --skip-build).`);
    }
  }
  /* Adobe's signature check replaces symlinks as it verifies, and needs rights
     the user may not have — which shows up as a blank panel. Allow none. */
  const links = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(path);
      else if (entry.isDirectory()) walk(path);
    }
  })(staging);
  if (links.length) {
    fail(`the panel contains symlinks, which break signed installs:\n    ${links.join("\n    ")}`);
  }

  log("[2/6]", `staged ${count(staging)} files in release/staging/com.lazylord.panel`);
}

function sign(tool) {
  if (!existsSync(p12)) {
    fail("no certificate yet. Run `node tools/package-zxp.mjs --cert` first.");
  }
  const pw = password();
  rmSync(zxp, { force: true });

  let signed = false;
  for (const tsa of TIMESTAMP_SERVERS) {
    try {
      run(tool, ["-sign", staging, zxp, p12, pw, "-tsa", tsa]);
      log("[3/6]", `signed, timestamped by ${tsa}`);
      signed = true;
      break;
    } catch {
      rmSync(zxp, { force: true });
      log("[3/6]", `${tsa} did not answer; trying the next timestamp server...`);
    }
  }
  if (!signed) {
    /* Without a timestamp the panel stops loading the day the certificate
       expires, so this is a fallback and it says so. */
    try {
      run(tool, ["-sign", staging, zxp, p12, pw]);
    } catch (error) {
      fail(`signing failed:\n${error.stdout || ""}${error.stderr || error.message}`);
    }
    log("[3/6]", "signed WITHOUT a timestamp — no timestamp server answered.");
    console.log("       Re-run with a connection: an untimestamped panel stops");
    console.log("       loading on the day the certificate expires.\n");
  }
  if (!existsSync(zxp)) fail("ZXPSignCmd reported success but no .zxp appeared.");
}

function verify(tool) {
  try {
    const out = run(tool, ["-verify", zxp, "-certInfo"]);
    log("[4/6]", "verified:");
    for (const line of out.trim().split(/\r?\n/)) console.log(`        ${line}`);
  } catch (error) {
    fail(`the signed package does not verify:\n${error.stdout || error.message}`);
  }
}

/* ------------------------------------------------------- what a user gets */

function assemble() {
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  cpSync(zxp, join(payload, zxpName));

  /* The installers are copied by hand rather than in bulk: cmd.exe misreads a
     .bat with Unix line endings, and a .command has to stay executable. */
  for (const name of readdirSync(join(root, "tools", "installer"))) {
    const from = join(root, "tools", "installer", name);
    const to = join(payload, name);
    if (/\.(bat|cmd|txt)$/i.test(name)) {
      const text = readFileSync(from, "utf8").replace(/\r?\n/g, "\r\n");
      writeFileSync(to, text);
    } else {
      const text = readFileSync(from, "utf8").replace(/\r\n/g, "\n");
      writeFileSync(to, text);
      if (name.endsWith(".command")) chmodSync(to, 0o755);
    }
  }

  /* Figma cannot install a plugin from a script, so the files it needs to be
     imported by hand travel with the panel until the plugin is published. */
  const figma = join(payload, "Figma plugin");
  mkdirSync(join(figma, "dist"), { recursive: true });
  cpSync(join(root, "packages", "figma-plugin", "manifest.json"), join(figma, "manifest.json"));
  for (const file of ["code.js", "ui.html"]) {
    cpSync(join(root, "packages", "figma-plugin", "dist", file), join(figma, "dist", file));
  }
  log("[5/6]", `assembled release/LazyLord-${VERSION}/`);
}

function zip() {
  const out = join(release, `LazyLord-${VERSION}.zip`);
  rmSync(out, { force: true });
  if (process.platform === "win32") {
    execFileSync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `Compress-Archive -Path "${payload}\\*" -DestinationPath "${out}" -Force`,
    ], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-r", "-q", out, `LazyLord-${VERSION}`], { cwd: release });
  }
  const mb = (statSync(out).size / 1024 / 1024).toFixed(2);
  log("[6/6]", `release/LazyLord-${VERSION}.zip (${mb} MB)`);
  return out;
}

/* ------------------------------------------------------------------- main */

const tool = signTool();
mkdirSync(release, { recursive: true });

if (has("--cert")) {
  makeCert(tool);
  process.exit(0);
}

if (has("--skip-build")) log("[1/6]", "skipping the build (--skip-build)");
else build();
stage();
sign(tool);
verify(tool);
assemble();
const out = zip();

console.log(`
Done. Give people ${out.split(/[\\/]/).pop()}:
  they unzip it and run "Install LazyLord.bat" (macOS: the .command file).
Nothing else is needed — no Node, no bridge window, no debug mode.
`);
