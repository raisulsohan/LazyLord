/*
 * LazyLord - CEP panel controller tests (no Node required).
 *
 *   cscript //Nologo tools\test-cep-panel.js
 *
 * Runs the real js/main.js against a mocked panel DOM, CSInterface, WebSocket
 * and localStorage under Windows Script Host. main.js runs in CEP's Chromium,
 * but it is kept ES3-clean, so JScript can drive it end to end.
 *
 * Covers what is otherwise only visible by clicking around in the panel:
 * per-host preferences, the one-line transfer summary, the ordering and counts
 * of the diagnostics card, and that canvas / clip / primitive pass through the
 * panel byte for byte (only image layers are materialised). Also that a
 * transfer declined because auto-receive is off gets a failed ack the sender
 * can show, and that an ack arriving after the push timed out is still reported.
 * Hierarchy: embedded images are materialised however deeply they are grouped
 * (each to its own file), layer and image counts include group children, and
 * the push card's Layout / Hierarchy options are remembered per host and sent
 * as doc.options. The option values are read from the real index.html.
 * Image file names stay unique for missing or awkward ids ("__proto__").
 * Malformed entries anywhere in the layer tree (null, numbers, text, lists) are
 * left out of ir.json with a "skipped" diagnostic that also reaches the sender,
 * and the written ir.json is walked with the real host helpers from
 * lazylord.jsx (applyOrigin / eachLayer / flattenLayers), as every builder does.
 * Updates: the latest release is asked of GitHub (a mocked XMLHttpRequest) a
 * few seconds after opening, a newer one shows its card and marks the header
 * version, Later and the "Check for updates" switch are remembered, a recent
 * answer is reused, and failures stay quiet unless the user asked.
 */
var fso = new ActiveXObject("Scripting.FileSystemObject");

var scriptDir = fso.GetParentFolderName(WScript.ScriptFullName);
var repoRoot = fso.GetParentFolderName(scriptDir);
var CEP = fso.BuildPath(repoRoot, "packages\\adobe-cep") + "\\";

function read(path) {
    var st = new ActiveXObject("ADODB.Stream");
    st.Type = 2; st.Charset = "utf-8"; st.Open();
    st.LoadFromFile(path);
    var s = st.ReadText(-1);
    st.Close();
    return s;
}

function load(rel) {
    return read(CEP + rel).replace(/^\s*#[a-zA-Z].*$/gm, "");
}

// json2 at GLOBAL scope: the panel relies on a global JSON.
eval(load("jsx\\json2.js"));
var MAIN_SRC = load("js\\main.js");
var HTML_SRC = read(CEP + "index.html");

// The shared host helpers, also at GLOBAL scope, so a test can walk the
// ir.json the panel writes exactly the way every builder does
// (LazyLord.eachLayer / flattenLayers / applyOrigin). A load failure is
// reported by the tests that need them rather than stopping the suite.
var HELPERS_ERROR = null;
try { eval(load("jsx\\lazylord.jsx")); } catch (e) { HELPERS_ERROR = e.message || String(e); }

/**
 * Walk a written document with the host helpers; returns null when all of
 * them get through, or the error a builder would have hit.
 */
function hostWalk(doc) {
    if (HELPERS_ERROR !== null) return "lazylord.jsx did not load: " + HELPERS_ERROR;
    try {
        LazyLord.applyOrigin(doc);
        LazyLord.eachLayer(doc.layers, function (layer) { return layer.type; });
        LazyLord.countLeaves(doc.layers);
        LazyLord.flattenLayers(doc.layers);
        return null;
    } catch (e) {
        return e.message || String(e);
    }
}
/** Every list in a layer tree holds only layer objects (no null, text, numbers or lists). */
function allEntriesAreLayers(layers) {
    if (Object.prototype.toString.call(layers) !== "[object Array]") return false;
    for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (l === null || typeof l !== "object" || Object.prototype.toString.call(l) === "[object Array]") return false;
        // Missing or null children are an empty group to every host helper.
        if (l.type === "group" && l.children !== undefined && l.children !== null &&
            !allEntriesAreLayers(l.children)) return false;
    }
    return true;
}

/** Option values of a <select> in index.html, in document order. */
function selectValues(id) {
    var m = new RegExp('<select id="' + id + '"[^>]*>([\\s\\S]*?)</select>').exec(HTML_SRC);
    var out = [];
    if (!m) return out;
    var re = /<option value="([^"]*)"/g, o;
    while ((o = re.exec(m[1])) !== null) out.push(o[1]);
    return out;
}
var LAYOUT_VALUES = selectValues("push-layout");
var HIERARCHY_VALUES = selectValues("push-hierarchy");
var EXISTING_VALUES = selectValues("push-existing");
var KEYFRAME_VALUES = selectValues("push-keyframes");
var CONFLICT_VALUES = selectValues("push-conflict");
var DESTINATION_VALUES = selectValues("push-destination");
/** The image scales index.html offers, read off its chips. */
var SCALE_VALUES = (function () {
    var out = [], re = /data-scale="([^"]*)"/g, m;
    while ((m = re.exec(HTML_SRC)) !== null) out.push(m[1]);
    return out;
})();

// --- Minimal DOM ------------------------------------------------------------
function El(tag, id) {
    this.tagName = tag;
    this.id = id || "";
    this.nodeType = 1;
    this.children = [];
    this.firstChild = null;
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.style = {};
    this.listeners = {};
}
El.prototype.appendChild = function (c) {
    // A text node appended to an element also becomes its text, as in the real
    // DOM — but it stays in children, which index-based assertions rely on.
    if (c && c.nodeType === 3) this.textContent = (this.textContent || "") + c.textContent;
    this.children.push(c);
    this.firstChild = this.children[0];
    // A <select> selects its first option, like the real thing.
    if (this.tagName === "select" && this.children.length === 1) this.value = c.value;
    return c;
};
El.prototype.removeChild = function (c) {
    for (var i = 0; i < this.children.length; i++) {
        if (this.children[i] === c) { this.children.splice(i, 1); break; }
    }
    this.firstChild = this.children.length ? this.children[0] : null;
    if (this.tagName === "select" && !this.children.length) this.value = "";
    return c;
};
El.prototype.addEventListener = function (type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
};
El.prototype.fire = function (type, target) {
    var hs = this.listeners[type] || [];
    for (var i = 0; i < hs.length; i++) hs[i]({ type: type, target: target || this });
};
El.prototype.setAttribute = function (name, value) {
    if (!this.attrs) this.attrs = {};
    this.attrs[name] = String(value);
};
El.prototype.getAttribute = function (name) {
    return (this.attrs && this.attrs[name] !== undefined) ? this.attrs[name] : null;
};
/** Click a chip the way a user does: the event bubbles to its row. */
El.prototype.clickChip = function (value, key) {
    var chip = null;
    for (var i = 0; i < this.children.length; i++) {
        if (this.children[i].getAttribute("data-" + key) === String(value)) chip = this.children[i];
    }
    if (!chip) throw new Error("no " + key + " chip for " + value);
    this.fire("click", chip);
    return chip;
};
function textNode(s) { return { nodeType: 3, textContent: s, nodeValue: s }; }

var IDS = ["conn", "conn-text", "host", "host-sub", "log", "auto", "push-card",
           "push-sub", "push", "push-targets", "push-scales", "scale-card", "destination-card",
           "options-card", "send-card", "diag-card", "diag-head", "diag-title",
           "diag-counts", "diag-list", "reconnect", "push-options", "push-opts-note", "push-layout",
           "push-hierarchy", "push-existing", "push-keyframes", "push-keyframes-row", "push-opts-hint",
           "push-destination", "push-dest-note", "push-preset", "push-preset-name", "push-preset-save",
           "push-preset-delete", "history", "history-list", "history-count", "history-clear",
           "ae-tools", "ae-precompose", "ae-decompose", "ae-import-psd", "push-only-changed", "push-only-changed-row",
           "push-conflict", "push-conflict-row", "push-live", "ver", "log-card", "log-last", "author",
           "image-folder-row", "image-folder", "image-folder-choose", "image-folder-reset", "push-sequence", "push-sequence-row",
           "update-card", "update-title", "update-notes", "update-download", "update-later", "check-updates"];
var LIVE_POLL = 1500;
var TAGS = { "auto": "input", "push": "button", "reconnect": "button",
             "push-preset": "select", "push-preset-name": "input", "push-preset-save": "button",
             "push-preset-delete": "button", "history": "details", "history-list": "ul", "history-clear": "button",
             "ae-precompose": "button", "ae-decompose": "button", "ae-import-psd": "button", "push-only-changed": "input", "push-live": "input",
             "diag-list": "ul", "push-options": "details", "log-card": "details",
             "push-layout": "select", "push-hierarchy": "select",
             "push-existing": "select", "push-keyframes": "select", "push-conflict": "select",
             "push-destination": "select", "image-folder-choose": "button", "image-folder-reset": "button", "push-sequence": "input",
             "update-notes": "ul", "update-download": "button", "update-later": "button", "check-updates": "input" };

/** Fill a mock chip row the way index.html does, with one chip active. */
function addChips(row, key, values, active) {
    for (var i = 0; i < values.length; i++) {
        var chip = new El("button");
        chip.setAttribute("data-" + key, values[i]);
        chip.className = values[i] === active ? "a-" + key + " is-active" : "a-" + key;
        chip.appendChild(textNode(values[i]));
        row.appendChild(chip);
    }
}

/** Fill a mock <select> with index.html's options; the first one is selected. */
function addOptions(sel, values) {
    for (var i = 0; i < values.length; i++) {
        var o = new El("option");
        o.value = values[i];
        o.textContent = values[i];
        sel.appendChild(o);
    }
}

// --- Host, bridge and storage stand-ins --------------------------------------
var document = null, window = null;
var els = {}, sockets = [], evalCalls = [], files = {}, timers = [];
var currentApp = "ILST";

var SystemPath = { EXTENSION: "extension", USER_DATA: "userData" };

function CSInterface() {}
CSInterface.prototype.getHostEnvironment = function () {
    return { appName: currentApp, appVersion: "99.0" };
};
CSInterface.prototype.getSystemPath = function (p) {
    return p === SystemPath.EXTENSION ? "C:/ext" : "C:/data";
};
CSInterface.prototype.evalScript = function (script, cb) {
    evalCalls.push({ script: script, cb: cb });
    if (script.indexOf("$.evalFile") >= 0) cb("ok"); // module load succeeds at once
};

function WebSocket(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    sockets.push(this);
}
WebSocket.prototype.send = function (s) { this.sent.push(JSON.parse(s)); };
WebSocket.prototype.close = function () { this.readyState = 3; };

function setTimeout(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; }
function clearTimeout(id) {}

/** The panel's requests to GitHub, answered by the test with respond(). */
var requests = [], opened = [];
function XMLHttpRequest() { this.headers = {}; this.readyState = 0; requests.push(this); }
XMLHttpRequest.prototype.open = function (method, url, async) { this.method = method; this.url = url; this.async = async; };
XMLHttpRequest.prototype.setRequestHeader = function (k, v) { this.headers[k] = v; };
XMLHttpRequest.prototype.send = function () { this.sent = true; };
XMLHttpRequest.prototype.respond = function (status, body) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.readyState = 4;
    this.onreadystatechange();
};

function MemoryStorage() { this.data = {}; }
MemoryStorage.prototype.getItem = function (k) {
    return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null;
};
MemoryStorage.prototype.setItem = function (k, v) { this.data[k] = String(v); };

function BrokenStorage() { this.writes = 0; }
BrokenStorage.prototype.getItem = function () { throw new Error("denied"); };
BrokenStorage.prototype.setItem = function () { this.writes++; throw new Error("denied"); };

/** Fresh panel: new DOM, new socket, same storage if passed back in. */
function boot(appName, storage) {
    els = {};
    for (var i = 0; i < IDS.length; i++) els[IDS[i]] = new El(TAGS[IDS[i]] || "div", IDS[i]);
    els["host"].appendChild(textNode("Detecting host..."));
    els["log"].appendChild(textNode("Waiting for the LazyLord bridge..."));
    els["auto"].checked = true; // index.html default
    els["push-only-changed"].checked = true; // index.html default
    els["push-card"].hidden = true;
    els["image-folder-row"].hidden = true; // index.html default
    els["push-sequence-row"].hidden = true;
    els["image-folder-reset"].hidden = true;
    els["diag-card"].hidden = true;
    addOptions(els["push-layout"], LAYOUT_VALUES);
    addOptions(els["push-hierarchy"], HIERARCHY_VALUES);
    addOptions(els["push-existing"], EXISTING_VALUES);
    addOptions(els["push-keyframes"], KEYFRAME_VALUES);
    addOptions(els["push-conflict"], CONFLICT_VALUES);
    addOptions(els["push-destination"], DESTINATION_VALUES);
    addChips(els["push-scales"], "scale", SCALE_VALUES, "2"); // index.html default
    els["push-keyframes-row"].hidden = true;
    els["update-card"].hidden = true; // index.html default
    els["update-notes"].hidden = true;
    els["check-updates"].checked = true;

    sockets = []; evalCalls = []; files = {}; timers = []; requests = []; opened = [];
    currentApp = appName;

    document = {
        getElementById: function (id) { return els[id] || null; },
        createElement: function (t) { return new El(t); },
        createTextNode: textNode
    };
    window = {
        localStorage: storage,
        cep: {
            fs: {
                makedir: function () { return { err: 0 }; },
                writeFile: function (path, data, enc) { files[path] = { data: data, enc: enc || "" }; return { err: 0 }; },
                readFile: function (path) {
                    return files[path] ? { err: 0, data: files[path].data } : { err: 3, data: "" };
                }
            },
            encoding: { Base64: "Base64", UTF8: "UTF-8" },
            util: { openURLInDefaultBrowser: function (url) { opened.push(url); } }
        }
    };

    eval(MAIN_SRC);
    var sock = sockets[sockets.length - 1];
    sock.onopen();
    return sock;
}

function deliver(sock, msg) { sock.onmessage({ data: JSON.stringify(msg) }); }
function peersMsg(sock, type, list) { deliver(sock, { type: type, protocol: 1, peers: list }); }

