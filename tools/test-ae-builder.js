/*
 * LazyLord — After Effects builder tests (no Node required).
 *
 *   cscript //Nologo tools\test-ae-builder.js
 *
 * Runs the real jsx/ae.jsx against a mocked After Effects DOM under Windows
 * Script Host, whose JScript engine is ES3 like ExtendScript. The mock records
 * the property tree the builder writes (addProperty / setValue), so these tests
 * pin down what is otherwise only visible on screen: Gradient Ramp points and
 * colours in comp space, clip masks carried through each layer type's
 * transform, mask modes for even-odd and nonzero, live rect/ellipse shapes,
 * rotation pivots, stroke-over-fill paint order, fonts by PostScript name,
 * composition sizing, the project asset folder, and the transfer options:
 * groups flattened or rebuilt as
 * parenting nulls, and vectors split into layers or combined into one shape
 * layer (nested vector groups for IR groups).
 *
 * Like After Effects, the mock invalidates property references when a property
 * is added to (or removed from) a layer, so code that keeps using a stale
 * reference fails here with "Object is invalid" as it would in AE.
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

// Returns cleaned source; eval at GLOBAL scope so `var` becomes global.
function load(name) {
    return read(JSX + name).replace(/^\s*#[a-zA-Z].*$/gm, "");
}

// --- A tiny file system ----------------------------------------------------
var mockFiles = {};   // normalised path -> true
var mockDirs = {};    // normalised path -> true
var copies = [];      // { from, to }
var foldersCreated = [];

function norm(p) { return String(p).replace(/\\/g, "/").replace(/\/+$/, ""); }
function dirOf(p) { return norm(p).replace(/\/[^\/]*$/, ""); }

function File(path) {
    this.fsName = norm(path);
    this.name = this.fsName.replace(/^.*\//, "");
    this.exists = !!mockFiles[this.fsName];
    this.parent = new Folder(dirOf(this.fsName));
}
File.prototype.copy = function (target) {
    var to = norm(typeof target === "string" ? target : target.fsName);
    if (!mockFiles[this.fsName] || !mockDirs[dirOf(to)]) return false;
    mockFiles[to] = true;
    copies.push({ from: this.fsName, to: to });
    return true;
};

function Folder(path) {
    this.fsName = norm(path);
    this.exists = !!mockDirs[this.fsName];
}
Folder.prototype.create = function () {
    mockDirs[this.fsName] = true;
    foldersCreated.push(this.fsName);
    return true;
};

// --- Minimal After Effects stand-ins ---------------------------------------
function CompItem() {}
function ShapeLayer() {}
function TextLayer() {}
function AVLayer() {}
function Shape() {}
function ImportOptions(file) { this.file = file; }

var MaskMode = { NONE: "NONE", ADD: "ADD", SUBTRACT: "SUBTRACT", INTERSECT: "INTERSECT", DIFFERENCE: "DIFFERENCE" };
/** After Effects' blend modes, by the names the scripting guide gives them. */
var BlendingMode = {
    NORMAL: "NORMAL", MULTIPLY: "MULTIPLY", SCREEN: "SCREEN", OVERLAY: "OVERLAY",
    DARKEN: "DARKEN", LIGHTEN: "LIGHTEN", CLASSIC_COLOR_DODGE: "CLASSIC_COLOR_DODGE",
    CLASSIC_COLOR_BURN: "CLASSIC_COLOR_BURN", HARD_LIGHT: "HARD_LIGHT", SOFT_LIGHT: "SOFT_LIGHT",
    DIFFERENCE: "DIFFERENCE", EXCLUSION: "EXCLUSION", HUE: "HUE", SATURATION: "SATURATION",
    COLOR: "COLOR", LUMINOSITY: "LUMINOSITY"
};
var ParagraphJustification = {
    LEFT_JUSTIFY: "l",
    CENTER_JUSTIFY: "c",
    RIGHT_JUSTIFY: "r",
    FULL_JUSTIFY_LASTLINE_LEFT: "fl"
};

// Knobs individual tests flip to simulate host differences.
//   invalidate  - model AE's reference invalidation (on unless a test turns it off)
//   failSet     - { matchName: n }: the n-th setValue on that property throws
//   rejectRemove - { matchName: true }: remove() on that property throws
//   rejectNull  - comp.layers.addNull() throws
var mock = { rejectAdd: {}, rejectRemove: {}, rampWithoutMatchNames: false, invalidate: true, failSet: {}, setCounts: {},
             rejectNull: false };

// Fonts the mocked After Effects has, by PostScript name: [family, style].
var MOCK_FONTS = {
    "ArialMT": ["Arial", "Regular"],
    "Inter-Regular": ["Inter", "Regular"],
    "Inter-SemiBold": ["Inter", "Semi Bold"],
    "Roboto": ["Roboto", "Regular"],
    "BrandSansWeb-Bd": ["Brand Sans", "Bold"]
};

// Groups and the children AE creates inside them. Only names listed here can
// be passed to addProperty, as in AE; anything else is a leaf property.
var SCHEMA = {
    "ADBE Root Vectors Group": [],
    "ADBE Vectors Group": [],
    "ADBE Effect Parade": [],
    "ADBE Mask Parade": [],
    "ADBE Vector Group": ["ADBE Vector Transform Group", "ADBE Vectors Group"],
    "ADBE Vector Transform Group": ["ADBE Vector Anchor", "ADBE Vector Position", "ADBE Vector Scale", "ADBE Vector Skew",
        "ADBE Vector Skew Axis", "ADBE Vector Rotation", "ADBE Vector Group Opacity"],
    "ADBE Vector Shape - Group": ["ADBE Vector Shape"],
    "ADBE Vector Shape - Rect": ["ADBE Vector Rect Size", "ADBE Vector Rect Position", "ADBE Vector Rect Roundness"],
    "ADBE Vector Shape - Ellipse": ["ADBE Vector Ellipse Size", "ADBE Vector Ellipse Position"],
    "ADBE Vector Graphic - Fill": ["ADBE Vector Fill Rule", "ADBE Vector Fill Color", "ADBE Vector Fill Opacity"],
    "ADBE Vector Graphic - Stroke": ["ADBE Vector Stroke Color", "ADBE Vector Stroke Opacity", "ADBE Vector Stroke Width",
        "ADBE Vector Stroke Line Cap", "ADBE Vector Stroke Line Join"],
    "ADBE Ramp": ["ADBE Ramp-0001", "ADBE Ramp-0002", "ADBE Ramp-0003", "ADBE Ramp-0004",
        "ADBE Ramp-0005", "ADBE Ramp-0006", "ADBE Ramp-0007"],
    "ADBE Drop Shadow": ["ADBE Drop Shadow-0001", "ADBE Drop Shadow-0002", "ADBE Drop Shadow-0003",
        "ADBE Drop Shadow-0004", "ADBE Drop Shadow-0005", "ADBE Drop Shadow-0006"],
    "ADBE Gaussian Blur 2": ["ADBE Gaussian Blur 2-0001", "ADBE Gaussian Blur 2-0002", "ADBE Gaussian Blur 2-0003"],
    "ADBE Mask Atom": ["ADBE Mask Shape", "ADBE Mask Feather", "ADBE Mask Opacity", "ADBE Mask Offset"],
    "ADBE Transform Group": ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Opacity"],
    "ADBE Text Properties": ["ADBE Text Document"]
};

var DEFAULTS = {
    "ADBE Anchor Point": [0, 0], "ADBE Position": [0, 0], "ADBE Scale": [100, 100],
    "ADBE Rotate Z": 0, "ADBE Opacity": 100,
    "ADBE Vector Anchor": [0, 0], "ADBE Vector Position": [0, 0], "ADBE Vector Scale": [100, 100],
    "ADBE Vector Skew": 0, "ADBE Vector Skew Axis": 0, "ADBE Vector Rotation": 0, "ADBE Vector Group Opacity": 100
};

function PNode(matchName, parent) {
    this.matchName = matchName;
    this.name = matchName;
    this.value = DEFAULTS[matchName];
    this.children = [];
    this.parent = parent || null;
    this.layer = parent ? parent.layer : null;
    this.removed = false;
    this.invalid = false;
    this.propertyIndex = 0;
    this.numProperties = 0;
    // Keyframes: a property with any is animated, and only takes timed values.
    this.keys = [];
    this.numKeys = 0;
}
function stale(n) { if (n.invalid) throw new Error("Object is invalid"); }
function renumber(n) {
    for (var i = 0; i < n.children.length; i++) n.children[i].propertyIndex = i + 1;
    n.numProperties = n.children.length;
}
PNode.prototype.property = function (key) {
    stale(this);
    if (typeof key === "number") return this.children[key - 1] || null;
    for (var i = 0; i < this.children.length; i++) {
        var c = this.children[i];
        if (c.matchName === key || c.name === key) return c;
    }
    return null;
};
PNode.prototype.addProperty = function (mn) {
    stale(this);
    if (mock.rejectAdd[mn]) throw new Error("After Effects refused to add " + mn);
    if (!SCHEMA[mn]) throw new Error("Cannot add property " + mn);
    var n = makeNode(mn, this);
    this.children.push(n);
    renumber(this);
    invalidateAround(this, n);
    return n;
};
PNode.prototype.setValue = function (v) {
    stale(this);
    // After Effects refuses a plain value on an animated property.
    if (this.numKeys > 0) throw new Error("Cannot set value of a property with keyframes");
    var count = mock.setCounts[this.matchName] = (mock.setCounts[this.matchName] || 0) + 1;
    if (mock.failSet[this.matchName] === count) throw new Error("After Effects could not set " + this.matchName);
    if (this.matchName === "ADBE Text Document") resolveFont(this, v);
    this.value = v;
    this.wasSet = true;
};
PNode.prototype.setValueAtTime = function (t, v) {
    stale(this);
    if (this.matchName === "ADBE Text Document") resolveFont(this, v);
    this.value = v;
    this.wasSet = true;
    this.keys.push({ time: t, value: v });
    this.numKeys = this.keys.length;
};
PNode.prototype.remove = function () {
    stale(this);
    if (mock.rejectRemove[this.matchName]) throw new Error("After Effects could not remove " + this.matchName);
    var p = this.parent;
    for (var i = 0; i < p.children.length; i++) if (p.children[i] === this) { p.children.splice(i, 1); break; }
    this.removed = true;
    renumber(p);
    invalidateAround(p, null);
    this.invalid = true;
};

/*
 * AE recreates an indexed group when a property is added to it, invalidating
 * existing references to properties (PropertyGroup.addProperty in the scripting
 * guide). The group itself and its ancestors stay usable — the guide's own
 * example keeps using the group — and so does the property just added. Every
 * other reference on the layer goes stale, other groups included: AE does not
 * document how far it reaches, so the mock takes the strict reading. Removing
 * a property is treated the same way.
 */
function invalidateAround(group, fresh) {
    if (!mock.invalidate || !group.layer) return;
    var keep = [];
    for (var a = group; a; a = a.parent) keep.push(a);
    var groups = group.layer.groups;
    for (var k in groups) groups[k] = cloneTree(groups[k], null, keep, fresh);
}
function isIn(list, x) { for (var i = 0; i < list.length; i++) if (list[i] === x) return true; return false; }
function cloneTree(n, parent, keep, fresh) {
    var c = n;
    if (n !== fresh && !isIn(keep, n)) {
        c = new PNode(n.matchName, parent);
        c.name = n.name; c.value = n.value; c.wasSet = n.wasSet; c.maskMode = n.maskMode;
        c.fontState = n.fontState; c.layer = n.layer; c.removed = n.removed;
        n.invalid = true;
    }
    c.parent = parent;
    if (n === fresh) return c; // just added: nothing below it has been handed out yet
    var out = [];
    for (var i = 0; i < n.children.length; i++) out.push(cloneTree(n.children[i], c, keep, fresh));
    c.children = out;
    renumber(c);
    return c;
}
function setLayer(n, l) {
    n.layer = l;
    for (var i = 0; i < n.children.length; i++) setLayer(n.children[i], l);
}

/*
 * After Effects picks a text font by PostScript name (TextDocument.font) and
 * ignores a name it does not have, keeping the font it had; the read-only
 * fontFamily / fontStyle follow the font actually in use.
 */
function resolveFont(node, td) {
    var st = node.fontState || { font: "ArialMT", family: "Arial", style: "Regular" };
    var f = MOCK_FONTS[td.font];
    if (td.font !== st.font && f) st = { font: td.font, family: f[0], style: f[1] };
    node.fontState = st;
    td.font = st.font; td.fontFamily = st.family; td.fontStyle = st.style;
}

function makeNode(mn, parent) {
    var n = new PNode(mn, parent);
    var kids = SCHEMA[mn] || [];
    for (var i = 0; i < kids.length; i++) {
        var child = makeNode(kids[i], n);
        if (mn === "ADBE Ramp" && mock.rampWithoutMatchNames) { child.matchName = ""; child.name = ""; }
        n.children.push(child);
    }
    renumber(n);
    if (mn === "ADBE Mask Atom") n.maskMode = MaskMode.ADD;
    return n;
}

/** app.fonts as After Effects 24+ has it: fonts by family and style name. */
var mockFontsApi = {
    getFontsByFamilyNameAndStyleName: function (family, style) {
        var out = [];
        for (var ps in MOCK_FONTS) {
            if (MOCK_FONTS[ps][0] === family && MOCK_FONTS[ps][1] === style) {
                out.push({ postScriptName: ps, familyName: family, styleName: style });
            }
        }
        return out;
    }
};

function TextDocument(text) {
    this.text = text;
    this.fontSize = 12;
    this.font = "ArialMT";
    this.fontFamily = "Arial";
    this.fontStyle = "Regular";
}
TextDocument.prototype.resetCharStyle = function () {};

function makeLayer(Ctor, comp, groups) {
    var l = new Ctor();
    l.name = "";
    l.removed = false;
    // Layer.parent. Assigning it in AE offsets the child's values so nothing
    // moves (scripting guide, Layer.parent); the mock keeps the raw values,
    // which are therefore the comp-space placement the builder wrote.
    l.parent = null;
    l.groups = {
        "ADBE Transform Group": makeNode("ADBE Transform Group"),
        "ADBE Effect Parade": makeNode("ADBE Effect Parade"),
        "ADBE Mask Parade": makeNode("ADBE Mask Parade")
    };
    for (var k in groups) l.groups[k] = groups[k];
    for (var g in l.groups) setLayer(l.groups[g], l);
    l.comment = ""; // where a layer records the source object it was built from
    l.property = function (key) { return this.groups[key] || null; };
    l.remove = function () {
        for (var i = 0; i < comp.list.length; i++) if (comp.list[i] === this) { comp.list.splice(i, 1); break; }
        this.removed = true;
        comp.syncCount();
    };
    comp.list.unshift(l); // new layers go on top, as in AE
    comp.syncCount();
    return l;
}

