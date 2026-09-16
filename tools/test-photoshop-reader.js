/*
 * LazyLord — Photoshop reader tests (no Node required).
 *
 *   cscript //Nologo tools\test-photoshop-reader.js
 *
 * Runs the real jsx/ps-read.jsx against a mocked Photoshop DOM under Windows
 * Script Host, whose JScript engine is ES3 like ExtendScript.
 *
 * Photoshop shares the IR's y-down pixel space, so there is no flip to get
 * wrong here. What there is instead: path data kept in POINTS rather than
 * pixels, a selection that only ActionManager knows about, and a DOM where a
 * shape is a fill layer wearing a vector mask. These tests pin down that
 * conversion, the fallback to the active layer when ActionManager is not
 * there, and that every branch that cannot be read ends in a reported raster
 * rather than silence.
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

// --- Photoshop stand-ins ----------------------------------------------------
var LayerKind = {
    NORMAL: "normal", TEXT: "text", SOLIDFILL: "solid", GRADIENTFILL: "grad",
    PATTERNFILL: "pattern", SMARTOBJECT: "smart", VIDEO: "video", LAYER3D: "3d",
    BRIGHTNESSCONTRAST: "adjust"
};
var PathKind = { NORMALPATH: "normal", VECTORMASK: "vectormask", WORKPATH: "work" };
var TextType = { POINTTEXT: "point", PARAGRAPHTEXT: "para" };
var Justification = { LEFT: "left", CENTER: "center", RIGHT: "right", FULLY: "fully" };
var Units = { PIXELS: "px" }, TypeUnits = { PIXELS: "px" };
var SaveOptions = { DONOTSAVECHANGES: "no" };
var ElementPlacement = { PLACEATBEGINNING: "begin" };
var NewDocumentMode = { RGB: "rgb" }, DocumentFill = { TRANSPARENT: "t" };
var ResampleMethod = { BICUBIC: "bicubic" }, Extension = { LOWERCASE: "lower" };
function PNGSaveOptions() { this.compression = 6; this.interlaced = false; }
function SolidColor() { this.rgb = { red: 0, green: 0, blue: 0 }; }
var DialogModes = { NO: "no" };
function UnitValue(v) { return v; }
function File(p) { this.fsName = String(p); }

var MOCK = { noActionManager: false, noVectorMask: false, noSolidColour: false, exports: [], failExport: false,
             failMaskSelection: false };

/** Photoshop's ActionManager, reduced to the two things the reader asks it. */
var AM = { targetIndices: [], layerIdAt: {}, adjustments: {}, masks: {}, actions: [], gradients: {}, styles: {}, globalAngle: 120 };
function ActionReference() { this.parts = []; }
ActionReference.prototype.putProperty = function (c, p) { this.parts.push(["prop", p]); };
ActionReference.prototype.putEnumerated = function (a, b, c) { this.parts.push(["enum", c]); };
ActionReference.prototype.putIndex = function (c, i) { this.parts.push(["index", i]); };
ActionReference.prototype.putIdentifier = function (c, id) { this.parts.push(["id", id]); };

function Desc(map) { this.map = map; }
Desc.prototype.hasKey = function (k) { return this.map[k] !== undefined; };
Desc.prototype.getList = function (k) { return this.map[k]; };
Desc.prototype.getInteger = function (k) { return this.map[k]; };
Desc.prototype.getDouble = function (k) { return this.map[k]; };
Desc.prototype.getObjectValue = function (k) { return this.map[k]; };
Desc.prototype.getBoolean = function (k) { return this.map[k]; };
Desc.prototype.getUnitDoubleValue = function (k) { return this.map[k]; };
Desc.prototype.getEnumerationValue = function (k) { return this.map[k]; };
function typeIDToCharID(id) { return String(id).replace(/^c:/, ""); }
function typeIDToStringID(id) { return String(id); }

/** ActionManager's executeAction: only "load the layer mask as the selection" is expected. */
function ActionDescriptor() { this.map = {}; }
ActionDescriptor.prototype.putReference = function (k, r) { this.map[k] = r; };
function executeAction(id, desc, mode) {
    var target = desc && desc.map["c:T   "];
    var layerNow = app.activeDocument.activeLayer;
    AM.actions.push({ id: id, to: target ? target.parts[0][1] : null, activeKind: layerNow ? layerNow.kind : null });
    if (MOCK.failMaskSelection) throw new Error("the layer has no mask to load");
}

function List(items) { this.items = items; this.count = items.length; }
List.prototype.getReference = function (i) {
    var v = this.items[i];
    return { getIndex: function () { return v; } };
};
List.prototype.getObjectValue = function (i) { return this.items[i]; };

function charIDToTypeID(s) { return "c:" + s; }
function stringIDToTypeID(s) { return s; }

function executeActionGet(ref) {
    if (MOCK.noActionManager) throw new Error("ActionManager is unavailable");
    var kind = ref.parts[0] ? ref.parts[0][0] : "";
    var what = ref.parts[0] ? ref.parts[0][1] : "";

    if (kind === "prop" && what === "c:gblA") return new Desc({ "c:gblA": AM.globalAngle });
    if (kind === "prop" && what === "targetLayers") {
        return new Desc({ targetLayers: new List(AM.targetIndices) });
    }
    if (kind === "prop" && what === "layerID") {
        var index = ref.parts[1][1];
        var id = AM.layerIdAt["#" + index];
        if (id === undefined) throw new Error("no layer at index " + index);
        return new Desc({ layerID: id });
    }
    if (kind === "id") {
        var lid = ref.parts[0][1];
        var map = {};
        var m = AM.masks["#" + lid];
        if (m) { map.hasUserMask = true; map.userMaskEnabled = m.enabled !== false; }
        var adj = AM.adjustments["#" + lid];
        if (adj && !MOCK.noSolidColour) map.adjustment = new List([new Desc({ color: new Desc(adj) })]);
        if (AM.gradients["#" + lid]) map.adjustment = new List([AM.gradients["#" + lid]]);
        if (AM.styles["#" + lid]) map.layerEffects = AM.styles["#" + lid];
        return new Desc(map);
    }
    throw new Error("unexpected ActionReference");
}