// --- Reading the panel back --------------------------------------------------
function logLines() {
    var out = [], kids = els["log"].children;
    for (var i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === 1) out.push({ text: kids[i].textContent, kind: kids[i].className });
    }
    return out;
}
function has(s, sub) { return String(s).indexOf(sub) >= 0; }
function linesWith(sub) {
    var out = [], lines = logLines();
    for (var i = 0; i < lines.length; i++) if (has(lines[i].text, sub)) out.push(lines[i]);
    return out;
}
function lastLog() {
    var l = logLines();
    return l.length ? l[l.length - 1] : { text: "", kind: "" };
}
function lastSent(sock) { return sock.sent[sock.sent.length - 1]; }
function lastEval() { return evalCalls[evalCalls.length - 1]; }
/** Run the most recent timer scheduled for `ms`; false when there is none. */
function fireTimer(ms) {
    for (var i = timers.length - 1; i >= 0; i--) {
        if (timers[i].ms === ms) { timers[i].fn(); return true; }
    }
    return false;
}
function texts(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i].textContent);
    return out.join("|");
}
function diagObjects() {
    var out = [], kids = els["diag-list"].children;
    for (var i = 0; i < kids.length; i++) out.push(kids[i].children[0].textContent);
    return out.join("|");
}
function diagTags() {
    var out = [], kids = els["diag-list"].children;
    for (var i = 0; i < kids.length; i++) {
        var tag = kids[i].children[2];
        out.push(tag.textContent + "/" + tag.className);
    }
    return out.join("|");
}
function irFile() {
    for (var k in files) {
        if (Object.prototype.hasOwnProperty.call(files, k) && /ir\.json$/.test(k)) return { path: k, file: files[k] };
    }
    return null;
}
function endsWith(s, tail) { s = String(s); return s.substr(s.length - tail.length) === tail; }
/** Every image layer in a tree, group children included, in walk order. */
function imagesIn(layers, out) {
    out = out || [];
    for (var i = 0; layers && i < layers.length; i++) {
        if (!layers[i]) continue;
        if (layers[i].type === "image") out.push(layers[i]);
        if (layers[i].type === "group") imagesIn(layers[i].children, out);
    }
    return out;
}
function noteText() { return els["push-opts-note"].textContent; }
/** The value of the active chip in a row, or "". */
function chipValue(row, key) {
    for (var i = 0; i < row.children.length; i++) {
        if (/is-active/.test(row.children[i].className || "")) return row.children[i].getAttribute("data-" + key);
    }
    return "";
}
/** Click a chip, the way a user does. */
function pick(id, key, value) { return els[id].clickChip(value, key); }
function optionValues() { return els["push-layout"].value + "/" + els["push-hierarchy"].value; }
/** Pick an option the way a user does: set the value, then the change event. */
function choose(id, value) { els[id].value = value; els[id].fire("change"); }
// Non-ASCII in the panel's log lines, built from char codes: cscript reads this
// file as ANSI, so a literal ellipsis or middle dot would not match.
var ELLIPSIS = String.fromCharCode(0x2026), DOT = " " + String.fromCharCode(0xB7) + " ";

// --- Assertions ----------------------------------------------------------------
var passed = 0, failed = 0;

function ok(name, cond, detail) {
    if (cond) { WScript.Echo("  ok   " + name); passed++; }
    else { WScript.Echo("  FAIL " + name + (detail !== undefined ? "  -> " + detail : "")); failed++; }
}
function run(name, fn) {
    try { fn(); } catch (e) { ok(name + " (threw)", false, e.message || String(e)); }
}

// --- Fixtures ------------------------------------------------------------------
function square() {
    return {
        closed: true,
        vertices: [[0, 0], [50, 0], [50, 50], [0, 50]],
        inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
        outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]]
    };
}
function clipPath() {
    return { id: "clip-1", name: "Mask", subpaths: [square()], windingRule: "evenodd" };
}
function frame(x, y) { return { x: x, y: y, width: 50, height: 50, rotation: 0, opacity: 1 }; }

function figmaDoc() {
    return {
        version: "1.0", source: "figma", name: "Page", originSpace: "canvas",
        bounds: { x: 10, y: 20, width: 200, height: 100 },
        canvas: { width: 1920, height: 1080, name: "Desktop" },
        layers: [
            { id: "v1", name: "Card", type: "vector", frame: frame(0, 0), subpaths: [square()],
              fills: [{ type: "linear-gradient", stops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
                                                          { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }],
                        from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 } }],
              strokes: [], windingRule: "nonzero",
              primitive: { kind: "rect", x: 0, y: 0, width: 50, height: 50, roundness: 8 },
              clip: clipPath() },
            { id: "i1", name: "Photo", type: "image", frame: frame(60, 0), pngBase64: "iVBORw0KGgo=",
              pixelWidth: 100, pixelHeight: 100, clip: clipPath() },
            { id: "i2", name: "Linked", type: "image", frame: frame(120, 0), filePath: "C:\\art\\photo.psd",
              isOriginalFile: true, pixelWidth: 50, pixelHeight: 50 },
            { id: "g1", name: "Group", type: "group", frame: frame(0, 60), children: [
                { id: "i3:child", name: "Nested", type: "image", frame: frame(0, 60), pngBase64: "AAAA",
                  pixelWidth: 2, pixelHeight: 2 }
            ]}
        ],
        diagnostics: [
            { object: "Blur", reason: "Layer blur is not supported", resolution: "approximated" },
            { object: "Video", reason: "Video fills cannot transfer", resolution: "skipped" }
        ]
    };
}

WScript.Echo("LazyLord - CEP panel controller (mocked DOM)");
WScript.Echo("");

var store = new MemoryStorage();
/** The failed ack Illustrator sends while auto-receive is off (case 2 -> 9). */
var declinedAck = null;

// 1) Defaults, then the user's choices are stored under the host's own key.
run("prefs", function () {
    var sock = boot("ILST", store);
    var sel = els["push-targets"];

    ok("prefs: auto-receive on by default", els["auto"].checked === true);
    // A bug report starts with which LazyLord it was, so the panel shows it.
    ok("prefs: the panel prints its own version",
       /^v\d+\.\d+\.\d+$/.test(els["ver"].textContent), els["ver"].textContent);
    ok("prefs: that version matches the manifest",
       els["ver"].textContent === "v" + (read(CEP + "CSXS\\manifest.xml").match(/ExtensionBundleVersion="([\d.]+)"/) || [])[1],
       els["ver"].textContent);
    ok("prefs: push card shown on a host with a reader", els["push-card"].hidden === false);
    // The log is folded, but whatever it last said is still readable.
    ok("prefs: the log stays folded", els["log-card"].open !== true);
    ok("prefs: its newest line shows on the summary",
       els["log-last"].textContent.length > 0 &&
       lastLog().text.indexOf(els["log-last"].textContent) > 0,
       els["log-last"].textContent + " / " + lastLog().text);
    peersMsg(sock, "welcome", ["illustrator", "photoshop", "aftereffects", "figma"]);
    ok("prefs: Illustrator defaults to After Effects", chipValue(sel, "target") === "aftereffects", chipValue(sel, "target"));
    // Figma receives now, so every connected app but this one is offered.
    ok("prefs: every other app is offered, and not itself",
       texts(sel.children) === "Photoshop|After Effects|Figma", texts(sel.children));
    ok("prefs: nothing stored before the user chooses", store.getItem("lazylord.prefs.illustrator") === null);

    pick("push-targets", "target", "photoshop");
    sel.fire("change");
    els["auto"].checked = false;
    els["auto"].fire("change");

    var saved = JSON.parse(store.getItem("lazylord.prefs.illustrator"));
    ok("prefs: target stored per host role", saved && saved.target === "photoshop", store.getItem("lazylord.prefs.illustrator"));
    ok("prefs: auto-receive stored", saved && saved.autoReceive === false);
    ok("prefs: no other key written", store.getItem("lazylord.prefs.aftereffects") === null);

    ok("options: Split and Flatten by default", optionValues() === "split/flatten", optionValues());
    ok("options: nothing noted on the defaults", noteText() === "", noteText());
    choose("push-layout", "combine");
    ok("options: the folded label names the choice", noteText() === "Combine", noteText());
    choose("push-hierarchy", "groups");
    ok("options: both choices named", noteText() === "Combine, Groups", noteText());
    saved = JSON.parse(store.getItem("lazylord.prefs.illustrator"));
    ok("options: stored with the host's other prefs", saved && saved.layout === "combine" &&
       saved.hierarchy === "groups" && saved.target === "photoshop" && saved.autoReceive === false,
       store.getItem("lazylord.prefs.illustrator"));
});

// 2) A reopened panel restores both - the target only once that app connects.
run("restore", function () {
    var sock = boot("ILST", store);
    var sel = els["push-targets"];

    ok("restore: auto-receive off comes back", els["auto"].checked === false);
    ok("restore: push options come back", optionValues() === "combine/groups", optionValues());
    ok("restore: and are named while folded", noteText() === "Combine, Groups", noteText());
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
    ok("restore: default stands in while the saved app is absent", chipValue(sel, "target") === "aftereffects", chipValue(sel, "target"));
    peersMsg(sock, "peers", ["illustrator", "aftereffects", "photoshop"]);
    ok("restore: saved target selected once it connects", chipValue(sel, "target") === "photoshop", chipValue(sel, "target"));
    peersMsg(sock, "peers", ["illustrator", "aftereffects", "photoshop", "photoshop"]);
    ok("restore: duplicate peers listed once", sel.children.length === 2, texts(sel.children));

    deliver(sock, { type: "transfer", id: "t-off", target: "illustrator", document: figmaDoc() });
    ok("restore: transfers declined while auto-receive is off", has(lastLog().text, "auto-receive off"), lastLog().text);
    ok("restore: nothing built", irFile() === null);
    var refusal = lastSent(sock);
    ok("restore: the sender is told (failed ack)", refusal && refusal.type === "ack" && refusal.id === "t-off" &&
       refusal.ok === false && refusal.from === "illustrator" && refusal.layersCreated === 0, JSON.stringify(refusal));
    ok("restore: the ack says why and what to do",
       has(refusal.message, "Auto-receive is off in the Illustrator LazyLord panel") &&
       has(refusal.message, "Tick Auto-receive"), refusal.message);
    declinedAck = refusal;

    // A broadcast (no target) is declined out loud as well.
    var before = sock.sent.length;
    deliver(sock, { type: "transfer", id: "t-all", document: figmaDoc() });
    ok("restore: broadcasts are declined too", sock.sent.length === before + 1 &&
       lastSent(sock).id === "t-all" && lastSent(sock).ok === false, JSON.stringify(lastSent(sock)));
    ok("restore: still nothing built", irFile() === null);
});

// 3) After Effects keeps its own preferences on the same machine.
run("per-host", function () {
    var sock = boot("AEFT", store);
    var sel = els["push-targets"];

    ok("per-host: AE ignores Illustrator's auto-receive", els["auto"].checked === true);
    ok("per-host: AE ignores Illustrator's push options", optionValues() === "split/flatten" && noteText() === "",
       optionValues());
    peersMsg(sock, "welcome", ["aftereffects", "illustrator", "photoshop"]);
    ok("per-host: AE defaults to Illustrator", chipValue(sel, "target") === "illustrator", chipValue(sel, "target"));
    els["auto"].checked = false;
    els["auto"].fire("change");
    var ae = JSON.parse(store.getItem("lazylord.prefs.aftereffects"));
    var ai = JSON.parse(store.getItem("lazylord.prefs.illustrator"));
    ok("per-host: AE stored under its own key", ae && ae.autoReceive === false && ae.target === undefined,
       store.getItem("lazylord.prefs.aftereffects"));
    ok("per-host: Illustrator's key untouched", ai && ai.target === "photoshop" && ai.autoReceive === false &&
       ai.layout === "combine" && ai.hierarchy === "groups", store.getItem("lazylord.prefs.illustrator"));
    ok("per-host: AE stores no options it was not given", ae && ae.layout === undefined && ae.hierarchy === undefined,
       store.getItem("lazylord.prefs.aftereffects"));
});

// 4) Storage that throws, is missing or holds junk never breaks the panel.
run("storage", function () {
    var broken = new BrokenStorage();
    var threw = null, autoAtBoot = null;
    try {
        var sock = boot("ILST", broken);
        autoAtBoot = els["auto"].checked;
        els["auto"].checked = false;
        els["auto"].fire("change");
        // The target chips only exist once the bridge says who is listening.
        peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
        pick("push-targets", "target", "aftereffects");
    } catch (e) { threw = e.message || String(e); }
    ok("storage: a throwing store is survivable", threw === null, threw);
    ok("storage: defaults used", autoAtBoot === true, String(autoAtBoot));
    ok("storage: each change still tries to save", broken.writes === 2, String(broken.writes));
    ok("storage: the problem is reported once", linesWith("reset").length + linesWith("defaults").length === 1,
       texts(els["log"].children));

    threw = null;
    try { boot("ILST", null); } catch (e2) { threw = e2.message || String(e2); }
    ok("storage: a missing store is survivable", threw === null, threw);
    ok("storage: a missing store is reported", linesWith("cannot be stored").length === 1);

    var junk = new MemoryStorage();
    junk.setItem("lazylord.prefs.illustrator", "{not json");
    boot("ILST", junk);
    ok("storage: unreadable prefs reset to defaults", els["auto"].checked === true);
    ok("storage: unreadable prefs reported", linesWith("unreadable").length === 1);

    var odd = new MemoryStorage();
    odd.setItem("lazylord.prefs.illustrator", JSON.stringify({ autoReceive: false, layout: "stack", hierarchy: 7 }));
    boot("ILST", odd);
    ok("storage: option values the panel does not offer fall back to the defaults",
       optionValues() === "split/flatten" && noteText() === "", optionValues());
    ok("storage: the valid prefs beside them are kept", els["auto"].checked === false);
});

