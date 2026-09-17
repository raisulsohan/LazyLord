/*
 * LazyLord CEP panel controller.
 * Receives design transfers and drives the host-specific ExtendScript builder,
 * and — on hosts that have a reader — pushes the current selection out to
 * another app through the bridge.
 */
(function () {
  "use strict";

  var DEFAULT_PORT = 7878;
  var BRIDGE_URL = "ws://127.0.0.1:" + DEFAULT_PORT;
  var PROTOCOL_VERSION = 1;
  /** Kept in step with package.json by tools/package-zxp.mjs. */
  var PANEL_VERSION = "1.1.3";
  var AUTHOR_URL = "https://raisulsohan.com/";

  /** Hosts that ship a reader module and can therefore originate a transfer. */
  var READ_MODULE = { illustrator: "ai-read", aftereffects: "ae-read", photoshop: "ps-read" };
  /**
   * Where a transfer goes by default when several apps are listening. Only a
   * starting point: the select lists every connected app, and the choice is
   * remembered per host.
   */
  var PREFERRED_TARGET = { illustrator: "aftereffects", aftereffects: "illustrator", photoshop: "aftereffects" };
  /**
   * Where the receiving app builds, and how the transfer is sized for it:
   *   active    — into the document or comp already open
   *   page      — a new one the size of the source page (artboard / composition)
   *   selection — a new one the size of the selection, artwork at its origin
   */
  var DESTINATIONS = ["active", "page", "selection"];
  var DEST_NOTES = {
    active: "Into the document or composition already open, where it sits on the page.",
    page: "A new document or composition the size of the source page, with everything where it sits on it.",
    selection: "A new document or composition the size of the selection, with the artwork at its origin."
  };
  var SCALES = ["1", "2", "3", "4"];
  /**
   * Fallback ladder rungs, worst first. The diagnostics card lists them in this
   * order so the things that did not arrive at all are read before the rest.
   */
  var RESOLUTIONS = ["skipped", "rasterized", "approximated"];
  /** How long a push waits for its ack before the button is freed again. */
  var PUSH_TIMEOUT_MS = 20000;
  /** How long a timed-out push can still be answered (the bridge's own TTL). */
  var LATE_ACK_TTL_MS = 5 * 60 * 1000;

  var cs = new CSInterface();
  var env = cs.getHostEnvironment();
  var appName = (env && env.appName) || "UNKN";

  // Optional Node modules (available with --enable-nodejs).
  var fs = null, os = null, nodePath = null;
  try { fs = require("fs"); os = require("os"); nodePath = require("path"); } catch (e) {}

  var connEl = document.getElementById("conn");
  var connText = document.getElementById("conn-text");
  var hostEl = document.getElementById("host");
  var hostSub = document.getElementById("host-sub");
  var logEl = document.getElementById("log");
  var logCard = document.getElementById("log-card");
  var logLast = document.getElementById("log-last");
  var autoEl = document.getElementById("auto");
  var pushCard = document.getElementById("push-card");
  var pushSub = document.getElementById("push-sub");
  var pushBtn = document.getElementById("push");
  var liveEl = document.getElementById("push-live");
  var targetsEl = document.getElementById("push-targets");
  var layoutSel = document.getElementById("push-layout");
  var hierarchySel = document.getElementById("push-hierarchy");
  var existingSel = document.getElementById("push-existing");
  var keyframesSel = document.getElementById("push-keyframes");
  var keyframesRow = document.getElementById("push-keyframes-row");
  var conflictSel = document.getElementById("push-conflict");
  var conflictRow = document.getElementById("push-conflict-row");
  var onlyChangedEl = document.getElementById("push-only-changed");
  var onlyChangedRow = document.getElementById("push-only-changed-row");
  var guidesEl = document.getElementById("push-guides");
  var sequenceEl = document.getElementById("push-sequence");
  var sequenceRow = document.getElementById("push-sequence-row");
  var swatchesEl = document.getElementById("push-swatches");
  var optsHint = document.getElementById("push-opts-hint");
  var destinationSel = document.getElementById("push-destination");
  var destNote = document.getElementById("push-dest-note");
  var scalesEl = document.getElementById("push-scales");
  var optsNote = document.getElementById("push-opts-note");
  var diagCard = document.getElementById("diag-card");
  var presetSel = document.getElementById("push-preset");
  var presetName = document.getElementById("push-preset-name");
  var presetSave = document.getElementById("push-preset-save");
  var presetDelete = document.getElementById("push-preset-delete");
  var historyList = document.getElementById("history-list");
  var historyCount = document.getElementById("history-count");
  var historyClear = document.getElementById("history-clear");
  var diagHead = document.getElementById("diag-head");
  var diagTitle = document.getElementById("diag-title") || diagHead;
  var diagCounts = document.getElementById("diag-counts");
  var diagList = document.getElementById("diag-list");

  var ws = null;
  var reconnectTimer = null;
  var jsxReady = false;
  var jsxLoading = false;
  var jsxWaiters = [];
  var jsxError = "";
  var JSX_LOAD_TIMEOUT_MS = 15000;
  var peers = [];
  var pendingPush = null;
  /** What the pending push sent, so its ack can be summarised. */
  var pendingPushInfo = null;
  /**
   * Pushes that timed out, by transfer id: { info, at }. A slow rebuild can
   * still answer, and its result (fallbacks included) is reported when it does.
   */
  var lateAcks = {};
  var pushBusy = false;
  var targetsAvailable = false;
  var diagItems = [];
  /** The transfer id the diagnostics card currently describes. */
  var diagFor = null;
  var prefs = {};
  var prefsWarned = false;

  function roleForApp(name) {
    if (name === "PHXS" || name === "PHSP") return "photoshop";
    if (name === "ILST") return "illustrator";
    if (name === "AEFT") return "aftereffects";
    return "unknown";
  }
  function roleLabel(role) {
    return {
      photoshop: "Photoshop",
      illustrator: "Illustrator",
      aftereffects: "After Effects",
      figma: "Figma"
    }[role] || "Unknown";
  }
  var role = roleForApp(appName);
  var canPush = !!READ_MODULE[role];

  hostEl.firstChild.nodeValue = roleLabel(role);
  hostSub.textContent = appName + " " + (env.appVersion || "");

  /* Which LazyLord this is — the first thing a bug report needs. */
  var verEl = document.getElementById("ver");
  if (verEl) verEl.textContent = "v" + PANEL_VERSION;

  /* A panel is a browser with nowhere to go: a plain link would load the site
     inside it, with no way back. CEP hands the URL to the real browser. */
  var authorEl = document.getElementById("author");
  if (authorEl) {
    authorEl.onclick = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      try {
        window.cep.util.openURLInDefaultBrowser(AUTHOR_URL);
      } catch (err) {
        log("Could not open " + AUTHOR_URL + " — " + (err.message || err), "warn");
      }
      return false;
    };
  }

  function log(msg, kind) {
    var line = document.createElement("div");
    if (kind) line.className = kind;
    var t = new Date().toTimeString().slice(0, 8);
    line.textContent = "[" + t + "] " + msg;
    if (logEl.firstChild && logEl.firstChild.nodeType === 3) logEl.textContent = "";
    logEl.appendChild(line);
    // Live adds lines all session long: keep the newest LOG_MAX.
    while (logEl.children && logEl.children.length > LOG_MAX && logEl.firstChild) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
    /* The log itself stays shut: the newest line shows beside its summary, and
       anything that went wrong opens it without being asked. */
    if (logLast) {
      logLast.textContent = msg;
      logLast.className = "a-last" + (kind === "err" || kind === "warn" ? " " + kind : "");
    }
    if (logCard && (kind === "err" || kind === "warn")) logCard.open = true;
  }
  var LOG_MAX = 500;

  function setConn(on, text) {
    connEl.className = "conn" + (on ? " on" : "");
    connText.textContent = text;
  }

  function jsonStr(s) {
    return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function newId() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

  /** Array membership without Array.prototype.indexOf (ES3-safe). */
  function contains(list, value) {
    for (var i = 0; list && i < list.length; i++) if (list[i] === value) return true;
    return false;
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function plural(n, one) {
    return n + " " + one + (n === 1 ? "" : "s");
  }

  // --- Preferences --------------------------------------------------------
  // Kept per host role ("lazylord.prefs.illustrator", …), so Illustrator and
  // After Effects on the same machine each remember their own auto-receive
  // setting, push destination and push options. Storage can be missing or
  // refuse writes (locked-down profiles); the panel then works with defaults
  // and says so once.

  var PREFS_KEY = "lazylord.prefs." + role;

  function prefsStore() {
    try { return window.localStorage || null; } catch (e) { return null; }
  }

  function prefsProblem(msg) {
    if (prefsWarned) return;
    prefsWarned = true;
    log(msg);
  }

  function loadPrefs() {
    var st = prefsStore();
    if (!st) {
      prefsProblem("Preferences cannot be stored here; they will reset when the panel closes.");
      return {};
    }
    var raw = null;
    try { raw = st.getItem(PREFS_KEY); } catch (e) {
      prefsProblem("Saved preferences could not be read; using the defaults.");
      return {};
    }
    if (!raw) return {};
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (e2) {}
    prefsProblem("Saved preferences were unreadable and have been reset.");
    return {};
  }

  function savePref(key, value) {
    prefs[key] = value;
    var st = prefsStore();
    if (!st) {
      prefsProblem("Preferences cannot be stored here; they will reset when the panel closes.");
      return;
    }
    try {
      st.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {
      prefsProblem("Preferences could not be saved; they will reset when the panel closes.");
    }
  }

  /**
   * Auto-receive and the push options are restored at once; the push target
   * waits for peers. A stored value the panel does not offer is ignored.
   */
  function restorePrefs() {
    prefs = loadPrefs();
    if (typeof prefs.autoReceive === "boolean") autoEl.checked = prefs.autoReceive;
    if (layoutSel && contains(LAYOUTS, prefs.layout)) layoutSel.value = prefs.layout;
    if (hierarchySel && contains(HIERARCHIES, prefs.hierarchy)) hierarchySel.value = prefs.hierarchy;
    if (existingSel && contains(EXISTING, prefs.existing)) existingSel.value = prefs.existing;
    if (keyframesSel && contains(KEYFRAMES, prefs.keyframes)) keyframesSel.value = prefs.keyframes;
    if (conflictSel && contains(CONFLICTS, prefs.conflict)) conflictSel.value = prefs.conflict;
    if (guidesEl && typeof prefs.guides === "boolean") guidesEl.checked = prefs.guides;
    if (sequenceRow) sequenceRow.hidden = role !== "photoshop";
    if (sequenceEl && role === "photoshop" && typeof prefs.sequence === "boolean") sequenceEl.checked = prefs.sequence;
    if (onlyChangedEl && typeof prefs.onlyChanged === "boolean") onlyChangedEl.checked = prefs.onlyChanged;
    if (swatchesEl && typeof prefs.swatches === "boolean") swatchesEl.checked = prefs.swatches;
    if (destinationSel && contains(DESTINATIONS, prefs.destination)) destinationSel.value = prefs.destination;
    if (scalesEl && contains(SCALES, String(prefs.scale))) selectChip(scalesEl, "scale", prefs.scale);
    renderImageFolder();
    updateDestNote();
    updateOptionsNote();
  }

  // --- Presets and history -------------------------------------------------
  // Both are lists kept per host role next to the preferences, in the same
  // storage and with the same tolerance for a profile that refuses to store.

  var PRESETS_KEY = "lazylord.presets." + role;
  var HISTORY_KEY = "lazylord.history." + role;
  var HISTORY_MAX = 25;

  function loadList(key) {
    var st = prefsStore();
    if (!st) return [];
    try {
      var parsed = JSON.parse(st.getItem(key) || "[]");
      return isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveList(key, list) {
    var st = prefsStore();
    if (!st) {
      prefsProblem("Preferences cannot be stored here; they will reset when the panel closes.");
      return;
    }
    try { st.setItem(key, JSON.stringify(list)); } catch (e) {
      prefsProblem("Preferences could not be saved; they will reset when the panel closes.");
    }
  }

  function trimText(s) {
    return String(s || "").replace(/^\s+|\s+$/g, "");
  }

  /** Everything a preset holds: the Destination, Image scale and Options shown now. */
  function currentSettings() {
    var o = pushOptions();
    return {
      destination: destinationSel ? destinationSel.value : "active",
      scale: Number(activeChip(scalesEl, "scale") || 2),
      layout: o.layout,
      hierarchy: o.hierarchy,
      existing: o.existing,
      keyframes: o.keyframes,
      conflict: o.conflict,
      guides: o.guides,
      swatches: o.swatches
    };
  }

  /** Put a preset's values into the card and remember them as the current choices. */
  function applySettings(s) {
    if (destinationSel && contains(DESTINATIONS, s.destination)) { destinationSel.value = s.destination; savePref("destination", s.destination); }
    if (scalesEl && contains(SCALES, String(s.scale))) { selectChip(scalesEl, "scale", s.scale); savePref("scale", Number(s.scale)); }
    if (layoutSel && contains(LAYOUTS, s.layout)) { layoutSel.value = s.layout; savePref("layout", s.layout); }
    if (hierarchySel && contains(HIERARCHIES, s.hierarchy)) { hierarchySel.value = s.hierarchy; savePref("hierarchy", s.hierarchy); }
    if (existingSel && contains(EXISTING, s.existing)) { existingSel.value = s.existing; savePref("existing", s.existing); }
    if (keyframesSel && contains(KEYFRAMES, s.keyframes)) { keyframesSel.value = s.keyframes; savePref("keyframes", s.keyframes); }
    if (conflictSel && contains(CONFLICTS, s.conflict)) { conflictSel.value = s.conflict; savePref("conflict", s.conflict); }
    if (guidesEl && typeof s.guides === "boolean") { guidesEl.checked = s.guides; savePref("guides", s.guides); }
    if (swatchesEl && typeof s.swatches === "boolean") { swatchesEl.checked = s.swatches; savePref("swatches", s.swatches); }
    updateDestNote();
    updateOptionsNote();
  }

  function findPreset(list, name) {
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].name === name) return i;
    return -1;
  }

  function renderPresets(selected) {
    if (!presetSel) return;
    var list = loadList(PRESETS_KEY);
    clearChildren(presetSel);
    var none = document.createElement("option");
    none.value = "";
    none.textContent = list.length ? "—" : "No presets yet";
    presetSel.appendChild(none);
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || typeof list[i].name !== "string") continue;
      var opt = document.createElement("option");
      opt.value = list[i].name;
      opt.textContent = list[i].name;
      presetSel.appendChild(opt);
    }
    presetSel.value = selected && findPreset(list, selected) >= 0 ? selected : "";
    if (presetDelete) presetDelete.disabled = !presetSel.value;
  }

  function savePreset() {
    var name = trimText(presetName && presetName.value) || trimText(presetSel && presetSel.value);
    if (!name) { log("Type a name for the preset first.", "warn"); return; }
    var list = loadList(PRESETS_KEY);
    var entry = { name: name, values: currentSettings() };
    var at = findPreset(list, name);
    if (at >= 0) list[at] = entry; else list.push(entry);
    saveList(PRESETS_KEY, list);
    if (presetName) presetName.value = "";
    renderPresets(name);
    log((at >= 0 ? "Updated" : "Saved") + " preset \"" + name + "\".");
  }

  function usePreset(name) {
    if (presetDelete) presetDelete.disabled = !name;
    if (!name) return;
    var list = loadList(PRESETS_KEY);
    var at = findPreset(list, name);
    if (at < 0) return;
    applySettings(list[at].values || {});
    log("Preset \"" + name + "\" applied.");
  }

  function deletePreset() {
    var name = presetSel ? presetSel.value : "";
    if (!name) return;
    var list = loadList(PRESETS_KEY);
    var at = findPreset(list, name);
    if (at >= 0) list.splice(at, 1);
    saveList(PRESETS_KEY, list);
    renderPresets("");
    log("Deleted preset \"" + name + "\".");
  }

  /**
   * One finished transfer, newest first: { dir: "in" | "out", peer, name, ok,
   * layers, updated, fallbacks, message }. Only counts and names are kept.
   */
  function recordHistory(entry) {
    entry.t = new Date().getTime();
    var list = loadList(HISTORY_KEY);
    list.unshift(entry);
    if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
    saveList(HISTORY_KEY, list);
    renderHistory();
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function historyTime(t) {
    var d = new Date(t);
    var now = new Date();
    var time = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return time;
    return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + " " + time;
  }

  function historyText(e) {
    var route = e.dir === "in" ? e.peer + " → here" : "here → " + e.peer;
    var parts = [route];
    if (e.name) parts.push("\"" + e.name + "\"");
    if (!e.ok) {
      parts.push("failed" + (e.message ? ": " + e.message : ""));
      return parts.join(" · ");
    }
    var built = plural(e.layers || 0, "layer");
    if (e.updated) built += " (" + e.updated + " updated)";
    parts.push(built);
    return parts.join(" · ");
  }

  function renderHistory() {
    if (!historyList) return;
    var list = loadList(HISTORY_KEY);
    clearChildren(historyList);
    if (historyCount) historyCount.textContent = list.length ? String(list.length) : "";
    if (!list.length) {
      var empty = document.createElement("li");
      empty.className = "a-history-item a-history-empty";
      empty.textContent = "Nothing sent or received yet.";
      historyList.appendChild(empty);
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      var li = document.createElement("li");
      li.className = "a-history-item" + (e.ok ? "" : " err");
      var time = document.createElement("span");
      time.className = "a-history-time";
      time.textContent = historyTime(e.t || 0);
      li.appendChild(time);
      li.appendChild(document.createTextNode(historyText(e)));
      if (e.ok && e.fallbacks) {
        var fb = document.createElement("span");
        fb.className = "a-history-fb";
        fb.textContent = " · " + plural(e.fallbacks, "fallback");
        li.appendChild(fb);
      }
      historyList.appendChild(li);
    }
  }

  // --- Transfer options ---------------------------------------------------
  // The sender chooses how the target lays a push out, and the target's
  // builder obeys doc.options. The defaults (Split + Flatten) reproduce what
  // every builder produced before options existed, so notes and log lines
  // only ever mention a choice that differs from them.

  var LAYOUTS = ["split", "combine"];
  var HIERARCHIES = ["flatten", "groups", "precomps"];
  var EXISTING = ["add", "update"];
  var KEYFRAMES = ["auto", "always"];
  var CONFLICTS = ["overwrite", "keep"];

  /** Options with the defaults applied (mirrors core's transferOptions). */
  function normaliseOptions(o) {
    o = o || {};
    return {
      layout: o.layout === "combine" ? "combine" : "split",
      hierarchy: (o.hierarchy === "groups" || o.hierarchy === "precomps") ? o.hierarchy : "flatten",
      existing: o.existing === "update" ? "update" : "add",
      keyframes: o.keyframes === "always" ? "always" : "auto",
      conflict: o.conflict === "keep" ? "keep" : "overwrite",
      guides: o.guides === true,
      swatches: o.swatches === true
    };
  }

  /** The non-default choices as the push card labels them, e.g. "Combine, Groups"; "" for the defaults. */
  function optionsNote(o) {
    var parts = [];
    if (o.layout === "combine") parts.push("Combine");
    if (o.hierarchy === "groups") parts.push("Groups");
    if (o.hierarchy === "precomps") parts.push("Precomps");
    if (o.existing === "update") parts.push("Update");
    if (o.existing === "update" && o.keyframes === "always") parts.push("Always key");
    if (o.existing === "update" && o.conflict === "keep") parts.push("Keep edits");
    if (o.guides) parts.push("Guides");
    if (o.swatches) parts.push("Swatches");
    if (sequenceWanted()) parts.push("Frames");
    var sc = activeChip(scalesEl, "scale");
    if (sc && sc !== "2") parts.push(sc + "x");
    return parts.join(", ");
  }

  /** What the push card's selects say right now. */
  function pushOptions() {
    return normaliseOptions({
      layout: layoutSel ? layoutSel.value : "",
      hierarchy: hierarchySel ? hierarchySel.value : "",
      existing: existingSel ? existingSel.value : "",
      keyframes: keyframesSel ? keyframesSel.value : "",
      conflict: conflictSel ? conflictSel.value : "",
      guides: !!(guidesEl && guidesEl.checked),
      swatches: !!(swatchesEl && swatchesEl.checked)
    });
  }

  /**
   * Shape the document for where it is going. The readers always write the
   * artwork against its source page, which is what "active" and "page" want;
   * "selection" drops that page so the target sizes itself to the selection
   * and builds it at its own origin (LazyLord.canvasSize falls back to bounds,
   * and applyOrigin leaves canvas-space artwork alone).
   */
  function applyDestination(doc, place) {
    // There is nothing to update in a document that does not exist yet.
    if (place === "active" || doc.options.existing === "update") {
      doc.options.destination = "active";
      return;
    }
    doc.options.destination = "new";
    if (place === "selection") {
      doc.originSpace = "canvas";
      delete doc.canvas;
    }
  }

  /**
   * A Figma plugin runs in a browser sandbox and cannot open a file on disk, so
   * anything going there travels as bytes rather than as a path. Every other
   * host is on this machine and reads the file itself.
   */
  function embedImagesForFigma(doc) {
    eachLayer(doc.layers, function (layer) {
      // A layer mask is an image too.
      if (layer.mask && layer.mask.filePath && !layer.mask.pngBase64) {
        try {
          layer.mask.pngBase64 = readBase64(layer.mask.filePath);
        } catch (eMask) {
          log("Could not read " + layer.mask.filePath + " to send to Figma: " + eMask.message, "warn");
        }
      }
      if (layer.type !== "image" || layer.pngBase64 || !layer.filePath) return;
      try {
        layer.pngBase64 = readBase64(layer.filePath);
      } catch (e) {
        log("Could not read " + layer.filePath + " to send to Figma: " + e.message, "warn");
      }
    });
  }

  function updateDestNote() {
    if (!destNote || !destinationSel) return;
    destNote.textContent = DEST_NOTES[destinationSel.value] || "";
  }

  /** The Options disclosure stays closed, so its label shows what differs from the defaults. */
  function updateOptionsNote() {
    var o = pushOptions();
    if (optsNote) optsNote.textContent = optionsNote(o);

    // Keyframes only mean anything while updating, and only in After Effects.
    var updating = (o.existing === "update");
    if (keyframesRow) keyframesRow.hidden = !updating;
    if (onlyChangedRow) onlyChangedRow.hidden = !updating;
    if (conflictRow) conflictRow.hidden = !updating;
    if (optsHint) {
      if (!updating) optsHint.textContent = "";
      else if (destinationSel && destinationSel.value !== "active") {
        optsHint.textContent = "Update edits what an earlier send built, so it goes into the open document — " +
          "the Destination above is ignored.";
      } else {
        optsHint.textContent = "Layers an earlier send built are edited where they stand. " +
          "Layout and Hierarchy are ignored for those.";
      }
    }
  }

  // --- Load ExtendScript modules -----------------------------------------

  /**
   * Load the ExtendScript modules. Each file is evaluated in its own top-level
   * try/catch (kept out of a function so $.evalFile stays in global scope), so
   * a failure names the file, line and message rather than CEP's bare
   * "EvalScript error.". `done(ok)` is optional; callers arriving while a load
   * is already running wait for it.
   */
  function loadJsx(done) {
    if (done) jsxWaiters.push(done);
    if (jsxLoading) return;

    var ext = cs.getSystemPath(SystemPath.EXTENSION);
    var jsxDir = ext + "/jsx";
    var host = role === "aftereffects" ? "ae" : role === "illustrator" ? "ai" : role === "photoshop" ? "ps" : null;
    if (!host) {
      jsxError = "unsupported host application " + appName;
      log("Unsupported host application: " + appName, "err");
      flushJsxWaiters(false);
      return;
    }

    var files = [jsxDir + "/json2.js", jsxDir + "/lazylord.jsx", jsxDir + "/" + host + ".jsx"];
    if (READ_MODULE[role]) files.push(jsxDir + "/" + READ_MODULE[role] + ".jsx");

    var script = "var __lazylordLoad = 'ok';";
    for (var i = 0; i < files.length; i++) {
      script += "if (__lazylordLoad === 'ok') { try { $.evalFile(" + jsonStr(files[i]) + "); } catch (e) { " +
        "__lazylordLoad = 'error|" + i + "|' + e.line + '|' + e.message; } }";
    }
    script += "__lazylordLoad;";

    jsxLoading = true;
    var answered = false;
    // A host busy with a modal dialog, or still starting up, may never answer.
    var timer = setTimeout(function () {
      if (answered) return;
      jsxLoading = false;
      jsxError = "the application did not answer, it may be busy or showing a dialog";
      log("Loading the host scripts timed out: " + jsxError + ".", "err");
      loadFailed();
    }, JSX_LOAD_TIMEOUT_MS);

    cs.evalScript(script, function (res) {
      answered = true;
      clearTimeout(timer);
      jsxLoading = false;
      if (res === "ok") {
        jsxReady = true;
        jsxError = "";
        log("Host modules loaded (" + host + (canPush ? " + reader" : "") + ").");
        showSendCards();
        updatePushButton();
        flushJsxWaiters(true);
        return;
      }
      jsxError = describeLoadError(res, files);
      log("Failed to load the host scripts: " + jsxError, "err");
      loadFailed();
    });
  }

  /**
   * Everything about sending appears at once, so a host that cannot send shows
   * a receive-only panel rather than dead controls.
   */
  function showSendCards() {
    if (!canPush) return;
    var cards = ["push-card", "scale-card", "destination-card", "options-card", "send-card"];
    for (var c = 0; c < cards.length; c++) {
      var el = document.getElementById(cards[c]);
      if (el) el.hidden = false;
    }
    pushSub.textContent = "Send the selected " +
      (role === "aftereffects" ? "layers" : "artwork") + " to another app.";
    updateDestNote();
  }

  /**
   * The scripts did not load (the host was busy or starting up). The send side
   * still appears, and Send tries loading them again.
   */
  function loadFailed() {
    showSendCards();
    if (canPush) log("Press Send to try loading the scripts again.");
    updatePushButton();
    flushJsxWaiters(false);
  }

  function flushJsxWaiters(ok) {
    var waiting = jsxWaiters;
    jsxWaiters = [];
    for (var i = 0; i < waiting.length; i++) waiting[i](ok);
  }

  /** "error|<file index>|<line>|<message>" from the loader, or CEP's own text. */
  function describeLoadError(res, files) {
    var text = String(res);
    if (text.indexOf("error|") !== 0) return text || "no answer from the application";
    var parts = text.split("|");
    var file = files[Number(parts[1])] || "";
    var name = file.replace(/^.*[\\\/]/, "") || "a script";
    return name + " line " + parts[2] + ": " + parts.slice(3).join("|");
  }

  // --- Bridge connection --------------------------------------------------

  // --- The bridge, run by the panel itself ----------------------------------
  // Nobody starts a bridge by hand: the first LazyLord panel opened hosts the
  // relay in its own Node context (js/relay.js), and every panel — that one
  // included — and the Figma plugin connect to it. When the hosting app quits,
  // the others lose their connection, and the next to reconnect takes the port
  // over. A stand-alone bridge (start-bridge.bat) still works: it holds the
  // port, and the panels simply use it.

  var relay = null;
  var relayNoted = false;

  function ensureBridge(done) {
    if (relay || typeof require !== "function") { done(); return; }
    var mod = null;
    try {
      mod = require(cs.getSystemPath(SystemPath.EXTENSION) + "/js/relay.js");
    } catch (e) {
      // Not built (an old install): a stand-alone bridge may be running instead.
      if (!relayNoted) {
        relayNoted = true;
        log("The built-in bridge is missing (run install.bat again); looking for a running bridge instead.", "warn");
      }
      done();
      return;
    }
    mod.startRelay({ port: DEFAULT_PORT }).then(function (r) {
      relay = r;
      done();
    }, function () {
      // The port is served already — by another app's panel, or a stand-alone bridge.
      done();
    });
  }

  function stopBridge() {
    if (!relay) return;
    try { relay.close(); } catch (e) {}
    relay = null;
  }

  function connect() {
    ensureBridge(openSocket);
  }

  function openSocket() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // The old socket is let go first, so its close cannot schedule a reconnect
    // of its own: that turned Reconnect into an endless drop-and-reconnect.
    var old = ws;
    ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch (e) {}
    }
    setConn(false, "Connecting…");
    var sock;
    try {
      sock = ws = new WebSocket(BRIDGE_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    sock.onopen = function () {
      if (sock !== ws) return;
      setConn(true, "Connected");
      send({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        role: role,
        client: roleLabel(role) + " " + (env.appVersion || "")
      });
      log("Connected to LazyLord bridge.");
    };
    sock.onmessage = function (ev) {
      if (sock !== ws) return;
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      onMessage(msg);
    };
    sock.onclose = function () {
      if (sock !== ws) return;
      setConn(false, "Bridge offline");
      peers = [];
      renderTargets();
      scheduleReconnect();
    };
    sock.onerror = function () { try { sock.close(); } catch (e) {} };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, 2500);
  }

  /** False when the bridge is not connected, so nothing went. */
  function send(msg) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  // --- Large transfers -----------------------------------------------------
  // Mirrors chunkTransfer / ChunkJoiner in packages/core/src/protocol.ts: a
  // transfer longer than CHUNK_THRESHOLD characters travels as CHUNK_SIZE
  // pieces the receiver joins back together.

  var CHUNK_THRESHOLD = 4 * 1024 * 1024;
  var CHUNK_SIZE = 1024 * 1024;
  var CHUNK_TIMEOUT_MS = 2 * 60 * 1000;
  var chunksOpen = {};

  /** How many messages it took; 0 when the bridge was not connected (or dropped part-way). */
  function sendTransfer(msg) {
    var text = JSON.stringify(msg);
    if (text.length <= CHUNK_THRESHOLD) return send(msg) ? 1 : 0;
    var total = Math.ceil(text.length / CHUNK_SIZE);
    for (var i = 0; i < total; i++) {
      var sent = send({ type: "chunk", id: msg.id, target: msg.target, index: i, total: total,
        data: text.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) });
      if (!sent) return 0;
    }
    return total;
  }

  /** Forget half-joined transfers whose sender went quiet. */
  function pruneChunks(now) {
    now = now || new Date().getTime();
    for (var k in chunksOpen) {
      if (Object.prototype.hasOwnProperty.call(chunksOpen, k) && now - chunksOpen[k].at > CHUNK_TIMEOUT_MS) delete chunksOpen[k];
    }
  }

  /** Add one chunk; the whole transfer once its last piece is in, else null. */
  function joinChunk(c, now) {
    now = now || new Date().getTime();
    pruneChunks(now);
    if (!c || typeof c.id !== "string" || !(c.total > 0) || !(c.index >= 0 && c.index < c.total)) return null;
    var rec = Object.prototype.hasOwnProperty.call(chunksOpen, c.id) ? chunksOpen[c.id] : null;
    if (!rec || rec.total !== c.total) rec = chunksOpen[c.id] = { total: c.total, got: 0, data: [], at: now };
    rec.at = now;
    if (rec.data[c.index] === undefined) rec.got++;
    rec.data[c.index] = String(c.data || "");
    if (rec.got < rec.total) return null;
    delete chunksOpen[c.id];
    try {
      var whole = JSON.parse(rec.data.join(""));
      return whole && whole.type === "transfer" ? whole : null;
    } catch (e) {
      log("A large transfer arrived damaged and was dropped.", "err");
      return null;
    }
  }

  function onMessage(msg) {
    // Any message will do as a clock: a transfer cut off half-way is dropped
    // even if no other large transfer ever arrives.
    if (msg.type !== "chunk") pruneChunks();
    if (msg.type === "chunk") {
      var joined = joinChunk(msg);
      if (joined) onMessage(joined);
    } else if (msg.type === "transfer") {
      if (!autoEl.checked) { declineTransfer(msg); return; }
      handleTransfer(msg);
    } else if (msg.type === "welcome" || msg.type === "peers") {
      peers = msg.peers || [];
      renderTargets();
    } else if (msg.type === "ack") {
      onAck(msg);
    } else if (msg.type === "request") {
      answerRequest(msg);
    } else if (msg.type === "reply") {
      onReply(msg);
    }
  }

  // --- Smart diff ------------------------------------------------------------
  // Every leaf sent is fingerprinted from its IR. After a successful send the
  // fingerprints are kept per destination app and source document; an update
  // then leaves out every leaf whose fingerprint has not changed (groups that
  // end up empty go too — updating ignores hierarchy anyway). The paths of
  // images LazyLord generated change on every read without the art changing,
  // so they are not part of the fingerprint.

  var SENT_KEY = "lazylord.sent." + role;
  var SENT_DOCS_MAX = 30;

  function hashText(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + "." + s.length.toString(36);
  }

  function leafPrint(layer, salt) {
    var copy = {};
    for (var k in layer) {
      if (!Object.prototype.hasOwnProperty.call(layer, k)) continue;
      if (k === "filePath" && layer.isOriginalFile !== true) continue;
      // A layer mask is always generated: its frame counts, its path does not.
      if (k === "mask" && layer.mask) {
        copy.mask = { frame: layer.mask.frame };
        continue;
      }
      copy[k] = layer[k];
    }
    return hashText(salt + JSON.stringify(copy));
  }

  function sequenceWanted() {
    return role === "photoshop" && !!(sequenceEl && sequenceEl.checked);
  }

  function onlyChangedWanted() {
    return !onlyChangedEl || onlyChangedEl.checked !== false;
  }

  /**
   * Fingerprint every leaf; with `prune`, drop the ones the destination
   * already has unchanged. Returns { key, prints, kept, skipped, pruned }.
   */
  function fingerprintLeaves(doc, target, prune) {
    var key = target + "|" + (doc.sourceKey || "") + "|" + (doc.source || "");
    var before = prune ? (loadSentMap()[key] || {}) : {};
    var prints = {}, kept = 0, skipped = 0;
    // Frames are measured from the selection's corner, so where the selection
    // sits is part of every print, and so is what a group passes on to its
    // leaves: moving the whole selection, or fading its group, is a change.
    var b = doc.bounds || { x: 0, y: 0 };
    var base = JSON.stringify([b.x, b.y, doc.originSpace || "", doc.canvas || null]);
    function walk(list, salt) {
      var out = [];
      for (var i = 0; list && i < list.length; i++) {
        var l = list[i];
        if (!l) continue;
        if (l.type === "group") {
          var passed = JSON.stringify([l.frame && l.frame.opacity, l.blendMode, l.effects, l.clip]);
          l.children = walk(l.children || [], salt + "|" + passed);
          if (!prune || l.children.length) out.push(l);
          continue;
        }
        var p = leafPrint(l, salt);
        if (l.id !== undefined) prints[l.id] = p;
        if (prune && l.id !== undefined && before[l.id] === p) { skipped++; continue; }
        kept++;
        out.push(l);
      }
      return out;
    }
    doc.layers = walk(doc.layers, base);
    return { key: key, prints: prints, kept: kept, skipped: skipped, pruned: !!prune };
  }

  function loadSentMap() {
    var st = prefsStore();
    if (!st) return {};
    try {
      var m = JSON.parse(st.getItem(SENT_KEY) || "{}");
      return (m && typeof m === "object") ? m : {};
    } catch (e) {
      return {};
    }
  }

  /**
   * Every leaf of a send is fingerprinted, the unchanged ones too, so the
   * document's entry is replaced outright: leaves no longer sent drop out. If
   * the prints cannot be stored, the old ones are dropped with them — stale
   * prints would leave a real change unsent, a missing one only sends again.
   */
  function rememberSent(key, prints) {
    var st = prefsStore();
    if (!st || !prints) return;
    var all = loadSentMap();
    delete all[key];
    all[key] = prints; // newest last
    var keys = [];
    for (var k in all) if (Object.prototype.hasOwnProperty.call(all, k)) keys.push(k);
    while (keys.length > SENT_DOCS_MAX) delete all[keys.shift()];
    try {
      st.setItem(SENT_KEY, JSON.stringify(all));
    } catch (e) {
      try { st.removeItem(SENT_KEY); } catch (e2) {}
    }
  }

  // --- Requests between panels ---------------------------------------------
  // One question today: the After Effects panel asks Photoshop which document
  // is open, to import it.

  var pendingReplies = {};
  var REPLY_TIMEOUT_MS = 10000;

  function answerRequest(msg) {
    function reply(ok, message, data) {
      send({ type: "reply", id: msg.id, from: role, ok: ok, message: message || "", data: data || {} });
    }
    if (msg.what !== "active-document" || role !== "photoshop") {
      reply(false, "The " + roleLabel(role) + " panel cannot answer that.");
      return;
    }
    if (!jsxReady) { reply(false, "The Photoshop panel's scripts are not loaded yet."); return; }
    cs.evalScript("LazyLord.activeDocumentInfo()", function (res) {
      var r;
      try { r = JSON.parse(res); } catch (e) { r = { ok: false, message: "Photoshop did not answer: " + res }; }
      reply(!!r.ok, r.message, r.data);
    });
  }

  /** Ask another app; `done(reply)` runs once, with ok false on a timeout. */
  function request(target, what, done) {
    var id = newId();
    var finished = false;
    pendingReplies[id] = function (r) {
      if (finished) return;
      finished = true;
      delete pendingReplies[id];
      done(r);
    };
    send({ type: "request", id: id, target: target, what: what });
    setTimeout(function () {
      if (pendingReplies[id]) pendingReplies[id]({ ok: false, message: roleLabel(target) + " did not answer." });
    }, REPLY_TIMEOUT_MS);
  }

  function onReply(msg) {
    var cb = pendingReplies[msg.id];
    if (cb) cb(msg);
  }

  /** After Effects: import the document open in Photoshop, or a chosen file. */
  function importPsd() {
    if (!jsxReady) { log("The host scripts are not loaded yet.", "err"); return; }
    function run(path) {
      cs.evalScript("LazyLord.importPsd(" + jsonStr(path) + ")", function (res) {
        var r;
        try { r = JSON.parse(res); } catch (e) { r = { ok: false, message: "Import failed: " + res }; }
        log(r.message || (r.ok ? "Imported." : "Import failed."), r.ok ? "ok" : "err");
      });
    }
    if (!contains(peers, "photoshop")) {
      log("Photoshop is not connected, so choose the file to import.");
      run("");
      return;
    }
    log("Asking Photoshop which document is open…");
    request("photoshop", "active-document", function (r) {
      var d = r.data || {};
      if (!r.ok) { log(r.message || "Photoshop could not say which document is open.", "err"); return; }
      if (!d.path) {
        log("\"" + (d.name || "The document") + "\" has never been saved. Save it in Photoshop, then import again.", "warn");
        return;
      }
      if (!d.saved) log("\"" + d.name + "\" has unsaved changes; its last saved version is imported.", "warn");
      run(d.path);
    });
  }

  // --- Where received images are kept (After Effects) ------------------------
  // After Effects links the images a transfer brings in, so they have to live
  // somewhere lasting: beside the saved project by default, or in a folder
  // the user picks here. Illustrator and Photoshop embed them.

  var imageFolderRow = document.getElementById("image-folder-row");
  var imageFolderEl = document.getElementById("image-folder");
  var imageFolderReset = document.getElementById("image-folder-reset");

  function chosenImageFolder() {
    return typeof prefs.imageFolder === "string" && prefs.imageFolder ? prefs.imageFolder : "";
  }

  function renderImageFolder() {
    if (!imageFolderRow || role !== "aftereffects") return;
    imageFolderRow.hidden = false;
    var dir = chosenImageFolder();
    if (imageFolderEl) {
      imageFolderEl.textContent = dir ? "Images: " + dir : "Images: beside the project";
      imageFolderEl.title = dir;
    }
    if (imageFolderReset) imageFolderReset.hidden = !dir;
  }

  function chooseImageFolder() {
    if (!jsxReady) { log("The host scripts are not loaded yet.", "err"); return; }
    cs.evalScript("LazyLord.chooseFolder(" + jsonStr("Where should LazyLord keep the images it brings in?") + "," +
      jsonStr(chosenImageFolder()) + ")", function (res) {
      var r;
      try { r = JSON.parse(res); } catch (e) { r = null; }
      if (!r || typeof r.path !== "string") { log("The folder could not be chosen: " + res, "err"); return; }
      if (!r.path) return; // cancelled
      savePref("imageFolder", r.path);
      renderImageFolder();
      log("Images from now on go in " + r.path + ".", "ok");
    });
  }

  function resetImageFolder() {
    savePref("imageFolder", "");
    renderImageFolder();
    log("Images from now on go beside the project.", "ok");
  }

  var imageFolderChoose = document.getElementById("image-folder-choose");
  if (imageFolderChoose) imageFolderChoose.addEventListener("click", chooseImageFolder);
  if (imageFolderReset) imageFolderReset.addEventListener("click", resetImageFolder);

  // --- Push targets -------------------------------------------------------

  /* --- Chip rows -----------------------------------------------------------
   * The target and the image scale are chips rather than dropdowns, the way
   * the Figma plugin shows them: both are short lists worth seeing at a glance,
   * and the row reflows to whatever width the panel is dragged to.
   */

  /** The chip in `container` whose data-<key> is `value`, or null. */
  function chipFor(container, key, value) {
    var kids = container ? container.children : null;
    for (var i = 0; kids && i < kids.length; i++) {
      if (String(kids[i].getAttribute("data-" + key)) === String(value)) return kids[i];
    }
    return null;
  }

  /** Mark exactly one chip active; returns the value that ended up active. */
  function selectChip(container, key, value) {
    var kids = container ? container.children : null;
    var chosen = "";
    for (var i = 0; kids && i < kids.length; i++) {
      var on = String(kids[i].getAttribute("data-" + key)) === String(value);
      kids[i].className = on ? "a-" + key + " is-active" : "a-" + key;
      if (on) chosen = String(value);
    }
    return chosen;
  }

  /** The active chip's value, or "" when none is. */
  function activeChip(container, key) {
    var kids = container ? container.children : null;
    for (var i = 0; kids && i < kids.length; i++) {
      if (/is-active/.test(kids[i].className || "")) return String(kids[i].getAttribute("data-" + key));
    }
    return "";
  }

  function renderTargets() {
    if (!canPush) return;
    var previous = activeChip(targetsEl, "target");
    var available = [];
    for (var i = 0; i < peers.length; i++) {
      var p = peers[i];
      if (p === role || p === "unknown") continue;
      if (!contains(available, p)) available.push(p);
    }

    clearChildren(targetsEl);
    if (available.length === 0) {
      var none = document.createElement("button");
      none.className = "a-target";
      none.setAttribute("data-target", "");
      none.disabled = true;
      none.appendChild(document.createTextNode("No app connected"));
      targetsEl.appendChild(none);
    } else {
      for (var j = 0; j < available.length; j++) {
        var chip = document.createElement("button");
        chip.className = "a-target";
        chip.setAttribute("data-target", available[j]);
        chip.appendChild(document.createTextNode(roleLabel(available[j])));
        targetsEl.appendChild(chip);
      }
      // The user's remembered choice wins whenever that app is connected; the
      // one showing only stands in for it while it is not.
      var saved = prefs.target;
      var preferred = PREFERRED_TARGET[role];
      var pick = "";
      if (saved && contains(available, saved)) pick = saved;
      else if (previous && contains(available, previous)) pick = previous;
      else if (preferred && contains(available, preferred)) pick = preferred;
      else pick = available[0];
      selectChip(targetsEl, "target", pick);
    }

    targetsAvailable = available.length > 0;
    updatePushButton();
  }

  /** The target the next transfer goes to. */
  function currentTarget() {
    return activeChip(targetsEl, "target");
  }

  /** The image scale the next transfer is read at. */
  function currentScale() {
    var v = Number(activeChip(scalesEl, "scale"));
    return contains(SCALES, String(v)) ? v : 2;
  }

  /**
   * The button says where the transfer is going. "Push" and "Pull" describe a
   * direction through someone's workflow, not what the button does, and stop
   * meaning anything once every app can send to every other one.
   */
  function updatePushButton() {
    if (!canPush) return;
    // Not loaded yet is no reason to disable it: pressing it loads the scripts again.
    pushBtn.disabled = pushBusy || !targetsAvailable || jsxLoading;
    var where = currentTarget() ? roleLabel(currentTarget()) : "";
    if (pushBusy) pushBtn.textContent = "Sending…";
    else pushBtn.textContent = where ? "Send to " + where : "Send";
  }

  function setPushBusy(b) {
    pushBusy = b;
    updatePushButton();
  }

  // --- Filesystem ---------------------------------------------------------

  // --- Temporary files ----------------------------------------------------
  // Every transfer writes its IR and images into <temp>/lazylord/<id>. Once it
  // is built nothing needs them — After Effects copies generated images next
  // to a saved project, Illustrator embeds them, Photoshop places them as smart
  // objects — except footage in an After Effects project that was never saved,
  // which still links there. So only folders older than a week are removed, at
  // start-up, and the panel says how many.

  var TEMP_KEEP_DAYS = 7;

  function tempBase() {
    var sep = nodePath ? nodePath.sep : "/";
    return (os ? os.tmpdir() : cs.getSystemPath(SystemPath.USER_DATA)) + sep + "lazylord";
  }

  /** Delete a file or folder tree; links are removed, never followed. */
  function removeTree(p) {
    var st = fs.lstatSync(p);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      var kids = fs.readdirSync(p);
      for (var i = 0; i < kids.length; i++) removeTree(nodePath.join(p, kids[i]));
      fs.rmdirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  }

  function cleanTempFiles(now) {
    if (!fs || !nodePath) return 0;
    var base = tempBase();
    var names;
    try { names = fs.readdirSync(base); } catch (e) { return 0; } // nothing written yet
    var cutoff = (now || new Date().getTime()) - TEMP_KEEP_DAYS * 24 * 3600 * 1000;
    var removed = 0;
    for (var i = 0; i < names.length; i++) {
      var dir = nodePath.join(base, names[i]);
      try {
        var st = fs.statSync(dir);
        if (!st.isDirectory() || st.mtime.getTime() >= cutoff) continue;
        removeTree(dir);
        removed++;
      } catch (e) {} // in use by another panel, or already gone: next start-up tries again
    }
    if (removed) {
      log("Removed " + plural(removed, "transfer folder") + " older than " + TEMP_KEEP_DAYS +
        " days from the temp folder.");
    }
    return removed;
  }

  function tempDir(id) {
    var sep = nodePath ? nodePath.sep : "/";
    var base = tempBase();
    // A transfer id comes off the network: never let it name a path of its own.
    var dir = base + sep + (safeName(id).slice(0, 64) || newId());
    if (fs) {
      try { fs.mkdirSync(base, { recursive: true }); } catch (e) {}
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    } else if (window.cep && window.cep.fs) {
      window.cep.fs.makedir(base);
      window.cep.fs.makedir(dir);
    }
    return dir;
  }

  function joinPath(dir, name) {
    return dir + (nodePath ? nodePath.sep : "/") + name;
  }

  function writeText(path, str) {
    if (fs) { fs.writeFileSync(path, str, "utf8"); return; }
    if (window.cep && window.cep.fs) { window.cep.fs.writeFile(path, str); return; }
    throw new Error("No filesystem API available.");
  }

  function readText(path) {
    if (fs) return fs.readFileSync(path, "utf8");
    if (window.cep && window.cep.fs) {
      var r = window.cep.fs.readFile(path);
      if (r && r.err === 0) return r.data;
      throw new Error("Could not read " + path);
    }
    throw new Error("No filesystem API available.");
  }

  function readBase64(path) {
    if (fs) return fs.readFileSync(path).toString("base64");
    if (window.cep && window.cep.fs && window.cep.encoding) {
      var r = window.cep.fs.readFile(path, window.cep.encoding.Base64);
      if (r && r.err === 0) return r.data;
    }
    throw new Error("no filesystem API available");
  }

  function writePngFromBase64(path, b64) {
    if (fs) { fs.writeFileSync(path, Buffer.from(b64, "base64")); return; }
    if (window.cep && window.cep.fs && window.cep.encoding) {
      window.cep.fs.writeFile(path, b64, window.cep.encoding.Base64);
      return;
    }
    throw new Error("No binary filesystem API available.");
  }

  function safeName(s) {
    return String(s).replace(/[^A-Za-z0-9_-]+/g, "_");
  }

  /**
   * A PNG file name no other image in this transfer uses. Different ids can
   * sanitise to the same name ("1:2" and "1;2"), and names that differ only in
   * case are one file on Windows and on default macOS volumes; without this,
   * a later image would silently overwrite an earlier one. Keys are prefixed so
   * an id such as "__proto__" is an ordinary entry, not the object's prototype.
   */
  function uniqueImageName(id, used) {
    var base = safeName(id || "image");
    var name = base;
    for (var n = 2; Object.prototype.hasOwnProperty.call(used, "png:" + name.toLowerCase()); n++) name = base + "-" + n;
    used["png:" + name.toLowerCase()] = true;
    return name + ".png";
  }

  // --- Live sync ------------------------------------------------------------
  // While Live is on, the panel asks the host for a cheap stamp of the
  // selection (LazyLord.liveStamp) every LIVE_POLL_MS, and sends again when it
  // changes. Live sends always update what the first one built, and only what
  // changed goes (smart diff). A stamp that moves because of the read itself
  // costs one extra read whose diff is empty, then settles; an edit made while
  // a send is under way is caught by the next poll, never lost.

  var LIVE_POLL_MS = 1500;
  var LIVE_STAMP_TIMEOUT_MS = 10000;
  var liveOn = false;
  var liveGen = 0;
  var liveStamp = null;
  var livePolling = false;
  var liveStarted = false; // its first, full send has gone
  var liveRetry = false;   // the last live send failed: send again once

  /** Only these rebuild what they built before; anywhere else Live would pile up copies. */
  function liveCanReach(target) {
    return target === "aftereffects" || target === "illustrator" || target === "photoshop";
  }

  /**
   * Figma places what it receives only when someone presses Place in the
   * plugin, one transfer at a time, so a stream of Live updates has nowhere
   * to go there.
   */
  var LIVE_FIGMA = "Figma asks you to place every transfer yourself, so Live cannot send to it; " +
    "use Send, then Place in the LazyLord plugin in Figma";

  function startLive() {
    var target = currentTarget();
    if (!target) {
      stopLive("no destination app is connected");
      return;
    }
    if (target === "figma") {
      stopLive(LIVE_FIGMA);
      return;
    }
    if (!liveCanReach(target)) {
      stopLive(roleLabel(target) + " can only add layers, not update them, so every change would add another copy; " +
        "choose After Effects or Illustrator");
      return;
    }
    liveOn = true;
    liveGen++;
    liveStamp = null;
    livePolling = false;
    liveStarted = false;
    liveRetry = false;
    log("Live: changes to the selection are sent to " + roleLabel(target) + " as you work.", "ok");
    livePoll(liveGen);
  }

  /** A live send failed (read, delivery or build): try it once more at the next poll. */
  function liveFailed() {
    if (liveOn) liveRetry = true;
  }

  function stopLive(why) {
    var was = liveOn;
    liveOn = false;
    liveGen++;
    if (liveEl) liveEl.checked = false;
    if (why) log("Live stopped: " + why + ".", "warn");
    else if (was) log("Live is off.");
  }

  function livePoll(gen) {
    if (!liveOn || gen !== liveGen) return;
    setTimeout(function () { livePoll(gen); }, LIVE_POLL_MS);
    var target = currentTarget();
    if (!target) { stopLive("the destination app disconnected"); return; }
    if (target === "figma") { stopLive(LIVE_FIGMA); return; }
    if (!liveCanReach(target)) { stopLive(roleLabel(target) + " can only add layers, not update them"); return; }
    if (pushBusy || livePolling || !jsxReady) return;
    livePolling = true;
    var answered = false;
    // A host showing a modal dialog may not answer for a while: poll again later.
    setTimeout(function () { if (!answered && gen === liveGen) livePolling = false; }, LIVE_STAMP_TIMEOUT_MS);
    cs.evalScript("LazyLord.liveStamp()", function (res) {
      answered = true;
      livePolling = false;
      if (!liveOn || gen !== liveGen) return;
      // A Send pressed while the host was answering has the floor: poll again after it.
      if (pushBusy) return;
      var retry = liveRetry && res === liveStamp;
      if (res === liveStamp && !retry) return;
      liveRetry = false;
      liveStamp = res;
      if (res === "") return; // nothing selected: wait for a selection
      doPush(liveStarted ? "live" : "live-start");
    });
  }

  // --- Push ---------------------------------------------------------------

  /**
   * Send the selection. `mode` is unset for the Send button; "live-start" is
   * Live's first send (everything, updating what is there), "live" a later
   * one (only what changed, and quietly when nothing did).
   */
  function doPush(mode) {
    // One send at a time: a second would take over the first one's ack.
    if (pushBusy) return;
    var live = mode === "live" || mode === "live-start";
    var target = currentTarget();
    if (!target) { log("No destination app is connected.", "err"); return; }
    if (!jsxReady) {
      loadJsx(function (ok) {
        if (ok) doPush(mode);
        else log("Could not load the host scripts (" + jsxError + ").", "err");
      });
      return;
    }

    // Taken now: the options showing when the button was pressed are the ones
    // sent, even if a select is changed while the host is still reading.
    var options = pushOptions();
    var place = destinationSel ? destinationSel.value : "active";
    // Live keeps one copy in step: it updates what its first send built.
    if (live) {
      options.existing = "update";
      options.live = true; // so the receiver keeps it out of its history too
      place = "active";
    }
    var prune = live ? mode === "live" : (options.existing === "update" && onlyChangedWanted());
    // Guides and swatches cost a walk of the whole document, so the reader skips what was not asked for.
    var reading = { scale: currentScale(), guides: options.guides, swatches: options.swatches, target: target };
    // Frames are a one-off export: Live keeps layers in step, not sequences.
    if (sequenceWanted() && !live) reading.sequence = true;
    var id = newId();
    var dir;
    try {
      dir = tempDir(id);
    } catch (e) {
      log("Could not create a working folder: " + e.message, "err");
      return;
    }

    setPushBusy(true);
    setDiagnostics([], id);
    if (!live) log("Reading the " + roleLabel(role) + " selection…");

    cs.evalScript("LazyLord.runRead(" + jsonStr(dir) + ", " + JSON.stringify(reading) + ")", function (res) {
      var r;
      try { r = JSON.parse(res); } catch (e) { r = { ok: false, message: "Host error: " + res }; }

      if (r.diagnostics && r.diagnostics.length) setDiagnostics(r.diagnostics, id);

      if (!r.ok) {
        log(r.message || "Could not read the selection.", "err");
        setPushBusy(false);
        if (live) liveFailed();
        return;
      }

      var doc;
      try {
        doc = JSON.parse(readText(r.irPath));
        if (!doc || typeof doc !== "object" || !doc.layers) throw new Error("it carried no layers.");
      } catch (e2) {
        log("Could not read the exported data: " + e2.message, "err");
        setPushBusy(false);
        if (live) liveFailed();
        return;
      }

      // The document goes out as the reader wrote it — canvas, clip, primitive
      // and groups included — plus the options chosen in this panel, which the
      // target's builder obeys.
      doc.options = options;
      applyDestination(doc, place);

      // Updating: only what changed since the last send to this app goes out.
      var diff = fingerprintLeaves(doc, target, prune);
      if (diff.pruned && diff.kept === 0) {
        if (!live) log("Nothing changed since the last send to " + roleLabel(target) + ", so nothing was sent.", "ok");
        setPushBusy(false);
        return;
      }
      if (diff.skipped && !live) log(plural(diff.skipped, "unchanged layer") + " not sent again.");
      if (target === "figma") embedImagesForFigma(doc);

      pendingPush = id;
      pendingPushInfo = {
        name: doc.name || "",
        images: imageStats(doc),
        diagnostics: doc.diagnostics || r.diagnostics || [],
        sentKey: diff.key,
        prints: diff.prints,
        live: live
      };
      var parts = sendTransfer({ type: "transfer", id: id, target: target, document: doc });
      if (!parts) {
        pendingPush = null;
        pendingPushInfo = null;
        log("Not connected to the other apps, so nothing was sent. The panel reconnects by itself; send again in a moment.", "err");
        setPushBusy(false);
        if (live) liveFailed();
        return;
      }
      if (mode === "live-start") liveStarted = true;
      if (parts > 1) log("Large transfer: sent in " + parts + " pieces.");
      // Counted here, not taken from the reader's layerCount, which only sees
      // the top level: layers inside groups count too.
      var note = optionsNote(options);
      log((live ? "Live: sent " : "Sent ") + layerPhrase(doc.layers) + " to " + roleLabel(target) +
        (note && !live ? " · " + note : "") + "…");
      // Figma places nothing until someone says so there.
      if (target === "figma") log("Waiting for Place to be pressed in the LazyLord plugin in Figma.");

      setTimeout(function () {
        if (pendingPush !== id) return;
        // Free the button, but remember what was sent: a large rebuild can
        // outlast the wait, and its result still deserves a summary.
        pruneLateAcks();
        lateAcks[id] = { info: pendingPushInfo, at: new Date().getTime() };
        pendingPush = null;
        pendingPushInfo = null;
        if (target === "figma") {
          log("Figma has not placed it yet: press Place in the LazyLord plugin there. The result will still be shown here.", "warn");
        } else {
          log("No response from " + roleLabel(target) + " after " + (PUSH_TIMEOUT_MS / 1000) +
            " s. Its result will still be shown here if it arrives.", "warn");
        }
        setPushBusy(false);
        if (live) liveFailed();
      }, PUSH_TIMEOUT_MS);
    });
  }

  function onAck(msg) {
    if (pendingPush && msg.id === pendingPush) {
      var info = pendingPushInfo;
      pendingPush = null;
      pendingPushInfo = null;
      setPushBusy(false);
      reportAck(msg, info, false);
      return;
    }
    var late = takeLateAck(msg.id);
    if (late) reportAck(msg, late.info, true);
    // Anything else is another panel's transfer; the bridge can relay those.
  }

  function reportAck(msg, info, late) {
    if (!info) info = { images: imageStats(null), diagnostics: [] };
    var hostDiags = msg.diagnostics || [];
    // What the target now holds, for the next update's comparison.
    if (msg.ok && info.sentKey) rememberSent(info.sentKey, info.prints);
    if (!msg.ok && info.live && !late) liveFailed();

    // A late reply leaves the card to a push that is still waiting for its
    // own answer; the summary line below still counts every fallback.
    if (!late || !pendingPush) showTransferDiagnostics(msg.id, info.diagnostics, hostDiags);

    if (msg.ok) {
      // Fallbacks cover the whole transfer — our reader's and the target's
      // rebuild (from the ack) — so the line agrees with the card.
      var all = info.diagnostics.concat(hostDiags);
      log("Rebuilt in " + roleLabel(msg.from) + (late ? " (late reply)" : "") + ": " +
        transferSummary(msg.layersCreated, info.images, all, msg.layersUpdated), all.length ? "warn" : "ok");
    } else {
      log((late ? "Late reply from " + roleLabel(msg.from) + ": " : "") +
        (msg.message || "The transfer failed."), "err");
    }
    // Live sends would push every real send out of the history; they stay in the log.
    if (info.live) return;
    recordHistory({
      dir: "out", peer: roleLabel(msg.from), name: info.name || "", ok: !!msg.ok,
      layers: msg.layersCreated || 0, updated: msg.layersUpdated || 0,
      fallbacks: info.diagnostics.length + hostDiags.length, message: msg.ok ? "" : (msg.message || "")
    });
  }

  /** Hand back (once) what a timed-out push sent, or null. */
  function takeLateAck(id) {
    pruneLateAcks();
    if (!id || !Object.prototype.hasOwnProperty.call(lateAcks, id)) return null;
    var entry = lateAcks[id];
    delete lateAcks[id];
    return entry;
  }

  function pruneLateAcks() {
    var cutoff = new Date().getTime() - LATE_ACK_TTL_MS;
    for (var k in lateAcks) {
      if (Object.prototype.hasOwnProperty.call(lateAcks, k) && lateAcks[k].at < cutoff) delete lateAcks[k];
    }
  }

  // --- Receive ------------------------------------------------------------

  /**
   * Auto-receive is off, and the setting is remembered across restarts, so
   * the sender is told why nothing arrived rather than left to time out. A
   * broadcast is answered too: the panel cannot see whether any other app will
   * take it, and a refusal arrives before any real rebuild's result.
   */
  function declineTransfer(msg) {
    var from = roleLabel(msg.document && msg.document.source);
    log("Declined a transfer from " + from + " (auto-receive off); the sender has been told.");
    ack(msg.id, false, "Auto-receive is off in the " + roleLabel(role) + " LazyLord panel, so nothing was " +
      "built there. Tick Auto-receive in that panel and send again.");
  }

  function handleTransfer(msg) {
    var doc = msg.document;
    // The sender's options are only read for the log; the builder applies them.
    var note = (doc && doc.options) ? optionsNote(normaliseOptions(doc.options)) : "";
    log("Receiving " + layerPhrase(doc && doc.layers) + " from " + roleLabel(doc && doc.source) +
      (note ? " · " + note : "") + "…");

    if (!jsxReady) {
      // A load that failed or timed out at start-up gets one more try, so a
      // host that was merely busy then does not refuse the transfer.
      log("The host scripts are not loaded yet; loading them again…");
      loadJsx(function (ok) {
        if (ok) { handleTransfer(msg); return; }
        ack(msg.id, false, "The " + roleLabel(role) + " LazyLord panel could not load its scripts (" + jsxError +
          "). Close and reopen the panel; if this persists, send this message to the developer.");
      });
      return;
    }

    if (!doc || !isArray(doc.layers)) {
      log("The transfer carried no layers.", "err");
      ack(msg.id, false, "The transfer carried no layers.");
      return;
    }

    var sourceDiags = isArray(doc.diagnostics) ? doc.diagnostics : [];
    // Receive-side fallbacks belong to this rebuild: they are shown with the
    // sender's, and travel back in the ack with the builder's own.
    var recvDiags = [];
    doc.layers = dropMalformed(doc.layers, null, recvDiags);
    var shownDiags = sourceDiags.concat(recvDiags);
    setDiagnostics(shownDiags, msg.id);

    try {
      var dir = tempDir(msg.id);

      // Materialise embedded bytes to real files, however deeply grouped.
      // Layers that already carry a filePath (another app on this machine
      // produced them) pass straight through — including the user's own linked
      // assets. Only image layers are touched: canvas, clip, primitive, groups
      // and options reach the builder untouched (bar the malformed entries
      // dropped above, which no builder could walk).
      var usedNames = {};
      // The same picture sent twice is written once: copies of one component
      // then name the same file, and After Effects can share their precomp.
      var written = {};
      eachLayer(doc.layers, function (layer) {
        if (layer.type === "image" && layer.pngBase64 && !layer.filePath) {
          var pngPath = written["#" + layer.pngBase64];
          if (!pngPath) {
            pngPath = joinPath(dir, uniqueImageName(layer.id, usedNames));
            writePngFromBase64(pngPath, layer.pngBase64);
            written["#" + layer.pngBase64] = pngPath;
          }
          layer.filePath = pngPath;
          layer.isOriginalFile = false;
          delete layer.pngBase64;
        }
      });
      var images = imageStats(doc);
      // Where this app keeps them is this panel's choice, not the sender's.
      if (doc.options && typeof doc.options === "object") delete doc.options.imageFolder;
      if (role === "aftereffects" && chosenImageFolder()) {
        if (!doc.options || typeof doc.options !== "object") doc.options = {};
        doc.options.imageFolder = chosenImageFolder();
      }

      var irPath = joinPath(dir, "ir.json");
      writeText(irPath, JSON.stringify(doc));

      cs.evalScript("LazyLord.run(" + jsonStr(irPath) + ")", function (res) {
        var result;
        try { result = JSON.parse(res); } catch (e) { result = { ok: false, message: "Host error: " + res }; }
        var buildDiags = result.diagnostics || [];
        showTransferDiagnostics(msg.id, shownDiags, buildDiags);
        if (result.ok) {
          // Source-side, receive and rebuild fallbacks together, matching the card.
          var all = shownDiags.concat(buildDiags);
          log("Received from " + roleLabel(doc.source) + ": " +
            transferSummary(result.layersCreated, images, all, result.layersUpdated), all.length ? "warn" : "ok");
        } else {
          log("Build failed: " + (result.message || "unknown error"), "err");
        }
        // A live update is one of many: it stays in the log, as on the sending side.
        if (!(doc.options && doc.options.live)) {
          recordHistory({
            dir: "in", peer: roleLabel(doc.source), name: doc.name || "", ok: !!result.ok,
            layers: result.layersCreated || 0, updated: result.layersUpdated || 0,
            fallbacks: shownDiags.length + buildDiags.length, message: result.ok ? "" : (result.message || "unknown error")
          });
        }
        ack(msg.id, !!result.ok, result.message, result.layersCreated, recvDiags.concat(buildDiags), result.layersUpdated);
      });
    } catch (e) {
      log("Transfer error: " + e.message, "err");
      recordHistory({ dir: "in", peer: roleLabel(doc && doc.source), name: (doc && doc.name) || "", ok: false, message: e.message });
      ack(msg.id, false, e.message, 0, recvDiags, 0);
    }
  }

  /**
   * The layer list without entries a builder cannot walk. The IR types
   * doc.layers and every group's children as Layer[], and the host helpers
   * (LazyLord.eachLayer, flattenLayers, applyOrigin) read .type on every
   * entry, so one null — or a number, text or a list — anywhere in the tree
   * would fail the whole rebuild with a cryptic host error. Each is left out
   * instead, with a "skipped" diagnostic saying where it sat. A group whose
   * children are not a list keeps its place but arrives empty. Returns a new
   * list; groups are repaired in place (the document is this panel's own parse).
   */
  function dropMalformed(layers, parent, diags) {
    var out = [];
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (!isLayerEntry(layer)) {
        diags.push({
          object: "(unnamed)",
          reason: (parent ? "Entry " + (i + 1) + " of " + groupPhrase(parent) : "Top-level entry " + (i + 1)) +
            " was " + entryKind(layer) + ", not a layer, so it was left out",
          resolution: "skipped"
        });
        continue;
      }
      if (layer.type === "group" && layer.children !== undefined && layer.children !== null) {
        if (isArray(layer.children)) {
          layer.children = dropMalformed(layer.children, layer, diags);
        } else {
          diags.push({
            object: layer.name || layer.id || "(unnamed)",
            reason: "The group's contents were " + entryKind(layer.children) + ", not a list of layers, " +
              "so it arrives empty",
            resolution: "skipped"
          });
          layer.children = [];
        }
      }
      out.push(layer);
    }
    return out;
  }

  /** 'the group "Frame"', or "an unnamed group". */
  function groupPhrase(group) {
    var name = group.name || group.id;
    return name ? 'the group "' + name + '"' : "an unnamed group";
  }

  /** What a malformed entry was, in plain words. */
  function entryKind(x) {
    if (x === null || x === undefined) return "empty";
    if (isArray(x)) return "a list";
    if (typeof x === "string") return "text";
    if (typeof x === "number") return "a number";
    if (typeof x === "boolean") return "a true/false value";
    return typeof x === "object" ? "an object" : "a " + typeof x;
  }

  function ack(id, ok, message, layersCreated, diagnostics, layersUpdated) {
    send({
      type: "ack",
      id: id,
      from: role,
      ok: ok,
      message: message,
      layersCreated: layersCreated || 0,
      layersUpdated: layersUpdated || 0,
      diagnostics: diagnostics || []
    });
  }

  // --- Transfer summary ---------------------------------------------------

  function isArray(x) {
    return Object.prototype.toString.call(x) === "[object Array]";
  }

  /** Something a layer list may hold: an object. JSON can also carry null, numbers, text and lists. */
  function isLayerEntry(x) {
    return x !== null && typeof x === "object" && !isArray(x);
  }

  /**
   * Visit every layer, group children included. Malformed entries are passed
   * over, so counts taken before dropMalformed agree with what is built.
   */
  function eachLayer(layers, fn) {
    if (!isArray(layers)) return;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (!isLayerEntry(layer)) continue;
      fn(layer);
      if (layer.type === "group") eachLayer(layer.children, fn);
    }
  }

  /** Leaf layers and groups in a layer tree, group children included. */
  function countLayers(layers) {
    var c = { leaves: 0, groups: 0 };
    eachLayer(layers, function (layer) {
      if (layer.type === "group") c.groups++;
      else c.leaves++;
    });
    return c;
  }

  /** "4 layers", or "4 layers (1 group)": leaves however deeply grouped, plus the groups. */
  function layerPhrase(layers) {
    var c = countLayers(layers);
    return plural(c.leaves, "layer") + (c.groups ? " (" + plural(c.groups, "group") + ")" : "");
  }

  /**
   * Image layers, group children included, split into the user's own files
   * (never re-encoded) and ones LazyLord generated: Figma bytes, rasterised
   * fallbacks, embedded rasters.
   */
  function imageStats(doc) {
    var s = { total: 0, original: 0, generated: 0 };
    eachLayer(doc && doc.layers, function (layer) {
      if (layer.type !== "image") return;
      s.total++;
      if (layer.isOriginalFile === true && layer.filePath) s.original++;
      else s.generated++;
    });
    return s;
  }

  /** A missing resolution is an approximation (LazyLord.warn's default). */
  function resolutionOf(d) {
    return (d && d.resolution) || "approximated";
  }

  function resolutionRank(d) {
    var r = resolutionOf(d);
    for (var i = 0; i < RESOLUTIONS.length; i++) if (RESOLUTIONS[i] === r) return i;
    return RESOLUTIONS.length; // anything unrecognised goes last
  }

  function countResolutions(list) {
    var c = { total: 0, other: 0 };
    for (var i = 0; i < RESOLUTIONS.length; i++) c[RESOLUTIONS[i]] = 0;
    for (var j = 0; list && j < list.length; j++) {
      var rank = resolutionRank(list[j]);
      if (rank < RESOLUTIONS.length) c[RESOLUTIONS[rank]]++;
      else c.other++;
      c.total++;
    }
    return c;
  }

  /**
   * One compact line per transfer, e.g.
   * "12 layers created · 3 images (1 original, 2 generated) ·
   *  fallbacks: 2 approximated / 0 rasterized / 1 skipped".
   */
  function transferSummary(layersCreated, images, diagnostics, layersUpdated) {
    var imgs = images.total === 0
      ? "no images"
      : plural(images.total, "image") + " (" + images.original + " original, " + images.generated + " generated)";
    var c = countResolutions(diagnostics);
    var falls = "no fallbacks";
    if (c.total) {
      falls = "fallbacks: " + c.approximated + " approximated / " + c.rasterized + " rasterized / " +
        c.skipped + " skipped" + (c.other ? " / " + c.other + " other" : "");
    }
    // Updating reports both halves: what it edited and what it had to add.
    var built = plural(layersCreated || 0, "layer") + " created";
    if (layersUpdated) built = plural(layersUpdated, "layer") + " updated · " + built;
    return built + " · " + imgs + " · " + falls;
  }

  // --- Diagnostics --------------------------------------------------------

  /** Replace the card with one transfer's diagnostics. */
  function setDiagnostics(list, id) {
    diagItems = (list || []).slice();
    diagFor = id || null;
    renderDiagnostics();
  }

  function addDiagnostics(list) {
    for (var i = 0; i < list.length; i++) diagItems.push(list[i]);
    renderDiagnostics();
  }

  /**
   * The card describes one transfer at a time. The rebuild's diagnostics join
   * it while it still shows that transfer; if another transfer was reported in
   * between (a receive, a late reply), the card is redrawn with this transfer's
   * full list, so the card and the summary line always agree.
   */
  function showTransferDiagnostics(id, base, extra) {
    extra = extra || [];
    if (diagFor === id) {
      if (extra.length) addDiagnostics(extra);
    } else {
      setDiagnostics((base || []).concat(extra), id);
    }
  }

  /**
   * Worst first: skipped, then rasterized, then approximated. Arrival order is
   * kept within a rung (explicit tiebreak — sort stability is not guaranteed).
   */
  function sortedDiagnostics(list) {
    var keyed = [];
    for (var i = 0; i < list.length; i++) keyed.push({ d: list[i], rank: resolutionRank(list[i]), at: i });
    keyed.sort(function (a, b) { return (a.rank - b.rank) || (a.at - b.at); });
    var out = [];
    for (var j = 0; j < keyed.length; j++) out.push(keyed[j].d);
    return out;
  }

  function renderDiagnostics() {
    clearChildren(diagList);
    if (diagCounts) clearChildren(diagCounts);
    if (diagItems.length === 0) {
      diagCard.hidden = true;
      return;
    }
    diagCard.hidden = false;
    diagTitle.textContent =
      diagItems.length + (diagItems.length === 1 ? " item needed a fallback" : " items needed a fallback");

    // A small count per rung, worst first; empty rungs are left out.
    if (diagCounts) {
      var c = countResolutions(diagItems);
      for (var k = 0; k < RESOLUTIONS.length; k++) {
        var key = RESOLUTIONS[k];
        if (!c[key]) continue;
        var chip = document.createElement("span");
        chip.className = "cnt res-" + key;
        chip.textContent = c[key] + " " + key;
        diagCounts.appendChild(chip);
      }
      if (c.other) {
        var otherChip = document.createElement("span");
        otherChip.className = "cnt";
        otherChip.textContent = c.other + " other";
        diagCounts.appendChild(otherChip);
      }
    }

    var sorted = sortedDiagnostics(diagItems);
    for (var i = 0; i < sorted.length; i++) {
      var d = sorted[i];
      var res = resolutionOf(d);
      var li = document.createElement("li");
      var b = document.createElement("b");
      b.textContent = d.object;
      li.appendChild(b);
      li.appendChild(document.createTextNode(" — " + d.reason));
      var tag = document.createElement("span");
      tag.className = "res res-" + safeName(res);
      tag.textContent = res;
      li.appendChild(tag);
      diagList.appendChild(li);
    }
  }

  // --- Wire up ------------------------------------------------------------

  document.getElementById("reconnect").addEventListener("click", connect);
  autoEl.addEventListener("change", function () { savePref("autoReceive", !!autoEl.checked); });
  if (canPush) {
    pushBtn.addEventListener("click", function () { doPush(); });
    if (liveEl) liveEl.addEventListener("change", function () {
      if (liveEl.checked) startLive();
      else stopLive();
    });
    // One listener per row rather than per chip: the target chips are rebuilt
    // whenever the connected apps change.
    targetsEl.addEventListener("click", function (e) {
      var chip = e.target;
      while (chip && chip !== targetsEl && !chip.getAttribute) chip = chip.parentNode;
      if (!chip || chip === targetsEl || chip.disabled) return;
      var value = chip.getAttribute("data-target");
      if (!value) return;
      selectChip(targetsEl, "target", value);
      savePref("target", value);
      updatePushButton(); // the button names where it is going
    });
    if (layoutSel) layoutSel.addEventListener("change", function () {
      savePref("layout", pushOptions().layout);
      updateOptionsNote();
    });
    if (hierarchySel) hierarchySel.addEventListener("change", function () {
      savePref("hierarchy", pushOptions().hierarchy);
      updateOptionsNote();
    });
    if (existingSel) existingSel.addEventListener("change", function () {
      savePref("existing", pushOptions().existing);
      updateOptionsNote();
    });
    if (keyframesSel) keyframesSel.addEventListener("change", function () {
      savePref("keyframes", pushOptions().keyframes);
      updateOptionsNote();
    });
    if (conflictSel) conflictSel.addEventListener("change", function () {
      savePref("conflict", pushOptions().conflict);
      updateOptionsNote();
    });
    if (guidesEl) guidesEl.addEventListener("change", function () { savePref("guides", !!guidesEl.checked); updateOptionsNote(); });
    if (sequenceEl) sequenceEl.addEventListener("change", function () { savePref("sequence", !!sequenceEl.checked); updateOptionsNote(); });
    if (onlyChangedEl) onlyChangedEl.addEventListener("change", function () { savePref("onlyChanged", !!onlyChangedEl.checked); });
    if (swatchesEl) swatchesEl.addEventListener("change", function () { savePref("swatches", !!swatchesEl.checked); updateOptionsNote(); });
    if (destinationSel) destinationSel.addEventListener("change", function () {
      savePref("destination", destinationSel.value);
      updateDestNote();
      updateOptionsNote(); // the Update hint depends on the destination
    });
    if (scalesEl) scalesEl.addEventListener("click", function (e) {
      var chip = e.target;
      while (chip && chip !== scalesEl && !chip.getAttribute) chip = chip.parentNode;
      if (!chip || chip === scalesEl) return;
      var value = chip.getAttribute("data-scale");
      if (!value) return;
      selectChip(scalesEl, "scale", value);
      savePref("scale", Number(value));
      updateOptionsNote();
    });
  }

  // After Effects only: precompose / decompose the selection, in the host.
  var aeTools = document.getElementById("ae-tools");
  function runHelper(fn, label) {
    if (!jsxReady) { log("The host scripts are not loaded yet.", "err"); return; }
    cs.evalScript("LazyLord." + fn + "()", function (res) {
      var r;
      try { r = JSON.parse(res); } catch (e) { r = { ok: false, message: label + " failed: " + res }; }
      log(r.message || (label + (r.ok ? " done." : " failed.")), r.ok ? "ok" : "err");
    });
  }
  if (aeTools && role === "aftereffects") {
    aeTools.hidden = false;
    var pre = document.getElementById("ae-precompose");
    var dec = document.getElementById("ae-decompose");
    if (pre) pre.addEventListener("click", function () { runHelper("precomposeSelection", "Precompose"); });
    if (dec) dec.addEventListener("click", function () { runHelper("decomposeSelection", "Decompose"); });
    var imp = document.getElementById("ae-import-psd");
    if (imp) imp.addEventListener("click", importPsd);
  }

  if (presetSel) presetSel.addEventListener("change", function () { usePreset(presetSel.value); });
  if (presetSave) presetSave.addEventListener("click", savePreset);
  if (presetDelete) presetDelete.addEventListener("click", deletePreset);
  if (historyClear) historyClear.addEventListener("click", function () {
    saveList(HISTORY_KEY, []);
    renderHistory();
  });

  restorePrefs();
  renderPresets("");
  renderHistory();
  cleanTempFiles();
  loadJsx();
  connect();
  // Closing the panel (or quitting the app) frees the port for another panel.
  try { window.addEventListener("beforeunload", stopBridge); } catch (eU) {}

  // The dropdowns drawn like the rest of the panel (js/select.js).
  if (window.LazyLordSelect) window.LazyLordSelect.enhance(document);

  // Photoshop unloads a panel that is closed or tabbed behind another, which
  // would drop the bridge connection (and Live); ask it to keep this one loaded.
  if (role === "photoshop") {
    try {
      var keep = new CSEvent("com.adobe.PhotoshopPersistent", "APPLICATION");
      keep.extensionId = cs.getExtensionID();
      cs.dispatchEvent(keep);
    } catch (e) {}
  }
})();