// --- Document / layers ------------------------------------------------------
function bounds(x, y, w, h) { return [x, y, x + w, y + h]; }

function layer(name, kind, box, extra) {
    var l = {
        typename: "ArtLayer",
        name: name,
        kind: kind,
        bounds: bounds(box[0], box[1], box[2], box[3]),
        visible: true,
        opacity: 100,
        id: layer.nextId++,
        duplicate: function (target) {
            var copy = {
                kind: "copy",
                removed: false,
                remove: function () { this.removed = true; },
                bounds: this.bounds.slice(),
                translate: function (dx, dy) {
                    this.bounds = [this.bounds[0] + dx, this.bounds[1] + dy,
                                   this.bounds[2] + dx, this.bounds[3] + dy];
                }
            };
            target.duplicated.push({ name: name, layer: copy });
            return copy;
        }
    };
    if (extra) for (var k in extra) l[k] = extra[k];
    return l;
}
layer.nextId = 100;

function layerSet(name, box, kids) {
    var set = {
        typename: "LayerSet",
        name: name,
        bounds: bounds(box[0], box[1], box[2], box[3]),
        visible: true,
        opacity: 100,
        id: layer.nextId++,
        layers: kids
    };
    for (var i = 0; i < kids.length; i++) kids[i].parent = set;
    return set;
}

/** A path point in Photoshop's POINTS, the way the DOM reports them. */
function pp(a, l, r) { return { anchor: a, leftDirection: l || a, rightDirection: r || a }; }
function subPath(points, closed) {
    return { closed: closed !== false, pathPoints: points };
}
function vectorMask(subs) {
    return { kind: PathKind.VECTORMASK, subPathItems: subs };
}

var app;
function makeDoc(opts) {
    opts = opts || {};
    var d = {
        name: opts.name || "Art.psd",
        width: opts.width || 800,
        height: opts.height || 600,
        resolution: opts.resolution || 72,
        fullName: opts.saved === false ? null : new File("C:\\work\\Art.psd"),
        layers: opts.layers || [],
        pathItems: opts.pathItems || [],
        activeLayer: null,
        duplicated: [],
        resized: null,
        saved: [],
        closed: false,
        resizeImage: function (w, h) { this.resized = [w, h]; },
        saveAs: function (file) {
            if (MOCK.failExport) throw new Error("disk is full");
            this.saved.push(file.fsName);
            MOCK.exports.push(file.fsName);
        },
        close: function () { this.closed = true; },
        added: [],
        painted: [],
        artLayers: { add: function () { var l = { kind: "paper" }; d.added.push(l); return l; } },
        selection: {
            selectAll: function () { d.painted.push("select all"); },
            fill: function (c) { d.painted.push("fill " + c.rgb.red + " on " + (d.activeLayer ? d.activeLayer.kind : "?")); },
            deselect: function () { d.painted.push("deselect"); }
        }
    };
    for (var i = 0; i < d.layers.length; i++) d.layers[i].parent = d;
    return d;
}

function setUp(doc) {
    app = {
        documents: {
            length: 1,
            add: function (w, h, res, name) {
                var t = makeDoc({ name: name, width: w, height: h, resolution: res });
                app.created.push(t);
                app.activeDocument = t;
                return t;
            }
        },
        created: [],
        activeDocument: doc,
        preferences: { rulerUnits: null, typeUnits: null }
    };
    return doc;
}

// --- Load the real code (global scope) --------------------------------------
eval(load("json2.js"));
eval(load("lazylord.jsx"));
// ps-read leans on a few helpers the builder defines (_pv, _ps_msg, _ps_cid).
eval(load("ps.jsx"));
eval(load("ps-read.jsx"));

// --- Assertions -------------------------------------------------------------
var passed = 0, failed = 0;
function ok(name, cond, detail) {
    if (cond) { WScript.Echo("  ok   " + name); passed++; }
    else { WScript.Echo("  FAIL " + name + (detail ? "  -> " + detail : "")); failed++; }
}
function near(a, b, eps) { return Math.abs(a - b) < (eps || 1e-6); }
function xy(p) { return p ? "[" + p[0] + "," + p[1] + "]" : String(p); }
function dump(x) { return JSON.stringify(x); }
function diagWith(re) {
    for (var i = 0; i < LazyLord.diagnostics.length; i++) {
        if (re.test(LazyLord.diagnostics[i].reason)) return LazyLord.diagnostics[i];
    }
    return null;
}
function readIt(opts) {
    LazyLord.resetDiagnostics();
    LazyLord.readOptions = LazyLord.normaliseReadOptions(opts);
    return LazyLord.readSelection("C:\\tmp\\out", LazyLord.readOptions);
}
function reset() {
    MOCK = { noActionManager: false, noVectorMask: false, noSolidColour: false, exports: [], failExport: false,
             failMaskSelection: false };
    AM = { targetIndices: [], layerIdAt: {}, adjustments: {}, masks: {}, actions: [], gradients: {}, styles: {}, globalAngle: 120 };
}
/** Select `list` (bottom-most first, as Photoshop indexes them). */
function select(doc, list) {
    AM.targetIndices = [];
    for (var i = 0; i < list.length; i++) {
        AM.targetIndices.push(i);
        AM.layerIdAt["#" + (i + 1)] = list[i].id; // no Background layer -> offset 1
    }
}

WScript.Echo("LazyLord - Photoshop reader (mocked DOM)");
WScript.Echo("");