// 5) Receive: pass-through, materialisation, summary, card and ack.
run("receive", function () {
    var sock = boot("PHXS", new MemoryStorage());
    // Photoshop has a reader of its own now, so it sends as well as receives.
    ok("receive: Photoshop offers a send card too", els["push-card"].hidden === false);

    var original = figmaDoc();
    var sentStr = JSON.stringify(original);
    deliver(sock, { type: "transfer", id: "t-1", document: original });
    ok("receive: counts leaves inside groups", linesWith("Receiving 4 layers (1 group) from Figma" + ELLIPSIS).length === 1,
       texts(els["log"].children));

    var ir = irFile();
    ok("receive: ir.json written", ir !== null);
    var built = JSON.parse(ir.file.data);
    var byId = {};
    for (var i = 0; i < built.layers.length; i++) byId[built.layers[i].id] = built.layers[i];
    var nested = byId["g1"].children[0];

    ok("receive: canvas passes through", JSON.stringify(built.canvas) === JSON.stringify(original.canvas),
       JSON.stringify(built.canvas));
    ok("receive: vector clip passes through", JSON.stringify(byId["v1"].clip) === JSON.stringify(clipPath()));
    ok("receive: primitive passes through",
       JSON.stringify(byId["v1"].primitive) === JSON.stringify(original.layers[0].primitive));
    ok("receive: image clip passes through", JSON.stringify(byId["i1"].clip) === JSON.stringify(clipPath()));
    ok("receive: gradient paint passes through",
       JSON.stringify(byId["v1"].fills) === JSON.stringify(original.layers[0].fills));

    ok("receive: embedded PNG written to a file", endsWith(byId["i1"].filePath, "i1.png") &&
       byId["i1"].pngBase64 === undefined && byId["i1"].isOriginalFile === false, JSON.stringify(byId["i1"]));
    var png = files[byId["i1"].filePath];
    ok("receive: PNG written as base64", png && png.data === "iVBORw0KGgo=" && png.enc === "Base64");
    ok("receive: the user's own file untouched",
       byId["i2"].filePath === "C:\\art\\photo.psd" && byId["i2"].isOriginalFile === true);
    ok("receive: images inside groups materialised", endsWith(nested.filePath, "i3_child.png") &&
       nested.pngBase64 === undefined, JSON.stringify(nested));

    // Everything else is byte-identical: replay the only permitted edits.
    var expected = JSON.parse(sentStr);
    var imgs = [expected.layers[1], expected.layers[3].children[0]];
    var outs = [byId["i1"], nested];
    for (var j = 0; j < imgs.length; j++) {
        imgs[j].filePath = outs[j].filePath;
        imgs[j].isOriginalFile = false;
        delete imgs[j].pngBase64;
    }
    ok("receive: nothing but image layers changed", JSON.stringify(expected) === ir.file.data);

    var call = lastEval();
    ok("receive: builder run on ir.json", has(call.script, "LazyLord.run(") && has(call.script, "ir.json"), call.script);
    ok("receive: source diagnostics shown straight away", els["diag-card"].hidden === false &&
       diagObjects() === "Video|Blur", diagObjects());

    call.cb(JSON.stringify({ ok: true, layersCreated: 5, message: "", diagnostics: [
        { object: "Card", reason: "Gradient flattened", resolution: "approximated" },
        { object: "Glow", reason: "Effect rasterised", resolution: "rasterized" }
    ]}));

    var line = lastLog();
    ok("summary: one line after the build", linesWith("created").length === 1, texts(els["log"].children));
    ok("summary: names the source", has(line.text, "Received from Figma:"), line.text);
    ok("summary: layers created", has(line.text, "5 layers created"), line.text);
    ok("summary: original vs generated images", has(line.text, "3 images (1 original, 2 generated)"), line.text);
    ok("summary: fallbacks by resolution",
       has(line.text, "fallbacks: 2 approximated / 1 rasterized / 1 skipped"), line.text);
    ok("summary: flagged when anything fell back", line.kind === "warn", line.kind);

    var ack = lastSent(sock);
    ok("receive: ack sent", ack.type === "ack" && ack.id === "t-1" && ack.ok === true && ack.layersCreated === 5,
       JSON.stringify(ack));
    ok("receive: ack carries the rebuild diagnostics", ack.diagnostics.length === 2);

    ok("card: worst first, arrival order within a rung", diagObjects() === "Video|Glow|Blur|Card", diagObjects());
    ok("card: tagged per resolution",
       diagTags() === "skipped/res res-skipped|rasterized/res res-rasterized|" +
                      "approximated/res res-approximated|approximated/res res-approximated", diagTags());
    ok("card: header total", els["diag-title"].textContent === "4 items needed a fallback",
       els["diag-title"].textContent);
    ok("card: header count per resolution",
       texts(els["diag-counts"].children) === "1 skipped|1 rasterized|2 approximated",
       texts(els["diag-counts"].children));
    ok("card: count chips coloured per resolution", els["diag-counts"].children[0].className === "cnt res-skipped");
});

// 6) A clean receive says so, and hides the card.
run("clean receive", function () {
    var sock = boot("PHXS", new MemoryStorage());
    deliver(sock, { type: "transfer", id: "t-2", document: {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        layers: [{ id: "v", name: "Box", type: "vector", frame: frame(0, 0), subpaths: [square()], fills: [], strokes: [] }]
    }});
    lastEval().cb(JSON.stringify({ ok: true, layersCreated: 1, message: "", diagnostics: [] }));
    var line = lastLog();
    ok("clean: singular layer", has(line.text, "Received from Illustrator: 1 layer created"), line.text);
    ok("clean: no images", has(line.text, "no images"), line.text);
    ok("clean: no fallbacks", has(line.text, "no fallbacks"), line.text);
    ok("clean: shown as ok", line.kind === "ok", line.kind);
    ok("clean: card hidden", els["diag-card"].hidden === true);
});

// 7) A failed build reports the error, not a summary.
run("failed receive", function () {
    var sock = boot("PHXS", new MemoryStorage());
    deliver(sock, { type: "transfer", id: "t-3", document: figmaDoc() });
    lastEval().cb(JSON.stringify({ ok: false, layersCreated: 0, message: "No document is open.", diagnostics: [] }));
    ok("failed: error logged", lastLog().kind === "err" && has(lastLog().text, "No document is open."), lastLog().text);
    ok("failed: no summary line", linesWith("created").length === 0);
    // Folded away is fine until something goes wrong; then it opens itself.
    ok("failed: the log opens itself", els["log-card"].open === true);
    ok("failed: ack says so", lastSent(sock).ok === false);
});

// 8) Push: sent untouched, then the ack is summarised.
run("push", function () {
    var sock = boot("ILST", new MemoryStorage());
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
    ok("push: button enabled", els["push"].disabled === false);

    var pushed = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 100, y: 50, width: 300, height: 100 },
        canvas: { width: 800, height: 600, name: "Artboard 1" },
        layers: [
            { id: "e", name: "Dot", type: "vector", frame: frame(0, 0), subpaths: [square()], fills: [], strokes: [],
              primitive: { kind: "ellipse", x: 0, y: 0, width: 50, height: 50 }, clip: clipPath() },
            { id: "p", name: "Placed", type: "image", frame: frame(60, 0), filePath: "C:\\art\\logo.png",
              isOriginalFile: true, pixelWidth: 50, pixelHeight: 50, clip: clipPath() },
            { id: "r", name: "Raster", type: "image", frame: frame(120, 0), filePath: "C:\\tmp\\r@2x.png",
              isOriginalFile: false, pixelWidth: 100, pixelHeight: 100 }
        ],
        diagnostics: [{ object: "Mesh", reason: "Mesh rasterised", resolution: "rasterized" }]
    };
    var pushedStr = JSON.stringify(pushed);
    files["C:/tmp/pushed/ir.json"] = { data: pushedStr, enc: "" };

    els["push"].fire("click");
    var call = lastEval();
    ok("push: reader run", has(call.script, "LazyLord.runRead("), call.script);
    ok("push: the reader is told where it is going", has(call.script, '"target":"aftereffects"'), call.script);
    call.cb(JSON.stringify({ ok: true, layerCount: 3, irPath: "C:/tmp/pushed/ir.json", message: "",
                            diagnostics: pushed.diagnostics }));

    var t = lastSent(sock);
    ok("push: transfer sent to the selected app", t.type === "transfer" && t.target === "aftereffects", JSON.stringify(t.target));
    // Intended change: the panel now attaches its options; nothing else is touched.
    ok("push: default options attached", t.document.options && t.document.options.layout === "split" &&
       t.document.options.hierarchy === "flatten", JSON.stringify(t.document.options));
    var sentDoc = JSON.parse(JSON.stringify(t.document));
    delete sentDoc.options;
    ok("push: otherwise sent untouched (canvas, clip, primitive)", JSON.stringify(sentDoc) === pushedStr);
    ok("push: sent line counts layers, no options note on the defaults",
       linesWith("Sent 3 layers to After Effects" + ELLIPSIS).length === 1, texts(els["log"].children));
    ok("push: busy while waiting", els["push"].disabled === true);

    deliver(sock, { type: "ack", id: "someone-else", from: "photoshop", ok: true, layersCreated: 9, diagnostics: [] });
    ok("push: unrelated acks ignored", linesWith("Rebuilt").length === 0);

    deliver(sock, { type: "ack", id: t.id, from: "aftereffects", ok: true, layersCreated: 3, diagnostics: [
        { object: "Blob", reason: "Unsupported effect", resolution: "skipped" },
        { object: "Odd", reason: "Something new", resolution: "mystery" }
    ]});
    var line = lastLog();
    ok("push summary: names the target", has(line.text, "Rebuilt in After Effects: 3 layers created"), line.text);
    ok("push summary: images from the sent document", has(line.text, "2 images (1 original, 1 generated)"), line.text);
    ok("push summary: read + ack fallbacks",
       has(line.text, "fallbacks: 0 approximated / 1 rasterized / 1 skipped / 1 other"), line.text);
    ok("push summary: flagged", line.kind === "warn", line.kind);
    ok("push: button free again", els["push"].disabled === false);

    ok("push card: worst first, unknown last", diagObjects() === "Blob|Mesh|Odd", diagObjects());
    ok("push card: unknown resolution shown as sent", has(diagTags(), "mystery/res res-mystery"), diagTags());
    ok("push card: counts include other", texts(els["diag-counts"].children) === "1 skipped|1 rasterized|1 other",
       texts(els["diag-counts"].children));

    // A failed ack is an error line, not a summary.
    els["push"].fire("click");
    lastEval().cb(JSON.stringify({ ok: true, layerCount: 3, irPath: "C:/tmp/pushed/ir.json", message: "",
                                  diagnostics: [] }));
    var t2 = lastSent(sock);
    deliver(sock, { type: "ack", id: t2.id, from: "unknown", ok: false,
                    message: "After Effects is not connected. Open the LazyLord panel there first." });
    ok("push failed: error logged", lastLog().kind === "err" && has(lastLog().text, "not connected"), lastLog().text);
    ok("push failed: no second summary", linesWith("Rebuilt").length === 1);
});

// 9) The sender of a declined transfer hears why, instead of timing out.
run("declined", function () {
    var sock = boot("AEFT", new MemoryStorage());
    peersMsg(sock, "welcome", ["aftereffects", "illustrator"]);
    files["C:/tmp/d/ir.json"] = { data: JSON.stringify(figmaDoc()), enc: "" };
    els["push"].fire("click");
    lastEval().cb(JSON.stringify({ ok: true, layerCount: 4, irPath: "C:/tmp/d/ir.json", message: "", diagnostics: [] }));
    var t = lastSent(sock);
    ok("declined: pushed to Illustrator", t.type === "transfer" && t.target === "illustrator", JSON.stringify(t.target));

    // Replay what the Illustrator panel sent in case 2, as the bridge would.
    var reply = JSON.parse(JSON.stringify(declinedAck));
    reply.id = t.id;
    deliver(sock, reply);
    ok("declined: the reason reaches the sender", lastLog().kind === "err" &&
       has(lastLog().text, "Auto-receive is off in the Illustrator LazyLord panel"), lastLog().text);
    ok("declined: button free at once", els["push"].disabled === false);
    fireTimer(20000);
    ok("declined: no timeout afterwards", linesWith("No response").length === 0, texts(els["log"].children));
});

// 10) A reply that outlasts the wait is still summarised, once.
run("late ack", function () {
    var sock = boot("ILST", new MemoryStorage());
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
    var doc = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 110, height: 50 },
        layers: [
            { id: "v", name: "Box", type: "vector", frame: frame(0, 0), subpaths: [square()], fills: [], strokes: [] },
            { id: "p", name: "Placed", type: "image", frame: frame(60, 0), filePath: "C:\\art\\logo.png",
              isOriginalFile: true, pixelWidth: 50, pixelHeight: 50 }
        ],
        diagnostics: [{ object: "Mesh", reason: "Mesh rasterised", resolution: "rasterized" }]
    };
    files["C:/tmp/late/ir.json"] = { data: JSON.stringify(doc), enc: "" };

    function pushOnce() {
        els["push"].fire("click");
        lastEval().cb(JSON.stringify({ ok: true, layerCount: 2, irPath: "C:/tmp/late/ir.json", message: "",
                                      diagnostics: doc.diagnostics }));
        return lastSent(sock);
    }

    var t1 = pushOnce();
    ok("late: timeout scheduled for 20 s", fireTimer(20000));
    var wait = lastLog();
    ok("late: the timeout says a result may still come", wait.kind === "warn" &&
       has(wait.text, "No response from After Effects after 20 s") && has(wait.text, "still be shown"), wait.text);
    ok("late: button free after the timeout", els["push"].disabled === false);

    deliver(sock, { type: "ack", id: t1.id, from: "aftereffects", ok: true, layersCreated: 2, diagnostics: [
        { object: "Blob", reason: "Unsupported effect", resolution: "skipped" }
    ]});
    var line = lastLog();
    ok("late: summary still logged", has(line.text, "Rebuilt in After Effects (late reply): 2 layers created"), line.text);
    ok("late: counts read + rebuild fallbacks", has(line.text, "1 image (1 original, 0 generated)") &&
       has(line.text, "fallbacks: 0 approximated / 1 rasterized / 1 skipped"), line.text);
    ok("late: flagged", line.kind === "warn", line.kind);
    ok("late: rebuild diagnostics reach the card", diagObjects() === "Blob|Mesh", diagObjects());

    deliver(sock, { type: "ack", id: t1.id, from: "aftereffects", ok: true, layersCreated: 2, diagnostics: [] });
    ok("late: a repeated ack is reported once", linesWith("late reply").length === 1, texts(els["log"].children));

    // A late reply while a newer push is waiting: logged, the card left alone.
    var t2 = pushOnce();
    fireTimer(20000);
    var t3 = pushOnce();
    ok("late: newer push in flight", els["push"].disabled === true);
    deliver(sock, { type: "ack", id: t2.id, from: "aftereffects", ok: false, message: "No document is open." });
    ok("late: late failure logged with its source", lastLog().kind === "err" &&
       has(lastLog().text, "Late reply from After Effects: No document is open."), lastLog().text);
    ok("late: newer push still waiting", els["push"].disabled === true);
    ok("late: card still shows the newer push", diagObjects() === "Mesh", diagObjects());
    deliver(sock, { type: "ack", id: t3.id, from: "aftereffects", ok: true, layersCreated: 2, diagnostics: [] });
    ok("late: newer push completes normally", has(lastLog().text, "Rebuilt in After Effects: 2 layers created"),
       lastLog().text);
    ok("late: its card is its own", diagObjects() === "Mesh", diagObjects());
});