function makeComp(name, w, h) {
    var c = new CompItem();
    c.name = name; c.width = w; c.height = h;
    c.duration = 10;
    c.list = [];
    c.nullDurations = [];
    c.time = 0;              // the playhead, where update keys are written
    c.numLayers = 0;
    c.syncCount = function () { c.numLayers = c.list.length; };
    c.layer = function (i) { return c.list[i - 1] || null; };
    c.layers = {
        addNull: function (duration) {
            if (mock.rejectNull) throw new Error("After Effects could not add a null object");
            var l = makeLayer(AVLayer, c, {});
            l.nullLayer = true;
            c.nullDurations.push(duration);
            return l;
        },
        addShape: function () {
            return makeLayer(ShapeLayer, c, { "ADBE Root Vectors Group": makeNode("ADBE Root Vectors Group") });
        },
        addText: function (text) {
            var tp = makeNode("ADBE Text Properties");
            tp.property("ADBE Text Document").value = new TextDocument(text);
            return makeLayer(TextLayer, c, { "ADBE Text Properties": tp });
        },
        add: function (footage) {
            var l = makeLayer(AVLayer, c, {});
            l.source = footage;
            return l;
        }
    };
    return c;
}

var app = {
    undo: [],
    compsAdded: [],
    imports: [],
    footageSize: [200, 100],
    project: {
        activeItem: null,
        file: null,
        items: {
            addComp: function (name, w, h, pa, dur, fps) {
                var c = makeComp(name, w, h);
                app.compsAdded.push({ name: name, width: w, height: h });
                return c;
            }
        },
        importFile: function (io) {
            app.imports.push(io.file.fsName);
            return { name: "", width: app.footageSize[0], height: app.footageSize[1], file: io.file };
        }
    },
    beginUndoGroup: function (n) { app.undo.push("begin:" + n); },
    endUndoGroup: function () { app.undo.push("end"); }
};

// --- Load the real code (global scope) -------------------------------------
eval(load("json2.js"));
eval(load("lazylord.jsx"));
eval(load("ae.jsx"));

// --- IR builders -------------------------------------------------------------
function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push([0, 0]); return a; }

function rectSub(x, y, w, h, reverse) {
    var v = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    if (reverse) v = [[x, y], [x, y + h], [x + w, y + h], [x + w, y]];
    return { closed: true, vertices: v, inTangents: zeros(4), outTangents: zeros(4) };
}

function rgba(r, g, b, a) { return { r: r, g: g, b: b, a: a === undefined ? 1 : a }; }
function solid(r, g, b, a) { return { type: "solid", color: rgba(r, g, b, a) }; }
function stop(p, c) { return { position: p, color: c }; }
function linear(stops, from, to) { return { type: "linear-gradient", stops: stops, from: from, to: to }; }
function radial(stops, from, to) { return { type: "radial-gradient", stops: stops, from: from, to: to }; }

function vector(name, frame, opts) {
    opts = opts || {};
    return {
        id: name, name: name, type: "vector", frame: frame,
        subpaths: opts.subpaths || [rectSub(0, 0, frame.width, frame.height)],
        fills: opts.fills || [solid(1, 0, 0)],
        strokes: opts.strokes || [],
        windingRule: opts.windingRule,
        primitive: opts.primitive,
        clip: opts.clip,
        blendMode: opts.blendMode,
        effects: opts.effects
    };
}

function textLayer(name, frame, opts) {
    opts = opts || {};
    var l = {
        id: name, name: name, type: "text", frame: frame, characters: "Hello",
        fontFamily: opts.fontFamily || "Inter", fontStyle: opts.fontStyle || "Regular", fontSize: 20,
        color: opts.color || rgba(0, 0, 0),
        clip: opts.clip
    };
    if (opts.align) l.textAlignHorizontal = opts.align;
    if (opts.baseline !== undefined) l.baseline = opts.baseline;
    if (opts.anchorX !== undefined) l.anchorX = opts.anchorX;
    return l;
}

function imageLayer(name, frame, path, original, clip) {
    return {
        id: name, name: name, type: "image", frame: frame, filePath: path,
        isOriginalFile: original, pixelWidth: 200, pixelHeight: 100, clip: clip
    };
}

function group(name, frame, children) {
    return { id: name, name: name, type: "group", frame: frame, children: children };
}

function irDoc(layers, extra) {
    var d = {
        version: "1.0", source: "figma", name: "Doc",
        bounds: { x: 0, y: 0, width: 500, height: 400 },
        originSpace: "canvas", layers: layers
    };
    if (extra) for (var k in extra) d[k] = extra[k];
    return d;
}

/** Build into a fresh comp (or a new one when opts.newComp) and collect the results. */
function build(doc, opts) {
    opts = opts || {};
    LazyLord.resetDiagnostics();
    app.undo = []; app.compsAdded = []; app.imports = [];
    mock.rejectAdd = opts.rejectAdd || {};
    mock.rampWithoutMatchNames = !!opts.rampWithoutMatchNames;
    mock.invalidate = opts.invalidate !== false;
    mock.failSet = opts.failSet || {};
    mock.rejectRemove = opts.rejectRemove || {};
    mock.rejectNull = !!opts.rejectNull;
    mock.setCounts = {};
    app.fonts = opts.fonts || undefined;
    // opts.comp reuses a comp from an earlier build, so a second transfer can
    // find what the first one left behind.
    var comp = opts.comp || (opts.newComp ? null : makeComp("Active", 1920, 1080));
    app.project.activeItem = comp;
    var res = LazyLord.build(doc);
    return { res: res, comp: comp, diags: LazyLord.diagnostics };
}

// --- Tree queries ------------------------------------------------------------
function findIn(node, mn) {
    if (!node) return null;
    if (node.matchName === mn) return node;
    for (var i = 0; i < node.children.length; i++) {
        var r = findIn(node.children[i], mn);
        if (r) return r;
    }
    return null;
}
function countIn(node, mn) {
    if (!node) return 0;
    var n = node.matchName === mn ? 1 : 0;
    for (var i = 0; i < node.children.length; i++) n += countIn(node.children[i], mn);
    return n;
}
// Null-safe, so a layer the builder failed to make shows up as FAILs, not a crash.
function contents(l) { return l ? l.property("ADBE Root Vectors Group") : null; }
function effects(l) { return l ? l.property("ADBE Effect Parade").children : []; }
function masks(l) { return l ? l.property("ADBE Mask Parade").children : []; }
function tval(l, mn) { return l ? l.property("ADBE Transform Group").property(mn).value : null; }
function rampVal(fx, i) { return (fx && fx.children[i - 1]) ? fx.children[i - 1].value : null; }
function diagsMatching(diags, re) {
    var out = [];
    for (var i = 0; i < diags.length; i++) if (re.test(diags[i].reason)) out.push(diags[i]);
    return out;
}

// --- Assertions ------------------------------------------------------------
var passed = 0, failed = 0;

function ok(name, cond, detail) {
    if (cond) { WScript.Echo("  ok   " + name); passed++; }
    else { WScript.Echo("  FAIL " + name + (detail ? "  -> " + detail : "")); failed++; }
}
function near(a, b, eps) { return Math.abs(a - b) < (eps || 1e-6); }
function nearPt(p, q, eps) { return !!p && !!q && near(p[0], q[0], eps) && near(p[1], q[1], eps); }
function nearArr(p, q) {
    if (!p || !q || p.length !== q.length) return false;
    for (var i = 0; i < p.length; i++) if (!near(p[i], q[i])) return false;
    return true;
}
function nearPts(ps, qs) {
    if (!ps || ps.length !== qs.length) return false;
    for (var i = 0; i < ps.length; i++) if (!nearPt(ps[i], qs[i])) return false;
    return true;
}
function xy(p) { return p ? "[" + p.join(",") + "]" : String(p); }
function vlist(vs) {
    var out = [];
    for (var i = 0; i < (vs ? vs.length : 0); i++) out.push(xy(vs[i]));
    return out.join(" ");
}
function dump(diags) { return JSON.stringify(diags); }

/** The vector groups directly inside a Contents node, frontmost (first) first. */
function vgroups(node) {
    var out = [];
    for (var i = 0; node && i < node.children.length; i++) {
        if (node.children[i].matchName === "ADBE Vector Group") out.push(node.children[i]);
    }
    return out;
}
function inside(grp) { return grp ? grp.property("ADBE Vectors Group") : null; }
function gval(grp, mn) { return grp ? grp.property("ADBE Vector Transform Group").property(mn).value : null; }
function names(list) {
    var out = [];
    for (var i = 0; list && i < list.length; i++) out.push(list[i].name);
    return out.join(",");
}
function nullsIn(comp) {
    var n = 0;
    for (var i = 0; i < comp.list.length; i++) if (comp.list[i].nullLayer === true) n++;
    return n;
}

/** Forward AE layer transform, T(p)·R(r)·S(s)·T(-a), to check masks round-trip. */
function toComp(l, pt) {
    var a = tval(l, "ADBE Anchor Point"), p = tval(l, "ADBE Position");
    var s = tval(l, "ADBE Scale"), r = tval(l, "ADBE Rotate Z") * Math.PI / 180;
    var x = (pt[0] - a[0]) * s[0] / 100, y = (pt[1] - a[1]) * s[1] / 100;
    return [p[0] + x * Math.cos(r) - y * Math.sin(r), p[1] + x * Math.sin(r) + y * Math.cos(r)];
}

WScript.Echo("LazyLord - After Effects builder (mocked DOM)");
WScript.Echo("");

// 1) A linear gradient becomes a solid fill plus a Gradient Ramp. Shape layers
//    render effects after the transform, so the ramp's points are comp space.
(function () {
    var frame = { x: 10, y: 20, width: 100, height: 50 };
    var fill = linear([stop(0.2, rgba(1, 0, 0)), stop(0.8, rgba(0, 0, 1))], { x: 0, y: 0.5 }, { x: 1, y: 0.5 });
    var r = build(irDoc([vector("Bar", frame, { fills: [fill] })]));
    var l = r.comp.list[0];
    var fx = effects(l);

    ok("linear: one shape layer", r.comp.list.length === 1 && l instanceof ShapeLayer, String(r.comp.list.length));
    ok("linear: a Gradient Ramp effect", fx.length === 1 && fx[0].matchName === "ADBE Ramp", fx.length && fx[0].matchName);
    ok("linear: no scripted G-Fill", countIn(contents(l), "ADBE Vector Graphic - G-Fill") === 0);
    ok("linear: start at the first stop, in comp space", nearPt(rampVal(fx[0], 1), [30, 45]), xy(rampVal(fx[0], 1)));
    ok("linear: end at the last stop, in comp space", nearPt(rampVal(fx[0], 3), [90, 45]), xy(rampVal(fx[0], 3)));
    ok("linear: start colour is the first stop (RGBA 0..1)", nearArr(rampVal(fx[0], 2), [1, 0, 0, 1]), xy(rampVal(fx[0], 2)));
    ok("linear: end colour is the last stop", nearArr(rampVal(fx[0], 4), [0, 0, 1, 1]), xy(rampVal(fx[0], 4)));
    ok("linear: ramp shape linear", rampVal(fx[0], 5) === 1, String(rampVal(fx[0], 5)));
    ok("linear: no scatter, no blend with original", rampVal(fx[0], 6) === 0 && rampVal(fx[0], 7) === 0);
    var solidFill = findIn(contents(l), "ADBE Vector Graphic - Fill");
    ok("linear: solid fill keeps the layer's pixels in the first stop colour",
       solidFill && nearArr(solidFill.property("ADBE Vector Fill Color").value, [1, 0, 0, 1]) &&
       solidFill.property("ADBE Vector Fill Opacity").value === 100);
    ok("linear: shape layer origin at the frame top-left",
       nearPt(tval(l, "ADBE Position"), [10, 20]) && nearPt(tval(l, "ADBE Anchor Point"), [0, 0]));
    ok("linear: no diagnostics", r.diags.length === 0, dump(r.diags));
})();

// 2) More than two stops: first and last kept (after sorting), the loss reported.
(function () {
    var frame = { x: 0, y: 0, width: 100, height: 100 };
    var fill = linear([
        stop(1, rgba(0, 0, 1, 0.5)), stop(0, rgba(1, 0, 0)), stop(0.3, rgba(0, 1, 0)), stop(0.6, rgba(1, 1, 0))
    ], { x: 0, y: 0 }, { x: 1, y: 1 });
    var r = build(irDoc([vector("Rainbow", frame, { fills: [fill] })]));
    var l = r.comp.list[0];
    var fx = effects(l)[0];

    ok("stops: sorted, so the start colour is the position-0 stop", nearArr(rampVal(fx, 2), [1, 0, 0, 1]), xy(rampVal(fx, 2)));
    ok("stops: end colour is the position-1 stop", nearArr(rampVal(fx, 4), [0, 0, 1, 1]), xy(rampVal(fx, 4)));
    ok("stops: diagonal ramp corner to corner", nearPt(rampVal(fx, 1), [0, 0]) && nearPt(rampVal(fx, 3), [100, 100]),
       xy(rampVal(fx, 1)) + " " + xy(rampVal(fx, 3)));
    var lost = diagsMatching(r.diags, /4 colour stops.*2 stops in between are dropped/);
    ok("stops: '>2 stops' diagnostic names how many were dropped",
       lost.length === 1 && lost[0].resolution === "approximated" && lost[0].object === "Rainbow", dump(r.diags));
    var alpha = diagsMatching(r.diags, /transparency/);
    ok("stops: varying stop alpha reported", alpha.length === 1 && alpha[0].resolution === "approximated", dump(r.diags));
    ok("stops: fill opacity is the average alpha (87.5%)",
       findIn(contents(l), "ADBE Vector Fill Opacity").value === 88, String(findIn(contents(l), "ADBE Vector Fill Opacity").value));
})();

// 3) Radial: centre to the last stop's radius; uniform alpha is exact.
(function () {
    var frame = { x: 100, y: 50, width: 200, height: 100 };
    var fill = radial([stop(0, rgba(1, 1, 1, 0.5)), stop(0.5, rgba(0, 0, 0, 0.5))], { x: 0.5, y: 0.5 }, { x: 1, y: 0.5 });
    var r = build(irDoc([vector("Glow", frame, { fills: [fill] })]));
    var l = r.comp.list[0];
    var fx = effects(l)[0];

    ok("radial: ramp shape radial", rampVal(fx, 5) === 2, String(rampVal(fx, 5)));
    ok("radial: start at the centre, in comp space", nearPt(rampVal(fx, 1), [200, 100]), xy(rampVal(fx, 1)));
    ok("radial: end at half the radius (last stop 0.5)", nearPt(rampVal(fx, 3), [250, 100]), xy(rampVal(fx, 3)));
    ok("radial: shared stop alpha goes to fill opacity",
       findIn(contents(l), "ADBE Vector Fill Opacity").value === 50, String(findIn(contents(l), "ADBE Vector Fill Opacity").value));
    ok("radial: no diagnostics", r.diags.length === 0, dump(r.diags));

    var offset = radial([stop(0.25, rgba(1, 1, 1)), stop(1, rgba(0, 0, 0))], { x: 0.5, y: 0.5 }, { x: 1, y: 0.5 });
    var r2 = build(irDoc([vector("Halo", frame, { fills: [offset] })]));
    ok("radial: an offset first stop is reported", diagsMatching(r2.diags, /25% out from the centre/).length === 1, dump(r2.diags));
})();

