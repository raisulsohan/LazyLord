/**
 * LazyLord — Figma plugin UI thread.
 * Owns the WebSocket connection to the local bridge and drives the panel.
 */

import { DEFAULT_BRIDGE_PORT, PROTOCOL_VERSION, countLeaves, roleLabel, transferOptions } from "@lazylord/core";
import type { Diagnostic, Document, Message, Role, TransferMessage, TransferOptions } from "@lazylord/core";

// Figma's manifest only accepts host names in allowedDomains (an IP address is
// rejected as "not a valid URL"), and the connection must match it.
const BRIDGE_URL = `ws://localhost:${DEFAULT_BRIDGE_PORT}`;

const SCALES = [1, 2, 3, 4];

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const connEl = $("#conn");
const connText = $("#conn-text");
const peersEl = $("#peers");
const sendBtn = $<HTMLButtonElement>("#send");
const statusEl = $("#status");
const retryEl = $("#retry");
const targetsEl = $("#targets");
const scalesEl = $("#scales");
const layoutSel = $<HTMLSelectElement>("#layout");
const hierarchySel = $<HTMLSelectElement>("#hierarchy");
const existingSel = $<HTMLSelectElement>("#existing");
const keyframesSel = $<HTMLSelectElement>("#keyframes");
const keyframesOpt = $("#keyframes-opt");
const optsHint = $("#opts-hint");
const placeSel = $<HTMLSelectElement>("#place");
const placeNote = $("#place-note");
const optsNote = $("#opts-note");
const diagBlock = $("#diag-block");
const diagList = $("#diags");
const diagCount = $("#diag-count");

let ws: WebSocket | null = null;
let connected = false;
let peers: Role[] = [];
let selectionCount = 0;
let target: Role | "" = "";
let scale = 2;
/** Set by the saved prefs, or by the user's first choice, whichever comes first. */
let prefsApplied = false;
let reconnectTimer: number | undefined;
const pending = new Map<string, number>(); // transfer id -> timestamp

/** Fallbacks for the last transfer, from Figma and from every host that answered. */
let diagnostics: Array<Diagnostic & { from: string }> = [];

// --- Bridge connection ----------------------------------------------------

function connect() {
  cleanup();
  setConn(false, "Connecting…");
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    send({ type: "hello", protocol: PROTOCOL_VERSION, role: "figma", client: "Figma" });
    setConn(true, "Connected");
  };

  ws.onmessage = (ev) => {
    let msg: Message;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage(msg);
  };

  ws.onclose = () => {
    setConn(false, "Bridge offline");
    peers = [];
    renderPeers();
    scheduleReconnect();
  };

  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

function cleanup() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (ws) {
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, 2500);
}

function send(msg: Message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onMessage(msg: Message) {
  switch (msg.type) {
    case "welcome":
      peers = msg.peers.filter((p) => p !== "figma");
      renderPeers();
      break;
    case "peers":
      peers = msg.peers.filter((p) => p !== "figma");
      renderPeers();
      break;
    case "ack": {
      pending.delete(msg.id);
      addDiagnostics(roleLabel(msg.from), msg.diagnostics);
      if (batchAck(msg.id, !!msg.ok, msg.layersCreated ?? 0, msg.message || "", roleLabel(msg.from))) {
        // One frame of several: the batch keeps the status up to date.
      } else if (msg.ok) {
        const n = msg.diagnostics ? msg.diagnostics.length : 0;
        const fallbacks = n ? ` ${n} item${n === 1 ? "" : "s"} needed a fallback.` : "";
        setStatus(`${roleLabel(msg.from)}: created ${msg.layersCreated ?? 0} layer(s).${fallbacks}`, "ok");
      } else {
        setStatus(`${roleLabel(msg.from)}: ${msg.message || "transfer failed"}`, "err");
      }
      updateSendButton();
      break;
    }
    case "transfer": {
      // Another app is sending us artwork: the main thread rebuilds it.
      addDiagnostics(roleLabel((msg.document && msg.document.source) as Role), msg.document && msg.document.diagnostics);
      const n = countLeaves(msg.document && msg.document.layers);
      setStatus(`Receiving ${n} layer${n === 1 ? "" : "s"} from ${roleLabel((msg.document && msg.document.source) as Role)}…`, "");
      parent.postMessage({ pluginMessage: { type: "receive", id: msg.id, document: msg.document } }, "*");
      break;
    }
    default:
      break;
  }
}

// --- UI rendering ---------------------------------------------------------

function setConn(on: boolean, text: string) {
  connected = on;
  connEl.className = "a-conn " + (on ? "a-conn--on" : "a-conn--off");
  connText.textContent = text;
  updateSendButton();
}

function renderPeers() {
  const adobe = peers.filter((p) => p !== "unknown");
  if (adobe.length === 0) {
    peersEl.textContent = "No Adobe app connected yet.";
  } else {
    peersEl.textContent = "Listening: " + adobe.map(roleLabel).join(", ");
  }
  updateSendButton();
}

function targetIsAvailable(): boolean {
  if (!connected) return false;
  if (target === "") return peers.some((p) => p !== "unknown" && p !== "figma");
  return peers.includes(target);
}

function updateSendButton() {
  const ready = connected && selectionCount > 0 && targetIsAvailable() && pending.size === 0;
  sendBtn.disabled = !ready;
  if (pending.size > 0) sendBtn.textContent = "Sending…";
  else if (selectionCount === 0) sendBtn.textContent = "Select something to send";
  else if (!connected) sendBtn.textContent = "Bridge offline";
  else if (!targetIsAvailable()) sendBtn.textContent = "Open the LazyLord panel in Adobe";
  else sendBtn.textContent = `Send ${selectionCount} layer${selectionCount === 1 ? "" : "s"}`;
}

function setStatus(text: string, kind: "ok" | "err" | "") {
  statusEl.textContent = text;
  statusEl.className = "a-status" + (kind ? " " + kind : "");
}

/** Mark the button whose data-<key> equals `value` as active. */
function selectButton(container: HTMLElement, selector: string, key: string, value: string) {
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(selector))) {
    el.classList.toggle("is-active", (el.dataset[key] || "") === value);
  }
}