// 11) Push options travel on the document; nested layers are counted.
run("push options", function () {
    var sock = boot("ILST", new MemoryStorage());
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
    choose("push-layout", "combine");
    choose("push-hierarchy", "groups");

    var outer = frame(60, 0);
    outer.opacity = 0.5;
    var grouped = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 110, height: 50 },
        layers: [
            { id: "v", name: "Box", type: "vector", frame: frame(0, 0), subpaths: [square()], fills: [], strokes: [] },
            { id: "g1", name: "Outer", type: "group", frame: outer, children: [
                { id: "p", name: "Placed", type: "image", frame: frame(60, 0), filePath: "C:\\art\\logo.png",
                  isOriginalFile: true, pixelWidth: 50, pixelHeight: 50 },
                { id: "g2", name: "Inner", type: "group", frame: frame(60, 0), clip: clipPath(), children: [
                    { id: "r", name: "Raster", type: "image", frame: frame(60, 0), filePath: "C:\\tmp\\r.png",
                      isOriginalFile: false, pixelWidth: 50, pixelHeight: 50 },
                    { id: "t", name: "Title", type: "text", frame: frame(60, 0), characters: "Hi",
                      fontFamily: "Arial", fontStyle: "Regular", fontSize: 12, color: { r: 0, g: 0, b: 0, a: 1 } }
                ]}
            ]}
        ],
        // A reader never writes options, but if one did the panel's choice wins.
        options: { layout: "split", hierarchy: "flatten" },
        diagnostics: []
    };
    var groupedStr = JSON.stringify(grouped);
    files["C:/tmp/grouped/ir.json"] = { data: groupedStr, enc: "" };

    els["push"].fire("click");
    // Changed while the host is still reading: the choice made at the click is sent.
    choose("push-layout", "split");
    // runRead's layerCount only sees the top level (2); the panel counts leaves.
    lastEval().cb(JSON.stringify({ ok: true, layerCount: 2, irPath: "C:/tmp/grouped/ir.json", message: "",
                                  diagnostics: [] }));

    var t = lastSent(sock);
    ok("push options: the click-time choice is sent", t.document.options && t.document.options.layout === "combine" &&
       t.document.options.hierarchy === "groups", JSON.stringify(t.document.options));
    var sentDoc = JSON.parse(JSON.stringify(t.document));
    var expected = JSON.parse(groupedStr);
    delete sentDoc.options;
    delete expected.options;
    ok("push options: groups, clip and everything else sent as read", JSON.stringify(sentDoc) === JSON.stringify(expected));
    ok("push options: sent line counts leaves and groups, and names the options",
       linesWith("Sent 4 layers (2 groups) to After Effects" + DOT + "Combine, Groups" + ELLIPSIS).length === 1,
       texts(els["log"].children));

    deliver(sock, { type: "ack", id: t.id, from: "aftereffects", ok: true, layersCreated: 3, diagnostics: [] });
    ok("push options: nested images counted in the summary", has(lastLog().text, "2 images (1 original, 1 generated)"),
       lastLog().text);

    // The next push uses the choice as it stands now.
    els["push"].fire("click");
    lastEval().cb(JSON.stringify({ ok: true, layerCount: 2, irPath: "C:/tmp/grouped/ir.json", message: "",
                                  diagnostics: [] }));
    var t2 = lastSent(sock);
    ok("push options: a later change applies to the next push", t2.id !== t.id &&
       t2.document.options.layout === "split" && t2.document.options.hierarchy === "groups",
       JSON.stringify(t2.document.options));
    ok("push options: only the non-default choice is named", has(lastLog().text, "After Effects" + DOT + "Groups" + ELLIPSIS),
       lastLog().text);

    // Exported data that is not a document frees the button instead of hanging it.
    files["C:/tmp/null/ir.json"] = { data: "null", enc: "" };
    deliver(sock, { type: "ack", id: t2.id, from: "aftereffects", ok: true, layersCreated: 3, diagnostics: [] });
    els["push"].fire("click");
    lastEval().cb(JSON.stringify({ ok: true, layerCount: 1, irPath: "C:/tmp/null/ir.json", message: "", diagnostics: [] }));
    ok("push options: a non-document export is an error", lastLog().kind === "err" &&
       has(lastLog().text, "carried no layers"), lastLog().text);
    ok("push options: nothing sent for it", lastSent(sock).id === t2.id);
    ok("push options: button free after it", els["push"].disabled === false);
});

// 12) Receive: images are materialised however deeply grouped, each to its own file.
run("nested receive", function () {
    var sock = boot("PHXS", new MemoryStorage());
    function img(id, b64) {
        return { id: id, name: "Image " + id, type: "image", frame: frame(0, 0), pngBase64: b64,
                 pixelWidth: 2, pixelHeight: 2 };
    }
    var doc = {
        version: "1.0", source: "figma", name: "Page", originSpace: "canvas",
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        options: { layout: "combine", hierarchy: "groups" },
        layers: [
            img("1:2", "AAAA"),
            { id: "g", name: "Frame", type: "group", frame: frame(0, 0), children: [
                img("1;2", "BBBB"),                                   // sanitises to the same name
                { id: "g2", name: "Inner", type: "group", frame: frame(0, 0), children: [
                    img("deep", "CCCC"),
                    img("DEEP", "DDDD"),                              // differs only in case
                    { id: "g3", name: "Empty", type: "group", frame: frame(0, 0) } // no children at all
                ]},
                { id: "orig", name: "Linked", type: "image", frame: frame(0, 0), filePath: "C:\\art\\photo.psd",
                  isOriginalFile: true, pixelWidth: 50, pixelHeight: 50 }
            ]}
        ]
    };
    var sentStr = JSON.stringify(doc);
    deliver(sock, { type: "transfer", id: "t-n", document: doc });

    ok("nested: receiving line counts every leaf and group, and names the sender's options",
       linesWith("Receiving 5 layers (3 groups) from Figma" + DOT + "Combine, Groups" + ELLIPSIS).length === 1,
       texts(els["log"].children));

    var ir = irFile();
    ok("nested: ir.json written", ir !== null);
    var built = JSON.parse(ir.file.data);
    var imgs = imagesIn(built.layers);
    ok("nested: every image reached", imgs.length === 5, String(imgs.length));

    var embedded = [imgs[0], imgs[1], imgs[2], imgs[3]];
    var data = ["AAAA", "BBBB", "CCCC", "DDDD"];
    var names = ["1_2.png", "1_2-2.png", "deep.png", "DEEP-2.png"];
    var allFiled = true, allNamed = true, allOwnBytes = true, seen = {}, distinct = true;
    for (var i = 0; i < embedded.length; i++) {
        var l = embedded[i];
        if (!l.filePath || l.pngBase64 !== undefined || l.isOriginalFile !== false) allFiled = false;
        if (!endsWith(l.filePath, names[i])) allNamed = false;
        if (!files[l.filePath] || files[l.filePath].data !== data[i] || files[l.filePath].enc !== "Base64") allOwnBytes = false;
        var key = String(l.filePath).toLowerCase();
        if (seen[key]) distinct = false;
        seen[key] = true;
    }
    ok("nested: every embedded image, at any depth, has a file and no bytes left", allFiled, ir.file.data);
    ok("nested: colliding names get their own file", allNamed && distinct,
       embedded[0].filePath + " " + embedded[1].filePath + " " + embedded[2].filePath + " " + embedded[3].filePath);
    ok("nested: no image overwrote another", allOwnBytes);
    ok("nested: the user's own file untouched", imgs[4].filePath === "C:\\art\\photo.psd" && imgs[4].isOriginalFile === true);

    // Everything else is byte-identical: replay the only permitted edits.
    var expected = JSON.parse(sentStr);
    var exp = imagesIn(expected.layers);
    for (var j = 0; j < embedded.length; j++) {
        exp[j].filePath = embedded[j].filePath;
        exp[j].isOriginalFile = false;
        delete exp[j].pngBase64;
    }
    ok("nested: groups, the empty group and options pass through", JSON.stringify(expected) === ir.file.data);

    lastEval().cb(JSON.stringify({ ok: true, layersCreated: 5, message: "", diagnostics: [] }));
    ok("nested: summary counts images inside groups", has(lastLog().text, "5 layers created") &&
       has(lastLog().text, "5 images (1 original, 4 generated)"), lastLog().text);
});

// 13) Receive: awkward ids, missing ids and junk entries inside groups.
run("odd ids", function () {
    var sock = boot("PHXS", new MemoryStorage());
    function img(id, b64) {
        var l = { name: "Image", type: "image", frame: frame(0, 0), pngBase64: b64, pixelWidth: 2, pixelHeight: 2 };
        if (id !== null) l.id = id;
        return l;
    }
    var doc = {
        version: "1.0", source: "figma", name: "Page", originSpace: "canvas",
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        layers: [
            img(null, "AAAA"),                                        // no id at all
            { id: "g", name: "Frame", type: "group", frame: frame(0, 0), children: [
                img(null, "BBBB"),
                // Special as object keys in Chromium; JScript has no __proto__
                // magic, so here these only pin the names they must get.
                img("__proto__", "CCCC"),
                img("__proto__", "DDDD"),
                img("constructor", "EEEE"),
                null,                                                 // malformed entry: dropped, with a diagnostic
                { id: "gen", name: "Rendered", type: "image", frame: frame(0, 0),
                  filePath: "C:\\tmp\\lazylord\\x\\gen.png", isOriginalFile: false, pixelWidth: 2, pixelHeight: 2 }
            ]}
        ]
    };
    var sentStr = JSON.stringify(doc);
    var threw = null;
    try { deliver(sock, { type: "transfer", id: "t-odd", document: doc }); } catch (e) { threw = e.message || String(e); }
    ok("odd ids: a null entry in a group does not break the receive", threw === null, threw);
    ok("odd ids: the null entry is not counted",
       linesWith("Receiving 6 layers (1 group) from Figma" + ELLIPSIS).length === 1, texts(els["log"].children));

    var ir = irFile();
    ok("odd ids: ir.json written", ir !== null);
    var built = JSON.parse(ir.file.data);
    var imgs = imagesIn(built.layers);
    var names = ["image.png", "image-2.png", "__proto__.png", "__proto__-2.png", "constructor.png"];
    var data = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"];
    var allNamed = true, allOwnBytes = true, got = [];
    for (var i = 0; i < names.length; i++) {
        got.push(imgs[i].filePath);
        if (!endsWith(imgs[i].filePath, names[i]) || imgs[i].pngBase64 !== undefined) allNamed = false;
        if (!files[imgs[i].filePath] || files[imgs[i].filePath].data !== data[i]) allOwnBytes = false;
    }
    ok("odd ids: missing and awkward ids each get their own file", allNamed, got.join(" "));
    ok("odd ids: no image overwrote another", allOwnBytes);
    ok("odd ids: a generated file already on disk passes through", imgs[5].filePath === "C:\\tmp\\lazylord\\x\\gen.png" &&
       imgs[5].isOriginalFile === false && !files[imgs[5].filePath], JSON.stringify(imgs[5]));

    // The null never reaches the builder: every host helper reads .type on
    // each entry, so one null would fail the whole rebuild.
    ok("odd ids: the written ir.json holds no null entry", allEntriesAreLayers(built.layers) &&
       built.layers[1].children.length === 5, ir.file.data);
    var walkErr = hostWalk(JSON.parse(ir.file.data));
    ok("odd ids: the host helpers walk the written ir.json", walkErr === null, walkErr);
    ok("odd ids: the dropped entry is on the card", diagObjects() === "(unnamed)" &&
       diagTags() === "skipped/res res-skipped", diagObjects() + " " + diagTags());

    // Replay the permitted edits: the embedded images, and the null left out.
    var expected = JSON.parse(sentStr);
    var exp = imagesIn(expected.layers);
    for (var j = 0; j < names.length; j++) {
        exp[j].filePath = imgs[j].filePath;
        exp[j].isOriginalFile = false;
        delete exp[j].pngBase64;
    }
    expected.layers[1].children.splice(4, 1);
    ok("odd ids: nothing else changed", JSON.stringify(expected) === ir.file.data);

    lastEval().cb(JSON.stringify({ ok: true, layersCreated: 6, message: "", diagnostics: [] }));
    ok("odd ids: summary counts every nested image", has(lastLog().text, "6 images (0 original, 6 generated)"),
       lastLog().text);
    ok("odd ids: summary counts the dropped entry", has(lastLog().text, "0 approximated / 0 rasterized / 1 skipped"),
       lastLog().text);
    var ack = lastSent(sock);
    ok("odd ids: the sender is told what was left out", ack.type === "ack" && ack.ok === true &&
       ack.diagnostics.length === 1 && ack.diagnostics[0].resolution === "skipped" &&
       ack.diagnostics[0].reason === 'Entry 5 of the group "Frame" was empty, not a layer, so it was left out',
       JSON.stringify(ack.diagnostics));
});

// 14) Receive: malformed entries anywhere in the tree are left out, each with
// a "skipped" diagnostic, so what is written is something every builder can walk.
run("malformed", function () {
    var sock = boot("PHXS", new MemoryStorage());
    var doc = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        // A real offset, so applyOrigin walks (and shifts) the whole tree.
        bounds: { x: 5, y: 7, width: 50, height: 50 },
        layers: [
            null,
            { id: "v", name: "Box", type: "vector", frame: frame(0, 0), subpaths: [square()], fills: [], strokes: [] },
            "junk",
            { id: "o", name: "Outer", type: "group", frame: frame(0, 0), children: [
                7,
                { id: "in", type: "group", frame: frame(0, 0), children: [
                    [1, 2],
                    { id: "p", name: "Pic", type: "image", frame: frame(0, 0), pngBase64: "QUJD",
                      pixelWidth: 2, pixelHeight: 2 },
                    true
                ]},
                { id: "b", name: "Broken", type: "group", frame: frame(0, 0), children: "abc" },
                { id: "e", name: "Empty", type: "group", frame: frame(0, 0) }
            ]}
        ],
        diagnostics: [{ object: "Glow", reason: "Effect dropped", resolution: "approximated" }]
    };
    var sentStr = JSON.stringify(doc);
    var threw = null;
    try { deliver(sock, { type: "transfer", id: "t-bad", document: doc }); } catch (e) { threw = e.message || String(e); }
    ok("malformed: the receive goes on", threw === null, threw);
    // Before: "junk", 7, [1,2], true and each letter of "abc" counted as layers.
    ok("malformed: only real layers are counted",
       linesWith("Receiving 2 layers (4 groups) from Illustrator" + ELLIPSIS).length === 1, texts(els["log"].children));

    var ir = irFile();
    ok("malformed: ir.json written", ir !== null);
    var built = JSON.parse(ir.file.data);
    ok("malformed: every list in ir.json holds only layers", allEntriesAreLayers(built.layers), ir.file.data);
    var walkErr = hostWalk(JSON.parse(ir.file.data));
    ok("malformed: the host helpers walk the written ir.json", walkErr === null, walkErr);
    ok("malformed: two leaves survive for the builder", HELPERS_ERROR === null &&
       LazyLord.flattenLayers(JSON.parse(ir.file.data).layers).length === 2, HELPERS_ERROR);

    // Replay the permitted edits on what was sent: entries out, the broken
    // group emptied, the embedded image materialised. The empty group (no
    // children at all) is a valid group and is kept as it was.
    var expected = JSON.parse(sentStr);
    expected.layers.splice(2, 1);
    expected.layers.splice(0, 1);
    var outer = expected.layers[1];
    outer.children.splice(0, 1);
    var inner = outer.children[0];
    inner.children = [inner.children[1]];
    outer.children[1].children = [];
    var pic = built.layers[1].children[0].children[0];
    inner.children[0].filePath = pic.filePath;
    inner.children[0].isOriginalFile = false;
    delete inner.children[0].pngBase64;
    ok("malformed: nothing else changed", JSON.stringify(expected) === ir.file.data, ir.file.data);
    ok("malformed: the image inside still materialised", endsWith(pic.filePath, "p.png") && files[pic.filePath] &&
       files[pic.filePath].data === "QUJD", pic.filePath);

    var reasons = [
        "Top-level entry 1 was empty, not a layer, so it was left out",
        "Top-level entry 3 was text, not a layer, so it was left out",
        'Entry 1 of the group "Outer" was a number, not a layer, so it was left out',
        'Entry 1 of the group "in" was a list, not a layer, so it was left out',
        'Entry 3 of the group "in" was a true/false value, not a layer, so it was left out',
        "The group's contents were text, not a list of layers, so it arrives empty"
    ];
    ok("malformed: shown straight away, the sender's own fallback kept",
       diagObjects() === "(unnamed)|(unnamed)|(unnamed)|(unnamed)|(unnamed)|Broken|Glow", diagObjects());

    lastEval().cb(JSON.stringify({ ok: true, layersCreated: 2, message: "", diagnostics: [
        { object: "Box", reason: "Stroke approximated", resolution: "approximated" }
    ]}));
    var ack = lastSent(sock);
    var got = [];
    for (var i = 0; ack.diagnostics && i < ack.diagnostics.length; i++) got.push(ack.diagnostics[i].reason);
    ok("malformed: the ack carries each drop, then the builder's own", ack.ok === true &&
       got.join("|") === reasons.join("|") + "|Stroke approximated", got.join("|"));
    ok("malformed: drops are skipped", ack.diagnostics[0].resolution === "skipped" &&
       ack.diagnostics[5].resolution === "skipped" && ack.diagnostics[5].object === "Broken");
    ok("malformed: the card lists each once, with the rebuild's",
       diagObjects() === "(unnamed)|(unnamed)|(unnamed)|(unnamed)|(unnamed)|Broken|Glow|Box", diagObjects());
    ok("malformed: summary counts every fallback",
       has(lastLog().text, "fallbacks: 2 approximated / 0 rasterized / 6 skipped"), lastLog().text);

    // A failed build still tells the sender what was left out.
    sock = boot("PHXS", new MemoryStorage());
    deliver(sock, { type: "transfer", id: "t-bad2", document: JSON.parse(sentStr) });
    lastEval().cb(JSON.stringify({ ok: false, layersCreated: 0, message: "No document is open.", diagnostics: [] }));
    ack = lastSent(sock);
    ok("malformed: a failed build's ack still lists the drops", ack.ok === false && ack.diagnostics.length === 6,
       JSON.stringify(ack));

    // A layer list that is not a list at all is refused before any builder runs.
    sock = boot("PHXS", new MemoryStorage());
    var evalsBefore = evalCalls.length;
    deliver(sock, { type: "transfer", id: "t-bad3", document: { version: "1.0", source: "figma", name: "X",
        originSpace: "canvas", bounds: { x: 0, y: 0, width: 1, height: 1 }, layers: "abc" } });
    ack = lastSent(sock);
    ok("malformed: a non-list layers field gets a failed ack", ack.type === "ack" && ack.id === "t-bad3" &&
       ack.ok === false && ack.message === "The transfer carried no layers.", JSON.stringify(ack));
    ok("malformed: and no builder call", evalCalls.length === evalsBefore && irFile() === null);
});

