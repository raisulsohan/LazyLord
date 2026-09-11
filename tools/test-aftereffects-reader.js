/*
 * LazyLord — After Effects reader tests (no Node required).
 *
 *   cscript //Nologo tools\test-aftereffects-reader.js
 *
 * Runs the real jsx/ae-read.jsx against a mocked After Effects DOM under
 * Windows Script Host, whose JScript engine is ES3 like ExtendScript.
 *
 * The risk here is different from the Illustrator side: AE and the IR share a
 * y-down space, so there is no flip — but every layer and every nested shape
 * group carries its own anchor/position/scale/rotation, a parented layer sits
 * in its parent's space, and vectors have all of it baked into the geometry
 * while text and footage keep their turn as frame.rotation. These tests pin
 * down that affine chain (parents included), the turned boxes, the parametric
 * rect/ellipse/star generators, curve-tight frames, fill rules and
 * stroke-width scaling — and that the layer stack follows the comp, not the
 * click order, with layers that draw nothing of their own left out.
 *
 * Hierarchy: paint is scoped the way AE scopes it (a Fill or Stroke paints the
 * paths above it in its group, nested groups included), so differently painted
 * groups come out as separate vectors under a group named after the layer,
 * nested with their group opacity; and a selected parent null becomes a group
 * of its selected children, one group per unbroken run of them, so grouping
 * never changes the stack. Paints that cannot be read are reported with what
 * is really sent in their place.
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

// --- Minimal After Effects stand-ins ---------------------------------------
function CompItem() {}
function FootageItem() {}
function SolidSource() {}
function AVLayer() {}
function ShapeLayer() {}
function TextLayer() {}
function CameraLayer() {}

var ParagraphJustification = {
    LEFT_JUSTIFY: "l",
    CENTER_JUSTIFY: "c",
    RIGHT_JUSTIFY: "r",
    FULL_JUSTIFY_LASTLINE_LEFT: "fl"
};

// Enum values are arbitrary non-zero numbers, as in AE, so truthiness bugs show.
var MaskMode = {
    NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815,
    LIGHTEN: 6816, DARKEN: 6817, DIFFERENCE: 6818
};

var TrackMatteType = {
    NO_TRACK_MATTE: 5012, ALPHA: 5013, ALPHA_INVERTED: 5014,
    LUMA: 5015, LUMA_INVERTED: 5016
};

// AE exposes everything as a property tree; one node type covers groups and leaves.
function node(matchName, opts) {
    opts = opts || {};
    var kids = opts.children || [];
    return {
        matchName: matchName,
        name: opts.name || matchName,
        enabled: opts.enabled !== false,
        value: opts.value,
        numProperties: kids.length,
        property: function (key) {
            if (typeof key === "number") return kids[key - 1];
            for (var i = 0; i < kids.length; i++) {
                if (kids[i].matchName === key) return kids[i];
            }
            return null;
        }
    };
}

function transform(position, opts) {
    opts = opts || {};
    return node("ADBE Transform Group", { children: [
        node("ADBE Anchor Point", { value: opts.anchor || [0, 0] }),
        node("ADBE Position", { value: position }),
        node("ADBE Scale", { value: opts.scale || [100, 100] }),
        node("ADBE Rotate Z", { value: opts.rotation || 0 }),
        node("ADBE Opacity", { value: opts.opacity === undefined ? 100 : opts.opacity })
    ]});
}

// Every AVLayer (shape and text layers included) has its switches as real booleans.
function makeLayer(Ctor, name, groups) {
    var l = new Ctor();
    l.name = name;
    l.enabled = true;
    l.threeDLayer = false;
    l.nullLayer = false;
    l.adjustmentLayer = false;
    l.guideLayer = false;
    l.id = 1;
    l.property = function (n) { return groups[n] || null; };
    return l;
}

// `extra` adds more top-level groups, e.g. "ADBE Mask Parade" / "ADBE Effect Parade".
function shapeLayer(name, contents, tform, extra) {
    var groups = {
        "ADBE Transform Group": tform,
        "ADBE Root Vectors Group": node("ADBE Root Vectors Group", { children: contents })
    };
    if (extra) { for (var k in extra) groups[k] = extra[k]; }
    return makeLayer(ShapeLayer, name, groups);
}

// A mask is a property group with its mode and inversion as attributes.
function maskNode(name, vertices, opts) {
    opts = opts || {};
    var zeros = [];
    for (var i = 0; i < vertices.length; i++) zeros.push([0, 0]);
    var shape = {
        vertices: vertices,
        inTangents: opts.inTangents || zeros,
        outTangents: opts.outTangents || zeros,
        closed: opts.closed !== false
    };
    // Variable-width feather points ride on the path value itself.
    if (opts.featherRadii) shape.featherRadii = opts.featherRadii;
    var m = node("ADBE Mask Atom", { name: name, enabled: opts.enabled, children: [
        node("ADBE Mask Shape", { value: shape }),
        node("ADBE Mask Feather", { value: opts.feather || [0, 0] }),
        node("ADBE Mask Opacity", { value: opts.opacity === undefined ? 100 : opts.opacity }),
        node("ADBE Mask Offset", { value: opts.expansion || 0 })
    ]});
    m.maskMode = opts.mode === undefined ? MaskMode.ADD : opts.mode;
    m.inverted = !!opts.inverted;
    return m;
}

function maskParade(masks) { return node("ADBE Mask Parade", { children: masks }); }
function effectParade(fx) { return node("ADBE Effect Parade", { children: fx }); }

// Gradient Ramp. `byIndex` hides the match names so only positional lookup works.
function rampNode(start, startColour, end, endColour, shape, opts) {
    opts = opts || {};
    var mn = opts.byIndex
        ? ["Start of Ramp", "Start Color", "End of Ramp", "End Color", "Ramp Shape", "Ramp Scatter", "Blend With Original"]
        : ["ADBE Ramp-0001", "ADBE Ramp-0002", "ADBE Ramp-0003", "ADBE Ramp-0004", "ADBE Ramp-0005",
           "ADBE Ramp-0006", "ADBE Ramp-0007"];
    return node("ADBE Ramp", { name: "Gradient Ramp", enabled: opts.enabled, children: [
        node(mn[0], { value: start }),
        node(mn[1], { value: startColour }),
        node(mn[2], { value: end }),
        node(mn[3], { value: endColour }),
        node(mn[4], { value: shape || 1 }),
        node(mn[5], { value: 0 }),
        node(mn[6], { value: opts.blend || 0 })
    ]});
}

function rectNode(size, position, roundness) {
    return node("ADBE Vector Shape - Rect", { children: [
        node("ADBE Vector Rect Size", { value: size }),
        node("ADBE Vector Rect Position", { value: position }),
        node("ADBE Vector Rect Roundness", { value: roundness || 0 })
    ]});
}

function ellipseNode(size, position) {
    return node("ADBE Vector Shape - Ellipse", { children: [
        node("ADBE Vector Ellipse Size", { value: size }),
        node("ADBE Vector Ellipse Position", { value: position })
    ]});
}

// AE always has a Fill Rule (1 Non-Zero, its default; 2 Even-Odd); `rule`
// null leaves it out to exercise the unreadable case. `composite` 2 is
// "Above Previous in Same Group" (1, the default, is left out).
function fillNode(rgba, opacity, rule, composite) {
    var kids = [
        node("ADBE Vector Fill Color", { value: rgba }),
        node("ADBE Vector Fill Opacity", { value: opacity === undefined ? 100 : opacity })
    ];
    if (rule !== null) kids.push(node("ADBE Vector Fill Rule", { value: rule === undefined ? 1 : rule }));
    if (composite) kids.push(node("ADBE Vector Composite Order", { value: composite }));
    return node("ADBE Vector Graphic - Fill", { name: "Fill " + (composite ? "above" : "1"), children: kids });
}

function strokeNode(rgba, width, opacity) {
    return node("ADBE Vector Graphic - Stroke", { children: [
        node("ADBE Vector Stroke Color", { value: rgba }),
        node("ADBE Vector Stroke Opacity", { value: opacity === undefined ? 100 : opacity }),
        node("ADBE Vector Stroke Width", { value: width }),
        node("ADBE Vector Stroke Line Cap", { value: 2 }),
        node("ADBE Vector Stroke Line Join", { value: 2 })
    ]});
}

function pathNode(vertices, closed) {
    var ins = [], outs = [];
    for (var i = 0; i < vertices.length; i++) { ins.push([0, 0]); outs.push([0, 0]); }
    return node("ADBE Vector Shape - Group", { children: [
        node("ADBE Vector Shape", { value: {
            vertices: vertices, inTangents: ins, outTangents: outs, closed: !!closed
        }})
    ]});
}

// A drawn path with explicit (relative) tangents, for curves that bulge.
function curvedPathNode(vertices, ins, outs, closed) {
    return node("ADBE Vector Shape - Group", { children: [
        node("ADBE Vector Shape", { value: {
            vertices: vertices, inTangents: ins, outTangents: outs, closed: !!closed
        }})
    ]});
}

// Footage with a file on disk.
function footageLayer(name, w, h, tform) {
    var src = new FootageItem();
    src.file = { exists: true, fsName: "C:\\art\\" + name + ".png" };
    var av = makeLayer(AVLayer, name, { "ADBE Transform Group": tform });
    av.source = src;
    av.width = w;
    av.height = h;
    return av;
}

// A point-text layer whose drawn extent is `rect` in layer space.
function textLayer(name, tform, rect, docOpts) {
    var td = {
        text: "Hi", fontSize: 30, fillColor: [0, 0, 0], applyFill: true,
        fontFamily: "Futura", fontStyle: "Bold", tracking: 0,
        autoLeading: true, justification: ParagraphJustification.LEFT_JUSTIFY, boxText: false
    };
    if (docOpts) { for (var k in docOpts) td[k] = docOpts[k]; }
    var tl = makeLayer(TextLayer, name, {
        "ADBE Transform Group": tform,
        "ADBE Text Properties": node("ADBE Text Properties", { children: [
            node("ADBE Text Document", { value: td })
        ]})
    });
    if (rect) tl.sourceRectAtTime = function () { return rect; };
    return tl;
}

// A shape group; tformOpts.name names it, tformOpts.opacity is its Transform
// opacity (AE always has one, 100 by default).
function vectorGroup(children, tformOpts) {
    tformOpts = tformOpts || {};
    return node("ADBE Vector Group", { name: tformOpts.name, children: [
        node("ADBE Vector Transform Group", { children: [
            node("ADBE Vector Anchor", { value: tformOpts.anchor || [0, 0] }),
            node("ADBE Vector Position", { value: tformOpts.position || [0, 0] }),
            node("ADBE Vector Scale", { value: tformOpts.scale || [100, 100] }),
            node("ADBE Vector Rotation", { value: tformOpts.rotation || 0 }),
            node("ADBE Vector Group Opacity", { value: tformOpts.opacity === undefined ? 100 : tformOpts.opacity })
        ]}),
        node("ADBE Vectors Group", { children: children })
    ]});
}

// A null object: an AVLayer with a solid source and the Null switch on.
function nullLayer(name, tform) {
    var src = new FootageItem();
    src.file = null;
    src.mainSource = new SolidSource();
    src.mainSource.color = [1, 1, 1];
    var n = makeLayer(AVLayer, name, { "ADBE Transform Group": tform });
    n.source = src;
    n.width = 100;
    n.height = 100;
    n.nullLayer = true;
    return n;
}

// Names of a layer list, groups as name[children], for order checks.
function tree(layers) {
    var out = [];
    for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        out.push(l.type === "group" ? l.name + "[" + tree(l.children) + "]" : l.name);
    }
    return out.join(",");
}

// Names of a flat layer list (e.g. LazyLord.flattenLayers), bottom to top.
function names(layers) {
    var out = [];
    for (var i = 0; i < layers.length; i++) out.push(layers[i].name);
    return out.join(",");
}

// Gradient Fill / Stroke: nothing in them can be read as an IR paint.
function gfillNode(name) { return node("ADBE Vector Graphic - G-Fill", { name: name || "Gradient Fill 1", children: [] }); }
function gstrokeNode(name) { return node("ADBE Vector Graphic - G-Stroke", { name: name || "Gradient Stroke 1", children: [] }); }

// A comp whose selection we swap per test. Unless a test sets them, indices
// put the selection bottom to top, as the IR lists layers: AE's index 1 is the
// top layer, so the first layer listed gets the highest index.
var app = { project: { activeItem: null } };
function selectComp(layers) {
    for (var i = 0; i < layers.length; i++) {
        if (layers[i].index === undefined) layers[i].index = layers.length - i;
    }
    var comp = new CompItem();
    comp.name = "Main";
    comp.width = 1920;
    comp.height = 1080;
    comp.time = 0;
    comp.selectedLayers = layers;
    app.project.activeItem = comp;
    return comp;
}

// --- Load the real code (global scope) -------------------------------------
eval(load("json2.js"));
eval(load("lazylord.jsx"));
eval(load("ae.jsx")); // the panel loads the builder too; the live stamp uses its fingerprint
eval(load("ae-read.jsx"));

// --- Assertions ------------------------------------------------------------
var passed = 0, failed = 0;

function ok(name, cond, detail) {
    if (cond) { WScript.Echo("  ok   " + name); passed++; }
    else { WScript.Echo("  FAIL " + name + (detail ? "  -> " + detail : "")); failed++; }
}
function near(a, b, eps) { return Math.abs(a - b) < (eps || 1e-6); }
function xy(p) { return "[" + p[0] + "," + p[1] + "]"; }
function vlist(vs) {
    var out = [];
    for (var i = 0; i < vs.length; i++) out.push(xy(vs[i]));
    return out.join(" ");
}
function sameVerts(vs, expected) {
    if (!vs || vs.length !== expected.length) return false;
    for (var i = 0; i < vs.length; i++) {
        if (!near(vs[i][0], expected[i][0]) || !near(vs[i][1], expected[i][1])) return false;
    }
    return true;
}
// Diagnostics whose reason contains every one of the given fragments.
function diagsWith() {
    var out = [];
    for (var i = 0; i < LazyLord.diagnostics.length; i++) {
        var d = LazyLord.diagnostics[i], all = true;
        for (var a = 0; a < arguments.length; a++) {
            if (d.reason.toLowerCase().indexOf(arguments[a].toLowerCase()) < 0) all = false;
        }
        if (all) out.push(d);
    }
    return out;
}
function allApproximated() {
    for (var i = 0; i < LazyLord.diagnostics.length; i++) {
        if (LazyLord.diagnostics[i].resolution !== "approximated") return false;
    }
    return true;
}

WScript.Echo("LazyLord - After Effects reader (mocked DOM)");
WScript.Echo("");

// 1) A parametric rectangle, offset by the layer transform.
(function () {
    selectComp([shapeLayer("Box", [rectNode([100, 50], [0, 0]), fillNode([1, 0, 0, 1])], transform([200, 300]))]);
    var doc = LazyLord.readSelection("C:\\temp");
    var l = doc.layers[0];

    ok("rect: one vector layer", doc.layers.length === 1 && l.type === "vector", l && l.type);
    ok("rect: comp is the origin space", doc.originSpace === "document", doc.originSpace);
    ok("rect: bounds at (150,275)", near(doc.bounds.x, 150) && near(doc.bounds.y, 275),
       doc.bounds.x + "," + doc.bounds.y);
    ok("rect: 100x50", near(l.frame.width, 100) && near(l.frame.height, 50),
       l.frame.width + "x" + l.frame.height);
    ok("rect: rotation baked out", l.frame.rotation === 0);

    var v = l.subpaths[0].vertices;
    ok("rect: 4 corners, clockwise from top-right",
       v.length === 4 &&
       near(v[0][0], 100) && near(v[0][1], 0) &&
       near(v[1][0], 100) && near(v[1][1], 50) &&
       near(v[2][0], 0) && near(v[2][1], 50) &&
       near(v[3][0], 0) && near(v[3][1], 0), vlist(v));
    ok("rect: closed", l.subpaths[0].closed === true);
    ok("rect: red fill", l.fills.length === 1 && near(l.fills[0].color.r, 1) && near(l.fills[0].color.g, 0),
       JSON.stringify(l.fills));
})();

// 2) A parametric ellipse becomes a 4-point bezier with kappa handles.
(function () {
    selectComp([shapeLayer("Dot", [ellipseNode([100, 100], [0, 0])], transform([200, 300]))]);
    var l = LazyLord.readSelection("C:\\temp").layers[0];
    var sp = l.subpaths[0];
    var K = 0.5522847498307936 * 50;

    ok("ellipse: 4 vertices", sp.vertices.length === 4, vlist(sp.vertices));
    ok("ellipse: top vertex centred", near(sp.vertices[0][0], 50) && near(sp.vertices[0][1], 0), xy(sp.vertices[0]));
    ok("ellipse: kappa out-handle on top vertex", near(sp.outTangents[0][0], K) && near(sp.outTangents[0][1], 0),
       xy(sp.outTangents[0]));
    ok("ellipse: bounds 100x100", near(l.frame.width, 100) && near(l.frame.height, 100),
       l.frame.width + "x" + l.frame.height);
})();

// 3) A nested group transform composes with the layer transform.
(function () {
    var grp = vectorGroup([pathNode([[0, 0], [10, 0]], false), strokeNode([0, 0, 1, 1], 4)], { scale: [200, 200] });
    selectComp([shapeLayer("Nested", [grp], transform([100, 100]))]);
    var doc = LazyLord.readSelection("C:\\temp");
    var l = doc.layers[0];
    var v = l.subpaths[0].vertices;

    ok("nested: group scale doubles the geometry", near(v[1][0], 20) && near(v[1][1], 0), vlist(v));
    ok("nested: placed by the layer transform", near(doc.bounds.x, 100) && near(doc.bounds.y, 100),
       doc.bounds.x + "," + doc.bounds.y);
    ok("nested: stroke width scales with the transform",
       l.strokes.length === 1 && near(l.strokes[0].weight, 8), JSON.stringify(l.strokes));
    ok("nested: round cap read", l.strokes.length === 1 && l.strokes[0].cap === "round");
})();

// 4) Rotation sign: AE turns clockwise, and the IR shares its y-down space.
(function () {
    selectComp([shapeLayer("Turned", [pathNode([[0, 0], [10, 0]], false)], transform([0, 0], { rotation: 90 }))]);
    var doc = LazyLord.readSelection("C:\\temp");
    var v = doc.layers[0].subpaths[0].vertices;
    // (10,0) points right; rotated 90 clockwise it must point down, i.e. +y.
    ok("rotation: 90 deg turns right into down",
       near(doc.bounds.x, 0) && near(doc.bounds.y, 0) && near(v[1][0], 0) && near(v[1][1], 10),
       "bounds " + doc.bounds.x + "," + doc.bounds.y + " verts " + vlist(v));
})();

// 5) Text carries its true baseline rather than an estimate.
(function () {
    var tl = makeLayer(TextLayer, "Title", {
        "ADBE Transform Group": transform([50, 80]),
        "ADBE Text Properties": node("ADBE Text Properties", { children: [
            node("ADBE Text Document", { value: {
                text: "Hi", fontSize: 30, fillColor: [0, 0, 1], applyFill: true,
                fontFamily: "Futura", fontStyle: "Bold", tracking: 100,
                autoLeading: true, justification: ParagraphJustification.LEFT_JUSTIFY,
                boxText: false
            }})
        ]})
    });
    tl.sourceRectAtTime = function () { return { left: 0, top: -24, width: 40, height: 30 }; };

    selectComp([tl]);
    var l = LazyLord.readSelection("C:\\temp").layers[0];

    ok("text: layer type", l.type === "text", l.type);
    ok("text: contents", l.characters === "Hi", l.characters);
    ok("text: font family and style", l.fontFamily === "Futura" && l.fontStyle === "Bold",
       l.fontFamily + "/" + l.fontStyle);
    ok("text: baseline 24 below the box top", near(l.baseline, 24), String(l.baseline));
    ok("text: anchorX at the box left", near(l.anchorX, 0), String(l.anchorX));
    ok("text: tracking converted to px", near(l.letterSpacing, 3), String(l.letterSpacing));
    ok("text: blue fill", near(l.color.b, 1) && near(l.color.r, 0), JSON.stringify(l.color));
})();

// 6) A solid layer has no file, but it is just a coloured rectangle.
(function () {
    var src = new FootageItem();
    src.file = null;
    src.mainSource = new SolidSource();
    src.mainSource.color = [1, 0, 0];

    var av = makeLayer(AVLayer, "Red Solid", { "ADBE Transform Group": transform([0, 0]) });
    av.source = src;
    av.width = 100;
    av.height = 50;

    selectComp([av]);
    var l = LazyLord.readSelection("C:\\temp").layers[0];

    ok("solid: becomes a filled vector", l.type === "vector", l.type);
    ok("solid: rectangle covers the layer", near(l.frame.width, 100) && near(l.frame.height, 50),
       l.frame.width + "x" + l.frame.height);
    ok("solid: keeps its colour", l.fills.length === 1 && near(l.fills[0].color.r, 1), JSON.stringify(l.fills));
})();

// 7) Two layers normalise against their shared top-left.
(function () {
    selectComp([
        shapeLayer("A", [rectNode([100, 100], [0, 0])], transform([100, 100])),
        shapeLayer("B", [rectNode([100, 100], [0, 0])], transform([300, 100]))
    ]);
    var doc = LazyLord.readSelection("C:\\temp");

    ok("multi: two layers", doc.layers.length === 2, String(doc.layers.length));
    ok("multi: bounds start at the left-most edge", near(doc.bounds.x, 50) && near(doc.bounds.y, 50),
       doc.bounds.x + "," + doc.bounds.y);
    ok("multi: first layer normalised to 0,0",
       near(doc.layers[0].frame.x, 0) && near(doc.layers[0].frame.y, 0),
       doc.layers[0].frame.x + "," + doc.layers[0].frame.y);
    ok("multi: second layer offset by 200", near(doc.layers[1].frame.x, 200), String(doc.layers[1].frame.x));
    ok("multi: bounds span both", near(doc.bounds.width, 300), String(doc.bounds.width));
})();

// 8) Precomps are reported rather than silently dropped.
(function () {
    LazyLord.resetDiagnostics();
    var av = makeLayer(AVLayer, "Inner comp", { "ADBE Transform Group": transform([0, 0]) });
    av.source = new CompItem();
    av.width = 10; av.height = 10;

    selectComp([av]);
    var threw = false;
    try { LazyLord.readSelection("C:\\temp"); } catch (e) { threw = true; }

    ok("precomp: nothing transferable is an error", threw);
    ok("precomp: reported as skipped",
       LazyLord.diagnostics.length === 1 && LazyLord.diagnostics[0].resolution === "skipped",
       JSON.stringify(LazyLord.diagnostics));
})();

// 9) Add masks on a moved, turned shape layer become a clip in FRAME space.
(function () {
    LazyLord.resetDiagnostics();
    // Layer turned 90 deg clockwise and moved to (200,300): (x,y) -> (200 - y, 300 + x).
    var masked = shapeLayer("Masked", [rectNode([100, 100], [0, 0])],
        transform([200, 300], { rotation: 90 }), {
        "ADBE Mask Parade": maskParade([
            maskNode("Window", [[0, 0], [40, 0], [40, 10], [0, 10]],
                     { outTangents: [[10, 0], [0, 0], [0, 0], [0, 0]] }),
            maskNode("Off", [[0, 0], [5, 0], [5, 5]], { mode: MaskMode.NONE }),
            // Drawn counter-clockwise: must be turned round so nonzero unions it.
            maskNode("Second", [[-40, -40], [-40, -30], [-30, -30], [-30, -40]])
        ])
    });
    masked.id = 7;
    // A second layer further up-left moves the selection's top-left to (40,40).
    var other = shapeLayer("Anchor", [rectNode([20, 20], [0, 0])], transform([50, 50]));
    other.id = 8;

    selectComp([masked, other]);
    var doc = LazyLord.readSelection("C:\\temp");
    var l = doc.layers[0];
    var clip = l.clip;

    ok("mask: bounds come from geometry only",
       near(doc.bounds.x, 40) && near(doc.bounds.y, 40) && near(doc.bounds.width, 210) && near(doc.bounds.height, 310),
       JSON.stringify(doc.bounds));
    ok("mask: masked layer frame at (110,210)", near(l.frame.x, 110) && near(l.frame.y, 210),
       l.frame.x + "," + l.frame.y);
    ok("mask: clip present", !!clip, JSON.stringify(l));
    if (!clip) return;
    ok("mask: clip id from the layer id", clip.id === "ae-mask-7", clip.id);
    ok("mask: clip named after the first mask", clip.name === "Window", clip.name);
    ok("mask: nonzero union", clip.windingRule === "nonzero", clip.windingRule);
    ok("mask: None-mode mask ignored, two Add masks kept", clip.subpaths.length === 2, String(clip.subpaths.length));
    ok("mask: vertices turned, moved and in frame space (minus selection top-left, not layer box)",
       sameVerts(clip.subpaths[0].vertices, [[160, 260], [160, 300], [150, 300], [150, 260]]),
       vlist(clip.subpaths[0].vertices));
    ok("mask: tangents turn with the layer",
       near(clip.subpaths[0].outTangents[0][0], 0) && near(clip.subpaths[0].outTangents[0][1], 10),
       xy(clip.subpaths[0].outTangents[0]));
    ok("mask: closed", clip.subpaths[0].closed === true);
    ok("mask: counter-clockwise mask reversed to match",
       sameVerts(clip.subpaths[1].vertices, [[200, 230], [190, 230], [190, 220], [200, 220]]),
       vlist(clip.subpaths[1].vertices));
    ok("mask: unmasked layer has no clip", doc.layers[1].clip === undefined);
    ok("mask: clean Add masks raise nothing", LazyLord.diagnostics.length === 0,
       JSON.stringify(LazyLord.diagnostics));

    // The shared placement helper shifts clip vertices; nothing may be shared.
    LazyLord.applyOrigin(doc);
    ok("mask: applyOrigin moves the clip back to comp space",
       near(clip.subpaths[0].vertices[0][0], 200) && near(clip.subpaths[0].vertices[0][1], 300),
       xy(clip.subpaths[0].vertices[0]));
})();

// 10) What a hard clip cannot express is reported, naming the mask.
(function () {
    LazyLord.resetDiagnostics();
    var sq = [[-50, -50], [50, -50], [50, 50], [-50, 50]];
    var small = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    var lossy = shapeLayer("Cutout", [rectNode([100, 100], [0, 0])], transform([100, 100]), {
        "ADBE Mask Parade": maskParade([
            maskNode("Keep", sq),
            maskNode("Hole", small, { mode: MaskMode.SUBTRACT }),
            maskNode("Flipped", small, { inverted: true }),
            maskNode("Soft", small, { feather: [5, 5], opacity: 50, expansion: 3 })
        ])
    });
    lossy.id = 3;
    var onlySub = shapeLayer("Punched", [rectNode([100, 100], [0, 0])], transform([300, 100]), {
        "ADBE Mask Parade": maskParade([maskNode("Punch", small, { mode: MaskMode.SUBTRACT })])
    });
    onlySub.id = 4;

    selectComp([lossy, onlySub]);
    var doc = LazyLord.readSelection("C:\\temp");
    var l = doc.layers[0];

    ok("mask loss: subtract warns, naming the mask", diagsWith("'Hole'", "Subtract").length === 1,
       JSON.stringify(LazyLord.diagnostics));
    ok("mask loss: inverted warns", diagsWith("'Flipped'", "inverted").length === 1);
    ok("mask loss: feather warns", diagsWith("'Soft'", "feather").length === 1);
    ok("mask loss: expansion warns", diagsWith("'Soft'", "expansion").length === 1);
    ok("mask loss: mask opacity warns", diagsWith("'Soft'", "50% opacity").length === 1);
    ok("mask loss: every one approximated, six in all",
       allApproximated() && LazyLord.diagnostics.length === 6, JSON.stringify(LazyLord.diagnostics));
    ok("mask loss: warnings name the layer", diagsWith("'Hole'")[0].object === "Cutout");
    ok("mask loss: the Add masks still clip (Keep + Soft)", l.clip && l.clip.subpaths.length === 2,
       l.clip && String(l.clip.subpaths.length));
    ok("mask loss: subtract-only layer has no clip but is still sent",
       doc.layers.length === 2 && doc.layers[1].clip === undefined);
    ok("mask loss: its subtract mask is reported too", diagsWith("'Punch'", "Subtract").length === 1);
})();

// 11) Masks work on any layer type — here a solid.
(function () {
    LazyLord.resetDiagnostics();
    var src = new FootageItem();
    src.file = null;
    src.mainSource = new SolidSource();
    src.mainSource.color = [0, 1, 0];
    var av = makeLayer(AVLayer, "Masked solid", {
        "ADBE Transform Group": transform([30, 20]),
        "ADBE Mask Parade": maskParade([maskNode("Inset", [[10, 10], [90, 10], [90, 40], [10, 40]])])
    });
    av.id = 12;
    av.source = src;
    av.width = 100;
    av.height = 50;

    selectComp([av]);
    var l = LazyLord.readSelection("C:\\temp").layers[0];
    ok("solid mask: clip on a non-shape layer", l.clip && l.clip.id === "ae-mask-12",
       l.clip && l.clip.id);
    ok("solid mask: vertices in frame space",
       l.clip && sameVerts(l.clip.subpaths[0].vertices, [[10, 10], [90, 10], [90, 40], [10, 40]]),
       l.clip && vlist(l.clip.subpaths[0].vertices));
})();

// 12) Track mattes cannot be carried and say so — old and 2023+ APIs.
(function () {
    LazyLord.resetDiagnostics();
    var legacy = shapeLayer("Matted", [rectNode([10, 10], [0, 0])], transform([0, 0]));
    legacy.trackMatteType = TrackMatteType.ALPHA;
    legacy.index = 2;
    var modern = shapeLayer("Matted 2023", [rectNode([10, 10], [0, 0])], transform([50, 0]));
    modern.hasTrackMatte = true;
    modern.trackMatteLayer = { name: "Logo matte" };
    var plain = shapeLayer("Plain", [rectNode([10, 10], [0, 0])], transform([100, 0]));
    plain.trackMatteType = TrackMatteType.NO_TRACK_MATTE;
    plain.hasTrackMatte = false;
    // AE 23+ removeTrackMatte(): the layer is unmatted but keeps its type.
    var removed = shapeLayer("Unmatted 2023", [rectNode([10, 10], [0, 0])], transform([150, 0]));
    removed.trackMatteLayer = null;
    removed.hasTrackMatte = false;
    removed.trackMatteType = TrackMatteType.ALPHA;
    removed.index = 2;

    var comp = selectComp([legacy, modern, plain, removed]);
    comp.layer = function (i) { return i === 1 ? { name: "Matte above" } : null; };
    var doc = LazyLord.readSelection("C:\\temp");

    ok("matte: every layer still sent", doc.layers.length === 4, String(doc.layers.length));
    var removedReports = 0;
    for (var r = 0; r < LazyLord.diagnostics.length; r++) {
        if (LazyLord.diagnostics[r].object === "Unmatted 2023") removedReports++;
    }
    ok("matte: a 2023+ matte that was removed is not reported (type kept, no matte layer)",
       removedReports === 0 && diagsWith("track matte", "Matte above").length === 1,
       JSON.stringify(LazyLord.diagnostics));
    ok("matte: pre-2023 matte names the layer above", diagsWith("track matte", "Matte above").length === 1,
       JSON.stringify(LazyLord.diagnostics));
    ok("matte: 2023+ trackMatteLayer named", diagsWith("track matte", "Logo matte").length === 1);
    ok("matte: no matte, no warning; the two approximated",
       LazyLord.diagnostics.length === 2 && allApproximated(), JSON.stringify(LazyLord.diagnostics));
})();

// 13) A Gradient Ramp reads back as a gradient. Shape layers are continuously
//     rasterised, so AE applies effects after the transform: the ramp's points
//     are comp space and must NOT go through the layer matrix.
(function () {
    LazyLord.resetDiagnostics();
    // 100x50 rect turned 90 deg at (200,300): comp box x 175..225, y 250..350.
    // Through the matrix, (200,250) would land at (-50,500), far off the box.
    var turned = shapeLayer("Ramped", [rectNode([100, 50], [0, 0]), fillNode([1, 0, 0, 1])],
        transform([200, 300], { rotation: 90 }), {
        "ADBE Effect Parade": effectParade([
            rampNode([200, 250], [1, 0, 0, 1], [200, 350], [0, 0, 1, 1], 1)
        ])
    });
    selectComp([turned]);
    var doc = LazyLord.readSelection("C:\\temp");
    var l = doc.layers[0];
    var p = l.fills[0];

    ok("ramp: 50x100 box", near(l.frame.width, 50) && near(l.frame.height, 100),
       l.frame.width + "x" + l.frame.height);
    ok("ramp: replaces the flat fill", l.fills.length === 1 && p.type === "linear-gradient",
       JSON.stringify(l.fills));
    ok("ramp: start normalised to (0.5,0)", near(p.from.x, 0.5) && near(p.from.y, 0),
       JSON.stringify(p.from));
    ok("ramp: end normalised to (0.5,1)", near(p.to.x, 0.5) && near(p.to.y, 1), JSON.stringify(p.to));
    ok("ramp: two stops, red to blue",
       p.stops.length === 2 && p.stops[0].position === 0 && p.stops[1].position === 1 &&
       near(p.stops[0].color.r, 1) && near(p.stops[1].color.b, 1) && near(p.stops[1].color.a, 1),
       JSON.stringify(p.stops));
    ok("ramp: no private fields leak into the IR", JSON.stringify(doc).indexOf("_aer") < 0);
    ok("ramp: nothing reported", LazyLord.diagnostics.length === 0, JSON.stringify(LazyLord.diagnostics));
    ok("ramp: canvas matches the comp",
       doc.canvas && doc.canvas.width === 1920 && doc.canvas.height === 1080 && doc.canvas.name === "Main",
       JSON.stringify(doc.canvas));
})();

// 14) Radial ramp read by parameter position; disabled ramps and real G-Fills.
(function () {
    LazyLord.resetDiagnostics();
    // Comp-space points: the box is x 50..150, y 50..150.
    var radial = shapeLayer("Glow", [rectNode([100, 100], [0, 0]), fillNode([1, 1, 1, 1])], transform([100, 100]), {
        "ADBE Effect Parade": effectParade([
            rampNode([100, 100], [1, 1, 1, 1], [150, 100], [0, 0, 0, 1], 2, { byIndex: true })
        ])
    });
    var off = shapeLayer("Off ramp", [rectNode([100, 100], [0, 0]), fillNode([0, 1, 0, 1])], transform([300, 100]), {
        "ADBE Effect Parade": effectParade([
            rampNode([0, 0], [1, 1, 1, 1], [50, 0], [0, 0, 0, 1], 1, { enabled: false })
        ])
    });
    var gfill = shapeLayer("Real gradient", [rectNode([100, 100], [0, 0]),
        node("ADBE Vector Graphic - G-Fill", { children: [] })], transform([500, 100]));

    selectComp([radial, off, gfill]);
    var doc = LazyLord.readSelection("C:\\temp");
    var p = doc.layers[0].fills[0];

    ok("radial ramp: type from Ramp Shape 2", p && p.type === "radial-gradient", JSON.stringify(p));
    ok("radial ramp: centre at the box centre", near(p.from.x, 0.5) && near(p.from.y, 0.5), JSON.stringify(p.from));
    ok("radial ramp: edge point at the right", near(p.to.x, 1) && near(p.to.y, 0.5), JSON.stringify(p.to));
    ok("radial ramp: radius 50 px via the shared helper",
       near(LazyLord.gradientPx(doc.layers[0], p).radius, 50), String(LazyLord.gradientPx(doc.layers[0], p).radius));
    ok("disabled ramp: flat fill kept",
       doc.layers[1].fills.length === 1 && doc.layers[1].fills[0].type === "solid",
       JSON.stringify(doc.layers[1].fills));
    ok("G-Fill: still reported as unreadable",
       diagsWith("Gradient fills cannot be read").length === 1 &&
       diagsWith("Gradient fills cannot be read")[0].object === "Real gradient",
       JSON.stringify(LazyLord.diagnostics));
})();

// 15) A gradient-ramp solid (the classic AE background) becomes a gradient rect.
(function () {
    LazyLord.resetDiagnostics();
    var src = new FootageItem();
    src.file = null;
    src.mainSource = new SolidSource();
    src.mainSource.color = [0, 0, 0];
    var av = makeLayer(AVLayer, "Backdrop", {
        "ADBE Transform Group": transform([0, 0]),
        "ADBE Effect Parade": effectParade([rampNode([0, 25], [1, 0, 0, 1], [100, 25], [0, 0, 1, 1], 1)])
    });
    av.source = src;
    av.width = 100;
    av.height = 50;

    selectComp([av]);
    var p = LazyLord.readSelection("C:\\temp").layers[0].fills[0];
    ok("solid ramp: left to right across the middle",
       p.type === "linear-gradient" && near(p.from.x, 0) && near(p.from.y, 0.5) &&
       near(p.to.x, 1) && near(p.to.y, 0.5), JSON.stringify(p));
})();

// 16) A ramp recolours what the layer paints, each at that paint's own opacity.
(function () {
    LazyLord.resetDiagnostics();
    function rampFx(x0, x1, y) {
        return effectParade([rampNode([x0, y], [1, 0, 0, 1], [x1, y], [0, 0, 1, 1], 1)]);
    }
    // Half-transparent fill: where LazyLord's AE builder puts a gradient's alpha.
    var half = shapeLayer("Half", [rectNode([100, 100], [0, 0]), fillNode([1, 1, 1, 1], 50)],
        transform([100, 100]), { "ADBE Effect Parade": rampFx(50, 150, 100) });
    // An open line with only a stroke: AE colours the stroke and there is no fill.
    var line = shapeLayer("Line", [pathNode([[0, 0], [100, 0]], false), strokeNode([1, 1, 1, 1], 4)],
        transform([100, 500]), { "ADBE Effect Parade": rampFx(100, 200, 500) });
    // Fill and stroke: the ramp covers both.
    var both = shapeLayer("Both", [rectNode([100, 100], [0, 0]), fillNode([0, 1, 0, 1]),
        strokeNode([1, 1, 1, 1], 2, 80)], transform([400, 100]), { "ADBE Effect Parade": rampFx(350, 450, 100) });

    selectComp([half, line, both]);
    var doc = LazyLord.readSelection("C:\\temp");
    var h = doc.layers[0].fills[0], ln = doc.layers[1], b = doc.layers[2];

    ok("ramp alpha: fill opacity carried onto every stop",
       h.type === "linear-gradient" && near(h.stops[0].color.a, 0.5) && near(h.stops[1].color.a, 0.5),
       JSON.stringify(h.stops));
    ok("ramp alpha: handles still across the box", near(h.from.x, 0) && near(h.from.y, 0.5) &&
       near(h.to.x, 1) && near(h.to.y, 0.5), JSON.stringify(h));
    ok("stroke-only ramp: no fill is invented", ln.fills.length === 0, JSON.stringify(ln.fills));
    ok("stroke-only ramp: the stroke takes the gradient, boxed like a fill",
       ln.strokes.length === 1 && ln.strokes[0].paint.type === "linear-gradient" &&
       near(ln.strokes[0].paint.from.x, 0) && near(ln.strokes[0].paint.to.x, 1) && near(ln.strokes[0].weight, 4),
       JSON.stringify(ln.strokes));
    ok("fill and stroke: both recoloured, each at its own opacity",
       b.fills[0].type === "linear-gradient" && near(b.fills[0].stops[1].color.a, 1) &&
       b.strokes[0].paint.type === "linear-gradient" && near(b.strokes[0].paint.stops[0].color.a, 0.8) &&
       near(b.strokes[0].paint.from.x, 0) && near(b.strokes[0].paint.to.x, 1),
       JSON.stringify(b.fills) + " " + JSON.stringify(b.strokes));
    ok("fill and stroke: separate stop objects", b.fills[0].stops[0] !== b.strokes[0].paint.stops[0]);
    ok("ramp paints: no private fields leak", JSON.stringify(doc).indexOf("_aer") < 0);
    ok("ramp paints: nothing reported", LazyLord.diagnostics.length === 0, JSON.stringify(LazyLord.diagnostics));
})();

// 17) Ramps AE does not show keep the flat fill: fx switch off, fully blended.
(function () {
    LazyLord.resetDiagnostics();
    function rampLayer(name, x, opts) {
        return shapeLayer(name, [rectNode([100, 100], [0, 0]), fillNode([0, 1, 0, 1])], transform([x, 100]), {
            "ADBE Effect Parade": effectParade([
                rampNode([x - 50, 100], [1, 0, 0, 1], [x + 50, 100], [0, 0, 1, 1], 1, opts)
            ])
        });
    }
    var fxOff = rampLayer("Effects off", 100);
    fxOff.effectsActive = false;
    var blended = rampLayer("Blended away", 300, { blend: 100 });
    var partly = rampLayer("Partly blended", 500, { blend: 40 });

    selectComp([fxOff, blended, partly]);
    var doc = LazyLord.readSelection("C:\\temp");
    function flatGreen(l) { return l.fills.length === 1 && l.fills[0].type === "solid" && near(l.fills[0].color.g, 1); }

    ok("fx switch off: flat fill kept", flatGreen(doc.layers[0]), JSON.stringify(doc.layers[0].fills));
    ok("blend 100%: flat fill kept", flatGreen(doc.layers[1]), JSON.stringify(doc.layers[1].fills));
    ok("blend 40%: the ramp is still sent", doc.layers[2].fills[0].type === "linear-gradient",
       JSON.stringify(doc.layers[2].fills));
    ok("blend: only the partial blend is reported",
       LazyLord.diagnostics.length === 1 && diagsWith("40%").length === 1 &&
       diagsWith("40%")[0].object === "Partly blended", JSON.stringify(LazyLord.diagnostics));
})();

// 18) A solid's ramp lives in layer pixels: through rotation, uneven scale, radial.
(function () {
    LazyLord.resetDiagnostics();
    function solid(name, w, h, tform, fx) {
        var src = new FootageItem();
        src.file = null;
        src.mainSource = new SolidSource();
        src.mainSource.color = [0, 0, 0];
        var av = makeLayer(AVLayer, name, { "ADBE Transform Group": tform, "ADBE Effect Parade": effectParade(fx) });
        av.source = src;
        av.width = w;
        av.height = h;
        return av;
    }
    // Scaled 200% x 100%: AE's ramp is 0.5 at layer (100,0) = comp (200,0).
    var stretched = solid("Stretched", 100, 100, transform([0, 0], { scale: [200, 100] }),
        [rampNode([0, 0], [1, 0, 0, 1], [100, 100], [0, 0, 1, 1], 1)]);
    // Turned 90 about its centre: comp box x 175..225, y 250..350.
    var turned = solid("Turned", 100, 50, transform([200, 300], { anchor: [50, 25], rotation: 90 }),
        [rampNode([0, 25], [1, 0, 0, 1], [100, 25], [0, 0, 1, 1], 1)]);
    // A radial ramp under the same uneven scale is an ellipse in AE.
    var oval = solid("Oval", 100, 100, transform([600, 0], { scale: [200, 100] }),
        [rampNode([50, 50], [1, 1, 1, 1], [100, 50], [0, 0, 0, 1], 2)]);

    selectComp([stretched, turned, oval]);
    var doc = LazyLord.readSelection("C:\\temp");
    var s = doc.layers[0], p = s.fills[0];
    var g = LazyLord.gradientPx(s, p);
    var t = ((200 - g.from[0]) * (g.to[0] - g.from[0]) + (0 - g.from[1]) * (g.to[1] - g.from[1])) /
            (g.radius * g.radius);

    ok("uneven scale: start at the corner", near(p.from.x, 0) && near(p.from.y, 0), JSON.stringify(p.from));
    ok("uneven scale: end rebuilt from the gradient direction (0.4,1.6)",
       near(p.to.x, 0.4) && near(p.to.y, 1.6), JSON.stringify(p.to));
    ok("uneven scale: comp (200,0) sits halfway, as in AE", near(t, 0.5), String(t));

    var q = doc.layers[1].fills[0];
    ok("turned solid: 50x100 box", near(doc.layers[1].frame.width, 50) && near(doc.layers[1].frame.height, 100),
       doc.layers[1].frame.width + "x" + doc.layers[1].frame.height);
    ok("turned solid: ramp turns with it, top to bottom",
       near(q.from.x, 0.5) && near(q.from.y, 0) && near(q.to.x, 0.5) && near(q.to.y, 1), JSON.stringify(q));

    var o = doc.layers[2].fills[0];
    ok("oval: centre at the box centre", near(o.from.x, 0.5) && near(o.from.y, 0.5), JSON.stringify(o.from));
    ok("oval: circle of the same area (radius 50 * sqrt 2)",
       near(LazyLord.gradientPx(doc.layers[2], o).radius, 50 * Math.SQRT2),
       String(LazyLord.gradientPx(doc.layers[2], o).radius));
    ok("oval: the stretch is reported, and nothing else",
       LazyLord.diagnostics.length === 1 && diagsWith("ellipse").length === 1 &&
       diagsWith("ellipse")[0].object === "Oval" && allApproximated(), JSON.stringify(LazyLord.diagnostics));
})();

// 19) Add + Difference stacks (what LazyLord's AE builder writes) and stacks
//     that start from the whole layer.
(function () {
    LazyLord.resetDiagnostics();
    var outer = [[-50, -50], [50, -50], [50, 50], [-50, 50]];     // clockwise on screen
    var inner = [[-20, -20], [20, -20], [20, 20], [-20, 20]];     // clockwise too
    var islandCW = [[60, -10], [80, -10], [80, 10], [60, 10]];
    var islandCCW = [[60, -10], [60, 10], [80, 10], [80, -10]];
    function masked(name, x, masks) {
        return shapeLayer(name, [rectNode([200, 200], [0, 0])], transform([x, 300]),
            { "ADBE Mask Parade": maskParade(masks) });
    }
    // Even-odd: one Add, then Differences only — a hole and a second island.
    var donut = masked("Donut", 200, [
        maskNode("Ring", outer),
        maskNode("Ring 2", inner, { mode: MaskMode.DIFFERENCE }),
        maskNode("Ring 3", islandCW, { mode: MaskMode.DIFFERENCE })
    ]);
    // Nonzero: Add, an opposite-wound hole as Difference, then an Add island.
    var nz = masked("Nonzero", 600, [
        maskNode("Shape", outer),
        maskNode("Shape 2", inner, { mode: MaskMode.DIFFERENCE }),
        maskNode("Shape 3", islandCCW)
    ]);
    var holeFirst = masked("Hole first", 1000, [
        maskNode("Hole", inner, { mode: MaskMode.SUBTRACT }),
        maskNode("Frame", outer)
    ]);
    var flipFirst = masked("Inverted first", 1400, [
        maskNode("Flip", inner, { inverted: true }),
        maskNode("Frame", outer)
    ]);
    var invDiff = masked("Inverted difference", 1800, [
        maskNode("Keep", outer),
        maskNode("Odd", inner, { mode: MaskMode.DIFFERENCE, inverted: true })
    ]);

    selectComp([donut, nz, holeFirst, flipFirst, invDiff]);
    var doc = LazyLord.readSelection("C:\\temp");
    var area = LazyLord._aer_signedArea;

    var d = doc.layers[0].clip;
    ok("add+difference: every contour kept", d && d.subpaths.length === 3, d && String(d.subpaths.length));
    ok("add+difference: even-odd", d && d.windingRule === "evenodd", d && d.windingRule);
    ok("add+difference: orientation left alone",
       d && area(d.subpaths[0]) > 0 && area(d.subpaths[1]) > 0 && area(d.subpaths[2]) > 0);
    ok("add+difference: named after the Add", d && d.name === "Ring", d && d.name);

    var n = doc.layers[1].clip;
    ok("mixed add/difference: nonzero, all three contours",
       n && n.windingRule === "nonzero" && n.subpaths.length === 3, n && JSON.stringify(n.windingRule));
    ok("mixed add/difference: Adds one way, the Difference hole the other",
       n && area(n.subpaths[0]) > 0 && area(n.subpaths[1]) < 0 && area(n.subpaths[2]) > 0,
       n && (area(n.subpaths[0]) + " " + area(n.subpaths[1]) + " " + area(n.subpaths[2])));

    ok("subtract first: not clipped to the Add alone", doc.layers[2].clip === undefined);
    ok("subtract first: one warning naming the leading mask",
       diagsWith("'Hole'", "whole layer").length === 1 && diagsWith("'Hole'", "whole layer")[0].object === "Hole first",
       JSON.stringify(LazyLord.diagnostics));
    ok("inverted first: not clipped either", doc.layers[3].clip === undefined);
    ok("inverted first: reported", diagsWith("'Flip'", "inverted", "whole layer").length === 1);
    ok("inverted difference: dropped, the Add still clips",
       doc.layers[4].clip && doc.layers[4].clip.subpaths.length === 1 && diagsWith("'Odd'", "inverted").length === 1);
    ok("mask stacks: exactly those three reports, all approximated",
       LazyLord.diagnostics.length === 3 && allApproximated(), JSON.stringify(LazyLord.diagnostics));
})();

// 20) Variable-width feather points (the Mask Feather tool) are reported.
(function () {
    LazyLord.resetDiagnostics();
    var sq = [[-50, -50], [50, -50], [50, 50], [-50, 50]];
    var l = shapeLayer("Feathered", [rectNode([100, 100], [0, 0])], transform([100, 100]), {
        "ADBE Mask Parade": maskParade([
            maskNode("Outer soft", sq, { featherRadii: [0, 8] }),
            maskNode("Inner soft", sq, { featherRadii: [-4] }),
            maskNode("Flat points", sq, { featherRadii: [0, 0] })
        ])
    });
    selectComp([l]);
    var doc = LazyLord.readSelection("C:\\temp");

    ok("feather points: the clip is still sent", doc.layers[0].clip && doc.layers[0].clip.subpaths.length === 3);
    ok("feather points: outer points reported", diagsWith("'Outer soft'", "variable feather points").length === 1,
       JSON.stringify(LazyLord.diagnostics));
    ok("feather points: inner (negative) points reported", diagsWith("'Inner soft'", "feather").length === 1);
    ok("feather points: zero-radius points are not", diagsWith("'Flat points'").length === 0);
    ok("feather points: two reports, approximated",
       LazyLord.diagnostics.length === 2 && allApproximated(), JSON.stringify(LazyLord.diagnostics));
})();

// 21) Rotated footage keeps its turn: the unrotated box, centred on M * centre.
//     Before, it was read as its turned 111.6x93.3 box at rotation 0.
(function () {
    LazyLord.resetDiagnostics();
    var av = footageLayer("Photo", 100, 50, transform([500, 300], { anchor: [50, 25], rotation: 30 }));
    selectComp([av]);
    var doc = LazyLord.readSelection("C:\\temp");
    var l = doc.layers[0];
    var c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);

    ok("rotated footage: the user's own file", l.type === "image" && l.isOriginalFile === true, l.type);
    ok("rotated footage: rotation 30 carried", near(l.frame.rotation, 30), String(l.frame.rotation));
    ok("rotated footage: unrotated 100x50 box",
       near(l.frame.width, 100) && near(l.frame.height, 50), l.frame.width + "x" + l.frame.height);
    ok("rotated footage: selection bounds are the turned box",
       near(doc.bounds.x, 500 - 50 * c30 - 25 * s30) && near(doc.bounds.y, 300 - 50 * s30 - 25 * c30) &&
       near(doc.bounds.width, 100 * c30 + 50 * s30) && near(doc.bounds.height, 100 * s30 + 50 * c30),
       JSON.stringify(doc.bounds));
    LazyLord.applyOrigin(doc);
    ok("rotated footage: box centred on the layer's centre (500,300)",
       near(l.frame.x, 450) && near(l.frame.y, 275), l.frame.x + "," + l.frame.y);
    // The IR box's top-left, turned about its centre, is AE's layer (0,0).
    var tl = LazyLord.rotatePoint([l.frame.x, l.frame.y], LazyLord.frameCenter(l.frame), l.frame.rotation);
    var ae = [500 - 50 * c30 + 25 * s30, 300 - 50 * s30 - 25 * c30];
    ok("rotated footage: the turned IR corner lands on AE's corner",
       near(tl[0], ae[0]) && near(tl[1], ae[1]), xy(tl) + " vs " + xy(ae));
    ok("rotated footage: native, nothing reported", LazyLord.diagnostics.length === 0,
       JSON.stringify(LazyLord.diagnostics));
})();

// 22) Rotated text keeps its turn; its baseline anchor is stored unturned
//     about the box centre, so rotatedTextAnchor gives AE's origin back.
(function () {
    LazyLord.resetDiagnostics();
    // Turned 90 at (300,200): layer (x,y) -> (300 - y, 200 + x).
    var t = textLayer("Turned title", transform([300, 200], { rotation: 90 }),
                      { left: 0, top: -24, width: 40, height: 30 });
    selectComp([t]);
    var doc = LazyLord.readSelection("C:\\temp");
    var l = doc.layers[0];

    ok("rotated text: rotation 90 carried", near(l.frame.rotation, 90), String(l.frame.rotation));
    ok("rotated text: selection bounds are the turned box (30x40 at 294,200)",
       near(doc.bounds.x, 294) && near(doc.bounds.y, 200) && near(doc.bounds.width, 30) &&
       near(doc.bounds.height, 40), JSON.stringify(doc.bounds));
    ok("rotated text: unrotated 40x30 box", near(l.frame.width, 40) && near(l.frame.height, 30),
       l.frame.width + "x" + l.frame.height);
    LazyLord.applyOrigin(doc);
    ok("rotated text: box centred on M * rect centre (309,220)",
       near(l.frame.x, 289) && near(l.frame.y, 205), l.frame.x + "," + l.frame.y);
    ok("rotated text: anchor stored unturned, at the box left and 24 below its top",
       near(l.anchorX, 289) && near(l.baseline, 229), l.anchorX + "," + l.baseline);
    var ra = LazyLord.rotatedTextAnchor(l);
    ok("rotated text: rotatedTextAnchor gives back AE's baseline origin (300,200)",
       near(ra[0], 300) && near(ra[1], 200), xy(ra));
    ok("rotated text: font size unchanged by a pure turn", near(l.fontSize, 30), String(l.fontSize));
    ok("rotated text: native, nothing reported", LazyLord.diagnostics.length === 0,
       JSON.stringify(LazyLord.diagnostics));
})();

// 23) What a turned box cannot hold is reported: stretched text, mirrors, skew.
//     A mirror is dropped along whichever axis leaves the layer nearest
//     upright (as the Illustrator reader does), in the box AE shows.
(function () {
    LazyLord.resetDiagnostics();
    var rect = { left: 0, top: -24, width: 40, height: 30 };
    var stretched = textLayer("Stretched text", transform([100, 100], { scale: [200, 100] }), rect);
    // Mirrored along x: layer (x,y) -> (400 - x, 100 + y), so its glyphs run leftwards from (400,100).
    var mirrored = textLayer("Mirrored text", transform([400, 100], { scale: [-100, 100] }), rect);
    var wide = footageLayer("Wide photo", 100, 50, transform([700, 100], { scale: [200, 100] }));
    // A turned child under an unevenly scaled parent is skewed.
    var squash = makeLayer(AVLayer, "Squash", { "ADBE Transform Group": transform([0, 0], { scale: [200, 100] }) });
    var skewed = footageLayer("Skewed photo", 100, 100, transform([500, 400], { rotation: 45 }));
    skewed.parent = squash;
    // Mirrored along y: layer (x,y) -> (600 + x, 100 - y), hanging upside down from its baseline.
    var flipped = textLayer("Upside-down text", transform([600, 100], { scale: [100, -100] }), rect);
    // Mirrored and turned 30: keeping its y axis turns it by 30, keeping x by -150.
    var turnedMirror = footageLayer("Turned mirror", 100, 50,
        transform([500, 700], { anchor: [50, 25], scale: [-100, 100], rotation: 30 }));

    selectComp([stretched, mirrored, wide, skewed, flipped, turnedMirror]);
    var doc = LazyLord.readSelection("C:\\temp");
    var s = doc.layers[0], m = doc.layers[1], w = doc.layers[2], k = doc.layers[3];
    var f = doc.layers[4], tm = doc.layers[5];

    ok("stretched text: box keeps both axis lengths (80x30)",
       near(s.frame.width, 80) && near(s.frame.height, 30), s.frame.width + "x" + s.frame.height);
    ok("stretched text: font at the average scale (30 * sqrt 2)", near(s.fontSize, 30 * Math.SQRT2),
       String(s.fontSize));
    ok("stretched text: reported", diagsWith("uneven scale").length === 1 &&
       diagsWith("uneven scale")[0].object === "Stretched text", JSON.stringify(LazyLord.diagnostics));
    ok("mirrored text: sent upright and unmirrored (rotation 0), not upside down",
       m.frame.rotation === 0, String(m.frame.rotation));
    ok("mirrored text: reported", diagsWith("mirrored", "unmirrored").length === 3 &&
       diagsWith("mirrored")[0].object === "Mirrored text", JSON.stringify(LazyLord.diagnostics));
    ok("uneven footage: stretched into its box, unturned, not reported",
       near(w.frame.width, 200) && near(w.frame.height, 50) && w.frame.rotation === 0,
       JSON.stringify(w.frame));
    ok("skewed footage: reported", diagsWith("skewed").length === 1 &&
       diagsWith("skewed")[0].object === "Skewed photo", JSON.stringify(LazyLord.diagnostics));
    ok("turned mirror: keeps the turn nearest upright (30), box unrotated 100x50",
       near(tm.frame.rotation, 30) && near(tm.frame.width, 100) && near(tm.frame.height, 50),
       JSON.stringify(tm.frame));
    ok("upside-down text: sent upright (rotation 0)", f.frame.rotation === 0, String(f.frame.rotation));

    LazyLord.applyOrigin(doc);
    var kc = LazyLord.frameCenter(k.frame);
    ok("skewed footage: centred where the parent puts it (1000, 400 + 50 sqrt 2)",
       near(kc[0], 1000) && near(kc[1], 400 + 50 * Math.SQRT2), xy(kc));
    ok("mirrored text: the same 40x30 box AE shows (360..400, 76..106)",
       near(m.frame.x, 360) && near(m.frame.y, 76) && near(m.frame.width, 40) && near(m.frame.height, 30),
       JSON.stringify(m.frame));
    ok("mirrored text: its anchor moves to the box's left, so it reads forwards in place",
       near(m.anchorX, 360) && near(m.baseline, 100), m.anchorX + "," + m.baseline);
    ok("upside-down text: the same box (600..640, 94..124)",
       near(f.frame.x, 600) && near(f.frame.y, 94) && near(f.frame.width, 40) && near(f.frame.height, 30),
       JSON.stringify(f.frame));
    ok("upside-down text: baseline 24 below the box top, as upright text has it",
       near(f.anchorX, 600) && near(f.baseline, 118), f.anchorX + "," + f.baseline);
    ok("turned mirror: centred where AE shows it (500,700)",
       near(LazyLord.frameCenter(tm.frame)[0], 500) && near(LazyLord.frameCenter(tm.frame)[1], 700),
       xy(LazyLord.frameCenter(tm.frame)));
    ok("turned-box losses: exactly five, all approximated",
       LazyLord.diagnostics.length === 5 && allApproximated(), JSON.stringify(LazyLord.diagnostics));
})();

// 24) The fill's own Fill Rule decides the winding, not the contour count.
//     Before, every multi-contour shape went out even-odd, so a Non-Zero ring
//     (AE's default, and what LazyLord's AE builder writes) came back holed.
(function () {
    LazyLord.resetDiagnostics();
    function ring(paint) { return [rectNode([100, 100], [0, 0]), rectNode([40, 40], [0, 0]), paint]; }
    var offFill = fillNode([1, 0, 0, 1], 100, 1);
    offFill.enabled = false;

    selectComp([
        shapeLayer("Nonzero ring", ring(fillNode([1, 0, 0, 1], 100, 1)), transform([100, 100])),
        shapeLayer("Even-odd ring", ring(fillNode([1, 0, 0, 1], 100, 2)), transform([300, 100])),
        shapeLayer("Even-odd single", [rectNode([100, 100], [0, 0]), fillNode([1, 0, 0, 1], 100, 2)],
                   transform([500, 100])),
        shapeLayer("Unfilled ring", ring(strokeNode([0, 0, 0, 1], 2)), transform([700, 100])),
        shapeLayer("Unfilled single", [rectNode([100, 100], [0, 0]), strokeNode([0, 0, 0, 1], 2)],
                   transform([900, 100])),
        shapeLayer("Fill switched off", ring(offFill), transform([1100, 100])),
        shapeLayer("Two fills", [rectNode([100, 100], [0, 0]), rectNode([40, 40], [0, 0]),
                   fillNode([1, 0, 0, 1], 100, 2), fillNode([0, 1, 0, 1], 100, 1)], transform([1300, 100])),
        shapeLayer("No rule", ring(fillNode([1, 0, 0, 1], 100, null)), transform([1500, 100]))
    ]);
    var doc = LazyLord.readSelection("C:\\temp");
    function rule(i) { return doc.layers[i].windingRule; }

    ok("fill rule 1: a Non-Zero ring stays nonzero", rule(0) === "nonzero", rule(0));
    ok("fill rule 2: even-odd", rule(1) === "evenodd", rule(1));
    ok("fill rule 2: honoured on a single contour too", rule(2) === "evenodd", rule(2));
    ok("no fill: several contours fall back to even-odd", rule(3) === "evenodd", rule(3));
    ok("no fill: one contour falls back to nonzero", rule(4) === "nonzero", rule(4));
    ok("switched-off fill: counts as no fill", rule(5) === "evenodd" && doc.layers[5].fills.length === 0,
       rule(5) + " " + JSON.stringify(doc.layers[5].fills));
    ok("two fills: the first (the one sent) decides", rule(6) === "evenodd" &&
       near(doc.layers[6].fills[0].color.r, 1), rule(6));
    ok("unreadable rule: After Effects' default, nonzero", rule(7) === "nonzero", rule(7));
    ok("unreadable rule: the only report, approximated",
       LazyLord.diagnostics.length === 1 && diagsWith("fill rule").length === 1 &&
       diagsWith("fill rule")[0].object === "No rule" && allApproximated(), JSON.stringify(LazyLord.diagnostics));
})();

// 25) Frames follow the curves, not just their vertices.
(function () {
    // One segment bulging 22.5 px above its chord: y(t) = -90 t (1 - t).
    var b = LazyLord._aer_curveBounds([{ closed: false, vertices: [[0, 0], [100, 0]],
        inTangents: [[0, 0], [0, -30]], outTangents: [[0, -30], [0, 0]] }]);
    ok("curve bounds: the bulge's extremum counts",
       near(b.x, 0) && near(b.y, -22.5) && near(b.width, 100) && near(b.height, 22.5), JSON.stringify(b));
    // Only the closing segment bulges (down to y = 22.5).
    function lens(closed) {
        return { closed: closed, vertices: [[0, 0], [100, 0]],
                 inTangents: [[0, 30], [0, 0]], outTangents: [[0, 0], [0, 30]] };
    }
    ok("curve bounds: an open path has no closing segment",
       near(LazyLord._aer_curveBounds([lens(false)]).height, 0), JSON.stringify(LazyLord._aer_curveBounds([lens(false)])));
    ok("curve bounds: a closed path's closing segment counts",
       near(LazyLord._aer_curveBounds([lens(true)]).height, 22.5), JSON.stringify(LazyLord._aer_curveBounds([lens(true)])));
    var sq = LazyLord._aer_curveBounds([{ closed: true, vertices: [[0, 0], [10, 0], [10, 20], [0, 20]],
        inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]] }]);
    ok("curve bounds: straight segments stay at the vertices",
       near(sq.x, 0) && near(sq.y, 0) && near(sq.width, 10) && near(sq.height, 20), JSON.stringify(sq));

    // A 200x100 ellipse turned 45: its vertex box is 141.4 square, the drawn one ~158.1.
    // A ramp across the drawn width must then run exactly 0..1 of the box.
    LazyLord.resetDiagnostics();
    var half = Math.sqrt((100 * 100 + 50 * 50) / 2);
    selectComp([shapeLayer("Tilted oval", [ellipseNode([200, 100], [0, 0]), fillNode([1, 0, 0, 1])],
        transform([500, 500], { rotation: 45 }), {
        "ADBE Effect Parade": effectParade([
            rampNode([500 - half, 500], [1, 0, 0, 1], [500 + half, 500], [0, 0, 1, 1], 1)
        ])
    })]);
    var doc = LazyLord.readSelection("C:\\temp");
    var l = doc.layers[0], p = l.fills[0];

    ok("tilted ellipse: frame is the drawn box (~158.1), not the vertices' (141.4)",
       near(l.frame.width, 2 * half, 0.1) && near(l.frame.height, 2 * half, 0.1),
       l.frame.width + "x" + l.frame.height);
    ok("tilted ellipse: selection bounds follow the curve too",
       near(doc.bounds.x, 500 - half, 0.05) && near(doc.bounds.y, 500 - half, 0.05) &&
       near(doc.bounds.width, 2 * half, 0.1), JSON.stringify(doc.bounds));
    var inside = true;
    for (var v = 0; v < l.subpaths[0].vertices.length; v++) {
        var pt = l.subpaths[0].vertices[v];
        if (pt[0] < 1 || pt[1] < 1 || pt[0] > l.frame.width - 1 || pt[1] > l.frame.height - 1) inside = false;
    }
    ok("tilted ellipse: its vertices sit inside the box, off its edges", inside, vlist(l.subpaths[0].vertices));
    ok("tilted ellipse: ramp across the drawn width runs 0..1 of the box",
       near(p.from.x, 0, 0.002) && near(p.to.x, 1, 0.002) && near(p.from.y, 0.5, 0.002), JSON.stringify(p));
    ok("tilted ellipse: still baked", l.frame.rotation === 0, String(l.frame.rotation));
})();

// 26) Parenting: the whole chain is composed wherever the layer matrix is used —
//     geometry, strokes, masks, a solid's ramp, a text layer's turn.
(function () {
    LazyLord.resetDiagnostics();
    // Rig turned 90 and doubled at (500,500): rig (x,y) -> (500 - 2y, 500 + 2x).
    var rig = makeLayer(AVLayer, "Rig", {
        "ADBE Transform Group": transform([500, 500], { rotation: 90, scale: [200, 200] })
    });
    // Its Position is in the rig's layer space: child (x,y) -> rig (x + 10, y).
    var child = shapeLayer("Child", [rectNode([20, 10], [0, 0]), strokeNode([0, 0, 0, 1], 3)],
        transform([10, 0]), {
        "ADBE Mask Parade": maskParade([maskNode("Window", [[-10, -5], [0, -5], [0, 5], [-10, 5]])])
    });
    child.id = 31;
    child.parent = rig;

    // A solid under the same rig: solid (x,y) -> rig (x, y + 100) -> comp (300 - 2y, 500 + 2x).
    var src = new FootageItem();
    src.file = null;
    src.mainSource = new SolidSource();
    src.mainSource.color = [0, 0, 0];
    var solid = makeLayer(AVLayer, "Rig solid", {
        "ADBE Transform Group": transform([0, 100]),
        "ADBE Effect Parade": effectParade([rampNode([0, 0], [1, 0, 0, 1], [50, 0], [0, 0, 1, 1], 1)])
    });
    solid.source = src;
    solid.width = 50;
    solid.height = 20;
    solid.parent = rig;

    // Two levels up, and a turned text under a turned parent: 30 + 60 = 90.
    var top = makeLayer(AVLayer, "Top", { "ADBE Transform Group": transform([100, 0]) });
    var mid = makeLayer(AVLayer, "Mid", { "ADBE Transform Group": transform([0, 50], { rotation: 60 }) });
    mid.parent = top;
    var caption = textLayer("Caption", transform([10, 0], { rotation: 30 }),
                            { left: 0, top: -24, width: 40, height: 30 });
    caption.parent = mid;

    selectComp([child, solid, caption]);
    var doc = LazyLord.readSelection("C:\\temp");
    LazyLord.applyOrigin(doc);
    var c = doc.layers[0], s = doc.layers[1], t = doc.layers[2];

    ok("parented shape: placed through the rig (20x40 at 490,500)",
       near(c.frame.x, 490) && near(c.frame.y, 500) && near(c.frame.width, 20) && near(c.frame.height, 40),
       JSON.stringify(c.frame));
    ok("parented shape: still baked, rotation 0", c.frame.rotation === 0, String(c.frame.rotation));
    ok("parented shape: stroke scales with the rig", c.strokes.length === 1 && near(c.strokes[0].weight, 6),
       JSON.stringify(c.strokes));
    ok("parented mask: the clip goes through the rig too",
       c.clip && sameVerts(c.clip.subpaths[0].vertices, [[510, 500], [510, 520], [490, 520], [490, 500]]),
       c.clip && vlist(c.clip.subpaths[0].vertices));
    ok("parented solid: placed through the rig (40x100 at 260,500)",
       near(s.frame.x, 260) && near(s.frame.y, 500) && near(s.frame.width, 40) && near(s.frame.height, 100),
       JSON.stringify(s.frame));
    ok("parented solid: its ramp turns with the rig, down the right edge",
       s.fills[0].type === "linear-gradient" && near(s.fills[0].from.x, 1) && near(s.fills[0].from.y, 0) &&
       near(s.fills[0].to.x, 1) && near(s.fills[0].to.y, 1), JSON.stringify(s.fills[0]));
    ok("grandparented text: parent turns add up (90)", near(t.frame.rotation, 90), String(t.frame.rotation));
    var ra = LazyLord.rotatedTextAnchor(t);
    ok("grandparented text: baseline origin at (105, 50 + 5 sqrt 3)",
       near(ra[0], 105) && near(ra[1], 50 + 5 * Math.sqrt(3)), xy(ra));
    ok("parenting: nothing reported", LazyLord.diagnostics.length === 0, JSON.stringify(LazyLord.diagnostics));
})();

// 27) Parent chains that loop, run too deep or climb into 3D are cut or
//     flattened, and reported — never followed forever.
(function () {
    LazyLord.resetDiagnostics();
    var a = shapeLayer("Loop A", [rectNode([10, 10], [0, 0])], transform([100, 100]));
    var b = makeLayer(AVLayer, "Loop B", { "ADBE Transform Group": transform([50, 0]) });
    a.parent = b;
    b.parent = a;
    var self = shapeLayer("Own parent", [rectNode([10, 10], [0, 0])], transform([100, 300]));
    self.parent = self;

    var deep = shapeLayer("Deep", [rectNode([10, 10], [0, 0])], transform([100, 500]));
    var below = deep;
    for (var i = 0; i < 150; i++) {
        var n = makeLayer(AVLayer, "Null " + i, { "ADBE Transform Group": transform([1, 0]) });
        below.parent = n;
        below = n;
    }

    var cam = makeLayer(AVLayer, "3D null", { "ADBE Transform Group": transform([20, 0]) });
    cam.threeDLayer = true;
    var flat = shapeLayer("Flat child", [rectNode([10, 10], [0, 0])], transform([100, 700]));
    flat.parent = cam;

    selectComp([a, self, deep, flat]);
    var doc = LazyLord.readSelection("C:\\temp");
    LazyLord.applyOrigin(doc);

    ok("loop: every layer still sent", doc.layers.length === 4, String(doc.layers.length));
    ok("loop: each parent applied once (x 145)", near(doc.layers[0].frame.x, 145), String(doc.layers[0].frame.x));
    ok("loop: reported", diagsWith("loops back", "'Loop A'").length === 1 &&
       diagsWith("loops back", "'Loop A'")[0].object === "Loop A", JSON.stringify(LazyLord.diagnostics));
    ok("own parent: placed by its own transform", near(doc.layers[1].frame.x, 95), String(doc.layers[1].frame.x));
    ok("own parent: reported", diagsWith("loops back", "'Own parent'").length === 1);
    ok("deep chain: only the nearest 100 parents apply (x 95 + 100)",
       near(doc.layers[2].frame.x, 195), String(doc.layers[2].frame.x));
    ok("deep chain: reported", diagsWith("100 layers deep").length === 1 &&
       diagsWith("100 layers deep")[0].object === "Deep");
    ok("3D parent: still applied in 2D (x 115)", near(doc.layers[3].frame.x, 115), String(doc.layers[3].frame.x));
    ok("3D parent: reported, naming the parent", diagsWith("'3D null'", "3D").length === 1 &&
       diagsWith("'3D null'", "3D")[0].object === "Flat child", JSON.stringify(LazyLord.diagnostics));
    ok("broken chains: exactly four reports, all approximated",
       LazyLord.diagnostics.length === 4 && allApproximated(), JSON.stringify(LazyLord.diagnostics));
})();

// 28) A drawn curve's bulge widens the frame, and the geometry is local to it.
(function () {
    LazyLord.resetDiagnostics();
    // Bulges 22.5 px above its chord; doubled by a group scale to 45.
    var arc = curvedPathNode([[0, 0], [100, 0]], [[0, 0], [0, -30]], [[0, -30], [0, 0]], false);
    selectComp([shapeLayer("Arc", [vectorGroup([arc, strokeNode([0, 0, 0, 1], 2)], { scale: [200, 200] })],
        transform([200, 300]))]);
    var doc = LazyLord.readSelection("C:\\temp");
    var l = doc.layers[0];
    ok("bulge: frame 200 x 45, top at the bulge (y 255)",
       near(l.frame.width, 200) && near(l.frame.height, 45) && near(doc.bounds.y, 255),
       JSON.stringify(l.frame) + " " + JSON.stringify(doc.bounds));
    ok("bulge: chord ends sit on the box's bottom edge",
       sameVerts(l.subpaths[0].vertices, [[0, 45], [200, 45]]), vlist(l.subpaths[0].vertices));
    ok("bulge: tangents scaled, still relative", near(l.subpaths[0].outTangents[0][1], -60),
       xy(l.subpaths[0].outTangents[0]));
    ok("bulge: stroke only, one contour: nonzero", l.windingRule === "nonzero", l.windingRule);
})();

// 29) Text whose extent cannot be measured gets a font-size box, and says so;
//     its baseline and turn stay exact.
(function () {
    LazyLord.resetDiagnostics();
    var t = textLayer("Unmeasured", transform([300, 200], { rotation: 90 }), null);
    selectComp([t]);
    var doc = LazyLord.readSelection("C:\\temp");
    LazyLord.applyOrigin(doc);
    var l = doc.layers[0];
    ok("unmeasured text: still sent, turned 90", l.type === "text" && near(l.frame.rotation, 90),
       l.type + " " + l.frame.rotation);
    ok("unmeasured text: a 30 x 30 box from the font size",
       near(l.frame.width, 30) && near(l.frame.height, 30) && near(l.frame.x, 300) && near(l.frame.y, 200),
       JSON.stringify(l.frame));
    var ra = LazyLord.rotatedTextAnchor(l);
    ok("unmeasured text: baseline origin exact (300,200)", near(ra[0], 300) && near(ra[1], 200), xy(ra));
    ok("unmeasured text: reported once, approximated",
       LazyLord.diagnostics.length === 1 && diagsWith("could not be measured").length === 1 &&
       LazyLord.diagnostics[0].object === "Unmeasured" && allApproximated(), JSON.stringify(LazyLord.diagnostics));
})();

// 30) A null object is an AVLayer with a solid source: it has nothing to draw
//     and must not arrive as a coloured square.
(function () {
    LazyLord.resetDiagnostics();
    var src = new FootageItem();
    src.file = null;
    src.mainSource = new SolidSource();
    src.mainSource.color = [1, 1, 1];
    var nul = makeLayer(AVLayer, "Null 1", { "ADBE Transform Group": transform([500, 500]) });
    nul.source = src;
    nul.width = 100;
    nul.height = 100;
    nul.nullLayer = true;
    var box = shapeLayer("Box", [rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], transform([100, 100]));

    selectComp([nul, box]);
    var doc = LazyLord.readSelection("C:\\temp");
    ok("null: not sent, the shape is", doc.layers.length === 1 && doc.layers[0].name === "Box",
       String(doc.layers.length));
    ok("null: reported as having nothing to draw",
       LazyLord.diagnostics.length === 1 && LazyLord.diagnostics[0].object === "Null 1" &&
       LazyLord.diagnostics[0].resolution === "skipped" && diagsWith("nothing to draw").length === 1,
       JSON.stringify(LazyLord.diagnostics));
    ok("null: bounds from the shape alone", near(doc.bounds.x, 95) && near(doc.bounds.width, 10),
       JSON.stringify(doc.bounds));
})();

// 31) A camera parent: its "anchor" is a Point of Interest, not an offset.
(function () {
    LazyLord.resetDiagnostics();
    var cam = makeLayer(CameraLayer, "Camera 1", {
        "ADBE Transform Group": transform([100, 50], { anchor: [960, 540] })
    });
    var child = shapeLayer("On camera", [rectNode([10, 10], [0, 0])], transform([0, 0]));
    child.parent = cam;
    selectComp([child]);
    var doc = LazyLord.readSelection("C:\\temp");
    LazyLord.applyOrigin(doc);
    var l = doc.layers[0];
    ok("camera parent: placed from the camera's position only (95,45)",
       near(l.frame.x, 95) && near(l.frame.y, 45), l.frame.x + "," + l.frame.y);
    ok("camera parent: reported as 3D, naming it",
       LazyLord.diagnostics.length === 1 && diagsWith("'Camera 1'", "3D").length === 1 && allApproximated(),
       JSON.stringify(LazyLord.diagnostics));
})();

// 32) The layer stack follows the comp, not the order the layers were clicked.
//     selectedLayers is in click order, so Ctrl+A (or shift-click from the
//     top) lists the top layer first; before, the stack arrived upside down.
(function () {
    LazyLord.resetDiagnostics();
    var top = shapeLayer("Title", [rectNode([10, 10], [0, 0])], transform([100, 100]));
    var mid = shapeLayer("Card", [rectNode([10, 10], [0, 0])], transform([100, 100]));
    var bottom = shapeLayer("Background", [rectNode([10, 10], [0, 0])], transform([100, 100]));
    top.index = 1; mid.index = 4; bottom.index = 7;

    selectComp([top, bottom, mid]);
    var doc = LazyLord.readSelection("C:\\temp");
    function names(d) {
        var out = [];
        for (var i = 0; i < d.layers.length; i++) out.push(d.layers[i].name);
        return out.join(",");
    }
    ok("stack order: bottom to top whatever the click order", names(doc) === "Background,Card,Title", names(doc));
    ok("stack order: nothing reported", LazyLord.diagnostics.length === 0, JSON.stringify(LazyLord.diagnostics));

    selectComp([top, mid, bottom]);
    ok("stack order: select all from the top comes out the same", names(LazyLord.readSelection("C:\\temp")) ===
       "Background,Card,Title");

    // An index that cannot be read keeps the click order, and says so.
    LazyLord.resetDiagnostics();
    var lost = shapeLayer("No index", [rectNode([10, 10], [0, 0])], transform([100, 100]));
    lost.index = null;
    selectComp([top, lost, bottom]);
    doc = LazyLord.readSelection("C:\\temp");
    ok("unreadable index: the selection order is kept", names(doc) === "Title,No index,Background", names(doc));
    ok("unreadable index: reported once, naming the layer, approximated",
       LazyLord.diagnostics.length === 1 && LazyLord.diagnostics[0].object === "No index" &&
       diagsWith("layer stack", "order it was selected").length === 1 && allApproximated(),
       JSON.stringify(LazyLord.diagnostics));

    // One layer needs no order, so its index is never asked for.
    LazyLord.resetDiagnostics();
    selectComp([lost]);
    ok("single layer: no index needed, nothing reported",
       LazyLord.readSelection("C:\\temp").layers.length === 1 && LazyLord.diagnostics.length === 0,
       JSON.stringify(LazyLord.diagnostics));
})();

// 33) Adjustment and guide layers draw nothing of their own. An adjustment
//     layer is a comp-sized white solid (or a shape or text layer with the
//     switch on), so before it arrived as an opaque rectangle over everything.
(function () {
    LazyLord.resetDiagnostics();
    function solidLayer(name, w, h, tform) {
        var src = new FootageItem();
        src.file = null;
        src.mainSource = new SolidSource();
        src.mainSource.color = [1, 1, 1];
        var av = makeLayer(AVLayer, name, { "ADBE Transform Group": tform });
        av.source = src;
        av.width = w;
        av.height = h;
        return av;
    }
    var adjSolid = solidLayer("Adjustment Layer 1", 1920, 1080, transform([960, 540], { anchor: [960, 540] }));
    adjSolid.adjustmentLayer = true;
    var adjShape = shapeLayer("Vignette area", [ellipseNode([3000, 3000], [0, 0]), fillNode([1, 1, 1, 1])],
                              transform([960, 540]));
    adjShape.adjustmentLayer = true;
    var adjText = textLayer("Blur words", transform([0, 1000]), { left: 0, top: -24, width: 4000, height: 30 });
    adjText.adjustmentLayer = true;
    var guide = footageLayer("Reference", 1920, 1080, transform([0, 0]));
    guide.guideLayer = true;
    var guideAdj = solidLayer("Guide adjustment", 1920, 1080, transform([0, 0]));
    guideAdj.guideLayer = true;
    guideAdj.adjustmentLayer = true;
    var box = shapeLayer("Box", [rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], transform([100, 100]));
    // A camera is no AVLayer and has none of these switches, as in AE.
    var cam = makeLayer(CameraLayer, "Camera 1", { "ADBE Transform Group": transform([0, 0]) });
    cam.adjustmentLayer = undefined;
    cam.guideLayer = undefined;

    selectComp([box, adjSolid, adjShape, adjText, guide, guideAdj, cam]);
    var doc = LazyLord.readSelection("C:\\temp");
    function reportsFor(name) {
        var n = 0;
        for (var i = 0; i < LazyLord.diagnostics.length; i++) {
            if (LazyLord.diagnostics[i].object === name) n++;
        }
        return n;
    }
    function allSkipped() {
        for (var i = 0; i < LazyLord.diagnostics.length; i++) {
            if (LazyLord.diagnostics[i].resolution !== "skipped") return false;
        }
        return true;
    }

    ok("undrawn: only the box is sent", doc.layers.length === 1 && doc.layers[0].name === "Box",
       String(doc.layers.length));
    ok("undrawn: bounds from the box alone, not the comp-sized layers",
       near(doc.bounds.x, 95) && near(doc.bounds.y, 95) && near(doc.bounds.width, 10) && near(doc.bounds.height, 10),
       JSON.stringify(doc.bounds));
    ok("adjustment solid: reported once as an adjustment layer",
       reportsFor("Adjustment Layer 1") === 1 && diagsWith("adjustment layer", "not transferred").length === 3,
       JSON.stringify(LazyLord.diagnostics));
    ok("adjustment shape and text: reported once each",
       reportsFor("Vignette area") === 1 && reportsFor("Blur words") === 1);
    ok("guide layer: reported once as not rendered",
       reportsFor("Reference") === 1 && diagsWith("guide layer", "does not render").length === 2);
    ok("guide adjustment layer: one report, not two", reportsFor("Guide adjustment") === 1);
    ok("camera: one report, its missing switches are not unreadable ones", reportsFor("Camera 1") === 1 &&
       diagsWith("could not be read").length === 0);
    ok("undrawn: six reports, all skipped", LazyLord.diagnostics.length === 6 && allSkipped(),
       JSON.stringify(LazyLord.diagnostics));

    // A switch that cannot be read is taken as off: the layer is sent, and it says so.
    LazyLord.resetDiagnostics();
    var odd = shapeLayer("Odd", [rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], transform([100, 100]));
    odd.adjustmentLayer = undefined;
    var odder = shapeLayer("Odder", [rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], transform([200, 100]));
    odder.nullLayer = undefined;
    odder.guideLayer = "yes";
    selectComp([odd, odder]);
    doc = LazyLord.readSelection("C:\\temp");
    ok("unreadable switch: the layers are still sent", doc.layers.length === 2, String(doc.layers.length));
    ok("unreadable switch: named in the report",
       diagsWith("Whether it is an adjustment layer could not be read").length === 1 &&
       diagsWith("Whether it is an adjustment layer")[0].object === "Odd", JSON.stringify(LazyLord.diagnostics));
    ok("unreadable switches: listed together in one report",
       diagsWith("Whether it is a null object or a guide layer could not be read").length === 1 &&
       diagsWith("a null object or a guide layer")[0].object === "Odder", JSON.stringify(LazyLord.diagnostics));
    ok("unreadable switches: two reports, approximated", LazyLord.diagnostics.length === 2 && allApproximated(),
       JSON.stringify(LazyLord.diagnostics));
})();

// 34) Paint is scoped per group: a red circle group and a blue square group
//     are two vectors, grouped under the layer. Before, both came out red.
(function () {
    LazyLord.resetDiagnostics();
    var badge = shapeLayer("Badge", [
        vectorGroup([ellipseNode([100, 100], [0, 0]), fillNode([1, 0, 0, 1])], { name: "Circle" }),
        vectorGroup([rectNode([100, 100], [200, 0]), fillNode([0, 0, 1, 1])], { name: "Square" })
    ], transform([100, 100], { opacity: 80 }));
    badge.id = 21;
    selectComp([badge]);
    var doc = LazyLord.readSelection("C:\\temp");
    var g = doc.layers[0];

    ok("painted groups: one group named after the layer",
       doc.layers.length === 1 && g.type === "group" && g.name === "Badge", tree(doc.layers));
    ok("painted groups: first in contents is on top, so the square comes first (bottom)",
       tree(doc.layers) === "Badge[Square,Circle]", tree(doc.layers));
    var sq = g.children[0], ci = g.children[1];
    ok("painted groups: each vector keeps its own colour",
       sq.type === "vector" && ci.type === "vector" &&
       sq.fills.length === 1 && near(sq.fills[0].color.b, 1) && near(sq.fills[0].color.r, 0) &&
       ci.fills.length === 1 && near(ci.fills[0].color.r, 1) && near(ci.fills[0].color.b, 0),
       JSON.stringify(sq.fills) + " " + JSON.stringify(ci.fills));
    ok("painted groups: each vector has only its own path",
       sq.subpaths.length === 1 && sq.subpaths[0].vertices.length === 4 &&
       ci.subpaths.length === 1 && ci.subpaths[0].vertices.length === 4 && near(ci.subpaths[0].outTangents[0][0], 50 * 0.5522847498307936),
       sq.subpaths.length + " " + ci.subpaths.length);
    ok("painted groups: the layer's opacity is on the group, the vectors at 1",
       near(g.frame.opacity, 0.8) && near(sq.frame.opacity, 1) && near(ci.frame.opacity, 1),
       g.frame.opacity + " " + sq.frame.opacity + " " + ci.frame.opacity);
    ok("painted groups: group frame is the union of its vectors, unrotated",
       near(g.frame.x, 0) && near(g.frame.y, 0) && near(g.frame.width, 300) && near(g.frame.height, 100) &&
       g.frame.rotation === 0, JSON.stringify(g.frame));
    ok("painted groups: children keep frames in the same frame space",
       near(sq.frame.x, 200) && near(sq.frame.y, 0) && near(sq.frame.width, 100) &&
       near(ci.frame.x, 0) && near(ci.frame.width, 100), JSON.stringify(sq.frame) + " " + JSON.stringify(ci.frame));
    ok("painted groups: geometry local to each vector's own box",
       sameVerts(sq.subpaths[0].vertices, [[100, 0], [100, 100], [0, 100], [0, 0]]), vlist(sq.subpaths[0].vertices));
    ok("painted groups: distinct ids under the layer's",
       g.id === "ae-21" && sq.id !== ci.id && sq.id.indexOf("ae-21-") === 0 && ci.id.indexOf("ae-21-") === 0,
       g.id + " " + sq.id + " " + ci.id);
    ok("painted groups: bounds span both", near(doc.bounds.x, 50) && near(doc.bounds.y, 50) &&
       near(doc.bounds.width, 300) && near(doc.bounds.height, 100), JSON.stringify(doc.bounds));
    ok("painted groups: nothing reported, no private fields",
       LazyLord.diagnostics.length === 0 && JSON.stringify(doc).indexOf("_aer") < 0, JSON.stringify(LazyLord.diagnostics));

    // The shared helpers see a normal group tree.
    LazyLord.applyOrigin(doc);
    ok("painted groups: applyOrigin moves the children too", near(sq.frame.x, 250) && near(ci.frame.x, 50),
       sq.frame.x + " " + ci.frame.x);
    var flat = LazyLord.flattenLayers(doc.layers);
    ok("painted groups: flattened, two leaves at the layer's opacity, the fade counted as lossy",
       flat.length === 2 && near(flat[0].frame.opacity, 0.8) && near(flat[1].frame.opacity, 0.8) && flat.lossy === 1,
       flat.length + " " + flat.lossy);
})();

// 35) Nested painted groups nest, each with its group opacity; an outer Fill
//     paints the inner group's paths too (a paint covers every path above it).
(function () {
    LazyLord.resetDiagnostics();
    var nest = shapeLayer("Nest", [
        vectorGroup([rectNode([20, 20], [0, 0]), fillNode([0, 1, 0, 1])], { name: "Back" }),
        vectorGroup([
            vectorGroup([ellipseNode([10, 10], [0, 0]), fillNode([0, 0, 1, 1])], { name: "Inner", opacity: 40 }),
            rectNode([40, 40], [0, 0]),
            fillNode([1, 0, 0, 1])
        ], { name: "Outer", opacity: 50, position: [100, 0] })
    ], transform([500, 500]));
    selectComp([nest]);
    var doc = LazyLord.readSelection("C:\\temp");
    var g = doc.layers[0];

    ok("nested groups: the painted structure nests", tree(doc.layers) === "Nest[Outer[Outer,Inner],Back]",
       tree(doc.layers));
    var outer = g.children[0], red = outer.children[0], blue = outer.children[1], back = g.children[1];
    ok("nested groups: the shape group's opacity is on its IR group",
       outer.type === "group" && near(outer.frame.opacity, 0.5) && near(g.frame.opacity, 1),
       outer.frame.opacity + " " + g.frame.opacity);
    ok("nested groups: a group that paints one vector hands it up with its opacity",
       blue.type === "vector" && near(blue.frame.opacity, 0.4) && blue.subpaths.length === 1 &&
       near(blue.fills[0].color.b, 1), JSON.stringify(blue.frame));
    ok("nested groups: the outer Fill paints the inner ellipse and its own rect",
       red.type === "vector" && red.subpaths.length === 2 && near(red.fills[0].color.r, 1) &&
       red.windingRule === "nonzero" && near(red.frame.opacity, 1), red.subpaths.length + " " + red.windingRule);
    ok("nested groups: the group transform places them (bounds 490..620 x 480..520)",
       near(doc.bounds.x, 490) && near(doc.bounds.y, 480) && near(doc.bounds.width, 130) && near(doc.bounds.height, 40),
       JSON.stringify(doc.bounds));
    ok("nested groups: inner group frame is its vectors' union (40x40 at 90,0)",
       near(outer.frame.x, 90) && near(outer.frame.y, 0) && near(outer.frame.width, 40) && near(outer.frame.height, 40),
       JSON.stringify(outer.frame));
    ok("nested groups: the inner vector sits where AE draws it (10x10 at 105,15)",
       near(blue.frame.x, 105) && near(blue.frame.y, 15) && near(blue.frame.width, 10) && near(back.frame.x, 0),
       JSON.stringify(blue.frame));
    ok("nested groups: the painted-twice ellipse is two separate copies",
       red.subpaths[0].vertices !== blue.subpaths[0].vertices &&
       red.subpaths[0].inTangents[0] !== blue.subpaths[0].inTangents[0] &&
       red.subpaths[0].outTangents[0] !== blue.subpaths[0].outTangents[0]);
    var flat = LazyLord.flattenLayers(doc.layers);
    ok("nested groups: flattening multiplies the opacities down (0.5, 0.2, 1)",
       flat.length === 3 && near(flat[0].frame.opacity, 0.5) && near(flat[1].frame.opacity, 0.2) &&
       near(flat[2].frame.opacity, 1), flat[0].frame.opacity + " " + flat[1].frame.opacity + " " + flat[2].frame.opacity);
    ok("nested groups: nothing reported", LazyLord.diagnostics.length === 0, JSON.stringify(LazyLord.diagnostics));
})();

// 36) One painted set stays one vector named after the layer, exactly as before.
(function () {
    LazyLord.resetDiagnostics();
    var card = shapeLayer("Card", [vectorGroup([rectNode([100, 50], [0, 0]), strokeNode([0, 0, 0, 1], 2),
        fillNode([1, 0, 0, 1])], { name: "Rectangle 1" })], transform([100, 100], { opacity: 60 }));
    card.id = 5;
    // Group opacity was ignored before; one vector now takes it multiplied in.
    var faded = shapeLayer("Faded card", [vectorGroup([rectNode([100, 50], [0, 0]), fillNode([1, 0, 0, 1])],
        { opacity: 50 })], transform([300, 100], { opacity: 60 }));
    // A Fill at the root paints every group above it: one set, one vector.
    var pair = shapeLayer("Pair", [
        vectorGroup([rectNode([10, 10], [0, 0])], { name: "A" }),
        vectorGroup([ellipseNode([10, 10], [20, 0])], { name: "B" }),
        fillNode([0, 1, 0, 1])
    ], transform([500, 100]));
    selectComp([card, faded, pair]);
    var doc = LazyLord.readSelection("C:\\temp");
    var c = doc.layers[0], f = doc.layers[1], p = doc.layers[2];

    ok("single paint: a vector, not a group", c.type === "vector" && c.children === undefined, c.type);
    ok("single paint: named and numbered after the layer", c.name === "Card" && c.id === "ae-5", c.name + " " + c.id);
    ok("single paint: fill and stroke together, layer opacity", c.fills.length === 1 && c.strokes.length === 1 &&
       near(c.fills[0].color.r, 1) && near(c.strokes[0].weight, 2) && near(c.frame.opacity, 0.6),
       JSON.stringify(c.fills) + " " + JSON.stringify(c.strokes) + " " + c.frame.opacity);
    ok("single paint: frame as before (100x50 at 0,0)", near(c.frame.x, 0) && near(c.frame.width, 100) &&
       near(c.frame.height, 50), JSON.stringify(c.frame));
    ok("single paint in a faded group: group opacity multiplied in (0.6 x 0.5)", f.type === "vector" &&
       near(f.frame.opacity, 0.3), String(f.frame.opacity));
    ok("root fill: one vector over both groups' paths", p.type === "vector" && p.name === "Pair" &&
       p.subpaths.length === 2 && p.fills.length === 1 && near(p.fills[0].color.g, 1), tree(doc.layers));
    ok("single paint: nothing reported", LazyLord.diagnostics.length === 0, JSON.stringify(LazyLord.diagnostics));
})();

// 37) Paint scoping details: a paint covers only the paths above it; unpainted
//     paths in a layer that paints are left out; root paints are their own
//     vectors; a paint composited above the previous one is reported.
(function () {
    LazyLord.resetDiagnostics();
    // Red covers the rect only; blue, lower down, covers the rect and the ellipse.
    var stepped = shapeLayer("Stepped", [rectNode([100, 100], [0, 0]), fillNode([1, 0, 0, 1]),
        ellipseNode([50, 50], [200, 0]), fillNode([0, 0, 1, 1])], transform([100, 100]));
    var stray = shapeLayer("Stray", [
        vectorGroup([rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], { name: "Painted" }),
        vectorGroup([ellipseNode([500, 500], [0, 0])], { name: "Bare" })
    ], transform([100, 400]));
    // A Fill above its paths paints nothing: the layer paints nothing at all.
    var backwards = shapeLayer("Backwards", [fillNode([1, 0, 0, 1]), rectNode([10, 10], [0, 0])], transform([100, 600]));
    // A root Stroke below a group paints its paths from outside: drawn below the group's fill.
    var outlined = shapeLayer("Outlined", [vectorGroup([rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], { name: "Box" }),
        strokeNode([0, 0, 0, 1], 4)], transform([300, 600]));
    var reordered = shapeLayer("Reordered", [rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1]),
        ellipseNode([10, 10], [20, 0]), fillNode([0, 0, 1, 1], 100, 1, 2)], transform([500, 600]));
    // Fill and stroke over the same paths merge whatever their composite order.
    var merged = shapeLayer("Merged", [rectNode([10, 10], [0, 0]), strokeNode([0, 0, 0, 1], 2),
        fillNode([1, 0, 0, 1], 100, 1, 2)], transform([700, 600]));

    selectComp([stepped, stray, backwards, outlined, reordered, merged]);
    var doc = LazyLord.readSelection("C:\\temp");
    var st = doc.layers[0], sr = doc.layers[1], bw = doc.layers[2], ol = doc.layers[3], ro = doc.layers[4], mg = doc.layers[5];

    ok("paths above only: two vectors, the lower paint (blue) at the bottom",
       st.type === "group" && st.children.length === 2 && near(st.children[0].fills[0].color.b, 1) &&
       near(st.children[1].fills[0].color.r, 1), tree([st]));
    ok("paths above only: blue covers both paths, red only the rect",
       st.children[0].subpaths.length === 2 && st.children[1].subpaths.length === 1,
       st.children[0].subpaths.length + " " + st.children[1].subpaths.length);
    ok("paths above only: both named after the group they sit in (the layer's root)",
       st.children[0].name === "Stepped" && st.children[1].name === "Stepped", tree([st]));
    ok("unpainted path: left out, the painted one is sent alone",
       sr.type === "vector" && sr.name === "Stray" && sr.subpaths.length === 1 && near(sr.frame.width, 10),
       tree([sr]) + " " + JSON.stringify(sr.frame));
    ok("unpainted path: reported against the layer, skipped",
       diagsWith("no Fill or Stroke").length === 1 && diagsWith("no Fill or Stroke")[0].object === "Stray" &&
       diagsWith("no Fill or Stroke")[0].resolution === "skipped", JSON.stringify(LazyLord.diagnostics));
    ok("fill above its path: paints nothing, the bare outline is sent",
       bw.type === "vector" && bw.fills.length === 0 && bw.strokes.length === 0 && bw.subpaths.length === 1,
       JSON.stringify(bw.fills));
    ok("root stroke under a group: its own vector, below the group's fill",
       tree([ol]) === "Outlined[Outlined,Box]" && ol.children[0].strokes.length === 1 &&
       ol.children[0].fills.length === 0 && near(ol.children[0].strokes[0].weight, 4) &&
       ol.children[1].fills.length === 1 && ol.children[1].strokes.length === 0, tree([ol]));
    ok("composite above previous: still sent, in contents order",
       ro.type === "group" && ro.children.length === 2 && near(ro.children[0].fills[0].color.b, 1), tree([ro]));
    ok("composite above previous: reported, naming the paint",
       diagsWith("'Fill above'", "composited above").length === 1 &&
       diagsWith("composited above")[0].object === "Reordered", JSON.stringify(LazyLord.diagnostics));
    ok("same paths, fill composited above: one vector, nothing to report",
       mg.type === "vector" && mg.fills.length === 1 && mg.strokes.length === 1, tree([mg]));
    ok("paint scoping: exactly those two reports",
       LazyLord.diagnostics.length === 2, JSON.stringify(LazyLord.diagnostics));

    // A paint whose colour cannot be read still paints its paths: they are
    // sent without it, and it says so, rather than being dropped as unpainted.
    LazyLord.resetDiagnostics();
    var broken = node("ADBE Vector Graphic - Fill", { name: "Broken fill", children: [
        node("ADBE Vector Fill Opacity", { value: 100 })
    ]});
    selectComp([shapeLayer("Half read", [
        vectorGroup([rectNode([10, 10], [0, 0]), broken], { name: "Unread" }),
        vectorGroup([rectNode([10, 10], [20, 0]), fillNode([0, 0, 1, 1])], { name: "Read" })
    ], transform([100, 100]))]);
    doc = LazyLord.readSelection("C:\\temp");
    var hr = doc.layers[0];
    ok("unreadable colour: its paths still sent, as their own vector without the fill",
       tree(doc.layers) === "Half read[Read,Unread]" && hr.children[1].fills.length === 0 &&
       hr.children[1].subpaths.length === 1 && near(hr.children[0].fills[0].color.b, 1), tree(doc.layers));
    ok("unreadable colour: reported once, naming the paint, skipped",
       LazyLord.diagnostics.length === 1 && diagsWith("'Broken fill'", "could not be read").length === 1 &&
       LazyLord.diagnostics[0].object === "Half read" && LazyLord.diagnostics[0].resolution === "skipped",
       JSON.stringify(LazyLord.diagnostics));
})();

// 38) A ramp and masks on a layer sent as a group reach every vector in it.
(function () {
    LazyLord.resetDiagnostics();
    var duo = shapeLayer("Duo", [
        vectorGroup([rectNode([100, 100], [50, 50]), fillNode([1, 1, 1, 1], 50)], { name: "L" }),
        vectorGroup([rectNode([100, 100], [250, 50]), fillNode([1, 1, 1, 1])], { name: "R" })
    ], transform([0, 0]), {
        "ADBE Effect Parade": effectParade([rampNode([0, 50], [1, 0, 0, 1], [300, 50], [0, 0, 1, 1], 1)]),
        "ADBE Mask Parade": maskParade([maskNode("Window", [[0, 0], [300, 0], [300, 100], [0, 100]])])
    });
    duo.id = 9;
    selectComp([duo]);
    var doc = LazyLord.readSelection("C:\\temp");
    var g = doc.layers[0], r = g.children[0], l = g.children[1];

    ok("group ramp: both vectors, R below L", tree(doc.layers) === "Duo[R,L]", tree(doc.layers));
    ok("group ramp: one comp-space ramp, boxed to each vector (L 0..3)",
       l.fills[0].type === "linear-gradient" && near(l.fills[0].from.x, 0) && near(l.fills[0].to.x, 3),
       JSON.stringify(l.fills[0]));
    ok("group ramp: boxed to each vector (R -2..1)",
       r.fills[0].type === "linear-gradient" && near(r.fills[0].from.x, -2) && near(r.fills[0].to.x, 1),
       JSON.stringify(r.fills[0]));
    ok("group ramp: each at its own fill's opacity",
       near(l.fills[0].stops[0].color.a, 0.5) && near(r.fills[0].stops[0].color.a, 1));
    ok("group masks: every vector clipped under the layer's mask id",
       l.clip && r.clip && l.clip.id === "ae-mask-9" && r.clip.id === "ae-mask-9", l.clip && l.clip.id);
    ok("group masks: each its own copy", l.clip !== r.clip &&
       l.clip.subpaths[0].vertices !== r.clip.subpaths[0].vertices);
    ok("group masks: the group itself carries none", g.clip === undefined);
    ok("group masks: frame space", sameVerts(l.clip.subpaths[0].vertices, [[0, 0], [300, 0], [300, 100], [0, 100]]),
       vlist(l.clip.subpaths[0].vertices));
    ok("group ramp and masks: nothing reported", LazyLord.diagnostics.length === 0, JSON.stringify(LazyLord.diagnostics));
})();

// 39) A selected parent null becomes a group of its selected children.
(function () {
    LazyLord.resetDiagnostics();
    // Rig turned 90 at (100,100): rig (x,y) -> (100 - y, 100 + x). Its opacity is not passed on.
    var rig = nullLayer("Rig", transform([100, 100], { rotation: 90, opacity: 50 }));
    rig.id = 40;
    var arm = shapeLayer("Arm", [rectNode([20, 10], [0, 0]), fillNode([1, 0, 0, 1])], transform([10, 0]));
    arm.parent = rig;
    var label = textLayer("Label", transform([0, 50]), { left: 0, top: -24, width: 40, height: 30 });
    label.parent = rig;
    var floor = shapeLayer("Floor", [rectNode([10, 10], [0, 0]), fillNode([0, 0, 0, 1])], transform([300, 300]));

    selectComp([floor, arm, label, rig]);
    var doc = LazyLord.readSelection("C:\\temp");
    var g = doc.layers[1];

    ok("parent null: a group named after the null, holding its children bottom to top",
       tree(doc.layers) === "Floor,Rig[Arm,Label]", tree(doc.layers));
    ok("parent null: group opacity 1 (parenting passes none), unrotated",
       g.type === "group" && g.frame.opacity === 1 && g.frame.rotation === 0, JSON.stringify(g.frame));
    ok("parent null: id from the null", g.id === "ae-40", g.id);
    ok("parent null: frame is the union of what its children draw (61x40 at 0,0)",
       near(g.frame.x, 0) && near(g.frame.y, 0) && near(g.frame.width, 61) && near(g.frame.height, 40),
       JSON.stringify(g.frame));
    ok("parent null: not reported as having nothing to draw", LazyLord.diagnostics.length === 0,
       JSON.stringify(LazyLord.diagnostics));
    LazyLord.applyOrigin(doc);
    var a = g.children[0], t = g.children[1];
    ok("parent null: its child is placed through it (10x20 at 95,100)",
       near(a.frame.x, 95) && near(a.frame.y, 100) && near(a.frame.width, 10) && near(a.frame.height, 20),
       JSON.stringify(a.frame));
    ok("parent null: text under it keeps the null's turn", t.type === "text" && near(t.frame.rotation, 90),
       String(t.frame.rotation));
    ok("parent null: children keep their own opacity", near(a.frame.opacity, 1) && near(t.frame.opacity, 1));

    // Chains of selected nulls nest.
    LazyLord.resetDiagnostics();
    var root = nullLayer("Root", transform([0, 0]));
    var mid = nullLayer("Mid", transform([50, 0]));
    mid.parent = root;
    var hand = shapeLayer("Hand", [rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], transform([0, 0]));
    hand.parent = mid;
    selectComp([hand, mid, root]);
    doc = LazyLord.readSelection("C:\\temp");
    ok("null chain: nested groups", tree(doc.layers) === "Root[Mid[Hand]]", tree(doc.layers));
    ok("null chain: both groups boxed by the one leaf",
       near(doc.layers[0].frame.width, 10) && near(doc.layers[0].children[0].frame.width, 10),
       JSON.stringify(doc.layers[0].frame));
    ok("null chain: nothing reported, one leaf", LazyLord.diagnostics.length === 0 &&
       LazyLord.countLeaves(doc.layers) === 1, JSON.stringify(LazyLord.diagnostics));

    // A shape-layer group under a null group nests as it is.
    LazyLord.resetDiagnostics();
    var holder = nullLayer("Holder", transform([0, 0]));
    var two = shapeLayer("Two", [
        vectorGroup([rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], { name: "One" }),
        vectorGroup([rectNode([10, 10], [20, 0]), fillNode([0, 0, 1, 1])], { name: "Other" })
    ], transform([100, 100]));
    two.parent = holder;
    selectComp([two, holder]);
    doc = LazyLord.readSelection("C:\\temp");
    ok("null over a painted-group layer: groups nest", tree(doc.layers) === "Holder[Two[Other,One]]", tree(doc.layers));
})();

// 40) An unselected parent leaves its child flat, but placed through it.
(function () {
    LazyLord.resetDiagnostics();
    var rig = nullLayer("Rig", transform([100, 100], { rotation: 90 }));
    var arm = shapeLayer("Arm", [rectNode([20, 10], [0, 0]), fillNode([1, 0, 0, 1])], transform([10, 0]));
    arm.parent = rig;
    selectComp([arm]);
    var doc = LazyLord.readSelection("C:\\temp");
    LazyLord.applyOrigin(doc);
    var a = doc.layers[0];
    ok("unselected parent: flat", tree(doc.layers) === "Arm" && a.type === "vector", tree(doc.layers));
    ok("unselected parent: placed through it all the same (10x20 at 95,100)",
       near(a.frame.x, 95) && near(a.frame.y, 100) && near(a.frame.width, 10) && near(a.frame.height, 20),
       JSON.stringify(a.frame));
    ok("unselected parent: nothing reported", LazyLord.diagnostics.length === 0, JSON.stringify(LazyLord.diagnostics));
})();

// 41) Null groups that cannot be kept as they were: empty, interleaved, looped;
//     and a null under a drawn parent.
(function () {
    LazyLord.resetDiagnostics();
    // Its only child is a precomp, which is not sent.
    var lonely = nullLayer("Lonely null", transform([0, 0]));
    var pre = makeLayer(AVLayer, "Inner comp", { "ADBE Transform Group": transform([0, 0]) });
    pre.source = new CompItem();
    pre.width = 10; pre.height = 10;
    pre.parent = lonely;
    // X sits between the null's two children in the stack.
    var n = nullLayer("N", transform([0, 0]));
    n.id = 77;
    var c1 = shapeLayer("C1", [rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], transform([100, 100]));
    var c2 = shapeLayer("C2", [rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], transform([200, 100]));
    var x = shapeLayer("X", [rectNode([10, 10], [0, 0]), fillNode([0, 1, 0, 1])], transform([300, 100]));
    c1.parent = n;
    c2.parent = n;
    // A null parented to a drawn (selected) layer is a top-level group.
    var base = shapeLayer("Base", [rectNode([10, 10], [0, 0]), fillNode([0, 0, 0, 1])], transform([400, 100]));
    var n2 = nullLayer("N2", transform([0, 0]));
    n2.parent = base;
    var c3 = shapeLayer("C3", [rectNode([10, 10], [0, 0]), fillNode([0, 0, 0, 1])], transform([0, 50]));
    c3.parent = n2;

    selectComp([pre, lonely, c2, x, c1, n, base, c3, n2]);
    var doc = LazyLord.readSelection("C:\\temp");

    // Grouping never reorders: X stays between C2 and C1, so N is sent as one
    // group on each side of it (this used to stack X above both).
    ok("null groups: the tree, split around X", tree(doc.layers) === "N[C2],X,N[C1],Base,N2[C3]", tree(doc.layers));
    ok("split null: the first run keeps the null's id, the next is numbered",
       doc.layers[0].id === "ae-77" && doc.layers[2].id === "ae-77-2", doc.layers[0].id + " " + doc.layers[2].id);
    ok("split null: each run boxed by its own layers (C2 at 195, C1 at 95)",
       near(doc.layers[0].frame.x + doc.bounds.x, 195) && near(doc.layers[2].frame.x + doc.bounds.x, 95) &&
       near(doc.layers[0].frame.width, 10) && near(doc.layers[2].frame.width, 10),
       JSON.stringify(doc.layers[0].frame) + " " + JSON.stringify(doc.layers[2].frame));
    ok("empty null group: reported, skipped",
       diagsWith("null object has nothing to draw", "could be sent").length === 1 &&
       diagsWith("could be sent")[0].object === "Lonely null" && diagsWith("could be sent")[0].resolution === "skipped",
       JSON.stringify(LazyLord.diagnostics));
    ok("interleaved null group: reported against the null, naming what sits between and the split",
       diagsWith("not next to each other", "'X'", "sent as 2 groups").length === 1 &&
       diagsWith("not next to each other")[0].object === "N" &&
       diagsWith("not next to each other")[0].resolution === "approximated", JSON.stringify(LazyLord.diagnostics));
    ok("interleaved null group: nothing is said to have moved", diagsWith("above").length === 0,
       JSON.stringify(LazyLord.diagnostics));
    ok("null under a drawn parent: placed through it (C3 at x 395 + 0)",
       near(doc.layers[4].children[0].frame.x + doc.bounds.x, 395), String(doc.layers[4].children[0].frame.x));
    ok("null groups: the precomp, the empty null and the interleave, nothing else",
       LazyLord.diagnostics.length === 3 && diagsWith("Precomps").length === 1, JSON.stringify(LazyLord.diagnostics));
    ok("null groups: flattened, the leaves stack exactly as in the comp",
       names(LazyLord.flattenLayers(doc.layers)) === "C2,X,C1,Base,C3", names(LazyLord.flattenLayers(doc.layers)));

    // Two selected nulls parented to each other (After Effects refuses this): cut, not followed forever.
    LazyLord.resetDiagnostics();
    var la = nullLayer("Loop A", transform([0, 0]));
    var lb = nullLayer("Loop B", transform([0, 0]));
    la.parent = lb;
    lb.parent = la;
    var s = shapeLayer("Swing", [rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], transform([100, 100]));
    s.parent = la;
    selectComp([s, la, lb]);
    doc = LazyLord.readSelection("C:\\temp");
    ok("null loop: the shape is sent once, inside a group",
       LazyLord.countLeaves(doc.layers) === 1 && doc.layers.length === 1 && doc.layers[0].type === "group",
       tree(doc.layers));
})();

// 42) Nulls whose layers are interleaved never change the stack: each becomes
//     one group per unbroken run, so the default split + flatten transfer
//     stacks every leaf exactly as After Effects does.
(function () {
    function box(name, x) {
        return shapeLayer(name, [rectNode([10, 10], [0, 0]), fillNode([1, 0, 0, 1])], transform([x, 100]));
    }

    // Two nulls taking turns: L0 and L2 under N1, L1 and L3 under N2.
    LazyLord.resetDiagnostics();
    var n1 = nullLayer("N1", transform([0, 0]));
    var n2 = nullLayer("N2", transform([0, 0]));
    n1.id = 11; n2.id = 12;
    var l0 = box("L0", 100), l1 = box("L1", 200), l2 = box("L2", 300), l3 = box("L3", 400);
    l0.parent = n1; l2.parent = n1;
    l1.parent = n2; l3.parent = n2;
    selectComp([l0, l1, l2, l3, n1, n2]);
    var doc = LazyLord.readSelection("C:\\temp");
    ok("alternating nulls: a group per run, in stack order",
       tree(doc.layers) === "N1[L0],N2[L1],N1[L2],N2[L3]", tree(doc.layers));
    ok("alternating nulls: ids numbered per null",
       doc.layers[0].id === "ae-11" && doc.layers[1].id === "ae-12" &&
       doc.layers[2].id === "ae-11-2" && doc.layers[3].id === "ae-12-2",
       doc.layers[0].id + " " + doc.layers[1].id + " " + doc.layers[2].id + " " + doc.layers[3].id);
    ok("alternating nulls: flattened (the default), the stack is After Effects' own",
       names(LazyLord.flattenLayers(doc.layers)) === "L0,L1,L2,L3", names(LazyLord.flattenLayers(doc.layers)));
    ok("alternating nulls: each null reported once, naming the layer between its own",
       LazyLord.diagnostics.length === 2 &&
       diagsWith("'L1'", "sent as 2 groups").length === 1 && diagsWith("'L1'")[0].object === "N1" &&
       diagsWith("'L2'", "sent as 2 groups").length === 1 && diagsWith("'L2'")[0].object === "N2" &&
       allApproximated(), JSON.stringify(LazyLord.diagnostics));
    ok("alternating nulls: nothing is said to sit above or below anything", diagsWith("above").length === 0 &&
       diagsWith("below").length === 0, JSON.stringify(LazyLord.diagnostics));

    // The common rig: a Body null holding Arm R, Torso and Arm L, with a Head
    // parented to Torso (a drawn layer, so no group) between them.
    LazyLord.resetDiagnostics();
    var body = nullLayer("Body", transform([0, 0]));
    var armR = box("Arm R", 100), torso = box("Torso", 200), head = box("Head", 0), armL = box("Arm L", 300);
    armR.parent = body; torso.parent = body; armL.parent = body;
    head.parent = torso;
    selectComp([armR, torso, head, armL, body]);
    doc = LazyLord.readSelection("C:\\temp");
    ok("rig: Head stays between Torso and Arm L", tree(doc.layers) === "Body[Arm R,Torso],Head,Body[Arm L]",
       tree(doc.layers));
    ok("rig: flattened, the comp's order", names(LazyLord.flattenLayers(doc.layers)) === "Arm R,Torso,Head,Arm L",
       names(LazyLord.flattenLayers(doc.layers)));
    ok("rig: reported once against Body, naming Head",
       LazyLord.diagnostics.length === 1 && diagsWith("'Head' sits between them", "sent as 2 groups").length === 1 &&
       LazyLord.diagnostics[0].object === "Body", JSON.stringify(LazyLord.diagnostics));
    LazyLord.applyOrigin(doc);
    ok("rig: Head still placed through Torso (x 200 + 0 - 5)", near(doc.layers[1].frame.x, 195),
       String(doc.layers[1].frame.x));

    // Nested: Root holds Mid and B; Mid holds A and C with B between them.
    // Root's layers are unbroken, so only Mid splits, inside the one Root.
    LazyLord.resetDiagnostics();
    var root = nullLayer("Root", transform([0, 0]));
    var mid = nullLayer("Mid", transform([0, 0]));
    root.id = 21; mid.id = 22;
    mid.parent = root;
    var a = box("A", 100), b = box("B", 200), c = box("C", 300);
    a.parent = mid; c.parent = mid; b.parent = root;
    selectComp([a, b, c, mid, root]);
    doc = LazyLord.readSelection("C:\\temp");
    ok("nested split: one Root, Mid split around B", tree(doc.layers) === "Root[Mid[A],B,Mid[C]]", tree(doc.layers));
    ok("nested split: Mid's runs numbered, Root's box spans all three",
       doc.layers[0].children[0].id === "ae-22" && doc.layers[0].children[2].id === "ae-22-2" &&
       near(doc.layers[0].frame.width, 210), doc.layers[0].children[2].id + " " + doc.layers[0].frame.width);
    ok("nested split: only Mid reported",
       LazyLord.diagnostics.length === 1 && LazyLord.diagnostics[0].object === "Mid" &&
       diagsWith("'B' sits between them").length === 1, JSON.stringify(LazyLord.diagnostics));
    ok("nested split: flattened, the comp's order", names(LazyLord.flattenLayers(doc.layers)) === "A,B,C",
       names(LazyLord.flattenLayers(doc.layers)));

    // Several layers between: all named, the sentence in the plural.
    LazyLord.resetDiagnostics();
    var pair = nullLayer("Pair", transform([0, 0]));
    var p1 = box("P1", 100), q1 = box("Q1", 200), q2 = box("Q2", 300), p2 = box("P2", 400);
    p1.parent = pair; p2.parent = pair;
    selectComp([p1, q1, q2, p2, pair]);
    doc = LazyLord.readSelection("C:\\temp");
    ok("several between: Pair[P1],Q1,Q2,Pair[P2]", tree(doc.layers) === "Pair[P1],Q1,Q2,Pair[P2]", tree(doc.layers));
    ok("several between: both named, plural",
       diagsWith("'Q1' and 'Q2' sit between them", "sent as 2 groups").length === 1, JSON.stringify(LazyLord.diagnostics));

    // A layer between them that is not sent (a disabled one, a precomp) is
    // not in the transfer, so it does not break the run.
    LazyLord.resetDiagnostics();
    var hold = nullLayer("Hold", transform([0, 0]));
    var h1 = box("H1", 100), h2 = box("H2", 300);
    var off = box("Off", 200);
    off.enabled = false;
    var pre = makeLayer(AVLayer, "Inner comp", { "ADBE Transform Group": transform([0, 0]) });
    pre.source = new CompItem();
    pre.width = 10; pre.height = 10;
    h1.parent = hold; h2.parent = hold;
    selectComp([h1, off, pre, h2, hold]);
    doc = LazyLord.readSelection("C:\\temp");
    ok("unsent layer between: one group", tree(doc.layers) === "Hold[H1,H2]", tree(doc.layers));
    ok("unsent layer between: only the precomp reported", LazyLord.diagnostics.length === 1 &&
       diagsWith("Precomps").length === 1, JSON.stringify(LazyLord.diagnostics));
})();

// 43) A paint that cannot be read (a gradient, an unreadable colour) is
//     reported with what is really sent in its place.
(function () {
    function layerWith(name, contents, x) {
        return shapeLayer(name, [rectNode([10, 10], [0, 0])].concat(contents), transform([x, 100]));
    }
    var broken = node("ADBE Vector Graphic - Fill", { name: "Broken fill", children: [
        node("ADBE Vector Fill Opacity", { value: 100 })
    ]});

    function run(layer) {
        LazyLord.resetDiagnostics();
        selectComp([layer]);
        return LazyLord.readSelection("C:\\temp").layers[0];
    }

    // A gradient listed above a solid fill: AE shows the gradient; the solid is sent.
    var v = run(layerWith("Over solid", [gfillNode(), fillNode([1, 0, 0, 1])], 100));
    ok("gradient over a solid fill: the solid is sent", v.type === "vector" && v.fills.length === 1 &&
       near(v.fills[0].color.r, 1), JSON.stringify(v.fills));
    ok("gradient over a solid fill: approximated, naming both, never 'unfilled'",
       LazyLord.diagnostics.length === 1 && LazyLord.diagnostics[0].resolution === "approximated" &&
       diagsWith("'Gradient Fill 1'", "gradient fills cannot be read", "'Fill 1'", "in its place").length === 1 &&
       diagsWith("unfilled").length === 0 && LazyLord.diagnostics[0].object === "Over solid",
       JSON.stringify(LazyLord.diagnostics));

    // A gradient alone: nothing is sent in its place.
    v = run(layerWith("Alone", [gfillNode()], 100));
    ok("gradient alone: arrives unfilled, skipped", v.fills.length === 0 && LazyLord.diagnostics.length === 1 &&
       diagsWith("'Gradient Fill 1'", "arrive unfilled").length === 1 &&
       LazyLord.diagnostics[0].resolution === "skipped", JSON.stringify(LazyLord.diagnostics));

    // A gradient above its paths paints nothing: nothing to report.
    v = run(shapeLayer("Stray gradient", [gfillNode(), rectNode([10, 10], [0, 0]), fillNode([0, 0, 1, 1])],
        transform([100, 100])));
    ok("gradient above its paths: paints nothing, not reported", near(v.fills[0].color.b, 1) &&
       LazyLord.diagnostics.length === 0, JSON.stringify(LazyLord.diagnostics));

    // A gradient listed under a solid fill: the solid shows and is sent; the gradient is left out.
    v = run(layerWith("Under solid", [fillNode([1, 0, 0, 1]), gfillNode()], 100));
    ok("gradient under a solid fill: the solid is sent", v.fills.length === 1 && near(v.fills[0].color.r, 1),
       JSON.stringify(v.fills));
    ok("gradient under a solid fill: left out, skipped, never 'unfilled' or 'in its place'",
       LazyLord.diagnostics.length === 1 && diagsWith("'Gradient Fill 1'", "left out").length === 1 &&
       diagsWith("unfilled").length === 0 && diagsWith("in its place").length === 0 &&
       LazyLord.diagnostics[0].resolution === "skipped", JSON.stringify(LazyLord.diagnostics));

    // Gradient strokes: worded as strokes.
    v = run(layerWith("Stroke swap", [gstrokeNode(), strokeNode([0, 0, 0, 1], 3)], 100));
    ok("gradient over a solid stroke: the stroke is sent", v.strokes.length === 1 && near(v.strokes[0].weight, 3),
       JSON.stringify(v.strokes));
    ok("gradient over a solid stroke: approximated, as a stroke",
       LazyLord.diagnostics.length === 1 && LazyLord.diagnostics[0].resolution === "approximated" &&
       diagsWith("'Gradient Stroke 1' is a gradient stroke", "the stroke listed below it", "in its place").length === 1,
       JSON.stringify(LazyLord.diagnostics));
    v = run(layerWith("Stroke gone", [gstrokeNode(), fillNode([1, 0, 0, 1])], 100));
    ok("gradient stroke over a fill only: filled, no stroke", v.fills.length === 1 && v.strokes.length === 0,
       JSON.stringify(v.strokes));
    ok("gradient stroke over a fill only: 'without a stroke', skipped, never 'unfilled'",
       LazyLord.diagnostics.length === 1 && diagsWith("arrive without a stroke").length === 1 &&
       diagsWith("unfilled").length === 0 && LazyLord.diagnostics[0].resolution === "skipped",
       JSON.stringify(LazyLord.diagnostics));

    // An unreadable colour with a readable fill below it: that fill is sent in its place.
    v = run(layerWith("Half broken", [broken, fillNode([0, 0, 1, 1])], 100));
    ok("unreadable colour over a fill: the fill below is sent", v.fills.length === 1 && near(v.fills[0].color.b, 1),
       JSON.stringify(v.fills));
    ok("unreadable colour over a fill: approximated, naming both",
       LazyLord.diagnostics.length === 1 && LazyLord.diagnostics[0].resolution === "approximated" &&
       diagsWith("The colour of 'Broken fill' could not be read", "'Fill 1'", "in its place").length === 1,
       JSON.stringify(LazyLord.diagnostics));

    // Two gradients over a solid: the top one is replaced, the second left out.
    v = run(layerWith("Two gradients", [gfillNode("Top gradient"), gfillNode("Second gradient"),
        fillNode([1, 0, 0, 1])], 100));
    ok("two gradients over a solid: one report each, the solid sent",
       near(v.fills[0].color.r, 1) && LazyLord.diagnostics.length === 2 &&
       diagsWith("'Top gradient'", "in its place").length === 1 && diagsWith("'Second gradient'", "left out").length === 1,
       JSON.stringify(LazyLord.diagnostics));

    // A gradient in a nested group is reported once, with its own set, even
    // though a root fill paints the same paths as a vector of its own.
    v = run(shapeLayer("Nested gradient", [
        vectorGroup([rectNode([10, 10], [0, 0]), gfillNode()], { name: "Inner" }),
        fillNode([0, 1, 0, 1])
    ], transform([100, 100])));
    ok("nested gradient: the root fill still paints its own vector",
       tree([v]) === "Nested gradient[Nested gradient,Inner]" && near(v.children[0].fills[0].color.g, 1) &&
       v.children[1].fills.length === 0, tree([v]));
    ok("nested gradient: reported once, unfilled", LazyLord.diagnostics.length === 1 &&
       diagsWith("'Gradient Fill 1'", "arrive unfilled").length === 1, JSON.stringify(LazyLord.diagnostics));
})();

// Live sync: the stamp the panel polls.
(function () {
    var box = shapeLayer("Box", [rectNode([100, 50], [0, 0]), fillNode([1, 0, 0, 1])], transform([200, 300]));
    var comp = selectComp([box]);
    var s1 = LazyLord.liveStamp();
    ok("live stamp: a selection gives one", /^[0-9a-z]+\.[0-9a-z]+$/.test(s1), s1);
    ok("live stamp: the same each time", LazyLord.liveStamp() === s1);
    comp.time = 5;
    ok("live stamp: the playhead is not a change", LazyLord.liveStamp() === s1);
    box.property("ADBE Transform Group").property("ADBE Position").value = [210, 300];
    var s2 = LazyLord.liveStamp();
    ok("live stamp: a moved layer changes it", s2 !== s1, s2);
    box.property("ADBE Root Vectors Group").property(2).property("ADBE Vector Fill Color").value = [0, 0, 1, 1];
    ok("live stamp: a recolour changes it", LazyLord.liveStamp() !== s2);
    comp.selectedLayers = [];
    ok("live stamp: nothing selected is empty", LazyLord.liveStamp() === "");
})();

WScript.Echo("");
WScript.Echo(passed + " passed, " + failed + " failed.");
WScript.Quit(failed === 0 ? 0 : 1);
