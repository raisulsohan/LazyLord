/*
 * LazyLord — Illustrator reader tests (no Node required).
 *
 *   cscript //Nologo tools\test-illustrator-reader.js
 *
 * Runs the real jsx/ai-read.jsx against a mocked Illustrator DOM under Windows
 * Script Host, whose JScript engine is ES3 like ExtendScript. This covers the
 * riskiest maths in the push path: the y-up to y-down flip, bezier tangent
 * signs, frame normalisation and artboard-origin placement — plus clipping
 * masks in frame space, real gradient vectors, primitive detection, the
 * artboard canvas, the rotation (and mirror and scale) text frames and linked
 * images keep in their matrix, stacking order (Illustrator lists front to
 * back, the IR bottom to top) and groups carried as IR groups — which,
 * flattened, give back the flat list the reader sent before — with the
 * opacity of unselected groups and layers around the selection reported, and
 * a path picked out of a compound path sent as the whole compound path.
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

// Returns cleaned source; it must be eval'd at GLOBAL scope so the scripts'
// own `var` declarations become globals (JScript evals in the caller's scope).
function load(name) {
    return read(JSX + name).replace(/^\s*#[a-zA-Z].*$/gm, "");
}

// --- Minimal Illustrator stand-ins ----------------------------------------
var TextType = { POINTTEXT: "point", AREATEXT: "area" };
var TextOrientation = { HORIZONTAL: "horiz", VERTICAL: "vert" };
var Justification = { LEFT: "l", CENTER: "c", RIGHT: "r", FULLJUSTIFY: "f", FULLJUSTIFYLASTLINELEFT: "fl" };
var GradientType = { LINEAR: "lin", RADIAL: "rad" };
var StrokeCap = { BUTTENDED: "butt", ROUNDENDED: "round", PROJECTINGENDED: "proj" };
var StrokeJoin = { MITERENDED: "miter", ROUNDENDED: "round", BEVELENDED: "bevel" };

var KAPPA = 0.5522847498307936;

function pt(anchor, left, right) {
    return { anchor: anchor, leftDirection: left || anchor, rightDirection: right || anchor };
}

function rgb(r, g, b) {
    return { typename: "RGBColor", red: r, green: g, blue: b };
}

// A 100x100 square. Illustrator is y-up, so the TOP edge has the LARGER y.
function squarePath() {
    return {
        typename: "PathItem",
        name: "Square",
        closed: true,
        filled: true,
        stroked: false,
        opacity: 100,
        hidden: false,
        clipping: false,
        guides: false,
        fillColor: rgb(255, 0, 0),
        // geometricBounds = [left, top, right, bottom]
        geometricBounds: [100, 500, 200, 400],
        pathPoints: [
            // top-left anchor, with an out-handle pointing UP in Illustrator (+y)
            pt([100, 500], [100, 500], [100, 530]),
            pt([200, 500]),
            pt([200, 400]),
            pt([100, 400])
        ]
    };
}

// [left, top, right, bottom] of the anchors. Every test shape keeps its
// handles inside that box, so it is also the geometric bounds.
function boundsOf(points) {
    var l = Infinity, t = -Infinity, r = -Infinity, b = Infinity;
    for (var i = 0; i < points.length; i++) {
        var a = points[i].anchor;
        if (a[0] < l) l = a[0];
        if (a[0] > r) r = a[0];
        if (a[1] > t) t = a[1];
        if (a[1] < b) b = a[1];
    }
    return [l, t, r, b];
}

function pathItem(name, points, opts) {
    opts = opts || {};
    var p = {
        typename: "PathItem",
        name: name,
        closed: opts.closed !== false,
        filled: !!opts.fillColor,
        stroked: !!opts.strokeColor,
        opacity: opts.opacity === undefined ? 100 : opts.opacity,
        hidden: false,
        clipping: !!opts.clipping,
        guides: false,
        fillColor: opts.fillColor || null,
        strokeColor: opts.strokeColor || null,
        strokeWidth: 2,
        geometricBounds: opts.gb || boundsOf(points),
        pathPoints: points
    };
    if (opts.uuid) p.uuid = opts.uuid;
    return p;
}

function compoundItem(name, paths) {
    var l = Infinity, t = -Infinity, r = -Infinity, b = Infinity;
    for (var i = 0; i < paths.length; i++) {
        var gb = paths[i].geometricBounds;
        if (gb[0] < l) l = gb[0];
        if (gb[1] > t) t = gb[1];
        if (gb[2] > r) r = gb[2];
        if (gb[3] < b) b = gb[3];
    }
    return {
        typename: "CompoundPathItem", name: name, opacity: 100, hidden: false, guides: false,
        geometricBounds: [l, t, r, b], pathItems: paths
    };
}

function groupItem(name, kids, clipped) {
    return { typename: "GroupItem", name: name, hidden: false, guides: false, clipped: !!clipped, pageItems: kids };
}

function rectPts(l, t, r, b) {
    return [pt([l, t]), pt([r, t]), pt([r, b]), pt([l, b])];
}

// Reversing a path's direction swaps every point's in and out handles.
function reversePts(pts) {
    var out = [];
    for (var i = pts.length - 1; i >= 0; i--) out.push(pt(pts[i].anchor, pts[i].rightDirection, pts[i].leftDirection));
    return out;
}

// Start the same outline n points later.
function rotatePts(pts, n) {
    return pts.slice(n).concat(pts.slice(0, n));
}

// Ellipse in Illustrator's y-up space, drawn left -> top -> right -> bottom
// (clockwise on screen). k is the handle factor (KAPPA for a true ellipse).
function ellipsePts(l, t, r, b, k) {
    var cx = (l + r) / 2, cy = (t + b) / 2;
    var hx = k * (r - l) / 2, hy = k * (t - b) / 2;
    return [
        pt([l, cy], [l, cy - hy], [l, cy + hy]),
        pt([cx, t], [cx - hx, t], [cx + hx, t]),
        pt([r, cy], [r, cy + hy], [r, cy - hy]),
        pt([cx, b], [cx + hx, b], [cx - hx, b])
    ];
}

// Rounded rectangle, clockwise on screen, starting where the top edge leaves
// the top-left corner. k is the corner handle factor (KAPPA for round corners).
function roundRectPts(l, t, r, b, rad, k) {
    var h = k * rad;
    return [
        pt([l + rad, t], [l + rad - h, t], [l + rad, t]),
        pt([r - rad, t], [r - rad, t], [r - rad + h, t]),
        pt([r, t - rad], [r, t - rad + h], [r, t - rad]),
        pt([r, b + rad], [r, b + rad], [r, b + rad - h]),
        pt([r - rad, b], [r - rad + h, b], [r - rad, b]),
        pt([l + rad, b], [l + rad, b], [l + rad - h, b]),
        pt([l, b + rad], [l, b + rad - h], [l, b + rad]),
        pt([l, t - rad], [l, t - rad], [l, t - rad + h])
    ];
}

// Illustrator's Matrix object (the scripting reference names its coefficients
// mValueA .. mValueTY). Points map as x' = a*x + c*y + tx, y' = b*x + d*y + ty.
function mx(a, b, c, d, tx, ty) {
    return { typename: "Matrix", mValueA: a, mValueB: b, mValueC: c, mValueD: d, mValueTX: tx, mValueTY: ty };
}

// A two-stop red -> half-transparent blue gradient. Pass origin/length as
// undefined to model a GradientColor whose vector cannot be read. Its matrix
// is the identity, as when the gradient has just been applied; pass
// { matrix: ... } in `extra` for an object transformed afterwards.
function gradientColor(type, origin, angle, length, extra) {
    var gc = {
        typename: "GradientColor",
        gradient: { type: type, gradientStops: [
            { rampPoint: 0, midPoint: 50, opacity: 100, color: rgb(255, 0, 0) },
            { rampPoint: 100, midPoint: 50, opacity: 50, color: rgb(0, 0, 255) }
        ]},
        angle: angle,
        hiliteLength: 0,
        hiliteAngle: 0,
        matrix: mx(1, 0, 0, 1, 0, 0)
    };
    if (origin) gc.origin = origin;
    if (length !== undefined) gc.length = length;
    if (extra) for (var k in extra) gc[k] = extra[k];
    return gc;
}

var app = {
    documents: { length: 1 },
    activeDocument: {
        name: "test.ai",
        artboards: {
            getActiveArtboardIndex: function () { return 0; },
            0: { artboardRect: [0, 600, 800, 0], name: "Artboard 1" } // left 0, top 600
        }
    },
    selection: [squarePath()]
};
app.activeDocument.artboards.length = 1;

// --- Load the real code (global scope) -------------------------------------
eval(load("json2.js"));
eval(load("lazylord.jsx"));
eval(load("ai.jsx")); // the panel loads the builder too; the live stamp uses its fingerprint
eval(load("ai-read.jsx"));

// --- Assertions ------------------------------------------------------------
var passed = 0, failed = 0;

function ok(name, cond, detail) {
    if (cond) { WScript.Echo("  ok   " + name); passed++; }
    else { WScript.Echo("  FAIL " + name + (detail ? "  -> " + detail : "")); failed++; }
}
function near(a, b, eps) { return Math.abs(a - b) < (eps || 1e-6); }
function xy(p) { return "[" + p[0] + "," + p[1] + "]"; }
function uv(p) { return "(" + p.x + "," + p.y + ")"; }
function nearUV(p, x, y) { return !!p && near(p.x, x, 1e-9) && near(p.y, y, 1e-9); }

// Select `items`, clear diagnostics and read.
function readSel(items) {
    app.selection = items;
    LazyLord.resetDiagnostics();
    return LazyLord.readSelection("C:\\temp");
}
function warned(text, resolution) {
    for (var i = 0; i < LazyLord.diagnostics.length; i++) {
        var d = LazyLord.diagnostics[i];
        if (d.reason.indexOf(text) >= 0 && (!resolution || d.resolution === resolution)) return true;
    }
    return false;
}
function diags() { return JSON.stringify(LazyLord.diagnostics); }
// The leaf layers of a document, bottom to top, groups looked through. Unlike
// LazyLord.flattenLayers this leaves every frame as it is.
function leavesOf(doc) {
    var out = [];
    LazyLord.eachLayer(doc.layers, function (l) { if (l.type !== "group") out.push(l); });
    return out;
}
function names(list) {
    var s = [];
    for (var i = 0; i < list.length; i++) s.push(list[i].name);
    return s.join(",");
}
// "" when a and b hold the same values (numbers to 1e-9, arrays in order,
// objects with the same keys), else the path to the first difference.
function sameTree(a, b, path) {
    if (typeof a === "number" && typeof b === "number") return near(a, b, 1e-9) ? "" : path + ": " + a + " vs " + b;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
        return a === b ? "" : path + ": " + JSON.stringify(a) + " vs " + JSON.stringify(b);
    }
    var arrA = a instanceof Array, arrB = b instanceof Array;
    if (arrA !== arrB) return path + ": array vs object";
    var k, d;
    if (arrA) {
        // Indices only: flattenLayers hangs `lossy` on its list.
        if (a.length !== b.length) return path + ": length " + a.length + " vs " + b.length;
        for (k = 0; k < a.length; k++) {
            d = sameTree(a[k], b[k], path + "[" + k + "]");
            if (d) return d;
        }
        return "";
    }
    for (k in a) {
        if (!(k in b) && a[k] !== undefined) return path + "." + k + ": missing";
    }
    for (k in b) {
        if (!(k in a) && b[k] !== undefined) return path + "." + k + ": unexpected";
        d = sameTree(a[k], b[k], path + "." + k);
        if (d) return d;
    }
    return "";
}
// Layer ids made by the reader's counter ("ai-1", ...) replaced with "ai-#",
// all the way down; uuids are left alone. Returns the same list.
function counterIds(list) {
    LazyLord.eachLayer(list, function (l) { if (/^ai-\d+$/.test(l.id)) l.id = "ai-#"; });
    return list;
}

WScript.Echo("LazyLord - Illustrator reader (mocked DOM)");
WScript.Echo("");

var doc = LazyLord.readSelection("C:\\temp");

ok("one layer produced", doc.layers.length === 1, "got " + doc.layers.length);
ok("source is illustrator", doc.source === "illustrator", doc.source);
ok("originSpace is document", doc.originSpace === "document", doc.originSpace);

// The square sits 100pt right of and 100pt below the artboard's top-left.
ok("bounds.x = 100", near(doc.bounds.x, 100), String(doc.bounds.x));
ok("bounds.y = 100 (y-flipped from AI top=500)", near(doc.bounds.y, 100), String(doc.bounds.y));
ok("bounds 100x100", near(doc.bounds.width, 100) && near(doc.bounds.height, 100),
   doc.bounds.width + "x" + doc.bounds.height);

// The page the bounds are measured from travels along, for document creation.
ok("canvas is the 800x600 artboard",
   !!doc.canvas && near(doc.canvas.width, 800) && near(doc.canvas.height, 600), JSON.stringify(doc.canvas));
ok("canvas carries the artboard name", !!doc.canvas && doc.canvas.name === "Artboard 1", JSON.stringify(doc.canvas));

var layer = doc.layers[0];
ok("layer is a vector", layer.type === "vector", layer.type);
ok("frame normalised to 0,0", near(layer.frame.x, 0) && near(layer.frame.y, 0),
   layer.frame.x + "," + layer.frame.y);
ok("rotation left at 0 (AI bakes it into geometry)", layer.frame.rotation === 0);
ok("fill read as solid red",
   layer.fills.length === 1 && layer.fills[0].type === "solid" && near(layer.fills[0].color.r, 1),
   JSON.stringify(layer.fills));
ok("a square with a curved handle is not a primitive", layer.primitive === undefined, JSON.stringify(layer.primitive));
ok("an unclipped layer has no clip", layer.clip === undefined);

var sp = layer.subpaths[0];
ok("subpath closed", sp.closed === true);
ok("4 vertices", sp.vertices.length === 4, String(sp.vertices.length));

// Y-down local space: AI top-left (100,500) becomes local (0,0), and the
// AI bottom edge (y=400) becomes local y=100.
ok("v0 top-left  -> [0,0]",     near(sp.vertices[0][0], 0)   && near(sp.vertices[0][1], 0),   xy(sp.vertices[0]));
ok("v1 top-right -> [100,0]",   near(sp.vertices[1][0], 100) && near(sp.vertices[1][1], 0),   xy(sp.vertices[1]));
ok("v2 bot-right -> [100,100]", near(sp.vertices[2][0], 100) && near(sp.vertices[2][1], 100), xy(sp.vertices[2]));
ok("v3 bot-left  -> [0,100]",   near(sp.vertices[3][0], 0)   && near(sp.vertices[3][1], 100), xy(sp.vertices[3]));

// The handle pointed UP in Illustrator (+30 in y-up), so in the y-down IR it
// must come out as -30. Getting this sign wrong mirrors every curve.
ok("out-tangent y flips to -30", near(sp.outTangents[0][1], -30), xy(sp.outTangents[0]));
ok("out-tangent x unchanged",    near(sp.outTangents[0][0], 0),   xy(sp.outTangents[0]));

// applyOrigin puts document-space artwork back where it sat on the artboard.
LazyLord.applyOrigin(doc);
ok("applyOrigin shifts to artboard position (100,100)",
   near(doc.layers[0].frame.x, 100) && near(doc.layers[0].frame.y, 100),
   doc.layers[0].frame.x + "," + doc.layers[0].frame.y);

// A canvas-space document (Figma) must not be shifted.
var canvasDoc = {
    originSpace: "canvas",
    bounds: { x: 4000, y: 2500, width: 10, height: 10 },
    layers: [{ frame: { x: 0, y: 0 } }]
};
LazyLord.applyOrigin(canvasDoc);
ok("applyOrigin ignores canvas-space sources",
   canvasDoc.layers[0].frame.x === 0 && canvasDoc.layers[0].frame.y === 0);

// Text anchoring: exact when the source knew the baseline, estimated otherwise.
var exact = LazyLord.textAnchor({ frame: { x: 10, y: 20, width: 100 }, fontSize: 50, baseline: 63, anchorX: 12 });
ok("textAnchor uses the real baseline", near(exact[0], 12) && near(exact[1], 63), xy(exact));

var est = LazyLord.textAnchor({ frame: { x: 10, y: 20, width: 100 }, fontSize: 50, textAlignHorizontal: "left" });
ok("textAnchor falls back to 0.8 em", near(est[0], 10) && near(est[1], 60), xy(est));

var centred = LazyLord.textAnchor({ frame: { x: 10, y: 20, width: 100 }, fontSize: 50, textAlignHorizontal: "center" });
ok("textAnchor centres without an anchorX", near(centred[0], 60), xy(centred));

// Gradient fills must be reported, not silently flattened.
LazyLord.resetDiagnostics();
LazyLord.noteGradient({ name: "Blob", fills: [{ type: "linear-gradient", stops: [] }] });
ok("gradient raises a diagnostic", LazyLord.diagnostics.length === 1, JSON.stringify(LazyLord.diagnostics));
ok("gradient marked as approximated",
   LazyLord.diagnostics.length === 1 && LazyLord.diagnostics[0].resolution === "approximated");

LazyLord.resetDiagnostics();
LazyLord.noteGradient({ name: "Blob", fills: [{ type: "solid", color: {} }] });
ok("solid fill raises nothing", LazyLord.diagnostics.length === 0);

// --- Opacity ---------------------------------------------------------------
(function () {
    var l = readSel([pathItem("Half", rectPts(100, 500, 200, 400), { fillColor: rgb(255, 0, 0), opacity: 50 })]).layers[0];
    ok("opacity: carried once, as frame opacity", near(l.frame.opacity, 0.5), String(l.frame.opacity));
    ok("opacity: not folded into the fill colour as well", near(l.fills[0].color.a, 1), JSON.stringify(l.fills[0].color));
})();

// --- Stacking order ---------------------------------------------------------
// Illustrator lists the selection and a group's pageItems front to back
// (index 0 is the topmost object); the IR lists layers bottom to top.
(function () {
    var top = pathItem("Top", rectPts(100, 500, 200, 400), { fillColor: rgb(255, 0, 0) });
    var bottom = pathItem("Bottom", rectPts(150, 450, 250, 350), { fillColor: rgb(0, 0, 255) });
    var doc = readSel([top, bottom]);
    ok("order: a plain selection comes out bottom to top", names(doc.layers) === "Bottom,Top", names(doc.layers));

    doc = readSel([groupItem("G", [top, bottom])]);
    var g = doc.layers[0];
    ok("order: a group's children come out bottom to top",
       doc.layers.length === 1 && g.type === "group" && names(g.children) === "Bottom,Top", names(g.children || []));

    // Front, then a sub-group of two, then Back: bottom to top that is Back,
    // the sub-group's own back-most, its front-most, then Front.
    var mk = function (n, x) { return pathItem(n, rectPts(x, 500, x + 50, 450), { fillColor: rgb(1, 2, 3) }); };
    doc = readSel([groupItem("G", [mk("Front", 100), groupItem("Sub", [mk("Mid front", 150), mk("Mid back", 200)]),
        mk("Back", 250)])]);
    ok("order: nested groups stack bottom to top all the way down",
       names(leavesOf(doc)) === "Back,Mid back,Mid front,Front", names(leavesOf(doc)));
})();

// --- Groups -----------------------------------------------------------------
(function () {
    // Two squares 100pt apart in a group at 50%: AI (100..200) and (300..400).
    var a = pathItem("A", rectPts(100, 500, 200, 400), { fillColor: rgb(255, 0, 0) });
    var b = pathItem("B", rectPts(300, 450, 400, 350), { fillColor: rgb(0, 0, 255) });
    var grp = groupItem("Pair", [a, b]);
    grp.opacity = 50;
    grp.uuid = "group-uuid-1";
    var doc = readSel([grp]);
    var g = doc.layers[0];
    ok("group: sent as an IR group", doc.layers.length === 1 && g.type === "group" && g.children.length === 2,
       doc.layers.length + " " + g.type);
    ok("group: named after it, with its uuid as the id", g.name === "Pair" && g.id === "group-uuid-1", g.name + " " + g.id);
    ok("group: its opacity is its own, on the group", near(g.frame.opacity, 0.5), String(g.frame.opacity));
    ok("group: not multiplied into its layers as well", near(g.children[0].frame.opacity, 1) &&
       near(g.children[1].frame.opacity, 1), g.children[0].frame.opacity + "," + g.children[1].frame.opacity);
    ok("group: nothing reported by the reader (the target decides)", LazyLord.diagnostics.length === 0, diags());
    // Selection top-left is IR (100, 100); B sits at IR (300, 150).
    ok("group: frame is the union of its layers, never rotated",
       near(g.frame.x, 0) && near(g.frame.y, 0) && near(g.frame.width, 300) && near(g.frame.height, 150) &&
       g.frame.rotation === 0, fr(g.frame));
    var lb = g.children[0];
    ok("group: children keep frames in frame space, not relative to the group",
       lb.name === "B" && near(lb.frame.x, 200) && near(lb.frame.y, 50), lb.name + " " + fr(lb.frame));

    // The default (split + flatten) target path: the group's opacity reaches
    // the leaves through LazyLord.flattenLayers, and two of them make it lossy.
    var flat = LazyLord.flattenLayers(doc.layers);
    ok("group: flattened, each leaf gets the group's 50%",
       flat.length === 2 && near(flat[0].frame.opacity, 0.5) && near(flat[1].frame.opacity, 0.5) && flat.lossy === 1,
       flat.length + " " + flat.lossy);

    // applyOrigin moves a group and its children together, each once.
    doc = readSel([groupItem("Pair", [pathItem("A", rectPts(100, 500, 200, 400)), pathItem("B", rectPts(300, 450, 400, 350))])]);
    LazyLord.applyOrigin(doc);
    g = doc.layers[0];
    ok("group: applyOrigin puts the group and its layers where they sat on the artboard",
       near(g.frame.x, 100) && near(g.frame.y, 100) && near(g.children[0].frame.x, 300) && near(g.children[0].frame.y, 150),
       fr(g.frame) + " " + fr(g.children[0].frame));
    ok("group: an unnamed group without a uuid gets a name and an id", (function () {
        var d = readSel([groupItem("", [pathItem("A", rectPts(100, 500, 200, 400))])]);
        return d.layers[0].name === "Group" && typeof d.layers[0].id === "string" && d.layers[0].id.length > 0;
    })());
})();

(function () {
    // A group inside a group: nested groups, each framed by its own contents.
    var inner = groupItem("Inner", [pathItem("C", rectPts(300, 300, 350, 250))]);
    var outer = groupItem("Outer", [pathItem("A", rectPts(100, 500, 200, 400)), inner]);
    var doc = readSel([outer]);
    var o = doc.layers[0], i = o.children[0];
    ok("nested group: Inner is a group inside Outer, below A",
       o.type === "group" && i.type === "group" && i.name === "Inner" && o.children[1].name === "A",
       names(o.children));
    ok("nested group: Inner's frame is its own contents' box",
       near(i.frame.x, 200) && near(i.frame.y, 200) && near(i.frame.width, 50) && near(i.frame.height, 50), fr(i.frame));
    ok("nested group: Outer's covers Inner too",
       near(o.frame.x, 0) && near(o.frame.y, 0) && near(o.frame.width, 250) && near(o.frame.height, 250), fr(o.frame));
    ok("nested group: countLeaves sees both leaves", LazyLord.countLeaves(doc.layers) === 2);

    // A group whose contents are all hidden draws nothing and is left out.
    var hid = pathItem("Hidden", rectPts(100, 500, 200, 400));
    hid.hidden = true;
    doc = readSel([groupItem("Empty", [hid]), pathItem("Shown", rectPts(300, 500, 400, 400))]);
    ok("empty group: left out", doc.layers.length === 1 && doc.layers[0].name === "Shown", names(doc.layers));

    // A group whose only layer cannot be converted: the failure is reported and
    // no empty group is sent.
    var broken = pathItem("Broken", rectPts(100, 500, 200, 400));
    broken.pathPoints = null;
    doc = readSel([groupItem("Doomed", [broken]), pathItem("Fine", rectPts(300, 500, 400, 400))]);
    ok("failed group: no empty group is sent", doc.layers.length === 1 && doc.layers[0].name === "Fine", names(doc.layers));
    ok("failed group: its layer's failure is reported", warned("", "skipped") && diags().indexOf("Broken") >= 0, diags());

    // A group holding turned text is framed by the text's outer box, the box
    // the selection bounds use too, not by its unrotated frame.
    var tf = turnedText(60, 30, 30);
    doc = readSel([groupItem("Label", [tf])]);
    var gf = doc.layers[0].frame;
    ok("group of turned text: framed by the text's outer box",
       near(gf.x, 0) && near(gf.y, 0) && near(gf.width, outerW(tf.geometricBounds)) &&
       near(gf.height, outerH(tf.geometricBounds)) && near(doc.layers[0].children[0].frame.rotation, -30), fr(gf));
})();

(function () {
    // Three levels deep, named at every level, with mixed roots: a loose path
    // at the back, then Outer holding [Mid holding [Deep holding D], C], and a
    // loose path in front. Illustrator lists all of it front to back.
    var d = pathItem("D", rectPts(300, 300, 320, 280), { fillColor: rgb(1, 2, 3) });
    var c = pathItem("C", rectPts(200, 500, 250, 450), { fillColor: rgb(1, 2, 3) });
    var deep = groupItem("Deep", [d]);
    var mid = groupItem("Mid", [deep, pathItem("M", rectPts(250, 350, 280, 320), { fillColor: rgb(1, 2, 3) })]);
    var outer = groupItem("Outer", [c, mid]);
    var back = pathItem("Back", rectPts(100, 500, 150, 450), { fillColor: rgb(1, 2, 3) });
    var front = pathItem("Front", rectPts(400, 200, 450, 150), { fillColor: rgb(1, 2, 3) });
    var doc = readSel([front, outer, back]);

    ok("deep: the roots are the selected items, bottom to top", names(doc.layers) === "Back,Outer,Front",
       names(doc.layers));
    var o = doc.layers[1], m = o.children[0], dp = m.children[1];
    ok("deep: Outer holds Mid then C", o.type === "group" && names(o.children) === "Mid,C", names(o.children));
    ok("deep: Mid holds M then Deep", m.type === "group" && names(m.children) === "M,Deep", names(m.children));
    ok("deep: Deep holds D", dp.type === "group" && dp.children.length === 1 && dp.children[0].name === "D",
       names(dp.children || []));
    ok("deep: countLeaves sees all five leaves", LazyLord.countLeaves(doc.layers) === 5);
    ok("deep: the leaves stack as they did on the artboard", names(leavesOf(doc)) === "Back,M,D,C,Front",
       names(leavesOf(doc)));
    // Selection top-left is IR (100, 100). D: IR (300, 300) 20x20; M: IR
    // (250, 250) 30x30; C: IR (200, 100) 50x50.
    ok("deep: Deep's frame is D's box", near(dp.frame.x, 200) && near(dp.frame.y, 200) && near(dp.frame.width, 20) &&
       near(dp.frame.height, 20), fr(dp.frame));
    ok("deep: Mid's frame covers M and Deep", near(m.frame.x, 150) && near(m.frame.y, 150) &&
       near(m.frame.width, 70) && near(m.frame.height, 70), fr(m.frame));
    ok("deep: Outer's frame covers C and Mid", near(o.frame.x, 100) && near(o.frame.y, 0) &&
       near(o.frame.width, 120) && near(o.frame.height, 220), fr(o.frame));
    ok("deep: no group is rotated", o.frame.rotation === 0 && m.frame.rotation === 0 && dp.frame.rotation === 0);
    ok("deep: the bounds are the selection's, as before",
       near(doc.bounds.x, 100) && near(doc.bounds.y, 100) && near(doc.bounds.width, 350) && near(doc.bounds.height, 350),
       JSON.stringify(doc.bounds));
    ok("deep: groups without a uuid get their own counter ids, distinct from their layers'", (function () {
        var seen = {}, dup = false;
        LazyLord.eachLayer(doc.layers, function (l) { if (seen[l.id]) dup = true; seen[l.id] = true; });
        return !dup && /^ai-\d+$/.test(o.id) && /^ai-\d+$/.test(dp.id);
    })());
    ok("deep: nothing reported", LazyLord.diagnostics.length === 0, diags());
})();

(function () {
    // Opacity: the group's own on the group, each layer's own on the layer.
    var a = pathItem("A", rectPts(100, 500, 200, 400), { fillColor: rgb(1, 2, 3), opacity: 80 });
    var inner = groupItem("Inner", [a]);
    inner.opacity = 50;
    var b = pathItem("B", rectPts(300, 500, 400, 400), { fillColor: rgb(1, 2, 3) });
    var outer = groupItem("Outer", [inner, b]);
    outer.opacity = 40;
    var doc = readSel([outer]);
    var o = doc.layers[0], i = o.children[1];
    ok("group opacity: each group carries its own", near(o.frame.opacity, 0.4) && i.name === "Inner" &&
       near(i.frame.opacity, 0.5), o.frame.opacity + " " + i.frame.opacity);
    ok("group opacity: a layer keeps only its own", near(i.children[0].frame.opacity, 0.8) &&
       near(o.children[0].frame.opacity, 1), i.children[0].frame.opacity + " " + o.children[0].frame.opacity);
    ok("group opacity: carried natively, so nothing reported", LazyLord.diagnostics.length === 0, diags());
    var flat = LazyLord.flattenLayers(doc.layers);
    ok("group opacity: flattened, the opacities multiply down each branch",
       flat.length === 2 && flat[0].name === "B" && near(flat[0].frame.opacity, 0.4) &&
       flat[1].name === "A" && near(flat[1].frame.opacity, 0.8 * 0.5 * 0.4),
       flat.length + " " + (flat[0] && flat[0].frame.opacity) + " " + (flat[1] && flat[1].frame.opacity));
    // Only Outer holds more than one child, so only it is approximate there.
    ok("group opacity: flattening is lossy for the group of two only", flat.lossy === 1, String(flat.lossy));

    // An Illustrator opacity of 0 is still an opacity, not "unset".
    var z = groupItem("Zero", [pathItem("A", rectPts(100, 500, 200, 400))]);
    z.opacity = 0;
    ok("group opacity: 0 is carried as 0", near(readSel([z]).layers[0].frame.opacity, 0));
})();

(function () {
    // Groups that would draw nothing are left out, and so is a hidden group.
    var hg = groupItem("Hidden group", [pathItem("A", rectPts(100, 500, 200, 400))]);
    hg.hidden = true;
    var shown = pathItem("Shown", rectPts(300, 500, 400, 400));
    var doc = readSel([hg, shown]);
    ok("hidden group: left out", doc.layers.length === 1 && doc.layers[0].name === "Shown", names(doc.layers));

    // A clipping group whose only artwork is hidden: just its mask is left.
    var art = pathItem("Art", rectPts(100, 500, 200, 400));
    art.hidden = true;
    doc = readSel([groupItem("Only a mask", [maskPath("m-only"), art], true), shown]);
    ok("mask-only clipping group: left out", doc.layers.length === 1 && doc.layers[0].name === "Shown",
       names(doc.layers));

    // A group inside a group that draws nothing takes no place in it.
    var none = pathItem("None", rectPts(100, 500, 200, 400));
    none.hidden = true;
    doc = readSel([groupItem("Holder", [groupItem("Void", [none]), pathItem("K", rectPts(300, 500, 400, 400))])]);
    ok("empty sub-group: left out of its group", doc.layers.length === 1 && names(doc.layers[0].children) === "K",
       names(doc.layers[0].children || []));

    // One of two layers fails: the group keeps the other, framed by it alone.
    // The selection bounds still cover both, as they always have.
    var broken = pathItem("Broken", rectPts(100, 500, 200, 400));
    broken.pathPoints = null;
    doc = readSel([groupItem("Half", [broken, pathItem("Kept", rectPts(300, 450, 400, 350))])]);
    var g = doc.layers[0];
    ok("partly failed group: keeps what converted", g.type === "group" && names(g.children) === "Kept",
       names(g.children || []));
    ok("partly failed group: framed by what it holds", near(g.frame.x, 200) && near(g.frame.y, 50) &&
       near(g.frame.width, 100) && near(g.frame.height, 100), fr(g.frame));
    ok("partly failed group: bounds unchanged", near(doc.bounds.x, 100) && near(doc.bounds.width, 300),
       JSON.stringify(doc.bounds));
    ok("partly failed group: the failure is reported", warned("", "skipped") && diags().indexOf("Broken") >= 0, diags());
})();

// --- Primitives ------------------------------------------------------------
function primOf(points, opts) {
    return readSel([pathItem("Shape", points, opts)]).layers[0].primitive;
}
function isRect(p, w, h) {
    return !!p && p.kind === "rect" && near(p.x, 0) && near(p.y, 0) && near(p.width, w) && near(p.height, h);
}

(function () {
    var p = primOf(rectPts(100, 500, 300, 400));
    ok("rect: flagged as a 200x100 rect at 0,0", isRect(p, 200, 100) && p.roundness === undefined, JSON.stringify(p));

    p = primOf(rotatePts(reversePts(rectPts(100, 500, 300, 400)), 2));
    ok("rect: either winding and any start point", isRect(p, 200, 100), JSON.stringify(p));

    p = primOf(rectPts(100, 500, 300, 400), { closed: false });
    ok("rect: an open path is not a primitive", p === undefined, JSON.stringify(p));

    // A diamond: four sharp points on the edge midpoints.
    p = primOf([pt([200, 500]), pt([300, 450]), pt([200, 400]), pt([100, 450])]);
    ok("rect: a 4-point diamond is not flagged", p === undefined, JSON.stringify(p));

    // A trapezoid: axis-aligned bounds, but the top edge is shorter.
    p = primOf([pt([120, 500]), pt([280, 500]), pt([300, 400]), pt([100, 400])]);
    ok("rect: a 4-point trapezoid is not flagged", p === undefined, JSON.stringify(p));

    // Four corners visited in a bow-tie order.
    p = primOf([pt([100, 500]), pt([300, 400]), pt([300, 500]), pt([100, 400])]);
    ok("rect: a bow-tie through the corners is not flagged", p === undefined, JSON.stringify(p));

    p = primOf(ellipsePts(100, 500, 300, 400, KAPPA));
    ok("ellipse: flagged as a 200x100 ellipse at 0,0",
       !!p && p.kind === "ellipse" && near(p.x, 0) && near(p.y, 0) && near(p.width, 200) && near(p.height, 100),
       JSON.stringify(p));

    p = primOf(rotatePts(reversePts(ellipsePts(100, 500, 300, 400, KAPPA)), 1));
    ok("ellipse: either winding and any start point", !!p && p.kind === "ellipse", JSON.stringify(p));

    p = primOf(ellipsePts(100, 500, 300, 400, KAPPA * 1.01));
    ok("ellipse: handles within 2% still count", !!p && p.kind === "ellipse", JSON.stringify(p));

    p = primOf(ellipsePts(100, 500, 300, 400, KAPPA * 0.9));
    ok("ellipse: short handles (a squircle-ish blob) are not flagged", p === undefined, JSON.stringify(p));

    p = primOf(roundRectPts(100, 500, 300, 400, 20, KAPPA));
    ok("rounded rect: rect with roundness 20",
       isRect(p, 200, 100) && near(p.roundness, 20, 1e-6), JSON.stringify(p));

    p = primOf(rotatePts(roundRectPts(100, 500, 300, 400, 20, KAPPA), 1));
    ok("rounded rect: starting on a corner", isRect(p, 200, 100) && near(p.roundness, 20, 1e-6), JSON.stringify(p));

    p = primOf(rotatePts(reversePts(roundRectPts(100, 500, 300, 400, 20, KAPPA)), 3));
    ok("rounded rect: counter-clockwise", isRect(p, 200, 100) && near(p.roundness, 20, 1e-6), JSON.stringify(p));

    p = primOf(roundRectPts(100, 500, 300, 400, 20, 0.3));
    ok("rounded rect: non-circular corners are not flagged", p === undefined, JSON.stringify(p));

    // One corner with a bigger radius: move the top-left corner's two points out to 30.
    var odd = roundRectPts(100, 500, 300, 400, 20, KAPPA);
    odd[0] = pt([130, 500], [130 - KAPPA * 30, 500], [130, 500]);
    odd[7] = pt([100, 470], [100, 470], [100, 470 + KAPPA * 30]);
    p = primOf(odd);
    ok("rounded rect: mixed radii are not flagged", p === undefined, JSON.stringify(p));

    var cp = readSel([compoundItem("Ring", [pathItem("a", rectPts(100, 500, 300, 400))])]).layers[0];
    ok("compound paths are never primitives", cp.primitive === undefined, JSON.stringify(cp.primitive));
})();

// --- Gradients -------------------------------------------------------------
// Most use a 200x100 box at AI [100,500,300,400], i.e. IR (100,100)-(300,200).
function gradLayer(gc, opts) {
    opts = opts || {};
    opts.fillColor = gc;
    return readSel([pathItem("Grad", rectPts(100, 500, 300, 400), opts)]).layers[0];
}

(function () {
    var l = gradLayer(gradientColor(GradientType.LINEAR, [100, 450], 0, 200));
    var g = l.fills[0];
    ok("linear: type", g.type === "linear-gradient", g.type);
    ok("linear: runs from the left edge centre", nearUV(g.from, 0, 0.5), uv(g.from));
    ok("linear: to the right edge centre", nearUV(g.to, 1, 0.5), uv(g.to));
    ok("linear: stops in order", g.stops.length === 2 && near(g.stops[0].position, 0) && near(g.stops[1].position, 1),
       JSON.stringify(g.stops));
    ok("linear: a readable vector raises nothing", LazyLord.diagnostics.length === 0, diags());

    // 90 degrees counter-clockwise points UP in Illustrator: from the bottom
    // edge to the top, which is decreasing y in the IR.
    g = gradLayer(gradientColor(GradientType.LINEAR, [200, 400], 90, 100)).fills[0];
    ok("linear 90: starts at the bottom centre", nearUV(g.from, 0.5, 1), uv(g.from));
    ok("linear 90: ends at the top centre", nearUV(g.to, 0.5, 0), uv(g.to));

    // An off-centre, shorter vector normalises against width and height separately.
    g = gradLayer(gradientColor(GradientType.LINEAR, [150, 425], 0, 100)).fills[0];
    ok("linear: partial vector keeps its offset", nearUV(g.from, 0.25, 0.75) && nearUV(g.to, 0.75, 0.75),
       uv(g.from) + " " + uv(g.to));

    // 45 degrees on a square, from the bottom-left corner to the top-right one.
    var sq = readSel([pathItem("Diag", rectPts(100, 500, 200, 400),
        { fillColor: gradientColor(GradientType.LINEAR, [100, 400], 45, 100 * Math.SQRT2) })]).layers[0];
    g = sq.fills[0];
    ok("linear 45: bottom-left to top-right", nearUV(g.from, 0, 1) && nearUV(g.to, 1, 0), uv(g.from) + " " + uv(g.to));

    // Stop opacity is the paint's own; item opacity travels in the frame only.
    l = gradLayer(gradientColor(GradientType.LINEAR, [100, 450], 0, 200), { opacity: 50 });
    g = l.fills[0];
    ok("gradient: stop opacity carried", near(g.stops[0].color.a, 1) && near(g.stops[1].color.a, 0.5),
       JSON.stringify(g.stops));
    ok("gradient: item opacity stays in the frame", near(l.frame.opacity, 0.5), String(l.frame.opacity));
})();

(function () {
    var l = gradLayer(gradientColor(GradientType.RADIAL, [200, 450], 0, 50));
    var g = l.fills[0];
    ok("radial: type", g.type === "radial-gradient", g.type);
    ok("radial: centred on the origin", nearUV(g.from, 0.5, 0.5), uv(g.from));
    ok("radial: edge one radius along the angle", nearUV(g.to, 0.75, 0.5), uv(g.to));
    var px = LazyLord.gradientPx(l, g);
    ok("radial: radius comes back as 50 px", near(px.radius, 50), String(px.radius));
    ok("radial: centre in frame space", near(px.from[0], 100) && near(px.from[1], 50), xy(px.from));
    ok("radial: a plain radial raises nothing", LazyLord.diagnostics.length === 0, diags());

    gradLayer(gradientColor(GradientType.RADIAL, [200, 450], 0, 50, { hiliteLength: 10 }));
    ok("radial: off-centre highlight is reported", warned("highlight", "approximated"), diags());

    // Squashed to half height about the centre (200,450).
    gradLayer(gradientColor(GradientType.RADIAL, [200, 450], 0, 50, { matrix: mx(1, 0, 0, 0.5, 0, 225) }));
    ok("radial: an elliptical gradient is reported", warned("ellipse", "approximated"), diags());
})();

(function () {
    var g = gradLayer(gradientColor(GradientType.LINEAR, undefined, 0, undefined)).fills[0];
    ok("fallback: unreadable vector is centred across the box", nearUV(g.from, 0, 0.5) && nearUV(g.to, 1, 0.5),
       uv(g.from) + " " + uv(g.to));
    ok("fallback: reported as approximated", warned("could not be read", "approximated"), diags());

    var gc = gradientColor(GradientType.LINEAR, [100, 450], 0, 200);
    gc.gradient.gradientStops[0].midPoint = 30;
    gradLayer(gc);
    ok("gradient: moved midpoints are reported", warned("midpoints", "approximated"), diags());

    // A gradient stroke is normalised against the same box.
    var st = readSel([pathItem("Line", rectPts(100, 500, 300, 400),
        { strokeColor: gradientColor(GradientType.LINEAR, [150, 450], 0, 100) })]).layers[0];
    var sg = st.strokes.length ? st.strokes[0].paint : null;
    ok("stroke gradient: vector normalised to the layer box",
       !!sg && nearUV(sg.from, 0.25, 0.5) && nearUV(sg.to, 0.75, 0.5), sg ? uv(sg.from) + " " + uv(sg.to) : "no stroke");
})();

// --- Gradient matrix: transforms made after the gradient was applied -------
// Illustrator keeps origin/angle/length from when the gradient was applied and
// concatenates every later move, scale or rotation into GradientColor.matrix.
function gradFill(name, points, gc) {
    return readSel([pathItem(name, points, { fillColor: gc })]).layers[0].fills[0];
}
function uv2(g) { return uv(g.from) + " " + uv(g.to); }

(function () {
    // Applied across AI [100,500,300,400] (origin [100,450], angle 0, length
    // 200), then the object was moved 50pt right, to [150,500,350,400].
    var g = gradFill("Moved", rectPts(150, 500, 350, 400),
        gradientColor(GradientType.LINEAR, [100, 450], 0, 200, { matrix: mx(1, 0, 0, 1, 50, 0) }));
    ok("matrix: a move is applied to the origin", nearUV(g.from, 0, 0.5) && nearUV(g.to, 1, 0.5), uv2(g));
    ok("matrix: a readable transform raises nothing", LazyLord.diagnostics.length === 0, diags());

    // Scaled 50% about its centre (200,450), to [150,475,250,425].
    g = gradFill("Scaled", rectPts(150, 475, 250, 425),
        gradientColor(GradientType.LINEAR, [100, 450], 0, 200, { matrix: mx(0.5, 0, 0, 0.5, 100, 225) }));
    ok("matrix: a scale shrinks the vector with the object", nearUV(g.from, 0, 0.5) && nearUV(g.to, 1, 0.5), uv2(g));

    // Rotated 90 degrees counter-clockwise about its centre, to [150,550,250,350]:
    // the ramp that ran left to right now runs bottom to top.
    g = gradFill("Turned", rectPts(150, 550, 250, 350),
        gradientColor(GradientType.LINEAR, [100, 450], 0, 200, { matrix: mx(0, 1, -1, 0, 650, 250) }));
    ok("matrix: a rotation turns the vector", nearUV(g.from, 0.5, 1) && nearUV(g.to, 0.5, 0), uv2(g));

    // A 45 degree ramp across the 100x100 square [100,500,200,400], then the
    // object stretched 2x wide about its left edge. The colour bands shear, so
    // mapping the far corner would be wrong: the IR line must run
    // perpendicular to the sheared bands, from the bottom-left corner along
    // (1,2) in Illustrator, to the band through the top-right corner.
    g = gradFill("Stretched", rectPts(100, 500, 300, 400),
        gradientColor(GradientType.LINEAR, [100, 400], 45, 100 * Math.SQRT2, { matrix: mx(2, 0, 0, 1, -100, 0) }));
    ok("matrix: a stretched linear ramp keeps its colour bands",
       nearUV(g.from, 0, 1) && nearUV(g.to, 0.4, -0.6), uv2(g));
    ok("matrix: which is exact, so nothing is reported", LazyLord.diagnostics.length === 0, diags());

    // A radial gradient scaled 2x about its centre: same centre, twice the radius.
    var l = gradLayer(gradientColor(GradientType.RADIAL, [200, 450], 0, 50, { matrix: mx(2, 0, 0, 2, -200, -450) }));
    g = l.fills[0];
    ok("matrix: a scaled radial keeps its centre", nearUV(g.from, 0.5, 0.5), uv(g.from));
    var px = LazyLord.gradientPx(l, g);
    ok("matrix: and its radius scales with it (100 px)", near(px.radius, 100), String(px.radius));
    ok("matrix: a uniform scale is still a circle", LazyLord.diagnostics.length === 0, diags());

    // Matrix unreadable: the stored vector is used as it is, and that is reported.
    g = gradLayer(gradientColor(GradientType.LINEAR, [100, 450], 0, 200, { matrix: null })).fills[0];
    ok("matrix: unreadable, the stored vector is still used", nearUV(g.from, 0, 0.5) && nearUV(g.to, 1, 0.5), uv2(g));
    ok("matrix: unreadable is reported", warned("transform could not be read", "approximated"), diags());

    // A matrix missing a coefficient counts as unreadable too.
    var half = mx(1, 0, 0, 1, 0, 0);
    half.mValueTY = undefined;
    gradLayer(gradientColor(GradientType.LINEAR, [100, 450], 0, 200, { matrix: half }));
    ok("matrix: a missing coefficient is reported", warned("transform could not be read", "approximated"), diags());

    // A collapsed matrix leaves no ramp to read: centred and reported.
    gradLayer(gradientColor(GradientType.LINEAR, [100, 450], 0, 200, { matrix: mx(0, 0, 0, 0, 0, 0) }));
    ok("matrix: a collapsed matrix falls back to a centred ramp", warned("position could not be read", "approximated"),
       diags());
})();

// --- Gradient stops that cannot all be read -----------------------------------
(function () {
    // The host fails on the middle one of three stops.
    var gc = gradientColor(GradientType.LINEAR, [100, 450], 0, 200);
    var s = gc.gradient.gradientStops;
    gc.gradient.gradientStops = [s[0], null, s[1]];
    var g = gradLayer(gc).fills[0];
    ok("stops: the stops after an unreadable one are kept",
       g.stops.length === 2 && near(g.stops[0].position, 0) && near(g.stops[1].position, 1), JSON.stringify(g.stops));
    ok("stops: the lost stop is reported", warned("were left out", "approximated"), diags());

    // A stop whose colour cannot be converted keeps its place and opacity, in black.
    gc = gradientColor(GradientType.LINEAR, [100, 450], 0, 200);
    gc.gradient.gradientStops[1].color = { typename: "LabColor", l: 50, a: 0, b: 0 };
    g = gradLayer(gc).fills[0];
    ok("stops: an unreadable colour is carried as black",
       g.stops.length === 2 && near(g.stops[1].color.r, 0) && near(g.stops[1].color.b, 0) && near(g.stops[1].color.a, 0.5),
       JSON.stringify(g.stops));
    ok("stops: and that is reported", warned("carried as black", "approximated"), diags());

    g = gradLayer(gradientColor(GradientType.LINEAR, [100, 450], 0, 200)).fills[0];
    ok("stops: readable stops raise nothing", g.stops.length === 2 && LazyLord.diagnostics.length === 0, diags());
})();

(function () {
    var tf = {
        typename: "TextFrame", name: "Title", contents: "Hi", kind: TextType.POINTTEXT,
        anchor: [100, 480], opacity: 100, hidden: false, guides: false,
        geometricBounds: [100, 500, 160, 470],
        matrix: mx(1, 0, 0, 1, 100, 480), // upright
        textRange: {
            characterAttributes: {
                size: 24, tracking: 0, autoLeading: true,
                textFont: { family: "Futura", style: "Bold", name: "Futura-Bold" },
                fillColor: gradientColor(GradientType.LINEAR, [100, 485], 0, 60)
            },
            paragraphAttributes: { justification: Justification.LEFT },
            characters: []
        }
    };
    var l = readSel([tf]).layers[0];
    ok("text: gradient colour flattened to its first stop", near(l.color.r, 1) && near(l.color.b, 0),
       JSON.stringify(l.color));
    ok("text: the flattening is reported", warned("Gradient text", "approximated"), diags());
    // Anchor AI y=480 -> IR 120, minus the selection top (AI 500 -> IR 100).
    ok("text: baseline still exact", near(l.baseline, 20), String(l.baseline));
})();

// Guides and swatches always travel; the target adds them only when asked.
(function () {
    function guidePath(a, b) {
        return { guides: true, pathPoints: [{ anchor: a }, { anchor: b }] };
    }
    var doc = app.activeDocument;
    doc.pathItems = [guidePath([-100, 300], [900, 300]), guidePath([150, 0], [150, 600]),
                     guidePath([0, 0], [100, 100]), { guides: false, pathPoints: [{ anchor: [0, 10] }, { anchor: [50, 10] }] }];
    doc.swatches = [
        { name: "[None]", color: { typename: "NoColor" } },
        { name: "Brand red", color: rgb(255, 0, 0) },
        { name: "Blend", color: { typename: "GradientColor" } }
    ];
    var out;
    try { out = readSel([squarePath()]); }
    finally { delete doc.pathItems; delete doc.swatches; }
    // The square's top-left (IR 100,100) is frame space's 0,0.
    var gs = out.guides || [];
    ok("guides: only straight guides, in frame space",
       gs.length === 2 && gs[0].orientation === "horizontal" && near(gs[0].position, 200) &&
       gs[1].orientation === "vertical" && near(gs[1].position, 50), JSON.stringify(gs));
    ok("swatches: flat colours only, named", out.swatches && out.swatches.length === 1 &&
       out.swatches[0].name === "Brand red" && near(out.swatches[0].color.r, 1), JSON.stringify(out.swatches));
})();

// Mixed character styles travel as runs.
(function () {
    function ch(size, color, extra) {
        var a = { size: size, tracking: 0, textFont: { family: "Futura", style: "Bold", name: "Futura-Bold" },
                  fillColor: color, underline: false, strikeThrough: false };
        if (extra) for (var k in extra) a[k] = extra[k];
        return { characterAttributes: a };
    }
    var tf = {
        typename: "TextFrame", name: "Mixed", contents: "Hi!", kind: TextType.POINTTEXT,
        anchor: [100, 480], opacity: 100, hidden: false, guides: false,
        geometricBounds: [100, 500, 160, 470], matrix: mx(1, 0, 0, 1, 100, 480),
        textRange: {
            characterAttributes: { size: 24, tracking: 0, autoLeading: true,
                                   textFont: { family: "Futura", style: "Bold", name: "Futura-Bold" }, fillColor: rgb(255, 0, 0) },
            paragraphAttributes: { justification: Justification.LEFT },
            characters: [ch(24, rgb(255, 0, 0)), ch(24, rgb(255, 0, 0)), ch(36, rgb(0, 0, 255), { underline: true })]
        }
    };
    var l = readSel([tf]).layers[0];
    ok("text runs: equal neighbouring characters merge into one run",
       l.runs && l.runs.length === 2 && l.runs[0].start === 0 && l.runs[0].end === 2 && l.runs[1].start === 2 && l.runs[1].end === 3,
       JSON.stringify(l.runs));
    ok("text runs: each run has its own size, colour, font and decoration",
       l.runs && l.runs[1].fontSize === 36 && near(l.runs[1].color.b, 1) && l.runs[1].decoration === "underline" &&
       l.runs[0].fontFamily === "Futura" && l.runs[0].decoration === "none", JSON.stringify(l.runs));
    ok("text runs: nothing reported as flattened", !warned("flattened", "approximated"), diags());

    tf.textRange.characters = [ch(24, rgb(255, 0, 0)), ch(24, rgb(255, 0, 0)), ch(24, rgb(255, 0, 0))];
    ok("text runs: one style throughout sends no runs", readSel([tf]).layers[0].runs === undefined);
})();

// --- Clipping masks --------------------------------------------------------
// Mask: AI (120,480)-(180,420) with an up-pointing handle on its first point.
function maskPath(uuid) {
    return pathItem("Mask", [
        pt([120, 480], [120, 480], [120, 490]),
        pt([180, 480]),
        pt([180, 420]),
        pt([120, 420])
    ], { clipping: true, uuid: uuid });
}

(function () {
    var a = pathItem("A", rectPts(100, 500, 200, 400), { fillColor: rgb(255, 0, 0) });
    var b = pathItem("B", rectPts(150, 450, 250, 350), { fillColor: rgb(0, 255, 0) });
    // B sits in a plain sub-group: it still inherits the clipping group's mask.
    var doc = readSel([groupItem("Clip group", [maskPath("mask-uuid-1"), a, groupItem("Sub", [b], false)], true)]);

    var ls = leavesOf(doc);
    ok("clip: the mask is not emitted as a layer", ls.length === 2, names(ls));
    ok("clip: the clipping group arrives as one IR group, its mask on the leaves only",
       doc.layers.length === 1 && doc.layers[0].type === "group" && doc.layers[0].name === "Clip group" &&
       doc.layers[0].clip === undefined, doc.layers.length + " " + doc.layers[0].type);
    // pageItems lists front to back: A is in front of Sub (and so of B). The
    // IR is bottom to top, so B comes first. (Before this was fixed the reader
    // sent A, B, and every target drew B on top.)
    var lb = ls[0], la = ls[1];
    ok("clip: stacking order, bottom to top", lb.name === "B" && la.name === "A", names(ls));
    ok("clip: bounds come from the artwork, not the mask",
       near(doc.bounds.x, 100) && near(doc.bounds.y, 100) && near(doc.bounds.width, 150) && near(doc.bounds.height, 150),
       JSON.stringify(doc.bounds));
    ok("clip: both layers carry a clip", !!la.clip && !!lb.clip);
    if (!la.clip || !lb.clip) return;

    ok("clip: id is the mask's uuid, shared", la.clip.id === "mask-uuid-1" && lb.clip.id === "mask-uuid-1",
       la.clip.id + "," + lb.clip.id);
    ok("clip: named after the mask", la.clip.name === "Mask", la.clip.name);
    ok("clip: non-zero winding for a plain path", la.clip.windingRule === "nonzero", la.clip.windingRule);

    var cs = la.clip.subpaths[0];
    ok("clip: one closed contour of 4 points", la.clip.subpaths.length === 1 && cs.closed === true && cs.vertices.length === 4);
    // Frame space: AI (120,480) -> IR (120,120) -> minus selection top-left (100,100).
    ok("clip: top-left in frame space -> [20,20]", near(cs.vertices[0][0], 20) && near(cs.vertices[0][1], 20),
       xy(cs.vertices[0]));
    ok("clip: bottom-right in frame space -> [80,80]", near(cs.vertices[2][0], 80) && near(cs.vertices[2][1], 80),
       xy(cs.vertices[2]));
    ok("clip: handle y flips to -10", near(cs.outTangents[0][0], 0) && near(cs.outTangents[0][1], -10),
       xy(cs.outTangents[0]));
    // B's frame is not at the origin, yet its clip is still in frame space.
    ok("clip: not local to the layer", near(lb.frame.x, 50) && near(lb.clip.subpaths[0].vertices[0][0], 20),
       lb.frame.x + " / " + xy(lb.clip.subpaths[0].vertices[0]));

    ok("clip: every layer has its own copy",
       la.clip !== lb.clip && la.clip.subpaths[0] !== lb.clip.subpaths[0] &&
       la.clip.subpaths[0].vertices !== lb.clip.subpaths[0].vertices &&
       la.clip.subpaths[0].vertices[0] !== lb.clip.subpaths[0].vertices[0]);
    ok("clip: carried natively, so nothing is reported", LazyLord.diagnostics.length === 0, diags());

    // Shared objects would be shifted once per layer here.
    LazyLord.applyOrigin(doc);
    ok("clip: applyOrigin moves each clip exactly once",
       near(la.clip.subpaths[0].vertices[0][0], 120) && near(lb.clip.subpaths[0].vertices[0][0], 120) &&
       near(la.clip.subpaths[0].vertices[0][1], 120) && near(lb.clip.subpaths[0].vertices[0][1], 120),
       xy(la.clip.subpaths[0].vertices[0]) + " " + xy(lb.clip.subpaths[0].vertices[0]));
})();

(function () {
    // Outer mask (no uuid) around: an inner clipping group masked by a compound path, and leaf B.
    var hole = pathItem("hole", rectPts(140, 460, 160, 440));
    var ring = compoundItem("Ring mask", [pathItem("outer", rectPts(110, 490, 190, 410), { clipping: true }), hole]);
    var c = pathItem("C", rectPts(100, 500, 200, 400), { fillColor: rgb(0, 0, 255) });
    var b = pathItem("B", rectPts(300, 500, 400, 400), { fillColor: rgb(0, 255, 0) });
    var inner = groupItem("Inner", [ring, c], true);
    var outer = groupItem("Outer", [maskPath(), inner, b], true);
    var doc = readSel([outer]);

    var ls = leavesOf(doc);
    ok("nested: masks are not emitted", ls.length === 2, names(ls));
    // Outer lists [mask, Inner, B] front to back, so B is at the bottom.
    var lb = ls[0], lc = ls[1];
    ok("nested: bottom to top, B then Inner's C", lb.name === "B" && lc.name === "C", names(ls));
    ok("nested: the inner clipping group is a group inside the outer one",
       doc.layers.length === 1 && doc.layers[0].children.length === 2 && doc.layers[0].children[1].type === "group" &&
       doc.layers[0].children[1].name === "Inner", names(doc.layers[0].children || []));
    ok("nested: innermost mask wins", !!lc.clip && lc.clip.name === "Ring mask", lc.clip && lc.clip.name);
    ok("nested: a compound mask clips even-odd with every contour",
       !!lc.clip && lc.clip.windingRule === "evenodd" && lc.clip.subpaths.length === 2,
       lc.clip && (lc.clip.windingRule + " x" + lc.clip.subpaths.length));
    ok("nested: sibling outside the inner group keeps the outer mask", !!lb.clip && lb.clip.name === "Mask",
       lb.clip && lb.clip.name);
    ok("nested: masks without a uuid get distinct counter ids",
       !!lc.clip && !!lb.clip && lb.clip.id === "clip-1" && lc.clip.id === "clip-2",
       (lb.clip && lb.clip.id) + "," + (lc.clip && lc.clip.id));
    ok("nested: dropping the outer mask is reported", warned("Nested clipping masks", "approximated"), diags());

    // Flattened, the groups give back exactly what the reader sent before it
    // carried groups: the flat list below, captured from that reader for this
    // selection. Two changes are intended. The old list ran front to back (C,
    // then B), the reverse of the IR's bottom to top, so it is reversed here.
    // And counter ids ("ai-1", ... for objects with no uuid) are numbered in
    // reading order, which changed with it, so they are compared as "ai-#".
    var before = JSON.parse(
        '[{"id":"ai-1","name":"C","type":"vector","frame":{"x":0,"y":0,"width":100,"height":100,"rotation":0,"opacity":1},' +
        '"subpaths":[{"closed":true,"vertices":[[0,0],[100,0],[100,100],[0,100]],"inTangents":[[0,0],[0,0],[0,0],[0,0]],' +
        '"outTangents":[[0,0],[0,0],[0,0],[0,0]]}],"fills":[{"type":"solid","color":{"r":0,"g":0,"b":1,"a":1}}],' +
        '"strokes":[],"windingRule":"nonzero","primitive":{"kind":"rect","x":0,"y":0,"width":100,"height":100},' +
        '"clip":{"id":"clip-2","subpaths":[{"closed":true,"vertices":[[10,10],[90,10],[90,90],[10,90]],' +
        '"inTangents":[[0,0],[0,0],[0,0],[0,0]],"outTangents":[[0,0],[0,0],[0,0],[0,0]]},{"closed":true,' +
        '"vertices":[[40,40],[60,40],[60,60],[40,60]],"inTangents":[[0,0],[0,0],[0,0],[0,0]],' +
        '"outTangents":[[0,0],[0,0],[0,0],[0,0]]}],"windingRule":"evenodd","name":"Ring mask"}},' +
        '{"id":"ai-2","name":"B","type":"vector","frame":{"x":200,"y":0,"width":100,"height":100,"rotation":0,"opacity":1},' +
        '"subpaths":[{"closed":true,"vertices":[[0,0],[100,0],[100,100],[0,100]],"inTangents":[[0,0],[0,0],[0,0],[0,0]],' +
        '"outTangents":[[0,0],[0,0],[0,0],[0,0]]}],"fills":[{"type":"solid","color":{"r":0,"g":1,"b":0,"a":1}}],' +
        '"strokes":[],"windingRule":"nonzero","primitive":{"kind":"rect","x":0,"y":0,"width":100,"height":100},' +
        '"clip":{"id":"clip-1","subpaths":[{"closed":true,"vertices":[[20,20],[80,20],[80,80],[20,80]],' +
        '"inTangents":[[0,0],[0,0],[0,0],[0,0]],"outTangents":[[0,-10],[0,0],[0,0],[0,0]]}],"windingRule":"nonzero",' +
        '"name":"Mask"}}]').reverse();
    var flat = counterIds(LazyLord.flattenLayers(JSON.parse(JSON.stringify(doc.layers))));
    var diff = sameTree(counterIds(before), flat, "layers");
    ok("nested: flattened, the groups give back the flat list sent before", diff === "", diff);
    ok("nested: with the same bounds as before",
       near(doc.bounds.x, 100) && near(doc.bounds.y, 100) && near(doc.bounds.width, 300) && near(doc.bounds.height, 100),
       JSON.stringify(doc.bounds));
    ok("nested: and the same single report", LazyLord.diagnostics.length === 1, diags());

    // A mutation of the frame, a clip vertex or the order must show up.
    var bent = JSON.parse(JSON.stringify(flat));
    bent[1].clip.subpaths[1].vertices[2][0] = 61;
    ok("nested: the comparison notices a moved clip point", sameTree(counterIds(before), bent, "layers") !== "");
    ok("nested: and the old front-to-back order",
       sameTree(counterIds(before), counterIds(JSON.parse(JSON.stringify(flat)).reverse()), "layers") !== "");
})();

(function () {
    // The same objects picked out with Direct Selection (the selection then
    // holds C and B, front to back) reach their masks through their parents.
    // Flattened, the whole-group read must match that leaf for leaf: ids,
    // frames, clips and clip ids.
    var hole = pathItem("hole", rectPts(140, 460, 160, 440));
    var ring = compoundItem("Ring mask", [pathItem("outer", rectPts(110, 490, 190, 410), { clipping: true }), hole]);
    var c = pathItem("C", rectPts(100, 500, 200, 400), { fillColor: rgb(0, 0, 255), opacity: 70 });
    var b = pathItem("B", rectPts(300, 500, 400, 400), { fillColor: rgb(0, 255, 0) });
    var outer = adopt(groupItem("Outer", [maskPath(), groupItem("Inner", [ring, c], true), b], true));

    var whole = readSel([outer]);
    var wholeDiags = diags();
    var picked = readSel([c, b]);
    var diff = sameTree(picked.layers, LazyLord.flattenLayers(whole.layers), "layers");
    ok("group vs direct selection: the same flat list", diff === "", diff);
    ok("group vs direct selection: the same bounds", sameTree(picked.bounds, whole.bounds, "bounds") === "");
    ok("group vs direct selection: the same report", diags() === wholeDiags, diags() + " / " + wholeDiags);
    ok("group vs direct selection: only the whole-group read has groups",
       whole.layers[0].type === "group" && picked.layers[0].type === "vector" && picked.layers.length === 2);
})();

(function () {
    // Text used as a mask: no clipping path in the group, a TextFrame on top.
    var label = { typename: "TextFrame", name: "Mask text", hidden: false, guides: false,
                  geometricBounds: [100, 500, 200, 450] };
    var doc = readSel([groupItem("Text clip", [label, pathItem("Art", rectPts(100, 500, 200, 400), { fillColor: rgb(1, 2, 3) })], true)]);
    var ls = leavesOf(doc);
    ok("text mask: only the artwork is emitted", ls.length === 1 && ls[0].name === "Art", names(ls));
    ok("text mask: contents transfer unclipped", ls.length === 1 && ls[0].clip === undefined);
    ok("text mask: reported", warned("Text used as a clipping mask", "approximated"), diags());

    // A mask that has been given a visible stroke of its own.
    var m = maskPath();
    m.stroked = true;
    m.strokeColor = rgb(0, 0, 0);
    readSel([groupItem("Stroked mask", [m, pathItem("Art", rectPts(100, 500, 200, 400))], true)]);
    ok("painted mask: its own stroke is reported", warned("fill and stroke", "skipped"), diags());

    // A clipping path selected on its own is still not artwork.
    var threw = false;
    try { readSel([maskPath()]); } catch (e) { threw = true; }
    ok("stray clipping path: nothing to transfer", threw);

    threw = false;
    try { readSel([compoundItem("Stray", [pathItem("p", rectPts(0, 10, 10, 0), { clipping: true })])]); } catch (e2) { threw = true; }
    ok("stray compound clipping path: nothing to transfer", threw);
})();

// --- Clipping masks reached from below (Direct Selection, layer clips) ------
// Point each child's `parent` at its container, as the host does; a compound
// path's parts point at the compound path.
function adopt(c) {
    for (var i = 0; i < c.pageItems.length; i++) {
        var k = c.pageItems[i];
        k.parent = c;
        if (k.pageItems) adopt(k);
        if (k.pathItems) for (var j = 0; j < k.pathItems.length; j++) k.pathItems[j].parent = k;
    }
    return c;
}
function layerItem(name, kids) {
    return adopt({ typename: "Layer", name: name, pageItems: kids });
}
function countWarned(text) {
    var n = 0;
    for (var i = 0; i < LazyLord.diagnostics.length; i++) {
        if (LazyLord.diagnostics[i].reason.indexOf(text) >= 0) n++;
    }
    return n;
}
function clipId(l) { return (l && l.clip) ? l.clip.id : "(no clip)"; }

(function () {
    var m = maskPath("mask-uuid-2");
    var a = pathItem("A", rectPts(100, 500, 200, 400), { fillColor: rgb(255, 0, 0) });
    var b = pathItem("B", rectPts(150, 450, 250, 350), { fillColor: rgb(0, 255, 0) });
    var sub = groupItem("Sub", [b], false);
    adopt(groupItem("Clip group", [m, a, sub], true));

    // Direct Selection hands back the leaf, not its clipping group.
    var doc = readSel([a]);
    ok("direct: a leaf picked out of a clipping group keeps its clip",
       doc.layers.length === 1 && clipId(doc.layers[0]) === "mask-uuid-2", clipId(doc.layers[0]));
    ok("direct: the group around it was not selected, so it is not sent", doc.layers[0].type === "vector",
       doc.layers[0].type);
    // Frame space: A alone is the selection, so its top-left IR (100,100) is 0,0.
    ok("direct: the clip is in frame space",
       !!doc.layers[0].clip && near(doc.layers[0].clip.subpaths[0].vertices[0][0], 20), JSON.stringify(doc.layers[0].clip));
    ok("direct: nothing is reported", LazyLord.diagnostics.length === 0, diags());

    doc = readSel([b]);
    ok("direct: a leaf in a plain sub-group keeps the clip too", clipId(doc.layers[0]) === "mask-uuid-2",
       clipId(doc.layers[0]));
    // The selection's top-left is now B's, IR (150,150): the mask starts 30 up and left.
    ok("direct: measured from that selection",
       !!doc.layers[0].clip && near(doc.layers[0].clip.subpaths[0].vertices[0][0], -30), JSON.stringify(doc.layers[0].clip));

    doc = readSel([sub]);
    ok("direct: a sub-group picked with Group Selection keeps the clip, on its leaf",
       doc.layers[0].type === "group" && clipId(leavesOf(doc)[0]) === "mask-uuid-2", clipId(leavesOf(doc)[0]));

    // A marquee across the group picks the mask up as well.
    doc = readSel([m, a]);
    ok("direct: a selected mask is not emitted", doc.layers.length === 1 && doc.layers[0].name === "A",
       String(doc.layers.length));
    ok("direct: and still clips what was selected with it", clipId(doc.layers[0]) === "mask-uuid-2", clipId(doc.layers[0]));
    ok("direct: with nothing to report", LazyLord.diagnostics.length === 0, diags());
})();

(function () {
    // Siblings picked out of nested clipping groups whose masks have no uuid.
    var a = pathItem("A", rectPts(100, 500, 200, 400), { fillColor: rgb(255, 0, 0) });
    var b = pathItem("B", rectPts(150, 450, 250, 350), { fillColor: rgb(0, 255, 0) });
    adopt(groupItem("Outer", [maskPath(), groupItem("Inner", [maskPath(), a, b], true)], true));
    var doc = readSel([a, b]);
    var ca = doc.layers[0].clip, cb = doc.layers[1] && doc.layers[1].clip;
    ok("direct siblings: both clipped by the innermost mask, under one id",
       !!ca && !!cb && ca.id === "clip-2" && cb.id === "clip-2", clipId(doc.layers[0]) + "," + clipId(doc.layers[1]));
    ok("direct siblings: each has its own copy", !!ca && !!cb && ca !== cb && ca.subpaths[0] !== cb.subpaths[0]);
    ok("direct siblings: the dropped outer mask is reported once", countWarned("Nested clipping masks") === 1, diags());

    // A painted mask selected without any of its contents still loses its paint.
    var pm = maskPath();
    pm.stroked = true;
    pm.strokeColor = rgb(0, 0, 0);
    adopt(groupItem("Painted", [pm, pathItem("Art", rectPts(100, 500, 200, 400))], true));
    readSel([pm, pathItem("Other", rectPts(300, 500, 400, 400), { fillColor: rgb(1, 2, 3) })]);
    ok("own mask alone: its lost stroke is reported", countWarned("fill and stroke") === 1, diags());
    ok("own mask alone: not reported as stray", countWarned("clips nothing") === 0, diags());
})();

(function () {
    // A clipping path whose parent is no clipping group: nothing it clips can be found.
    var m = maskPath();
    var art = pathItem("Art", rectPts(100, 500, 200, 400), { fillColor: rgb(1, 2, 3) });
    adopt(groupItem("Loose", [m, art], false));
    var doc = readSel([m, art]);
    ok("stray mask: only the artwork is emitted", doc.layers.length === 1 && doc.layers[0].name === "Art",
       String(doc.layers.length));
    ok("stray mask: the artwork is unclipped", doc.layers[0].clip === undefined);
    ok("stray mask: reported as skipped", warned("clips nothing", "skipped"), diags());

    // No parent at all.
    readSel([maskPath(), pathItem("Art", rectPts(100, 500, 200, 400))]);
    ok("stray mask without a parent: reported", warned("clips nothing", "skipped"), diags());
})();

(function () {
    // Layer clipping mask: the layer's top object clips everything in it.
    var m = maskPath("layer-mask");
    var a = pathItem("A", rectPts(100, 500, 200, 400), { fillColor: rgb(255, 0, 0) });
    var b = pathItem("B", rectPts(300, 500, 400, 400), { fillColor: rgb(0, 255, 0) });
    var g = groupItem("Group", [b], false);
    var lay = layerItem("Layer 1", [m, a, g]);

    var doc = readSel([a, g]);
    var ls = leavesOf(doc);
    ok("layer clip: every selected object carries the layer's mask",
       ls.length === 2 && clipId(ls[0]) === "layer-mask" && clipId(ls[1]) === "layer-mask",
       clipId(ls[0]) + "," + clipId(ls[1]));
    ok("layer clip: nothing is reported", LazyLord.diagnostics.length === 0, diags());
    // The selection comes front to back like pageItems: A over Group.
    ok("layer clip: bottom to top, the group then A",
       doc.layers.length === 2 && doc.layers[0].name === "Group" && doc.layers[1].name === "A", names(doc.layers));

    // Select All on the layer picks up the mask too.
    doc = readSel([m, a, g]);
    ok("layer clip: the mask is neither emitted nor reported",
       leavesOf(doc).length === 2 && LazyLord.diagnostics.length === 0, names(leavesOf(doc)) + " " + diags());

    // A sublayer is clipped by its parent layer's mask.
    var c = pathItem("C", rectPts(100, 300, 200, 200), { fillColor: rgb(0, 0, 255) });
    var subLayer = layerItem("Sublayer", [c]);
    subLayer.parent = lay;
    doc = readSel([c]);
    ok("layer clip: reaches into sublayers", clipId(doc.layers[0]) === "layer-mask", clipId(doc.layers[0]));

    // A layer whose top object is ordinary artwork clips nothing.
    var d = pathItem("D", rectPts(100, 500, 200, 400), { fillColor: rgb(0, 0, 255) });
    layerItem("Plain", [d, pathItem("E", rectPts(300, 500, 400, 400))]);
    doc = readSel([d]);
    ok("plain layer: no clip", doc.layers[0].clip === undefined && LazyLord.diagnostics.length === 0, diags());
})();

// --- Opacity around the selection -------------------------------------------
// A group that is not selected itself is not sent, so its opacity cannot
// travel on it. It must not be dropped silently either.
(function () {
    var a = pathItem("A", rectPts(100, 500, 200, 400), { fillColor: rgb(255, 0, 0), opacity: 80 });
    var b = pathItem("B", rectPts(300, 500, 400, 400), { fillColor: rgb(0, 255, 0) });
    var faded = groupItem("Faded", [a, b]);
    faded.opacity = 50;
    var lay = layerItem("Layer 1", [faded]);

    var doc = readSel([a, b]);
    ok("parent fade: the objects keep only their own opacity",
       near(doc.layers[0].frame.opacity, 1) && near(doc.layers[1].frame.opacity, 0.8),
       doc.layers[0].frame.opacity + "," + doc.layers[1].frame.opacity);
    ok("parent fade: the group's lost opacity is reported once, by name",
       countWarned("opacity is not carried") === 1 && warned("The group's 50% opacity", "approximated") &&
       LazyLord.diagnostics[0].object === "Faded", diags());

    // Selecting the group itself carries it, with nothing to report.
    doc = readSel([faded]);
    ok("parent fade: selected whole, the group carries it instead",
       doc.layers[0].type === "group" && near(doc.layers[0].frame.opacity, 0.5) && LazyLord.diagnostics.length === 0,
       diags());

    // A faded layer loses its opacity whatever is selected on it.
    lay.opacity = 25;
    doc = readSel([faded]);
    ok("parent fade: a layer's opacity is reported too",
       countWarned("opacity is not carried") === 1 && warned("The layer's 25% opacity", "approximated") &&
       LazyLord.diagnostics[0].object === "Layer 1", diags());
    doc = readSel([a, b]);
    ok("parent fade: group and layer each reported once", countWarned("opacity is not carried") === 2, diags());

    // Opaque parents raise nothing.
    lay.opacity = 100;
    faded.opacity = 100;
    readSel([a]);
    ok("parent fade: opaque parents raise nothing", LazyLord.diagnostics.length === 0, diags());
})();

// --- Parts of a compound path -----------------------------------------------
// Direct or Group Selection can hand back one path out of a compound path,
// whose parent is then the CompoundPathItem. The part owns no paint, opacity
// or holes of its own, and the walk up to its groups and layers used to stop
// at the compound path, dropping their masks and opacity without a word.
(function () {
    var outerP = pathItem("outerP", rectPts(100, 500, 200, 400), { fillColor: rgb(255, 0, 0) });
    var holeP = pathItem("holeP", rectPts(130, 470, 170, 430), { fillColor: rgb(255, 0, 0) });
    var donut = compoundItem("Donut", [outerP, holeP]);
    donut.opacity = 50;
    var art = pathItem("Art", rectPts(150, 450, 250, 350), { fillColor: rgb(0, 255, 0) });
    var clip = groupItem("Faded clip", [maskPath("mk"), art, donut], true);
    clip.opacity = 40;
    var lay = layerItem("Layer 1", [clip]);
    lay.opacity = 60;

    var doc = readSel([outerP]);
    var l = doc.layers[0];
    ok("compound part: sent as its whole compound path",
       doc.layers.length === 1 && l.name === "Donut" && l.type === "vector" && l.subpaths.length === 2 &&
       l.windingRule === "evenodd", names(doc.layers));
    ok("compound part: carrying the compound path's own opacity", near(l.frame.opacity, 0.5), String(l.frame.opacity));
    ok("compound part: keeps the clipping group's mask", clipId(l) === "mk", clipId(l));
    ok("compound part: each faded container around it is reported once",
       countWarned("opacity is not carried") === 2 && warned("The group's 40% opacity", "approximated") &&
       warned("The layer's 60% opacity", "approximated"), diags());
    ok("compound part: sending the whole path is reported, once",
       countWarned("Only part of this compound path") === 1 && warned("Only part of this compound path", "approximated") &&
       LazyLord.diagnostics.length === 3, diags());

    // A marquee over the whole compound path picks every part up.
    var parts = readSel([holeP, outerP]);
    ok("compound parts: all of them give the compound path once",
       parts.layers.length === 1 && parts.layers[0].name === "Donut", names(parts.layers));
    ok("compound parts: all selected, only the containers' opacity is reported",
       countWarned("Only part") === 0 && countWarned("opacity is not carried") === 2 && LazyLord.diagnostics.length === 2,
       diags());
    var whole = readSel([donut]);
    var diff = sameTree(parts, whole, "doc");
    ok("compound parts: the same document as the compound path selected itself", diff === "", diff);

    // The compound path stacks where its part was: Art is in front of it.
    doc = readSel([art, outerP]);
    ok("compound part: stacked where its part was, under Art",
       doc.layers.length === 2 && doc.layers[0].name === "Donut" && doc.layers[1].name === "Art", names(doc.layers));
    ok("compound part: both keep the mask", clipId(doc.layers[0]) === "mk" && clipId(doc.layers[1]) === "mk",
       clipId(doc.layers[0]) + "," + clipId(doc.layers[1]));

    // Opaque containers and every part selected: nothing to report.
    clip.opacity = 100;
    lay.opacity = 100;
    readSel([outerP, holeP]);
    ok("compound parts: nothing lost, nothing reported", LazyLord.diagnostics.length === 0, diags());
})();

(function () {
    // A part of a compound clipping path is that mask, never artwork. The hole
    // is not flagged `clipping` itself, only the compound path's first part.
    var ringOuter = pathItem("ringOuter", rectPts(110, 490, 190, 410), { clipping: true });
    var ringHole = pathItem("ringHole", rectPts(140, 460, 160, 440));
    var ring = compoundItem("Ring mask", [ringOuter, ringHole]);
    ring.uuid = "ring";
    var art = pathItem("Art", rectPts(100, 500, 200, 400), { fillColor: rgb(0, 0, 255) });
    adopt(groupItem("Ring clip", [ring, art], true));

    var doc = readSel([ringHole, art]);
    ok("compound mask part: not emitted as artwork", doc.layers.length === 1 && doc.layers[0].name === "Art",
       names(doc.layers));
    ok("compound mask part: the art keeps the whole compound mask",
       clipId(doc.layers[0]) === "ring" && doc.layers[0].clip.windingRule === "evenodd" &&
       doc.layers[0].clip.subpaths.length === 2, clipId(doc.layers[0]));
    ok("compound mask part: nothing reported (not a stray, not a partial selection)",
       LazyLord.diagnostics.length === 0, diags());

    doc = readSel([ringOuter, ringHole, art]);
    ok("compound mask parts: all of them, still only the art, clipped",
       doc.layers.length === 1 && clipId(doc.layers[0]) === "ring" && LazyLord.diagnostics.length === 0,
       names(doc.layers) + " " + diags());

    // Its parts alone: nothing to transfer, as for the mask selected itself.
    var threw = false;
    try { readSel([ringOuter]); } catch (e) { threw = true; }
    ok("compound mask part alone: nothing to transfer", threw);
})();

// --- Rotated text and images -----------------------------------------------
// Illustrator bakes a path's rotation into its points, but a text frame or a
// linked image keeps its turn in item.matrix, and geometricBounds is then only
// the upright box around it. Angles passed below are Illustrator's:
// counter-clockwise in its y-up space.

// Turn AI point p counter-clockwise by deg about c.
function turnAI(p, c, deg) {
    var r = deg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    var dx = p[0] - c[0], dy = p[1] - c[1];
    return [c[0] + dx * cs - dy * sn, c[1] + dx * sn + dy * cs];
}

// geometricBounds of a w x h box centred on AI point c, turned by deg.
function turnedGb(c, w, h, deg) {
    var pts = [[c[0] - w / 2, c[1] + h / 2], [c[0] + w / 2, c[1] + h / 2],
               [c[0] + w / 2, c[1] - h / 2], [c[0] - w / 2, c[1] - h / 2]];
    var l = Infinity, t = -Infinity, r = -Infinity, b = Infinity;
    for (var i = 0; i < 4; i++) {
        var p = turnAI(pts[i], c, deg);
        if (p[0] < l) l = p[0];
        if (p[0] > r) r = p[0];
        if (p[1] > t) t = p[1];
        if (p[1] < b) b = p[1];
    }
    return [l, t, r, b];
}

// The matrix of an item whose own axes were scaled by sx, sy (negative
// mirrors) and which was then turned by deg: x' = a*x + c*y.
function rotMx(deg, sx, sy) {
    if (sx === undefined) sx = 1;
    if (sy === undefined) sy = 1;
    var r = deg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    return mx(cs * sx, sn * sx, -sn * sy, cs * sy, 0, 0);
}

// A linked raster PlacedItem's matrix: the same behind Illustrator's vertical
// flip, so an upright one reads [1, 0, 0, -1] (mValueB and mValueD negated).
function placedMx(deg, sx, sy) {
    var m = rotMx(deg, sx, sy);
    m.mValueB = -m.mValueB;
    m.mValueD = -m.mValueD;
    return m;
}

// AI point -> frame space, when the item with outer box gb is the whole
// selection (artboard top 600, left 0).
function irOf(p, gb) { return [p[0] - gb[0], gb[1] - p[1]]; }
function nearPt(p, q) { return !!p && !!q && near(p[0], q[0]) && near(p[1], q[1]); }
function fr(f) { return "(" + f.x + "," + f.y + " " + f.width + "x" + f.height + " rot " + f.rotation + ")"; }
function outerW(gb) { return gb[2] - gb[0]; }
function outerH(gb) { return gb[1] - gb[3]; }

// Point text whose upright w x h box has its top-left at AI (100, 500) and its
// baseline 20pt down, turned by deg about its centre. The anchor starts the
// baseline on the left edge; opts.just = Justification.RIGHT puts it on the
// right edge and CENTER in the middle, as Illustrator does. opts.anchorX
// overrides its upright x; opts.kind makes it area text. w x h is the box as
// drawn: opts.sx / opts.sy put a scale (negative mirrors) in the matrix
// behind the turn, or opts.matrix replaces it (its translation is set to the
// anchor either way). opts.size, opts.leading (explicit, else auto),
// opts.tracking, opts.contents and opts.orientation set the type.
function turnedText(w, h, deg, opts) {
    opts = opts || {};
    var just = opts.just || Justification.LEFT;
    var c = [100 + w / 2, 500 - h / 2];
    var ux = just === Justification.RIGHT ? 100 + w : (just === Justification.CENTER ? 100 + w / 2 : 100);
    if (opts.anchorX !== undefined) ux = opts.anchorX;
    var anchor = turnAI([ux, 480], c, deg);
    var m = opts.matrix || rotMx(deg, opts.sx, opts.sy);
    m.mValueTX = anchor[0];
    m.mValueTY = anchor[1];
    var tf = {
        typename: "TextFrame", name: "Turned", contents: opts.contents || "Hi", kind: opts.kind || TextType.POINTTEXT,
        anchor: anchor, opacity: 100, hidden: false, guides: false,
        geometricBounds: turnedGb(c, w, h, deg),
        matrix: m,
        textRange: {
            characterAttributes: {
                size: opts.size || 24, tracking: opts.tracking || 0, autoLeading: opts.leading === undefined,
                textFont: { family: "Futura", style: "Bold", name: "Futura-Bold" },
                fillColor: rgb(0, 0, 0)
            },
            paragraphAttributes: { justification: just },
            characters: []
        }
    };
    if (opts.leading !== undefined) tf.textRange.characterAttributes.leading = opts.leading;
    if (opts.orientation) tf.orientation = opts.orientation;
    return tf;
}
function textCentre(w, h) { return [100 + w / 2, 500 - h / 2]; }

(function () {
    // Worked sign check. Point text turned 45 degrees counter-clockwise in
    // Illustrator reads rising to the right. Its matrix is
    // [cos 45, sin 45, -sin 45, cos 45], so atan2(mValueB, mValueA) = +45. The
    // IR turns clockwise in y-down space, so that same turn on screen is -45.
    var tf = turnedText(60, 30, 45);
    var gb = tf.geometricBounds;
    var l = readSel([tf]).layers[0];
    ok("text 45: the matrix reads +45 counter-clockwise",
       near(Math.atan2(tf.matrix.mValueB, tf.matrix.mValueA) * 180 / Math.PI, 45), JSON.stringify(tf.matrix));
    ok("text 45: rotation is -45", near(l.frame.rotation, -45), fr(l.frame));
    // The IR's +x axis turned by the IR rotation: (cos -45, sin -45) = (0.707,
    // -0.707), i.e. right and UP on a y-down screen, as Illustrator shows it.
    var dir = LazyLord.rotatePoint([1, 0], [0, 0], l.frame.rotation);
    ok("text 45: its baseline rises to the right on the y-down screen",
       near(dir[0], Math.SQRT1_2) && near(dir[1], -Math.SQRT1_2), xy(dir));
    // A point 10pt along the upright baseline, carried through the IR frame's
    // turn, lands where Illustrator draws it: 10pt along its 45 degree baseline.
    var along = LazyLord.rotatePoint([l.anchorX + 10, l.baseline], LazyLord.frameCenter(l.frame), l.frame.rotation);
    ok("text 45: the baseline runs where Illustrator draws it",
       nearPt(along, irOf(turnAI([110, 480], textCentre(60, 30), 45), gb)), xy(along));
    ok("text 45: the box is centred on the outer box's centre",
       nearPt(LazyLord.frameCenter(l.frame), irOf(textCentre(60, 30), gb)), fr(l.frame));
    ok("text 45: rotatedTextAnchor lands on Illustrator's anchor",
       nearPt(LazyLord.rotatedTextAnchor(l), irOf(tf.anchor, gb)), xy(LazyLord.rotatedTextAnchor(l)));
    // Upright, the anchor sits 30 left of the centre and 5 below it.
    var ctr = LazyLord.frameCenter(l.frame);
    ok("text 45: the anchor is carried unrotated", near(l.anchorX - ctr[0], -30) && near(l.baseline - ctr[1], 5),
       l.anchorX + "," + l.baseline);
    // At 45 degrees the outer box only gives w + h; left-aligned point text
    // starts on the box's left edge, so its anchor gives w (and so h).
    ok("text 45: its upright 60 x 30 is found from where the anchor sits",
       near(l.frame.width, 60) && near(l.frame.height, 30), fr(l.frame));
    // Nothing independent can confirm that size exactly (the outer box only
    // gives w + h here), so it is reported. This used to report nothing.
    ok("text 45: the inferred size is reported, once",
       LazyLord.diagnostics.length === 1 && warned("worked out from where its first line starts", "approximated"),
       diags());

    // Right-aligned: the anchor ends the baseline on the right edge.
    tf = turnedText(60, 30, 45, { just: Justification.RIGHT });
    l = readSel([tf]).layers[0];
    ok("text 45 right-aligned: 60 x 30 from the anchor on the right edge",
       near(l.frame.width, 60) && near(l.frame.height, 30) && LazyLord.diagnostics.length === 1 &&
       warned("worked out from where its first line starts", "approximated"), fr(l.frame) + " " + diags());
    ok("text 45 right-aligned: rotatedTextAnchor lands on Illustrator's anchor",
       nearPt(LazyLord.rotatedTextAnchor(l), irOf(tf.anchor, tf.geometricBounds)), xy(LazyLord.rotatedTextAnchor(l)));

    // Fully justified point text sets like left-aligned.
    l = readSel([turnedText(60, 30, 45, { just: Justification.FULLJUSTIFY })]).layers[0];
    ok("text 45 justified: solved like left-aligned", near(l.frame.width, 60) && near(l.frame.height, 30),
       fr(l.frame));

    // Near 45 but not on it: too close to solve from the outer box.
    tf = turnedText(80, 20, 42);
    l = readSel([tf]).layers[0];
    ok("text 42: too near 45 to solve from the outer box, found from the anchor",
       near(l.frame.rotation, -42) && near(l.frame.width, 80) && near(l.frame.height, 20) &&
       LazyLord.diagnostics.length === 1 && warned("worked out from where its first line starts", "approximated"),
       fr(l.frame) + " " + diags());
    tf = turnedText(80, 20, 135);
    l = readSel([tf]).layers[0];
    ok("text 135: found from the anchor as well",
       near(l.frame.rotation, -135) && near(l.frame.width, 80) && near(l.frame.height, 20), fr(l.frame));
    ok("text 135: rotatedTextAnchor lands on Illustrator's anchor",
       nearPt(LazyLord.rotatedTextAnchor(l), irOf(tf.anchor, tf.geometricBounds)), xy(LazyLord.rotatedTextAnchor(l)));
})();

(function () {
    // Where the anchor cannot pin the size, the outer box is used and reported.
    // Centred point text: the anchor is in the middle, which says nothing.
    var tf = turnedText(60, 30, 45, { just: Justification.CENTER });
    var gb = tf.geometricBounds;
    var l = readSel([tf]).layers[0];
    ok("text 45 centred: its size cannot be solved, so the outer box is used",
       near(l.frame.width, outerW(gb)) && near(l.frame.height, outerH(gb)), fr(l.frame));
    ok("text 45 centred: and that is reported", warned("cannot be worked out", "approximated"), diags());
    ok("text 45 centred: the angle and the anchor are still exact",
       near(l.frame.rotation, -45) && nearPt(LazyLord.rotatedTextAnchor(l), irOf(tf.anchor, gb)),
       xy(LazyLord.rotatedTextAnchor(l)));

    // An anchor that is not on the box's edge gives a box that does not fit.
    tf = turnedText(60, 30, 45, { anchorX: 20 });
    l = readSel([tf]).layers[0];
    ok("text 45, anchor off the edge: refused, the outer box is used",
       near(l.frame.width, outerW(tf.geometricBounds)) && warned("cannot be worked out", "approximated"),
       fr(l.frame) + " " + diags());

    // The reviewers' probes. Near 45 degrees the outer box's two equations
    // only check w + h, so these used to pass as 40 x 50 and 80 x 10 with
    // nothing reported. The line-height check refuses both.
    tf = turnedText(60, 30, 45, { anchorX: 110 }); // 10pt inside the left edge
    l = readSel([tf]).layers[0];
    ok("text 45, anchor 10pt inside the edge: a 50pt-tall single line is refused, outer box used",
       near(l.frame.width, outerW(tf.geometricBounds)) && near(l.frame.height, outerH(tf.geometricBounds)) &&
       warned("cannot be worked out", "approximated") && !warned("first line starts"), fr(l.frame) + " " + diags());
    ok("text 45, anchor 10pt inside the edge: its angle and anchor stay exact",
       near(l.frame.rotation, -45) && nearPt(LazyLord.rotatedTextAnchor(l), irOf(tf.anchor, tf.geometricBounds)),
       xy(LazyLord.rotatedTextAnchor(l)));
    tf = turnedText(60, 30, 44, { anchorX: 90 }); // 10pt outside it
    l = readSel([tf]).layers[0];
    ok("text 44, anchor 10pt outside the edge: a 10pt-tall line is refused, outer box used",
       near(l.frame.width, outerW(tf.geometricBounds)) && warned("cannot be worked out", "approximated") &&
       !warned("first line starts"), fr(l.frame) + " " + diags());

    // An anchor whose baseline, turned back, falls outside the box it solves:
    // on the left edge of a 60 x 30 box, but 30pt below its bottom.
    tf = turnedText(60, 30, 45);
    var c45 = textCentre(60, 30);
    tf.anchor = turnAI([100, 440], c45, 45);
    l = readSel([tf]).layers[0];
    ok("text 45, baseline outside the solved box: refused",
       warned("cannot be worked out", "approximated") && !warned("first line starts"), fr(l.frame) + " " + diags());

    // Two lines need about twice the height, so a 60pt-tall box fits them...
    tf = turnedText(80, 60, 45, { contents: "Hi\rthere" });
    l = readSel([tf]).layers[0];
    ok("text 45, two lines: 80 x 60 found from the anchor",
       near(l.frame.width, 80) && near(l.frame.height, 60) && warned("first line starts", "approximated"),
       fr(l.frame) + " " + diags());
    // ...but not one line of 24pt type (more than twice its size).
    tf = turnedText(80, 60, 45);
    l = readSel([tf]).layers[0];
    ok("text 45, one line in a 60pt-tall box: refused",
       near(l.frame.width, outerW(tf.geometricBounds)) && warned("cannot be worked out", "approximated"),
       fr(l.frame) + " " + diags());
    // A forced line break (Illustrator's ETX, U+0003) counts as a line too.
    l = readSel([turnedText(80, 60, 45, { contents: "Hithere" })]).layers[0];
    ok("text 45, forced line break: two lines", near(l.frame.width, 80) && near(l.frame.height, 60), fr(l.frame));
    // Explicit leading is the line pitch. Two lines 60pt apart need about
    // 84pt, so a 120pt-tall box fits them; at auto leading (28.8pt) it does not.
    tf = turnedText(80, 120, 45, { contents: "Hi\rthere", leading: 60 });
    l = readSel([tf]).layers[0];
    ok("text 45, explicit leading: two lines 60pt apart fit a 120pt-tall box",
       near(l.frame.width, 80) && near(l.frame.height, 120) && near(l.lineHeight, 60), fr(l.frame) + " " + l.lineHeight);
    tf = turnedText(80, 120, 45, { contents: "Hi\rthere" });
    l = readSel([tf]).layers[0];
    ok("text 45, auto leading: two lines do not fill a 120pt-tall box, refused",
       near(l.frame.width, outerW(tf.geometricBounds)) && warned("cannot be worked out", "approximated"),
       fr(l.frame) + " " + diags());
    // The paragraph's own auto leading counts: at 300% two lines are 72pt apart.
    tf = turnedText(80, 120, 45, { contents: "Hi\rthere" });
    tf.textRange.paragraphAttributes.autoLeadingAmount = 300;
    l = readSel([tf]).layers[0];
    ok("text 45, 300% auto leading: two lines fit the 120pt-tall box",
       near(l.frame.width, 80) && near(l.frame.height, 120), fr(l.frame) + " " + diags());

    // Vertical point text does not start its line at the box's left edge.
    tf = turnedText(60, 30, 45, { orientation: TextOrientation.VERTICAL });
    l = readSel([tf]).layers[0];
    ok("vertical text 45: its anchor is not used for the size, outer box used",
       near(l.frame.width, outerW(tf.geometricBounds)) && warned("cannot be worked out", "approximated"),
       fr(l.frame) + " " + diags());
    ok("vertical text: rebuilt horizontal, and that is reported", warned("Vertical text", "approximated"), diags());
    readSel([turnedText(60, 30, 0, { orientation: TextOrientation.HORIZONTAL })]);
    ok("horizontal text: nothing reported", LazyLord.diagnostics.length === 0, diags());

    // Area text has no anchor to go by.
    tf = turnedText(60, 30, 45, { kind: TextType.AREATEXT });
    l = readSel([tf]).layers[0];
    ok("area text 45: the outer box, reported",
       near(l.frame.rotation, -45) && near(l.frame.width, outerW(tf.geometricBounds)) &&
       warned("cannot be worked out", "approximated") && warned("Area text", "approximated"),
       fr(l.frame) + " " + diags());
    ok("area text 45: no anchor is sent", l.anchorX === undefined && l.baseline === undefined,
       l.anchorX + "," + l.baseline);

    // Area text at a solvable angle needs no anchor.
    l = readSel([turnedText(60, 30, 30, { kind: TextType.AREATEXT })]).layers[0];
    ok("area text 30: 60 x 30 solved from the outer box", near(l.frame.width, 60) && near(l.frame.height, 30),
       fr(l.frame));

    // Point text whose anchor cannot be read: reported, not silently dropped.
    tf = turnedText(60, 30, 30);
    tf.anchor = null;
    l = readSel([tf]).layers[0];
    ok("text, anchor unreadable: the frame is still turned and sized",
       near(l.frame.rotation, -30) && near(l.frame.width, 60) && l.baseline === undefined, fr(l.frame));
    ok("text, anchor unreadable: reported", warned("anchor point could not be read", "approximated"), diags());
})();

(function () {
    var tf = turnedText(60, 30, 30);
    var gb = tf.geometricBounds;
    var d = readSel([tf]);
    var l = d.layers[0];
    ok("text 30: rotation -30", near(l.frame.rotation, -30), fr(l.frame));
    ok("text 30: its upright 60 x 30 is solved from the outer box",
       near(l.frame.width, 60) && near(l.frame.height, 30), fr(l.frame));
    ok("text 30: centred on the outer box", nearPt(LazyLord.frameCenter(l.frame), irOf(textCentre(60, 30), gb)),
       fr(l.frame));
    var ctr = LazyLord.frameCenter(l.frame);
    ok("text 30: the anchor is carried unrotated", near(l.anchorX - ctr[0], -30) && near(l.baseline - ctr[1], 5),
       l.anchorX + "," + l.baseline);
    ok("text 30: the upright anchor is the box's left edge, 20 down",
       near(l.anchorX, l.frame.x) && near(l.baseline, l.frame.y + 20), l.anchorX + "," + l.baseline + " " + fr(l.frame));
    ok("text 30: rotatedTextAnchor lands on Illustrator's anchor",
       nearPt(LazyLord.rotatedTextAnchor(l), irOf(tf.anchor, gb)), xy(LazyLord.rotatedTextAnchor(l)));
    ok("text 30: the selection bounds stay the outer box",
       near(d.bounds.width, outerW(gb)) && near(d.bounds.height, outerH(gb)), JSON.stringify(d.bounds));
    ok("text 30: exact, so nothing is reported", LazyLord.diagnostics.length === 0, diags());

    // applyOrigin moves frame and anchor together: the anchor still lands on
    // its artboard position (IR y = 600 - AI y).
    LazyLord.applyOrigin(d);
    ok("text 30: after applyOrigin the anchor is where it sat on the artboard",
       nearPt(LazyLord.rotatedTextAnchor(l), [tf.anchor[0], 600 - tf.anchor[1]]), xy(LazyLord.rotatedTextAnchor(l)));

    tf = turnedText(60, 30, -30);
    l = readSel([tf]).layers[0];
    ok("text -30: a clockwise turn in Illustrator is +30",
       near(l.frame.rotation, 30) && near(l.frame.width, 60) && near(l.frame.height, 30), fr(l.frame));
    ok("text -30: rotatedTextAnchor lands on Illustrator's anchor",
       nearPt(LazyLord.rotatedTextAnchor(l), irOf(tf.anchor, tf.geometricBounds)), xy(LazyLord.rotatedTextAnchor(l)));

    tf = turnedText(60, 30, 90);
    l = readSel([tf]).layers[0];
    ok("text 90: a 30 x 60 outer box is 60 x 30 turned -90",
       near(l.frame.rotation, -90) && near(l.frame.width, 60) && near(l.frame.height, 30), fr(l.frame));

    tf = turnedText(60, 30, 180);
    l = readSel([tf]).layers[0];
    ok("text 180: upside down, same size",
       near(Math.abs(l.frame.rotation), 180) && near(l.frame.width, 60) && near(l.frame.height, 30), fr(l.frame));
    ok("text 180: rotatedTextAnchor lands on Illustrator's anchor",
       nearPt(LazyLord.rotatedTextAnchor(l), irOf(tf.anchor, tf.geometricBounds)), xy(LazyLord.rotatedTextAnchor(l)));

    tf = turnedText(60, 30, 60);
    l = readSel([tf]).layers[0];
    ok("text 60: solved as well", near(l.frame.rotation, -60) && near(l.frame.width, 60) && near(l.frame.height, 30),
       fr(l.frame));
    ok("text 60: nothing reported", LazyLord.diagnostics.length === 0, diags());
})();

(function () {
    var tf = turnedText(60, 30, 0);
    var l = readSel([tf]).layers[0];
    ok("text upright: rotation 0 and the outer box is the frame",
       l.frame.rotation === 0 && near(l.frame.x, 0) && near(l.frame.y, 0) && near(l.frame.width, 60) &&
       near(l.frame.height, 30), fr(l.frame));
    ok("text upright: anchor unchanged", near(l.anchorX, 0) && near(l.baseline, 20), l.anchorX + "," + l.baseline);
    ok("text upright: nothing reported", LazyLord.diagnostics.length === 0, diags());

    // Mirrored left to right, left-aligned text runs leftward from its anchor,
    // which so sits on the right end of its box (AI x 160).
    tf = turnedText(60, 30, 0, { anchorX: 160 });
    tf.matrix = mx(-1, 0, 0, 1, 160, 480);
    l = readSel([tf]).layers[0];
    ok("text mirrored: carried upright, not turned upside down", l.frame.rotation === 0, fr(l.frame));
    ok("text mirrored: reported", warned("mirrored", "approximated"), diags());
    // Carried unmirrored, it has to start on the box's left edge to cover the
    // same box; kept on the right end it ran from x 60 to 120, out of its box.
    ok("text mirrored: the anchor is mirrored to the box's left edge",
       near(l.anchorX, 0) && near(l.baseline, 20), l.anchorX + "," + l.baseline + " " + fr(l.frame));

    // Mirrored top to bottom, the text hangs from its baseline: in a 30pt box
    // whose baseline is 20pt from the top, the glyphs it had above that line
    // are below it. Unmirrored, the baseline goes 10pt from the top instead.
    tf = turnedText(60, 30, 0);
    tf.matrix = mx(1, 0, 0, -1, 100, 480);
    l = readSel([tf]).layers[0];
    ok("text mirrored top to bottom: upright, anchor mirrored across the middle",
       l.frame.rotation === 0 && near(l.anchorX, 0) && near(l.baseline, 10), l.anchorX + "," + l.baseline);
    ok("text mirrored top to bottom: reported", warned("mirrored", "approximated"), diags());

    // Mirrored left to right, then turned 30: turned -30 in the IR, and the
    // anchor (on the turned box's right end) goes to the upright box's left.
    tf = turnedText(60, 30, 30, { anchorX: 160, sx: -1 });
    l = readSel([tf]).layers[0];
    ok("text mirrored then turned: -30, 60 x 30",
       near(l.frame.rotation, -30) && near(l.frame.width, 60) && near(l.frame.height, 30), fr(l.frame));
    ok("text mirrored then turned: the upright anchor is on the left edge, 20 down",
       near(l.anchorX, l.frame.x) && near(l.baseline, l.frame.y + 20), l.anchorX + "," + l.baseline + " " + fr(l.frame));

    // At 45 degrees the size comes from the anchor, which mirrored text has
    // on its other edge.
    tf = turnedText(60, 30, 45, { anchorX: 160, sx: -1 });
    l = readSel([tf]).layers[0];
    ok("text mirrored at 45: 60 x 30 from the anchor on the far edge",
       near(l.frame.width, 60) && near(l.frame.height, 30) && warned("first line starts", "approximated"),
       fr(l.frame) + " " + diags());
    ok("text mirrored at 45: the upright anchor is on the left edge",
       near(l.anchorX, l.frame.x) && near(l.baseline, l.frame.y + 20), l.anchorX + "," + l.baseline + " " + fr(l.frame));

    tf = turnedText(60, 30, 0);
    tf.matrix = mx(1, 0, 0.3, 1, 0, 0);
    l = readSel([tf]).layers[0];
    ok("text slanted: reported", warned("slanted", "approximated"), diags());
    // A slant lengthens the matrix's y axis without making the type taller.
    ok("text slanted: its size is kept, not read as a stretch", near(l.fontSize, 24) && !warned("stretched"),
       l.fontSize + " " + diags());

    // Scaled 200% as an object and turned 30: the matrix keeps the scale and
    // the character attributes the 24pt set before it (_air_textScale).
    tf = turnedText(120, 60, 30, { sx: 2, sy: 2, tracking: 100, leading: 30 });
    l = readSel([tf]).layers[0];
    ok("text scaled 200%: the point size follows the matrix, 48", near(l.fontSize, 48), String(l.fontSize));
    ok("text scaled 200%: so do tracking (100/1000 em of 48 = 4.8) and explicit leading (60)",
       near(l.letterSpacing, 4.8) && near(l.lineHeight, 60), l.letterSpacing + " " + l.lineHeight);
    ok("text scaled 200%: its box is the drawn 120 x 60, turned -30",
       near(l.frame.rotation, -30) && near(l.frame.width, 120) && near(l.frame.height, 60), fr(l.frame));
    ok("text scaled 200%: an even scale is exact, nothing reported", LazyLord.diagnostics.length === 0, diags());

    // At 45 degrees the scaled size is what the line-height check expects:
    // a 60pt-tall line of 48pt type fits, where 24pt type would be refused.
    l = readSel([turnedText(120, 60, 45, { sx: 2, sy: 2 })]).layers[0];
    ok("text scaled 200% at 45: sized from the anchor against the scaled type",
       near(l.frame.width, 120) && near(l.frame.height, 60) && near(l.fontSize, 48), fr(l.frame) + " " + l.fontSize);

    // Stretched 2x along the baseline only: the height, and so the size, stays.
    tf = turnedText(120, 30, 30, { sx: 2, sy: 1 });
    l = readSel([tf]).layers[0];
    ok("text stretched: carried at its height, 24pt", near(l.fontSize, 24), String(l.fontSize));
    ok("text stretched: reported", warned("stretched", "approximated"), diags());

    ok("text upright and unscaled: 24pt as set", near(readSel([turnedText(60, 30, 0)]).layers[0].fontSize, 24));

    tf = turnedText(60, 30, 30);
    tf.matrix = null;
    l = readSel([tf]).layers[0];
    ok("text, matrix unreadable: upright at the outer box",
       l.frame.rotation === 0 && near(l.frame.width, outerW(tf.geometricBounds)), fr(l.frame));
    ok("text, matrix unreadable: reported", warned("rotation could not be read", "approximated"), diags());
})();

// A linked image whose file is bw x bh (its boundingBox), scaled by sx, sy on
// the page and turned by deg about AI (200, 450).
function linkedImage(file, bw, bh, deg, opts) {
    opts = opts || {};
    var sx = opts.sx === undefined ? 1 : opts.sx, sy = opts.sy === undefined ? 1 : opts.sy;
    var type = opts.typename || "PlacedItem";
    var upright = type === "RasterItem" || /\.eps$/i.test(file);
    var it = {
        typename: type, name: "Photo", opacity: 100, hidden: false, guides: false,
        file: { exists: true, fsName: "C:\\art\\" + file, name: file },
        boundingBox: opts.bb || [0, bh, bw, 0],
        geometricBounds: turnedGb([200, 450], bw * Math.abs(sx), bh * Math.abs(sy), deg),
        matrix: opts.matrix || (upright ? rotMx(deg, sx, sy) : placedMx(deg, sx, sy))
    };
    if (opts.noBox) delete it.boundingBox;
    return it;
}

(function () {
    // The cross-check's case: a linked 200x100 PNG turned 90 degrees
    // counter-clockwise. Its outer box is 100 wide and 200 tall, and sending
    // that squashed the photo. Its matrix is the flip behind the turn,
    // [0, -1, -1, 0], so the flip is undone first: +90 CCW, i.e. IR -90.
    var it = linkedImage("photo.png", 200, 100, 90);
    var gb = it.geometricBounds;
    var l = readSel([it]).layers[0];
    ok("image 90: sent as the original file",
       l.type === "image" && l.isOriginalFile === true && l.filePath === "C:\\art\\photo.png", l.filePath);
    ok("image 90: rotation -90", near(l.frame.rotation, -90), fr(l.frame));
    ok("image 90: upright 200 x 100, not squashed into 100 x 200",
       near(l.frame.width, 200) && near(l.frame.height, 100), fr(l.frame));
    ok("image 90: centred on the outer box", nearPt(LazyLord.frameCenter(l.frame), irOf([200, 450], gb)), fr(l.frame));
    // The file's top-left corner (AI (100, 500) upright) turns to the bottom-left.
    var corner = LazyLord.rotatePoint([l.frame.x, l.frame.y], LazyLord.frameCenter(l.frame), l.frame.rotation);
    ok("image 90: its top-left corner lands where Illustrator shows it",
       nearPt(corner, irOf(turnAI([100, 500], [200, 450], 90), gb)), xy(corner));
    ok("image 90: the pixel size is the upright one", l.pixelWidth === 200 && l.pixelHeight === 100,
       l.pixelWidth + "x" + l.pixelHeight);
    ok("image 90: nothing reported", LazyLord.diagnostics.length === 0, diags());

    l = readSel([linkedImage("photo.png", 200, 100, 0)]).layers[0];
    ok("image upright: Illustrator's flip is not read as a mirror",
       l.frame.rotation === 0 && near(l.frame.width, 200) && near(l.frame.height, 100) &&
       LazyLord.diagnostics.length === 0, fr(l.frame) + " " + diags());

    l = readSel([linkedImage("photo.png", 200, 100, 30, { sx: 0.5, sy: 0.5 })]).layers[0];
    ok("image 30 at 50%: 100 x 50 turned -30",
       near(l.frame.rotation, -30) && near(l.frame.width, 100) && near(l.frame.height, 50), fr(l.frame));

    l = readSel([linkedImage("photo.png", 200, 100, 30, { sx: 2, sy: 0.5 })]).layers[0];
    ok("image 30, stretched: 400 x 50", near(l.frame.width, 400) && near(l.frame.height, 50), fr(l.frame));
    ok("image 30, stretched: an uneven scale is still a box, nothing reported",
       LazyLord.diagnostics.length === 0, diags());

    // At 45 degrees the outer box alone cannot give the size, but the file's
    // proportions can.
    l = readSel([linkedImage("photo.png", 200, 100, 45)]).layers[0];
    ok("image 45: its own box gives the size where text cannot",
       near(l.frame.rotation, -45) && near(l.frame.width, 200) && near(l.frame.height, 100) &&
       LazyLord.diagnostics.length === 0, fr(l.frame) + " " + diags());

    // A boundingBox in other units (half size) with the right proportions.
    l = readSel([linkedImage("photo.png", 200, 100, 30, { bb: [0, 50, 100, 0] })]).layers[0];
    ok("image: a box in other units is scaled to fit the outer box",
       near(l.frame.width, 200) && near(l.frame.height, 100), fr(l.frame));

    // A boundingBox that does not fit the outer box at all is ignored.
    l = readSel([linkedImage("photo.png", 200, 100, 30, { bb: [0, 300, 100, 0] })]).layers[0];
    ok("image: a box that does not fit falls back to solving the outer box",
       near(l.frame.width, 200) && near(l.frame.height, 100) && LazyLord.diagnostics.length === 0,
       fr(l.frame) + " " + diags());

    l = readSel([linkedImage("photo.png", 200, 100, 30, { noBox: true })]).layers[0];
    ok("image without a boundingBox: solved from the outer box",
       near(l.frame.width, 200) && near(l.frame.height, 100), fr(l.frame));

    l = readSel([linkedImage("photo.png", 200, 100, 45, { noBox: true })]).layers[0];
    ok("image without a boundingBox at 45: the outer box, reported",
       near(l.frame.rotation, -45) && near(l.frame.width, outerW(turnedGb([200, 450], 200, 100, 45))) &&
       warned("cannot be worked out", "approximated"), fr(l.frame) + " " + diags());
})();

(function () {
    // EPS and embedded RasterItems are the right way up: no flip to undo.
    var l = readSel([linkedImage("logo.eps", 200, 100, 90)]).layers[0];
    ok("eps 90: rotation -90, 200 x 100",
       near(l.frame.rotation, -90) && near(l.frame.width, 200) && near(l.frame.height, 100), fr(l.frame));
    ok("eps 90: nothing reported", LazyLord.diagnostics.length === 0, diags());

    l = readSel([linkedImage("logo.eps", 200, 100, 0)]).layers[0];
    ok("eps upright: not a mirror", l.frame.rotation === 0 && LazyLord.diagnostics.length === 0, diags());

    l = readSel([linkedImage("scan.tif", 200, 100, 30, { typename: "RasterItem" })]).layers[0];
    ok("raster item 30: rotation -30, 200 x 100",
       l.type === "image" && near(l.frame.rotation, -30) && near(l.frame.width, 200) && near(l.frame.height, 100),
       fr(l.frame));
    ok("raster item 30: nothing reported", LazyLord.diagnostics.length === 0, diags());

    // Mirrored left to right: no turn undoes that, so it is carried upright.
    l = readSel([linkedImage("photo.png", 200, 100, 0, { sx: -1 })]).layers[0];
    ok("image mirrored: carried upright and unmirrored",
       l.frame.rotation === 0 && near(l.frame.width, 200) && near(l.frame.height, 100), fr(l.frame));
    ok("image mirrored: reported", warned("mirrored", "approximated"), diags());

    // Mirrored and turned: still the unrotated size, the turn kept.
    l = readSel([linkedImage("photo.png", 200, 100, 30, { sy: -1 })]).layers[0];
    ok("image mirrored and turned: the turn and size are kept",
       near(l.frame.rotation, -30) && near(l.frame.width, 200) && near(l.frame.height, 100), fr(l.frame));

    // Mirrored left to right, then turned 30: the item's x axis now points
    // 150 degrees round, but its y axis only 30. Dropping the mirror along x
    // keeps the item's top where it was, turned 30 (IR -30), not upside down.
    l = readSel([linkedImage("photo.png", 200, 100, 30, { sx: -1 })]).layers[0];
    ok("image mirrored across, then turned: read from its y axis, -30",
       near(l.frame.rotation, -30) && near(l.frame.width, 200) && near(l.frame.height, 100), fr(l.frame));
    ok("image mirrored across, then turned: reported", warned("mirrored", "approximated"), diags());

    l = readSel([linkedImage("photo.png", 200, 100, 0, { matrix: mx(1, 0, 0.3, -1, 0, 0) })]).layers[0];
    ok("image slanted: reported", warned("slanted", "approximated"), diags());

    var it = linkedImage("photo.png", 200, 100, 30);
    it.matrix = null;
    l = readSel([it]).layers[0];
    ok("image, matrix unreadable: upright at the outer box, reported",
       l.frame.rotation === 0 && near(l.frame.width, outerW(it.geometricBounds)) &&
       warned("rotation could not be read", "approximated"), fr(l.frame) + " " + diags());
})();

(function () {
    // A missing link is exported as a PNG of the item as it looks on the
    // page, already turned: that PNG fills the outer box, upright.
    var realExport = LazyLord._air_export;
    LazyLord._air_export = function () {};
    try {
        var it = linkedImage("gone.png", 200, 100, 90);
        it.file = { exists: false };
        var l = readSel([it]).layers[0];
        ok("rasterized: the PNG is upright, over the outer box",
           l.isOriginalFile === false && l.frame.rotation === 0 && near(l.frame.width, 100) &&
           near(l.frame.height, 200), fr(l.frame));
        ok("rasterized: pixel size is the @2x outer box", l.pixelWidth === 200 && l.pixelHeight === 400,
           l.pixelWidth + "x" + l.pixelHeight);
        ok("rasterized: reported", warned("PNG was exported", "rasterized"), diags());
    } finally {
        LazyLord._air_export = realExport;
    }
})();

// Live sync: the stamp the panel polls.
(function () {
    var sq = squarePath();
    app.selection = [sq];
    var s1 = LazyLord.liveStamp();
    ok("live stamp: a selection gives one", /^[0-9a-z]+\.[0-9a-z]+$/.test(s1), s1);
    ok("live stamp: the same each time", LazyLord.liveStamp() === s1);
    sq.pathPoints[1].anchor = [210, 500];
    var s2 = LazyLord.liveStamp();
    ok("live stamp: a moved point changes it", s2 !== s1);
    sq.fillColor = rgb(0, 0, 255);
    ok("live stamp: a recolour changes it", LazyLord.liveStamp() !== s2);
    app.selection = [];
    ok("live stamp: nothing selected is empty", LazyLord.liveStamp() === "");
    app.selection = { typename: "TextRange", length: 3 };
    ok("live stamp: typing in a text frame is empty until done", LazyLord.liveStamp() === "");

    // Past the point budget a path is counted, not read, so a huge selection stays quick.
    var many = [];
    for (var n = 0; n < 5; n++) {
        var pts = [];
        for (var i = 0; i < 1000; i++) pts.push(pt([i, n * 10]));
        many.push(pathItem("P" + n, pts));
    }
    app.selection = many;
    var big = LazyLord.liveStamp();
    many[4].pathPoints[1].anchor = [1.5, 40];
    ok("live stamp: beyond the budget only the count is read", LazyLord.liveStamp() === big);
    many[4].geometricBounds = [0, 41, 999, 40];
    ok("live stamp: but its bounds still are", LazyLord.liveStamp() !== big);
    many[0].pathPoints[1].anchor = [1.5, 0];
    ok("live stamp: within it every point counts", LazyLord.liveStamp() !== big);
})();

WScript.Echo("");
WScript.Echo(passed + " passed, " + failed + " failed.");
WScript.Quit(failed === 0 ? 0 : 1);