// 15) index.html: the options sit folded inside the push card, defaults first.
run("markup", function () {
    var card = HTML_SRC.indexOf('id="push-card"');
    var opts = HTML_SRC.indexOf('id="push-options"');
    var nextCard = HTML_SRC.indexOf('class="card"', card + 1);
    ok("markup: options live in the push card", card >= 0 && opts > card && (nextCard < 0 || opts < nextCard));
    var tag = /<details[^>]*id="push-options"[^>]*>/.exec(HTML_SRC);
    ok("markup: a disclosure, closed until needed", tag !== null && !/\sopen[\s>=]/.test(tag[0]), tag && tag[0]);
    ok("markup: the folded label carries the note", /<summary[^>]*>[^<]*Options[\s\S]*?id="push-opts-note"[\s\S]*?<\/summary>/
       .test(HTML_SRC));
    ok("markup: Layout offers Split then Combine", LAYOUT_VALUES.join("|") === "split|combine", LAYOUT_VALUES.join("|"));
    ok("markup: Hierarchy offers Flatten, Groups, then Precomps", HIERARCHY_VALUES.join("|") === "flatten|groups|precomps",
       HIERARCHY_VALUES.join("|"));
    ok("markup: both selects are labelled", has(HTML_SRC, '<label for="push-layout">Layout</label>') &&
       has(HTML_SRC, '<label for="push-hierarchy">Hierarchy</label>'));

    // The log reads as clutter until it is needed, so it folds away too.
    var logTag = /<details[^>]*id="log-card"[^>]*>/.exec(HTML_SRC);
    ok("markup: the log is folded away", logTag !== null && !/\sopen[\s>=]/.test(logTag[0]), logTag && logTag[0]);
    ok("markup: its newest line shows on the summary",
       /<summary[^>]*>[^<]*Log[\s\S]*?id="log-last"[\s\S]*?<\/summary>/.test(HTML_SRC));
    // The footer used to print the bridge address; that is diagnostic, and the
    // panel is the only place a user learns who wrote it.
    ok("markup: the footer credits the author, and links to the site",
       /<footer[\s\S]*?id="author"[^>]*>Raisul Sohan<\/a>[\s\S]*?<\/footer>/.test(HTML_SRC));
    ok("markup: the bridge address moved to the connection chip",
       !/<footer[\s\S]*?7878[\s\S]*?<\/footer>/.test(HTML_SRC) &&
       /<div id="conn"[^>]*title="[^"]*7878/.test(HTML_SRC));
});

// 12) Phase 3: the Existing / Keyframes options on the push card.
run("update options", function () {
    var store = new MemoryStorage();
    var sock = boot("ILST", store);
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);

    // index.html offers exactly the values the builders understand.
    ok("markup: Existing offers add and update",
       EXISTING_VALUES.length === 2 && EXISTING_VALUES[0] === "add" && EXISTING_VALUES[1] === "update",
       EXISTING_VALUES.join(","));
    ok("markup: Keyframes offers auto and always",
       KEYFRAME_VALUES.length === 2 && KEYFRAME_VALUES[0] === "auto" && KEYFRAME_VALUES[1] === "always",
       KEYFRAME_VALUES.join(","));
    ok("markup: both new selects are labelled",
       has(HTML_SRC, '<label for="push-existing">Existing</label>') &&
       has(HTML_SRC, '<label for="push-keyframes">Keyframes</label>'));

    // Keyframes only mean anything while updating, so the row follows Existing.
    ok("keyframes row: hidden while adding", els["push-keyframes-row"].hidden === true);
    ok("note: nothing while everything is default", noteText() === "", noteText());
    ok("hint: empty while adding", els["push-opts-hint"].textContent === "",
       els["push-opts-hint"].textContent);

    choose("push-existing", "update");
    ok("keyframes row: shown once updating", els["push-keyframes-row"].hidden === false);
    ok("note: Update alone", noteText() === "Update", noteText());
    ok("hint: says Layout and Hierarchy are ignored",
       has(els["push-opts-hint"].textContent, "Layout and Hierarchy are ignored"),
       els["push-opts-hint"].textContent);

    choose("push-keyframes", "always");
    ok("note: Update and Always key", noteText() === "Update, Always key", noteText());

    var saved = JSON.parse(store.getItem("lazylord.prefs.illustrator"));
    ok("prefs: Existing stored with the host's other prefs", saved && saved.existing === "update",
       store.getItem("lazylord.prefs.illustrator"));
    ok("prefs: Keyframes stored", saved && saved.keyframes === "always",
       store.getItem("lazylord.prefs.illustrator"));

    choose("push-existing", "add");
    ok("keyframes row: hidden again", els["push-keyframes-row"].hidden === true);
    ok("note: Always key is not named while adding", noteText() === "", noteText());
});

// 13) The choices are restored per host, and travel on doc.options.
run("update options travel", function () {
    var store = new MemoryStorage();
    store.setItem("lazylord.prefs.illustrator",
        JSON.stringify({ existing: "update", keyframes: "always", target: "aftereffects" }));
    var sock = boot("ILST", store);
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);

    ok("prefs: Existing restored", els["push-existing"].value === "update", els["push-existing"].value);
    ok("prefs: Keyframes restored", els["push-keyframes"].value === "always", els["push-keyframes"].value);
    ok("prefs: the keyframes row is shown again", els["push-keyframes-row"].hidden === false);
    ok("prefs: the folded label is restored too", noteText() === "Update, Always key", noteText());

    var ir = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        layers: [{ id: "v", name: "Box", type: "vector", frame: frame(0, 0), subpaths: [square()],
                   fills: [], strokes: [] }],
        diagnostics: []
    };
    files["C:/tmp/upd/ir.json"] = { data: JSON.stringify(ir), enc: "" };

    els["push"].fire("click");
    lastEval().cb(JSON.stringify({ ok: true, layerCount: 1, irPath: "C:/tmp/upd/ir.json", message: "", diagnostics: [] }));

    var sent = lastSent(sock);
    ok("sent: Update reaches the builder", sent.document.options.existing === "update",
       JSON.stringify(sent.document.options));
    ok("sent: so does Always", sent.document.options.keyframes === "always",
       JSON.stringify(sent.document.options));
    ok("sent: On conflict defaults to Overwrite", sent.document.options.conflict === "overwrite",
       JSON.stringify(sent.document.options));
});

// 13a) On conflict: shown while updating, stored, named on the folded label, sent.
run("on conflict", function () {
    var store = new MemoryStorage();
    var sock = boot("ILST", store);
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
    ok("conflict: offers Overwrite then Keep my edits", CONFLICT_VALUES.join(",") === "overwrite,keep", CONFLICT_VALUES.join(","));
    ok("conflict: labelled", has(HTML_SRC, '<label for="push-conflict">On conflict</label>'));
    ok("conflict: hidden while adding", els["push-conflict-row"].hidden === true);
    choose("push-existing", "update");
    ok("conflict: shown once updating", els["push-conflict-row"].hidden === false);
    choose("push-conflict", "keep");
    ok("conflict: named on the folded label", noteText() === "Update, Keep edits", noteText());
    var saved = JSON.parse(store.getItem("lazylord.prefs.illustrator"));
    ok("conflict: stored", saved && saved.conflict === "keep", store.getItem("lazylord.prefs.illustrator"));

    var again = boot("ILST", store);
    peersMsg(again, "welcome", ["illustrator", "aftereffects"]);
    ok("conflict: restored", els["push-conflict"].value === "keep", els["push-conflict"].value);
    var ir = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        layers: [{ id: "v", name: "Box", type: "vector", frame: frame(0, 0), subpaths: [square()], fills: [], strokes: [] }],
        diagnostics: []
    };
    files["C:/tmp/cf/ir.json"] = { data: JSON.stringify(ir), enc: "" };
    els["push"].fire("click");
    lastEval().cb(JSON.stringify({ ok: true, layerCount: 1, irPath: "C:/tmp/cf/ir.json", message: "", diagnostics: [] }));
    var sent = lastSent(again);
    ok("conflict: Keep my edits reaches the builder", sent && sent.document.options.conflict === "keep",
       sent && JSON.stringify(sent.document.options));
});

// 13b) Smart diff: while updating, only what changed since the last send goes out.
run("smart diff", function () {
    var store = new MemoryStorage();
    store.setItem("lazylord.prefs.illustrator", JSON.stringify({ existing: "update", target: "aftereffects" }));
    var sock = boot("ILST", store);
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
    ok("diff: the Only what changed switch shows while updating", els["push-only-changed-row"] ?
       els["push-only-changed-row"].hidden === false : true);

    function art(boxX) {
        return {
            version: "1.0", source: "illustrator", sourceKey: "doc-1", name: "Art", originSpace: "document",
            bounds: { x: 0, y: 0, width: 50, height: 50 },
            layers: [
                { id: "a", name: "A", type: "vector", frame: frame(boxX, 0), subpaths: [square()], fills: [], strokes: [] },
                { id: "b", name: "B", type: "vector", frame: frame(0, 20), subpaths: [square()], fills: [], strokes: [] }
            ],
            diagnostics: []
        };
    }
    function push(doc) {
        files["C:/tmp/diff/ir.json"] = { data: JSON.stringify(doc), enc: "" };
        var before = sock.sent.length;
        els["push"].fire("click");
        lastEval().cb(JSON.stringify({ ok: true, layerCount: 2, irPath: "C:/tmp/diff/ir.json", message: "", diagnostics: [] }));
        return sock.sent.length > before ? lastSent(sock) : null;
    }

    var first = push(art(0));
    ok("diff: the first send carries everything", first && first.document.layers.length === 2);
    deliver(sock, { type: "ack", id: first.id, from: "aftereffects", ok: true, layersCreated: 2 });
    ok("diff: the destination's fingerprints are kept after a successful send",
       /"a":/.test(store.getItem("lazylord.sent.illustrator") || ""), store.getItem("lazylord.sent.illustrator"));

    var again = push(art(0));
    ok("diff: nothing changed, nothing sent", again === null && linesWith("Nothing changed").length === 1, texts(els["log"].children));

    var moved = push(art(10));
    ok("diff: only the changed layer is sent", moved && moved.document.layers.length === 1 && moved.document.layers[0].id === "a",
       moved && JSON.stringify(moved.document.layers));
    ok("diff: the unchanged one is counted in the log", linesWith("1 unchanged layer not sent again").length === 1, texts(els["log"].children));

    // Without an ack the fingerprints are not taken: a failed send is resent in full.
    deliver(sock, { type: "ack", id: moved.id, from: "aftereffects", ok: false, message: "No comp open." });
    var retry = push(art(10));
    ok("diff: after a failed send the change is sent again", retry && retry.document.layers.length === 1 && retry.document.layers[0].id === "a");
    deliver(sock, { type: "ack", id: retry.id, from: "aftereffects", ok: true, layersCreated: 0 });

    // Switched off, everything goes again.
    els["push-only-changed"].checked = false;
    var all = push(art(10));
    ok("diff: switched off, everything is sent", all && all.document.layers.length === 2);
});