// 1) A shape layer: a solid fill wearing a vector mask.
(function () {
    reset();
    // A 100x50 rectangle at (20, 30). Photoshop reports path points in POINTS,
    // so at 144 ppi those numbers are half the pixel values.
    var mask = vectorMask([subPath([
        pp([10, 15]), pp([60, 15]), pp([60, 40]), pp([10, 40])
    ])]);
    var shape = layer("Badge", LayerKind.SOLIDFILL, [20, 30, 100, 50]);
    var doc = setUp(makeDoc({ resolution: 144, layers: [shape], pathItems: [mask] }));
    AM.adjustments["#" + shape.id] = { red: 255, grain: 0, blue: 0 };
    select(doc, [shape]);

    var ir = readIt();
    var l = ir.layers[0];

    ok("shape: one vector layer", ir.layers.length === 1 && l.type === "vector", l && l.type);
    ok("shape: source is photoshop", ir.source === "photoshop", ir.source);
    ok("shape: the canvas is the page", ir.canvas.width === 800 && ir.originSpace === "document",
       dump(ir.canvas));
    ok("shape: bounds at the layer", near(ir.bounds.x, 20) && near(ir.bounds.y, 30),
       ir.bounds.x + "," + ir.bounds.y);
    ok("shape: frame normalised to 0,0", near(l.frame.x, 0) && near(l.frame.y, 0),
       l.frame.x + "," + l.frame.y);
    ok("shape: 100x50", near(l.frame.width, 100) && near(l.frame.height, 50),
       l.frame.width + "x" + l.frame.height);
    ok("shape: no rotation (Photoshop bakes it)", l.frame.rotation === 0);

    // points * (resolution / 72) = pixels, then local to the layer's top-left.
    var v = l.subpaths[0].vertices;
    ok("shape: points converted to pixels and made local",
       near(v[0][0], 0) && near(v[0][1], 0) && near(v[1][0], 100) && near(v[2][1], 50),
       v[0] + " " + v[1] + " " + v[2]);
    ok("shape: closed", l.subpaths[0].closed === true);
    ok("shape: the fill colour was read", l.fills.length === 1 && near(l.fills[0].color.r, 1) &&
       near(l.fills[0].color.g, 0), dump(l.fills));
    ok("shape: nothing had to fall back", LazyLord.diagnostics.length === 0, dump(LazyLord.diagnostics));
})();

// 2) Bezier handles come through as tangents relative to their vertex.
(function () {
    reset();
    // One point at (0,0) px with its out-handle 20 px to the right; at 72 ppi
    // points and pixels are the same number.
    var mask = vectorMask([subPath([pp([0, 0], [0, 0], [20, 0]), pp([40, 0])], false)]);
    var shape = layer("Curve", LayerKind.SOLIDFILL, [0, 0, 40, 10]);
    var doc = setUp(makeDoc({ resolution: 72, layers: [shape], pathItems: [mask] }));
    AM.adjustments["#" + shape.id] = { red: 0, grain: 0, blue: 255 };
    select(doc, [shape]);

    var sp = readIt().layers[0].subpaths[0];
    ok("handles: out-tangent is relative to its vertex",
       near(sp.outTangents[0][0], 20) && near(sp.outTangents[0][1], 0), xy(sp.outTangents[0]));
    ok("handles: an unset handle is zero", near(sp.inTangents[0][0], 0) && near(sp.inTangents[0][1], 0),
       xy(sp.inTangents[0]));
    ok("handles: open subpath stays open", sp.closed === false);
})();

// 3) Text: contents, size, colour, font and the real baseline.
(function () {
    reset();
    var t = layer("Title", LayerKind.TEXT, [10, 20, 200, 40], {
        textItem: {
            contents: "Hello", size: 30, kind: TextType.POINTTEXT,
            color: { rgb: { red: 0, green: 0, blue: 255 } },
            font: "Futura-Bold", justification: Justification.LEFT,
            tracking: 100, useAutoLeading: true, position: [12, 55]
        }
    });
    var doc = setUp(makeDoc({ resolution: 72, layers: [t] }));
    select(doc, [t]);

    var l = readIt().layers[0];
    ok("text: layer type", l.type === "text", l.type);
    ok("text: contents", l.characters === "Hello", l.characters);
    ok("text: size", near(l.fontSize, 30), String(l.fontSize));
    ok("text: colour", near(l.color.b, 1) && near(l.color.r, 0), dump(l.color));
    ok("text: PostScript name split into family and style",
       l.fontFamily === "Futura" && l.fontStyle === "Bold", l.fontFamily + "/" + l.fontStyle);
    ok("text: tracking converted to px", near(l.letterSpacing, 3), String(l.letterSpacing));
    ok("text: the real baseline travels", near(l.baseline, 35) && near(l.anchorX, 2),
       l.anchorX + "," + l.baseline); // 55 - 20 and 12 - 10, after normalising
})();

// 4) Paragraph text has no single baseline, and says so.
(function () {
    reset();
    var t = layer("Body", LayerKind.TEXT, [0, 0, 100, 100], {
        textItem: {
            contents: "Para", size: 12, kind: TextType.PARAGRAPHTEXT,
            color: { rgb: { red: 0, green: 0, blue: 0 } }, font: "Arial",
            justification: Justification.LEFT, tracking: 0, useAutoLeading: true, position: [0, 0]
        }
    });
    var doc = setUp(makeDoc({ layers: [t] }));
    select(doc, [t]);

    var l = readIt().layers[0];
    ok("paragraph: still live text", l.type === "text" && l.characters === "Para");
    ok("paragraph: no baseline claimed", l.baseline === undefined, String(l.baseline));
    ok("paragraph: reported", !!diagWith(/rebuilt as point text/), dump(LazyLord.diagnostics));
})();

// 5) A pixel layer is rasterised into a scratch document, not the user's.
(function () {
    reset();
    var px = layer("Photo", LayerKind.NORMAL, [50, 60, 200, 100]);
    var doc = setUp(makeDoc({ resolution: 72, layers: [px] }));
    select(doc, [px]);

    var l = readIt({ scale: 2 }).layers[0];
    ok("raster: becomes an image layer", l.type === "image", l.type);
    ok("raster: placed where it sat", near(l.frame.x, 0) && near(l.frame.y, 0));
    ok("raster: sized in document pixels", near(l.frame.width, 200) && near(l.frame.height, 100));
    ok("raster: generated, not the user's own file", l.isOriginalFile === false);
    ok("raster: a PNG was written", MOCK.exports.length === 1 && /Photo-0\.png$/.test(MOCK.exports[0]),
       dump(MOCK.exports));
    ok("raster: the scratch document was closed", app.created[0].closed === true);
    ok("raster: the user's document was not touched", doc.closed === false && doc.saved.length === 0);
    ok("raster: the copy was brought to the origin",
       near(app.created[0].duplicated[0].layer.bounds[0], 0) &&
       near(app.created[0].duplicated[0].layer.bounds[1], 0),
       dump(app.created[0].duplicated[0].layer.bounds));
    ok("raster: reported", !!diagWith(/Pixel layers are sent as an image/), dump(LazyLord.diagnostics));
    ok("raster: pixel size follows the scale", l.pixelWidth === 400 && l.pixelHeight === 200,
       l.pixelWidth + "x" + l.pixelHeight);
    ok("raster: the scratch document was scaled", !!app.created[0].resized, dump(app.created[0].resized));
})();

