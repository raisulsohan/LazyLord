// The relay, run for real: routing, acks, chunks, requests, Origins, and a
// second panel finding the port taken. Needs `npm run build:core` and the
// bridge build (packages/bridge/dist/relay.js).
//   node tools/test-bridge.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const WebSocket = require(resolve(root, "node_modules/ws"));
const core = require(resolve(root, "packages/core/dist/index.js"));
const { startRelay } = require(resolve(root, "packages/bridge/dist/relay.js"));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 7900 + Math.floor(Math.random() * 90);
const url = `ws://127.0.0.1:${PORT}`;

function client(role, origin) {
  return new Promise((res, rej) => {
    const w = new WebSocket(url, origin === undefined ? {} : { origin });
    w.inbox = [];
    w.on("message", (d) => w.inbox.push(JSON.parse(d)));
    w.on("open", () => { w.send(JSON.stringify({ type: "hello", protocol: core.PROTOCOL_VERSION, role, client: role })); res(w); });
    w.on("error", rej);
    w.on("unexpected-response", (_req, resp) => rej(new Error("HTTP " + resp.statusCode)));
  });
}
const took = (w, type, pred) => w.inbox.find((m) => m.type === type && (!pred || pred(m)));
async function waitFor(w, type, pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const m = took(w, type, pred); if (m) return m; await sleep(15); }
  return null;
}
const doc = (n, big) => ({
  version: "1.0", source: "figma", name: "Doc " + n, bounds: { x: 0, y: 0, width: 10, height: 10 },
  layers: [{ id: "a", name: "A", type: "image", frame: { x: 0, y: 0, width: 10, height: 10 }, pngBase64: big ? "A".repeat(6 * 1024 * 1024) : "AAAA" }],
});

console.log("LazyLord - relay (real sockets, port " + PORT + ")\n");
const relay = await startRelay({ port: PORT, hosts: ["127.0.0.1"] });
ok("start: listens", relay.hosts[0] === "127.0.0.1" && relay.port === PORT);

// A second panel opening finds the port served, and stays a client.
let second = null;
try { await startRelay({ port: PORT, hosts: ["127.0.0.1"] }); } catch (e) { second = e; }
ok("a second relay on the same port is refused (EADDRINUSE)", second && second.code === "EADDRINUSE", second && second.code);

// Who may connect: LazyLord's own clients, never a web page.
const figma = await client("figma", "null");                 // Figma plugin iframe
const ai = await client("illustrator", "file://");            // CEP panel
const ae = await client("aftereffects");                      // no Origin (Node)
let refused = null;
try { await client("figma", "https://evil.example"); } catch (e) { refused = e; }
ok("origin: a web page is refused", !!refused, refused && refused.message);
await sleep(150);
const peers = () => { const all = figma.inbox.filter((m) => m.type === "peers" || m.type === "welcome"); return all.length ? all[all.length - 1].peers : []; };
ok("origin: Figma (null), a panel (file://) and Node are all in", ["illustrator", "aftereffects"].every((p) => peers().includes(p)), JSON.stringify(peers()));

figma.send(JSON.stringify({ type: "transfer", id: "t1", target: "illustrator", document: doc(1) }));
ok("transfer: reaches its target", !!(await waitFor(ai, "transfer", (m) => m.id === "t1")));
await sleep(100);
ok("transfer: and nobody else", !took(ae, "transfer", (m) => m.id === "t1"));
ai.send(JSON.stringify({ type: "ack", id: "t1", from: "illustrator", ok: true, layersCreated: 1 }));
ok("ack: back to the sender only", !!(await waitFor(figma, "ack", (m) => m.id === "t1")) && !took(ae, "ack", (m) => m.id === "t1"));

// A staged ack keeps the way back open: the ack that follows reaches the sender only.
ai.send(JSON.stringify({ type: "transfer", id: "t-live", target: "figma", document: doc(9) }));
await waitFor(figma, "transfer", (m) => m.id === "t-live");
figma.send(JSON.stringify({ type: "ack", id: "t-live", from: "figma", ok: true, staged: true }));
ok("staged ack: reaches the sender", !!(await waitFor(ai, "ack", (m) => m.id === "t-live" && m.staged === true)));
figma.send(JSON.stringify({ type: "ack", id: "t-live", from: "figma", ok: true, layersUpdated: 1 }));
ok("staged ack: the final one is routed to the sender too, not broadcast",
  !!(await waitFor(ai, "ack", (m) => m.id === "t-live" && !m.staged)) && !took(ae, "ack", (m) => m.id === "t-live"));

figma.send(JSON.stringify({ type: "transfer", id: "t2", target: "photoshop", document: doc(2) }));
const nack = await waitFor(figma, "ack", (m) => m.id === "t2");
ok("absent target: a failed ack with a reason", nack && nack.ok === false && /Photoshop/.test(nack.message), JSON.stringify(nack));

// Chunks: the targets are fixed at the first piece.
const parts = core.chunkTransfer({ type: "transfer", id: "t3", target: "aftereffects", document: doc(3, true) });
figma.send(JSON.stringify(parts[0]));
await sleep(50);
const late = await client("aftereffects");                   // joins half-way
for (const p of parts.slice(1)) figma.send(JSON.stringify(p));
const joiner = new core.ChunkJoiner();
let whole = null;
const end = Date.now() + 5000;
while (!whole && Date.now() < end) {
  for (const m of ae.inbox.splice(0)) if (m.type === "chunk") { const w = joiner.add(m); if (w) whole = w; }
  if (!whole) await sleep(15);
}
ok("chunks: joined intact at the target", whole && whole.document.layers[0].pngBase64.length === 6 * 1024 * 1024);
ok("chunks: an app connecting half-way gets none of the tail", !took(late, "chunk"));

ae.send(JSON.stringify({ type: "request", id: "q1", target: "illustrator", what: "active-document" }));
ok("request: reaches its target", !!(await waitFor(ai, "request", (m) => m.id === "q1")));
ai.send(JSON.stringify({ type: "reply", id: "q1", from: "illustrator", ok: true, data: { name: "x.ai" } }));
ok("reply: back to the asker", !!(await waitFor(ae, "reply", (m) => m.id === "q1")));

figma.send("{not json");
figma.send(JSON.stringify({ type: "transfer", id: "t4", target: "illustrator", document: doc(4) }));
ok("robust: survives bad messages", !!(await waitFor(ai, "transfer", (m) => m.id === "t4")));

ae.close(); late.close();
await sleep(200);
ok("peers: a closed app leaves the list", !peers().includes("aftereffects"), JSON.stringify(peers()));

// The panel hosting it closes: the port is free for the next one to take over.
await relay.close();
const next = await startRelay({ port: PORT, hosts: ["127.0.0.1"] }).catch((e) => e);
ok("take-over: after close, another relay can start on the port", next && typeof next.close === "function", next && next.code);
if (next && next.close) await next.close();
figma.terminate(); ai.terminate();

console.log("\n" + pass + " passed, " + fail + " failed.");
process.exit(fail ? 1 : 0);