// 13c) Live: poll a stamp, send what changed as an update, stop cleanly.
// Live into Figma: each change is held there until Update on canvas, then remembered.
run("live to figma", function () {
    var store = new MemoryStorage();
    store.setItem("lazylord.prefs.illustrator", JSON.stringify({ target: "figma" }));
    var sock = boot("ILST", store);
    peersMsg(sock, "welcome", ["illustrator", "figma"]);
    function art(boxX) {
        return {
            version: "1.0", source: "illustrator", sourceKey: "doc-F", name: "Art", originSpace: "document",
            canvas: { width: 100, height: 100 }, bounds: { x: 0, y: 0, width: 50, height: 50 },
            layers: [
                { id: "a", name: "A", type: "vector", frame: frame(boxX, 0), subpaths: [square()], fills: [], strokes: [] },
                { id: "b", name: "B", type: "vector", frame: frame(0, 20), subpaths: [square()], fills: [], strokes: [] }
            ],
            diagnostics: []
        };
    }
    function stamp(st, doc) {
        var call = lastEval();
        if (!call || call.script !== "LazyLord.liveStamp()") return "no poll";
        var before = sock.sent.length, evals = evalCalls.length;
        call.cb(st);
        if (doc && evalCalls.length > evals) {
            files["C:/tmp/livef/ir.json"] = { data: JSON.stringify(doc), enc: "" };
            lastEval().cb(JSON.stringify({ ok: true, layerCount: 2, irPath: "C:/tmp/livef/ir.json", message: "", diagnostics: [] }));
        }
        return sock.sent.length > before ? lastSent(sock) : null;
    }
    function sentMap() { return store.getItem("lazylord.sent.illustrator") || ""; }

    els["push-live"].checked = true;
    els["push-live"].fire("change");
    ok("live to figma: allowed", els["push-live"].checked === true &&
       linesWith("Live: changes to the selection are sent to Figma").length === 1, texts(els["log"].children));
    var first = stamp("s1", art(0));
    ok("live to figma: the first change goes", first && first.target === "figma" && first.document.layers.length === 2);
    deliver(sock, { type: "ack", id: first.id, from: "figma", ok: true, staged: true, layersCreated: 0 });
    ok("live to figma: held in Figma, said once, nothing remembered as sent",
       linesWith("changes wait in Figma until Update on canvas").length === 1 && sentMap() === "", sentMap());

    fireTimer(LIVE_POLL);
    ok("live to figma: the same state is not held twice", stamp("s2", art(0)) === null);
    fireTimer(LIVE_POLL);
    var moved = stamp("s3", art(10));
    ok("live to figma: a change carries all that Figma has not applied", moved && moved.document.layers.length === 2,
       moved && JSON.stringify(moved.document.layers));
    deliver(sock, { type: "ack", id: moved.id, from: "figma", ok: true, staged: true, layersCreated: 0 });
    ok("live to figma: still said only once", linesWith("changes wait in Figma until Update on canvas").length === 1);

    // Update on canvas pressed in Figma: its result comes under the same id.
    deliver(sock, { type: "ack", id: moved.id, from: "figma", ok: true, layersCreated: 0, layersUpdated: 2 });
    ok("live to figma: applied, reported, and now remembered", linesWith("Figma applied the Live changes").length === 1 &&
       sentMap().indexOf("doc-F") >= 0, texts(els["log"].children));
    fireTimer(LIVE_POLL);
    var next = stamp("s4", art(20));
    ok("live to figma: after that, only what changed goes", next && next.document.layers.length === 1 && next.document.layers[0].id === "a",
       next && JSON.stringify(next.document.layers));
});

run("live", function () {
    var store = new MemoryStorage();
    // Adding, to a new document: Live sends updates into the open one anyway.
    store.setItem("lazylord.prefs.illustrator", JSON.stringify({ existing: "add", destination: "page", target: "aftereffects" }));
    var sock = boot("ILST", store);
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);

    function art(boxX) {
        return {
            version: "1.0", source: "illustrator", sourceKey: "doc-L", name: "Art", originSpace: "document",
            canvas: { width: 100, height: 100 }, bounds: { x: 0, y: 0, width: 50, height: 50 },
            layers: [
                { id: "a", name: "A", type: "vector", frame: frame(boxX, 0), subpaths: [square()], fills: [], strokes: [] },
                { id: "b", name: "B", type: "vector", frame: frame(0, 20), subpaths: [square()], fills: [], strokes: [] }
            ],
            diagnostics: []
        };
    }
    /** The host answers the stamp poll, then (if a read follows) the read. */
    function stamp(s, doc) {
        var call = lastEval();
        if (!call || call.script !== "LazyLord.liveStamp()") return "no poll";
        var before = sock.sent.length, evals = evalCalls.length;
        call.cb(s);
        if (doc && evalCalls.length > evals) {
            files["C:/tmp/live/ir.json"] = { data: JSON.stringify(doc), enc: "" };
            lastEval().cb(JSON.stringify({ ok: true, layerCount: 2, irPath: "C:/tmp/live/ir.json", message: "", diagnostics: [] }));
        }
        return sock.sent.length > before ? lastSent(sock) : null;
    }

    els["push-live"].checked = true;
    els["push-live"].fire("change");
    ok("live: says it is on", linesWith("Live: changes to the selection are sent to After Effects").length === 1, texts(els["log"].children));
    var first = stamp("s1", art(0));
    ok("live: the first send carries everything", first && first.document.layers.length === 2, first && JSON.stringify(first.document.layers));
    ok("live: as an update into the open document", first && first.document.options.existing === "update" &&
       first.document.options.destination === "active", first && JSON.stringify(first.document.options));
    fireTimer(LIVE_POLL);
    ok("live: no poll while the send is under way", lastEval().script !== "LazyLord.liveStamp()", lastEval().script);
    deliver(sock, { type: "ack", id: first.id, from: "aftereffects", ok: true, layersCreated: 2 });
    ok("live: its sends stay out of the history", !store.getItem("lazylord.history.illustrator"), store.getItem("lazylord.history.illustrator"));

    fireTimer(LIVE_POLL);
    var same = stamp("s1", art(0));
    ok("live: an unchanged stamp reads nothing", same === null && lastEval().script === "LazyLord.liveStamp()");
    fireTimer(LIVE_POLL);
    var noop = stamp("s2", art(0));
    ok("live: a stamp that moved without a real change sends nothing, quietly", noop === null && linesWith("Nothing changed").length === 0,
       texts(els["log"].children));
    fireTimer(LIVE_POLL);
    var moved = stamp("s3", art(10));
    ok("live: a change sends just that layer", moved && moved.document.layers.length === 1 && moved.document.layers[0].id === "a",
       moved && JSON.stringify(moved.document.layers));
    ok("live: logged as a live send", linesWith("Live: sent 1 layer to After Effects").length === 1, texts(els["log"].children));
    deliver(sock, { type: "ack", id: moved.id, from: "aftereffects", ok: true, layersCreated: 0, layersUpdated: 1 });

    fireTimer(LIVE_POLL);
    ok("live: nothing selected sends nothing", stamp("", art(10)) === null);

    els["push-live"].checked = false;
    els["push-live"].fire("change");
    ok("live: turned off", linesWith("Live is off.").length === 1, texts(els["log"].children));
    var evals = evalCalls.length;
    fireTimer(LIVE_POLL);
    ok("live: no more polls once off", evalCalls.length === evals);

    // The destination leaving stops it.
    els["push-live"].checked = true;
    els["push-live"].fire("change");
    stamp("s9", art(10));
    peersMsg(sock, "peers", ["illustrator"]);
    fireTimer(LIVE_POLL);
    ok("live: stops when the destination disconnects", els["push-live"].checked === false &&
       linesWith("Live stopped: the destination app disconnected").length === 1, texts(els["log"].children));
});

// 13d) What the in-depth review found: Live, delivery, reconnect, paths.
run("live and delivery fixes", function () {
    var ir = {
        version: "1.0", source: "illustrator", sourceKey: "doc-F", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        layers: [{ id: "a", name: "A", type: "vector", frame: frame(0, 0), subpaths: [square()], fills: [], strokes: [] }],
        diagnostics: []
    };
    function answerRead(sock) {
        files["C:/tmp/fix/ir.json"] = { data: JSON.stringify(ir), enc: "" };
        lastEval().cb(JSON.stringify({ ok: true, layerCount: 1, irPath: "C:/tmp/fix/ir.json", message: "", diagnostics: [] }));
    }

    // Photoshop updates what it drew now (layer XMP), so Live reaches it too.
    var store = new MemoryStorage();
    store.setItem("lazylord.prefs.illustrator", JSON.stringify({ target: "photoshop" }));
    var sock = boot("ILST", store);
    peersMsg(sock, "welcome", ["illustrator", "photoshop"]);
    els["push-live"].checked = true;
    els["push-live"].fire("change");
    ok("live: Photoshop can be kept in step", els["push-live"].checked === true &&
       linesWith("Live: changes to the selection are sent to Photoshop").length === 1, texts(els["log"].children));
    els["push-live"].checked = false;
    els["push-live"].fire("change");

    // A failed live send is tried again at the next poll, with the flag the receiver reads.
    store = new MemoryStorage();
    store.setItem("lazylord.prefs.illustrator", JSON.stringify({ target: "aftereffects" }));
    sock = boot("ILST", store);
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
    els["push-live"].checked = true;
    els["push-live"].fire("change");
    lastEval().cb("s1");
    answerRead(sock);
    var t1 = lastSent(sock);
    ok("live: the send says it is live", t1 && t1.document.options.live === true, t1 && JSON.stringify(t1.document.options));
    deliver(sock, { type: "ack", id: t1.id, from: "aftereffects", ok: false, message: "Busy" });
    fireTimer(LIVE_POLL);
    lastEval().cb("s1"); // nothing changed since, but the last one did not arrive
    ok("live: a failed send is read again", lastEval().script.indexOf("LazyLord.runRead(") === 0, lastEval().script);
    answerRead(sock);
    ok("live: and sent again", lastSent(sock).id !== t1.id);

    // Pressing Send while a send is under way does nothing.
    var count = sock.sent.length, evals = evalCalls.length;
    els["push"].fire("click");
    ok("send: never two at once", sock.sent.length === count && evalCalls.length === evals);

    // Bridge gone: said at once, the button freed, nothing pretended.
    sock = boot("ILST", new MemoryStorage());
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
    sock.readyState = 3;
    els["push"].fire("click");
    answerRead(sock);
    ok("send: without the bridge nothing is claimed as sent", linesWith("Not connected to the other apps").length === 1 &&
       linesWith("Sent 1 layer").length === 0 && els["push"].disabled === false, texts(els["log"].children));

    // Reconnect lets the old socket go without it scheduling a reconnect of its own.
    sock = boot("ILST", new MemoryStorage());
    var first = sockets[0];
    els["reconnect"].fire("click");
    ok("reconnect: a new socket, and the old one's close is ignored", sockets.length === 2 && first.onclose === null);

    // A transfer id off the network cannot name a folder of its own.
    sock = boot("AEFT", new MemoryStorage());
    peersMsg(sock, "welcome", ["aftereffects", "illustrator"]);
    var img = { version: "1.0", source: "figma", name: "X", bounds: { x: 0, y: 0, width: 1, height: 1 },
                layers: [{ id: "i", name: "I", type: "image", frame: frame(0, 0), pngBase64: "AAAA" }],
                options: { live: true } };
    deliver(sock, { type: "transfer", id: "../../../Users/Public/evil", document: img });
    var bad = false;
    for (var p in files) if (files.hasOwnProperty(p) && p.indexOf("..") >= 0) bad = true;
    ok("paths: the id is made safe before it names a folder", !bad);
    lastEval().cb(JSON.stringify({ ok: true, layersCreated: 1, message: "", diagnostics: [] }));
    ok("receive: a live update stays out of the history", !store.getItem("lazylord.history.aftereffects") &&
       els["history-count"].textContent === "", els["history-count"].textContent);
});

// 14) A build that updated layers reports both halves in its one line.
run("update summary", function () {
    var sock = boot("AEFT", new MemoryStorage());
    peersMsg(sock, "welcome", ["aftereffects", "illustrator"]);

    var ir = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        layers: [{ id: "v", name: "Box", type: "vector", frame: frame(0, 0), subpaths: [square()],
                   fills: [], strokes: [] }],
        diagnostics: []
    };
    deliver(sock, { type: "transfer", id: "t-upd", document: ir });
    lastEval().cb(JSON.stringify({ ok: true, layersCreated: 1, layersUpdated: 3, message: "", diagnostics: [] }));

    var line = lastLog();
    ok("summary: updated layers are counted first", has(line.text, "3 layers updated"), line.text);
    ok("summary: created layers still counted", has(line.text, "1 layer created"), line.text);

    var ack = null;
    for (var i = sock.sent.length - 1; i >= 0; i--) {
        if (sock.sent[i].type === "ack") { ack = sock.sent[i]; break; }
    }
    ok("ack: carries the updated count back to the sender", ack && ack.layersUpdated === 3,
       ack ? JSON.stringify(ack) : "no ack");
});

// 15) The button names where the transfer is going, rather than Push / Pull.
run("send button names its destination", function () {
    var sock = boot("AEFT", new MemoryStorage());
    ok("button: disabled with nobody to send to", els["push"].disabled === true);

    peersMsg(sock, "welcome", ["aftereffects", "illustrator"]);
    ok("button: names the only peer", els["push"].textContent === "Send to Illustrator",
       els["push"].textContent);

    peersMsg(sock, "peers", ["aftereffects", "illustrator", "photoshop"]);
    pick("push-targets", "target", "photoshop");
    ok("button: follows the target", els["push"].textContent === "Send to Photoshop",
       els["push"].textContent);
    ok("card: the send section is labelled by what it does, not by a direction",
       has(HTML_SRC, ">Send to<"), "send-to label");
    ok("markup: no Push or Pull left in the panel",
       HTML_SRC.indexOf(">Push<") < 0 && HTML_SRC.indexOf(">Pull<") < 0);
});

// 16) Destination: the panel can ask for a new document, like the Figma plugin.
run("send destination", function () {
    var store = new MemoryStorage();
    var sock = boot("ILST", store);
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);

    ok("markup: three destinations", DESTINATION_VALUES.length === 3 &&
       DESTINATION_VALUES[0] === "active" && DESTINATION_VALUES[1] === "page" &&
       DESTINATION_VALUES[2] === "selection", DESTINATION_VALUES.join(","));
    ok("destination: Open document by default", els["push-destination"].value === "active");
    ok("destination: the note explains it", has(els["push-dest-note"].textContent, "already open"),
       els["push-dest-note"].textContent);

    // A reader always writes the artwork against its source page.
    var pageDoc = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 40, y: 30, width: 50, height: 50 },
        canvas: { width: 800, height: 600, name: "Artboard 1" },
        layers: [{ id: "v", name: "Box", type: "vector", frame: frame(0, 0), subpaths: [square()],
                   fills: [], strokes: [] }],
        diagnostics: []
    };
    files["C:/tmp/dest/ir.json"] = { data: JSON.stringify(pageDoc), enc: "" };

    // Each send is answered before the next: the button is disabled until then.
    function send() {
        els["push"].fire("click");
        lastEval().cb(JSON.stringify({ ok: true, layerCount: 1, irPath: "C:/tmp/dest/ir.json",
                                       message: "", diagnostics: [] }));
        var t = lastSent(sock);
        deliver(sock, { type: "ack", id: t.id, from: t.target || "aftereffects", ok: true, layersCreated: 1 });
        return t;
    }

    var t1 = send();
    ok("active: builds into the open document", t1.document.options.destination === "active",
       JSON.stringify(t1.document.options));
    ok("active: the page is left on the document", !!t1.document.canvas &&
       t1.document.originSpace === "document");

    choose("push-destination", "page");
    ok("destination: the note follows the choice", has(els["push-dest-note"].textContent, "size of the source page"),
       els["push-dest-note"].textContent);
    var t2 = send();
    ok("page: asks for a new document", t2.document.options.destination === "new");
    ok("page: sized to the artboard, artwork where it sat",
       t2.document.canvas.width === 800 && t2.document.originSpace === "document",
       JSON.stringify(t2.document.canvas));

    choose("push-destination", "selection");
    var t3 = send();
    ok("selection: asks for a new document", t3.document.options.destination === "new");
    ok("selection: the source page is dropped, so the target sizes to the selection",
       t3.document.canvas === undefined, JSON.stringify(t3.document.canvas));
    ok("selection: and builds at its own origin", t3.document.originSpace === "canvas",
       t3.document.originSpace);

    var saved = JSON.parse(store.getItem("lazylord.prefs.illustrator"));
    ok("destination: remembered per host", saved && saved.destination === "selection",
       store.getItem("lazylord.prefs.illustrator"));
});