// 6) The scale option reaches the export; 1x does not resize at all.
(function () {
    reset();
    var px = layer("Photo", LayerKind.NORMAL, [0, 0, 100, 100]);
    var doc = setUp(makeDoc({ layers: [px] }));
    select(doc, [px]);

    var l = readIt({ scale: 1 }).layers[0];
    ok("scale: 1x needs no resize", app.created[0].resized === null, dump(app.created[0].resized));
    ok("scale: 1x pixel size", l.pixelWidth === 100, String(l.pixelWidth));
})();

// 7) Every kind that cannot be described natively names itself when reported.
(function () {
    reset();
    var smart = layer("Logo", LayerKind.SMARTOBJECT, [0, 0, 50, 50]);
    var doc = setUp(makeDoc({ layers: [smart] }));
    select(doc, [smart]);
    readIt();
    ok("smart object: reported in its own words", !!diagWith(/Smart objects are sent as a flattened image/),
       dump(LazyLord.diagnostics));

    reset();
    var adj = layer("Curves", LayerKind.BRIGHTNESSCONTRAST, [0, 0, 50, 50]);
    var doc2 = setUp(makeDoc({ layers: [adj] }));
    select(doc2, [adj]);
    readIt();
    ok("adjustment: reported in its own words", !!diagWith(/Adjustment layers/), dump(LazyLord.diagnostics));
})();

// 8) A shape whose outline or colour cannot be read falls back to a raster
//    rather than arriving wrong.
(function () {
    reset();
    var shape = layer("Badge", LayerKind.SOLIDFILL, [0, 0, 50, 50]);
    var doc = setUp(makeDoc({ layers: [shape], pathItems: [] })); // no vector mask
    AM.adjustments["#" + shape.id] = { red: 255, grain: 0, blue: 0 };
    select(doc, [shape]);
    var l = readIt().layers[0];
    ok("no mask: falls back to an image", l.type === "image", l.type);
    ok("no mask: reported", !!diagWith(/no outline to read/), dump(LazyLord.diagnostics));

    reset();
    var shape2 = layer("Badge", LayerKind.SOLIDFILL, [0, 0, 50, 50]);
    var mask = vectorMask([subPath([pp([0, 0]), pp([50, 0]), pp([50, 50])])]);
    var doc2 = setUp(makeDoc({ layers: [shape2], pathItems: [mask] }));
    MOCK.noSolidColour = true; // the colour cannot be read
    select(doc2, [shape2]);
    var l2 = readIt().layers[0];
    ok("no colour: falls back to an image", l2.type === "image", l2.type);
})();

// 9) Groups nest, and Photoshop's front-to-back order is turned around.
(function () {
    reset();
    var top = layer("Top", LayerKind.NORMAL, [0, 0, 50, 50]);
    var bottom = layer("Bottom", LayerKind.NORMAL, [0, 0, 50, 50]);
    var set = layerSet("Card", [0, 0, 60, 60], [top, bottom]); // front first, as Photoshop lists them
    var doc = setUp(makeDoc({ layers: [set] }));
    set.opacity = 50;
    select(doc, [set]);

    var g = readIt().layers[0];
    ok("group: becomes an IR group", g.type === "group", g.type);
    ok("group: its opacity travels", near(g.frame.opacity, 0.5), String(g.frame.opacity));
    ok("group: children are bottom-to-top",
       g.children.length === 2 && g.children[0].name === "Bottom" && g.children[1].name === "Top",
       g.children[0].name + "," + g.children[1].name);
})();

// 10) Without ActionManager only the active layer can be read — and it says so
//     rather than sending nothing.
(function () {
    reset();
    var a = layer("A", LayerKind.NORMAL, [0, 0, 10, 10]);
    var b = layer("B", LayerKind.NORMAL, [20, 0, 10, 10]);
    var doc = setUp(makeDoc({ layers: [a, b] }));
    doc.activeLayer = b;
    MOCK.noActionManager = true;

    var ir = readIt();
    ok("no AM: the active layer still goes", ir.layers.length === 1 && ir.layers[0].name === "B",
       ir.layers.length + " " + (ir.layers[0] && ir.layers[0].name));
    ok("no AM: and the limit is reported", !!diagWith(/Only the active layer could be read/),
       dump(LazyLord.diagnostics));
})();

// 11) Several selected layers normalise against their shared top-left.
(function () {
    reset();
    var a = layer("A", LayerKind.NORMAL, [100, 100, 50, 50]);
    var b = layer("B", LayerKind.NORMAL, [300, 100, 50, 50]);
    var doc = setUp(makeDoc({ layers: [a, b] }));
    select(doc, [a, b]);

    var ir = readIt();
    ok("multi: both layers", ir.layers.length === 2, String(ir.layers.length));
    ok("multi: bounds start at the left-most edge", near(ir.bounds.x, 100) && near(ir.bounds.y, 100),
       ir.bounds.x + "," + ir.bounds.y);
    ok("multi: first normalised to 0,0", near(ir.layers[0].frame.x, 0));
    ok("multi: second offset by 200", near(ir.layers[1].frame.x, 200), String(ir.layers[1].frame.x));
    ok("multi: bounds span both", near(ir.bounds.width, 250), String(ir.bounds.width));
})();