function hasButton(container: HTMLElement, selector: string, key: string, value: string): boolean {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).some((el) => (el.dataset[key] || "") === value);
}

function addDiagnostics(from: string, list: Diagnostic[] | undefined) {
  if (!list || !list.length) return;
  for (const d of list) {
    if (d && d.object != null) diagnostics.push({ object: String(d.object), reason: String(d.reason || ""), resolution: d.resolution, from });
  }
  renderDiagnostics();
}

/** One row per fallback: "object — reason [resolution]", tagged with the app that reported it. */
function renderDiagnostics() {
  diagList.textContent = "";
  diagBlock.hidden = diagnostics.length === 0;
  diagCount.textContent = diagnostics.length ? `(${diagnostics.length})` : "";
  for (const d of diagnostics) {
    const li = document.createElement("li");
    li.className = "a-diag";

    const src = document.createElement("span");
    src.className = "a-diag-src";
    src.textContent = d.from;

    const obj = document.createElement("span");
    obj.className = "a-diag-obj";
    obj.textContent = d.object;

    const res = document.createElement("span");
    res.className = "a-diag-res " + (d.resolution || "");
    res.textContent = `[${d.resolution || "approximated"}]`;

    li.appendChild(src);
    li.appendChild(obj);
    li.appendChild(document.createTextNode(` — ${d.reason} `));
    li.appendChild(res);
    diagList.appendChild(li);
  }
}

// --- Transfer options -----------------------------------------------------
// Figma always sends its whole hierarchy; these choices travel on
// doc.options and the receiving app's builder obeys them. The defaults
// (Split + Flatten) reproduce what every builder did before options existed.

/** What the option selects say, with the defaults applied. */
function currentOptions(): Required<TransferOptions> {
  const existing = existingSel.value as TransferOptions["existing"];
  return transferOptions({
    options: {
      layout: layoutSel.value as TransferOptions["layout"],
      hierarchy: hierarchySel.value as TransferOptions["hierarchy"],
      // Both "new document" choices ask the target for a new document; the
      // main thread has already sized the transfer for the one chosen.
      // There is nothing to update in a document that does not exist yet, so
      // updating always builds into the one already open.
      destination: existing === "update" || placeSel.value === "open" ? "active" : "new",
      existing,
      keyframes: keyframesSel.value as TransferOptions["keyframes"],
    },
  });
}

const PLACE_NOTES: Record<string, string> = {
  auto: "A whole frame or section gets a document its size; a single object gets one its own size.",
  frame: "A new document the size of the top-level frame, with everything where it sits in that frame.",
  open: "Into the document or composition already open, where it sits in its frame.",
};

function updatePlaceNote() {
  placeNote.textContent = PLACE_NOTES[placeSel.value] || "";
}

/** The closed Options disclosure names the choices that differ from the defaults, e.g. "Combine, Groups". */
function updateOptionsNote() {
  const o = currentOptions();
  const parts: string[] = [];
  if (o.layout === "combine") parts.push("Combine");
  if (o.hierarchy === "groups") parts.push("Groups");
  if (o.existing === "update") parts.push("Update");
  if (o.existing === "update" && o.keyframes === "always") parts.push("Always key");
  optsNote.textContent = parts.join(", ");

  // Keyframes only mean anything while updating, and only in After Effects.
  const updating = o.existing === "update";
  keyframesOpt.hidden = !updating;
  if (!updating) {
    optsHint.textContent = "Applied by the app that receives the transfer.";
  } else if (placeSel.value !== "open") {
    optsHint.textContent =
      "Update edits what an earlier send built, so it goes into the open document — the Destination above is ignored.";
  } else {
    optsHint.textContent =
      "Layers an earlier send built are edited where they stand. Layout and Hierarchy are ignored for those.";
  }
}

