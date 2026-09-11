/*
 * LazyLord — transaction tests (no Node required).
 *
 *   cscript //Nologo tools\test-rollback.js
 *
 * A build that throws part-way must take back what it made — and only that.
 * Each host's LazyLord.snapshot / LazyLord.rollback runs against a small
 * mocked DOM, through the real LazyLord.run, with a builder that creates a few
 * things and then fails. The user's own layers, items and documents must come
 * through untouched.
 */
var fso = new ActiveXObject("Scripting.FileSystemObject");
var scriptDir = fso.GetParentFolderName(WScript.ScriptFullName);
var repoRoot = fso.GetParentFolderName(scriptDir);
var JSX = fso.BuildPath(repoRoot, "packages\\adobe-cep\\jsx") + "\\";

function read(path) {
    var st = new ActiveXObject("ADODB.Stream");
    st.Type = 2; st.Charset = "utf-8"; st.Open();
    st.LoadFromFile(path);
    var s = st.ReadText(-1);
    st.Close();
    return s;
}
function load(name) { return read(JSX + name).replace(/^\s*#[a-zA-Z].*$/gm, ""); }

var passed = 0, failed = 0;
function ok(name, cond, detail) {
    if (cond) { WScript.Echo("  ok   " + name); passed++; }
    else { WScript.Echo("  FAIL " + name + (detail ? "  -> " + detail : "")); failed++; }
}
function without(list, x) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i] !== x) out.push(list[i]);
    return out;
}

var SaveOptions = { DONOTSAVECHANGES: "dont-save" };
var app = {};

eval(load("json2.js"));
eval(load("lazylord.jsx"));
LazyLord.readFile = function () { return '{"layers":[]}'; };

/** Run LazyLord.run with `make` as the builder: it creates things, then throws. */
function failingRun(make) {
    LazyLord.build = function () { make(); throw new Error("Boom"); };
    return JSON.parse(LazyLord.run("ir.json"));
}

WScript.Echo("LazyLord - transactions");
WScript.Echo("");

// --- After Effects -----------------------------------------------------------
function CompItem() {}
var nextId = 1;
function aeItem(kind) { return { id: nextId++, kind: kind, remove: function () { app.project.list = without(app.project.list, this); syncAe(); } }; }
function syncAe() { app.project.numItems = app.project.list.length; }
function aeComp(layerIds) {
    var c = new CompItem();
    c.id = nextId++;
    c.kind = "comp";
    c.layers = [];
    c.numLayers = 0;
    c.layer = function (i) { return c.layers[i - 1]; };
    c.addLayer = function (id) {
        var l = { id: id, remove: function () { c.layers = without(c.layers, this); c.numLayers = c.layers.length; } };
        c.layers.unshift(l); // AE adds new layers on top
        c.numLayers = c.layers.length;
        return l;
    };
    c.remove = function () { app.project.list = without(app.project.list, c); syncAe(); };
    for (var i = 0; i < layerIds.length; i++) c.addLayer(layerIds[i]);
    return c;
}
function aeSetup(layerIds) {
    app = { project: { list: [], numItems: 0, activeItem: null, item: function (i) { return this.list[i - 1]; } } };
    var comp = aeComp(layerIds);
    app.project.list.push(comp, aeItem("footage"));
    syncAe();
    app.project.activeItem = comp;
    return comp;
}

eval(load("ae.jsx"));
(function () {
    var comp = aeSetup([11, 12]);
    var res = failingRun(function () {
        comp.addLayer(13);
        var solids = aeItem("folder");
        app.project.list.push(solids, aeItem("solid"), aeItem("footage"));
        syncAe();
    });
    ok("ae: the build failed and says so", res.ok === false && res.message.indexOf("Boom") === 0, res.message);
    ok("ae: says everything was removed", res.message.indexOf("removed again") > 0, res.message);
    var left = [comp.layer(1).id, comp.layer(2).id].sort().join(",");
    ok("ae: only the user's layers are left", comp.numLayers === 2 && left === "11,12", comp.numLayers + ": " + left);
    ok("ae: only the user's project items are left", app.project.numItems === 2 && app.project.item(1) === comp);

    // The build made a comp of its own: it goes, with its layers.
    comp = aeSetup([11]);
    res = failingRun(function () {
        var mine = aeComp([21, 22]);
        app.project.list.push(mine);
        syncAe();
        app.project.activeItem = mine;
    });
    ok("ae: a comp the build made is removed", app.project.numItems === 2 && comp.numLayers === 1, app.project.numItems + "");

    // Without layer ids the open comp's layers are not guessed at.
    comp = aeSetup([]);
    comp.layers.push({ remove: function () { throw new Error("must not be removed"); } });
    comp.numLayers = 1;
    res = failingRun(function () {
        comp.addLayer(undefined);
        app.project.list.push(aeItem("footage"));
        syncAe();
    });
    ok("ae: without layer ids nothing in the comp is removed, and it says so",
       comp.numLayers === 2 && res.message.indexOf("could not be identified") > 0, res.message);
    ok("ae: new project items are still removed", app.project.numItems === 2);

    // A build that succeeds removes nothing.
    comp = aeSetup([11]);
    LazyLord.build = function () { comp.addLayer(12); return { ok: true, layersCreated: 1, message: "" }; };
    res = JSON.parse(LazyLord.run("ir.json"));
    ok("ae: a successful build keeps what it made", res.ok === true && comp.numLayers === 2);
})();