// 4) A gradient fill with a stroke: the stroke moves to its own layer above.
(function () {
    var frame = { x: 40, y: 30, width: 120, height: 60 };
    var fill = linear([stop(0, rgba(1, 0, 0)), stop(1, rgba(0, 1, 0))], { x: 0, y: 0 }, { x: 1, y: 0 });
    var clip = { id: "m1", name: "Frame mask", subpaths: [rectSub(40, 30, 60, 60)] };
    var r = build(irDoc([vector("Card", frame, {
        fills: [fill],
        strokes: [{ paint: solid(0, 0, 0), weight: 3, cap: "round", join: "bevel" }],
        primitive: { kind: "rect", x: 0, y: 0, width: 120, height: 60, roundness: 6 },
        subpaths: [rectSub(0, 0, 120, 60)],
        clip: clip
    })]));
    var top = r.comp.list[0], under = r.comp.list[1];

    // layersCreated counts the AE layers actually made, so the stroke layer counts.
    ok("split: two layers for one IR layer, both counted", r.comp.list.length === 2 && r.res.layersCreated === 2,
       r.comp.list.length + " / " + r.res.layersCreated);
    ok("split: stroke layer directly above, named '<name> stroke'", top.name === "Card stroke" && under.name === "Card",
       top.name + " / " + under.name);
    ok("split: fill layer has the ramp but no stroke",
       effects(under).length === 1 && countIn(contents(under), "ADBE Vector Graphic - Stroke") === 0);
    var st = findIn(contents(top), "ADBE Vector Graphic - Stroke");
    ok("split: stroke layer has the stroke, no fill, no ramp",
       st && effects(top).length === 0 && countIn(contents(top), "ADBE Vector Graphic - Fill") === 0);
    ok("split: stroke width, cap and join",
       st && st.property("ADBE Vector Stroke Width").value === 3 &&
       st.property("ADBE Vector Stroke Line Cap").value === 2 && st.property("ADBE Vector Stroke Line Join").value === 3);
    ok("split: same geometry (live rect) on both",
       countIn(contents(top), "ADBE Vector Shape - Rect") === 1 && countIn(contents(under), "ADBE Vector Shape - Rect") === 1);
    ok("split: same transform", nearPt(tval(top, "ADBE Position"), tval(under, "ADBE Position")) &&
       nearPt(tval(top, "ADBE Position"), [40, 30]));
    ok("split: both layers clipped by the same mask",
       masks(top).length === 1 && masks(under).length === 1 &&
       nearPts(masks(top)[0].property("ADBE Mask Shape").value.vertices, masks(under)[0].property("ADBE Mask Shape").value.vertices));
    ok("split: no diagnostics", r.diags.length === 0, dump(r.diags));
})();

// 5) A gradient stroke is flattened to its first stop and reported.
(function () {
    var frame = { x: 0, y: 0, width: 50, height: 50 };
    var r = build(irDoc([vector("Ring", frame, {
        fills: [solid(1, 1, 1)],
        strokes: [{ paint: linear([stop(0, rgba(0, 0, 1)), stop(1, rgba(1, 0, 0))], { x: 0, y: 0 }, { x: 1, y: 0 }), weight: 2 }]
    })]));
    var l = r.comp.list[0];
    var st = findIn(contents(l), "ADBE Vector Graphic - Stroke");

    ok("gradient stroke: stays on one layer", r.comp.list.length === 1 && effects(l).length === 0);
    ok("gradient stroke: first stop colour", st && nearArr(st.property("ADBE Vector Stroke Color").value, [0, 0, 1, 1]));
    ok("gradient stroke: reported", diagsMatching(r.diags, /Gradient stroke/).length === 1, dump(r.diags));
})();

// 6) Clip mask on a shape layer, document-space source: origin shift, layer space.
(function () {
    var frame = { x: 10, y: 20, width: 100, height: 50 };
    var sp = rectSub(0, 0, 60, 40);
    sp.outTangents[0] = [5, 0];
    var clip = { id: "m", name: "Mask A", subpaths: [sp] };
    var r = build(irDoc([vector("Box", frame, { clip: clip })], {
        source: "illustrator", originSpace: "document",
        bounds: { x: 300, y: 200, width: 100, height: 50 },
        canvas: { width: 800, height: 600, name: "Artboard 1" }
    }), { newComp: true });

    ok("comp: new comp sized to the source page", app.compsAdded.length === 1 &&
       app.compsAdded[0].width === 800 && app.compsAdded[0].height === 600, JSON.stringify(app.compsAdded));
    ok("comp: named after the page", app.compsAdded[0].name === "Artboard 1", app.compsAdded[0].name);
})();
(function () {
    var frame = { x: 10, y: 20, width: 100, height: 50 };
    var sp = rectSub(0, 0, 60, 40);
    sp.outTangents[0] = [5, 0];
    var clip = { id: "m", name: "Mask A", subpaths: [sp] };
    var r = build(irDoc([vector("Box", frame, { clip: clip })], {
        source: "illustrator", originSpace: "document",
        bounds: { x: 300, y: 200, width: 100, height: 50 }
    }));
    var l = r.comp.list[0];
    var m = masks(l);
    var shape = m.length ? m[0].property("ADBE Mask Shape").value : null;

    ok("shape mask: layer placed at the page offset", nearPt(tval(l, "ADBE Position"), [310, 220]), xy(tval(l, "ADBE Position")));
    ok("shape mask: one mask named after the clip", m.length === 1 && m[0].name === "Mask A" && m[0].maskMode === MaskMode.ADD,
       m.length && (m[0].name + " " + m[0].maskMode));
    ok("shape mask: vertices in layer space",
       shape && nearPts(shape.vertices, [[-10, -20], [50, -20], [50, 20], [-10, 20]]), shape && vlist(shape.vertices));
    ok("shape mask: tangents unchanged by a pure translation", shape && nearPt(shape.outTangents[0], [5, 0]));
    ok("shape mask: closed", shape && shape.closed === true);
})();

// 7) Rotated text: origin on the rotated baseline anchor; mask through the rotation.
(function () {
    var frame = { x: 0, y: 0, width: 100, height: 20, rotation: 90 };
    var sp = { closed: true, vertices: [[44, -40], [44, 60], [34, -40]],
               inTangents: zeros(3), outTangents: [[0, 0], [0, 10], [0, 0]] };
    var r = build(irDoc([textLayer("Title", frame, { anchorX: 0, baseline: 16,
        clip: { id: "t", name: "Text mask", subpaths: [sp] } })]));
    var l = r.comp.list[0];
    var shape = masks(l)[0].property("ADBE Mask Shape").value;

    ok("text: a text layer", l instanceof TextLayer && l.name === "Title");
    ok("text: position is the rotated text anchor", nearPt(tval(l, "ADBE Position"), [44, -40]), xy(tval(l, "ADBE Position")));
    ok("text: anchor at the origin, rotation carried", nearPt(tval(l, "ADBE Anchor Point"), [0, 0]) &&
       tval(l, "ADBE Rotate Z") === 90, String(tval(l, "ADBE Rotate Z")));
    ok("text: mask vertices un-rotated into layer space",
       nearPts(shape.vertices, [[0, 0], [100, 0], [0, 10]]), vlist(shape.vertices));
    ok("text: mask tangents rotated too", nearPt(shape.outTangents[1], [10, 0]), xy(shape.outTangents[1]));
})();

// 8) Scaled footage: anchor at the footage centre, mask in footage pixels.
(function () {
    mockFiles["C:/art/photo.png"] = true;
    app.footageSize = [200, 100];
    var sp = rectSub(50, 60, 100, 50);
    sp.outTangents[0] = [10, 0];
    var r = build(irDoc([imageLayer("Photo", { x: 50, y: 60, width: 100, height: 50 }, "C:/art/photo.png", true,
        { id: "f", name: "Photo mask", subpaths: [sp] })]));
    var l = r.comp.list[0];
    var shape = masks(l)[0].property("ADBE Mask Shape").value;

    ok("footage: imported from the original file", app.imports.length === 1 && app.imports[0] === "C:/art/photo.png",
       app.imports.join(","));
    ok("footage: anchor at the footage centre, scaled to the frame",
       nearPt(tval(l, "ADBE Anchor Point"), [100, 50]) && nearPt(tval(l, "ADBE Scale"), [50, 50]) &&
       nearPt(tval(l, "ADBE Position"), [100, 85]), xy(tval(l, "ADBE Scale")) + " " + xy(tval(l, "ADBE Position")));
    ok("footage: mask vertices in footage pixels",
       nearPts(shape.vertices, [[0, 0], [200, 0], [200, 100], [0, 100]]), vlist(shape.vertices));
    ok("footage: mask tangent divided by the scale", nearPt(shape.outTangents[0], [20, 0]), xy(shape.outTangents[0]));

    // Rotated and non-uniformly scaled: the mask must land back on the clip.
    app.footageSize = [400, 100];
    var clipSp = { closed: true, vertices: [[70, 65], [130, 80], [90, 105]], inTangents: zeros(3), outTangents: zeros(3) };
    var r2 = build(irDoc([imageLayer("Tilted", { x: 50, y: 60, width: 100, height: 50, rotation: 30 },
        "C:/art/photo.png", true, { id: "g", subpaths: [clipSp] })]));
    var l2 = r2.comp.list[0];
    var v2 = masks(l2)[0].property("ADBE Mask Shape").value.vertices;
    var back = [toComp(l2, v2[0]), toComp(l2, v2[1]), toComp(l2, v2[2])];
    ok("footage: rotated + scaled mask round-trips to the clip", nearPts(back, clipSp.vertices), vlist(back));
    ok("footage: unnamed clip gets a readable mask name", masks(l2)[0].name === "Clip mask", masks(l2)[0].name);
    app.footageSize = [200, 100];
})();

// 9) Mask modes: even-odd, nonzero same direction, nonzero opposite direction.
(function () {
    function modesFor(rule, reverseInner) {
        var clip = { id: "c", name: "Ring", windingRule: rule,
                     subpaths: [rectSub(0, 0, 100, 100), rectSub(25, 25, 50, 50, reverseInner)] };
        var r = build(irDoc([vector("Disc", { x: 0, y: 0, width: 100, height: 100 }, { clip: clip })]));
        var m = masks(r.comp.list[0]);
        return { names: m[0].name + "|" + m[1].name, modes: m[0].maskMode + "," + m[1].maskMode };
    }
    var eo = modesFor("evenodd", false);
    ok("masks: one per contour, numbered", eo.names === "Ring 1|Ring 2", eo.names);
    ok("masks: evenodd -> ADD then DIFFERENCE", eo.modes === "ADD,DIFFERENCE", eo.modes);
    var nzSame = modesFor("nonzero", false);
    ok("masks: nonzero, same winding -> ADD, ADD", nzSame.modes === "ADD,ADD", nzSame.modes);
    var nzOpp = modesFor("nonzero", true);
    ok("masks: nonzero, opposite winding cuts a hole -> ADD, DIFFERENCE", nzOpp.modes === "ADD,DIFFERENCE", nzOpp.modes);
    var eoOpp = modesFor(undefined, true);
    ok("masks: no winding rule is nonzero", eoOpp.modes === "ADD,DIFFERENCE", eoOpp.modes);
})();

// 10) Primitives: live rectangle and ellipse instead of drawn paths.
(function () {
    var r = build(irDoc([
        vector("Button", { x: 0, y: 0, width: 100, height: 50 },
               { primitive: { kind: "rect", x: 0, y: 0, width: 100, height: 50, roundness: 8 } }),
        vector("Dot", { x: 200, y: 0, width: 50, height: 30 },
               { subpaths: [rectSub(5, 5, 40, 20)], primitive: { kind: "ellipse", x: 5, y: 5, width: 40, height: 20 } }),
        vector("Two", { x: 0, y: 100, width: 100, height: 100 },
               { subpaths: [rectSub(0, 0, 100, 100), rectSub(10, 10, 20, 20)],
                 primitive: { kind: "rect", x: 0, y: 0, width: 100, height: 100 } })
    ]));
    var rectL = r.comp.list[2], ellL = r.comp.list[1], twoL = r.comp.list[0];
    var rect = findIn(contents(rectL), "ADBE Vector Shape - Rect");
    var ell = findIn(contents(ellL), "ADBE Vector Shape - Ellipse");

    ok("rect: live rectangle, no drawn path", rect && countIn(contents(rectL), "ADBE Vector Shape - Group") === 0);
    ok("rect: size", rect && nearPt(rect.property("ADBE Vector Rect Size").value, [100, 50]));
    ok("rect: centred position in local space", rect && nearPt(rect.property("ADBE Vector Rect Position").value, [50, 25]));
    ok("rect: roundness", rect && rect.property("ADBE Vector Rect Roundness").value === 8);
    ok("ellipse: live ellipse, no drawn path", ell && countIn(contents(ellL), "ADBE Vector Shape - Group") === 0);
    ok("ellipse: size and centre", ell && nearPt(ell.property("ADBE Vector Ellipse Size").value, [40, 20]) &&
       nearPt(ell.property("ADBE Vector Ellipse Position").value, [25, 15]),
       ell && xy(ell.property("ADBE Vector Ellipse Position").value));
    ok("primitive: ignored when there is more than one contour",
       countIn(contents(twoL), "ADBE Vector Shape - Rect") === 0 && countIn(contents(twoL), "ADBE Vector Shape - Group") === 2);
    var path = findIn(contents(twoL), "ADBE Vector Shape").value;
    ok("paths: drawn contour keeps its local vertices", nearPts(path.vertices, [[0, 0], [100, 0], [100, 100], [0, 100]]),
       vlist(path.vertices));
    ok("primitive: no diagnostics", r.diags.length === 0, dump(r.diags));

    var r2 = build(irDoc([vector("Pill", { x: 0, y: 0, width: 100, height: 50 },
        { primitive: { kind: "rect", x: 0, y: 0, width: 100, height: 50 } })]),
        { rejectAdd: { "ADBE Vector Shape - Rect": true } });
    var l2 = r2.comp.list[0];
    ok("primitive: falls back to the path when the live shape fails",
       countIn(contents(l2), "ADBE Vector Shape - Group") === 1 &&
       diagsMatching(r2.diags, /live rectangle/).length === 1, dump(r2.diags));
})();