// 11b) Live sync: the stamp follows the history and the selection.
(function () {
    reset();
    var a = layer("A", LayerKind.NORMAL, [100, 100, 50, 50]);
    var b = layer("B", LayerKind.NORMAL, [300, 100, 50, 50]);
    var doc = setUp(makeDoc({ layers: [a, b] }));
    doc.id = 7;
    doc.historyStates = { length: 3 };
    doc.activeHistoryState = { name: "Move" };
    select(doc, [a]);
    doc.activeLayer = a;
    var s1 = LazyLord.liveStamp();
    ok("live stamp: a document gives one", /^[0-9a-z]+\.[0-9a-z]+$/.test(s1), s1);
    ok("live stamp: the same each time", LazyLord.liveStamp() === s1);
    doc.historyStates.length = 4;
    doc.activeHistoryState = { name: "Color Fill" };
    var s2 = LazyLord.liveStamp();
    ok("live stamp: a new history state changes it", s2 !== s1);
    a.bounds = bounds(110, 100, 50, 50); // a move, with the history already full
    var s3 = LazyLord.liveStamp();
    ok("live stamp: so does moving the active layer", s3 !== s2);
    select(doc, [a, b]);
    ok("live stamp: and a different selection", LazyLord.liveStamp() !== s3);
    app.documents.length = 0;
    ok("live stamp: no document is empty", LazyLord.liveStamp() === "");
})();

// 12) The document key is what stops a layer id matching another file's.
(function () {
    reset();
    var a = layer("A", LayerKind.NORMAL, [0, 0, 10, 10]);
    var doc = setUp(makeDoc({ layers: [a] }));
    select(doc, [a]);
    ok("key: a saved document is identified by its path",
       readIt().sourceKey === "C:\\work\\Art.psd", readIt().sourceKey);

    reset();
    var b = layer("A", LayerKind.NORMAL, [0, 0, 10, 10]);
    var doc2 = setUp(makeDoc({ layers: [b], saved: false }));
    select(doc2, [b]);
    ok("key: an unsaved one offers nothing", readIt().sourceKey === "", readIt().sourceKey);
})();

// 13) Ruler units are set for the read and put back afterwards.
(function () {
    reset();
    var a = layer("A", LayerKind.NORMAL, [0, 0, 10, 10]);
    var doc = setUp(makeDoc({ layers: [a] }));
    app.preferences.rulerUnits = "inches";
    app.preferences.typeUnits = "points";
    select(doc, [a]);
    readIt();
    ok("units: restored after reading",
       app.preferences.rulerUnits === "inches" && app.preferences.typeUnits === "points",
       app.preferences.rulerUnits + "," + app.preferences.typeUnits);

    // Even when the read throws part-way.
    reset();
    var doc2 = setUp(makeDoc({ layers: [] }));
    app.preferences.rulerUnits = "inches";
    var threw = false;
    try { readIt(); } catch (e) { threw = true; }
    ok("units: restored even when nothing could be read", threw && app.preferences.rulerUnits === "inches",
       app.preferences.rulerUnits);
})();

// 14) A failed export is reported and skipped, never sent as a broken layer.
(function () {
    reset();
    var px = layer("Photo", LayerKind.NORMAL, [0, 0, 50, 50]);
    var doc = setUp(makeDoc({ layers: [px] }));
    MOCK.failExport = true;
    select(doc, [px]);

    var threw = false;
    try { readIt(); } catch (e) { threw = true; }
    ok("export failure: nothing transferable is an error", threw);
    ok("export failure: reported with its reason", !!diagWith(/Could not be rasterised/),
       dump(LazyLord.diagnostics));
    ok("export failure: the scratch document was still closed", app.created[0].closed === true);
})();

// M1) A clipping group: every clipped layer points at its base, which stays itself.
(function () {
    reset();
    var base = layer("Base", LayerKind.NORMAL, [0, 0, 100, 100]);
    var one = layer("Tint", LayerKind.NORMAL, [10, 10, 50, 50], { grouped: true });
    var two = layer("Glow", LayerKind.NORMAL, [20, 20, 50, 50], { grouped: true });
    // Photoshop lists front to back.
    var doc = setUp(makeDoc({ layers: [two, one, base] }));
    select(doc, [base, one, two]);

    var ir = readIt();
    var ids = [];
    for (var i = 0; i < ir.layers.length; i++) ids.push(ir.layers[i].name + ">" + (ir.layers[i].clipTo || "-"));
    ok("clipping: the base is not clipped", !ir.layers[0].clipTo, ids.join(" "));
    ok("clipping: both clipped layers name the base",
       ir.layers[1].clipTo === ir.layers[0].id && ir.layers[2].clipTo === ir.layers[0].id, ids.join(" "));
    ok("clipping: nothing reported about clipping", diagWith(/clipped to/) === null, dump(LazyLord.diagnostics));
})();

// M2) A clipped layer sent without its base arrives unclipped, and says to what it was clipped.
(function () {
    reset();
    var base = layer("Photo", LayerKind.NORMAL, [0, 0, 100, 100]);
    var tint = layer("Tint", LayerKind.NORMAL, [0, 0, 100, 100], { grouped: true });
    var other = layer("Other", LayerKind.NORMAL, [0, 0, 10, 10]);
    var doc = setUp(makeDoc({ layers: [tint, base, other] }));
    select(doc, [other, tint]);

    var ir = readIt();
    var t = ir.layers[1];
    ok("clipping, base not sent: no clipTo, and not to the wrong layer below", t && !t.clipTo, dump(t));
    var d = diagWith(/clipped to 'Photo', which was not sent/);
    ok("clipping, base not sent: reported with the base's name", d !== null && d.object === "Tint", dump(LazyLord.diagnostics));
})();

// M3) Clipping inside a group links within that group.
(function () {
    reset();
    var base = layer("Card", LayerKind.NORMAL, [0, 0, 100, 60]);
    var art = layer("Art", LayerKind.NORMAL, [0, 0, 100, 60], { grouped: true });
    var set = layerSet("Folder", [0, 0, 100, 60], [art, base]);
    var doc = setUp(makeDoc({ layers: [set] }));
    select(doc, [set]);

    var g = readIt().layers[0];
    ok("clipping in a group: the clipped child names its sibling",
       g && g.children && g.children[1].clipTo === g.children[0].id, dump(g && g.children));
})();

