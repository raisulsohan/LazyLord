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
function UnitValue(v) { return v; }
function File(p) { this.fsName = String(p); }

var MOCK = { noActionManager: false, noVectorMask: false, noSolidColour: false, exports: [], failExport: false };

/** Photoshop's ActionManager, reduced to the two things the reader asks it. */
var AM = { targetIndices: [], layerIdAt: {}, adjustments: {} };
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
        var adj = AM.adjustments["#" + ref.parts[0][1]];
        if (!adj || MOCK.noSolidColour) return new Desc({});
        return new Desc({ adjustment: new List([new Desc({ color: new Desc(adj) })]) });
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
    return {
        typename: "LayerSet",
        name: name,
        bounds: bounds(box[0], box[1], box[2], box[3]),
        visible: true,
        opacity: 100,
        id: layer.nextId++,
        layers: kids
    };
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
        close: function () { this.closed = true; }
    };
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
    MOCK = { noActionManager: false, noVectorMask: false, noSolidColour: false, exports: [], failExport: false };
    AM = { targetIndices: [], layerIdAt: {}, adjustments: {} };
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

WScript.Echo("");
WScript.Echo(passed + " passed, " + failed + " failed.");
WScript.Quit(failed === 0 ? 0 : 1);