// 11) Composition sizing and naming.
(function () {
    build(irDoc([vector("A", { x: 0, y: 0, width: 10, height: 10 })], {
        bounds: { x: 0, y: 0, width: 640, height: 360 }, canvas: { width: 1440, height: 900, name: "Frame 1" }
    }), { newComp: true });
    ok("comp: canvas-space source sized to the selection", app.compsAdded[0].width === 640 && app.compsAdded[0].height === 360,
       JSON.stringify(app.compsAdded));
    ok("comp: named after the canvas when there is one", app.compsAdded[0].name === "Frame 1", app.compsAdded[0].name);

    build(irDoc([vector("A", { x: 0, y: 0, width: 10, height: 10 })], { name: "Page 1" }), { newComp: true });
    ok("comp: otherwise named after the document", app.compsAdded[0].name === "Page 1", app.compsAdded[0].name);

    // Destination: the default builds into the open comp; "new" makes one even so.
    build(irDoc([vector("A", { x: 0, y: 0, width: 10, height: 10 })], { name: "Icon" }));
    ok("destination default: the open comp is used, none is made", app.compsAdded.length === 0, JSON.stringify(app.compsAdded));
    build(irDoc([vector("A", { x: 0, y: 0, width: 10, height: 10 })], {
        name: "Icon", bounds: { x: 0, y: 0, width: 120, height: 80 }, options: { destination: "new" }
    }));
    ok("destination new: a comp is made although one is open, sized and named after the selection",
       app.compsAdded.length === 1 && app.compsAdded[0].name === "Icon" &&
       app.compsAdded[0].width === 120 && app.compsAdded[0].height === 80, JSON.stringify(app.compsAdded));

    var big = build(irDoc([vector("A", { x: 0, y: 0, width: 10, height: 10 })], {
        originSpace: "document", canvas: { width: 40000, height: 2.4 }
    }), { newComp: true });
    ok("comp: clamped to After Effects' 4..30000 px range",
       app.compsAdded[0].width === 30000 && app.compsAdded[0].height === 4, JSON.stringify(app.compsAdded));
    ok("comp: oversize page reported", diagsMatching(big.diags, /30000 px limit/).length === 1, dump(big.diags));

    var active = build(irDoc([vector("A", { x: 0, y: 0, width: 10, height: 10 })]));
    ok("comp: an active comp is reused", app.compsAdded.length === 0 && active.comp.list.length === 1);
})();

// 12) A vector that still carries a rotation turns about its frame centre.
(function () {
    var r = build(irDoc([vector("Legacy", { x: 10, y: 20, width: 100, height: 50, rotation: 45, opacity: 0.5 })]));
    var l = r.comp.list[0];
    ok("legacy rotation: anchor at the box centre", nearPt(tval(l, "ADBE Anchor Point"), [50, 25]), xy(tval(l, "ADBE Anchor Point")));
    ok("legacy rotation: position at the frame centre", nearPt(tval(l, "ADBE Position"), [60, 45]), xy(tval(l, "ADBE Position")));
    ok("legacy rotation: rotation and opacity", tval(l, "ADBE Rotate Z") === 45 && tval(l, "ADBE Opacity") === 50);

    // A gradient on a rotated vector turns with it. The ramp is in comp space,
    // so its handles are turned 30 degrees about the frame centre [60, 45].
    var fill = linear([stop(0, rgba(1, 0, 0)), stop(1, rgba(0, 0, 1))], { x: 0, y: 0.5 }, { x: 1, y: 0.5 });
    var r2 = build(irDoc([vector("Turned", { x: 10, y: 20, width: 100, height: 50, rotation: 30 }, { fills: [fill] })]));
    var fx = effects(r2.comp.list[0])[0];
    var hx = 50 * Math.cos(Math.PI / 6), hy = 50 * Math.sin(Math.PI / 6);
    ok("legacy rotation: ramp points turned with the shape, in comp space",
       nearPt(rampVal(fx, 1), [60 - hx, 45 - hy]) && nearPt(rampVal(fx, 3), [60 + hx, 45 + hy]),
       xy(rampVal(fx, 1)) + " " + xy(rampVal(fx, 3)));

    var r3 = build(irDoc([textLayer("Plain", { x: 5, y: 6, width: 100, height: 20 }, {})]));
    var t = r3.comp.list[0];
    ok("text: unrotated text sits on the estimated baseline",
       nearPt(tval(t, "ADBE Position"), [5, 6 + 16]) && tval(t, "ADBE Rotate Z") === 0, xy(tval(t, "ADBE Position")));
})();

// 13) Unsaved project: generated images stay in temp, reported once.
(function () {
    mockFiles["C:/Temp/lazylord/t1/a.png"] = true;
    mockFiles["C:/Temp/lazylord/t1/b.png"] = true;
    mockFiles["C:/art/logo.png"] = true;
    app.project.file = null;
    copies = [];
    var r = build(irDoc([
        imageLayer("Hero", { x: 0, y: 0, width: 100, height: 50 }, "C:/Temp/lazylord/t1/a.png", false),
        imageLayer("Badge", { x: 0, y: 0, width: 100, height: 50 }, "C:/Temp/lazylord/t1/b.png"),
        imageLayer("Logo", { x: 0, y: 0, width: 100, height: 50 }, "C:/art/logo.png", true)
    ]));
    var proj = [];
    for (var i = 0; i < r.diags.length; i++) if (r.diags[i].object === "Project") proj.push(r.diags[i]);

    ok("unsaved: all three imported", r.res.layersCreated === 3 && app.imports.length === 3, app.imports.join(","));
    ok("unsaved: generated images imported from temp",
       app.imports[0] === "C:/Temp/lazylord/t1/a.png" && app.imports[1] === "C:/Temp/lazylord/t1/b.png");
    ok("unsaved: nothing copied", copies.length === 0);
    ok("unsaved: exactly one 'Project' diagnostic, approximated",
       proj.length === 1 && proj[0].resolution === "approximated" && /not been saved/.test(proj[0].reason), dump(r.diags));
    ok("unsaved: no other diagnostics", r.diags.length === 1, dump(r.diags));
})();

// 14) Saved project: generated images copied beside the .aep, never overwriting.
(function () {
    mockDirs["D:/Work"] = true;
    mockFiles["D:/Work/Film.aep"] = true;
    mockFiles["C:/Temp/lazylord/t2/1_2.png"] = true;
    mockFiles["C:/Temp/lazylord/t2/3_4.png"] = true;
    mockFiles["C:/art/logo.png"] = true;
    app.project.file = new File("D:\\Work\\Film.aep");
    copies = []; foldersCreated = [];

    var r = build(irDoc([
        imageLayer("Hero", { x: 0, y: 0, width: 100, height: 50 }, "C:/Temp/lazylord/t2/1_2.png", false),
        imageLayer("Logo", { x: 0, y: 0, width: 100, height: 50 }, "C:/art/logo.png", true)
    ]));
    ok("saved: asset folder created beside the project", foldersCreated.length === 1 &&
       foldersCreated[0] === "D:/Work/LazyLord Assets", foldersCreated.join(","));
    ok("saved: generated image copied under the layer's name",
       copies.length === 1 && copies[0].to === "D:/Work/LazyLord Assets/Hero.png", JSON.stringify(copies));
    ok("saved: imported from the copy", app.imports[0] === "D:/Work/LazyLord Assets/Hero.png", app.imports[0]);
    ok("saved: the user's own file is imported in place and never copied", app.imports[1] === "C:/art/logo.png");
    ok("saved: no diagnostics", r.diags.length === 0, dump(r.diags));

    // Hero.png now exists; add Hero-1.png too: the next copies must be -2, then -3.
    mockFiles["D:/Work/LazyLord Assets/Hero-1.png"] = true;
    copies = []; foldersCreated = [];
    build(irDoc([
        imageLayer("Hero", { x: 0, y: 0, width: 100, height: 50 }, "C:/Temp/lazylord/t2/1_2.png", false),
        imageLayer("Hero", { x: 0, y: 0, width: 100, height: 50 }, "C:/Temp/lazylord/t2/3_4.png", false)
    ]));
    ok("saved: collision-safe names -2 then -3",
       copies.length === 2 && copies[0].to === "D:/Work/LazyLord Assets/Hero-2.png" &&
       copies[1].to === "D:/Work/LazyLord Assets/Hero-3.png", JSON.stringify(copies));
    ok("saved: existing folder is not re-created", foldersCreated.length === 0);

    // Unsafe characters in the layer name, and a file with no layer name.
    copies = [];
    var unnamed = imageLayer("", { x: 0, y: 0, width: 100, height: 50 }, "C:/Temp/lazylord/t2/3_4.png", false);
    build(irDoc([
        imageLayer("a/b:c?", { x: 0, y: 0, width: 100, height: 50 }, "C:/Temp/lazylord/t2/1_2.png", false),
        unnamed
    ]));
    ok("saved: file names are sanitised, unnamed layers keep the source name",
       copies.length === 2 && copies[0].to === "D:/Work/LazyLord Assets/a_b_c_.png" &&
       copies[1].to === "D:/Work/LazyLord Assets/3_4.png", JSON.stringify(copies));

    // A missing source cannot be copied: reported, and the temp path is tried.
    copies = [];
    var miss = build(irDoc([imageLayer("Gone", { x: 0, y: 0, width: 100, height: 50 }, "C:/Temp/lazylord/t2/missing.png", false)]));
    ok("saved: failed copy falls back to the temp path with a diagnostic",
       copies.length === 0 && app.imports[0] === "C:/Temp/lazylord/t2/missing.png" &&
       diagsMatching(miss.diags, /Could not copy the generated image/).length === 1, dump(miss.diags));
    app.project.file = null;
})();

// 15) Undo group, return shape, and skipped layers.
(function () {
    var r = build(irDoc([
        vector("Ok", { x: 0, y: 0, width: 10, height: 10 }),
        { id: "g", name: "Group", type: "group", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] },
        { id: "i", name: "No file", type: "image", frame: { x: 0, y: 0, width: 1, height: 1 }, pixelWidth: 1, pixelHeight: 1 }
    ]));
    ok("build: one undo group, closed", app.undo.length === 2 && app.undo[0] === "begin:LazyLord Import" && app.undo[1] === "end",
       app.undo.join(","));
    ok("build: return shape", r.res.ok === true && r.res.layersCreated === 1 && r.res.message === "", JSON.stringify(r.res));
    ok("build: unsupported and broken layers reported as skipped",
       r.diags.length === 2 && r.diags[0].object === "Group" && r.diags[0].resolution === "skipped" &&
       r.diags[1].object === "No file" && r.diags[1].resolution === "skipped", dump(r.diags));
})();

// 16) A layer that fails part-way leaves nothing half-built behind.
(function () {
    var fill = linear([stop(0, rgba(1, 0, 0)), stop(1, rgba(0, 1, 0))], { x: 0, y: 0 }, { x: 1, y: 0 });
    var r = build(irDoc([
        vector("Keep", { x: 0, y: 0, width: 10, height: 10 }),
        vector("Broken", { x: 0, y: 0, width: 10, height: 10 },
               { fills: [fill], strokes: [{ paint: solid(0, 0, 0), weight: 1 }] })
    ]), { rejectAdd: { "ADBE Vector Graphic - Stroke": true } });
    ok("cleanup: the failed layer's fill and stroke layers are removed",
       r.comp.list.length === 1 && r.comp.list[0].name === "Keep", String(r.comp.list.length));
    ok("cleanup: reported as skipped", r.res.layersCreated === 1 &&
       r.diags.length === 1 && r.diags[0].object === "Broken" && r.diags[0].resolution === "skipped", dump(r.diags));
})();

// 17) Gradient Ramp fallbacks: by index, then flat colour.
(function () {
    var fill = linear([stop(0, rgba(0, 1, 0)), stop(1, rgba(1, 0, 1))], { x: 0, y: 0 }, { x: 1, y: 0 });
    var frame = { x: 0, y: 0, width: 100, height: 10 };

    var r = build(irDoc([vector("Indexed", frame, { fills: [fill] })]), { rampWithoutMatchNames: true });
    var fx = effects(r.comp.list[0])[0];
    ok("ramp: controls found by index when match names are missing",
       nearPt(fx.children[2].value, [100, 0]) && nearArr(fx.children[3].value, [1, 0, 1, 1]) && r.diags.length === 0,
       dump(r.diags));

    var r2 = build(irDoc([vector("Flat", frame, { fills: [fill] })]), { rejectAdd: { "ADBE Ramp": true } });
    var l2 = r2.comp.list[0];
    ok("ramp: without the effect the fill is the first stop",
       effects(l2).length === 0 &&
       nearArr(findIn(contents(l2), "ADBE Vector Fill Color").value, [0, 1, 0, 1]));
    ok("ramp: flattening reported", diagsMatching(r2.diags, /flat colour from its first stop/).length === 1, dump(r2.diags));
})();

// 18) AE invalidates property references when a property is added, and so does
//     the mock: the fill must be finished with, or found again, around the Ramp.
(function () {
    var frame = { x: 0, y: 0, width: 100, height: 10 };
    var fill = linear([stop(0, rgba(0, 1, 0, 0.4)), stop(1, rgba(1, 0, 1, 0.8))], { x: 0, y: 0 }, { x: 1, y: 0 });

    var r = build(irDoc([vector("Fade", frame, { fills: [fill] })]));
    var l = r.comp.list[0];
    ok("invalidation: a gradient layer survives its Ramp being added",
       r.res.layersCreated === 1 && effects(l).length === 1 && diagsMatching(r.diags, /invalid/).length === 0, dump(r.diags));
    ok("invalidation: fill opacity is the ramp's overall alpha (60%)",
       l && findIn(contents(l), "ADBE Vector Fill Opacity").value === 60);

    // The Ramp is added, then one of its controls fails: the flat fallback puts
    // the first stop's alpha back on the fill through a fresh lookup.
    var r2 = build(irDoc([vector("Half", frame, { fills: [fill] })]), { failSet: { "ADBE Ramp-0003": 1 } });
    var l2 = r2.comp.list[0];
    ok("invalidation: a half-built ramp is removed", l2 && effects(l2).length === 0, dump(r2.diags));
    ok("invalidation: the flat fill gets the first stop's alpha back (40%)",
       l2 && findIn(contents(l2), "ADBE Vector Fill Opacity").value === 40,
       l2 && String(findIn(contents(l2), "ADBE Vector Fill Opacity").value));
    ok("invalidation: flattening reported, layer kept",
       r2.res.layersCreated === 1 && r2.diags.length === 1 &&
       diagsMatching(r2.diags, /flat colour from its first stop/).length === 1, dump(r2.diags));

    var r3 = build(irDoc([vector("Stuck", frame, { fills: [fill] })]),
                   { failSet: { "ADBE Ramp-0003": 1 }, rejectRemove: { "ADBE Ramp": true } });
    ok("ramp: a half-built ramp that cannot be removed is reported",
       diagsMatching(r3.diags, /half-built Gradient Ramp could not be removed/).length === 1, dump(r3.diags));
})();

