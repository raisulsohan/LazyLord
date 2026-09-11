/*
 * LazyLord — After Effects precomp helper tests (no Node required).
 *
 *   cscript //Nologo tools\test-ae-helpers.js
 *
 * The panel's Precompose / Decompose buttons, against a small mocked comp:
 * which layers are precomposed, where decomposed layers land in the stack,
 * that the helper null and the precomp layer are gone afterwards, that the
 * precomp layer's opacity and start time carry over, what is reported as not
 * carried, and that a failed copy leaves the comp as it was.
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

// --- A small After Effects ---------------------------------------------------
var undo = [];
var failCopyOf = null;

function prop(v) {
    return { value: v, numKeys: 0, setValue: function (x) { this.value = x; } };
}
function Layer(name, opts) {
    opts = opts || {};
    var t = {
        "ADBE Anchor Point": prop([0, 0]), "ADBE Position": prop(opts.position || [0, 0]),
        "ADBE Scale": prop([100, 100]), "ADBE Rotate Z": prop(0), "ADBE Opacity": prop(opts.opacity === undefined ? 100 : opts.opacity)
    };
    this.name = name;
    this.source = opts.source || null;
    this.startTime = opts.startTime || 0;
    this.parent = null;
    this.comp = null;
    this.effects = opts.effects || 0;
    this.masks = opts.masks || 0;
    var self = this;
    this.groups = {
        "ADBE Transform Group": { property: function (k) { return t[k]; } },
        "ADBE Effect Parade": { numProperties: self.effects },
        "ADBE Mask Parade": { numProperties: self.masks }
    };
}
Layer.prototype.property = function (k) { return this.groups[k]; };
Layer.prototype.remove = function () { this.comp.take(this); this.comp = null; };
Layer.prototype.moveBefore = function (other) {
    var c = this.comp;
    c.take(this);
    var at = c.list.length;
    for (var i = 0; i < c.list.length; i++) if (c.list[i] === other) at = i;
    c.list.splice(at, 0, this);
    this.comp = c;
    c.sync();
};
Layer.prototype.copyToComp = function (target) {
    if (failCopyOf === this.name) return; // After Effects silently did nothing
    var copy = new Layer(this.name, {
        opacity: this.property("ADBE Transform Group").property("ADBE Opacity").value,
        startTime: this.startTime
    });
    target.list.unshift(copy); // copies land on top
    copy.comp = target;
    target.sync();
};
Layer.prototype.setParentWithJump = function (p) { this.jumpedTo = p.name; this.parent = p; };

function CompItem(name, layers) {
    this.name = name;
    this.list = [];
    this.selectedLayers = [];
    var self = this;
    this.layers = {
        addNull: function () { var n = new Layer("Null"); self.list.unshift(n); n.comp = self; self.sync(); return n; },
        precompose: function (idx, nm, move) {
            self.precomposed = { idx: idx.join(","), name: nm, move: move };
            var inner = [];
            for (var i = 0; i < idx.length; i++) inner.push(self.list[idx[i] - 1]);
            var sub = new CompItem(nm, []);
            for (var k = 0; k < inner.length; k++) { self.take(inner[k]); sub.list.push(inner[k]); inner[k].comp = sub; }
            sub.sync();
            var pl = new Layer(nm, { source: sub });
            self.list.splice(idx[0] - 1, 0, pl);
            pl.comp = self;
            self.sync();
            return sub;
        }
    };
    for (var i = 0; i < layers.length; i++) { this.list.push(layers[i]); layers[i].comp = this; }
    this.sync();
}
CompItem.prototype.layer = function (i) { return this.list[i - 1]; };
CompItem.prototype.take = function (l) {
    var out = [];
    for (var i = 0; i < this.list.length; i++) if (this.list[i] !== l) out.push(this.list[i]);
    this.list = out;
    this.sync();
};
CompItem.prototype.sync = function () {
    this.numLayers = this.list.length;
    for (var i = 0; i < this.list.length; i++) this.list[i].index = i + 1;
};
function namesOf(comp) { var out = []; for (var i = 0; i < comp.list.length; i++) out.push(comp.list[i].name); return out.join(","); }

var app = {
    project: { activeItem: null },
    beginUndoGroup: function (n) { undo.push("begin " + n); },
    endUndoGroup: function () { undo.push("end"); }
};

eval(load("json2.js"));
eval(load("lazylord.jsx"));
eval(load("ae.jsx"));

WScript.Echo("LazyLord - After Effects precomp helpers");
WScript.Echo("");

// Precompose
(function () {
    var a = new Layer("A"), b = new Layer("B"), c = new Layer("C");
    var comp = new CompItem("Main", [a, b, c]);
    app.project.activeItem = comp;
    comp.selectedLayers = [c, b];
    undo = [];
    var r = JSON.parse(LazyLord.precomposeSelection());
    ok("precompose: the selected layers, in stack order, attributes moved", comp.precomposed &&
       comp.precomposed.idx === "2,3" && comp.precomposed.move === true, JSON.stringify(comp.precomposed));
    ok("precompose: named after the selection and reported", r.ok && comp.precomposed.name === "Precomp of 2 layers" &&
       r.message.indexOf("Precomposed 2 layers") === 0, r.message);
    ok("precompose: one undo step", undo.join("|") === "begin LazyLord Precompose|end", undo.join("|"));

    comp.selectedLayers = [];
    r = JSON.parse(LazyLord.precomposeSelection());
    ok("precompose: nothing selected is explained, nothing done", !r.ok && r.message.indexOf("select the layers") > 0, r.message);
})();

// Decompose
(function () {
    var s1 = new Layer("S1", { opacity: 80 }), s2 = new Layer("S2");
    var sub = new CompItem("Card", [s1, s2]);
    var x = new Layer("X"), y = new Layer("Y");
    var pl = new Layer("Card", { source: sub, opacity: 50, startTime: 2, effects: 1 });
    var comp = new CompItem("Main", [x, pl, y]);
    app.project.activeItem = comp;
    comp.selectedLayers = [pl];
    var r = JSON.parse(LazyLord.decomposeSelection());
    ok("decompose: contents take the precomp layer's place in the stack, in order",
       namesOf(comp) === "X,S1,S2,Y", namesOf(comp));
    ok("decompose: the helper null and the precomp layer are gone", namesOf(comp).indexOf("Null") < 0 && pl.comp === null);
    ok("decompose: each copy went through the null and was let go again",
       comp.layer(2).jumpedTo === "Null" && comp.layer(2).parent === null && comp.layer(3).jumpedTo === "Null");
    ok("decompose: the precomp layer's opacity multiplies in",
       comp.layer(2).property("ADBE Transform Group").property("ADBE Opacity").value === 40 &&
       comp.layer(3).property("ADBE Transform Group").property("ADBE Opacity").value === 50);
    ok("decompose: the precomp layer's start time carries over", comp.layer(2).startTime === 2);
    ok("decompose: reported, with what did not carry", r.ok && r.message.indexOf("into 2 layers") > 0 && r.message.indexOf("effects") > 0, r.message);

    // A copy After Effects refuses: the comp is left as it was.
    var t1 = new Layer("T1"), t2 = new Layer("T2");
    var sub2 = new CompItem("Box", [t1, t2]);
    var pl2 = new Layer("Box", { source: sub2 });
    var comp2 = new CompItem("Main", [pl2]);
    app.project.activeItem = comp2;
    comp2.selectedLayers = [pl2];
    failCopyOf = "T2";
    r = JSON.parse(LazyLord.decomposeSelection());
    failCopyOf = null;
    ok("decompose: a failed copy undoes itself and says so", !r.ok && namesOf(comp2) === "Box" && r.message.indexOf("did not copy") > 0,
       namesOf(comp2) + " / " + r.message);

    comp2.selectedLayers = [new Layer("Plain")];
    r = JSON.parse(LazyLord.decomposeSelection());
    ok("decompose: no precomp selected is explained", !r.ok && r.message.indexOf("precomp layer") > 0, r.message);
})();

// Import PSD
(function () {
    function File(path) { this.fsName = path; this.name = path.replace(/^.*[\\\/]/, ""); this.exists = path.indexOf("missing") < 0; }
    File.openDialog = function () { return null; };
    function ImportOptions(f) { this.file = f; }
    var ImportAsType = { COMP: "comp", COMP_CROPPED_LAYERS: "cropped" };
    var imported = null, opened = false;
    app.project.importFile = function (io) {
        imported = io;
        var c = new CompItem(io.file.name.replace(/\.psd$/, ""), []);
        c.openInViewer = function () { opened = true; };
        return c;
    };
    // The host names these globally.
    this.File = File; this.ImportOptions = ImportOptions; this.ImportAsType = ImportAsType;
    undo = [];
    var r = JSON.parse(LazyLord.importPsd("C:\\art\\Poster.psd"));
    ok("psd: imported as a composition keeping layer sizes, and opened",
       r.ok && imported && imported.importAs === "cropped" && opened && r.message.indexOf("'Poster'") > 0, r.message);
    ok("psd: one undo step", undo.join("|") === "begin LazyLord Import PSD|end", undo.join("|"));
    r = JSON.parse(LazyLord.importPsd("C:\\art\\missing.psd"));
    ok("psd: a file that is gone is explained", !r.ok && r.message.indexOf("not there") > 0, r.message);
    r = JSON.parse(LazyLord.importPsd(""));
    ok("psd: a cancelled file dialog does nothing", !r.ok && r.message === "No file chosen.", r.message);
})();

WScript.Echo("");
WScript.Echo(passed + " passed, " + failed + " failed.");
WScript.Quit(failed === 0 ? 0 : 1);