// --- Preferences ----------------------------------------------------------

/** Tell the main thread, which keeps them in figma.clientStorage. */
function savePrefs() {
  const o = currentOptions();
  parent.postMessage({ pluginMessage: { type: "prefs", target, scale, layout: o.layout, hierarchy: o.hierarchy, existing: o.existing, keyframes: o.keyframes, place: placeSel.value, width: winWidth, height: winHeight } }, "*");
}

function applyPrefs(msg: { target?: unknown; scale?: unknown; layout?: unknown; hierarchy?: unknown; existing?: unknown; keyframes?: unknown; place?: unknown; width?: unknown; height?: unknown }) {
  noteSize(msg.width, msg.height);
  if (typeof msg.place === "string" && PLACE_NOTES[msg.place]) placeSel.value = msg.place;
  updatePlaceNote();
  const t = typeof msg.target === "string" ? msg.target : "";
  if (hasButton(targetsEl, ".a-target", "target", t)) {
    target = t as Role | "";
    selectButton(targetsEl, ".a-target", "target", t);
  }
  const s = Number(msg.scale);
  if (SCALES.indexOf(s) >= 0) {
    scale = s;
    selectButton(scalesEl, ".a-scale", "scale", String(s));
  }
  const o = transferOptions({ options: msg as TransferOptions });
  layoutSel.value = o.layout;
  hierarchySel.value = o.hierarchy;
  existingSel.value = o.existing;
  keyframesSel.value = o.keyframes;
  updateOptionsNote();
  updateSendButton();
}

// --- Events ---------------------------------------------------------------

targetsEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".a-target") as HTMLElement | null;
  if (!btn) return;
  prefsApplied = true;
  target = (btn.dataset.target || "") as Role | "";
  selectButton(targetsEl, ".a-target", "target", target);
  updateSendButton();
  savePrefs();
});

scalesEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".a-scale") as HTMLElement | null;
  if (!btn) return;
  const s = Number(btn.dataset.scale);
  if (SCALES.indexOf(s) < 0) return;
  prefsApplied = true;
  scale = s;
  selectButton(scalesEl, ".a-scale", "scale", String(s));
  savePrefs();
});

for (const sel of [layoutSel, hierarchySel, existingSel, keyframesSel, placeSel]) {
  sel.addEventListener("change", () => {
    prefsApplied = true;
    updateOptionsNote();
    updatePlaceNote();
    savePrefs();
  });
}

sendBtn.addEventListener("click", () => {
  setStatus("", "");
  diagnostics = [];
  renderDiagnostics();
  parent.postMessage({ pluginMessage: { type: "export", target: target || null, scale, place: placeSel.value } }, "*");
});

retryEl.addEventListener("click", (e) => {
  e.preventDefault();
  connect();
});

// Messages from the plugin main thread.
window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage;
  if (!msg) return;
  if (msg.type === "selection") {
    selectionCount = msg.count;
    updateSendButton();
  } else if (msg.type === "prefs") {
    // Saved choices arrive once at start-up; never override one the user has made since.
    if (!prefsApplied) {
      prefsApplied = true;
      applyPrefs(msg);
    }
  } else if (msg.type === "ir") {
    // Several whole frames arrive as one document each (a comp / document per frame).
    const docs = (Array.isArray(msg.documents) ? msg.documents : [msg.document]) as Document[];
    const options = currentOptions();
    batch = docs.length > 1 ? { ids: new Set(), total: docs.length, done: 0, layers: 0, failures: [], from: "" } : null;
    docs.forEach((doc, i) => {
      addDiagnostics("Figma", doc.diagnostics);
      // The receiving app's builder lays the transfer out as asked here.
      doc.options = Object.assign({}, options);
      dispatchTransfer(doc, (msg.target as Role) || undefined, i);
    });
    if (batch) setStatus(`Sent ${docs.length} frames, one ${frameUnit()} each…`, "");
  } else if (msg.type === "built") {
    // The main thread finished rebuilding a transfer: tell the sender.
    const r = msg.result || { ok: false, layersCreated: 0, message: "", diagnostics: [] };
    addDiagnostics("Figma", r.diagnostics);
    if (r.ok) {
      const extra = r.message ? ` ${r.message}` : "";
      setStatus(`Rebuilt ${r.layersCreated} layer${r.layersCreated === 1 ? "" : "s"}.${extra}`, "ok");
    } else {
      setStatus(r.message || "The transfer could not be rebuilt.", "err");
    }
    send({
      type: "ack",
      id: msg.id,
      from: "figma",
      ok: !!r.ok,
      message: r.message || "",
      layersCreated: r.layersCreated || 0,
      diagnostics: r.diagnostics || [],
    });
  } else if (msg.type === "error") {
    setStatus(msg.message, "err");
    updateSendButton();
  }
};

