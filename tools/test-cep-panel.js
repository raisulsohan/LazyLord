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
El.prototype.fire = function (type) {
    var hs = this.listeners[type] || [];
    for (var i = 0; i < hs.length; i++) hs[i]({ type: type, target: this });
};
function textNode(s) { return { nodeType: 3, textContent: s, nodeValue: s }; }

var IDS = ["conn", "conn-text", "host", "host-sub", "log", "auto", "push-card", "push-title",
           "push-sub", "push", "push-target", "diag-card", "diag-head", "diag-title",
           "diag-counts", "diag-list", "reconnect", "push-options", "push-opts-note", "push-layout",
           "push-hierarchy"];
var TAGS = { "auto": "input", "push-target": "select", "push": "button", "reconnect": "button",
             "diag-list": "ul", "push-options": "details", "push-layout": "select", "push-hierarchy": "select" };

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
    els["push-card"].hidden = true;
    els["diag-card"].hidden = true;
    addOptions(els["push-layout"], LAYOUT_VALUES);
    addOptions(els["push-hierarchy"], HIERARCHY_VALUES);

    sockets = []; evalCalls = []; files = {}; timers = [];
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
            encoding: { Base64: "Base64", UTF8: "UTF-8" }
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
    var sel = els["push-target"];

    ok("prefs: auto-receive on by default", els["auto"].checked === true);
    ok("prefs: push card shown on a host with a reader", els["push-card"].hidden === false);
    peersMsg(sock, "welcome", ["illustrator", "photoshop", "aftereffects", "figma"]);
    ok("prefs: Illustrator defaults to After Effects", sel.value === "aftereffects", sel.value);
    ok("prefs: Figma and self are not offered", texts(sel.children) === "Photoshop|After Effects",
       texts(sel.children));
    ok("prefs: nothing stored before the user chooses", store.getItem("lazylord.prefs.illustrator") === null);

    sel.value = "photoshop";
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
    var sel = els["push-target"];

    ok("restore: auto-receive off comes back", els["auto"].checked === false);
    ok("restore: push options come back", optionValues() === "combine/groups", optionValues());
    ok("restore: and are named while folded", noteText() === "Combine, Groups", noteText());
    peersMsg(sock, "welcome", ["illustrator", "aftereffects"]);
    ok("restore: default stands in while the saved app is absent", sel.value === "aftereffects", sel.value);
    peersMsg(sock, "peers", ["illustrator", "aftereffects", "photoshop"]);
    ok("restore: saved target selected once it connects", sel.value === "photoshop", sel.value);
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
    var sel = els["push-target"];

    ok("per-host: AE ignores Illustrator's auto-receive", els["auto"].checked === true);
    ok("per-host: AE ignores Illustrator's push options", optionValues() === "split/flatten" && noteText() === "",
       optionValues());
    peersMsg(sock, "welcome", ["aftereffects", "illustrator", "photoshop"]);
    ok("per-host: AE defaults to Illustrator", sel.value === "illustrator", sel.value);
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
        boot("ILST", broken);
        autoAtBoot = els["auto"].checked;
        els["auto"].checked = false;
        els["auto"].fire("change");
        els["push-target"].value = "aftereffects";
        els["push-target"].fire("change");
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
    ok("receive: no push card without a reader", els["push-card"].hidden === true);

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
    ok("markup: Hierarchy offers Flatten then Groups", HIERARCHY_VALUES.join("|") === "flatten|groups",
       HIERARCHY_VALUES.join("|"));
    ok("markup: both selects are labelled", has(HTML_SRC, '<label for="push-layout">Layout</label>') &&
       has(HTML_SRC, '<label for="push-hierarchy">Hierarchy</label>'));
});

WScript.Echo("");
WScript.Echo(passed + " passed, " + failed + " failed.");
WScript.Quit(failed === 0 ? 0 : 1);