// 17) Updating has nothing to update in a document that does not exist yet.
run("update overrides destination", function () {
    var sock = boot("ILST", new MemoryStorage());
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
    choose("push-destination", "page");
    choose("push-existing", "update");

    ok("hint: says the destination is ignored",
       has(els["push-opts-hint"].textContent, "Destination above is ignored"),
       els["push-opts-hint"].textContent);

    var ir = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        canvas: { width: 800, height: 600 },
        layers: [{ id: "v", name: "Box", type: "vector", frame: frame(0, 0), subpaths: [square()],
                   fills: [], strokes: [] }],
        diagnostics: []
    };
    files["C:/tmp/ud/ir.json"] = { data: JSON.stringify(ir), enc: "" };
    els["push"].fire("click");
    lastEval().cb(JSON.stringify({ ok: true, layerCount: 1, irPath: "C:/tmp/ud/ir.json",
                                   message: "", diagnostics: [] }));

    var t = lastSent(sock);
    ok("update: forced into the open document", t.document.options.destination === "active",
       JSON.stringify(t.document.options));
    ok("update: still an update", t.document.options.existing === "update");
});

// 18) Image scale is a read-time choice, so it goes to the reader, not the builder.
run("send image scale", function () {
    var store = new MemoryStorage();
    var sock = boot("ILST", store);
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);

    ok("markup: the same scales the Figma plugin offers",
       SCALE_VALUES.join(",") === "1,2,3,4", SCALE_VALUES.join(","));
    ok("scale: 2x by default", chipValue(els["push-scales"], "scale") === "2", chipValue(els["push-scales"], "scale"));
    ok("note: the default scale is not named", noteText() === "", noteText());

    pick("push-scales", "scale", "4");
    ok("note: a non-default scale is named", noteText() === "4x", noteText());

    var ir = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        layers: [{ id: "v", name: "Box", type: "vector", frame: frame(0, 0), subpaths: [square()],
                   fills: [], strokes: [] }],
        diagnostics: []
    };
    files["C:/tmp/sc/ir.json"] = { data: JSON.stringify(ir), enc: "" };
    els["push"].fire("click");

    var call = lastEval();
    ok("scale: reaches runRead, not doc.options", has(call.script, '"scale":4'), call.script);
    call.cb(JSON.stringify({ ok: true, layerCount: 1, irPath: "C:/tmp/sc/ir.json", message: "", diagnostics: [] }));
    var t = lastSent(sock);
    ok("scale: not smuggled into the builder's options", t.document.options.scale === undefined,
       JSON.stringify(t.document.options));

    var saved = JSON.parse(store.getItem("lazylord.prefs.illustrator"));
    ok("scale: remembered per host", saved && saved.scale === 4, store.getItem("lazylord.prefs.illustrator"));
});
/** Key names of an object, for a failure message. */
function dumpKeys(o) { var k = []; for (var n in o) k.push(n); return k.join(","); }

// 19) Figma is a destination like any other — but it cannot open a file, so
//     anything sent there travels as bytes.
run("sending to Figma", function () {
    var sock = boot("ILST", new MemoryStorage());
    peersMsg(sock, "welcome", ["illustrator", "aftereffects", "figma"]);

    var sel = els["push-targets"];
    ok("figma: offered as a target", has(texts(sel.children), "Figma"), texts(sel.children));
    pick("push-targets", "target", "figma");
    ok("figma: the button names it", els["push"].textContent === "Send to Figma", els["push"].textContent);

    // The reader wrote one image it owns and one the user owns.
    files["C:\\art\\logo.png"] = { data: "T1JJRw==", enc: "Base64" };
    files["C:\\tmp\\gen\\raster.png"] = { data: "R0VO", enc: "Base64" };
    var ir = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 110, height: 50 },
        layers: [
            { id: "a", name: "Linked", type: "image", frame: frame(0, 0), filePath: "C:\\art\\logo.png",
              isOriginalFile: true, pixelWidth: 50, pixelHeight: 50 },
            { id: "g", name: "Set", type: "group", frame: frame(60, 0), children: [
                { id: "b", name: "Raster", type: "image", frame: frame(60, 0),
                  filePath: "C:\\tmp\\gen\\raster.png", isOriginalFile: false,
                  pixelWidth: 50, pixelHeight: 50 }
            ]}
        ],
        diagnostics: []
    };
    files["C:/tmp/fig/ir.json"] = { data: JSON.stringify(ir), enc: "" };

    els["push"].fire("click");
    lastEval().cb(JSON.stringify({ ok: true, layerCount: 2, irPath: "C:/tmp/fig/ir.json",
                                   message: "", diagnostics: [] }));

    var t = lastSent(sock);
    ok("figma: targeted, not broadcast", t.target === "figma", String(t.target));
    ok("figma: a top-level image carries its bytes", !!t.document.layers[0].pngBase64,
       dumpKeys(t.document.layers[0]));
    ok("figma: so does one inside a group",
       !!t.document.layers[1].children[0].pngBase64, dumpKeys(t.document.layers[1].children[0]));
    ok("figma: the path is kept alongside, so the origin is still known",
       t.document.layers[0].filePath === "C:\\art\\logo.png" &&
       t.document.layers[0].isOriginalFile === true);

    // A Photoshop layer mask is an image too, and goes as bytes like one.
    files["C:\\tmp\\gen\\Title-mask-0.png"] = { data: "TUFTSw==", enc: "Base64" };
    var masked = {
        version: "1.0", source: "photoshop", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        layers: [{ id: "t", name: "Title", type: "vector", frame: frame(0, 0), subpaths: [], fills: [], strokes: [],
                   mask: { frame: frame(0, 0), filePath: "C:\\tmp\\gen\\Title-mask-0.png" } }],
        diagnostics: []
    };
    files["C:/tmp/fig2/ir.json"] = { data: JSON.stringify(masked), enc: "" };
    els["push"].fire("click");
    lastEval().cb(JSON.stringify({ ok: true, layerCount: 1, irPath: "C:/tmp/fig2/ir.json", message: "", diagnostics: [] }));
    var m = lastSent(sock).document.layers[0].mask;
    ok("figma: a layer mask carries its bytes too", m && m.pngBase64 === "TUFTSw==", m && dumpKeys(m));
});

// 20) Every other destination is on this machine and reads the file itself.
run("sending to Adobe keeps paths", function () {
    var sock = boot("ILST", new MemoryStorage());
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);

    files["C:\\art\\logo.png"] = { data: "T1JJRw==", enc: "Base64" };
    var ir = {
        version: "1.0", source: "illustrator", name: "Art", originSpace: "document",
        bounds: { x: 0, y: 0, width: 50, height: 50 },
        layers: [{ id: "a", name: "Linked", type: "image", frame: frame(0, 0),
                   filePath: "C:\\art\\logo.png", isOriginalFile: true,
                   pixelWidth: 50, pixelHeight: 50 }],
        diagnostics: []
    };
    files["C:/tmp/ae/ir.json"] = { data: JSON.stringify(ir), enc: "" };

    els["push"].fire("click");
    lastEval().cb(JSON.stringify({ ok: true, layerCount: 1, irPath: "C:/tmp/ae/ir.json",
                                   message: "", diagnostics: [] }));

    var t = lastSent(sock);
    ok("adobe: no bytes are carried", t.document.layers[0].pngBase64 === undefined,
       dumpKeys(t.document.layers[0]));
    ok("adobe: the path goes as it was", t.document.layers[0].filePath === "C:\\art\\logo.png");
});

// 21) The panel must be free to grow. A CEP panel with no MaxSize is clamped
//     to its Size by several hosts, which is what once pinned this one at
//     300x360 however hard its edge was dragged.
run("panel geometry", function () {
    var xml = read(CEP + "CSXS\\manifest.xml");

    function box(tag) {
        var m = new RegExp("<" + tag + "><Height>([0-9]+)</Height><Width>([0-9]+)</Width></" + tag + ">").exec(xml);
        return m ? { h: Number(m[1]), w: Number(m[2]) } : null;
    }
    var size = box("Size"), min = box("MinSize"), max = box("MaxSize");

    ok("geometry: a starting size is declared", !!size, String(size && size.w));
    ok("geometry: a minimum is declared", !!min, String(min && min.w));
    ok("geometry: a MAXIMUM is declared, so the panel can be resized",
       !!max, max ? "yes" : "missing — the panel will be stuck at its Size");
    ok("geometry: the maximum leaves room for any display",
       !!max && max.w >= 2000 && max.h >= 2000, max ? max.w + "x" + max.h : "none");
    ok("geometry: the minimum is not above the starting size",
       !!min && !!size && min.w <= size.w && min.h <= size.h,
       min && size ? min.w + "x" + min.h + " vs " + size.w + "x" + size.h : "");
    ok("geometry: it opens tall enough to show the send controls",
       !!size && size.h >= 560, String(size && size.h));

    // The stylesheet the panel links has to be the synced copy, not a path
    // reaching outside the folder Adobe symlinks into its extensions directory.
    ok("markup: the stylesheet is linked from inside the panel folder",
       has(HTML_SRC, 'href="./css/lazylord.css"'), "css link");
    ok("markup: and nothing reaches outside it", !has(HTML_SRC, 'href="../'), "relative escape");
});

WScript.Echo("");
// PSD import: After Effects asks Photoshop which document is open.
run("psd import", function () {
    // Photoshop answers.
    var ps = boot("PHXS", new MemoryStorage());
    deliver(ps, { type: "request", id: "q-1", target: "photoshop", what: "active-document" });
    var call = lastEval();
    ok("psd: Photoshop asks its host", call && has(call.script, "LazyLord.activeDocumentInfo()"), call && call.script);
    call.cb(JSON.stringify({ ok: true, data: { name: "Poster.psd", path: "C:\\art\\Poster.psd", saved: false } }));
    var answer = lastSent(ps);
    ok("psd: and replies under the same id", answer && answer.type === "reply" && answer.id === "q-1" && answer.ok === true &&
       answer.from === "photoshop" && answer.data.path === "C:\\art\\Poster.psd", JSON.stringify(answer));

    // After Effects asks, then imports what Photoshop names.
    var ae = boot("AEFT", new MemoryStorage());
    ok("psd: the After Effects tools are shown", els["ae-tools"].hidden === false);
    peersMsg(ae, "welcome", ["aftereffects", "photoshop"]);
    els["ae-import-psd"].fire("click");
    var q = lastSent(ae);
    ok("psd: After Effects asks Photoshop", q && q.type === "request" && q.target === "photoshop" && q.what === "active-document",
       JSON.stringify(q));
    deliver(ae, { type: "reply", id: q.id, from: "photoshop", ok: true, data: { name: "Poster.psd", path: "C:\\art\\Poster.psd", saved: false } });
    ok("psd: unsaved changes are mentioned", linesWith("last saved version").length === 1, texts(els["log"].children));
    ok("psd: the saved file is imported", has(lastEval().script, "LazyLord.importPsd(") && has(lastEval().script, "Poster.psd"),
       lastEval().script);

    // A document that was never saved cannot be imported.
    var before = evalCalls.length;
    els["ae-import-psd"].fire("click");
    q = lastSent(ae);
    deliver(ae, { type: "reply", id: q.id, from: "photoshop", ok: true, data: { name: "Untitled-1", path: "", saved: false } });
    ok("psd: an unsaved document asks to be saved, nothing imported",
       linesWith("never been saved").length === 1 && evalCalls.length === before, texts(els["log"].children));

    // Without Photoshop, a file is chosen instead.
    ae = boot("AEFT", new MemoryStorage());
    peersMsg(ae, "welcome", ["aftereffects"]);
    els["ae-import-psd"].fire("click");
    ok("psd: without Photoshop, a file dialog", has(lastEval().script, 'LazyLord.importPsd("")'), lastEval().script);
});

// Large transfers arrive in pieces and are built once all are in.
run("chunks", function () {
    var sock = boot("PHXS", new MemoryStorage());
    var text = JSON.stringify({ type: "transfer", id: "c-1", target: "photoshop", document: figmaDoc() });
    var size = Math.ceil(text.length / 3);
    var pieces = [];
    for (var i = 0; i < 3; i++) {
        pieces.push({ type: "chunk", id: "c-1", target: "photoshop", index: i, total: 3, data: text.slice(i * size, (i + 1) * size) });
    }
    deliver(sock, pieces[2]);
    deliver(sock, pieces[0]);
    ok("chunks: nothing built before the last piece", irFile() === null);
    deliver(sock, pieces[1]);
    ok("chunks: built once every piece is in, whatever the order", irFile() !== null &&
       JSON.parse(irFile().file.data).name === "Page");
    lastEval().cb(JSON.stringify({ ok: true, layersCreated: 4, message: "", diagnostics: [] }));
    var reply = lastSent(sock);
    ok("chunks: acknowledged under the transfer's id", reply && reply.type === "ack" && reply.id === "c-1" && reply.ok === true,
       JSON.stringify(reply));
});

// History: every finished transfer is kept per host role, newest first.
run("history", function () {
    var store = new MemoryStorage();
    var sock = boot("PHXS", store);
    ok("history: empty at first", els["history-list"].children.length === 1 && els["history-count"].textContent === "");

    deliver(sock, { type: "transfer", id: "h-1", document: figmaDoc() });
    lastEval().cb(JSON.stringify({ ok: true, layersCreated: 5, layersUpdated: 2, message: "", diagnostics: [] }));
    deliver(sock, { type: "transfer", id: "h-2", document: figmaDoc() });
    lastEval().cb(JSON.stringify({ ok: false, layersCreated: 0, message: "No document is open.", diagnostics: [] }));

    var saved = JSON.parse(store.getItem("lazylord.history.photoshop"));
    ok("history: both transfers kept, newest first", saved && saved.length === 2 && saved[0].ok === false && saved[1].ok === true,
       store.getItem("lazylord.history.photoshop"));
    ok("history: route, name and counts", saved[1].dir === "in" && saved[1].peer === "Figma" && saved[1].name === "Page" &&
       saved[1].layers === 5 && saved[1].updated === 2 && saved[1].fallbacks > 0, JSON.stringify(saved[1]));
    ok("history: a failure keeps its message", saved[0].message === "No document is open.", JSON.stringify(saved[0]));
    ok("history: listed in the card with a count", els["history-list"].children.length === 2 && els["history-count"].textContent === "2");
    ok("history: the failed entry is marked", els["history-list"].children[0].className.indexOf("err") >= 0);

    boot("PHXS", store);
    ok("history: survives a restart", els["history-list"].children.length === 2);
    els["history-clear"].fire("click");
    ok("history: cleared", JSON.parse(store.getItem("lazylord.history.photoshop")).length === 0 &&
       els["history-list"].children.length === 1);

    // Only the newest 25 are kept.
    var many = [];
    for (var i = 0; i < 25; i++) many.push({ t: i, dir: "out", peer: "Illustrator", ok: true, layers: 1 });
    store.setItem("lazylord.history.photoshop", JSON.stringify(many));
    sock = boot("PHXS", store);
    deliver(sock, { type: "transfer", id: "h-3", document: figmaDoc() });
    lastEval().cb(JSON.stringify({ ok: true, layersCreated: 1, message: "", diagnostics: [] }));
    var capped = JSON.parse(store.getItem("lazylord.history.photoshop"));
    ok("history: capped at 25, the oldest dropped", capped.length === 25 && capped[0].peer === "Figma" && capped[24].t === 23,
       capped.length + " / " + capped[24].t);
});

