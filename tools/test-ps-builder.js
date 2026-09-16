/*
 * LazyLord — Photoshop builder tests (no Node required).
 *
 *   cscript //Nologo tools\test-ps-builder.js
 *
 * Runs the real jsx/ps.jsx against a mocked Photoshop DOM under Windows Script
 * Host, whose JScript engine is ES3 like ExtendScript. ActionManager is mocked
 * by recording descriptors: every key, class, unit and value that would reach
 * executeAction is kept, so these tests pin down the descriptors themselves —
 * shape layers, gradient fills (stop locations, angle sign, scale, offset),
 * shape strokes and vector masks — plus the fallbacks when Photoshop refuses
 * one, clip grouping in runs, rotation about the IR frame centre, canvas
 * sizing, and path coordinates on documents that are not 72 ppi (the mock
 * reads PathPointInfo as points, as Photoshop does). IR groups are covered in
 * both hierarchy modes: flattened (the default) and rebuilt as nested layer
 * sets, under either model of where Photoshop puts a new layer when a set is
 * active, either model of where Document.layerSets.add() puts a new set (top
 * of the document by default, as reported; above the active layer with
 * host.setsAboveActive), and with Photoshop's refusal to move one layer set
 * into another (host.setsStayPut takes the most pessimistic reading: a set
 * may never change container at all). A group's own clip is covered in both
 * modes too, as is a transfer landing inside one of the user's own groups.
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

function idxOf(arr, x) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === x) return i;
    return -1;
}

// --- Recording ActionManager stand-ins -------------------------------------
// Type IDs are just their strings, so descriptors read back like ScriptListener.
function charIDToTypeID(s) { return s; }
function stringIDToTypeID(s) { return s; }
var DialogModes = { NO: "no" };

function ActionDescriptor() { this.keys = []; this.items = {}; }
ActionDescriptor.prototype._put = function (key, rec) {
    if (!this.items.hasOwnProperty(key)) this.keys.push(key);
    this.items[key] = rec;
};
ActionDescriptor.prototype.putReference = function (k, r) { this._put(k, { kind: "ref", value: r }); };
ActionDescriptor.prototype.putObject = function (k, cls, d) { this._put(k, { kind: "obj", cls: cls, value: d }); };
ActionDescriptor.prototype.putDouble = function (k, v) { this._put(k, { kind: "double", value: v }); };
ActionDescriptor.prototype.putInteger = function (k, v) { this._put(k, { kind: "int", value: v }); };
ActionDescriptor.prototype.putBoolean = function (k, v) { this._put(k, { kind: "bool", value: v }); };
ActionDescriptor.prototype.putString = function (k, v) { this._put(k, { kind: "string", value: v }); };
ActionDescriptor.prototype.putEnumerated = function (k, t, v) { this._put(k, { kind: "enum", type: t, value: v }); };
ActionDescriptor.prototype.putUnitDouble = function (k, u, v) { this._put(k, { kind: "unit", unit: u, value: v }); };
ActionDescriptor.prototype.putList = function (k, l) { this._put(k, { kind: "list", value: l }); };
ActionDescriptor.prototype.putPath = function (k, f) { this._put(k, { kind: "path", value: f }); };
ActionDescriptor.prototype.hasKey = function (k) { return this.items.hasOwnProperty(k); };
ActionDescriptor.prototype.getBoolean = function (k) { return this.items[k].value; };
ActionDescriptor.prototype.get = function (k) { return this.items.hasOwnProperty(k) ? this.items[k] : null; };

function ActionList() { this.items = []; }
ActionList.prototype.putObject = function (cls, d) { this.items.push({ kind: "obj", cls: cls, value: d }); };
ActionList.prototype.putUnitDouble = function (u, v) { this.items.push({ kind: "unit", unit: u, value: v }); };

function ActionReference() { this.parts = []; }
ActionReference.prototype.putClass = function (c) { this.parts.push({ kind: "class", cls: c }); };
ActionReference.prototype.putEnumerated = function (c, t, v) { this.parts.push({ kind: "enum", cls: c, type: t, value: v }); };
ActionReference.prototype.putProperty = function (c, p) { this.parts.push({ kind: "prop", cls: c, value: p }); };

// --- Minimal Photoshop DOM stand-ins ---------------------------------------
var Units = { PIXELS: "px", CM: "cm" };
var TypeUnits = { PIXELS: "px", POINTS: "pt" };
var LayerKind = { NORMAL: "normal", TEXT: "text", SOLIDFILL: "solidfill", GRADIENTFILL: "gradientfill" };
var TextType = { POINTTEXT: "point" };
var Justification = { LEFT: "l", CENTER: "c", RIGHT: "r", CENTERJUSTIFIED: "cj" };
var PointKind = { CORNERPOINT: "corner" };
var ShapeOperation = { SHAPEXOR: "xor" };
var ToolType = { PENCIL: "pencil" };
var ColorBlendMode = { NORMAL: "normal" };
var AnchorPosition = { MIDDLECENTER: "middlecenter", TOPLEFT: "topleft" };
var ElementPlacement = { PLACEATBEGINNING: "atBeginning", PLACEATEND: "atEnd", PLACEBEFORE: "before", PLACEAFTER: "after" };
var NewDocumentMode = { RGB: "rgb" };
var DocumentFill = { TRANSPARENT: "transparent" };
function SolidColor() { this.rgb = { red: 0, green: 0, blue: 0 }; }
function PathPointInfo() {}
function SubPathInfo() {}
function File(p) { this.fsName = p; }

var host;       // per-test switches and the action log
var nextId = 1;

function MockLayer(doc, kind, name) {
    this.id = nextId++;
    this.doc = doc;
    this.kind = kind;
    this.name = name;
    this.parent = null;
    this.opacity = 100;
    this.fillOpacity = 100;
    this.bounds = [0, 0, 10, 10];
    this.textItem = {};
    this.vectorMask = null;
    this.strokeStyle = null;
    this.rasterFills = [];
    this.rasterStrokes = [];
    this.transforms = [];   // rotate / translate / resize, in call order
    this.removed = false;
    this.isSet = false;
    this.children = null;
    this.xmpMetadata = { rawData: "" };  // where an update finds what a transfer drew
    this.grouped = false;                // clipped to the layer below
}
MockLayer.prototype.remove = function () {
    detach(this);
    this.removed = true;
    if (this.doc.activeLayer === this) {
        var c = this.doc.children;
        this.doc.activeLayer = c.length ? c[c.length - 1] : null;
    }
};
MockLayer.prototype.move = function (rel, placement) {
    // failMove: true refuses every move; a function picks which ones.
    if (host.failMove === true || (typeof host.failMove === "function" && host.failMove(this, rel, placement))) {
        throw new Error("mock: move refused");
    }
    // Photoshop throws "illegal argument" when a layer set is moved into
    // another one; it can only go before/after a layer already inside.
    if (this.isSet && rel.isSet &&
        (placement === ElementPlacement.PLACEATBEGINNING || placement === ElementPlacement.PLACEATEND)) {
        throw new Error("mock: illegal argument (a layer set cannot be moved into a layer set)");
    }
    // host.setsStayPut: the pessimistic reading of that bug, where a layer set
    // may only be reordered within the container it is already in.
    if (host.setsStayPut && this.isSet) {
        var dest = (placement === ElementPlacement.PLACEBEFORE || placement === ElementPlacement.PLACEAFTER) ? rel.parent : rel;
        if (dest !== this.parent) throw new Error("mock: illegal argument (a layer set cannot change container)");
    }
    detach(this);
    if (placement === ElementPlacement.PLACEATBEGINNING && rel.isSet) {
        rel.children.push(this); this.parent = rel;               // top of the set
    } else if (placement === ElementPlacement.PLACEATEND && rel.isSet) {
        rel.children.unshift(this); this.parent = rel;            // bottom of the set
    } else if (placement === ElementPlacement.PLACEBEFORE) {
        var sib = rel.parent.children;
        sib.splice(idxOf(sib, rel) + 1, 0, this); this.parent = rel.parent;  // directly above
    } else {
        throw new Error("mock: unsupported placement " + placement);
    }
    relist(this.parent);
};
MockLayer.prototype.rotate = function (deg, anchor) {
    if (host.failRotate) throw new Error("mock: rotate refused");
    this.transforms.push({ op: "rotate", deg: deg, anchor: anchor, bounds: this.bounds.slice(0) });
};
MockLayer.prototype.translate = function (dx, dy) {
    this.transforms.push({ op: "translate", dx: dx, dy: dy });
    var b = this.bounds;
    this.bounds = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
};
MockLayer.prototype.resize = function (sx, sy, anchor) {
    this.transforms.push({ op: "resize", sx: sx, sy: sy, anchor: anchor });
    var b = this.bounds;
    this.bounds = [b[0], b[1], b[0] + (b[2] - b[0]) * sx / 100, b[1] + (b[3] - b[1]) * sy / 100];
};

function detach(lyr) {
    if (!lyr.parent) return;
    var sib = lyr.parent.children;
    var i = idxOf(sib, lyr);
    if (i >= 0) sib.splice(i, 1);
    relist(lyr.parent);
    lyr.parent = null;
}

// `children` is bottom to top for the tests; `layers` is the host's view of
// the same container, top to bottom as in Photoshop's Layers collections,
// rebuilt after every change.
function relist(container) {
    var l = [];
    for (var i = container.children.length - 1; i >= 0; i--) l.push(container.children[i]);
    container.layers = l;
}

// New layers land directly above the active one, as in Photoshop. When the
// active layer is a set, host.newInsideActiveSet puts them at the top of that
// set instead of above it (which one Photoshop does is not relied upon).
// atRootTop puts one at the top of the document instead (host.misplacePath).
function insertAbove(d, lyr, atRootTop) {
    var a = d.activeLayer;
    if (atRootTop) {
        d.children.push(lyr);
        lyr.parent = d;
    } else if (host.newInsideActiveSet && a && !a.removed && a.isSet) {
        a.children.push(lyr);
        lyr.parent = a;
    } else {
        var ok = a && !a.removed && a.parent;
        var container = ok ? a.parent : d;
        var i = ok ? idxOf(container.children, a) : -1;
        if (i < 0) container.children.push(lyr); else container.children.splice(i + 1, 0, lyr);
        lyr.parent = container;
    }
    relist(lyr.parent);
    d.activeLayer = lyr;
}

// Put a layer at the top of a container, for building the user's own layers.
function put(container, lyr) {
    container.children.push(lyr);
    lyr.parent = container;
    relist(container);
    return lyr;
}

// Photoshop reads PathPointInfo coordinates as points (1/72 inch) whatever the
// ruler units; this is where they land, in pixels, on a `res` ppi document.
function toPixels(subInfos, res) {
    var f = (typeof res === "number" && res > 0 ? res : 72) / 72;
    function sc(p) { return [p[0] * f, p[1] * f]; }
    var out = [];
    for (var s = 0; s < subInfos.length; s++) {
        var pts = subInfos[s].entireSubPath, conv = [];
        for (var i = 0; i < pts.length; i++) {
            conv.push({ anchor: sc(pts[i].anchor), leftDirection: sc(pts[i].leftDirection),
                        rightDirection: sc(pts[i].rightDirection) });
        }
        out.push({ closed: subInfos[s].closed, operation: subInfos[s].operation, entireSubPath: conv });
    }
    return out;
}

function newDoc(w, h, res) {
    var d = { width: w, height: h, resolution: res === undefined ? 72 : res,
              children: [], layers: [], activeLayer: null, selectedPath: null };
    var bg = new MockLayer(d, LayerKind.NORMAL, "Background");
    insertAbove(d, bg);

    var paths = [];
    d.pathItems = {
        length: 0,
        add: function (name, subInfos) {
            // subPathInfos: exactly what the builder passed; pixels: where it lands.
            var p = {
                name: name, subPathInfos: subInfos, pixels: toPixels(subInfos, d.resolution), removed: false,
                select: function () { d.selectedPath = p; },
                deselect: function () { if (d.selectedPath === p) d.selectedPath = null; },
                remove: function () {
                    paths.splice(idxOf(paths, p), 1);
                    d.pathItems.length = paths.length;
                    if (d.selectedPath === p) d.selectedPath = null;
                    p.removed = true;
                },
                fillPath: function (col, mode, opacity) {
                    if (host.failFillPath) throw new Error("mock: fillPath refused");
                    d.activeLayer.rasterFills.push({ rgb: col.rgb, opacity: opacity });
                },
                strokePath: function (tool) {
                    if (host.failStrokePath) throw new Error("mock: strokePath refused");
                    d.activeLayer.rasterStrokes.push({ tool: tool, fg: app.foregroundColor });
                }
            };
            paths.push(p);
            host.paths.push(p);
            d.pathItems.length = paths.length;
            return p;
        }
    };
    d.artLayers = {
        add: function () {
            var l = new MockLayer(d, LayerKind.NORMAL, "Layer");
            if (host.textBounds) l.bounds = host.textBounds.slice(0);
            insertAbove(d, l);
            return l;
        }
    };
    // doc.layerSets.add() lands at the top of the document whatever is active,
    // as the Adobe forums report ("Script for new Group(layer Set) above
    // Active Layer"); host.setsAboveActive puts it above the active layer
    // instead, the other reading. set.layerSets.add() lands inside that set,
    // at its BOTTOM, so a builder that does not move a nested set next to its
    // siblings gets the order wrong. createdIn records which collection made it.
    function makeSet(container) {
        if (host.failLayerSets === true ||
            (typeof host.failLayerSets === "function" && host.failLayerSets(container))) {
            throw new Error("mock: layer set refused");
        }
        var s = new MockLayer(d, "set", "Group");
        s.isSet = true;
        s.children = [];
        s.layers = [];
        s.createdIn = container;
        s.layerSets = {
            add: function () {
                var n = makeSet(s);
                s.children.unshift(n);
                n.parent = s;
                relist(s);
                d.activeLayer = n;
                return n;
            }
        };
        return s;
    }
    d.layerSets = {
        add: function () {
            var s = makeSet(d);
            if (host.setsAboveActive) insertAbove(d, s);
            else insertAbove(d, s, true);
            return s;
        }
    };
    return d;
}

var app = {
    preferences: { rulerUnits: Units.CM, typeUnits: TypeUnits.POINTS },
    documents: {
        length: 1,
        add: function (w, h, res, name) {
            host.added = { width: w, height: h, res: res, name: name };
            app.activeDocument = newDoc(w, h, res);
            app.documents.length = 1;
            return app.activeDocument;
        }
    },
    activeDocument: null,
    foregroundColor: "user-fg"
};

function refClass(desc) {
    var r = desc.get("null");
    return r && r.value.parts.length ? r.value.parts[0].cls : null;
}

function executeAction(id, desc, mode) {
    var d = app.activeDocument;
    host.actions.push({ id: id, desc: desc, mode: mode, selectedPath: d.selectedPath ? d.selectedPath.name : null });
    if (host.fail && host.fail(id, desc)) throw new Error("mock: Photoshop refused " + id);

    if (id === "Mk  " && refClass(desc) === "contentLayer") {
        var type = desc.get("Usng").value.get("Type");
        var lyr = new MockLayer(d, type.cls === "gradientLayer" ? LayerKind.GRADIENTFILL : LayerKind.SOLIDFILL, "Fill");
        lyr.fillType = type.cls;
        lyr.fillDesc = type.value;
        lyr.vectorMask = (!host.dropMask && d.selectedPath) ? d.selectedPath.pixels : null;
        // host.misplacePath: the shape made from this path lands at the top of
        // the document, not above the active layer.
        insertAbove(d, lyr, !!(host.misplacePath && d.selectedPath && d.selectedPath.name === host.misplacePath));
        if (host.throwAfterCreate) throw new Error("mock: failed after creating the layer");
    } else if (id === "Mk  " && refClass(desc) === "Path") {
        d.activeLayer.vectorMask = d.selectedPath ? d.selectedPath.pixels : null;
    } else if (id === "setd" && desc.get("T   ").cls === "Lefx") {
        d.activeLayer.layerStyle = desc.get("T   ").value;
    } else if (id === "setd") {
        d.activeLayer.strokeStyle = desc.get("T   ").value.get("strokeStyle").value;
    } else if (id === "newPlacedLayer") {
        // Convert to Smart Object: a new layer in the old one's place, which is gone.
        var old = d.activeLayer, box = old.parent;
        var so = new MockLayer(d, "smartobject", old.name);
        so.bounds = old.bounds.slice();
        so.opacity = old.opacity;
        so.blendMode = old.blendMode;
        so.convertedFrom = old.kind;
        so.smartFilters = [];
        box.children.splice(idxOf(box.children, old), 1, so);
        so.parent = box;
        relist(box);
        old.removed = true;
        d.activeLayer = so;
    } else if (id === "GsnB") {
        if (!d.activeLayer.smartFilters) throw new Error("mock: a filter would rasterise a layer that is not a smart object");
        d.activeLayer.smartFilters.push({ filter: "GsnB", radius: desc.get("Rds ").value });
    } else if (id === "Plc ") {
        var pl = new MockLayer(d, "smartobject", "placed");
        pl.bounds = [d.width / 2 - 50, d.height / 2 - 25, d.width / 2 + 50, d.height / 2 + 25];
        insertAbove(d, pl);
    }
}

function executeActionGet(ref) {
    var a = app.activeDocument.activeLayer;
    var out = new ActionDescriptor();
    out.putBoolean("hasVectorMask", !!(a && a.vectorMask));
    return out;
}

// --- Load the real code (global scope) -------------------------------------
eval(load("json2.js"));
eval(load("lazylord.jsx"));
eval(load("ps.jsx"));

// --- Assertions ------------------------------------------------------------
var passed = 0, failed = 0;

function ok(name, cond, detail) {
    if (cond) { WScript.Echo("  ok   " + name); passed++; }
    else { WScript.Echo("  FAIL " + name + (detail ? "  -> " + detail : "")); failed++; }
}
function near(a, b, eps) { return typeof a === "number" && Math.abs(a - b) < (eps || 1e-6); }
function xy(p) { return "[" + p[0] + "," + p[1] + "]"; }
function diags() { return JSON.stringify(LazyLord.diagnostics); }
function diagMatching(re) {
    for (var i = 0; i < LazyLord.diagnostics.length; i++) {
        if (re.test(LazyLord.diagnostics[i].reason)) return LazyLord.diagnostics[i];
    }
    return null;
}

function diagFor(object, re) {
    for (var i = 0; i < LazyLord.diagnostics.length; i++) {
        var d = LazyLord.diagnostics[i];
        if (d.object === object && re.test(d.reason)) return d;
    }
    return null;
}

function reset(opts) {
    opts = opts || {};
    host = { actions: [], paths: [] };
    app.preferences.rulerUnits = Units.CM;
    app.preferences.typeUnits = TypeUnits.POINTS;
    app.foregroundColor = "user-fg";
    app.activeDocument = newDoc(1000, 800, opts.res);
    app.documents.length = 1;
    LazyLord.resetDiagnostics();
}

function actions(id, cls) {
    var out = [];
    for (var i = 0; i < host.actions.length; i++) {
        var a = host.actions[i];
        if (a.id === id && (!cls || refClass(a.desc) === cls)) out.push(a);
    }
    return out;
}

// Every live layer, depth first, bottom to top.
function allLayers(container, out) {
    out = out || [];
    for (var i = 0; i < container.children.length; i++) {
        var l = container.children[i];
        out.push(l);
        if (l.isSet) allLayers(l, out);
    }
    return out;
}
function ofKind(kind) {
    var all = allLayers(app.activeDocument), out = [];
    for (var i = 0; i < all.length; i++) if (all[i].kind === kind) out.push(all[i]);
    return out;
}
function names(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i].name);
    return out.join(",");
}

function rectPath(w, h) {
    return {
        closed: true,
        vertices: [[0, 0], [w, 0], [w, h], [0, h]],
        inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
        outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]]
    };
}
function solid(r, g, b, a) { return { type: "solid", color: { r: r, g: g, b: b, a: a === undefined ? 1 : a } }; }
function vec(name, frame, fills, strokes, clip) {
    return { type: "vector", id: name, name: name, frame: frame, subpaths: [rectPath(frame.width, frame.height)],
             fills: fills || [], strokes: strokes || [], clip: clip };
}
function irDoc(layers, extra) {
    var d = { version: "1.0", source: "figma", name: "Test", originSpace: "canvas",
              bounds: { x: 0, y: 0, width: 400, height: 300 }, layers: layers };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) d[k] = extra[k];
    return d;
}

// Drill into a recorded contentLayer Mk: { cls, body } of its Type object.
function contentType(action) {
    var t = action.desc.get("Usng").value.get("Type");
    return { cls: t.cls, body: t.value };
}

WScript.Echo("LazyLord - Photoshop builder (mocked DOM + ActionManager)");
WScript.Echo("");

// 1) A solid fill becomes a native shape layer: a solidColorLayer masked by the path.
(function () {
    reset();
    var res = LazyLord.build(irDoc([vec("Box", { x: 10, y: 20, width: 100, height: 50 }, [solid(1, 0.5, 0)])]));
    var mk = actions("Mk  ", "contentLayer");

    ok("solid: one layer created", res.layersCreated === 1, String(res.layersCreated));
    ok("solid: one Mk contentLayer", mk.length === 1, String(mk.length));
    var d = mk[0].desc;
    ok("solid: Usng is a contentLayer object", d.get("Usng").kind === "obj" && d.get("Usng").cls === "contentLayer");
    var t = contentType(mk[0]);
    ok("solid: Type is solidColorLayer", t.cls === "solidColorLayer", t.cls);
    var clr = t.body.get("Clr ");
    ok("solid: colour is an RGBC object", clr.cls === "RGBC");
    ok("solid: RGB 255,128,0",
       clr.value.get("Rd  ").value === 255 && clr.value.get("Grn ").value === 128 && clr.value.get("Bl  ").value === 0,
       clr.value.get("Rd  ").value + "," + clr.value.get("Grn ").value + "," + clr.value.get("Bl  ").value);
    ok("solid: the temp path was selected when the layer was made", mk[0].selectedPath === "LazyLord Box", mk[0].selectedPath);
    ok("solid: executeAction runs without dialogs", mk[0].mode === DialogModes.NO);

    var fills = ofKind(LayerKind.SOLIDFILL);
    ok("solid: exactly one fill layer, named after the IR layer", fills.length === 1 && fills[0].name === "Box", names(fills));
    var a0 = fills[0].vectorMask[0].entireSubPath[0].anchor;
    ok("solid: vector mask placed at frame origin", near(a0[0], 10) && near(a0[1], 20), xy(a0));
    ok("solid: temp path removed from the Paths panel", app.activeDocument.pathItems.length === 0,
       String(app.activeDocument.pathItems.length));
    ok("solid: no raster layer made", ofKind(LayerKind.NORMAL).length === 1, names(ofKind(LayerKind.NORMAL)));
    ok("solid: no diagnostics", LazyLord.diagnostics.length === 0, diags());
    ok("solid: ruler units restored", app.preferences.rulerUnits === Units.CM && app.preferences.typeUnits === TypeUnits.POINTS);
})();

// 2) A linear gradient becomes a gradientLayer with Photoshop's stop encoding.
(function () {
    reset();
    var paint = { type: "linear-gradient", from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 }, stops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 0.5, color: { r: 0, g: 1, b: 0, a: 0.5 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }
    ]};
    LazyLord.build(irDoc([vec("Ramp", { x: 0, y: 0, width: 200, height: 100 }, [paint])]));
    var mk = actions("Mk  ", "contentLayer");
    ok("linear: one Mk contentLayer", mk.length === 1, String(mk.length));
    var t = contentType(mk[0]);
    var g = t.body;
    ok("linear: Type is gradientLayer", t.cls === "gradientLayer", t.cls);
    ok("linear: GrdT Lnr", g.get("Type").type === "GrdT" && g.get("Type").value === "Lnr ", g.get("Type").value);
    ok("linear: angle 0 in #Ang", g.get("Angl").unit === "#Ang" && near(g.get("Angl").value, 0), String(g.get("Angl").value));
    ok("linear: full-width ramp is Scl 100%", g.get("Scl ").unit === "#Prc" && near(g.get("Scl ").value, 100),
       String(g.get("Scl ").value));
    var of = g.get("Ofst");
    ok("linear: centred (Ofst 0,0 in #Prc)",
       of.value.get("Hrzn").unit === "#Prc" && near(of.value.get("Hrzn").value, 0) && near(of.value.get("Vrtc").value, 0));
    ok("linear: aligned with the layer", g.get("Algn").value === true);

    var grad = g.get("Grad");
    ok("linear: Grad is a Grdn object", grad.cls === "Grdn");
    ok("linear: custom stops (GrdF CstS)", grad.value.get("GrdF").value === "CstS");
    ok("linear: smoothness Intr 4096", grad.value.get("Intr").value === 4096);

    var clrs = grad.value.get("Clrs").value.items;
    ok("linear: three colour stops", clrs.length === 3, String(clrs.length));
    var locs = [], mids = [], kinds = [];
    for (var i = 0; i < clrs.length; i++) {
        locs.push(clrs[i].value.get("Lctn").value);
        kinds.push(clrs[i].value.get("Lctn").kind);
        mids.push(clrs[i].value.get("Mdpn").value);
    }
    ok("linear: stops are Clrt objects", clrs[0].cls === "Clrt");
    ok("linear: Lctn scaled to 0..4096", locs.join(",") === "0,2048,4096", locs.join(","));
    ok("linear: Lctn is an integer", kinds.join(",") === "int,int,int", kinds.join(","));
    ok("linear: midpoints 50", mids.join(",") === "50,50,50", mids.join(","));
    ok("linear: stop colour type UsrS", clrs[0].value.get("Type").type === "Clry" && clrs[0].value.get("Type").value === "UsrS");
    ok("linear: first stop red", clrs[0].value.get("Clr ").value.get("Rd  ").value === 255);
    ok("linear: last stop blue", clrs[2].value.get("Clr ").value.get("Bl  ").value === 255);

    var trns = grad.value.get("Trns").value.items;
    var ops = [];
    for (var j = 0; j < trns.length; j++) ops.push(trns[j].value.get("Opct").value);
    ok("linear: transparency stops carry stop alpha", trns[0].cls === "TrnS" && ops.join(",") === "100,50,100", ops.join(","));
    ok("linear: shape layer is a gradient fill", ofKind(LayerKind.GRADIENTFILL).length === 1);
    ok("linear: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

// 3) Gradient geometry: angle sign, scale and offset against the layer box.
(function () {
    var box = { x: 0, y: 0, width: 200, height: 100 };
    function geo(type, fx, fy, tx, ty) {
        var g = LazyLord.gradientPx({ frame: box }, { type: type, stops: [], from: { x: fx, y: fy }, to: { x: tx, y: ty } });
        return LazyLord._ps_gradientGeometry(box, g);
    }
    var down = geo("linear-gradient", 0.5, 0, 0.5, 1);
    ok("geometry: top-to-bottom ramp is -90 deg (Photoshop turns counter-clockwise)", near(down.angle, -90), String(down.angle));
    ok("geometry: full-height ramp is 100%", near(down.scale, 100), String(down.scale));
    var up = geo("linear-gradient", 0.5, 1, 0.5, 0);
    ok("geometry: bottom-to-top ramp is +90 deg", near(up.angle, 90), String(up.angle));
    var left = geo("linear-gradient", 1, 0.5, 0, 0.5);
    ok("geometry: right-to-left ramp is 180 deg", near(left.angle, 180), String(left.angle));

    var diag = geo("linear-gradient", 0, 0, 1, 1);
    ok("geometry: corner-to-corner angle", near(diag.angle, -Math.atan2(100, 200) * 180 / Math.PI), String(diag.angle));
    ok("geometry: corner-to-corner is 100% (half-length reaches the box edge)", near(diag.scale, 100), String(diag.scale));

    var half = geo("linear-gradient", 0.25, 0.5, 0.75, 0.5);
    ok("geometry: half-width ramp is 50%", near(half.scale, 50) && near(half.offsetX, 0), half.scale + " / " + half.offsetX);
    var shifted = geo("linear-gradient", 0.5, 0.5, 1, 0.5);
    // 100 px ramp: half-length 50 px against a 100 px reach to the side edge.
    ok("geometry: ramp on the right half is 50%, centred +25%",
       near(shifted.scale, 50) && near(shifted.offsetX, 25) && near(shifted.offsetY, 0),
       shifted.scale + " / " + shifted.offsetX + "," + shifted.offsetY);

    var rad = geo("radial-gradient", 0.5, 0.5, 1, 0.5);
    ok("geometry: radial to the side edge is 100%", rad.radial && near(rad.scale, 100) && near(rad.angle, 0),
       rad.scale + " @ " + rad.angle);
    var radLow = geo("radial-gradient", 0.25, 0.5, 0.25, 1);
    ok("geometry: radial centre offset -25%, radius to the bottom edge is 100%",
       near(radLow.offsetX, -25) && near(radLow.offsetY, 0) && near(radLow.scale, 100) && near(radLow.angle, -90),
       radLow.offsetX + "," + radLow.offsetY + " " + radLow.scale + "% @ " + radLow.angle);

    var threw = false;
    try { geo("linear-gradient", 0.5, 0.5, 0.5, 0.5); } catch (e) { threw = true; }
    ok("geometry: coincident handles are refused", threw);
})();

// 4) A radial gradient becomes GrdT Rdl.
(function () {
    reset();
    var paint = { type: "radial-gradient", from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 }, stops: [
        { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 0, a: 0 } }
    ]};
    LazyLord.build(irDoc([vec("Glow", { x: 50, y: 50, width: 200, height: 100 }, [paint])]));
    var g = contentType(actions("Mk  ", "contentLayer")[0]).body;
    ok("radial: GrdT Rdl", g.get("Type").value === "Rdl ", g.get("Type").value);
    ok("radial: Scl 100%", near(g.get("Scl ").value, 100), String(g.get("Scl ").value));
    var trns = g.get("Grad").value.get("Trns").value.items;
    ok("radial: transparent outer stop", trns[1].value.get("Opct").value === 0, String(trns[1].value.get("Opct").value));
})();

// 5) A gradient shorter than Photoshop allows is clamped, and says so.
(function () {
    reset();
    var paint = { type: "linear-gradient", from: { x: 0.5, y: 0.5 }, to: { x: 0.52, y: 0.5 }, stops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }
    ]};
    LazyLord.build(irDoc([vec("Sharp", { x: 0, y: 0, width: 200, height: 100 }, [paint])]));
    var g = contentType(actions("Mk  ", "contentLayer")[0]).body;
    ok("clamp: scale clamped to 10%", near(g.get("Scl ").value, 10), String(g.get("Scl ").value));
    var dg = diagMatching(/clamped/);
    ok("clamp: reported as approximated", dg && dg.resolution === "approximated" && dg.object === "Sharp", diags());
})();

// 6) Fallbacks: Photoshop refusing a native layer never leaves one behind.
(function () {
    reset();
    host.fail = function (id) { return id === "Mk  "; };
    var res = LazyLord.build(irDoc([vec("Box", { x: 10, y: 20, width: 100, height: 50 }, [solid(1, 0.5, 0)])]));
    var raster = ofKind(LayerKind.NORMAL);
    ok("fallback: still counts as created", res.layersCreated === 1, String(res.layersCreated));
    ok("fallback: raster layer named after the IR layer", raster.length === 2 && raster[1].name === "Box", names(raster));
    ok("fallback: painted with fillPath in the fill colour",
       raster[1].rasterFills.length === 1 && raster[1].rasterFills[0].rgb.red === 255 && raster[1].rasterFills[0].rgb.green === 128,
       JSON.stringify(raster[1].rasterFills));
    ok("fallback: no fill layer left behind", ofKind(LayerKind.SOLIDFILL).length === 0);
    var dg = diagMatching(/native shape layer/);
    ok("fallback: reported as approximated with the reason",
       dg && dg.resolution === "approximated" && /refused/.test(dg.reason), diags());
    ok("fallback: temp path removed", app.activeDocument.pathItems.length === 0);
})();

(function () {
    reset();
    host.fail = function (id, desc) {
        return id === "Mk  " && refClass(desc) === "contentLayer" && contentType({ desc: desc }).cls === "gradientLayer";
    };
    var paint = { type: "linear-gradient", from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, stops: [
        { position: 0, color: { r: 0, g: 0, b: 1, a: 1 } }, { position: 1, color: { r: 1, g: 0, b: 0, a: 1 } }
    ]};
    LazyLord.build(irDoc([vec("Ramp", { x: 0, y: 0, width: 100, height: 100 }, [paint])]));
    var fills = ofKind(LayerKind.SOLIDFILL);
    ok("gradient fallback: flat-colour shape layer instead", fills.length === 1 && ofKind(LayerKind.GRADIENTFILL).length === 0);
    ok("gradient fallback: uses the first stop's colour", fills.length === 1 && fills[0].fillDesc.get("Clr ").value.get("Bl  ").value === 255);
    var dg = diagMatching(/flat colour from its first stop/);
    ok("gradient fallback: reported as approximated", dg && dg.resolution === "approximated", diags());
})();

(function () {
    reset();
    host.throwAfterCreate = true;
    LazyLord.build(irDoc([vec("Box", { x: 0, y: 0, width: 10, height: 10 }, [solid(0, 0, 0)])]));
    ok("half-made: a layer created by a failing call is removed", ofKind(LayerKind.SOLIDFILL).length === 0,
       names(allLayers(app.activeDocument)));
    ok("half-made: raster fill used instead", ofKind(LayerKind.NORMAL).length === 2);
})();

(function () {
    reset();
    host.dropMask = true;
    LazyLord.build(irDoc([vec("Box", { x: 0, y: 0, width: 10, height: 10 }, [solid(0, 0, 0)])]));
    ok("no mask: a fill layer without its vector mask is removed", ofKind(LayerKind.SOLIDFILL).length === 0);
    var dg = diagMatching(/vector mask/);
    ok("no mask: reason names the missing vector mask", dg && dg.resolution === "approximated", diags());
})();

(function () {
    reset();
    host.fail = function (id) { return id === "Mk  "; };
    host.failFillPath = true;
    var res = LazyLord.build(irDoc([vec("Box", { x: 0, y: 0, width: 10, height: 10 }, [solid(0, 0, 0)])]));
    ok("last rung: nothing works -> layer skipped", res.layersCreated === 0 && diagMatching(/fillPath refused/) &&
       diagMatching(/fillPath refused/).resolution === "skipped", diags());
    ok("last rung: the empty raster layer is removed", ofKind(LayerKind.NORMAL).length === 1, names(ofKind(LayerKind.NORMAL)));
    ok("last rung: temp path still removed", app.activeDocument.pathItems.length === 0);
})();

// 7) Strokes: a vector stroke on the shape layer, or the pencil when refused.
(function () {
    reset();
    var stroke = { paint: solid(0, 0, 1), weight: 3, cap: "round", join: "round", align: "inside" };
    LazyLord.build(irDoc([vec("Pill", { x: 0, y: 0, width: 100, height: 40 }, [solid(1, 0, 0)], [stroke])]));
    var setd = actions("setd");
    ok("stroke: one set shapeStyle call", setd.length === 1, String(setd.length));
    var d = setd[0].desc;
    ok("stroke: targets the contentLayer",
       d.get("null").value.parts[0].cls === "contentLayer" && d.get("null").value.parts[0].value === "Trgt");
    ok("stroke: T is a shapeStyle object", d.get("T   ").cls === "shapeStyle");
    var ss = d.get("T   ").value.get("strokeStyle").value;
    ok("stroke: width 3 #Pxl", ss.get("strokeStyleLineWidth").unit === "#Pxl" && ss.get("strokeStyleLineWidth").value === 3);
    ok("stroke: enabled, fill kept", ss.get("strokeEnabled").value === true && ss.get("fillEnabled").value === true);
    ok("stroke: round cap", ss.get("strokeStyleLineCapType").value === "strokeStyleRoundCap");
    ok("stroke: round join", ss.get("strokeStyleLineJoinType").value === "strokeStyleRoundJoin");
    ok("stroke: inside alignment", ss.get("strokeStyleLineAlignment").value === "strokeStyleAlignInside");
    ok("stroke: solid blue content",
       ss.get("strokeStyleContent").cls === "solidColorLayer" &&
       ss.get("strokeStyleContent").value.get("Clr ").value.get("Bl  ").value === 255);
    var fills = ofKind(LayerKind.SOLIDFILL);
    ok("stroke: carried by the fill's own shape layer", fills.length === 1 && fills[0].strokeStyle === ss, names(fills));
    ok("stroke: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

(function () {
    reset();
    var stroke = { paint: solid(0, 0, 0), weight: 2 };
    var res = LazyLord.build(irDoc([vec("Line", { x: 0, y: 0, width: 100, height: 1 }, [], [stroke])]));
    var fills = ofKind(LayerKind.SOLIDFILL);
    ok("stroke only: one stroke-only shape layer", res.layersCreated === 1 && fills.length === 1, names(fills));
    ok("stroke only: fill disabled", fills.length === 1 && fills[0].strokeStyle && fills[0].strokeStyle.get("fillEnabled").value === false);
    ok("stroke only: named as the stroke", fills.length === 1 && fills[0].name === "Line stroke", names(fills));
})();

(function () {
    reset();
    host.fail = function (id) { return id === "setd"; };
    var stroke = { paint: solid(0, 1, 0), weight: 3 };
    LazyLord.build(irDoc([vec("Pill", { x: 0, y: 0, width: 100, height: 40 }, [solid(1, 0, 0)], [stroke])]));
    var raster = ofKind(LayerKind.NORMAL);
    ok("stroke fallback: fill shape layer kept", ofKind(LayerKind.SOLIDFILL).length === 1);
    ok("stroke fallback: pencil stroke on a raster layer",
       raster.length === 2 && raster[1].name === "Pill stroke" && raster[1].rasterStrokes.length === 1 &&
       raster[1].rasterStrokes[0].tool === ToolType.PENCIL, names(raster));
    ok("stroke fallback: stroked in the stroke colour",
       raster.length === 2 && raster[1].rasterStrokes[0].fg.rgb.green === 255);
    ok("stroke fallback: foreground colour restored", app.foregroundColor === "user-fg");
    var dg = diagMatching(/3 px weight/);
    ok("stroke fallback: warns that the weight is not honoured", dg && dg.resolution === "approximated", diags());
})();

(function () {
    reset();
    var stroke = { paint: solid(0, 0, 0), weight: 1 };
    LazyLord.build(irDoc([vec("Veil", { x: 0, y: 0, width: 100, height: 40 }, [solid(0, 0, 0, 0.5)], [stroke])]));
    var fills = ofKind(LayerKind.SOLIDFILL);
    ok("translucent fill: Fill opacity 50", fills.length === 2 && fills[0].fillOpacity === 50, names(fills));
    ok("translucent fill: stroke on its own layer so it is not faded",
       fills.length === 2 && fills[0].strokeStyle === null && fills[1].strokeStyle !== null);
})();

// 8) Clipping: each run of consecutive layers sharing a clip id becomes a group
// with a vector mask; a layer built in between splits the run, so the stacking
// order is kept exactly.
(function () {
    reset();
    function clip() {
        // Each layer carries its own copy, as the IR requires.
        return { id: "m1", name: "Mask", subpaths: [rectPath(50, 50)] };
    }
    var res = LazyLord.build(irDoc([
        vec("A", { x: 0, y: 0, width: 80, height: 80 }, [solid(1, 0, 0)], [], clip()),
        vec("B", { x: 0, y: 0, width: 20, height: 20 }, [solid(0, 1, 0)]),
        vec("C", { x: 30, y: 30, width: 80, height: 80 }, [solid(0, 0, 1)], [], clip())
    ], { originSpace: "document", bounds: { x: 5, y: 7, width: 110, height: 110 } }));

    var top = app.activeDocument.children;
    ok("clip: three layers created", res.layersCreated === 3, String(res.layersCreated));
    ok("clip: stacking kept, B still between A and C", names(top) === "Background,Mask,B,Mask", names(top));
    var set = top[1], upper = top[3];
    ok("clip: each run is a layer set named after the mask",
       set.isSet && upper.isSet && set.name === "Mask" && upper.name === "Mask");
    ok("clip: A in the lower group, C in the upper one",
       set.isSet && names(set.children) === "A" && upper.isSet && names(upper.children) === "C",
       set.isSet && upper.isSet && names(set.children) + " / " + names(upper.children));

    var mk = actions("Mk  ", "Path");
    ok("clip: one vector-mask Mk per group", mk.length === 2, String(mk.length));
    var ua = upper.vectorMask && upper.vectorMask[0].entireSubPath[2].anchor;
    ok("clip: the upper group carries the same mask", ua && near(ua[0], 55) && near(ua[1], 57), ua && xy(ua));
    var d = mk[0].desc;
    ok("clip: null = ref class Path", d.get("null").value.parts[0].kind === "class" && d.get("null").value.parts[0].cls === "Path");
    var at = d.get("At  ").value.parts[0];
    ok("clip: At = Path enum vectorMask", at.cls === "Path" && at.type === "Path" && at.value === "vectorMask",
       at.cls + "/" + at.type + "/" + at.value);
    var us = d.get("Usng").value.parts[0];
    ok("clip: Usng = Path Ordn Trgt", us.cls === "Path" && us.type === "Ordn" && us.value === "Trgt",
       us.cls + "/" + us.type + "/" + us.value);
    ok("clip: the clip outline was the selected path", mk[0].selectedPath === "LazyLord Mask", mk[0].selectedPath);
    var a0 = set.vectorMask && set.vectorMask[0].entireSubPath[0].anchor;
    ok("clip: mask in document space, shifted once by the origin", a0 && near(a0[0], 5) && near(a0[1], 7), a0 && xy(a0));
    var a2 = set.vectorMask && set.vectorMask[0].entireSubPath[2].anchor;
    ok("clip: mask not offset by any layer frame", a2 && near(a2[0], 55) && near(a2[1], 57), a2 && xy(a2));
    ok("clip: all temp paths removed", app.activeDocument.pathItems.length === 0, String(app.activeDocument.pathItems.length));
    ok("clip: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

(function () {
    reset();
    host.fail = function (id, desc) { return id === "Mk  " && refClass(desc) === "Path"; };
    var c = { id: "m2", name: "Frame", subpaths: [rectPath(10, 10)] };
    LazyLord.build(irDoc([vec("A", { x: 0, y: 0, width: 20, height: 20 }, [solid(1, 0, 0)], [], c)]));
    var top = app.activeDocument.children;
    ok("clip fallback: layers still grouped", top.length === 2 && top[1].isSet && names(top[1].children) === "A", names(top));
    ok("clip fallback: no vector mask on the group", top[1].vectorMask === null);
    var dg = diagMatching(/grouped but unclipped/);
    ok("clip fallback: reported as approximated", dg && dg.resolution === "approximated" && dg.object === "Frame", diags());
    ok("clip fallback: temp path removed", app.activeDocument.pathItems.length === 0);
})();

(function () {
    reset();
    host.failMove = true;
    var c = { id: "m3", name: "Frame", subpaths: [rectPath(10, 10)] };
    LazyLord.build(irDoc([vec("A", { x: 0, y: 0, width: 20, height: 20 }, [solid(1, 0, 0)], [], c)]));
    var top = app.activeDocument.children;
    ok("group fallback: no empty group left behind", names(top) === "Background,A", names(top));
    ok("group fallback: reported as left unclipped", diagMatching(/left unclipped/) !== null, diags());
})();

(function () {
    reset();
    // Only B refuses to go into the group; A and C still do.
    host.failMove = function (lyr, rel) { return lyr.name === "B" && rel.isSet; };
    function c() { return { id: "m4", name: "Frame", subpaths: [rectPath(10, 10)] }; }
    var res = LazyLord.build(irDoc([
        vec("A", { x: 0, y: 0, width: 20, height: 20 }, [solid(1, 0, 0)], [], c()),
        vec("B", { x: 0, y: 0, width: 20, height: 20 }, [solid(0, 1, 0)], [], c()),
        vec("C", { x: 0, y: 0, width: 20, height: 20 }, [solid(0, 0, 1)], [], c())
    ]));
    var top = app.activeDocument.children;
    ok("partial group: three layers created", res.layersCreated === 3, String(res.layersCreated));
    ok("partial group: the stuck layer stays outside, the others are grouped",
       names(top) === "Background,B,Frame" && names(top[2].children) === "A,C", names(top));
    ok("partial group: the group is still masked", top.length === 3 && top[2].vectorMask !== null);
    var dg = diagMatching(/1 of 3 clipped layers could not be moved/);
    ok("partial group: reported, naming the unclipped layers",
       dg && dg.resolution === "approximated" && dg.object === "Frame" && /left unclipped/.test(dg.reason), diags());
    ok("partial group: nothing else reported", LazyLord.diagnostics.length === 1, diags());
})();

(function () {
    reset();
    // A nested mask reduced to its innermost clip: Outer recurs above Inner.
    function outer() { return { id: "m1", name: "Outer", subpaths: [rectPath(100, 100)] }; }
    function inner() { return { id: "m2", name: "Inner", subpaths: [rectPath(40, 40)] }; }
    function f() { return { x: 0, y: 0, width: 60, height: 60 }; }
    var res = LazyLord.build(irDoc([
        vec("P", f(), [solid(1, 0, 0)], [], outer()),
        vec("Q", f(), [solid(1, 1, 0)], [], outer()),
        { type: "widget", name: "Widget", frame: f() },  // builds nothing (unsupported type)
        vec("R", f(), [solid(0, 1, 1)], [], outer()),
        vec("Y", f(), [solid(0, 1, 0)], [], inner()),
        vec("Z", f(), [solid(0, 0, 1)], [], outer())
    ]));
    var top = app.activeDocument.children;
    ok("clip runs: five layers created", res.layersCreated === 5, String(res.layersCreated));
    ok("clip runs: stacking order kept", names(top) === "Background,Outer,Inner,Outer", names(top));
    ok("clip runs: a layer that built nothing does not split a run",
       top.length === 4 && names(top[1].children) === "P,Q,R", top.length === 4 && names(top[1].children));
    ok("clip runs: the inner mask has its own group", top.length === 4 && names(top[2].children) === "Y");
    ok("clip runs: the recurring mask gets a second group above it", top.length === 4 && names(top[3].children) === "Z");
    ok("clip runs: every group masked", top.length === 4 && top[1].vectorMask && top[2].vectorMask && top[3].vectorMask);
    ok("clip runs: only the unsupported layer is reported",
       LazyLord.diagnostics.length === 1 && diagMatching(/not supported/) !== null, diags());
})();

// 9) Rotation: text and images turn clockwise about the IR frame centre.
function applyTransforms(lyr, p) {
    // Replays the recorded rotate/translate calls on a point.
    var q = [p[0], p[1]];
    for (var i = 0; i < lyr.transforms.length; i++) {
        var t = lyr.transforms[i];
        if (t.op === "rotate") {
            var b = t.bounds;
            var c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
            var r = t.deg * Math.PI / 180;
            var dx = q[0] - c[0], dy = q[1] - c[1];
            q = [c[0] + dx * Math.cos(r) - dy * Math.sin(r), c[1] + dx * Math.sin(r) + dy * Math.cos(r)];
        } else if (t.op === "translate") {
            q = [q[0] + t.dx, q[1] + t.dy];
        }
    }
    return q;
}

(function () {
    reset();
    host.textBounds = [100, 102, 260, 120]; // ink box: NOT centred on the frame
    var text = { type: "text", id: "t", name: "Title", characters: "Hello", fontFamily: "Inter", fontStyle: "Regular",
                 fontSize: 20, color: { r: 0, g: 0, b: 0, a: 1 },
                 frame: { x: 100, y: 100, width: 200, height: 40, rotation: 30 } };
    LazyLord.build(irDoc([text]));
    var lyr = app.activeDocument.children[1];
    var rot = [];
    for (var i = 0; i < lyr.transforms.length; i++) if (lyr.transforms[i].op === "rotate") rot.push(lyr.transforms[i]);
    ok("text rotation: one rotate call, 30 deg clockwise", rot.length === 1 && rot[0].deg === 30, JSON.stringify(lyr.transforms));
    ok("text rotation: pivots MIDDLECENTER", rot.length === 1 && rot[0].anchor === AnchorPosition.MIDDLECENTER);
    ok("text rotation: placed unrotated on its baseline", near(lyr.textItem.position[0], 100) && near(lyr.textItem.position[1], 116),
       xy(lyr.textItem.position));
    var c = applyTransforms(lyr, [200, 120]);
    ok("text rotation: frame centre stays put (net turn is about the frame centre)", near(c[0], 200, 1e-6) && near(c[1], 120, 1e-6), xy(c));
    var anchor = applyTransforms(lyr, [100, 116]);
    var want = LazyLord.rotatedTextAnchor(text);
    ok("text rotation: baseline start lands on rotatedTextAnchor", near(anchor[0], want[0]) && near(anchor[1], want[1]),
       xy(anchor) + " vs " + xy(want));
})();

(function () {
    reset();
    var img = { type: "image", id: "i", name: "Photo", filePath: "C:\\img.png", pixelWidth: 400, pixelHeight: 200,
                frame: { x: 50, y: 60, width: 200, height: 100, rotation: 45 } };
    LazyLord.build(irDoc([img]));
    ok("image: placed via Plc", actions("Plc ").length === 1);
    var lyr = app.activeDocument.children[1];
    var ops = [];
    for (var i = 0; i < lyr.transforms.length; i++) ops.push(lyr.transforms[i].op);
    ok("image: resized, moved, then rotated about its own centre (no correction needed)",
       ops.join(",") === "resize,translate,rotate", ops.join(","));
    var last = lyr.transforms[lyr.transforms.length - 1];
    ok("image: 45 deg about MIDDLECENTER", last.deg === 45 && last.anchor === AnchorPosition.MIDDLECENTER);
    ok("image: box matches the frame before turning",
       near(last.bounds[0], 50) && near(last.bounds[1], 60) && near(last.bounds[2], 250) && near(last.bounds[3], 160),
       last.bounds.join(","));
})();

(function () {
    reset();
    host.failRotate = true;
    var img = { type: "image", id: "i", name: "Photo", filePath: "C:\\img.png", pixelWidth: 10, pixelHeight: 10,
                frame: { x: 0, y: 0, width: 10, height: 10, rotation: 10 } };
    var res = LazyLord.build(irDoc([img]));
    var dg = diagMatching(/placed unrotated/);
    ok("rotation fallback: image kept, reported", res.layersCreated === 1 && dg && dg.resolution === "approximated", diags());
})();

// 10) Canvas: a new document takes the source page size.
(function () {
    reset();
    app.documents.length = 0;
    LazyLord.build(irDoc([vec("Box", { x: 0, y: 0, width: 10, height: 10 }, [solid(0, 0, 0)])], {
        originSpace: "document", bounds: { x: 10, y: 10, width: 100, height: 100 }, canvas: { width: 800, height: 600 }
    }));
    ok("canvas: new document sized to the source page", host.added && host.added.width === 800 && host.added.height === 600,
       JSON.stringify(host.added));
    ok("canvas: 72 ppi", host.added && host.added.res === 72);

    reset();
    app.documents.length = 0;
    LazyLord.build(irDoc([vec("Box", { x: 0, y: 0, width: 10, height: 10 }, [solid(0, 0, 0)])], {
        originSpace: "canvas", bounds: { x: 4000, y: 2000, width: 300, height: 200 }, canvas: { width: 1920, height: 1080 }
    }));
    ok("canvas: canvas-space sources use the selection size", host.added && host.added.width === 300 && host.added.height === 200,
       JSON.stringify(host.added));

    reset();
    LazyLord.build(irDoc([vec("Box", { x: 0, y: 0, width: 10, height: 10 }, [solid(0, 0, 0)])]));
    ok("canvas: an open document is reused", !host.added);

    reset();
    LazyLord.build(irDoc([vec("Box", { x: 0, y: 0, width: 10, height: 10 }, [solid(0, 0, 0)])], {
        name: "Icon", options: { destination: "new" }
    }));
    ok("destination new: a new document although one is open, sized and named after the selection",
       host.added && host.added.name === "Icon" && host.added.width === 400 && host.added.height === 300,
       JSON.stringify(host.added));
})();

// 11) Units are restored even when something throws mid-build.
(function () {
    reset();
    var threw = false;
    var bad = { type: "vector", name: "Bad", frame: { x: 0, y: 0, width: 1, height: 1 },
                subpaths: [{ closed: true, vertices: [[0, 0]], inTangents: null, outTangents: null }], fills: [solid(0, 0, 0)], strokes: [] };
    var res;
    try { res = LazyLord.build(irDoc([bad, { type: "widget", name: "Widget", frame: { x: 0, y: 0, width: 1, height: 1 } }])); }
    catch (e) { threw = true; }
    ok("robust: a broken layer is skipped, not fatal", !threw && res.layersCreated === 0, threw ? "threw" : String(res.layersCreated));
    ok("robust: broken layer reported as skipped", diagMatching(/.+/) && LazyLord.diagnostics[0].object === "Bad" &&
       LazyLord.diagnostics[0].resolution === "skipped", diags());
    ok("robust: unsupported layer type reported", diagMatching(/not supported/) !== null, diags());
    ok("robust: units restored", app.preferences.rulerUnits === Units.CM && app.preferences.typeUnits === TypeUnits.POINTS);
})();

// 12) Paths on a document that is not 72 ppi: Photoshop reads PathPointInfo as
// points, so the builder scales by 72 / resolution and outlines land in pixels.
(function () {
    reset({ res: 300 });
    var c = { id: "m5", name: "Mask", subpaths: [rectPath(50, 50)] };
    var box = vec("Box", { x: 10, y: 20, width: 100, height: 50 }, [solid(1, 0, 0)], [], c);
    box.subpaths[0].outTangents[0] = [30, 0]; // a curve handle, relative to its vertex
    var res = LazyLord.build(irDoc([box]));
    ok("300 ppi: layer created", res.layersCreated === 1, String(res.layersCreated));

    var raw = host.paths.length ? host.paths[0].subPathInfos[0].entireSubPath : null;
    ok("300 ppi: anchors handed to Photoshop scaled by 72/300",
       raw && near(raw[0].anchor[0], 10 * 72 / 300) && near(raw[0].anchor[1], 20 * 72 / 300), raw && xy(raw[0].anchor));
    ok("300 ppi: direction points scaled too",
       raw && near(raw[0].rightDirection[0], 40 * 72 / 300) && near(raw[0].leftDirection[1], 20 * 72 / 300),
       raw && xy(raw[0].rightDirection) + " " + xy(raw[0].leftDirection));

    var fills = ofKind(LayerKind.SOLIDFILL);
    var m = fills.length === 1 && fills[0].vectorMask ? fills[0].vectorMask[0].entireSubPath : null;
    ok("300 ppi: shape outline lands on the frame in pixels",
       m && near(m[0].anchor[0], 10) && near(m[0].anchor[1], 20) && near(m[2].anchor[0], 110) && near(m[2].anchor[1], 70),
       m && xy(m[0].anchor) + " " + xy(m[2].anchor));
    ok("300 ppi: curve handle lands in pixels", m && near(m[0].rightDirection[0], 40) && near(m[0].rightDirection[1], 20),
       m && xy(m[0].rightDirection));

    var set = app.activeDocument.children[1];
    var cm = set && set.isSet && set.vectorMask ? set.vectorMask[0].entireSubPath : null;
    ok("300 ppi: clip mask covers 50 px, not 208", cm && near(cm[2].anchor[0], 50) && near(cm[2].anchor[1], 50),
       cm && xy(cm[2].anchor));
    ok("300 ppi: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

(function () {
    reset();
    app.activeDocument.resolution = undefined;
    var res = LazyLord.build(irDoc([vec("Box", { x: 0, y: 0, width: 10, height: 10 }, [solid(0, 0, 0)])]));
    ok("resolution unknown: shape still built", res.layersCreated === 1, String(res.layersCreated));
    var dg = diagFor("Box", /resolution could not be read/);
    ok("resolution unknown: 72 ppi assumed and reported", dg && dg.resolution === "approximated", diags());
})();

// 13) A vector that draws nothing is not counted as created, and says why.
(function () {
    reset();
    var empty = vec("Empty", { x: 0, y: 0, width: 10, height: 10 }, [solid(1, 0, 0)]);
    empty.subpaths = [];
    var hollow = vec("Hollow", { x: 0, y: 0, width: 10, height: 10 }, [solid(0, 1, 0)]);
    hollow.subpaths = [{ closed: true, vertices: [], inTangents: [], outTangents: [] }];
    var bare = vec("Bare", { x: 0, y: 0, width: 10, height: 10 }, [], [{ paint: solid(0, 0, 0), weight: 0 }]);
    var res = LazyLord.build(irDoc([empty, hollow, bare]));
    ok("nothing drawn: not counted as created", res.layersCreated === 0, String(res.layersCreated));
    ok("nothing drawn: no layers made", allLayers(app.activeDocument).length === 1, names(allLayers(app.activeDocument)));
    var e1 = diagFor("Empty", /no outline/), e2 = diagFor("Hollow", /no outline/), e3 = diagFor("Bare", /no visible fill or stroke/);
    ok("nothing drawn: empty outline reported as skipped", e1 && e1.resolution === "skipped", diags());
    ok("nothing drawn: vertex-less outline reported as skipped", e2 && e2.resolution === "skipped", diags());
    ok("nothing drawn: no fill and no stroke reported as skipped", e3 && e3.resolution === "skipped", diags());
    ok("nothing drawn: no temp path left", app.activeDocument.pathItems.length === 0);
})();

(function () {
    reset();
    host.fail = function (id) { return id === "Mk  "; };
    host.failStrokePath = true;
    var res = LazyLord.build(irDoc([vec("Line", { x: 0, y: 0, width: 100, height: 1 }, [], [{ paint: solid(0, 0, 0), weight: 2 }])]));
    ok("failed stroke only: not counted as created", res.layersCreated === 0, String(res.layersCreated));
    var dg = diagFor("Line stroke", /strokePath refused/);
    ok("failed stroke only: reported as skipped", dg && dg.resolution === "skipped", diags());
    ok("failed stroke only: no layer left behind", allLayers(app.activeDocument).length === 1,
       names(allLayers(app.activeDocument)));
})();

// 14) Hierarchy "flatten" (the default): groups dissolve into their leaves.
// The layer tree as a string: name, @opacity when not 100, [children] of sets.
function tree(container) {
    var out = [];
    for (var i = 0; i < container.children.length; i++) {
        var l = container.children[i];
        out.push(l.name + (l.opacity !== 100 ? "@" + l.opacity : "") + (l.isSet ? "[" + tree(l) + "]" : ""));
    }
    return out.join(",");
}
function box(x, y) { return { x: x || 0, y: y || 0, width: 20, height: 20 }; }
function grp(name, children, opacity) {
    var f = { x: 0, y: 0, width: 100, height: 100 };
    if (opacity !== undefined) f.opacity = opacity;
    return { type: "group", id: name || "g", name: name, frame: f, children: children };
}
function txt(name) {
    return { type: "text", id: name, name: name, characters: name, fontFamily: "Inter", fontStyle: "Regular",
             fontSize: 12, color: { r: 0, g: 0, b: 0, a: 1 }, frame: { x: 0, y: 0, width: 40, height: 14 } };
}
function img(name) {
    return { type: "image", id: name, name: name, filePath: "C:\\" + name + ".png", pixelWidth: 10, pixelHeight: 10,
             frame: { x: 0, y: 0, width: 10, height: 10 } };
}
function mclip(id, name) { return { id: id, name: name || "Mask", subpaths: [rectPath(50, 50)] }; }
function setsIn(container) {
    var all = allLayers(container), out = [];
    for (var i = 0; i < all.length; i++) if (all[i].isSet) out.push(all[i]);
    return out;
}

// A mixed selection with groups, clips and a two-layer shape; fresh each call
// because building mutates the IR (origin shift, flattened opacity).
function mixedDoc(options) {
    var extra = { originSpace: "document", bounds: { x: 3, y: 4, width: 200, height: 200 } };
    if (options) extra.options = options;
    return irDoc([
        vec("Base", box(), [solid(1, 0, 0)]),
        grp("Card", [
            vec("Bg", box(), [solid(0, 1, 0)], [], mclip("m1")),
            grp("Inner", [vec("Icon", box(), [solid(0, 0, 1)], [], mclip("m1")), txt("Label")], 0.5),
            vec("Veil", box(), [solid(0, 0, 0, 0.5)], [{ paint: solid(0, 0, 0), weight: 1 }])
        ], 0.8),
        vec("Top", box(), [solid(1, 1, 0)])
    ], extra);
}

(function () {
    function run(options) {
        reset();
        var res = LazyLord.build(mixedDoc(options));
        return { tree: tree(app.activeDocument), diags: diags(), created: res.layersCreated };
    }
    var none = run();
    var explicit = run({ layout: "split", hierarchy: "flatten" });
    var combine = run({ layout: "combine" });
    ok("default: flattened, only the clip run makes a set",
       none.tree === "Background,Base,Mask[Bg@80,Icon@40],Label@40,Veil@80,Veil stroke@80,Top", none.tree);
    ok("default: every leaf counted, groups are not", none.created === 6, String(none.created));
    ok("default: both multi-child faded groups reported in one diagnostic",
       LazyLord.diagnostics.length === 1 && LazyLord.diagnostics[0].object === "Card, Inner" &&
       LazyLord.diagnostics[0].resolution === "approximated" && /^2 groups/.test(LazyLord.diagnostics[0].reason), none.diags);
    ok("default: explicit split + flatten is identical", explicit.tree === none.tree && explicit.diags === none.diags,
       explicit.tree + " " + explicit.diags);
    ok("default: layout combine is ignored, without a diagnostic",
       combine.tree === none.tree && combine.diags === none.diags && combine.created === none.created,
       combine.tree + " " + combine.diags);
})();

(function () {
    reset();
    var res = LazyLord.build(irDoc([
        grp("G", [vec("A", box(), [solid(1, 0, 0)]), vec("B", box(), [solid(0, 1, 0)])], 0.5)
    ]));
    ok("flatten: leaves only, no layer set", tree(app.activeDocument) === "Background,A@50,B@50" &&
       setsIn(app.activeDocument).length === 0, tree(app.activeDocument));
    ok("flatten: two layers created", res.layersCreated === 2, String(res.layersCreated));
    var dg = diagFor("G", /partial opacity was flattened/);
    ok("flatten: overlapping group opacity reported as approximated", dg && dg.resolution === "approximated" &&
       /show through/.test(dg.reason) && LazyLord.diagnostics.length === 1, diags());

    reset();
    var b = vec("B", box(), [solid(0, 1, 0)]);
    b.frame.opacity = 0.8;
    LazyLord.build(irDoc([
        grp("G1", [vec("A", box(), [solid(1, 0, 0)]), grp("G2", [b], 0.5)], 0.5),
        vec("C", box(), [solid(0, 0, 1)])
    ]));
    ok("flatten: nested opacities multiply into the leaf (0.8 x 0.5 x 0.5)",
       tree(app.activeDocument) === "Background,A@50,B@20,C", tree(app.activeDocument));
    ok("flatten: one diagnostic for the one lossy group", LazyLord.diagnostics.length === 1 &&
       LazyLord.diagnostics[0].object === "G1" && /^A group/.test(LazyLord.diagnostics[0].reason), diags());

    reset();
    LazyLord.build(irDoc([
        grp("Solo", [vec("A", box(), [solid(1, 0, 0)])], 0.5),
        grp("Twin1", [vec("B", box(), [solid(1, 0, 0)]), vec("C", box(), [solid(1, 0, 0)])], 0.5),
        grp("Twin2", [vec("D", box(), [solid(1, 0, 0)]), vec("E", box(), [solid(1, 0, 0)])], 0.9)
    ]));
    ok("flatten: a single-child group's opacity is exact", tree(app.activeDocument) === "Background,A@50,B@50,C@50,D@90,E@90",
       tree(app.activeDocument));
    var many = diagMatching(/^2 groups with partial opacity were flattened/);
    ok("flatten: several lossy groups share one diagnostic naming them",
       LazyLord.diagnostics.length === 1 && many && many.object === "Twin1, Twin2", diags());

    // Lossy is about leaves, not direct children: a faded frame round ONE group
    // of two shapes can show the overlap, one shape beside an empty group cannot.
    reset();
    LazyLord.build(irDoc([
        grp("Card", [grp("Icon", [vec("A", box(), [solid(1, 0, 0)]), vec("B", box(), [solid(0, 1, 0)])])], 0.5)
    ]));
    var card = diagFor("Card", /partial opacity was flattened/);
    ok("flatten: a faded group round one group of two shapes is reported, by the faded group's name",
       tree(app.activeDocument) === "Background,A@50,B@50" && card && LazyLord.diagnostics.length === 1, diags());

    reset();
    LazyLord.build(irDoc([
        grp("Lone", [vec("A", box(), [solid(1, 0, 0)]), grp("Nothing", [])], 0.5)
    ]));
    ok("flatten: one shape beside an empty group is exact, nothing about opacity reported",
       tree(app.activeDocument) === "Background,A@50" && !diagMatching(/partial opacity/), diags());

    reset();
    var r2 = LazyLord.build(irDoc([vec("A", box(), [solid(1, 0, 0)]), grp("Empty", []), grp("Hollow")]));
    ok("flatten: empty groups build nothing", r2.layersCreated === 1 && tree(app.activeDocument) === "Background,A",
       tree(app.activeDocument));
    var e1 = diagFor("Empty", /empty/), e2 = diagFor("Hollow", /empty/);
    ok("flatten: an empty group is reported, not silently dropped",
       e1 && e1.resolution === "skipped" && e2 && e2.resolution === "skipped", diags());

    reset();
    LazyLord.build(irDoc([
        grp("G", [vec("A", box(), [solid(1, 0, 0)], [], mclip("m1"))]),
        vec("B", box(), [solid(0, 1, 0)], [], mclip("m1"))
    ]));
    ok("flatten: a clip run carries on across a dissolved group",
       tree(app.activeDocument) === "Background,Mask[A,B]", tree(app.activeDocument));
})();

// 15) Hierarchy "groups": nested layer sets, built into place whatever
// Photoshop does with a new layer while a set is active.
function nestedDoc(options) {
    var veil = vec("Veil", box(), [solid(0, 0, 0, 0.5)], [{ paint: solid(0, 0, 0), weight: 1 }]);
    var base = vec("Base", box(), [solid(1, 0, 0)]);
    base.frame.opacity = 0.9;
    return irDoc([
        base,
        grp("Card", [
            vec("Bg", box(), [solid(0, 1, 0)]),
            grp("Inner", [vec("Icon", box(), [solid(0, 0, 1)]), img("Photo")], 0.5),
            veil,
            txt("Label")
        ], 0.6),
        vec("Top", box(), [solid(1, 1, 0)])
    ], { options: options || { hierarchy: "groups" } });
}

(function () {
    var want = "Background,Base@90,Card@60[Bg,Inner@50[Icon,Photo],Veil,Veil stroke,Label],Top";
    var models = [false, true];
    for (var m = 0; m < models.length; m++) {
        reset();
        host.newInsideActiveSet = models[m];
        var label = models[m] ? " (new layers go inside an active set)" : " (new layers go above an active set)";
        var res = LazyLord.build(nestedDoc());
        ok("groups: nested sets, names, opacity and order" + label, tree(app.activeDocument) === want,
           tree(app.activeDocument));
        ok("groups: leaves counted, sets are not" + label, res.layersCreated === 7, String(res.layersCreated));
        ok("groups: no diagnostics" + label, LazyLord.diagnostics.length === 0, diags());
        var card = app.activeDocument.children[2];
        var inner = card && card.isSet ? card.children[1] : null;
        ok("groups: the nested set was made in its parent set" + label,
           inner && inner.isSet && inner.createdIn === card && card.createdIn === app.activeDocument);
        ok("groups: a leaf's opacity is its own, not multiplied by its sets" + label,
           inner && inner.children[0].opacity === 100 && inner.children[0].name === "Icon");
        ok("groups: the translucent fill keeps its Fill opacity" + label,
           card && card.children[2].name === "Veil" && card.children[2].fillOpacity === 50);
    }

    reset();
    LazyLord.build(nestedDoc({ hierarchy: "groups", layout: "combine" }));
    ok("groups: layout combine is ignored, without a diagnostic",
       tree(app.activeDocument) === want && LazyLord.diagnostics.length === 0, tree(app.activeDocument) + " " + diags());
})();

(function () {
    reset();
    var res = LazyLord.build(irDoc([
        grp(undefined, [vec("A", box(), [solid(1, 0, 0)])]),
        grp("Empty", []),
        grp("Hollow"),
        vec("B", box(), [solid(0, 1, 0)])
    ], { options: { hierarchy: "groups" } }));
    ok("groups: unnamed group is called Group, empty groups are kept as empty sets",
       tree(app.activeDocument) === "Background,Group[A],Empty[],Hollow[],B", tree(app.activeDocument));
    ok("groups: two layers created", res.layersCreated === 2, String(res.layersCreated));
    ok("groups: nothing reported", LazyLord.diagnostics.length === 0, diags());
})();

// Clip sets form inside the right parent set; a clip id recurring under
// another parent gets its own set.
function clipTreeDoc(options) {
    var d = irDoc([
        grp("G", [vec("A", box(), [solid(1, 0, 0)], [], mclip("m1")), vec("B", box(), [solid(0, 1, 0)], [], mclip("m1"))]),
        vec("C", box(), [solid(0, 0, 1)], [], mclip("m1")),
        grp("H", [vec("D", box(), [solid(1, 1, 0)], [], mclip("m1"))])
    ], { originSpace: "document", bounds: { x: 5, y: 7, width: 100, height: 100 } });
    if (options) d.options = options;
    return d;
}

(function () {
    for (var m = 0; m < 2; m++) {
        reset();
        host.newInsideActiveSet = m === 1;
        var label = m === 1 ? " (new layers go inside an active set)" : " (new layers go above an active set)";
        var res = LazyLord.build(clipTreeDoc({ hierarchy: "groups" }));
        ok("groups clip: one clip set per parent, each inside it" + label,
           tree(app.activeDocument) === "Background,G[Mask[A,B]],Mask[C],H[Mask[D]]", tree(app.activeDocument));
        ok("groups clip: four layers created" + label, res.layersCreated === 4, String(res.layersCreated));
        var top = app.activeDocument.children;
        var g = top[1], h = top[3];
        ok("groups clip: clip sets made in their parent set" + label,
           g.isSet && g.children[0].createdIn === g && h.isSet && h.children[0].createdIn === h &&
           top[2].createdIn === app.activeDocument);
        var masks = [g.children[0], top[2], h.children[0]], masked = 0;
        for (var i = 0; i < masks.length; i++) {
            var a2 = masks[i].vectorMask && masks[i].vectorMask[0].entireSubPath[2].anchor;
            if (a2 && near(a2[0], 55) && near(a2[1], 57)) masked++;
        }
        ok("groups clip: every clip set carries the mask, shifted by the origin" + label, masked === 3, String(masked));
        ok("groups clip: the parent sets themselves are unmasked" + label, g.vectorMask === null && h.vectorMask === null);
        ok("groups clip: one vector-mask Mk per clip set" + label, actions("Mk  ", "Path").length === 3,
           String(actions("Mk  ", "Path").length));
        ok("groups clip: no diagnostics" + label, LazyLord.diagnostics.length === 0, diags());
    }

    reset();
    LazyLord.build(clipTreeDoc());
    ok("groups clip: the same selection flattened is one clip run",
       tree(app.activeDocument) === "Background,Mask[A,B,C,D]", tree(app.activeDocument));
})();

// Fallbacks: a set Photoshop will not make, and an item it will not move.
(function () {
    reset();
    host.failLayerSets = true;
    var res = LazyLord.build(irDoc([
        vec("X", box(), [solid(1, 0, 0)]),
        grp("G", [vec("A", box(), [solid(0, 1, 0)]), vec("B", box(), [solid(0, 0, 1)])], 0.5),
        vec("Y", box(), [solid(1, 1, 0)])
    ], { options: { hierarchy: "groups" } }));
    ok("set refused: its leaves are placed ungrouped, in order, faded by it",
       tree(app.activeDocument) === "Background,X,A@50,B@50,Y", tree(app.activeDocument));
    ok("set refused: four layers created", res.layersCreated === 4, String(res.layersCreated));
    var dg = diagFor("G", /could not be created/);
    ok("set refused: reported as approximated, with the overlap caveat",
       dg && dg.resolution === "approximated" && /2 layers were placed ungrouped/.test(dg.reason) &&
       /show through/.test(dg.reason) && LazyLord.diagnostics.length === 1, diags());

    reset();
    host.failLayerSets = true;
    var re = LazyLord.build(irDoc([vec("X", box(), [solid(1, 0, 0)]), grp("Empty", [])], { options: { hierarchy: "groups" } }));
    ok("empty set refused: nothing else built", re.layersCreated === 1 && tree(app.activeDocument) === "Background,X",
       tree(app.activeDocument));
    var de = diagFor("Empty", /could not be created.*empty/);
    ok("empty set refused: reported as skipped", de && de.resolution === "skipped" && LazyLord.diagnostics.length === 1, diags());

    reset();
    host.failLayerSets = function (container) { return container.isSet; }; // nested sets only
    LazyLord.build(irDoc([
        grp("G", [vec("A", box(), [solid(1, 0, 0)]), grp("H", [vec("B", box(), [solid(0, 1, 0)])], 0.5),
                  vec("C", box(), [solid(0, 0, 1)])])
    ], { options: { hierarchy: "groups" } }));
    ok("nested set refused: its leaves go into the parent set",
       tree(app.activeDocument) === "Background,G[A,B@50,C]", tree(app.activeDocument));
    var dh = diagFor("H", /could not be created/);
    ok("nested set refused: reported once, exact opacity so no overlap caveat",
       dh && dh.resolution === "approximated" && /1 layer was placed ungrouped/.test(dh.reason) &&
       !/show through/.test(dh.reason) && LazyLord.diagnostics.length === 1, diags());
})();

// A refused move costs nothing when Photoshop already made the item where it
// belongs (above the active layer, which is normally the item before it).
function abcdDoc() {
    return irDoc([
        grp("G", [vec("A", box(), [solid(1, 0, 0)]), vec("B", box(), [solid(0, 1, 0)]), vec("C", box(), [solid(0, 0, 1)])]),
        vec("D", box(), [solid(1, 1, 0)])
    ], { options: { hierarchy: "groups" } });
}

(function () {
    // Was: G[A,C,B] with B reported, because C was then moved below the
    // already well-placed B. Now B counts as placed and C goes above it.
    reset();
    var refused = 0;
    host.failMove = function (lyr, rel, placement) {
        var no = lyr.name === "B" && placement === ElementPlacement.PLACEBEFORE;
        if (no) refused++;
        return no;
    };
    var res = LazyLord.build(abcdDoc());
    ok("move refused in place: the move really was refused", refused === 1, String(refused));
    ok("move refused in place: every layer still built", res.layersCreated === 4, String(res.layersCreated));
    ok("move refused in place: the layer was already there, so the order is exact",
       tree(app.activeDocument) === "Background,G[A,B,C],D", tree(app.activeDocument));
    ok("move refused in place: nothing is lost, so nothing reported", LazyLord.diagnostics.length === 0, diags());

    // B is made at the top of the document instead, and cannot be moved.
    reset();
    host.misplacePath = "LazyLord B";
    host.failMove = function (lyr, rel, placement) { return lyr.name === "B" && placement === ElementPlacement.PLACEBEFORE; };
    res = LazyLord.build(abcdDoc());
    ok("move refused out of place: every layer still built", res.layersCreated === 4, String(res.layersCreated));
    ok("move refused out of place: only the refused layer is out of order",
       tree(app.activeDocument) === "Background,G[A,C],D,B", tree(app.activeDocument));
    var dg = diagFor("B", /group "G"/);
    ok("move refused out of place: reported as approximated, naming the group", dg && dg.resolution === "approximated" &&
       /outside the group or out of order/.test(dg.reason) && LazyLord.diagnostics.length === 1, diags());

    // The first item of a set refuses to go in: fine when Photoshop made it
    // inside the (active) set, reported when it made it beside the set.
    for (var m = 0; m < 2; m++) {
        reset();
        host.newInsideActiveSet = m === 1;
        host.failMove = function (lyr, rel, placement) { return lyr.name === "A" && placement === ElementPlacement.PLACEATBEGINNING; };
        LazyLord.build(abcdDoc());
        if (m === 1) {
            ok("move into refused, made inside: order exact, nothing reported",
               tree(app.activeDocument) === "Background,G[A,B,C],D" && LazyLord.diagnostics.length === 0,
               tree(app.activeDocument) + " " + diags());
        } else {
            ok("move into refused, made beside: the rest still fill the set in order",
               tree(app.activeDocument) === "Background,G[B,C],D,A", tree(app.activeDocument));
            var da = diagFor("A", /group "G"/);
            ok("move into refused, made beside: only that layer reported",
               da && da.resolution === "approximated" && LazyLord.diagnostics.length === 1, diags());
        }
    }
})();

// 16) Sets are made beside the item they go above, so no set ever has to be
// moved out of another. Under setsStayPut (a set may only be reordered within
// its own container) a set made above the active layer, which is by then deep
// inside the previous group, could not be moved out to its place.
function siblingsDoc() {
    return irDoc([
        grp("G", [vec("A", box(), [solid(1, 0, 0)]), grp("H", [vec("B", box(), [solid(0, 1, 0)])], 0.5)]),
        grp("K", [vec("C", box(), [solid(0, 0, 1)])]),
        vec("X", box(), [solid(1, 1, 0)], [], mclip("m1")),
        vec("Y", box(), [solid(0, 1, 1)]),
        grp("L", [grp("M", [vec("D", box(), [solid(1, 0, 1)])]), grp("N", [vec("E", box(), [solid(1, 1, 1)])])])
    ], { options: { hierarchy: "groups" } });
}

(function () {
    var want = "Background,G[A,H@50[B]],K[C],Mask[X],Y,L[M[D],N[E]]";
    var runs = [
        { inside: false, strict: true, label: " (new layers above an active set; sets stay in their container)" },
        { inside: false, strict: false, label: " (new layers above an active set)" },
        { inside: true, strict: false, label: " (new layers inside an active set)" }
    ];
    for (var r = 0; r < runs.length; r++) {
        reset();
        host.newInsideActiveSet = runs[r].inside;
        host.setsStayPut = runs[r].strict;
        var res = LazyLord.build(siblingsDoc());
        ok("sibling sets: each in its place" + runs[r].label, tree(app.activeDocument) === want, tree(app.activeDocument));
        ok("sibling sets: seven layers created" + runs[r].label, res.layersCreated === 7, String(res.layersCreated));
        ok("sibling sets: no diagnostics" + runs[r].label, LazyLord.diagnostics.length === 0, diags());
    }
})();

(function () {
    var want = "Background,L1@75[L2@50[L3@25[A],B],C],D";
    for (var m = 0; m < 2; m++) {
        reset();
        host.newInsideActiveSet = m === 1;
        host.setsStayPut = m === 0;
        var label = m === 1 ? " (new layers go inside an active set)" : " (new layers go above an active set)";
        LazyLord.build(irDoc([
            grp("L1", [grp("L2", [grp("L3", [vec("A", box(), [solid(1, 0, 0)])], 0.25), vec("B", box(), [solid(0, 1, 0)])], 0.5),
                       vec("C", box(), [solid(0, 0, 1)])], 0.75),
            vec("D", box(), [solid(1, 1, 0)])
        ], { options: { hierarchy: "groups" } }));
        ok("three levels deep: sets nest, each with its own opacity" + label, tree(app.activeDocument) === want,
           tree(app.activeDocument));
        var l1 = app.activeDocument.children[1];
        var l2 = l1 && l1.isSet ? l1.children[0] : null;
        var l3 = l2 && l2.isSet ? l2.children[0] : null;
        ok("three levels deep: each set made in its parent" + label,
           l1 && l2 && l3 && l1.createdIn === app.activeDocument && l2.createdIn === l1 && l3.createdIn === l2);
        ok("three levels deep: no diagnostics" + label, LazyLord.diagnostics.length === 0, diags());
    }
})();

// A clip run ends at every set boundary, even when the same mask recurs on
// both sides of a nested group inside one parent.
(function () {
    for (var m = 0; m < 2; m++) {
        reset();
        host.newInsideActiveSet = m === 1;
        host.setsStayPut = m === 0;
        var label = m === 1 ? " (new layers go inside an active set)" : " (new layers go above an active set)";
        var res = LazyLord.build(irDoc([
            grp("G", [
                vec("A", box(), [solid(1, 0, 0)], [], mclip("m1")),
                grp("H", [vec("B", box(), [solid(0, 1, 0)], [], mclip("m1"))]),
                vec("C", box(), [solid(0, 0, 1)], [], mclip("m1"))
            ])
        ], { options: { hierarchy: "groups" } }));
        ok("clip around a nested set: one clip set on each side and one inside" + label,
           tree(app.activeDocument) === "Background,G[Mask[A],H[Mask[B]],Mask[C]]", tree(app.activeDocument));
        ok("clip around a nested set: three layers created" + label, res.layersCreated === 3, String(res.layersCreated));
        var g = app.activeDocument.children[1];
        var h = g && g.isSet ? g.children[1] : null;
        ok("clip around a nested set: clip sets made in the set they sit in" + label,
           g && h && g.children[0].createdIn === g && g.children[2].createdIn === g && h.children[0].createdIn === h);
        ok("clip around a nested set: all three masked" + label,
           g && h && g.children[0].vectorMask && g.children[2].vectorMask && h.children[0].vectorMask && !h.vectorMask);
        ok("clip around a nested set: no diagnostics" + label, LazyLord.diagnostics.length === 0, diags());
    }
})();

// Leaves that build nothing leave no gap and do not disturb the order in a set.
(function () {
    reset();
    var res = LazyLord.build(irDoc([
        grp("G", [
            vec("A", box(), [solid(1, 0, 0)]),
            { type: "widget", id: "w", name: "Widget", frame: box() },
            vec("Ghost", box(), []),
            vec("B", box(), [solid(0, 1, 0)])
        ]),
        vec("C", box(), [solid(0, 0, 1)])
    ], { options: { hierarchy: "groups" } }));
    ok("empty leaves in a set: the rest stay in order", tree(app.activeDocument) === "Background,G[A,B],C",
       tree(app.activeDocument));
    ok("empty leaves in a set: only the drawn ones counted", res.layersCreated === 3, String(res.layersCreated));
    var w = diagFor("Widget", /not supported/), gh = diagFor("Ghost", /nothing to draw/);
    ok("empty leaves in a set: each reported as skipped",
       w && w.resolution === "skipped" && gh && gh.resolution === "skipped" && LazyLord.diagnostics.length === 2, diags());
})();

// A set whose opacity Photoshop refuses is kept, fully opaque, and reported.
(function () {
    reset();
    var realPct = LazyLord.pct;
    LazyLord.pct = function (o) {
        if (o === 0.25) throw new Error("mock: opacity refused");
        return realPct(o);
    };
    var res;
    try {
        res = LazyLord.build(irDoc([
            grp("Faint", [vec("A", box(), [solid(1, 0, 0)]), vec("B", box(), [solid(0, 1, 0)])], 0.25)
        ], { options: { hierarchy: "groups" } }));
    } finally {
        LazyLord.pct = realPct;
    }
    ok("set opacity refused: the set and its layers are kept", tree(app.activeDocument) === "Background,Faint[A,B]" &&
       res.layersCreated === 2, tree(app.activeDocument));
    var dg = diagFor("Faint", /opacity could not be applied/);
    ok("set opacity refused: reported as approximated", dg && dg.resolution === "approximated" &&
       /fully opaque/.test(dg.reason) && LazyLord.diagnostics.length === 1, diags());
})();

// 17) Where the transfer lands among the user's own layers: every top-level
// item, set or leaf, joins the container Photoshop put the first one in (above
// the active layer), even inside one of the user's own groups, whatever
// Document.layerSets.add() does with a new set.
function userLayers(activeInGroup) {
    // Background, U[u1, u2], Top; u1 (inside U) or the Background is active.
    var d = app.activeDocument;
    var u = put(d, new MockLayer(d, "set", "U"));
    u.isSet = true;
    u.children = [];
    u.layers = [];
    u.layerSets = { add: function () { throw new Error("mock: the user's group is made by hand"); } };
    var u1 = put(u, new MockLayer(d, LayerKind.NORMAL, "u1"));
    put(u, new MockLayer(d, LayerKind.NORMAL, "u2"));
    put(d, new MockLayer(d, LayerKind.NORMAL, "Top"));
    d.activeLayer = activeInGroup ? u1 : d.children[0];
    return u;
}
// A set made inside the user's group U: made like a nested set, at its bottom.
function userSets(u) {
    var d = app.activeDocument;
    u.layerSets = {
        add: function () {
            var s = d.layerSets.add(); // a real mock set, then moved to U's bottom by hand
            detach(s);
            u.children.unshift(s);
            s.parent = u;
            s.createdIn = u;
            relist(u);
            d.activeLayer = s;
            return s;
        }
    };
}

(function () {
    for (var m = 0; m < 2; m++) {
        var label = m === 1 ? " (a new set lands above the active layer)" : " (a new set lands at the top of the document)";
        reset();
        host.setsAboveActive = m === 1;
        userLayers(false);
        var res = LazyLord.build(irDoc([grp("G", [vec("A", box(), [solid(1, 0, 0)])]), vec("B", box(), [solid(0, 1, 0)])],
            { options: { hierarchy: "groups" } }));
        ok("landing: a set that comes first goes above the selected layer, like a leaf" + label,
           tree(app.activeDocument) === "Background,G[A],B,U[u1,u2],Top", tree(app.activeDocument));
        ok("landing: two layers created, nothing reported" + label,
           res.layersCreated === 2 && LazyLord.diagnostics.length === 0, diags());
        ok("landing: no placeholder left behind" + label,
           names(allLayers(app.activeDocument)).indexOf("placeholder") < 0, names(allLayers(app.activeDocument)));

        reset();
        host.setsAboveActive = m === 1;
        userLayers(false);
        LazyLord.build(irDoc([vec("X", box(), [solid(1, 0, 0)]), grp("G", [vec("A", box(), [solid(0, 1, 0)])])],
            { options: { hierarchy: "groups" } }));
        ok("landing: the same place when a leaf comes first" + label,
           tree(app.activeDocument) === "Background,X,G[A],U[u1,u2],Top", tree(app.activeDocument));
    }
})();

(function () {
    var runs = [
        { inside: false, above: false }, { inside: false, above: true },
        { inside: true, above: false }, { inside: true, above: true }
    ];
    for (var r = 0; r < runs.length; r++) {
        var label = " (" + (runs[r].inside ? "new layers inside an active set" : "new layers above an active set") + "; " +
            (runs[r].above ? "a new set above the active layer" : "a new set at the top of the document") + ")";
        var setup = function () {
            reset();
            host.newInsideActiveSet = runs[r].inside;
            host.setsAboveActive = runs[r].above;
            host.setsStayPut = true;
            var uu = userLayers(true);
            userSets(uu);
            return uu;
        };

        var u = setup();
        var res = LazyLord.build(irDoc([grp("G", [vec("A", box(), [solid(1, 0, 0)])]), grp("K", [vec("C", box(), [solid(0, 0, 1)])])],
            { options: { hierarchy: "groups" } }));
        ok("in the user's group: sets that come first join it, above the selected layer" + label,
           tree(app.activeDocument) === "Background,U[u1,G[A],K[C],u2],Top", tree(app.activeDocument));
        ok("in the user's group: both sets made in it" + label,
           u.children.length === 4 && u.children[1].createdIn === u && u.children[2].createdIn === u);
        ok("in the user's group: two layers created, nothing reported" + label,
           res.layersCreated === 2 && LazyLord.diagnostics.length === 0, diags());

        setup();
        LazyLord.build(irDoc([vec("X", box(), [solid(1, 0, 0)]), grp("G", [vec("A", box(), [solid(0, 1, 0)])]),
            vec("Y", box(), [solid(0, 0, 1)])], { options: { hierarchy: "groups" } }));
        ok("in the user's group: a set after a leaf is made beside it, not at the top of the document" + label,
           tree(app.activeDocument) === "Background,U[u1,X,G[A],Y,u2],Top" && LazyLord.diagnostics.length === 0,
           tree(app.activeDocument) + " " + diags());

        u = setup();
        LazyLord.build(irDoc([vec("A", box(), [solid(1, 0, 0)], [], mclip("m1")), vec("B", box(), [solid(0, 1, 0)], [], mclip("m1"))]));
        ok("in the user's group, flattened: the clip set is made beside its layers" + label,
           tree(app.activeDocument) === "Background,U[u1,Mask[A,B],u2],Top" && LazyLord.diagnostics.length === 0,
           tree(app.activeDocument) + " " + diags());
        ok("in the user's group, flattened: the clip set is masked" + label,
           u.children.length === 3 && u.children[1].createdIn === u && u.children[1].vectorMask !== null);
    }
})();

(function () {
    // The placeholder a first set is placed by is always removed, even when
    // the set cannot be made, or cannot be moved beside it.
    reset();
    host.failLayerSets = true;
    userLayers(false);
    LazyLord.build(irDoc([grp("G", [vec("A", box(), [solid(1, 0, 0)]), vec("B", box(), [solid(0, 1, 0)])])],
        { options: { hierarchy: "groups" } }));
    ok("first set refused: its layers still land above the selected layer, and no placeholder is left",
       tree(app.activeDocument) === "Background,A,B,U[u1,u2],Top", tree(app.activeDocument));
    ok("first set refused: only the missing set reported", LazyLord.diagnostics.length === 1 &&
       diagFor("G", /could not be created/) !== null, diags());

    for (var m = 0; m < 2; m++) {
        reset();
        host.setsAboveActive = m === 1;
        host.failMove = function (lyr, rel) { return rel.name === "LazyLord placeholder"; };
        userLayers(false);
        LazyLord.build(irDoc([grp("G", [vec("A", box(), [solid(1, 0, 0)])]), vec("B", box(), [solid(0, 1, 0)])],
            { options: { hierarchy: "groups" } }));
        if (m === 0) {
            ok("first set not movable: it stays where Photoshop made it, and the rest follow it",
               tree(app.activeDocument) === "Background,U[u1,u2],Top,G[A],B", tree(app.activeDocument));
            var dg = diagFor("G", /above the selected layer/);
            ok("first set not movable: reported as approximated", dg && dg.resolution === "approximated" &&
               LazyLord.diagnostics.length === 1, diags());
        } else {
            ok("first set not movable but made above the selected layer: in place, nothing reported",
               tree(app.activeDocument) === "Background,G[A],B,U[u1,u2],Top" && LazyLord.diagnostics.length === 0,
               tree(app.activeDocument) + " " + diags());
        }
    }
})();

// 18) A group's own clip: the layer set's vector mask when groups are rebuilt,
// handed down to its layers when they are not.
function clippedGroupDoc(options, innerClip) {
    var a = vec("A", box(), [solid(1, 0, 0)], [], innerClip ? mclip("m2", "Inner") : undefined);
    var g = grp("G", [a, vec("B", box(), [solid(0, 1, 0)])]);
    g.clip = mclip("g1", "Frame");
    var d = irDoc([g, vec("C", box(), [solid(0, 0, 1)])],
        { originSpace: "document", bounds: { x: 5, y: 7, width: 100, height: 100 } });
    if (options) d.options = options;
    return d;
}

(function () {
    for (var m = 0; m < 2; m++) {
        reset();
        host.newInsideActiveSet = m === 1;
        var label = m === 1 ? " (new layers go inside an active set)" : " (new layers go above an active set)";
        var res = LazyLord.build(clippedGroupDoc({ hierarchy: "groups" }));
        var g = app.activeDocument.children[1];
        ok("group clip, groups: the set itself is masked, no extra clip set" + label,
           tree(app.activeDocument) === "Background,G[A,B],C" && res.layersCreated === 3, tree(app.activeDocument));
        var a2 = g && g.vectorMask && g.vectorMask[0].entireSubPath[2].anchor;
        ok("group clip, groups: mask is the clip outline, shifted once by the origin" + label,
           a2 && near(a2[0], 55) && near(a2[1], 57), a2 && xy(a2));
        ok("group clip, groups: one vector-mask Mk" + label, actions("Mk  ", "Path").length === 1,
           String(actions("Mk  ", "Path").length));
        ok("group clip, groups: no temp path left, nothing reported" + label,
           app.activeDocument.pathItems.length === 0 && LazyLord.diagnostics.length === 0, diags());
    }

    reset();
    LazyLord.build(clippedGroupDoc({ hierarchy: "groups" }, true));
    var g2 = app.activeDocument.children[1];
    ok("group clip, groups: a child's own clip gets its own set inside the masked set",
       tree(app.activeDocument) === "Background,G[Inner[A],B],C" && g2.vectorMask !== null &&
       g2.children[0].vectorMask !== null && LazyLord.diagnostics.length === 0, tree(app.activeDocument) + " " + diags());

    reset();
    host.fail = function (id, desc) { return id === "Mk  " && refClass(desc) === "Path"; };
    LazyLord.build(clippedGroupDoc({ hierarchy: "groups" }));
    var g3 = app.activeDocument.children[1];
    ok("group clip refused: the set and its layers are kept, unmasked",
       tree(app.activeDocument) === "Background,G[A,B],C" && g3.vectorMask === null, tree(app.activeDocument));
    var dg = diagFor("G", /clipping mask "Frame" could not be applied/);
    ok("group clip refused: reported as approximated", dg && dg.resolution === "approximated" &&
       /unclipped/.test(dg.reason) && LazyLord.diagnostics.length === 1, diags());
    ok("group clip refused: temp path still removed", app.activeDocument.pathItems.length === 0);

    reset();
    var sets = 0;
    host.failLayerSets = function () { return sets++ === 0; }; // G's set only; clip sets still work
    LazyLord.build(clippedGroupDoc({ hierarchy: "groups" }));
    ok("group clip, set refused: its layers are placed ungrouped but still clipped",
       tree(app.activeDocument) === "Background,Frame[A,B],C", tree(app.activeDocument));
    ok("group clip, set refused: only the missing set reported",
       LazyLord.diagnostics.length === 1 && diagFor("G", /could not be created/) !== null, diags());
})();

(function () {
    reset();
    var d = clippedGroupDoc();
    var a = d.layers[0].children[0], b = d.layers[0].children[1];
    var res = LazyLord.build(d);
    var top = app.activeDocument.children;
    ok("group clip, flattened: its layers form one clip run, the next layer is unclipped",
       tree(app.activeDocument) === "Background,Frame[A,B],C" && res.layersCreated === 3, tree(app.activeDocument));
    var a2 = top[1].vectorMask && top[1].vectorMask[0].entireSubPath[2].anchor;
    ok("group clip, flattened: the clip set is masked by the group's outline, shifted once",
       a2 && near(a2[0], 55) && near(a2[1], 57), a2 && xy(a2));
    ok("group clip, flattened: each layer got its own copy of the group's clip",
       a.clip && b.clip && a.clip !== b.clip && a.clip.id === "g1" && b.clip.id === "g1" && a.clip !== d.layers[0].clip);
    ok("group clip, flattened: nothing reported", LazyLord.diagnostics.length === 0, diags());

    reset();
    var n = grp("N", [vec("D", box(), [solid(1, 0, 1)])]);
    var o = grp("O", [vec("E", box(), [solid(1, 1, 0)], [], mclip("e2", "Own")), n]);
    o.clip = mclip("g1", "Frame");
    LazyLord.build(irDoc([o]));
    ok("group clip, flattened: reaches layers in nested groups, a layer's own clip wins",
       tree(app.activeDocument) === "Background,Own[E],Frame[D]", tree(app.activeDocument));
    var de = diagFor("E", /both by its group's mask "Frame" and by its own "Own"/);
    ok("group clip, flattened: the lost outer mask is reported", de && de.resolution === "approximated" &&
       LazyLord.diagnostics.length === 1, diags());
})();

WScript.Echo("");
// Mixed character styles: when the text layer's descriptor cannot be
// rewritten, the text keeps its first style and says so.
(function () {
    reset();
    var res = LazyLord.build(irDoc([{
        id: "T", name: "Styled", type: "text", frame: { x: 0, y: 0, width: 50, height: 10 }, characters: "Hi there",
        fontFamily: "Inter", fontStyle: "Regular", fontSize: 12, color: { r: 0, g: 0, b: 0, a: 1 },
        runs: [{ start: 0, end: 2, fontSize: 20 }]
    }]));
    var hit = null;
    for (var i = 0; i < LazyLord.diagnostics.length; i++) {
        if (/Mixed character styles/.test(LazyLord.diagnostics[i].reason)) hit = LazyLord.diagnostics[i];
    }
    ok("runs: a failed rewrite keeps the first style, reported, text still built",
       hit && hit.object === "Styled" && hit.resolution === "approximated" && res.layersCreated === 1,
       JSON.stringify(LazyLord.diagnostics));
})();

// U) Updating into Photoshop: tags in each layer's XMP, rebuilt in place.
(function () {
    reset();
    var box = function (x) { return vec("Box", { x: x, y: 10, width: 100, height: 50, rotation: 0, opacity: 1 }, [solid(1, 0, 0)]); };
    var tagged = function (extra) { return irDoc([box(extra && extra.x || 10)], { sourceKey: "doc-P", options: extra && extra.options }); };
    var r1 = LazyLord.build(tagged());
    var first = ofKind(LayerKind.SOLIDFILL)[0];
    var meta = first && LazyLord._ps_readMeta(first);
    ok("PS tag: the drawn layer keeps its source in its XMP", meta && meta.tag === "figma|doc-P|Box", first && first.xmpMetadata.rawData);
    ok("PS tag: and a fingerprint of how it stands", meta && meta.fp === LazyLord._ps_state([first]), meta && meta.fp);
    ok("PS tag: a first send updates nothing", r1.layersUpdated === 0 && r1.layersCreated === 1);

    // The user adds a layer above; the source moves the box and sends it again.
    var mine = put(app.activeDocument, new MockLayer(app.activeDocument, LayerKind.NORMAL, "Mine"));
    LazyLord.resetDiagnostics();
    var r2 = LazyLord.build(tagged({ x: 60, options: { existing: "update" } }));
    var fills = ofKind(LayerKind.SOLIDFILL);
    var stack = app.activeDocument.children;
    ok("PS update: still one box, the old one gone", fills.length === 1 && first.removed === true && fills[0] !== first,
       fills.length + " " + first.removed);
    ok("PS update: rebuilt where it stood, under the user's own layer", idxOf(stack, fills[0]) < idxOf(stack, mine),
       names(stack));
    ok("PS update: counted and said", r2.layersUpdated === 1 && r2.layersCreated === 0 && /Replaced 1 layer/.test(r2.message), r2.message);
    ok("PS update: the new one is tagged for next time", LazyLord._ps_readMeta(fills[0]).tag === "figma|doc-P|Box");

    // The user moves it in Photoshop: a conflict, kept or overwritten.
    var now = fills[0];
    now.translate(5, 5);
    LazyLord.resetDiagnostics();
    var r3 = LazyLord.build(tagged({ x: 60, options: { existing: "update", conflict: "keep" } }));
    ok("PS conflict: kept as the user made it, and said", now.removed === false && ofKind(LayerKind.SOLIDFILL).length === 1 &&
       !!diagMatching(/changed in Photoshop since it was last sent, so it was left as you made it/) &&
       /left as you made them/.test(r3.message), diags() + " " + r3.message);
    LazyLord.resetDiagnostics();
    LazyLord.build(tagged({ x: 60, options: { existing: "update" } }));
    ok("PS conflict: overwritten by default, and said", now.removed === true && ofKind(LayerKind.SOLIDFILL).length === 1 &&
       !!diagMatching(/the update replaced it/), diags());
    LazyLord.resetDiagnostics();
    LazyLord.build(tagged({ x: 70, options: { existing: "update" } }));
    ok("PS conflict: once replaced, the next update is clean", !diagMatching(/since it was last sent/), diags());

    // Another file's layer with the same id never matches.
    LazyLord.resetDiagnostics();
    var other = irDoc([box(20)], { sourceKey: "doc-Q", options: { existing: "update" } });
    var r4 = LazyLord.build(other);
    ok("PS update: another file's layer is added, not matched", ofKind(LayerKind.SOLIDFILL).length === 2 && r4.layersUpdated === 0,
       r4.message);
})();

// Clipping and layer masks come only from Photoshop itself, which never sends to Photoshop: reported if seen.
(function () {
    reset();
    var v = vec("Tint", { x: 0, y: 0, width: 50, height: 50 }, [solid(1, 0, 0)]);
    v.clipTo = "ps-1";
    v.mask = { frame: { x: 0, y: 0, width: 50, height: 50 }, filePath: "C:/m.png" };
    LazyLord.resetDiagnostics();
    LazyLord.build(irDoc([v]));
    var d = LazyLord.diagnostics, mask = 0, clip = 0;
    for (var i = 0; i < d.length; i++) {
        if (/layer mask is not rebuilt in Photoshop/.test(d[i].reason)) mask++;
        if (/clipping mask is not rebuilt in Photoshop/.test(d[i].reason)) clip++;
    }
    ok("masks: reported, once each", mask === 1 && clip === 1, JSON.stringify(d));
})();

// Kerning: the setting is applied; pairs kerned by hand are reported.
(function () {
    reset();
    AutoKernType = { MANUAL: 0, METRICS: 1, OPTICAL: 2 };
    try {
        LazyLord.build(irDoc([{ type: "text", id: "k", name: "AVA", characters: "AVA", fontFamily: "Inter", fontStyle: "Regular",
                                fontSize: 20, color: { r: 0, g: 0, b: 0, a: 1 }, frame: { x: 10, y: 10, width: 80, height: 24 },
                                autoKern: "optical", kerns: [{ index: 1, amount: -50 }] }]));
    } finally {
        var kinds = AutoKernType;
        AutoKernType = undefined;
    }
    var lyr = app.activeDocument.children[1];
    ok("kerning: the setting", lyr && lyr.textItem.autoKerning === kinds.OPTICAL, lyr && String(lyr.textItem.autoKerning));
    ok("kerning: pairs kerned by hand are reported", /Manually kerned letter pairs are not rebuilt/.test(JSON.stringify(LazyLord.diagnostics)),
       JSON.stringify(LazyLord.diagnostics));
})();

// An image sequence has one frame here.
(function () {
    reset();
    LazyLord.build(irDoc([{ type: "image", id: "s", name: "Walk", frame: { x: 0, y: 0, width: 60, height: 50 },
                            filePath: "C:/tmp/Walk_0000.png", isOriginalFile: false, pixelWidth: 60, pixelHeight: 50,
                            sequence: { frames: ["C:/tmp/Walk_0000.png", "C:/tmp/Walk_0001.png"] } }]));
    ok("sequence: only the first frame, and said", /only the first of its 2 frames/.test(JSON.stringify(LazyLord.diagnostics)),
       JSON.stringify(LazyLord.diagnostics));
})();

// Effects: shadows as layer styles, a layer blur as a smart filter.
(function () {
    reset();
    var dot = vec("Dot", { x: 10, y: 10, width: 50, height: 50, rotation: 0, opacity: 1 }, [solid(1, 0, 0)]);
    dot.effects = [{ kind: "layer-blur", radius: 8 },
                   { kind: "drop-shadow", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 10, spread: 2 },
                   { kind: "inner-shadow", color: { r: 1, g: 0, b: 0, a: 0.5 }, offset: { x: 2, y: 0 }, radius: 3, blendMode: "multiply" },
                   { kind: "background-blur", radius: 4 }];
    var res = LazyLord.build(irDoc([dot], { sourceKey: "doc-FX" }));
    var sos = ofKind("smartobject");
    var so = sos[0];
    ok("ps effects: a blurred layer becomes a smart object, in its place", res.layersCreated === 1 && sos.length === 1 &&
       so.convertedFrom === LayerKind.SOLIDFILL && ofKind(LayerKind.SOLIDFILL).length === 0, String(sos.length));
    ok("ps effects: with a Gaussian Blur smart filter, at half Figma's radius",
       so && so.smartFilters.length === 1 && so.smartFilters[0].radius === 4, so && JSON.stringify(so.smartFilters));
    var st = so && so.layerStyle;
    var ds = st && st.get("DrSh"), is = st && st.get("IrSh");
    ok("ps effects: the drop shadow is a layer style on the smart object",
       ds && ds.value.get("Opct").value === 25 && near(ds.value.get("lagl").value, 90) && near(ds.value.get("Dstn").value, 4) &&
       ds.value.get("blur").value === 10 && near(ds.value.get("Ckmt").value, 20) && ds.value.get("Md  ").value === "Nrml" &&
       ds.value.get("layerConceals").value === true, ds && JSON.stringify(ds.value.keys));
    ok("ps effects: so is the inner shadow, colour and blend mode kept",
       is && near(is.value.get("lagl").value, 180) && is.value.get("Clr ").value.get("Rd  ").value === 255 &&
       is.value.get("Md  ").value === "Mltp" && !is.value.get("layerConceals"), is && JSON.stringify(is.value.keys));
    ok("ps effects: the background blur is reported", !!diagFor("Dot", /no counterpart here for background blur/), diags());
    var meta = so && LazyLord._ps_readMeta(so);
    ok("ps effects: the smart object carries the tag, so an update finds it", meta && meta.tag === "figma|doc-FX|Dot", so && so.xmpMetadata.rawData);
})();

(function () {
    // A Photoshop that will not convert: the blur is reported, the layer and its shadow stay.
    reset();
    host.fail = function (id) { return id === "newPlacedLayer"; };
    var dot = vec("Dot", { x: 10, y: 10, width: 50, height: 50, rotation: 0, opacity: 1 }, [solid(1, 0, 0)]);
    dot.effects = [{ kind: "layer-blur", radius: 8 }, { kind: "drop-shadow", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4 }];
    LazyLord.build(irDoc([dot]));
    var fill = ofKind(LayerKind.SOLIDFILL)[0];
    ok("ps effects: a refused conversion leaves the blur off, said", !!diagFor("Dot", /needs the layer to be a smart object/) &&
       fill && fill.layerStyle && fill.layerStyle.get("DrSh"), diags());
})();

WScript.Echo(passed + " passed, " + failed + " failed.");
WScript.Quit(failed === 0 ? 0 : 1);
