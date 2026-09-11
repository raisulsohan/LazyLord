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

  /** Hosts that ship a reader module and can therefore originate a transfer. */
  var READ_MODULE = { illustrator: "ai-read", aftereffects: "ae-read" };
  /** Where a transfer goes by default when several apps are listening. */
  var PREFERRED_TARGET = { illustrator: "aftereffects", aftereffects: "illustrator" };
  /** Overlord's vocabulary: you push artwork forward, and pull it back. */
  var SEND_VERB = { illustrator: "Push", aftereffects: "Pull" };
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
  var autoEl = document.getElementById("auto");
  var pushCard = document.getElementById("push-card");
  var pushSub = document.getElementById("push-sub");
  var pushBtn = document.getElementById("push");
  var targetSel = document.getElementById("push-target");
  var layoutSel = document.getElementById("push-layout");
  var hierarchySel = document.getElementById("push-hierarchy");
  var optsNote = document.getElementById("push-opts-note");
  var diagCard = document.getElementById("diag-card");
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
  var verb = SEND_VERB[role] || "Send";

  hostEl.firstChild.nodeValue = roleLabel(role);
  hostSub.textContent = appName + " " + (env.appVersion || "");

  function log(msg, kind) {
    var line = document.createElement("div");
    if (kind) line.className = kind;
    var t = new Date().toTimeString().slice(0, 8);
    line.textContent = "[" + t + "] " + msg;
    if (logEl.firstChild && logEl.firstChild.nodeType === 3) logEl.textContent = "";
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

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
    updateOptionsNote();
  }

  // --- Transfer options ---------------------------------------------------
  // The sender chooses how the target lays a push out, and the target's
  // builder obeys doc.options. The defaults (Split + Flatten) reproduce what
  // every builder produced before options existed, so notes and log lines
  // only ever mention a choice that differs from them.

  var LAYOUTS = ["split", "combine"];
  var HIERARCHIES = ["flatten", "groups"];

  /** Options with the defaults applied (mirrors core's transferOptions). */
  function normaliseOptions(o) {
    o = o || {};
    return {
      layout: o.layout === "combine" ? "combine" : "split",
      hierarchy: o.hierarchy === "groups" ? "groups" : "flatten"
    };
  }

  /** The non-default choices as the push card labels them, e.g. "Combine, Groups"; "" for the defaults. */
  function optionsNote(o) {
    var parts = [];
    if (o.layout === "combine") parts.push("Combine");
    if (o.hierarchy === "groups") parts.push("Groups");
    return parts.join(", ");
  }

  /** What the push card's selects say right now. */
  function pushOptions() {
    return normaliseOptions({
      layout: layoutSel ? layoutSel.value : "",
      hierarchy: hierarchySel ? hierarchySel.value : ""
    });
  }

  /** The Options disclosure stays closed, so its label shows what differs from the defaults. */
  function updateOptionsNote() {
    if (optsNote) optsNote.textContent = optionsNote(pushOptions());
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
      flushJsxWaiters(false);
    }, JSX_LOAD_TIMEOUT_MS);

    cs.evalScript(script, function (res) {
      answered = true;
      clearTimeout(timer);
      jsxLoading = false;
      if (res === "ok") {
        jsxReady = true;
        jsxError = "";
        log("Host modules loaded (" + host + (canPush ? " + reader" : "") + ").");
        if (canPush) {
          pushCard.hidden = false;
          document.getElementById("push-title").textContent = verb + " selection";
          pushSub.textContent = role === "aftereffects"
            ? "Send the selected layers back to Illustrator as editable artwork."
            : "Send the selected artwork to another app.";
        }
        updatePushButton();
        flushJsxWaiters(true);
        return;
      }
      jsxError = describeLoadError(res, files);
      log("Failed to load the host scripts: " + jsxError, "err");
      flushJsxWaiters(false);
    });
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

  function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { if (ws) ws.close(); } catch (e) {}
    setConn(false, "Connecting…");
    try {
      ws = new WebSocket(BRIDGE_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.onopen = function () {
      setConn(true, "Connected");
      send({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        role: role,
        client: roleLabel(role) + " " + (env.appVersion || "")
      });
      log("Connected to LazyLord bridge.");
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      onMessage(msg);
    };
    ws.onclose = function () {
      setConn(false, "Bridge offline");
      peers = [];
      renderTargets();
      scheduleReconnect();
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, 2500);
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function onMessage(msg) {
    if (msg.type === "transfer") {
      if (!autoEl.checked) { declineTransfer(msg); return; }
      handleTransfer(msg);
    } else if (msg.type === "welcome" || msg.type === "peers") {
      peers = msg.peers || [];
      renderTargets();
    } else if (msg.type === "ack") {
      onAck(msg);
    }
  }

  // --- Push targets -------------------------------------------------------

  function renderTargets() {
    if (!canPush) return;
    var previous = targetSel.value;
    var available = [];
    for (var i = 0; i < peers.length; i++) {
      var p = peers[i];
      if (p === role || p === "unknown" || p === "figma") continue; // Figma cannot receive yet
      if (!contains(available, p)) available.push(p);
    }

    clearChildren(targetSel);
    if (available.length === 0) {
      var none = document.createElement("option");
      none.value = "";
      none.textContent = "No app connected";
      targetSel.appendChild(none);
    } else {
      for (var j = 0; j < available.length; j++) {
        var opt = document.createElement("option");
        opt.value = available[j];
        opt.textContent = roleLabel(available[j]);
        targetSel.appendChild(opt);
      }
      // The user's remembered choice wins whenever that app is connected; the
      // current selection only stands in for it while it is not.
      var saved = prefs.target;
      var preferred = PREFERRED_TARGET[role];
      if (saved && contains(available, saved)) targetSel.value = saved;
      else if (previous && contains(available, previous)) targetSel.value = previous;
      else if (preferred && contains(available, preferred)) targetSel.value = preferred;
    }

    targetsAvailable = available.length > 0;
    updatePushButton();
  }

  function updatePushButton() {
    if (!canPush) return;
    pushBtn.disabled = pushBusy || !targetsAvailable || !jsxReady;
    pushBtn.textContent = pushBusy ? verb + "ing…" : verb;
  }

  function setPushBusy(b) {
    pushBusy = b;
    updatePushButton();
  }

  // --- Filesystem ---------------------------------------------------------

  function tempDir(id) {
    var sep = nodePath ? nodePath.sep : "/";
    var base = (os ? os.tmpdir() : cs.getSystemPath(SystemPath.USER_DATA)) + sep + "lazylord";
    var dir = base + sep + id;
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

  // --- Push ---------------------------------------------------------------

  function doPush() {
    var target = targetSel.value;
    if (!target) { log("No destination app is connected.", "err"); return; }
    if (!jsxReady) {
      loadJsx(function (ok) {
        if (ok) doPush();
        else log("Could not load the host scripts (" + jsxError + ").", "err");
      });
      return;
    }

    // Taken now: the options showing when the button was pressed are the ones
    // sent, even if a select is changed while the host is still reading.
    var options = pushOptions();
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
    log("Reading the " + roleLabel(role) + " selection…");

    cs.evalScript("LazyLord.runRead(" + jsonStr(dir) + ")", function (res) {
      var r;
      try { r = JSON.parse(res); } catch (e) { r = { ok: false, message: "Host error: " + res }; }

      if (r.diagnostics && r.diagnostics.length) setDiagnostics(r.diagnostics, id);

      if (!r.ok) {
        log(r.message || "Could not read the selection.", "err");
        setPushBusy(false);
        return;
      }

      var doc;
      try {
        doc = JSON.parse(readText(r.irPath));
        if (!doc || typeof doc !== "object" || !doc.layers) throw new Error("it carried no layers.");
      } catch (e2) {
        log("Could not read the exported data: " + e2.message, "err");
        setPushBusy(false);
        return;
      }

      // The document goes out as the reader wrote it — canvas, clip, primitive
      // and groups included — plus the options chosen in this panel, which the
      // target's builder obeys. Nothing else is rewritten.
      doc.options = options;

      pendingPush = id;
      pendingPushInfo = {
        images: imageStats(doc),
        diagnostics: doc.diagnostics || r.diagnostics || []
      };
      send({ type: "transfer", id: id, target: target, document: doc });
      // Counted here, not taken from the reader's layerCount, which only sees
      // the top level: layers inside groups count too.
      var note = optionsNote(options);
      log("Sent " + layerPhrase(doc.layers) + " to " + roleLabel(target) + (note ? " · " + note : "") + "…");

      setTimeout(function () {
        if (pendingPush !== id) return;
        // Free the button, but remember what was sent: a large rebuild can
        // outlast the wait, and its result still deserves a summary.
        pruneLateAcks();
        lateAcks[id] = { info: pendingPushInfo, at: new Date().getTime() };
        pendingPush = null;
        pendingPushInfo = null;
        log("No response from " + roleLabel(target) + " after " + (PUSH_TIMEOUT_MS / 1000) +
          " s. Its result will still be shown here if it arrives.", "warn");
        setPushBusy(false);
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

    // A late reply leaves the card to a push that is still waiting for its
    // own answer; the summary line below still counts every fallback.
    if (!late || !pendingPush) showTransferDiagnostics(msg.id, info.diagnostics, hostDiags);

    if (msg.ok) {
      // Fallbacks cover the whole transfer — our reader's and the target's
      // rebuild (from the ack) — so the line agrees with the card.
      var all = info.diagnostics.concat(hostDiags);
      log("Rebuilt in " + roleLabel(msg.from) + (late ? " (late reply)" : "") + ": " +
        transferSummary(msg.layersCreated, info.images, all), all.length ? "warn" : "ok");
    } else {
      log((late ? "Late reply from " + roleLabel(msg.from) + ": " : "") +
        (msg.message || "The transfer failed."), "err");
    }
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
      eachLayer(doc.layers, function (layer) {
        if (layer.type === "image" && layer.pngBase64 && !layer.filePath) {
          var pngPath = joinPath(dir, uniqueImageName(layer.id, usedNames));
          writePngFromBase64(pngPath, layer.pngBase64);
          layer.filePath = pngPath;
          layer.isOriginalFile = false;
          delete layer.pngBase64;
        }
      });
      var images = imageStats(doc);

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
            transferSummary(result.layersCreated, images, all), all.length ? "warn" : "ok");
        } else {
          log("Build failed: " + (result.message || "unknown error"), "err");
        }
        ack(msg.id, !!result.ok, result.message, result.layersCreated, recvDiags.concat(buildDiags));
      });
    } catch (e) {
      log("Transfer error: " + e.message, "err");
      ack(msg.id, false, e.message, 0, recvDiags);
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

  function ack(id, ok, message, layersCreated, diagnostics) {
    send({
      type: "ack",
      id: id,
      from: role,
      ok: ok,
      message: message,
      layersCreated: layersCreated || 0,
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
  function transferSummary(layersCreated, images, diagnostics) {
    var imgs = images.total === 0
      ? "no images"
      : plural(images.total, "image") + " (" + images.original + " original, " + images.generated + " generated)";
    var c = countResolutions(diagnostics);
    var falls = "no fallbacks";
    if (c.total) {
      falls = "fallbacks: " + c.approximated + " approximated / " + c.rasterized + " rasterized / " +
        c.skipped + " skipped" + (c.other ? " / " + c.other + " other" : "");
    }
    return plural(layersCreated || 0, "layer") + " created · " + imgs + " · " + falls;
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
    pushBtn.addEventListener("click", doPush);
    targetSel.addEventListener("change", function () {
      if (targetSel.value) savePref("target", targetSel.value);
    });
    if (layoutSel) layoutSel.addEventListener("change", function () {
      savePref("layout", pushOptions().layout);
      updateOptionsNote();
    });
    if (hierarchySel) hierarchySel.addEventListener("change", function () {
      savePref("hierarchy", pushOptions().hierarchy);
      updateOptionsNote();
    });
  }

  restorePrefs();
  loadJsx();
  connect();
})();