// 19) A clip that fails part-way comes off completely, removed by index.
(function () {
    var clip = { id: "c", name: "Tri", subpaths: [rectSub(0, 0, 50, 50), rectSub(60, 0, 20, 20), rectSub(0, 60, 20, 20)] };
    var frame = { x: 0, y: 0, width: 100, height: 100 };

    var r = build(irDoc([vector("Cut", frame, { clip: clip })]), { failSet: { "ADBE Mask Shape": 3 } });
    var l = r.comp.list[0];
    ok("clip cleanup: no partial masks left when the third contour fails", l && masks(l).length === 0,
       l && String(masks(l).length));
    var d = diagsMatching(r.diags, /could not be rebuilt as layer masks.*shows unclipped/);
    ok("clip cleanup: reported as unclipped, skipped", d.length === 1 && d[0].resolution === "skipped", dump(r.diags));
    ok("clip cleanup: the layer itself is kept", r.res.layersCreated === 1 && r.comp.list.length === 1);

    var r2 = build(irDoc([vector("Cut", frame, { clip: clip })]),
                   { failSet: { "ADBE Mask Shape": 3 }, rejectRemove: { "ADBE Mask Atom": true } });
    var l2 = r2.comp.list[0];
    var p = diagsMatching(r2.diags, /only partly clipped/);
    ok("clip cleanup: masks that cannot be removed are reported as a partial clip, not as unclipped",
       l2 && masks(l2).length === 3 && p.length === 1 && p[0].resolution === "approximated" &&
       diagsMatching(r2.diags, /shows unclipped/).length === 0, dump(r2.diags));
})();

// 20) Fonts are set by PostScript name and checked against what AE shows.
(function () {
    function tdoc(l) { return l.property("ADBE Text Properties").property("ADBE Text Document").value; }
    var box = { x: 0, y: 0, width: 100, height: 20 };
    var r = build(irDoc([
        textLayer("A", box, {}),
        textLayer("B", box, { fontFamily: "Inter", fontStyle: "Semi Bold" }),
        textLayer("C", box, { fontFamily: "Roboto", fontStyle: "Regular" })
    ]));
    var a = tdoc(r.comp.list[2]), b = tdoc(r.comp.list[1]), c = tdoc(r.comp.list[0]);
    ok("font: family and style become the PostScript name", a.font === "Inter-Regular" && a.fontFamily === "Inter", a.font);
    ok("font: spaces dropped from the style", b.font === "Inter-SemiBold" && b.fontStyle === "Semi Bold", b.font);
    ok("font: a regular face named after its family alone", c.font === "Roboto", c.font);
    ok("font: no diagnostics when every font is found", r.diags.length === 0, dump(r.diags));

    var miss = build(irDoc([textLayer("D", box, { fontFamily: "Brand Sans", fontStyle: "Bold" })]));
    var md = diagsMatching(miss.diags, /Font 'Brand Sans Bold' is not available in After Effects, so 'Arial Regular' is used instead/);
    ok("font: a font AE cannot match is reported with the one it shows",
       md.length === 1 && md[0].resolution === "approximated" && miss.res.layersCreated === 1, dump(miss.diags));

    var api = build(irDoc([textLayer("D", box, { fontFamily: "Brand Sans", fontStyle: "Bold" })]), { fonts: mockFontsApi });
    ok("font: the After Effects 24+ font lookup finds a non-standard PostScript name",
       tdoc(api.comp.list[0]).font === "BrandSansWeb-Bd" && api.diags.length === 0, dump(api.diags));
})();

// 20b) Mixed character styles: characterRange on After Effects 24.3+, one style before.
(function () {
    function tdoc(l) { return l.property("ADBE Text Properties").property("ADBE Text Document").value; }
    var box = { x: 0, y: 0, width: 100, height: 20 };
    var styled = textLayer("Styled", box); // "Hello", 20 px, black
    styled.runs = [{ start: 0, end: 2, fontSize: 30, color: rgba(1, 0, 0) }];

    var r = build(irDoc([styled]));
    ok("runs: older After Effects says the first style is used",
       diagsMatching(r.diags, /24\.3 or newer/).length === 1 && r.res.layersCreated === 1, dump(r.diags));

    TextDocument.prototype.characterRange = function (s, e) {
        var cr = { start: s, end: e };
        (this.ranges = this.ranges || []).push(cr);
        return cr;
    };
    try { r = build(irDoc([styled])); } finally { delete TextDocument.prototype.characterRange; }
    var td = tdoc(r.comp.list[0]);
    ok("runs: one range per stretch, covering the whole text",
       td.ranges && td.ranges.length === 2 && td.ranges[0].start === 0 && td.ranges[0].end === 2 &&
       td.ranges[1].start === 2 && td.ranges[1].end === 5, dump(td.ranges));
    ok("runs: each range takes its run's size and colour, the gap the base style",
       td.ranges[0].fontSize === 30 && nearArr(td.ranges[0].fillColor, [1, 0, 0]) &&
       td.ranges[1].fontSize === 20 && nearArr(td.ranges[1].fillColor, [0, 0, 0]), dump(td.ranges));
    ok("runs: nothing reported when every style applied", diagsMatching(r.diags, /character styles/).length === 0, dump(r.diags));
})();

// 21) Paragraph alignment, and a host that cannot set it.
(function () {
    function tdoc(l) { return l.property("ADBE Text Properties").property("ADBE Text Document").value; }
    var box = { x: 0, y: 0, width: 100, height: 20 };
    var r = build(irDoc([textLayer("Mid", box, { align: "center" })]));
    ok("align: centred", tdoc(r.comp.list[0]).justification === "c" && r.diags.length === 0, dump(r.diags));

    var saved = ParagraphJustification, r2;
    ParagraphJustification = null;
    try { r2 = build(irDoc([textLayer("NoAlign", box, { align: "right" })])); }
    finally { ParagraphJustification = saved; }
    var d = diagsMatching(r2.diags, /Paragraph alignment could not be set/);
    ok("align: a failure is reported and the text is still built",
       d.length === 1 && d[0].resolution === "approximated" && d[0].object === "NoAlign" && r2.res.layersCreated === 1,
       dump(r2.diags));
})();

// 22) Text colour alpha joins the layer opacity (fillColor takes no alpha).
(function () {
    var r = build(irDoc([
        textLayer("Faint", { x: 0, y: 0, width: 100, height: 20 }, { color: rgba(1, 0, 0, 0.5) }),
        textLayer("Fainter", { x: 0, y: 0, width: 100, height: 20, opacity: 0.8 }, { color: rgba(1, 0, 0, 0.5) })
    ]));
    var faint = r.comp.list[1], fainter = r.comp.list[0];
    ok("text alpha: a 50% colour on a full layer gives 50% opacity", tval(faint, "ADBE Opacity") === 50,
       String(tval(faint, "ADBE Opacity")));
    ok("text alpha: multiplied with the layer opacity (80% x 50%)", tval(fainter, "ADBE Opacity") === 40,
       String(tval(fainter, "ADBE Opacity")));
    ok("text alpha: the text colour itself is RGB",
       nearArr(faint.property("ADBE Text Properties").property("ADBE Text Document").value.fillColor, [1, 0, 0]));
    ok("text alpha: exact, so no diagnostics", r.diags.length === 0, dump(r.diags));
})();

// 23) Split fill and stroke layers each carry the layer opacity: reported.
(function () {
    var fill = linear([stop(0, rgba(1, 0, 0)), stop(1, rgba(0, 0, 1))], { x: 0, y: 0 }, { x: 1, y: 0 });
    var r = build(irDoc([vector("Ghost", { x: 0, y: 0, width: 50, height: 50, opacity: 0.5 },
        { fills: [fill], strokes: [{ paint: solid(0, 0, 0), weight: 10 }] })]));
    ok("split opacity: both layers at the layer opacity",
       r.comp.list.length === 2 && tval(r.comp.list[0], "ADBE Opacity") === 50 && tval(r.comp.list[1], "ADBE Opacity") === 50);
    var d = diagsMatching(r.diags, /applied to the fill and the stroke layer separately/);
    ok("split opacity: the see-through is reported, once",
       d.length === 1 && d[0].resolution === "approximated" && d[0].object === "Ghost" && r.diags.length === 1, dump(r.diags));
})();

// 24) A live shape that fails part-way is removed; if it cannot be, that is reported.
(function () {
    var frame = { x: 0, y: 0, width: 40, height: 40 };
    var opts = { primitive: { kind: "ellipse", x: 0, y: 0, width: 40, height: 40 }, subpaths: [rectSub(0, 0, 40, 40)] };
    var r = build(irDoc([vector("Dot", frame, opts)]), { failSet: { "ADBE Vector Ellipse Size": 1 } });
    var l = r.comp.list[0];
    ok("primitive: a half-built live ellipse is replaced by the path",
       countIn(contents(l), "ADBE Vector Shape - Ellipse") === 0 && countIn(contents(l), "ADBE Vector Shape - Group") === 1 &&
       diagsMatching(r.diags, /live ellipse/).length === 1 && r.diags.length === 1, dump(r.diags));

    var r2 = build(irDoc([vector("Dot", frame, opts)]),
                   { failSet: { "ADBE Vector Ellipse Size": 1 }, rejectRemove: { "ADBE Vector Shape - Ellipse": true } });
    ok("primitive: a leftover that cannot be removed is reported",
       diagsMatching(r2.diags, /half-built live ellipse could not be removed/).length === 1, dump(r2.diags));
})();

// 25) hierarchy "flatten" (the default): groups dissolve into their leaves,
//     their opacity multiplied in; a faded group of several layers is reported.
(function () {
    function faded() {
        return irDoc([
            group("Faded", { x: 0, y: 0, width: 100, height: 100, opacity: 0.5 }, [
                vector("A", { x: 0, y: 0, width: 50, height: 50, opacity: 0.8 }),
                vector("B", { x: 50, y: 50, width: 50, height: 50 })
            ]),
            vector("C", { x: 200, y: 0, width: 10, height: 10 })
        ]);
    }
    var r = build(faded());
    var L = r.comp.list, c = L[0], b = L[1], a = L[2];
    ok("flatten: one layer per leaf, stacking kept, no nulls",
       names(L) === "C,B,A" && nullsIn(r.comp) === 0 && r.res.layersCreated === 3 && r.res.message === "",
       names(L) + " " + JSON.stringify(r.res));
    ok("flatten: group opacity multiplied into its layers (50% x 80%, 50%, untouched 100%)",
       tval(a, "ADBE Opacity") === 40 && tval(b, "ADBE Opacity") === 50 && tval(c, "ADBE Opacity") === 100,
       tval(a, "ADBE Opacity") + " " + tval(b, "ADBE Opacity") + " " + tval(c, "ADBE Opacity"));
    ok("flatten: layers placed where they were", nearPt(tval(a, "ADBE Position"), [0, 0]) && nearPt(tval(b, "ADBE Position"), [50, 50]));
    var d = diagsMatching(r.diags, /opacity is applied to each layer inside it/);
    ok("flatten: one approximated diagnostic for the faded group",
       d.length === 1 && d[0].object === "Faded" && d[0].resolution === "approximated" && r.diags.length === 1, dump(r.diags));

    var ex = faded();
    ex.options = { layout: "split", hierarchy: "flatten" };
    var rx = build(ex);
    ok("flatten: explicit split + flatten options build exactly the default",
       names(rx.comp.list) === "C,B,A" && tval(rx.comp.list[2], "ADBE Opacity") === 40 && rx.diags.length === 1 &&
       rx.res.layersCreated === 3, names(rx.comp.list));

    var r2 = build(irDoc([group("Solo", { x: 0, y: 0, width: 10, height: 10, opacity: 0.5 },
        [vector("S", { x: 0, y: 0, width: 10, height: 10 })])]));
    ok("flatten: a faded group of one layer is exact, no diagnostic",
       tval(r2.comp.list[0], "ADBE Opacity") === 50 && r2.diags.length === 0, dump(r2.diags));

    var box = { x: 0, y: 0, width: 10, height: 10 };
    var r3 = build(irDoc([
        group("G1", { x: 0, y: 0, width: 10, height: 10, opacity: 0.5 }, [vector("a", box), vector("b", box)]),
        group("G2", { x: 0, y: 0, width: 10, height: 10, opacity: 0.7 }, [vector("c", box), vector("d", box)])
    ]));
    var d3 = diagsMatching(r3.diags, /2 groups \('G1' and 'G2'\) are faded/);
    ok("flatten: several faded groups share one diagnostic",
       d3.length === 1 && d3[0].resolution === "approximated" && r3.diags.length === 1, dump(r3.diags));

    // A faded group whose only child is a group of several layers (a faded
    // Figma frame around one auto-layout frame): its opacity still reaches the
    // overlapping leaves one by one, so it is reported, as hierarchy "groups"
    // reports the same IR. Counted by leaves, not by direct children.
    // Fresh frames each time: flattening writes the multiplied opacity into them.
    function leaf(name) { return vector(name, { x: 0, y: 0, width: 10, height: 10 }); }
    function wrapped(outerOpacity, innerOpacity, leaves, extra) {
        return irDoc([group("Outer", { x: 0, y: 0, width: 10, height: 10, opacity: outerOpacity }, [
            group("Inner", { x: 0, y: 0, width: 10, height: 10, opacity: innerOpacity }, leaves)
        ])], extra);
    }
    var r4 = build(wrapped(0.5, 1, [leaf("a"), leaf("b")]));
    var d4 = diagsMatching(r4.diags, /opacity is applied to each layer inside it/);
    ok("flatten: a faded group wrapping one group of several layers is reported",
       d4.length === 1 && d4[0].object === "Outer" && d4[0].resolution === "approximated" && r4.diags.length === 1 &&
       tval(r4.comp.list[0], "ADBE Opacity") === 50 && tval(r4.comp.list[1], "ADBE Opacity") === 50, dump(r4.diags));
    var r5 = build(wrapped(0.5, 1, [leaf("a"), leaf("b")], { options: { hierarchy: "groups" } }));
    var d5 = diagsMatching(r5.diags, /opacity/);
    ok("flatten and groups report that faded group alike",
       d5.length === 1 && d5[0].object === "Outer" && d5[0].resolution === "approximated" && r5.diags.length === 1,
       dump(r5.diags));

    var r6 = build(wrapped(0.5, 0.5, [leaf("a"), leaf("b")]));
    ok("flatten: nested faded groups over the same layers are both named, once",
       diagsMatching(r6.diags, /2 groups \('Outer' and 'Inner'\) are faded/).length === 1 && r6.diags.length === 1 &&
       tval(r6.comp.list[0], "ADBE Opacity") === 25, dump(r6.diags));

    var r7 = build(wrapped(0.5, 1, [leaf("a")]));
    ok("flatten: a faded group wrapping a single layer at any depth is exact",
       tval(r7.comp.list[0], "ADBE Opacity") === 50 && r7.diags.length === 0, dump(r7.diags));

    // Opacity that rounds to 100% changes nothing, in either mode.
    var r8 = build(wrapped(0.999, 1, [leaf("a"), leaf("b")]));
    ok("flatten: a group at a rounded 100% is not reported",
       r8.diags.length === 0 && tval(r8.comp.list[0], "ADBE Opacity") === 100, dump(r8.diags));
})();