// M4) A layer mask on live text: drawn in a scratch document as a greyscale PNG.
(function () {
    reset();
    var t = layer("Headline", LayerKind.TEXT, [40, 30, 200, 50], {
        textItem: { contents: "Hi", size: 30, kind: TextType.POINTTEXT, position: [40, 70], font: "ArialMT",
                    color: { rgb: { red: 0, green: 0, blue: 0 } }, justification: Justification.LEFT }
    });
    AM.masks["#" + t.id] = { enabled: true };
    var doc = setUp(makeDoc({ layers: [t] }));
    select(doc, [t]);

    var ir = readIt();
    var l = ir.layers[0];
    ok("layer mask: the text stays live", l && l.type === "text", l && l.type);
    ok("layer mask: carried as a mask covering the layer",
       l && l.mask && near(l.mask.frame.x, 0) && near(l.mask.frame.y, 0) &&
       near(l.mask.frame.width, 200) && near(l.mask.frame.height, 50), dump(l && l.mask));
    ok("layer mask: saved as a PNG beside the transfer",
       l && l.mask && /Headline-mask-\d+\.png$/.test(l.mask.filePath) && MOCK.exports.join("|").indexOf("-mask-") > 0,
       MOCK.exports.join("|"));
    var scratch = app.created[app.created.length - 1];
    ok("layer mask: black first, then the mask loaded as a selection and filled white, on the paper layer",
       scratch && scratch.painted.join(", ") === "select all, fill 0 on paper, deselect, fill 255 on paper, deselect",
       scratch && scratch.painted.join(", "));
    ok("layer mask: the selection came from the copy's mask channel",
       AM.actions.length === 1 && AM.actions[0].to === "c:Msk " && AM.actions[0].activeKind === "copy", dump(AM.actions));
    ok("layer mask: the copy is removed before saving, and the scratch document closed",
       scratch && scratch.duplicated.length === 1 && scratch.duplicated[0].layer.removed === true && scratch.closed === true);
    ok("layer mask: the user's document gains nothing", doc.added.length === 0 && doc.painted.length === 0);
    ok("layer mask: the scratch copy was moved to the scratch origin",
       scratch && near(scratch.duplicated[0].layer.bounds[0], 0) && near(scratch.duplicated[0].layer.bounds[1], 0),
       scratch && dump(scratch.duplicated[0].layer.bounds));
})();

// M5) A mask that is switched off is not sent; one that cannot be read is reported.
(function () {
    reset();
    var shapeMask = vectorMask([subPath([pp([0, 0]), pp([50, 0]), pp([50, 50]), pp([0, 50])])]);
    var off = layer("Off", LayerKind.SOLIDFILL, [0, 0, 50, 50]);
    AM.adjustments["#" + off.id] = { red: 255, grain: 255, blue: 255 };
    AM.masks["#" + off.id] = { enabled: false };
    var doc = setUp(makeDoc({ layers: [off], pathItems: [shapeMask] }));
    select(doc, [off]);
    var l = readIt().layers[0];
    ok("mask off: the shape arrives without one", l && l.type === "vector" && !l.mask, dump(l));

    reset();
    var broken = layer("Broken", LayerKind.SOLIDFILL, [0, 0, 50, 50]);
    AM.adjustments["#" + broken.id] = { red: 255, grain: 255, blue: 255 };
    AM.masks["#" + broken.id] = { enabled: true };
    MOCK.failMaskSelection = true;
    doc = setUp(makeDoc({ layers: [broken], pathItems: [shapeMask] }));
    select(doc, [broken]);
    l = readIt().layers[0];
    ok("mask unreadable: the shape still arrives, unmasked", l && l.type === "vector" && !l.mask, dump(l));
    ok("mask unreadable: said so", diagWith(/layer mask could not be read/) !== null, dump(LazyLord.diagnostics));
    ok("mask unreadable: the scratch document is still closed", app.created[app.created.length - 1].closed === true);
})();