// --- Illustrator -------------------------------------------------------------
function aiDoc(uuids) {
    var d = { items: [], closedWith: null };
    d.pageItems = d.items;
    d.add = function (uuid, parent) {
        var it = { uuid: uuid, parent: parent || null, remove: function () {
            if (this.gone) throw new Error("already removed");
            this.gone = true;
            var kept = [];
            for (var i = 0; i < d.items.length; i++) {
                var x = d.items[i];
                if (x === this || x.parent === this) { x.gone = true; continue; }
                kept.push(x);
            }
            d.items.length = 0;
            for (var k = 0; k < kept.length; k++) d.items.push(kept[k]);
        } };
        d.items.push(it);
        return it;
    };
    d.close = function (how) { d.closedWith = how; app.documents.length--; if (app.activeDocument === d) app.activeDocument = app.prev; };
    for (var i = 0; i < uuids.length; i++) d.add(uuids[i]);
    return d;
}
function uuidsOf(d) { var out = []; for (var i = 0; i < d.items.length; i++) out.push(d.items[i].uuid); return out.join(","); }

eval(load("ai.jsx"));
(function () {
    var doc = aiDoc(["u1", "u2"]);
    app = { documents: { length: 1 }, activeDocument: doc };
    var res = failingRun(function () {
        var g = doc.add("n-group");
        doc.add("n-child", g);
        doc.add("n-path");
    });
    ok("ai: new items removed, the user's kept", uuidsOf(doc) === "u1,u2", uuidsOf(doc));
    ok("ai: says everything was removed", res.message.indexOf("removed again") > 0, res.message);

    // The build opened a document: it is closed unsaved, the user's untouched.
    var mine = aiDoc([]);
    app = { documents: { length: 1 }, activeDocument: doc, prev: doc };
    res = failingRun(function () {
        app.documents.length++;
        app.activeDocument = mine;
        mine.add("n1");
    });
    ok("ai: a document the build opened is closed without saving", mine.closedWith === "dont-save", String(mine.closedWith));
    ok("ai: the user's document is untouched", doc.closedWith === null && uuidsOf(doc) === "u1,u2", uuidsOf(doc));

    // Items without uuids (older Illustrator): nothing is guessed at.
    var old = aiDoc([]);
    old.items.push({ remove: function () { throw new Error("must not be removed"); } });
    app = { documents: { length: 1 }, activeDocument: old };
    res = failingRun(function () { old.add("n1"); });
    ok("ai: without uuids nothing is removed, and it says so",
       old.items.length === 2 && res.message.indexOf("could not be identified") > 0, res.message);
})();

// --- Photoshop ---------------------------------------------------------------
eval(load("ps.jsx"));
(function () {
    var doc = { activeHistoryState: "Open", closedWith: null, close: function (h) { this.closedWith = h; } };
    app = { documents: { length: 1 }, activeDocument: doc };
    var res = failingRun(function () { doc.activeHistoryState = "New Layer 3"; });
    ok("ps: the document steps back to its state before the build", doc.activeHistoryState === "Open", doc.activeHistoryState);
    ok("ps: says everything was removed", res.message.indexOf("removed again") > 0, res.message);

    var mine = { closedWith: null, close: function (h) { this.closedWith = h; app.documents.length--; app.activeDocument = doc; } };
    doc.activeHistoryState = "Open";
    app = { documents: { length: 1 }, activeDocument: doc };
    res = failingRun(function () {
        app.documents.length++;
        app.activeDocument = mine;
    });
    ok("ps: a document the build opened is closed without saving", mine.closedWith === "dont-save", String(mine.closedWith));
    ok("ps: the user's document is left where it was", doc.closedWith === null && doc.activeHistoryState === "Open");

    // Nothing open before: the new document is simply closed.
    app = { documents: { length: 0 }, activeDocument: null };
    var only = { closedWith: null, close: function (h) { this.closedWith = h; app.documents.length--; } };
    res = failingRun(function () { app.documents.length = 1; app.activeDocument = only; });
    ok("ps: with nothing open before, the new document is closed", only.closedWith === "dont-save" &&
       res.message.indexOf("removed again") > 0, res.message);
})();

WScript.Echo("");
WScript.Echo(passed + " passed, " + failed + " failed.");
WScript.Quit(failed === 0 ? 0 : 1);