// 26) hierarchy "groups": each group a null parenting its layers, nested
//     groups nested nulls, group opacity carried into the leaves.
(function () {
    var clip = { id: "m", name: "B mask", subpaths: [rectSub(60, 60, 20, 20)] };
    var r = build(irDoc([
        group("Outer", { x: 10, y: 20, width: 190, height: 180 }, [
            vector("A", { x: 10, y: 20, width: 50, height: 50 }),
            group("Inner", { x: 60, y: 60, width: 140, height: 140, opacity: 0.5 }, [
                vector("B", { x: 60, y: 60, width: 40, height: 40 }, { clip: clip }),
                textLayer("C", { x: 100, y: 100, width: 100, height: 100 }, {})
            ])
        ]),
        vector("D", { x: 300, y: 0, width: 10, height: 10 })
    ], { options: { hierarchy: "groups" } }));
    var L = r.comp.list;
    var d = L[0], outer = L[1], inner = L[2], c = L[3], b = L[4], a = L[5];

    ok("groups: leaves keep their order; each null sits just above its group's layers",
       names(L) === "D,Outer,Inner,C,B,A", names(L));
    ok("groups: each group becomes a null object named after it",
       outer && outer.nullLayer === true && inner.nullLayer === true && outer instanceof AVLayer && nullsIn(r.comp) === 2);
    ok("groups: nulls last as long as the comp", r.comp.nullDurations.join(",") === "10,10", r.comp.nullDurations.join(","));
    ok("groups: null at the group's top-left, anchored at its corner, at 100%",
       nearPt(tval(outer, "ADBE Position"), [10, 20]) && nearPt(tval(outer, "ADBE Anchor Point"), [0, 0]) &&
       nearPt(tval(inner, "ADBE Position"), [60, 60]) && tval(inner, "ADBE Opacity") === 100,
       xy(tval(outer, "ADBE Position")) + " " + xy(tval(inner, "ADBE Position")));
    ok("groups: layers parented to their group's null", a.parent === outer && b.parent === inner && c.parent === inner);
    ok("groups: nested groups give nested nulls; top level stays unparented",
       inner.parent === outer && outer.parent === null && d.parent === null);
    ok("groups: layers are built in comp space and then parented (AE keeps them in place)",
       nearPt(tval(a, "ADBE Position"), [10, 20]) && nearPt(tval(b, "ADBE Position"), [60, 60]) &&
       nearPt(tval(c, "ADBE Position"), [100, 116]), xy(tval(c, "ADBE Position")));
    ok("groups: parenting passes no opacity, so the group's goes into its layers",
       tval(b, "ADBE Opacity") === 50 && tval(c, "ADBE Opacity") === 50 && tval(a, "ADBE Opacity") === 100 &&
       tval(d, "ADBE Opacity") === 100);
    var bm = masks(b);
    ok("groups: masks stay on the leaf, in its layer space",
       bm.length === 1 && masks(inner).length === 0 && masks(outer).length === 0 &&
       nearPts(bm[0].property("ADBE Mask Shape").value.vertices, [[0, 0], [20, 0], [20, 20], [0, 20]]),
       bm.length && vlist(bm[0].property("ADBE Mask Shape").value.vertices));
    var od = diagsMatching(r.diags, /parenting does not pass opacity on, so the group's 50% opacity/);
    ok("groups: a faded group of several layers is reported once, approximated",
       od.length === 1 && od[0].object === "Inner" && od[0].resolution === "approximated" && r.diags.length === 1, dump(r.diags));
    ok("groups: layersCreated counts the nulls, and the message says so",
       r.res.layersCreated === 6 && /2 null layers/.test(r.res.message), JSON.stringify(r.res));
    ok("groups: one undo group, closed", app.undo.join(",") === "begin:LazyLord Import,end", app.undo.join(","));

    // A split gradient + stroke vector: both of its layers follow the null.
    var fill = linear([stop(0, rgba(1, 0, 0)), stop(1, rgba(0, 0, 1))], { x: 0, y: 0 }, { x: 1, y: 0 });
    var r2 = build(irDoc([group("Wrap", { x: 5, y: 5, width: 50, height: 50 }, [
        vector("Card", { x: 5, y: 5, width: 50, height: 50 }, { fills: [fill], strokes: [{ paint: solid(0, 0, 0), weight: 2 }] })
    ])], { options: { hierarchy: "groups" } }));
    var W = r2.comp.list;
    ok("groups: a split fill and stroke are both parented to the null",
       names(W) === "Wrap,Card stroke,Card" && W[1].parent === W[0] && W[2].parent === W[0] &&
       r2.res.layersCreated === 3, names(W));
})();

// 27) hierarchy "groups" fallbacks: no null, a half-made null, empty groups.
(function () {
    var box = { x: 0, y: 0, width: 10, height: 10 };
    function doc() {
        return irDoc([group("G", { x: 0, y: 0, width: 30, height: 30 }, [
            vector("A", box), vector("B", { x: 20, y: 20, width: 10, height: 10 })
        ])], { options: { hierarchy: "groups" } });
    }
    var r = build(doc(), { rejectNull: true });
    var d = diagsMatching(r.diags, /could not be rebuilt as a null object.*kept without it/);
    ok("groups: without a null the layers are kept, unparented",
       names(r.comp.list) === "B,A" && r.comp.list[0].parent === null && r.comp.list[1].parent === null, names(r.comp.list));
    ok("groups: the missing null is reported, approximated",
       d.length === 1 && d[0].object === "G" && d[0].resolution === "approximated" && r.diags.length === 1, dump(r.diags));
    ok("groups: layersCreated counts only the layers made", r.res.layersCreated === 2 && r.res.message === "", JSON.stringify(r.res));

    // A and B set their anchors first; the third anchor is the null's.
    var r2 = build(doc(), { failSet: { "ADBE Anchor Point": 3 } });
    ok("groups: a null that fails part-way is removed, its layers kept",
       names(r2.comp.list) === "B,A" && nullsIn(r2.comp) === 0 && r2.res.layersCreated === 2 &&
       diagsMatching(r2.diags, /null object/).length === 1, names(r2.comp.list) + " " + dump(r2.diags));

    var r3 = build(irDoc([
        group("Empty", box, []),
        group("Solo", { x: 0, y: 0, width: 10, height: 10, opacity: 0.5 }, [vector("S", box)])
    ], { options: { hierarchy: "groups" } }));
    var e = diagsMatching(r3.diags, /no layers inside it/);
    ok("groups: an empty group is reported as skipped and makes no null",
       e.length === 1 && e[0].object === "Empty" && e[0].resolution === "skipped" && names(r3.comp.list) === "Solo,S",
       names(r3.comp.list) + " " + dump(r3.diags));
    ok("groups: a faded group of one layer is exact",
       tval(r3.comp.list[1], "ADBE Opacity") === 50 && r3.diags.length === 1, dump(r3.diags));

    var r4 = build(irDoc([group("Nested", box, [group("Hollow", box, [])]), vector("V", box)]));
    ok("flatten: empty groups are reported too, never silently dropped",
       diagsMatching(r4.diags, /no layers inside it/).length === 1 && r4.diags[0].object === "Nested" &&
       r4.res.layersCreated === 1, dump(r4.diags));
})();

// 28) layout "combine": every vector in one shape layer, one vector group each.
(function () {
    var r = build(irDoc([
        vector("A", { x: 10, y: 20, width: 100, height: 50 },
               { primitive: { kind: "rect", x: 0, y: 0, width: 100, height: 50, roundness: 4 } }),
        vector("B", { x: 50, y: 60, width: 40, height: 40, opacity: 0.5 },
               { fills: [solid(0, 1, 0, 0.5)], strokes: [{ paint: solid(0, 0, 1), weight: 2, cap: "round" }], windingRule: "evenodd" }),
        vector("C", { x: 200, y: 10, width: 30, height: 30 },
               { primitive: { kind: "ellipse", x: 0, y: 0, width: 30, height: 30 } })
    ], { name: "Poster", options: { layout: "combine" } }));
    var l = r.comp.list[0];
    var gs = vgroups(contents(l));

    ok("combine: one shape layer for all the vectors", r.comp.list.length === 1 && l instanceof ShapeLayer &&
       r.res.layersCreated === 1, String(r.comp.list.length));
    ok("combine: named after the document", l.name === "Poster", l.name);
    ok("combine: anchor [0, 0] at the combined bounds' top-left, layer at 100%",
       nearPt(tval(l, "ADBE Position"), [10, 10]) && nearPt(tval(l, "ADBE Anchor Point"), [0, 0]) &&
       tval(l, "ADBE Opacity") === 100, xy(tval(l, "ADBE Position")));
    ok("combine: one vector group per vector, named after it, topmost first",
       gs.length === 3 && names(gs) === "C,B,A", names(gs));
    ok("combine: each group's position offsets its shape into place",
       nearPt(gval(gs[2], "ADBE Vector Position"), [0, 10]) && nearPt(gval(gs[1], "ADBE Vector Position"), [40, 50]) &&
       nearPt(gval(gs[0], "ADBE Vector Position"), [190, 0]) && nearPt(gval(gs[1], "ADBE Vector Anchor"), [0, 0]),
       xy(gval(gs[2], "ADBE Vector Position")) + " " + xy(gval(gs[1], "ADBE Vector Position")) + " " +
       xy(gval(gs[0], "ADBE Vector Position")));
    var rect = findIn(inside(gs[2]), "ADBE Vector Shape - Rect");
    ok("combine: live rectangle and ellipse in local space",
       rect && nearPt(rect.property("ADBE Vector Rect Position").value, [50, 25]) &&
       rect.property("ADBE Vector Rect Roundness").value === 4 &&
       countIn(inside(gs[0]), "ADBE Vector Shape - Ellipse") === 1 && countIn(inside(gs[2]), "ADBE Vector Shape - Group") === 0);
    var path = findIn(inside(gs[1]), "ADBE Vector Shape");
    ok("combine: a drawn path keeps its local vertices",
       path && nearPts(path.value.vertices, [[0, 0], [40, 0], [40, 40], [0, 40]]), path && vlist(path.value.vertices));
    var kids = inside(gs[1]).children;
    ok("combine: path, then stroke, then fill (the stroke draws over the fill)",
       kids.length === 3 && kids[0].matchName === "ADBE Vector Shape - Group" &&
       kids[1].matchName === "ADBE Vector Graphic - Stroke" && kids[2].matchName === "ADBE Vector Graphic - Fill",
       kids.length && kids[1].matchName);
    ok("combine: fill colour, alpha and rule; stroke colour, width and cap",
       nearArr(kids[2].property("ADBE Vector Fill Color").value, [0, 1, 0, 1]) &&
       kids[2].property("ADBE Vector Fill Opacity").value === 50 && kids[2].property("ADBE Vector Fill Rule").value === 2 &&
       nearArr(kids[1].property("ADBE Vector Stroke Color").value, [0, 0, 1, 1]) &&
       kids[1].property("ADBE Vector Stroke Width").value === 2 && kids[1].property("ADBE Vector Stroke Line Cap").value === 2);
    ok("combine: a vector's opacity goes on its group",
       gval(gs[1], "ADBE Vector Group Opacity") === 50 && gval(gs[0], "ADBE Vector Group Opacity") === 100,
       String(gval(gs[1], "ADBE Vector Group Opacity")));
    ok("combine: no diagnostics", r.diags.length === 0, dump(r.diags));
    ok("combine: the message names the combined layer", /'Poster' holds 3 shapes/.test(r.res.message), r.res.message);

    // A vector that still carries a rotation turns about its centre inside its group.
    var r2 = build(irDoc([
        vector("Base", { x: 10, y: 20, width: 10, height: 10 }),
        vector("Tilt", { x: 10, y: 20, width: 100, height: 50, rotation: 45 })
    ], { options: { layout: "combine" } }));
    var tg = vgroups(contents(r2.comp.list[0]))[0];
    ok("combine: a legacy rotation turns the group about the frame centre",
       tg && tg.name === "Tilt" && nearPt(gval(tg, "ADBE Vector Anchor"), [50, 25]) &&
       nearPt(gval(tg, "ADBE Vector Position"), [50, 25]) && gval(tg, "ADBE Vector Rotation") === 45,
       tg && xy(gval(tg, "ADBE Vector Position")));
})();

// 29) layout "combine" + hierarchy "groups": nested vector groups, each with
//     the IR group's own opacity (exact); separate layers still get nulls.
(function () {
    var r = build(irDoc([
        group("G", { x: 100, y: 100, width: 200, height: 150, opacity: 0.5 }, [
            vector("A", { x: 100, y: 100, width: 50, height: 50 }),
            group("H", { x: 200, y: 150, width: 100, height: 100, opacity: 0.8 }, [
                vector("B", { x: 200, y: 150, width: 100, height: 100, opacity: 0.9 })
            ])
        ]),
        vector("C", { x: 0, y: 0, width: 20, height: 20 })
    ], { options: { layout: "combine", hierarchy: "groups" } }));
    var l = r.comp.list[0];
    var root = vgroups(contents(l));
    var g = root[1], gk = vgroups(inside(g)), h = gk[0], hk = vgroups(inside(h));

    ok("combine + groups: one shape layer, no nulls", r.comp.list.length === 1 && nullsIn(r.comp) === 0 &&
       r.res.layersCreated === 1 && !/null/.test(r.res.message), names(r.comp.list) + " " + r.res.message);
    ok("combine + groups: top level C over the group G", names(root) === "C,G", names(root));
    ok("combine + groups: G holds H over A, H holds B", names(gk) === "H,A" && names(hk) === "B", names(gk) + " / " + names(hk));
    ok("combine + groups: group opacity on the vector group, exactly",
       gval(g, "ADBE Vector Group Opacity") === 50 && gval(h, "ADBE Vector Group Opacity") === 80 &&
       gval(hk[0], "ADBE Vector Group Opacity") === 90 && gval(gk[1], "ADBE Vector Group Opacity") === 100,
       gval(g, "ADBE Vector Group Opacity") + " " + gval(h, "ADBE Vector Group Opacity"));
    ok("combine + groups: positions nest relative to each enclosing group",
       nearPt(tval(l, "ADBE Position"), [0, 0]) && nearPt(gval(g, "ADBE Vector Position"), [100, 100]) &&
       nearPt(gval(gk[1], "ADBE Vector Position"), [0, 0]) && nearPt(gval(h, "ADBE Vector Position"), [100, 50]) &&
       nearPt(gval(hk[0], "ADBE Vector Position"), [0, 0]) && nearPt(gval(root[0], "ADBE Vector Position"), [0, 0]),
       xy(gval(h, "ADBE Vector Position")));
    ok("combine + groups: leaf opacities untouched, no diagnostics", r.diags.length === 0, dump(r.diags));

    // A text inside a faded group stays separate, parented to the group's null.
    var r2 = build(irDoc([group("Card", { x: 0, y: 0, width: 100, height: 100, opacity: 0.5 }, [
        vector("Bg", { x: 0, y: 0, width: 100, height: 100 }),
        textLayer("Label", { x: 10, y: 10, width: 80, height: 20 }, {})
    ])], { options: { layout: "combine", hierarchy: "groups" } }));
    var L = r2.comp.list, nl = L[0], label = L[1], combined = L[2];
    ok("combine + groups: text separate under the group's null, combined layer unparented",
       names(L) === "Card,Label,Doc" && nl.nullLayer === true && label.parent === nl && combined.parent === null,
       names(L));
    ok("combine + groups: the combined layer keeps the group as a vector group",
       names(vgroups(contents(combined))) === "Card" &&
       gval(vgroups(contents(combined))[0], "ADBE Vector Group Opacity") === 50 && tval(label, "ADBE Opacity") === 50);
    ok("combine + groups: the text staying separate and the split opacity are reported",
       diagsMatching(r2.diags, /1 layer could not join.*1 text layer/).length === 1 &&
       diagsMatching(r2.diags, /parenting does not pass opacity on/).length === 1 && r2.diags.length === 2, dump(r2.diags));
    ok("combine + groups: the null and both layers counted", r2.res.layersCreated === 3, JSON.stringify(r2.res));
})();

// 30) Ineligible layers stay separate, reported once with the reasons.
(function () {
    mockFiles["C:/art/photo.png"] = true;
    app.footageSize = [200, 100];
    var grad = linear([stop(0, rgba(1, 0, 0)), stop(1, rgba(0, 0, 1))], { x: 0, y: 0 }, { x: 1, y: 0 });
    var box = { x: 0, y: 0, width: 10, height: 10 };
    var r = build(irDoc([
        vector("A", box),
        textLayer("T", { x: 0, y: 0, width: 100, height: 20 }, {}),
        vector("Grad", box, { fills: [grad] }),
        vector("K", box, { clip: { id: "m2", name: "Other", subpaths: [rectSub(0, 0, 5, 5)] } }),
        vector("B", { x: 20, y: 20, width: 10, height: 10 }),
        imageLayer("P", { x: 0, y: 0, width: 100, height: 50 }, "C:/art/photo.png", true)
    ], { options: { layout: "combine" } }));
    var L = r.comp.list;
    var combined = L[4];
    // An AE footage layer takes its name from the footage (the mock leaves it blank).
    ok("ineligible: text, image, gradient and other-clip layers stay separate, above the combined layer",
       L.length === 5 && L[0].source && L[0].source.name === "P" && names(L.slice(1)) === "K,Grad,T,Doc" &&
       r.res.layersCreated === 5, names(L));
    ok("ineligible: the combined layer holds only the eligible vectors",
       names(vgroups(contents(combined))) === "B,A" && masks(combined).length === 0, names(vgroups(contents(combined))));
    ok("ineligible: separate layers built as in split mode (ramp, mask)",
       effects(L[2]).length === 1 && masks(L[1]).length === 1 && L[3] instanceof TextLayer && L[0] instanceof AVLayer);
    var d = diagsMatching(r.diags, /could not join the combined shape layer 'Doc'/);
    ok("ineligible: one approximated diagnostic naming how many and why",
       d.length === 1 && d[0].resolution === "approximated" && r.diags.length === 1 &&
       /^4 layers/.test(d[0].reason) && /1 text layer/.test(d[0].reason) && /1 image/.test(d[0].reason) &&
       /1 gradient-filled shape/.test(d[0].reason) && /1 shape with a different clipping mask/.test(d[0].reason),
       dump(r.diags));
    ok("ineligible: layers that were between combined shapes are said to draw above them",
       d.length === 1 && /3 of them were stacked between combined shapes/.test(d[0].reason), d.length && d[0].reason);

    var r2 = build(irDoc([textLayer("Only", { x: 0, y: 0, width: 100, height: 20 }, {})], { options: { layout: "combine" } }));
    ok("ineligible: with nothing to combine every layer is built on its own, and that is said",
       r2.comp.list.length === 1 && r2.res.layersCreated === 1 && r2.res.message === "" &&
       diagsMatching(r2.diags, /No shape could be combined/).length === 1, dump(r2.diags));
})();

// 31) Clips in combine: a clip every combined vector shares goes on the layer.
(function () {
    function win() { return { id: "m1", name: "Window", subpaths: [rectSub(0, 0, 60, 60)] }; }
    var r = build(irDoc([
        vector("A", { x: 10, y: 10, width: 30, height: 30 }, { clip: win() }),
        vector("B", { x: 30, y: 30, width: 30, height: 30 }, { clip: win() })
    ], { options: { layout: "combine" } }));
    var l = r.comp.list[0], m = masks(l);
    ok("shared clip: both vectors combined", r.comp.list.length === 1 && names(vgroups(contents(l))) === "B,A");
    ok("shared clip: the clip becomes the combined layer's mask, in its layer space",
       m.length === 1 && m[0].name === "Window" &&
       nearPts(m[0].property("ADBE Mask Shape").value.vertices, [[-10, -10], [50, -10], [50, 50], [-10, 50]]),
       m.length && vlist(m[0].property("ADBE Mask Shape").value.vertices));
    ok("shared clip: no diagnostics", r.diags.length === 0, dump(r.diags));

    // Most vectors share the clip; the unclipped one stays a layer of its own.
    var r2 = build(irDoc([
        vector("A", { x: 10, y: 10, width: 30, height: 30 }, { clip: win() }),
        vector("B", { x: 30, y: 30, width: 30, height: 30 }, { clip: win() }),
        vector("Free", { x: 0, y: 0, width: 5, height: 5 })
    ], { options: { layout: "combine" } }));
    var L = r2.comp.list;
    ok("shared clip: a vector with a different clip stays separate and unclipped",
       names(L) === "Free,Doc" && masks(L[0]).length === 0 && masks(L[1]).length === 1, names(L));
    ok("shared clip: reported as a different clipping mask",
       diagsMatching(r2.diags, /1 layer could not join.*1 shape with a different clipping mask/).length === 1 &&
       r2.diags.length === 1, dump(r2.diags));
})();

// 32) Combine fallbacks: no combined layer, a shape that fails part-way.
(function () {
    var box = { x: 0, y: 0, width: 10, height: 10 };
    function doc() {
        return irDoc([
            vector("A", box),
            vector("B", { x: 20, y: 0, width: 10, height: 10 }, { strokes: [{ paint: solid(0, 0, 0), weight: 1 }] }),
            vector("C", { x: 40, y: 0, width: 10, height: 10 })
        ], { options: { layout: "combine" } });
    }
    // The combined layer's Position is the first one set.
    var r = build(doc(), { failSet: { "ADBE Position": 1 } });
    ok("combine: without the combined layer each vector is built on its own",
       names(r.comp.list) === "C,B,A" && r.res.layersCreated === 3 && r.res.message === "", names(r.comp.list));
    ok("combine: the missing combined layer is reported",
       diagsMatching(r.diags, /combined shape layer could not be made/).length === 1 && r.diags.length === 1, dump(r.diags));

    var r2 = build(doc(), { rejectAdd: { "ADBE Vector Graphic - Stroke": true } });
    var l2 = r2.comp.list[0];
    ok("combine: a shape that fails part-way is taken out of the combined layer",
       r2.comp.list.length === 1 && names(vgroups(contents(l2))) === "C,A" && r2.res.layersCreated === 1 &&
       /holds 2 shapes/.test(r2.res.message), names(vgroups(contents(l2))) + " " + r2.res.message);
    ok("combine: and reported as skipped",
       r2.diags.length === 1 && r2.diags[0].object === "B" && r2.diags[0].resolution === "skipped", dump(r2.diags));

    var r3 = build(doc(), { rejectAdd: { "ADBE Vector Graphic - Stroke": true }, rejectRemove: { "ADBE Vector Group": true } });
    ok("combine: a half-built shape that cannot be removed is reported",
       diagsMatching(r3.diags, /half-built shape could not be removed/).length === 1, dump(r3.diags));

    var r4 = build(irDoc([
        vector("A", box, { strokes: [{ paint: solid(0, 0, 0), weight: 1 }] })
    ], { options: { layout: "combine" } }), { rejectAdd: { "ADBE Vector Graphic - Stroke": true } });
    ok("combine: when every shape fails no empty combined layer is left",
       r4.comp.list.length === 0 && r4.res.layersCreated === 0 && r4.diags.length === 1, dump(r4.diags));
})();

// 33) Paint order. AE paints a group's Contents from the bottom of the Timeline
//     up, so paint listed higher renders in front: the stroke must sit above
//     the fill to draw over it, as in Figma and Illustrator. With the fill
//     above, a centred 10 px stroke would show only its outer 5 px. Split and
//     combine must lay a shape out alike.
(function () {
    function kinds(node) {
        var out = [];
        for (var i = 0; node && i < node.children.length; i++) {
            out.push(node.children[i].matchName.replace(/^ADBE Vector (Shape|Graphic) - /, ""));
        }
        return out.join(",");
    }
    function stroked(extra) {
        return irDoc([
            vector("Framed", { x: 0, y: 0, width: 100, height: 100 },
                   { fills: [solid(1, 0, 0)], strokes: [{ paint: solid(0, 0, 0), weight: 10 }] }),
            vector("Pill", { x: 200, y: 0, width: 100, height: 50 },
                   { strokes: [{ paint: solid(0, 0, 1), weight: 4 }],
                     primitive: { kind: "rect", x: 0, y: 0, width: 100, height: 50, roundness: 25 } }),
            vector("Line", { x: 0, y: 200, width: 100, height: 1 },
                   { fills: [], strokes: [{ paint: solid(0, 1, 0), weight: 2 }] })
        ], extra);
    }

    var r = build(stroked());
    var L = r.comp.list, line = L[0], pill = L[1], framed = L[2];
    var fc = inside(vgroups(contents(framed))[0]);
    ok("paint order: split lays out path, stroke, fill (the stroke draws over the fill)",
       kinds(fc) === "Group,Stroke,Fill", kinds(fc));
    ok("paint order: the stroke and fill keep their own colours and width",
       kinds(fc) === "Group,Stroke,Fill" &&
       nearArr(fc.children[1].property("ADBE Vector Stroke Color").value, [0, 0, 0, 1]) &&
       fc.children[1].property("ADBE Vector Stroke Width").value === 10 &&
       nearArr(fc.children[2].property("ADBE Vector Fill Color").value, [1, 0, 0, 1]));
    ok("paint order: a live primitive gets the same order",
       kinds(inside(vgroups(contents(pill))[0])) === "Rect,Stroke,Fill", kinds(inside(vgroups(contents(pill))[0])));
    ok("paint order: a stroke with no fill is just path, stroke",
       kinds(inside(vgroups(contents(line))[0])) === "Group,Stroke", kinds(inside(vgroups(contents(line))[0])));
    ok("paint order: exact, so no diagnostics", r.diags.length === 0 && r.res.layersCreated === 3, dump(r.diags));

    var rc = build(stroked({ options: { layout: "combine" } }));
    var cg = vgroups(contents(rc.comp.list[0]));
    ok("paint order: combine lays each shape out exactly as split does",
       names(cg) === "Line,Pill,Framed" && kinds(inside(cg[2])) === kinds(fc) &&
       kinds(inside(cg[1])) === "Rect,Stroke,Fill" && kinds(inside(cg[0])) === "Group,Stroke",
       names(cg) + " " + kinds(inside(cg[2])));

    // A gradient fill keeps its stroke on a layer of its own, and the Gradient
    // Ramp still finds the fill again by index.
    var fill = linear([stop(0, rgba(1, 0, 0, 0.4)), stop(1, rgba(0, 0, 1, 0.8))], { x: 0, y: 0 }, { x: 1, y: 0 });
    var rg = build(irDoc([vector("Card", { x: 0, y: 0, width: 50, height: 50 },
        { fills: [fill], strokes: [{ paint: solid(0, 0, 0), weight: 2 }] })]));
    var G = rg.comp.list;
    ok("paint order: a gradient fill and its stroke layer are unchanged",
       names(G) === "Card stroke,Card" && kinds(inside(vgroups(contents(G[1]))[0])) === "Group,Fill" &&
       kinds(inside(vgroups(contents(G[0]))[0])) === "Group,Stroke" && effects(G[1]).length === 1 &&
       findIn(contents(G[1]), "ADBE Vector Fill Opacity").value === 60, names(G) + " " + dump(rg.diags));
})();


/* -------------------------------------------------------------------------
 * Phase 3: layer tags, updating in place, and keyframes at the playhead
 * ---------------------------------------------------------------------- */

/** An IR document that identifies its source file, so tags can be matched. */
function taggedDoc(layers, key, options) {
    return irDoc(layers, { sourceKey: key === undefined ? "file-A" : key, options: options });
}
function updateOpts(extra) {
    var o = { existing: "update" };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
}
function shapeOf(l) { return findIn(contents(l), "ADBE Vector Shape"); }
function fillColorOf(l) { return findIn(contents(l), "ADBE Vector Fill Color"); }

// T1) A first transfer tags every layer it builds with where it came from.
(function () {
    var r = build(taggedDoc([vector("Box", { x: 10, y: 20, width: 100, height: 50 })]));
    var l = r.comp.list[0];
    ok("tag: the built layer carries a tag", /\[\[LazyLord /.test(l.comment), l.comment);
    ok("tag: it names the source app, file and layer id",
       l.comment.indexOf("figma|file-A|Box") >= 0, l.comment);
    ok("tag: the key round-trips through readTagKey",
       LazyLord.readTagKey(l.comment) === LazyLord.tagKey(taggedDoc([]), { id: "Box" }),
       LazyLord.readTagKey(l.comment));
})();

// T2) Sending the same thing again with Update edits that layer where it is.
(function () {
    var doc1 = taggedDoc([vector("Box", { x: 10, y: 20, width: 100, height: 50 })]);
    var first = build(doc1);
    var was = first.comp.list[0];

    var doc2 = taggedDoc(
        [vector("Box", { x: 80, y: 90, width: 100, height: 50 }, { fills: [solid(0, 0, 1)] })],
        "file-A", updateOpts());
    var second = build(doc2, { comp: first.comp });

    ok("update: no second layer was added", second.comp.list.length === 1, String(second.comp.list.length));
    ok("update: the same layer object was edited", second.comp.list[0] === was);
    ok("update: the transform moved", nearPt(tval(was, "ADBE Position"), [80, 90]), xy(tval(was, "ADBE Position")));
    ok("update: the fill changed", nearArr(fillColorOf(was).value, [0, 0, 1, 1]), xy(fillColorOf(was).value));
    ok("update: nothing was created", second.res.layersCreated === 0, String(second.res.layersCreated));
    ok("update: one layer counted as updated", second.res.layersUpdated === 1, String(second.res.layersUpdated));
    ok("update: the summary says so", /Updated 1 layer/.test(second.res.message), second.res.message);
})();

// T3) The document key is what stops a layer id matching the same id in
//     another file. A different file adds instead.
(function () {
    var first = build(taggedDoc([vector("Box", { x: 10, y: 20, width: 100, height: 50 })], "file-A"));
    var second = build(
        taggedDoc([vector("Box", { x: 80, y: 90, width: 100, height: 50 })], "file-B", updateOpts()),
        { comp: first.comp });

    ok("key: a different file does not match", second.comp.list.length === 2, String(second.comp.list.length));
    ok("key: it was added, not updated", second.res.layersUpdated === 0 && second.res.layersCreated === 1);
    ok("key: the miss is reported", /Nothing matched/.test(second.res.message), second.res.message);
})();

// T4) An animated property cannot take a plain value, so it gets a key at the
//     playhead — and a still one is left un-animated.
(function () {
    var first = build(taggedDoc([vector("Box", { x: 10, y: 20, width: 100, height: 50 })]));
    var was = first.comp.list[0];
    var position = was.property("ADBE Transform Group").property("ADBE Position");
    // Animate Position, as a user would have.
    position.setValueAtTime(0, [10, 20]);
    first.comp.time = 3;

    var second = build(
        taggedDoc([vector("Box", { x: 80, y: 90, width: 100, height: 50 })], "file-A", updateOpts()),
        { comp: first.comp });

    ok("keys: the animated property gained a key", position.numKeys === 2, String(position.numKeys));
    ok("keys: it was written at the playhead", near(position.keys[1].time, 3), String(position.keys[1].time));
    ok("keys: with the new value", nearPt(position.keys[1].value, [80, 90]), xy(position.keys[1].value));
    var rotation = was.property("ADBE Transform Group").property("ADBE Rotate Z");
    ok("keys: a still property stays still", rotation.numKeys === 0, String(rotation.numKeys));
    ok("keys: the summary mentions keying the animated ones",
       /keying the ones already animated/.test(second.res.message), second.res.message);
})();

// T5) keyframes "always" keys every property it writes — how you animate a
//     shape by re-sending it.
(function () {
    var first = build(taggedDoc([vector("Box", { x: 10, y: 20, width: 100, height: 50 })]));
    var was = first.comp.list[0];
    first.comp.time = 2;

    var second = build(
        taggedDoc([vector("Box", { x: 80, y: 90, width: 100, height: 50 })], "file-A",
                  updateOpts({ keyframes: "always" })),
        { comp: first.comp });

    var position = was.property("ADBE Transform Group").property("ADBE Position");
    ok("always: a still property was keyed", position.numKeys === 1, String(position.numKeys));
    ok("always: at the playhead", near(position.keys[0].time, 2), String(position.keys[0].time));
    ok("always: the path was keyed too", shapeOf(was).numKeys === 1, String(shapeOf(was).numKeys));
    ok("always: the summary says every property was keyed",
       /key at the playhead on every property/.test(second.res.message), second.res.message);
})();

// T6) Updating edits layers where they stand, so it cannot also restructure
//     them: the layout choices are reported and ignored.
(function () {
    var first = build(taggedDoc([vector("Box", { x: 10, y: 20, width: 100, height: 50 })]));
    var second = build(
        taggedDoc([vector("Box", { x: 10, y: 20, width: 100, height: 50 })], "file-A",
                  updateOpts({ hierarchy: "groups", layout: "combine" })),
        { comp: first.comp });

    ok("layout: Groups was reported as ignored",
       diagsMatching(second.diags, /Groups was ignored|Combine was ignored/).length === 1, dump(second.diags));
    ok("layout: no null object was made", nullsIn(second.comp) === 0, String(nullsIn(second.comp)));
    ok("layout: still just the one layer", second.comp.list.length === 1, String(second.comp.list.length));
})();

// T7) A shape the user has since reworked is not clobbered: the contours that
//     pair up are updated and the mismatch is reported.
(function () {
    var twoContours = [rectSub(0, 0, 40, 40), rectSub(50, 0, 40, 40)];
    var first = build(taggedDoc([vector("Box", { x: 0, y: 0, width: 90, height: 40 },
                                        { subpaths: twoContours })]));
    var was = first.comp.list[0];

    var second = build(
        taggedDoc([vector("Box", { x: 0, y: 0, width: 40, height: 40 },
                          { subpaths: [rectSub(0, 0, 40, 40)] })], "file-A", updateOpts()),
        { comp: first.comp });

    ok("mismatch: reported", diagsMatching(second.diags, /only the ones that pair up/).length === 1, dump(second.diags));
    ok("mismatch: the layer is still there", second.comp.list.length === 1 && second.comp.list[0] === was);
    ok("mismatch: nothing was deleted", countIn(contents(was), "ADBE Vector Shape") === 2,
       String(countIn(contents(was), "ADBE Vector Shape")));
})();

// T8) Text updates its document but keeps styling LazyLord never sets.
(function () {
    var first = build(taggedDoc([textLayer("Title", { x: 0, y: 0, width: 100, height: 30 })]));
    var was = first.comp.list[0];
    var prop = was.property("ADBE Text Properties").property("ADBE Text Document");
    prop.value.tsume = 0.5; // something only the user would have set

    var next = textLayer("Title", { x: 0, y: 0, width: 100, height: 30 });
    next.characters = "Goodbye";
    var second = build(taggedDoc([next], "file-A", updateOpts()), { comp: first.comp });

    ok("text: the same layer was edited", second.comp.list.length === 1 && second.comp.list[0] === was);
    ok("text: the words changed", prop.value.text === "Goodbye", String(prop.value.text));
    ok("text: untouched styling survives", prop.value.tsume === 0.5, String(prop.value.tsume));
})();

// T9) Update with nothing to match behaves exactly like Add.
(function () {
    var r = build(taggedDoc([vector("Box", { x: 10, y: 20, width: 100, height: 50 })], "file-A", updateOpts()));
    ok("empty: the layer was added", r.comp.list.length === 1, String(r.comp.list.length));
    ok("empty: counted as created", r.res.layersCreated === 1 && r.res.layersUpdated === 0);
    ok("empty: and the new layer is tagged for next time", /\[\[LazyLord /.test(r.comp.list[0].comment));
})();

// T10) The tag lives alongside whatever the user keeps in the comment.
(function () {
    var mine = "my own note";
    var tagged = LazyLord.withTag(mine, "[[LazyLord figma|f|1]]");
    ok("comment: the user's text is kept", tagged.indexOf(mine) === 0, tagged);
    ok("comment: the tag is appended", /\[\[LazyLord figma\|f\|1\]\]$/.test(tagged), tagged);

    var retagged = LazyLord.withTag(tagged, "[[LazyLord figma|f|2]]");
    ok("comment: re-tagging replaces, never stacks",
       retagged.indexOf("figma|f|1") < 0 && retagged.indexOf("figma|f|2") > 0 &&
       retagged.indexOf(mine) === 0, retagged);
    ok("comment: stripping leaves the user's text", LazyLord.stripTag(retagged) === mine,
       "[" + LazyLord.stripTag(retagged) + "]");
    ok("comment: an untagged comment reads as no tag", LazyLord.readTag(mine) === null);
    ok("comment: a Figma id with a colon survives",
       LazyLord.readTag("[[LazyLord figma|f|I1:23;4:56]]").id === "I1:23;4:56",
       LazyLord.readTag("[[LazyLord figma|f|I1:23;4:56]]").id);
})();

// T11) A source with no document key of its own still round-trips, and only
//      ever matches another keyless source.
(function () {
    var first = build(taggedDoc([vector("Box", { x: 0, y: 0, width: 10, height: 10 })], ""));
    var l = first.comp.list[0];
    ok("nokey: the tag has an empty middle field", /figma\|\|Box/.test(l.comment), l.comment);

    var second = build(taggedDoc([vector("Box", { x: 5, y: 5, width: 10, height: 10 })], "", updateOpts()),
                       { comp: first.comp });
    ok("nokey: it still matches itself", second.res.layersUpdated === 1, String(second.res.layersUpdated));

    var third = build(taggedDoc([vector("Box", { x: 9, y: 9, width: 10, height: 10 })], "file-A", updateOpts()),
                      { comp: first.comp });
    ok("nokey: a keyed source does not match a keyless layer", third.res.layersUpdated === 0,
       String(third.res.layersUpdated));
})();

/* -------------------------------------------------------------------------
 * Blend modes and effects
 * ---------------------------------------------------------------------- */

function fxOf(l) {
    var out = [];
    var list = effects(l);
    for (var i = 0; i < list.length; i++) out.push(list[i].matchName);
    return out.join(",");
}
function fxNamed(l, mn) {
    var list = effects(l);
    for (var i = 0; i < list.length; i++) if (list[i].matchName === mn) return list[i];
    return null;
}
function fxVal(fx, mn) {
    var p = fx ? fx.property(mn) : null;
    return p ? p.value : null;
}

// E1) A blend mode becomes the AE mode of the same name.
(function () {
    var r = build(irDoc([vector("Tint", { x: 0, y: 0, width: 10, height: 10 }, { blendMode: "multiply" })]));
    ok("blend: applied to the layer", r.comp.list[0].blendingMode === BlendingMode.MULTIPLY,
       String(r.comp.list[0].blendingMode));
    ok("blend: nothing reported for a mode AE has", r.diags.length === 0, dump(r.diags));

    var dodge = build(irDoc([vector("D", { x: 0, y: 0, width: 10, height: 10 }, { blendMode: "color-dodge" })]));
    ok("blend: color-dodge maps to AE's classic dodge",
       dodge.comp.list[0].blendingMode === BlendingMode.CLASSIC_COLOR_DODGE,
       String(dodge.comp.list[0].blendingMode));

    var normal = build(irDoc([vector("N", { x: 0, y: 0, width: 10, height: 10 })]));
    ok("blend: a layer without one is left alone", normal.comp.list[0].blendingMode === undefined ||
       normal.comp.list[0].blendingMode === BlendingMode.NORMAL, String(normal.comp.list[0].blendingMode));
})();

// E2) A drop shadow becomes AE's own, with the offset turned into the
//     direction-and-distance dial AE uses.
(function () {
    var shadow = {
        kind: "drop-shadow",
        color: { r: 0, g: 0, b: 0, a: 0.5 },
        offset: { x: 0, y: 10 },   // straight down
        radius: 4
    };
    var r = build(irDoc([vector("Card", { x: 0, y: 0, width: 20, height: 20 }, { effects: [shadow] })]));
    var l = r.comp.list[0];
    var fx = fxNamed(l, "ADBE Drop Shadow");

    ok("shadow: the stock Drop Shadow effect", !!fx, fxOf(l));
    ok("shadow: distance is the offset's length", near(fxVal(fx, "ADBE Drop Shadow-0004"), 10),
       String(fxVal(fx, "ADBE Drop Shadow-0004")));
    // AE's dial is 0 straight up, growing clockwise; straight down is 180.
    ok("shadow: direction is AE's clockwise-from-up dial",
       near(fxVal(fx, "ADBE Drop Shadow-0003"), 180), String(fxVal(fx, "ADBE Drop Shadow-0003")));
    ok("shadow: softness from the radius", near(fxVal(fx, "ADBE Drop Shadow-0005"), 4),
       String(fxVal(fx, "ADBE Drop Shadow-0005")));
    ok("shadow: opacity from the colour's alpha, in AE's 0..255",
       near(fxVal(fx, "ADBE Drop Shadow-0002"), 127.5), String(fxVal(fx, "ADBE Drop Shadow-0002")));

    // A shadow to the right is 90 degrees on the same dial.
    var right = build(irDoc([vector("R", { x: 0, y: 0, width: 20, height: 20 }, {
        effects: [{ kind: "drop-shadow", color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 8, y: 0 }, radius: 0 }]
    })]));
    ok("shadow: a rightward offset reads as 90 degrees",
       near(fxVal(fxNamed(right.comp.list[0], "ADBE Drop Shadow"), "ADBE Drop Shadow-0003"), 90),
       String(fxVal(fxNamed(right.comp.list[0], "ADBE Drop Shadow"), "ADBE Drop Shadow-0003")));
})();

// E3) Spread has no AE equivalent, and says so rather than shifting the shadow.
(function () {
    var r = build(irDoc([vector("Card", { x: 0, y: 0, width: 20, height: 20 }, {
        effects: [{ kind: "drop-shadow", color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 2 }, radius: 1, spread: 5 }]
    })]));
    ok("shadow: the effect is still built", !!fxNamed(r.comp.list[0], "ADBE Drop Shadow"));
    ok("shadow: its spread is reported", diagsMatching(r.diags, /spread/).length === 1, dump(r.diags));
})();

// E4) A layer blur becomes Gaussian Blur.
(function () {
    var r = build(irDoc([vector("Soft", { x: 0, y: 0, width: 20, height: 20 }, {
        effects: [{ kind: "layer-blur", radius: 5 }]
    })]));
    var fx = fxNamed(r.comp.list[0], "ADBE Gaussian Blur 2");
    ok("blur: the stock Gaussian Blur", !!fx, fxOf(r.comp.list[0]));
    ok("blur: AE's blurriness is about twice the radius",
       near(fxVal(fx, "ADBE Gaussian Blur 2-0001"), 10), String(fxVal(fx, "ADBE Gaussian Blur 2-0001")));
})();

// E5) The two with no After Effects equivalent are reported, not guessed at.
(function () {
    var r = build(irDoc([vector("Inner", { x: 0, y: 0, width: 20, height: 20 }, {
        effects: [{ kind: "inner-shadow", color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 2 }, radius: 2 },
                  { kind: "background-blur", radius: 6 }]
    })]));
    ok("effects: no effect was invented", effects(r.comp.list[0]).length === 0, fxOf(r.comp.list[0]));
    ok("effects: the inner shadow is reported", diagsMatching(r.diags, /inner-shadow effect/).length === 1, dump(r.diags));
    ok("effects: so is the background blur", diagsMatching(r.diags, /behind the layer/).length === 1, dump(r.diags));
})();

// E6) Text and images wear them too, and several effects stack in order.
(function () {
    var fx = [{ kind: "drop-shadow", color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 1, y: 1 }, radius: 1 },
              { kind: "layer-blur", radius: 2 }];
    var t = textLayer("Title", { x: 0, y: 0, width: 40, height: 20 });
    t.effects = fx;
    t.blendMode = "screen";
    var r = build(irDoc([t]));
    ok("text: both effects, in the order they were sent",
       fxOf(r.comp.list[0]) === "ADBE Drop Shadow,ADBE Gaussian Blur 2", fxOf(r.comp.list[0]));
    ok("text: and its blend mode", r.comp.list[0].blendingMode === BlendingMode.SCREEN);

    var img = imageLayer("Shot", { x: 0, y: 0, width: 40, height: 20 }, "C:/a.png", true);
    img.effects = [fx[0]];
    var r2 = build(irDoc([img]));
    ok("image: effects apply to footage too", !!fxNamed(r2.comp.list[0], "ADBE Drop Shadow"),
       fxOf(r2.comp.list[0]));
})();
WScript.Echo("");
WScript.Echo(passed + " passed, " + failed + " failed.");
WScript.Quit(failed === 0 ? 0 : 1);