// M6) A group's own layer mask is not transferred, and that is reported.
(function () {
    reset();
    var kid = layer("Inside", LayerKind.NORMAL, [0, 0, 20, 20]);
    var set = layerSet("Masked group", [0, 0, 20, 20], [kid]);
    AM.masks["#" + set.id] = { enabled: true };
    var doc = setUp(makeDoc({ layers: [set] }));
    select(doc, [set]);
    readIt();
    var d = diagWith(/group's layer mask is not transferred/);
    ok("group mask: reported", d !== null && d.object === "Masked group", dump(LazyLord.diagnostics));
})();

// GF) Gradient fill layers become vectors with a real gradient paint.
function gStop(loc, r, g, b, extra) {
    var m = { "c:Lctn": loc, "c:Mdpn": 50, "c:Type": "c:UsrS", "c:Clr ": new Desc({ "c:Rd  ": r, "c:Grn ": g, "c:Bl  ": b }) };
    if (extra) for (var k in extra) m[k] = extra[k];
    return new Desc(m);
}
function tStop(loc, opacity, mid) { return new Desc({ "c:Lctn": loc, "c:Mdpn": mid === undefined ? 50 : mid, "c:Opct": opacity }); }
function gradFill(opts) {
    return new Desc({
        "c:Type": "c:" + (opts.type || "Lnr "),
        "c:Angl": opts.angle === undefined ? 0 : opts.angle,
        "c:Scl ": opts.scale === undefined ? 100 : opts.scale,
        "c:Rvrs": !!opts.reverse,
        "c:Algn": opts.align !== false,
        "c:Ofst": new Desc({ "c:Hrzn": opts.ox || 0, "c:Vrtc": opts.oy || 0 }),
        "c:Grad": new Desc(opts.noise ? {} : {
            "c:Clrs": new List(opts.colours || [gStop(0, 255, 0, 0), gStop(4096, 0, 0, 255)]),
            "c:Trns": new List(opts.alphas || [tStop(0, 100), tStop(4096, 100)])
        })
    });
}
function gradientRead(opts, box, docOpts) {
    reset();
    var g = layer("Sky", LayerKind.GRADIENTFILL, box || [0, 0, 200, 100]);
    AM.gradients["#" + g.id] = gradFill(opts);
    var o = docOpts || {};
    o.layers = [g];
    var doc = setUp(makeDoc(o));
    select(doc, [g]);
    return readIt().layers[0];
}

(function () {
    var l = gradientRead({ alphas: [tStop(0, 100), tStop(2048, 50), tStop(4096, 0)] });
    var f = l && l.fills[0];
    ok("gradient fill: a vector, not an image", l && l.type === "vector", l && l.type);
    ok("gradient fill: without a mask it is its box, as a live rectangle",
       l && l.primitive && l.primitive.kind === "rect" && near(l.primitive.width, 200) && l.subpaths.length === 1, dump(l && l.primitive));
    ok("gradient fill: linear, left to right at 0 degrees",
       f && f.type === "linear-gradient" && near(f.from.x, 0) && near(f.from.y, 0.5) && near(f.to.x, 1) && near(f.to.y, 0.5), dump(f));
    ok("gradient fill: colour and transparency stops merged where either has one",
       f && f.stops.length === 3 && near(f.stops[1].position, 0.5), dump(f && f.stops));
    ok("gradient fill: the colour in the middle is read off the colour ramp",
       f && near(f.stops[1].color.r, 0.5) && near(f.stops[1].color.b, 0.5), dump(f && f.stops[1]));
    ok("gradient fill: each stop's alpha off the transparency ramp",
       f && near(f.stops[0].color.a, 1) && near(f.stops[1].color.a, 0.5) && near(f.stops[2].color.a, 0), dump(f && f.stops));
    ok("gradient fill: nothing to report", LazyLord.diagnostics.length === 0, dump(LazyLord.diagnostics));
})();

(function () {
    var up = gradientRead({ angle: 90 });
    var f = up && up.fills[0];
    ok("gradient fill: 90 degrees runs bottom to top, to the box's edge",
       f && near(f.from.x, 0.5) && near(f.from.y, 1) && near(f.to.x, 0.5) && near(f.to.y, 0), dump(f));

    var rev = gradientRead({ reverse: true }).fills[0];
    ok("gradient fill: reversed swaps its ends", near(rev.from.x, 1) && near(rev.to.x, 0), dump(rev));

    var rad = gradientRead({ type: "Rdl ", scale: 50, ox: 10 }).fills[0];
    ok("gradient fill: radial from its offset centre, half the reach at 50%",
       rad.type === "radial-gradient" && near(rad.from.x, 0.6) && near(rad.from.y, 0.5) && near(rad.to.x, 0.85), dump(rad));

    var rrev = gradientRead({ type: "Rdl ", reverse: true, colours: [gStop(0, 255, 255, 255), gStop(1024, 0, 0, 0)] }).fills[0];
    ok("gradient fill: a reversed radial turns its stops around",
       near(rrev.stops[0].position, 0) && near(rrev.stops[0].color.r, 0) && near(rrev.stops[rrev.stops.length - 1].position, 1) &&
       near(rrev.stops[rrev.stops.length - 1].color.r, 1), dump(rrev.stops));

    var canvas = gradientRead({ align: false }, [100, 0, 100, 100], { width: 800, height: 600 }).fills[0];
    ok("gradient fill: not aligned with the layer, it is measured on the canvas",
       near(canvas.from.x, -1) && near(canvas.to.x, 7) && near(canvas.from.y, 3), dump(canvas));
})();

(function () {
    var angle = gradientRead({ type: "Angl" });
    ok("gradient fill: an angle gradient falls back to an image, said why",
       angle && angle.type === "image" && diagWith(/Angle, reflected and diamond/) !== null, dump(LazyLord.diagnostics));
    var noise = gradientRead({ noise: true });
    ok("gradient fill: so does a noise gradient", noise && noise.type === "image" && diagWith(/noise gradient/) !== null,
       dump(LazyLord.diagnostics));
    var odd = gradientRead({ alphas: [tStop(0, 100), tStop(4096, 100, 25)] });
    ok("gradient fill: an off-centre midpoint is reported",
       odd && odd.type === "vector" && diagWith(/midpoints are moved off centre/) !== null, dump(LazyLord.diagnostics));
})();

// LS) Layer styles on live layers become IR effects.
function rgbDesc(r, g, b) { return new Desc({ "c:Rd  ": r, "c:Grn ": g, "c:Bl  ": b }); }
function styledShape(effects) {
    reset();
    var shapeMask = vectorMask([subPath([pp([0, 0]), pp([100, 0]), pp([100, 50]), pp([0, 50])])]);
    var s = layer("Button", LayerKind.SOLIDFILL, [0, 0, 100, 50]);
    AM.adjustments["#" + s.id] = { red: 255, grain: 255, blue: 255 };
    AM.styles["#" + s.id] = new Desc(effects);
    var doc = setUp(makeDoc({ layers: [s], pathItems: [shapeMask] }));
    select(doc, [s]);
    return readIt().layers[0];
}
function fxOfKind(l, kind) {
    var out = [];
    for (var i = 0; l && l.effects && i < l.effects.length; i++) if (l.effects[i].kind === kind) out.push(l.effects[i]);
    return out;
}

(function () {
    var l = styledShape({
        "c:Scl ": 100,
        dropShadow: new Desc({ "c:enab": true, "c:Md  ": "multiply", "c:Clr ": rgbDesc(0, 0, 0), "c:Opct": 50, "c:uglg": false,
                               "c:lagl": 90, "c:Dstn": 10, "c:Ckmt": 20, "c:blur": 8 }),
        innerShadow: new Desc({ "c:enab": false, "c:Clr ": rgbDesc(0, 0, 0), "c:Opct": 75 }),
        outerGlowMulti: new List([
            new Desc({ "c:enab": true, "c:Md  ": "screen", "c:Clr ": rgbDesc(255, 255, 0), "c:Opct": 80, "c:Ckmt": 50, "c:blur": 12 }),
            new Desc({ "c:enab": true, "c:Md  ": "dissolve", "c:Clr ": rgbDesc(0, 255, 255), "c:Opct": 100, "c:blur": 4 })
        ]),
        innerGlow: new Desc({ "c:enab": true, "c:Clr ": rgbDesc(255, 255, 255), "c:Opct": 60, "c:blur": 6, "c:Ckmt": 50, "c:glwS": "c:SrcC" }),
        frameFX: new Desc({ "c:enab": true, "c:Styl": "c:InsF", "c:PntT": "c:SClr", "c:Opct": 100, "c:Sz  ": 3, "c:Clr ": rgbDesc(255, 0, 0) }),
        solidFill: new Desc({ "c:enab": true, "c:Md  ": "overlay", "c:Opct": 40, "c:Clr ": rgbDesc(0, 128, 255) }),
        chromeFX: new Desc({ "c:enab": true, "c:Clr ": rgbDesc(0, 0, 0), "c:Opct": 50, "c:lagl": 19, "c:Dstn": 11, "c:blur": 14, "c:Invr": true }),
        bevelEmboss: new Desc({ "c:enab": true, "c:bvlS": "c:Embs", "c:bvlT": "c:PrBL", "c:srgR": 250, "c:bvlD": "c:Out ", "c:blur": 7,
                                "c:Sftn": 2, "c:uglg": true, "c:Lald": 45, "c:hglC": rgbDesc(255, 255, 255), "c:hglO": 90,
                                "c:sdwC": rgbDesc(0, 0, 0), "c:sdwO": 60 }),
        patternFill: new Desc({ "c:enab": true })
    });

    var ds = fxOfKind(l, "drop-shadow")[0];
    ok("styles: the shape still arrives as a vector", l && l.type === "vector", l && l.type);
    ok("styles: a drop shadow, light from above so it falls down",
       ds && near(ds.offset.x, 0, 1e-9) && near(ds.offset.y, 10) && near(ds.radius, 8) && near(ds.color.a, 0.5), dump(ds));
    ok("styles: its spread is the percentage of its size, in px", ds && near(ds.spread, 1.6), dump(ds));
    ok("styles: and its blend mode", ds && ds.blendMode === "multiply", dump(ds));
    ok("styles: a switched-off inner shadow is not sent", fxOfKind(l, "inner-shadow").length === 0, dump(l && l.effects));

    var glows = fxOfKind(l, "outer-glow");
    ok("styles: both outer glows of a Multi list", glows.length === 2 && near(glows[0].spread, 6) && near(glows[0].color.a, 0.8),
       dump(glows));
    ok("styles: a blend mode with no equivalent is reported and left off",
       glows.length === 2 && glows[1].blendMode === undefined && diagWith(/blend mode 'dissolve'/) !== null, dump(LazyLord.diagnostics));
    var ig = fxOfKind(l, "inner-glow")[0];
    ok("styles: inner glow from the centre, with its choke", ig && ig.source === "center" && near(ig.choke, 3), dump(ig));
    var st = fxOfKind(l, "stroke")[0];
    ok("styles: a Layer Style stroke, inside, 3 px red", st && st.position === "inside" && near(st.width, 3) && near(st.color.r, 1), dump(st));
    var co = fxOfKind(l, "color-overlay")[0];
    ok("styles: a colour overlay at 40%, overlay", co && near(co.color.a, 0.4) && co.blendMode === "overlay", dump(co));
    var sa = fxOfKind(l, "satin")[0];
    ok("styles: satin, inverted", sa && sa.invert === true && near(sa.distance, 11), dump(sa));
    var bv = fxOfKind(l, "bevel")[0];
    ok("styles: bevel and emboss read, down, following the global light",
       bv && bv.style === "emboss" && bv.technique === "hard" && bv.up === false && near(bv.angle, 120) && near(bv.highlight.a, 0.9),
       dump(bv));
    ok("styles: a pattern overlay is reported", diagWith(/pattern overlay is not transferred/) !== null, dump(LazyLord.diagnostics));
    ok("styles: the old 'not transferred' note is gone", diagWith(/layer style \(shadows/) === null, dump(LazyLord.diagnostics));
})();

(function () {
    // Scale Effects halves every size; a gradient-filled stroke is not carried.
    var l = styledShape({
        "c:Scl ": 50,
        dropShadow: new Desc({ "c:enab": true, "c:Clr ": rgbDesc(0, 0, 0), "c:Opct": 100, "c:uglg": false, "c:lagl": 180, "c:Dstn": 20, "c:blur": 10 }),
        frameFX: new Desc({ "c:enab": true, "c:PntT": "c:GrFl", "c:Sz  ": 4 })
    });
    var ds = fxOfKind(l, "drop-shadow")[0];
    ok("styles: Scale Effects applies to distance and size", ds && near(ds.offset.x, 10) && near(ds.radius, 5), dump(ds));
    ok("styles: a gradient stroke is reported once, not also as unreadable",
       fxOfKind(l, "stroke").length === 0 && diagWith(/filled with a gradient or pattern/) !== null &&
       diagWith(/stroke could not be read/) === null, dump(LazyLord.diagnostics));
})();

(function () {
    // A layer sent as an image keeps its style in its pixels: no effects on top.
    reset();
    var pix = layer("Photo", LayerKind.NORMAL, [0, 0, 40, 40]);
    AM.styles["#" + pix.id] = new Desc({ dropShadow: new Desc({ "c:enab": true, "c:Clr ": rgbDesc(0, 0, 0), "c:Opct": 100 }) });
    var doc = setUp(makeDoc({ layers: [pix] }));
    select(doc, [pix]);
    var l = readIt().layers[0];
    ok("styles: an image layer does not also send its style", l && l.type === "image" && !l.effects, dump(l));
})();

WScript.Echo("");
WScript.Echo(passed + " passed, " + failed + " failed.");
WScript.Quit(failed === 0 ? 0 : 1);
