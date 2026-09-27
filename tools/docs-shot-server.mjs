/*
 * Serve LazyLord's CEP panel as a plain web page, so it can be photographed
 * for the documentation without installing the extension into Adobe.
 *
 * The panel is a web page already; the only thing it has that a browser does
 * not is `window.__adobe_cep__`, the object CEP injects. This serves the real
 * files untouched, except that index.html gets one <script> inserted before
 * csinterface.js which supplies that object. Everything after that -- the
 * stylesheet, the layout, the strings, the bridge connection -- is the real
 * panel doing its real work.
 *
 *   node tools/docs-shot-server.mjs <panel-dir> <port> <appName> [version]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2]);
const PORT = Number(process.argv[3] || 8899);
const APP = process.argv[4] || "AEFT";
const VERSION = process.argv[5] || "26.5";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/* The CEP host, reduced to what the panel actually calls. evalScript answers
   the way a host with nothing selected does, so the panel settles into its
   normal idle state instead of hanging on a callback that never fires. */
const STUB = `<script>
window.__adobe_cep__ = {
  getHostEnvironment: function () {
    return JSON.stringify({ appName: ${JSON.stringify(APP)}, appVersion: ${JSON.stringify(VERSION)}, appLocale: "en_US" });
  },
  evalScript: function (script, cb) {
    /* Only the answers the panel needs while it is idle. The loader is happy
       with "ok"; a document query gets a plausible reply so the panel settles
       instead of logging a failure that never happens in the real host. */
    var out = "";
    if (script.indexOf("__lazylordLoad;") >= 0) out = "ok";
    else if (script.indexOf("activeDocumentInfo") >= 0) out = JSON.stringify({ ok: true, data: { name: "Untitled" } });
    else if (script.indexOf("liveStamp") >= 0) out = "0";
    setTimeout(function () { cb(out); }, 0);
  },
  getSystemPath: function () { return encodeURIComponent("C:/LazyLordShot"); },
  getExtensionId: function () { return "com.sohan.LazyLord"; },
  addEventListener: function () {},
  removeEventListener: function () {},
  dispatchEvent: function () {},
  requestOpenExtension: function () {},
  getScaleFactor: function () { return 1; },
  invokeSync: function () { return ""; },
  invokeAsync: function () { return ""; }
};
window.cep = window.cep || {};
window.cep.util = window.cep.util || { openURLInDefaultBrowser: function () {} };
window.cep.fs = window.cep.fs || {};
</script>
`;

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.join(ROOT, path.normalize(rel).replace(/^[\\/]+/, ""));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("no"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    const ext = path.extname(file).toLowerCase();
    if (ext === ".html") {
      let html = buf.toString("utf8");
      const marker = '<script src="./js/csinterface.js"></script>';
      html = html.includes(marker) ? html.replace(marker, STUB + marker) : STUB + html;
      res.writeHead(200, { "content-type": TYPES[ext] }).end(html);
      return;
    }
    res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream" }).end(buf);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log("LazyLord panel on http://127.0.0.1:" + PORT + "/  (host " + APP + ")");
});