// Presets: the Destination, Image scale and Options saved under a name.
run("presets", function () {
    var store = new MemoryStorage();
    var sock = boot("ILST", store);
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
    ok("presets: none yet, nothing to delete", els["push-preset"].children.length === 1 && els["push-preset-delete"].disabled === true);

    choose("push-layout", "combine");
    choose("push-destination", "page");
    pick("push-scales", "scale", "4");
    els["push-preset-save"].fire("click");
    ok("presets: a name is required", linesWith("name for the preset").length === 1, texts(els["log"].children));

    els["push-preset-name"].value = "  Motion  ";
    els["push-preset-save"].fire("click");
    var list = JSON.parse(store.getItem("lazylord.presets.illustrator"));
    ok("presets: saved with every setting, name trimmed", list.length === 1 && list[0].name === "Motion" &&
       list[0].values.layout === "combine" && list[0].values.destination === "page" && list[0].values.scale === 4,
       store.getItem("lazylord.presets.illustrator"));
    ok("presets: listed and selected", els["push-preset"].children.length === 2 && els["push-preset"].value === "Motion" &&
       els["push-preset-delete"].disabled === false);

    choose("push-layout", "split");
    choose("push-destination", "active");
    pick("push-scales", "scale", "2");
    choose("push-preset", "Motion");
    ok("presets: applying one restores its settings", els["push-layout"].value === "combine" &&
       els["push-destination"].value === "page" && chipValue(els["push-scales"], "scale") === "4");
    ok("presets: applied settings become the remembered ones",
       JSON.parse(store.getItem("lazylord.prefs.illustrator")).layout === "combine");

    els["push-preset-name"].value = "Motion";
    choose("push-layout", "split");
    els["push-preset-save"].fire("click");
    list = JSON.parse(store.getItem("lazylord.presets.illustrator"));
    ok("presets: saving under the same name updates it", list.length === 1 && list[0].values.layout === "split");

    els["push-preset-delete"].fire("click");
    ok("presets: deleted", JSON.parse(store.getItem("lazylord.presets.illustrator")).length === 0 &&
       els["push-preset"].children.length === 1 && els["push-preset-delete"].disabled === true);
});

// Where After Effects keeps received images: the panel's own choice.
run("image folder", function () {
    var st = new MemoryStorage();
    var sock = boot("AEFT", st);
    ok("image folder: offered in After Effects, beside the project by default",
       els["image-folder-row"].hidden === false && /beside the project/.test(els["image-folder"].textContent), els["image-folder"].textContent);
    els["image-folder-choose"].fire("click");
    var call = lastEval();
    ok("image folder: After Effects is asked for a folder", has(call.script, "LazyLord.chooseFolder("), call.script);
    call.cb(JSON.stringify({ path: "D:\\Renders\\Assets" }));
    var saved = JSON.parse(st.getItem("lazylord.prefs.aftereffects"));
    ok("image folder: shown and kept", has(els["image-folder"].textContent, "D:\\Renders\\Assets") &&
       els["image-folder-reset"].hidden === false && saved.imageFolder === "D:\\Renders\\Assets", st.getItem("lazylord.prefs.aftereffects"));

    var d = figmaDoc();
    d.options = { imageFolder: "C:\\elsewhere" };
    deliver(sock, { type: "transfer", id: "t-img", document: d });
    var ir = irFile();
    var built = ir ? JSON.parse(ir.file.data) : null;
    ok("image folder: reaches the builder as this panel's choice, not the sender's",
       built && built.options && built.options.imageFolder === "D:\\Renders\\Assets", ir && ir.file.data.slice(0, 200));

    els["image-folder-reset"].fire("click");
    ok("image folder: back to the default", /beside the project/.test(els["image-folder"].textContent) &&
       els["image-folder-reset"].hidden === true && JSON.parse(st.getItem("lazylord.prefs.aftereffects")).imageFolder === "");
});

run("image folder elsewhere", function () {
    var sock = boot("ILST", new MemoryStorage());
    ok("image folder: not offered where images are embedded", els["image-folder-row"].hidden === true);
    var d = figmaDoc();
    d.options = { imageFolder: "C:\\elsewhere" };
    deliver(sock, { type: "transfer", id: "t-img2", document: d });
    var ir = irFile();
    var built = ir ? JSON.parse(ir.file.data) : null;
    ok("image folder: a sender cannot set it", built && (!built.options || built.options.imageFolder === undefined));
});

// Photoshop: layers as the frames of one sequence, asked of the reader.
run("frames", function () {
    var st = new MemoryStorage();
    var sock = boot("PHXS", st);
    peersMsg(sock, "welcome", ["photoshop", "aftereffects"]);
    ok("frames: offered in Photoshop", els["push-sequence-row"].hidden === false);
    els["push-sequence"].checked = true;
    els["push-sequence"].fire("change");
    ok("frames: remembered", JSON.parse(st.getItem("lazylord.prefs.photoshop")).sequence === true);
    els["push"].fire("click");
    var call = lastEval();
    ok("frames: the reader is asked for a sequence", has(call.script, "LazyLord.runRead(") && has(call.script, '"sequence":true'), call.script);

    boot("AEFT", new MemoryStorage());
    ok("frames: not offered elsewhere", els["push-sequence-row"].hidden === true);
});

// Updates: the latest release on GitHub, announced in the panel.
var UPDATE_DELAY = 6000;
var CURRENT_VERSION = /var PANEL_VERSION = "([^"]+)"/.exec(MAIN_SRC)[1];
/** This panel's version with one part (0 major, 1 minor, 2 patch) moved on. */
function bumped(part) {
    var v = CURRENT_VERSION.split(".");
    for (var i = 0; i < 3; i++) v[i] = Number(v[i] || 0);
    v[part] += 1;
    for (var j = part + 1; j < 3; j++) v[j] = 0;
    return v.join(".");
}
/** A release as GitHub's API describes it, notes written the way releases are. */
function release(tag, extra) {
    var r = {
        tag_name: tag,
        html_url: "https://github.com/raisulsohan/LazyLord/releases/tag/" + tag,
        body: "**Download `LazyLord.zip` below**, unzip it, and run `1 - Install LazyLord.bat`.\r\n\r\n## A refined look\r\n\r\n" +
              "- **The logo spells the name.** The L symbol is now the first letter of LazyLord.\r\n" +
              "- Plain point with [a link](https://example.com) and `code`\r\n\r\nMade by [Raisul Sohan](http://raisulsohan.com/)."
    };
    for (var k in extra) r[k] = extra[k];
    return r;
}
function noteTexts() { return texts(els["update-notes"].children); }
function updateState(st) { return JSON.parse(st.getItem("lazylord.update")); }

run("updates", function () {
    var st = new MemoryStorage();
    var newer = bumped(1);
    boot("ILST", st);
    ok("updates: nothing is asked while the panel starts", requests.length === 0);
    ok("updates: the version offers a check", els["ver"].textContent === "v" + CURRENT_VERSION &&
       els["ver"].title === "Check for updates", els["ver"].textContent + " / " + els["ver"].title);
    ok("updates: the first check is scheduled", fireTimer(UPDATE_DELAY));
    var req = requests[0];
    ok("updates: GitHub is asked for the latest release", requests.length === 1 && req.method === "GET" && req.async === true &&
       req.url === "https://api.github.com/repos/raisulsohan/LazyLord/releases/latest", req && req.url);
    req.respond(200, release("v" + newer));
    ok("updates: a newer release shows the card", els["update-card"].hidden === false &&
       els["update-title"].textContent === "LazyLord " + newer + " is out", els["update-title"].textContent);
    ok("updates: with its points in a few words", els["update-notes"].hidden === false &&
       noteTexts() === "The logo spells the name.|Plain point with a link and code", noteTexts());
    ok("updates: the header version is marked", els["ver"].textContent === "v" + CURRENT_VERSION + DOT + "update" &&
       has(els["ver"].className, "has-update") && els["ver"].title === "LazyLord " + newer + " is available", els["ver"].textContent);
    ok("updates: logged once, quietly", linesWith("is available").length === 1 && lastLog().kind === "" && els["log-card"].open !== true);
    ok("updates: the answer is kept", updateState(st).latest.version === newer && typeof updateState(st).checkedAt === "number");
    els["update-download"].fire("click");
    ok("updates: Download opens the release page", opened.length === 1 && opened[0] === release("v" + newer).html_url, opened.join("|"));
    ok("updates: the card stays after Download", els["update-card"].hidden === false);
    els["update-later"].fire("click");
    ok("updates: Later puts the card away", els["update-card"].hidden === true && updateState(st).dismissed === newer);
    ok("updates: the header still says so", has(els["ver"].className, "has-update"));

    // Another app's panel soon after: no second request, and the card stays away.
    boot("AEFT", st);
    fireTimer(UPDATE_DELAY);
    ok("updates: a recent answer is reused", requests.length === 0);
    ok("updates: a version put away stays away", els["update-card"].hidden === true && has(els["ver"].className, "has-update"));
    els["ver"].fire("click");
    ok("updates: the marked version brings the card back", els["update-card"].hidden === false && requests.length === 0);

    // Half a day on, a release after the one put away.
    var state = updateState(st);
    state.checkedAt = 0;
    st.setItem("lazylord.update", JSON.stringify(state));
    boot("ILST", st);
    fireTimer(UPDATE_DELAY);
    ok("updates: an old answer is asked again", requests.length === 1);
    requests[0].respond(200, release("v" + bumped(0)));
    ok("updates: a later version than the one put away shows", els["update-card"].hidden === false &&
       els["update-title"].textContent === "LazyLord " + bumped(0) + " is out", els["update-title"].textContent);
});

run("updates: nothing new, and failures", function () {
    boot("PHXS", new MemoryStorage());
    fireTimer(UPDATE_DELAY);
    requests[0].respond(200, release("v" + CURRENT_VERSION));
    ok("updates: the same version shows nothing", els["update-card"].hidden === true &&
       !has(els["ver"].className, "has-update") && linesWith("available").length === 0);
    els["ver"].fire("click");
    ok("updates: clicking the version checks at once", requests.length === 2 && linesWith("Checking for a newer LazyLord").length === 1);
    requests[1].respond(200, release("v" + CURRENT_VERSION));
    ok("updates: and says this is the latest", lastLog().text.indexOf("This is the latest LazyLord (" + CURRENT_VERSION + ").") > 0 &&
       lastLog().kind === "ok", lastLog().text);

    boot("PHXS", new MemoryStorage());
    fireTimer(UPDATE_DELAY);
    requests[0].respond(200, release("v0.9.0"));
    ok("updates: an older release shows nothing", els["update-card"].hidden === true && !has(els["ver"].className, "has-update"));

    boot("PHXS", new MemoryStorage());
    fireTimer(UPDATE_DELAY);
    var before = logLines().length;
    requests[0].respond(500, "oops");
    ok("updates: a scheduled check that fails stays quiet", logLines().length === before && els["update-card"].hidden === true);
    els["ver"].fire("click");
    requests[1].onerror();
    ok("updates: a check the user asked for says why it failed",
       has(lastLog().text, "Could not check for updates: no connection.") && lastLog().kind === "warn", lastLog().text);

    boot("PHXS", new MemoryStorage());
    els["ver"].fire("click");
    requests[0].onerror();
    requests[0].respond(0, "");
    ok("updates: a request that cannot connect is reported once",
       linesWith("Could not check for updates: no connection.").length === 1, texts(els["log"].children));
    els["ver"].fire("click");
    requests[1].respond(404, "Not Found");
    ok("updates: GitHub's refusal is named", has(lastLog().text, "Could not check for updates: GitHub answered 404."), lastLog().text);

    boot("PHXS", new MemoryStorage());
    fireTimer(UPDATE_DELAY);
    requests[0].respond(200, "<html>not json</html>");
    boot("PHXS", new MemoryStorage());
    fireTimer(UPDATE_DELAY);
    requests[0].respond(200, { name: "no tag" });
    ok("updates: an answer without a version shows nothing", els["update-card"].hidden === true && linesWith("available").length === 0);

    boot("PHXS", new MemoryStorage());
    fireTimer(UPDATE_DELAY);
    var bullets = "";
    for (var i = 1; i <= 6; i++) bullets += "* Point " + i + (i === 2 ? " " + new Array(40).join("long ") : "") + "\n";
    requests[0].respond(200, release("v" + bumped(2), { html_url: "https://example.com/not-github", body: bullets }));
    var notes = els["update-notes"].children;
    ok("updates: at most four points, long ones cut short", notes.length === 4 && notes[0].textContent === "Point 1" &&
       notes[1].textContent.length <= 90 && notes[1].textContent.slice(-1) === ELLIPSIS, noteTexts());
    els["update-download"].fire("click");
    ok("updates: a link off GitHub is not followed", opened.length === 1 && opened[0] === "https://github.com/raisulsohan/LazyLord/releases/latest", opened.join("|"));

    boot("PHXS", new MemoryStorage());
    fireTimer(UPDATE_DELAY);
    requests[0].respond(200, release("v" + bumped(2), { body: "Just words, no points." }));
    ok("updates: notes without points leave the list out", els["update-card"].hidden === false && els["update-notes"].hidden === true);
});

run("updates: switched off", function () {
    var st = new MemoryStorage();
    boot("ILST", st);
    els["check-updates"].checked = false;
    els["check-updates"].fire("change");
    ok("updates: the choice is remembered", JSON.parse(st.getItem("lazylord.prefs.illustrator")).checkUpdates === false);
    fireTimer(UPDATE_DELAY);
    ok("updates: off means no request", requests.length === 0);

    boot("ILST", st);
    ok("updates: restored off, nothing scheduled", els["check-updates"].checked === false && !fireTimer(UPDATE_DELAY) && requests.length === 0);
    els["ver"].fire("click");
    ok("updates: a check the user asks for still goes", requests.length === 1);
    requests[0].respond(200, release("v" + bumped(1)));
    ok("updates: and shows what it found", els["update-card"].hidden === false);
    els["check-updates"].checked = true;
    els["check-updates"].fire("change");
    ok("updates: switched on, a recent answer is used", requests.length === 1 && els["update-card"].hidden === false);
    els["check-updates"].checked = false;
    els["check-updates"].fire("change");
    ok("updates: switched off, the card and the mark go", els["update-card"].hidden === true && !has(els["ver"].className, "has-update"));

    boot("AEFT", new MemoryStorage());
    fireTimer(UPDATE_DELAY);
    els["check-updates"].checked = false;
    els["check-updates"].fire("change");
    requests[0].respond(200, release("v" + bumped(1)));
    ok("updates: switched off while GitHub answers, nothing shows", els["update-card"].hidden === true && !has(els["ver"].className, "has-update"));
});

WScript.Echo(passed + " passed, " + failed + " failed.");
WScript.Quit(failed === 0 ? 0 : 1);