function dispatchTransfer(document: Document, tgt?: Role, index = 0) {
  const id = uuid();
  const transfer: TransferMessage = { type: "transfer", id, target: tgt, document };
  pending.set(id, Date.now());
  if (batch) batch.ids.add(id);
  send(transfer);
  // Leaves are what a target builds; the groups around them are not counted.
  const n = countLeaves(document.layers);
  setStatus(`Sent ${n} layer${n === 1 ? "" : "s"}…`, "");
  updateSendButton();

  // Time out a stuck transfer so the button re-enables. A target builds the
  // frames of a batch one after another, so later ones get longer.
  window.setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id);
      if (batch && batch.ids.has(id)) {
        batchAck(id, false, 0, "no response", "");
      } else {
        setStatus("No response from Adobe (is the panel open?).", "err");
      }
      updateSendButton();
    }
  }, 12000 + 8000 * index);
}

// --- Several frames, one document / comp each --------------------------------

type Batch = { ids: Set<string>; total: number; done: number; layers: number; failures: string[]; from: string };
let batch: Batch | null = null;

/** "comp" when After Effects is the only target, else "document". */
function frameUnit(): string {
  return target === "aftereffects" ? "comp" : "document";
}

/**
 * Count one frame's acknowledgement; the status shows progress, then a single
 * summary once every frame has answered. Returns false for a transfer outside
 * the current batch.
 */
function batchAck(id: string, ok: boolean, layers: number, message: string, from: string): boolean {
  if (!batch || !batch.ids.has(id)) return false;
  batch.ids.delete(id);
  batch.done++;
  if (from) batch.from = from;
  if (ok) batch.layers += layers;
  else batch.failures.push(message || "transfer failed");
  const who = batch.from || "Adobe";
  if (batch.done < batch.total) {
    setStatus(`${who}: ${batch.done} of ${batch.total} frames built…`, "");
  } else {
    const built = batch.total - batch.failures.length;
    const text = `${who}: ${built} of ${batch.total} frames built as separate ${frameUnit()}s, ${batch.layers} layer(s).` +
      (batch.failures.length ? ` Failed: ${batch.failures.join("; ")}` : "");
    setStatus(text, batch.failures.length ? "err" : "ok");
    batch = null;
  }
  return true;
}


// --- Window resizing --------------------------------------------------------
// A Figma plugin window is only ever the size the plugin asks for — there is no
// chrome to drag — so the grip in the corner is that chrome. The grip sits at
// the window's bottom-right, so wherever the pointer is during a drag is, plus
// the grip's own inset, exactly the size the window should become.

const grip = $("#grip");
const MIN_W = 300;
const MIN_H = 360;
const GRIP_INSET = 8;

/** The size last asked for, so it can be remembered with the other choices. */
let winWidth = 0;
let winHeight = 0;
let resizing = false;

function resizeTo(width: number, height: number) {
  const w = Math.max(MIN_W, Math.ceil(width));
  const h = Math.max(MIN_H, Math.ceil(height));
  if (w === winWidth && h === winHeight) return;
  winWidth = w;
  winHeight = h;
  parent.postMessage({ pluginMessage: { type: "resize", width: w, height: h } }, "*");
}

grip.addEventListener("pointerdown", (e) => {
  const ev = e as PointerEvent;
  resizing = true;
  try {
    grip.setPointerCapture(ev.pointerId);
  } catch {
    // Capture is a nicety; the move handler works without it.
  }
  ev.preventDefault();
});

grip.addEventListener("pointermove", (e) => {
  if (!resizing) return;
  const ev = e as PointerEvent;
  resizeTo(ev.clientX + GRIP_INSET, ev.clientY + GRIP_INSET);
});

function endResize(e: Event) {
  if (!resizing) return;
  resizing = false;
  try {
    grip.releasePointerCapture((e as PointerEvent).pointerId);
  } catch {
    /* nothing held it */
  }
  savePrefs();
}
grip.addEventListener("pointerup", endResize);
grip.addEventListener("pointercancel", endResize);

/** Note the size the window actually is, so a later save does not undo it. */
function noteSize(width: unknown, height: unknown) {
  const w = Number(width);
  const h = Number(height);
  if (w >= MIN_W) winWidth = w;
  if (h >= MIN_H) winHeight = h;
}

function uuid(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Boot: ask the main thread for anything posted before this page was listening.
connect();
renderDiagnostics();
updateOptionsNote();
parent.postMessage({ pluginMessage: { type: "ready" } }, "*");
