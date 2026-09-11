/*
 * LazyLord — Illustrator builder tests (no Node required).
 *
 *   cscript //Nologo tools\test-ai-builder.js
 *
 * Runs the real jsx/ai.jsx against a mocked Illustrator DOM under Windows
 * Script Host, whose JScript engine is ES3 like ExtendScript. It pins down what
 * is otherwise only visible on screen:
 *  - native gradient stops, and the matrix that moves Illustrator's default
 *    gradient vector onto the IR handles — whichever side app.concatenate*
 *    multiplies on, and wherever Transformation.DOCUMENTORIGIN really sits;
 *  - clipping-group structure and y-flipped clip vertices;
 *  - group hierarchy: flattening by default (group opacity folded into the
 *    leaves), or nested GroupItems with clipping groups formed per container,
 *    and a sub-group joining its siblings' clipping group to keep its place;
 *  - rotation sign and pivot for text and images;
 *  - the size of a newly created document, and embedding generated images only.
 *
 * ExtendScript (and JScript) has no property setters, so the mock cannot react
 * to `item.fillColor = gc`. Instead a new GradientColor starts with the vector
 * in MOCK.gradDefault, which each test sets to what Illustrator would pick:
 * the builder only ever reads that default back and transforms it.
 *
 * How a gradient transform shows up is MOCK.gradModel. "matrix" is what
 * Illustrator does: origin/angle/length stay as they were and the transform is
 * concatenated into GradientColor.matrix. "raw" rewrites origin/angle/length
 * instead (matrix stays the identity); "ignored" and "originOnly" model hosts
 * whose read-back cannot be trusted. Tests compare the EFFECTIVE vector (stored
 * origin and end point mapped through the matrix), computed independently here.
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

// --- Mock switches -----------------------------------------------------------
var MOCK = {};
function resetMock() {
    MOCK = {
        concat: "append",        // app.concatenate*: "append" = new step after, "prepend" = before
        docOrigin: [0, 0],       // where Transformation.DOCUMENTORIGIN sits in script coordinates
        gradDefault: null,       // vector a newly assigned GradientColor reports
        gradDefaultMatrix: null, // ... and its matrix (null = identity)
        gradModel: "matrix",     // how transform() changes a gradient (see the header)
        float32: false,          // matrices hold single-precision values, like AIRealMatrix
        gradientsFail: false,    // doc.gradients.add() throws
        gradientsFailCount: 0,   // ... or only the next N calls throw
        compoundFirstOnly: false,   // a compound transform moves only its first member's gradient
        memberMovesSiblings: false, // a member's transform moves every member's gradient (shared style)
        transforms: [],          // every PageItem.transform() call
        embedded: [],            // names of embedded placed items
        docsAdded: [],           // app.documents.add() arguments
        groupAdds: 0,            // groupItems.add() calls so far, in any container
        groupAddFailAt: 0,       // that call number (1-based) throws; 0 = none does
        pointTexts: [],          // textFrames.pointText() anchors, in any container
        textAdds: 0,             // textFrames.add() calls made by the builder itself
        textNoAnchor: false,     // text frames do not report their anchor (it reads NaN)
        textNoParagraphs: false  // textRange.paragraphAttributes is missing, so justifying throws
    };
}
resetMock();

// --- Enumerations ------------------------------------------------------------
var DocumentColorSpace = { RGB: "rgb", CMYK: "cmyk" };
var GradientType = { LINEAR: "lin", RADIAL: "rad" };
var PointType = { CORNER: "corner", SMOOTH: "smooth" };
var Justification = { LEFT: "l", CENTER: "c", RIGHT: "r", FULLJUSTIFY: "f" };
var Transformation = { CENTER: "center", DOCUMENTORIGIN: "docorigin", TOPLEFT: "topleft" };

function File(p) { this.fsName = p; this.exists = true; }

function RGBColor() { this.typename = "RGBColor"; this.red = 0; this.green = 0; this.blue = 0; }

// --- Matrices (Illustrator convention: x' = a*x + c*y + tx, y' = b*x + d*y + ty)
function Mx(a, b, c, d, tx, ty) {
    this.mValueA = a; this.mValueB = b; this.mValueC = c; this.mValueD = d;
    this.mValueTX = tx; this.mValueTY = ty;
}
function mxCopy(m) { return new Mx(m.mValueA, m.mValueB, m.mValueC, m.mValueD, m.mValueTX, m.mValueTY); }
/** Apply m, then n. */
function mxThen(m, n) {
    return new Mx(
        m.mValueA * n.mValueA + m.mValueB * n.mValueC,
        m.mValueA * n.mValueB + m.mValueB * n.mValueD,
        m.mValueC * n.mValueA + m.mValueD * n.mValueC,
        m.mValueC * n.mValueB + m.mValueD * n.mValueD,
        m.mValueTX * n.mValueA + m.mValueTY * n.mValueC + n.mValueTX,
        m.mValueTX * n.mValueB + m.mValueTY * n.mValueD + n.mValueTY);
}
function mxApply(m, p) {
    return [m.mValueA * p[0] + m.mValueC * p[1] + m.mValueTX,
            m.mValueB * p[0] + m.mValueD * p[1] + m.mValueTY];
}
function mxConcat(m, n) { return f32Mx(MOCK.concat === "append" ? mxThen(m, n) : mxThen(n, m)); }

/** Round to the nearest single-precision value (ES3 has no Math.fround). */
function fround(x) {
    if (x === 0 || !isFinite(x)) return x;
    var ax = Math.abs(x);
    var e = Math.floor(Math.log(ax) / Math.LN2);
    if (Math.pow(2, e) > ax) e--;
    if (Math.pow(2, e + 1) <= ax) e++;
    var s = Math.pow(2, 23 - e);
    return Math.round(x * s) / s;
}
/** A matrix as the host would store it: rounded to float when MOCK.float32. */
function f32Mx(m) {
    if (!MOCK.float32) return m;
    return new Mx(fround(m.mValueA), fround(m.mValueB), fround(m.mValueC),
                  fround(m.mValueD), fround(m.mValueTX), fround(m.mValueTY));
}

// --- Gradients -----------------------------------------------------------------
function GradientStop(ramp) { this.typename = "GradientStop"; this.rampPoint = ramp; this.midPoint = 50; this.opacity = 100; this.color = null; }

function Gradient() {
    this.typename = "Gradient";
    this.type = GradientType.LINEAR;
    var gs = [new GradientStop(0), new GradientStop(100)];
    gs.add = function () { var s = new GradientStop(100); gs.push(s); return s; };
    this.gradientStops = gs;
    this.removed = false;
}
Gradient.prototype.remove = function () { this.removed = true; };

function GradientColor() {
    var d = MOCK.gradDefault || { origin: [0, 0], angle: 0, length: 0 };
    this.typename = "GradientColor";
    this.gradient = null;
    this.origin = [d.origin[0], d.origin[1]];
    this.angle = d.angle;
    this.length = d.length;
    this.matrix = MOCK.gradDefaultMatrix ? mxCopy(MOCK.gradDefaultMatrix) : new Mx(1, 0, 0, 1, 0, 0);
}

function vecEnd(v) {
    var r = v.angle * Math.PI / 180;
    return [v.origin[0] + v.length * Math.cos(r), v.origin[1] + v.length * Math.sin(r)];
}

/** Move a GradientColor's vector by m about `about`, as MOCK.gradModel says transform() does. */
function moveVector(col, m, about) {
    if (!col || col.typename !== "GradientColor") return;
    // translate(-about), then m, then translate(about)
    var t = mxThen(mxThen(new Mx(1, 0, 0, 1, -about[0], -about[1]), m), new Mx(1, 0, 0, 1, about[0], about[1]));
    if (MOCK.gradModel === "matrix") {
        col.matrix = f32Mx(mxThen(col.matrix, t));
    } else if (MOCK.gradModel === "raw") {
        var o = mxApply(t, col.origin), e = mxApply(t, vecEnd(col));
        col.origin = o;
        col.angle = Math.atan2(e[1] - o[1], e[0] - o[0]) * 180 / Math.PI;
        col.length = Math.sqrt((e[0] - o[0]) * (e[0] - o[0]) + (e[1] - o[1]) * (e[1] - o[1]));
    } else if (MOCK.gradModel === "originOnly") {
        col.origin = mxApply(t, col.origin);
    } // "ignored": nothing changes
}

function moveColours(path, m, about) {
    moveVector(path.fillColor, m, about);
    moveVector(path.strokeColor, m, about);
}

function aboutPoint(about) { return (about === Transformation.DOCUMENTORIGIN) ? MOCK.docOrigin : [0, 0]; }

// --- Page items ------------------------------------------------------------------
function removeFrom(arr, item) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === item) { arr.splice(i, 1); return i; }
    return -1;
}

/** A collection whose add() puts the new item on top (index 0), like Illustrator. */
function zColl(owner, make) {
    var c = [];
    c.add = function () {
        var it = make();
        c.unshift(it);
        owner.pageItems.unshift(it);
        return it;
    };
    return c;
}

function makeContainer(obj) {
    obj.pageItems = [];
    obj.pathItems = zColl(obj, function () { return new PathItem(obj); });
    obj.compoundPathItems = zColl(obj, function () { return new CompoundPathItem(obj); });
    obj.textFrames = zColl(obj, function () { return new TextFrame(obj); });
    var addText = obj.textFrames.add;
    obj.textFrames.add = function () { MOCK.textAdds++; return addText(); };
    obj.textFrames.pointText = function (anchor) {
        MOCK.pointTexts.push([anchor[0], anchor[1]]);
        var t = addText();
        t._place(anchor);
        return t;
    };
    obj.placedItems = zColl(obj, function () { return new PlacedItem(obj); });
    obj.groupItems = zColl(obj, function () { return new GroupItem(obj); });
    var addGroup = obj.groupItems.add;
    obj.groupItems.add = function () {
        MOCK.groupAdds++;
        if (MOCK.groupAddFailAt && MOCK.groupAdds === MOCK.groupAddFailAt) throw new Error("groups are unavailable");
        return addGroup();
    };
    return obj;
}

function detach(item) {
    var p = item.parent;
    removeFrom(p.pageItems, item);
    var colls = [p.pathItems, p.compoundPathItems, p.textFrames, p.placedItems, p.groupItems];
    for (var i = 0; i < colls.length; i++) if (colls[i]) removeFrom(colls[i], item);
}

function scaleWidth(path, clw) {
    // Model changeLineWidths as a percentage: 1 would shrink strokes to 1%.
    if (path.stroked && typeof clw === "number") path.strokeWidth = path.strokeWidth * clw / 100;
}

function PathItem(parent) {
    this.typename = "PathItem";
    this.parent = parent;
    this.name = "";
    var pts = [];
    pts.add = function () { var p = {}; pts.push(p); return p; };
    this.pathPoints = pts;
    this.closed = false;
    this.filled = false;
    this.stroked = false;
    this.fillColor = null;
    this.strokeColor = null;
    this.strokeWidth = 1;
    this.opacity = 100;
    this.evenodd = false;
    this.clipping = false;
}
PathItem.prototype.transform = function (m, cp, cfp, cfg, csp, clw, about) {
    MOCK.transforms.push({ target: this, m: mxCopy(m), args: [cp, cfp, cfg, csp, clw, about] });
    if (cfg) {
        var sibs = (MOCK.memberMovesSiblings && this.parent.typename === "CompoundPathItem")
            ? this.parent.pathItems : [this];
        for (var i = 0; i < sibs.length; i++) moveColours(sibs[i], m, aboutPoint(about));
    }
    scaleWidth(this, clw);
};
PathItem.prototype.remove = function () { if (this.parent.pageItems) detach(this); };

function CompoundPathItem(parent) {
    var self = this;
    this.typename = "CompoundPathItem";
    this.parent = parent;
    this.name = "";
    this.opacity = 100;
    var members = [];
    members.add = function () { var p = new PathItem(self); members.push(p); return p; };
    this.pathItems = members;
}
CompoundPathItem.prototype.transform = function (m, cp, cfp, cfg, csp, clw, about) {
    MOCK.transforms.push({ target: this, m: mxCopy(m), args: [cp, cfp, cfg, csp, clw, about] });
    for (var i = 0; i < this.pathItems.length; i++) {
        var p = this.pathItems[i];
        if (cfg && (i === 0 || !MOCK.compoundFirstOnly)) moveColours(p, m, aboutPoint(about));
        scaleWidth(p, clw);
    }
};
CompoundPathItem.prototype.remove = function () { detach(this); };

function GroupItem(parent) {
    makeContainer(this);
    this.typename = "GroupItem";
    this.parent = parent;
    this.name = "";
    this.opacity = 100;
    this.clipped = false;
    this.removed = false;
}
GroupItem.prototype.remove = function () { this.removed = true; detach(this); };

// Rigid-box helpers shared by text frames and placed items (y-up).
function turnPts(pts, c, deg) {
    var r = deg * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
    for (var i = 0; i < pts.length; i++) {
        var dx = pts[i][0] - c[0], dy = pts[i][1] - c[1];
        pts[i] = [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos];
    }
}
function shiftPts(pts, dx, dy) {
    for (var i = 0; i < pts.length; i++) pts[i] = [pts[i][0] + dx, pts[i][1] + dy];
}
function syncBox(item) {
    var c = item._corners;
    var l = Infinity, t = -Infinity, r = -Infinity, b = Infinity;
    for (var i = 0; i < c.length; i++) {
        if (c[i][0] < l) l = c[i][0];
        if (c[i][0] > r) r = c[i][0];
        if (c[i][1] > t) t = c[i][1];
        if (c[i][1] < b) b = c[i][1];
    }
    item.geometricBounds = [l, t, r, b];
    item.position = [l, t];
    item.width = r - l;
    item.height = t - b;
}
function boxCentre(item) {
    var gb = item.geometricBounds;
    return [(gb[0] + gb[2]) / 2, (gb[1] + gb[3]) / 2];
}

/**
 * Point text: a 120 x 30 line whose baseline sits 24pt below its top. As in
 * Illustrator, the anchor stays where the text was created and the line is laid
 * out around it by the paragraph justification: starting there (left, full),
 * centred on it, or ending there (right). ES3 has no setters, so the layout
 * catches up whenever the frame is asked where it is: at rotate(), and when an
 * anchor hidden by MOCK.textNoAnchor is read (it lays out, then reads NaN).
 * this._a is the true anchor; this.anchor is what the builder can read.
 */
var LINE_START = { l: 0, c: -60, r: -120, f: 0 };
function TextFrame(parent) {
    this.typename = "TextFrame";
    this.parent = parent;
    this.name = "";
    this.contents = "";
    this.opacity = 100;
    this.textRange = { characterAttributes: {}, paragraphAttributes: MOCK.textNoParagraphs ? null : {} };
    this.rotations = [];
    this.turnedWith = []; // the justification in force at each rotate()
    this._place([0, 0]);
}
TextFrame.prototype._justification = function () {
    var pa = this.textRange.paragraphAttributes;
    return (pa && pa.justification) || Justification.LEFT;
};
TextFrame.prototype._layout = function () {
    if (this.rotations.length) return; // turned text keeps the layout it was turned with
    var x = this._a[0] + LINE_START[this._justification()], top = this._a[1] + 24;
    this._corners = [[x, top], [x + 120, top], [x + 120, top - 30], [x, top - 30]];
    syncBox(this);
};
TextFrame.prototype._sync = function () {
    if (!MOCK.textNoAnchor) { this.anchor = [this._a[0], this._a[1]]; return; }
    var self = this;
    var probe = { valueOf: function () { self._layout(); return NaN; } };
    this.anchor = [probe, probe];
};
TextFrame.prototype._place = function (anchor) {
    this._a = [anchor[0], anchor[1]];
    this._sync();
    this._layout();
};
TextFrame.prototype.rotate = function (deg) {
    this._layout();
    this.rotations.push(deg);
    this.turnedWith.push(this._justification());
    var c = boxCentre(this), pts = [this._a];
    turnPts(pts, c, deg);
    turnPts(this._corners, c, deg);
    this._a = pts[0];
    this._sync();
    syncBox(this);
};
TextFrame.prototype.translate = function (dx, dy) {
    this._a = [this._a[0] + dx, this._a[1] + dy];
    shiftPts(this._corners, dx, dy);
    this._sync();
    syncBox(this);
};

/** A placed image: 400 x 200 pt as linked, until resized. */
function PlacedItem(parent) {
    this.typename = "PlacedItem";
    this.parent = parent;
    this.name = "";
    this.opacity = 100;
    this.file = null;
    this.position = [0, 0];
    this.width = 400;
    this.height = 200;
    this.rotations = [];
    this._corners = null;
}
PlacedItem.prototype._fromPosition = function () {
    var p = this.position, w = this.width, h = this.height;
    this._corners = [[p[0], p[1]], [p[0] + w, p[1]], [p[0] + w, p[1] - h], [p[0], p[1] - h]];
};
PlacedItem.prototype.resize = function (sx, sy) {
    this._fromPosition(); // position was assigned; the item is still unrotated
    var p = this.position, w = this.width * sx / 100, h = this.height * sy / 100;
    this._corners = [[p[0], p[1]], [p[0] + w, p[1]], [p[0] + w, p[1] - h], [p[0], p[1] - h]];
    syncBox(this);
};
PlacedItem.prototype.rotate = function (deg) {
    if (!this._corners) this._fromPosition();
    this.rotations.push(deg);
    turnPts(this._corners, boxCentre(this), deg);
    syncBox(this);
};
PlacedItem.prototype.translate = function (dx, dy) {
    shiftPts(this._corners, dx, dy);
    syncBox(this);
};
PlacedItem.prototype.embed = function () {
    MOCK.embedded.push(this.name);
    var p = this.parent;
    var raster = { typename: "RasterItem", name: "", opacity: 100, geometricBounds: this.geometricBounds, parent: p };
    for (var i = 0; i < p.pageItems.length; i++) {
        if (p.pageItems[i] === this) { p.pageItems[i] = raster; break; }
    }
    removeFrom(p.placedItems, this);
};

// --- Documents ----------------------------------------------------------------------
function makeDoc(rect) {
    var d = makeContainer({ typename: "Document" });
    d.artboards = { length: 1, getActiveArtboardIndex: function () { return 0; } };
    d.artboards[0] = { artboardRect: rect };
    var grads = [];
    grads.add = function () {
        if (MOCK.gradientsFail) throw new Error("gradients are unavailable");
        if (MOCK.gradientsFailCount > 0) { MOCK.gradientsFailCount--; throw new Error("gradient could not be created"); }
        var g = new Gradient();
        grads.push(g);
        return g;
    };
    d.gradients = grads;
    return d;
}

var app = {
    documents: {
        length: 0,
        add: function (space, w, h) {
            MOCK.docsAdded.push([space, w, h]);
            var d = makeDoc([0, h, w, 0]);
            app.activeDocument = d;
            app.documents.length++;
            return d;
        }
    },
    activeDocument: null,
    textFonts: [],
    redraw: function () {},
    getIdentityMatrix: function () { return new Mx(1, 0, 0, 1, 0, 0); }, // exact in float too
    getTranslationMatrix: function (dx, dy) { return new Mx(1, 0, 0, 1, dx || 0, dy || 0); },
    getRotationMatrix: function (deg) {
        var r = (deg || 0) * Math.PI / 180;
        return new Mx(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0);
    },
    getScaleMatrix: function (sx, sy) { return new Mx(sx / 100, 0, 0, sy / 100, 0, 0); }
};
app.concatenateTranslationMatrix = function (m, dx, dy) { return mxConcat(m, app.getTranslationMatrix(dx, dy)); };
app.concatenateRotationMatrix = function (m, deg) { return mxConcat(m, app.getRotationMatrix(deg)); };
app.concatenateScaleMatrix = function (m, sx, sy) { return mxConcat(m, app.getScaleMatrix(sx, sy)); };

/** A fresh open document with its artboard's top-left at (0, 600) in y-up space. */
function openDoc() {
    var d = makeDoc([0, 600, 800, 0]);
    app.activeDocument = d;
    app.documents.length = 1;
    return d;
}

// --- Load the real code (global scope) -------------------------------------
eval(load("json2.js"));
eval(load("lazylord.jsx"));
eval(load("ai.jsx"));

// --- Assertions ------------------------------------------------------------
var passed = 0, failed = 0;

function ok(name, cond, detail) {
    if (cond) { WScript.Echo("  ok   " + name); passed++; }
    else { WScript.Echo("  FAIL " + name + (detail ? "  -> " + detail : "")); failed++; }
}
function near(a, b, eps) { return Math.abs(a - b) < (eps || 1e-6); }
function nearPt(p, q, eps) { return near(p[0], q[0], eps) && near(p[1], q[1], eps); }
function xy(p) { return "[" + p[0] + "," + p[1] + "]"; }
function diags() { return JSON.stringify(LazyLord.diagnostics); }
function findDiag(text) {
    for (var i = 0; i < LazyLord.diagnostics.length; i++) {
        if (LazyLord.diagnostics[i].reason.indexOf(text) >= 0) return LazyLord.diagnostics[i];
    }
    return null;
}
/** The vector on screen: stored origin and end point mapped through col.matrix. */
function vec(col) {
    var m = col.matrix || new Mx(1, 0, 0, 1, 0, 0);
    var o = mxApply(m, col.origin), e = mxApply(m, vecEnd(col));
    var dx = e[0] - o[0], dy = e[1] - o[1];
    return { origin: o, angle: Math.atan2(dy, dx) * 180 / Math.PI, length: Math.sqrt(dx * dx + dy * dy) };
}
function vecNear(v, t, eps) {
    return nearPt(v.origin, t.origin, eps) && nearPt(vecEnd(v), vecEnd(t), eps);
}
function vstr(v) { return "origin " + xy(v.origin) + " angle " + v.angle + " length " + v.length; }

function build(doc) {
    LazyLord.resetDiagnostics();
    return LazyLord.build(doc);
}

function rgba(r, g, b, a) { return { r: r, g: g, b: b, a: a === undefined ? 1 : a }; }

function rectPath(w, h, dx, dy) {
    dx = dx || 0; dy = dy || 0;
    return {
        closed: true,
        vertices: [[dx, dy], [dx + w, dy], [dx + w, dy + h], [dx, dy + h]],
        inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
        outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]]
    };
}

function canvasDoc(layers) {
    return { version: "1.0", source: "figma", name: "t", originSpace: "canvas",
             bounds: { x: 0, y: 0, width: 400, height: 300 }, layers: layers };
}

function vectorLayer(name, frame, subpaths, fills, strokes, extra) {
    var l = { id: name, name: name, type: "vector", frame: frame, subpaths: subpaths,
              fills: fills || [], strokes: strokes || [], windingRule: "nonzero" };
    if (extra) for (var k in extra) l[k] = extra[k];
    return l;
}

WScript.Echo("LazyLord - Illustrator builder (mocked DOM)");
WScript.Echo("");

// The gradient box used below: frame (100, 50) 200 x 100. Artboard top is 600,
// so in Illustrator it spans x 100..300, y 550 (top) .. 450 (bottom).
var BOX = { x: 100, y: 50, width: 200, height: 100, rotation: 0, opacity: 1 };
// Illustrator's own default for a linear gradient: left edge, mid-height, 0 deg,
// spanning the width.
var LINEAR_DEFAULT = { origin: [100, 500], angle: 0, length: 200 };
// IR: from the box's top-left to its bottom-right.
var LINEAR_TARGET = { origin: [100, 550], angle: Math.atan2(-100, 200) * 180 / Math.PI,
                      length: Math.sqrt(200 * 200 + 100 * 100) };

function linearPaint() {
    return { type: "linear-gradient", from: { x: 0, y: 0 }, to: { x: 1, y: 1 },
             stops: [ { position: 0.75, color: rgba(0, 0, 1, 0.5) },
                      { position: 0, color: rgba(1, 0, 0) },
                      { position: 0.25, color: rgba(0, 1, 0) } ] };
}

// 1) Native linear gradient: stops, and the matrix maths under either
//    concatenation order, whether the host keeps the move in the matrix (as
//    Illustrator does) or in origin/angle/length. Exactly one transform either
//    way: a read-back of the unchanged raw fields must not trigger a second.
(function () {
    var orders = ["append", "prepend"], models = ["matrix", "raw"];
    for (var n = 0; n < orders.length * models.length; n++) {
        var order = orders[n % 2], model = models[Math.floor(n / 2)];
        var tag = "gradient (" + order + ", " + model + "): ";
        resetMock();
        MOCK.concat = order;
        MOCK.gradModel = model;
        MOCK.gradDefault = LINEAR_DEFAULT;
        var aiDoc = openDoc();
        build(canvasDoc([vectorLayer("Blend", BOX, [rectPath(200, 100)], [linearPaint()])]));

        var path = aiDoc.pathItems[0];
        var grad = aiDoc.gradients[0];
        ok(tag + "one native gradient swatch", aiDoc.gradients.length === 1, String(aiDoc.gradients.length));
        ok(tag + "linear type", grad && grad.type === GradientType.LINEAR);
        ok(tag + "fill is a GradientColor on that swatch",
           path.fillColor.typename === "GradientColor" && path.fillColor.gradient === grad,
           path.fillColor.typename);

        var gs = grad.gradientStops;
        ok(tag + "3 stops (2 reused + 1 added)", gs.length === 3, String(gs.length));
        ok(tag + "stops sorted ascending: 0, 25, 75",
           near(gs[0].rampPoint, 0) && near(gs[1].rampPoint, 25) && near(gs[2].rampPoint, 75),
           gs[0].rampPoint + "," + gs[1].rampPoint + "," + gs[2].rampPoint);
        ok(tag + "stop colours follow the sort (red, green, blue)",
           gs[0].color.red === 255 && gs[1].color.green === 255 && gs[2].color.blue === 255 &&
           gs[0].color.blue === 0 && gs[2].color.red === 0);
        ok(tag + "stop opacity from alpha (100, 100, 50)",
           near(gs[0].opacity, 100) && near(gs[1].opacity, 100) && near(gs[2].opacity, 50),
           gs[0].opacity + "," + gs[1].opacity + "," + gs[2].opacity);
        ok(tag + "midpoints 50", gs[0].midPoint === 50 && gs[1].midPoint === 50 && gs[2].midPoint === 50);

        ok(tag + "exactly one gradient transform", MOCK.transforms.length === 1, String(MOCK.transforms.length));
        var t = MOCK.transforms[0];
        ok(tag + "transform moves gradients only",
           t && t.target === path && t.args[0] === false && t.args[1] === false && t.args[2] === true &&
           t.args[3] === false && t.args[4] === 1 && t.args[5] === Transformation.DOCUMENTORIGIN,
           t && String(t.args));

        // Apply the recorded matrix to Illustrator's default vector: it must land
        // exactly on the IR handles (converted to y-up).
        var o = mxApply(t.m, LINEAR_DEFAULT.origin);
        var e = mxApply(t.m, vecEnd(LINEAR_DEFAULT));
        ok(tag + "matrix maps default origin onto the IR start", nearPt(o, LINEAR_TARGET.origin, 1e-6), xy(o));
        ok(tag + "matrix maps default end onto the IR end", nearPt(e, [300, 450], 1e-6), xy(e));
        ok(tag + "read-back vector equals the target", vecNear(vec(path.fillColor), LINEAR_TARGET, 1e-6),
           vstr(vec(path.fillColor)));
        ok(tag + "no diagnostics", LazyLord.diagnostics.length === 0, diags());
    }
})();

// 2) DOCUMENTORIGIN away from the scripting origin: the second, translation-only
//    pass still lands the vector exactly.
(function () {
    var models = ["matrix", "raw"];
    for (var n = 0; n < models.length; n++) {
        var tag = "doc origin offset (" + models[n] + "): ";
        resetMock();
        MOCK.gradModel = models[n];
        MOCK.gradDefault = LINEAR_DEFAULT;
        MOCK.docOrigin = [37, -250];
        var aiDoc = openDoc();
        build(canvasDoc([vectorLayer("Blend", BOX, [rectPath(200, 100)], [linearPaint()])]));
        var path = aiDoc.pathItems[0];

        ok(tag + "two passes", MOCK.transforms.length === 2, String(MOCK.transforms.length));
        var m2 = MOCK.transforms[1] && MOCK.transforms[1].m;
        ok(tag + "second pass is a pure translation",
           m2 && near(m2.mValueA, 1) && near(m2.mValueB, 0) && near(m2.mValueC, 0) && near(m2.mValueD, 1),
           m2 && [m2.mValueA, m2.mValueB, m2.mValueC, m2.mValueD].join(","));
        ok(tag + "vector lands on the target", vecNear(vec(path.fillColor), LINEAR_TARGET, 1e-6),
           vstr(vec(path.fillColor)));
        ok(tag + "no diagnostics", LazyLord.diagnostics.length === 0, diags());
    }
})();

// 2b) A fresh GradientColor whose default is expressed through its matrix
//     (unit vector at the origin, scaled and moved): the effective vector is
//     what gets trusted and moved.
(function () {
    resetMock();
    MOCK.gradDefault = { origin: [0, 0], angle: 0, length: 1 };
    MOCK.gradDefaultMatrix = new Mx(200, 0, 0, 200, 100, 500); // = LINEAR_DEFAULT on screen
    var aiDoc = openDoc();
    build(canvasDoc([vectorLayer("Blend", BOX, [rectPath(200, 100)], [linearPaint()])]));
    var path = aiDoc.pathItems[0];
    ok("default in matrix: one transform", MOCK.transforms.length === 1, String(MOCK.transforms.length));
    ok("default in matrix: vector lands on the target", vecNear(vec(path.fillColor), LINEAR_TARGET, 1e-6),
       vstr(vec(path.fillColor)));
    ok("default in matrix: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

// 2c) Single-precision matrices, far from the origin: TX/TY in the thousands
//     round by more than 1e-4, and that must not count as a wrong matrix.
(function () {
    // 3000.000122 is not a float: it rounds to 3000, 1.22e-4 away.
    var want = [1, 0, 0, 1, 3000.000122, -2999.99988];
    resetMock();
    MOCK.float32 = true;
    var host = f32Mx(new Mx(want[0], want[1], want[2], want[3], want[4], want[5]));
    ok("float32: rounded TX really is more than 1e-4 off", Math.abs(host.mValueTX - want[4]) > 1e-4,
       String(host.mValueTX - want[4]));
    ok("float32: a rounded matrix is still the right matrix", LazyLord._ai_matrixIs(host, want));
    ok("float32: a matrix 0.5pt off is not", !LazyLord._ai_matrixIs(new Mx(1, 0, 0, 1, 3000.5, want[5]), want));

    resetMock();
    MOCK.float32 = true;
    var far = { x: 1234.567, y: 5678.9, width: 321.1, height: 123.4, rotation: 0, opacity: 1 };
    // Illustrator's default: left edge, mid-height (artboard top 600).
    MOCK.gradDefault = { origin: [far.x, 600 - far.y - far.height / 2], angle: 0, length: far.width };
    var paint = { type: "linear-gradient", from: { x: 0.1, y: 0.2 }, to: { x: 0.9, y: 0.7 },
                  stops: [ { position: 0, color: rgba(1, 0, 0) }, { position: 1, color: rgba(0, 0, 1) } ] };
    var aiDoc = openDoc();
    build(canvasDoc([vectorLayer("Far", far, [rectPath(far.width, far.height)], [paint])]));
    var o = [far.x + 0.1 * far.width, 600 - (far.y + 0.2 * far.height)];
    var e = [far.x + 0.9 * far.width, 600 - (far.y + 0.7 * far.height)];
    var tgt = { origin: o, angle: Math.atan2(e[1] - o[1], e[0] - o[0]) * 180 / Math.PI,
                length: Math.sqrt((e[0] - o[0]) * (e[0] - o[0]) + (e[1] - o[1]) * (e[1] - o[1])) };
    ok("float32 far away: one transform", MOCK.transforms.length === 1, String(MOCK.transforms.length));
    ok("float32 far away: vector within 0.01pt of the target", vecNear(vec(aiDoc.pathItems[0].fillColor), tgt, 0.01),
       vstr(vec(aiDoc.pathItems[0].fillColor)));
    ok("float32 far away: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

// 3) Radial: centre and radius (px == pt).
(function () {
    resetMock();
    MOCK.gradDefault = { origin: [200, 500], angle: 0, length: 111.8 };
    var aiDoc = openDoc();
    var paint = { type: "radial-gradient", from: { x: 0.5, y: 0.5 }, to: { x: 0.75, y: 0.5 },
                  stops: [ { position: 0, color: rgba(1, 1, 1) }, { position: 1, color: rgba(0, 0, 0) } ] };
    build(canvasDoc([vectorLayer("Glow", BOX, [rectPath(200, 100)], [paint])]));
    var v = vec(aiDoc.pathItems[0].fillColor);

    ok("radial: native radial type", aiDoc.gradients[0].type === GradientType.RADIAL);
    ok("radial: two stops reused, none added", aiDoc.gradients[0].gradientStops.length === 2);
    ok("radial: centre at the box centre", nearPt(v.origin, [200, 500], 1e-6), xy(v.origin));
    ok("radial: radius 50", near(v.length, 50, 1e-6), String(v.length));
    ok("radial: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

// 4) Compound path: every member painted, ONE transform on the compound item.
(function () {
    resetMock();
    MOCK.gradDefault = LINEAR_DEFAULT;
    var aiDoc = openDoc();
    build(canvasDoc([vectorLayer("Ring", BOX, [rectPath(200, 100), rectPath(100, 50, 50, 25)],
                                 [linearPaint()], [], { windingRule: "evenodd", frame: { x: 100, y: 50, width: 200, height: 100, opacity: 0.5 } })]));
    var cp = aiDoc.compoundPathItems[0];

    ok("compound: built as a compound path", cp && cp.pathItems.length === 2);
    ok("compound: both members carry the gradient",
       cp.pathItems[0].fillColor.typename === "GradientColor" && cp.pathItems[1].fillColor.typename === "GradientColor");
    ok("compound: one transform, on the compound item",
       MOCK.transforms.length === 1 && MOCK.transforms[0].target === cp, String(MOCK.transforms.length));
    ok("compound: every member's vector is on target",
       vecNear(vec(cp.pathItems[0].fillColor), LINEAR_TARGET, 1e-6) &&
       vecNear(vec(cp.pathItems[1].fillColor), LINEAR_TARGET, 1e-6));
    ok("compound: even-odd rule set on members", cp.pathItems[0].evenodd === true && cp.pathItems[1].evenodd === true);
    ok("compound: opacity on the compound item", cp.opacity === 50, String(cp.opacity));
    ok("compound: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

// 5) Gradient creation fails: flat colour from the first stop, reported.
(function () {
    resetMock();
    MOCK.gradientsFail = true;
    var aiDoc = openDoc();
    build(canvasDoc([vectorLayer("Blend", BOX, [rectPath(200, 100)], [linearPaint()])]));
    var path = aiDoc.pathItems[0];
    ok("no gradients: flat RGB fill", path.fillColor.typename === "RGBColor" && path.fillColor.blue === 255,
       JSON.stringify(path.fillColor));
    var d = findDiag("flat colour");
    ok("no gradients: reported as approximated", d && d.resolution === "approximated", diags());
})();

// 6) The read-back does not change after a transform (the host keeps the move
//    where it cannot be read, or ignores it): ONE transform, never a second one
//    built from the stale default; gradient kept, direction reported.
(function () {
    resetMock();
    MOCK.gradDefault = LINEAR_DEFAULT;
    MOCK.gradModel = "ignored";
    var aiDoc = openDoc();
    build(canvasDoc([vectorLayer("Blend", BOX, [rectPath(200, 100)], [linearPaint()])]));
    ok("stale read-back: exactly one transform", MOCK.transforms.length === 1, String(MOCK.transforms.length));
    ok("stale read-back: gradient kept", aiDoc.pathItems[0].fillColor.typename === "GradientColor");
    var d = findDiag("direction and length");
    ok("stale read-back: direction reported as approximated", d && d.resolution === "approximated", diags());
    ok("stale read-back: says the placement could not be confirmed", !!findDiag("could not be confirmed"), diags());
    ok("stale read-back: not reported as flattened", !findDiag("flat colour"), diags());
})();

// 6b) A read-back that moved, but not as the matrix should have moved it (here
//     only the origin follows): no second transform from it.
(function () {
    resetMock();
    MOCK.gradDefault = LINEAR_DEFAULT;
    MOCK.gradModel = "originOnly";
    openDoc();
    build(canvasDoc([vectorLayer("Blend", BOX, [rectPath(200, 100)], [linearPaint()])]));
    ok("inconsistent read-back: exactly one transform", MOCK.transforms.length === 1, String(MOCK.transforms.length));
    var d = findDiag("differently than expected");
    ok("inconsistent read-back: reported as approximated", d && d.resolution === "approximated", diags());
})();

// 7) A default vector nowhere near the object is not trusted.
(function () {
    resetMock();
    MOCK.gradDefault = { origin: [-5000, 9000], angle: 0, length: 200 };
    var aiDoc = openDoc();
    build(canvasDoc([vectorLayer("Blend", BOX, [rectPath(200, 100)], [linearPaint()])]));
    ok("foreign space: nothing transformed", MOCK.transforms.length === 0, String(MOCK.transforms.length));
    ok("foreign space: gradient kept", aiDoc.pathItems[0].fillColor.typename === "GradientColor");
    ok("foreign space: reported", !!findDiag("unexpected coordinate space"), diags());
})();

// 8) Gradient strokes: placed when the fill is solid; width preserved.
(function () {
    resetMock();
    MOCK.gradDefault = LINEAR_DEFAULT;
    var aiDoc = openDoc();
    build(canvasDoc([vectorLayer("Outline", BOX, [rectPath(200, 100)],
                                 [{ type: "solid", color: rgba(1, 1, 0) }],
                                 [{ paint: linearPaint(), weight: 4 }])]));
    var path = aiDoc.pathItems[0];
    ok("stroke gradient: stroke is a GradientColor", path.strokeColor.typename === "GradientColor");
    ok("stroke gradient: fill stays solid", path.fillColor.typename === "RGBColor");
    ok("stroke gradient: vector on target", vecNear(vec(path.strokeColor), LINEAR_TARGET, 1e-6),
       vstr(vec(path.strokeColor)));
    ok("stroke gradient: stroke width preserved through the transform", path.strokeWidth === 4, String(path.strokeWidth));
    ok("stroke gradient: no diagnostics", LazyLord.diagnostics.length === 0, diags());

    resetMock();
    MOCK.gradDefault = LINEAR_DEFAULT;
    aiDoc = openDoc();
    build(canvasDoc([vectorLayer("Both", BOX, [rectPath(200, 100)], [linearPaint()],
                                 [{ paint: linearPaint(), weight: 2 }])]));
    path = aiDoc.pathItems[0];
    ok("fill + stroke gradients: both native",
       path.fillColor.typename === "GradientColor" && path.strokeColor.typename === "GradientColor");
    ok("fill + stroke gradients: only the fill is transformed", MOCK.transforms.length === 1, String(MOCK.transforms.length));
    ok("fill + stroke gradients: stroke direction reported", !!findDiag("default direction"), diags());

    // The fill gradient cannot be created (flat), the stroke's can: nothing
    // stands in the stroke's way, so it is placed, and no false reason is given.
    resetMock();
    MOCK.gradDefault = LINEAR_DEFAULT;
    MOCK.gradientsFailCount = 1;
    aiDoc = openDoc();
    build(canvasDoc([vectorLayer("Both", BOX, [rectPath(200, 100)], [linearPaint()],
                                 [{ paint: linearPaint(), weight: 2 }])]));
    path = aiDoc.pathItems[0];
    ok("flat fill + gradient stroke: fill is flat", path.fillColor.typename === "RGBColor", path.fillColor.typename);
    ok("flat fill + gradient stroke: fill flattening reported", !!findDiag("Gradient fill rebuilt as flat colour"), diags());
    ok("flat fill + gradient stroke: stroke native", path.strokeColor.typename === "GradientColor");
    ok("flat fill + gradient stroke: stroke vector on target", vecNear(vec(path.strokeColor), LINEAR_TARGET, 1e-6),
       vstr(vec(path.strokeColor)));
    ok("flat fill + gradient stroke: no 'fill is a gradient too' claim", !findDiag("default direction"), diags());
    ok("flat fill + gradient stroke: only the fill is reported", LazyLord.diagnostics.length === 1, diags());
})();

// 8b) Compound path whose members share a style that one member's correction
//     moves for all: members already checked are read back again, and a member
//     knocked off target is reported instead of passing silently.
(function () {
    resetMock();
    MOCK.gradDefault = LINEAR_DEFAULT;
    MOCK.compoundFirstOnly = true;
    MOCK.memberMovesSiblings = true;
    var aiDoc = openDoc();
    build(canvasDoc([vectorLayer("Ring", BOX, [rectPath(200, 100), rectPath(100, 50, 50, 25)], [linearPaint()])]));
    var cp = aiDoc.compoundPathItems[0];
    ok("shared member style: second member corrected on its own",
       MOCK.transforms.length === 2 && MOCK.transforms[1].target === cp.pathItems[1], String(MOCK.transforms.length));
    ok("shared member style: the correction knocked the first member off (mock sanity)",
       !vecNear(vec(cp.pathItems[0].fillColor), LINEAR_TARGET, 1e-3));
    var d = findDiag("every contour");
    ok("shared member style: reported as approximated", d && d.resolution === "approximated", diags());
})();

// 9) Clipping group: structure, topmost mask, y-flipped clip vertices.
function clipOf(id, name, subpaths, rule) {
    // Every layer carries its OWN copy (applyOrigin mutates them).
    return JSON.parse(JSON.stringify({ id: id, name: name, subpaths: subpaths, windingRule: rule }));
}
(function () {
    resetMock();
    var aiDoc = openDoc();
    var clipShape = [{ closed: true, vertices: [[10, 20], [110, 20], [110, 70], [10, 70]],
                       inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
                       outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]] }];
    var red = [{ type: "solid", color: rgba(1, 0, 0) }];
    var doc = {
        version: "1.0", source: "illustrator", name: "t", originSpace: "document",
        bounds: { x: 5, y: 7, width: 200, height: 100 },
        layers: [
            vectorLayer("A", { x: 0, y: 0, width: 50, height: 50 }, [rectPath(50, 50)], red, [],
                        { clip: clipOf("m1", "Mask", clipShape) }),
            { id: "B", name: "B", type: "text", frame: { x: 20, y: 30, width: 120, height: 30 },
              characters: "Hi", fontFamily: "Arial", fontStyle: "Regular", fontSize: 24,
              color: rgba(0, 0, 0), baseline: 54, anchorX: 20, clip: clipOf("m1", "Mask", clipShape) },
            vectorLayer("C", { x: 0, y: 0, width: 50, height: 50 }, [rectPath(50, 50)], red)
        ]
    };
    var res = build(doc);

    ok("clip: three layers created", res.layersCreated === 3, String(res.layersCreated));
    ok("clip: one group", aiDoc.groupItems.length === 1, String(aiDoc.groupItems.length));
    var g = aiDoc.groupItems[0];
    ok("clip: group is clipped", g.clipped === true);
    ok("clip: group named after the mask", g.name === "Mask", g.name);
    ok("clip: mask + two members inside", g.pageItems.length === 3, String(g.pageItems.length));
    var mask = g.pageItems[0];
    ok("clip: topmost item is the clipping path",
       mask.typename === "PathItem" && mask.clipping === true && mask.filled === false && mask.stroked === false,
       mask.typename + " clipping=" + mask.clipping);
    ok("clip: members are the path A and the text B",
       g.pageItems[1].typename === "TextFrame" && g.pageItems[2].typename === "PathItem" && g.pageItems[2].name === "A");
    ok("clip: C stays outside, above the group",
       aiDoc.pageItems.length === 2 && aiDoc.pageItems[0].name === "C" && aiDoc.pageItems[1] === g);

    // Frame space (10,20)..(110,70), shifted by the document origin (5,7), then
    // flipped against the artboard top at y = 600.
    var want = [[15, 573], [115, 573], [115, 523], [15, 523]];
    var got = [];
    for (var i = 0; i < mask.pathPoints.length; i++) got.push(mask.pathPoints[i].anchor);
    var same = got.length === 4;
    for (var j = 0; same && j < 4; j++) same = nearPt(got[j], want[j]);
    ok("clip: vertices absolute and y-flipped", same, got.join(" "));
    ok("clip: mask closed", mask.closed === true);
    ok("clip: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

// 10) Several contours make a compound clipping path.
(function () {
    resetMock();
    var aiDoc = openDoc();
    var shape = [rectPath(100, 100), rectPath(50, 50, 25, 25)];
    build(canvasDoc([vectorLayer("A", { x: 0, y: 0, width: 100, height: 100 }, [rectPath(100, 100)],
                                 [{ type: "solid", color: rgba(1, 0, 0) }], [],
                                 { clip: clipOf("m2", "Donut", shape, "evenodd") })]));
    var g = aiDoc.groupItems[0];
    var mask = g.pageItems[0];
    ok("compound clip: topmost item is a compound path", mask.typename === "CompoundPathItem", mask.typename);
    ok("compound clip: both contours are clipping paths",
       mask.pathItems.length === 2 && mask.pathItems[0].clipping === true && mask.pathItems[1].clipping === true);
    ok("compound clip: even-odd", mask.pathItems[0].evenodd === true);
    ok("compound clip: group clipped", g.clipped === true);
})();

// 11) Same clip id, not consecutive: grouped together, reordering reported.
(function () {
    resetMock();
    var aiDoc = openDoc();
    var shape = [rectPath(100, 100)];
    var red = [{ type: "solid", color: rgba(1, 0, 0) }];
    build(canvasDoc([
        vectorLayer("A", { x: 0, y: 0, width: 10, height: 10 }, [rectPath(10, 10)], red, [], { clip: clipOf("m3", "M", shape) }),
        vectorLayer("B", { x: 0, y: 0, width: 10, height: 10 }, [rectPath(10, 10)], red),
        vectorLayer("C", { x: 0, y: 0, width: 10, height: 10 }, [rectPath(10, 10)], red, [], { clip: clipOf("m3", "M", shape) })
    ]));
    var g = aiDoc.groupItems[0];
    ok("interleaved: one group holds A and C", aiDoc.groupItems.length === 1 && g.pageItems.length === 3 &&
       g.pageItems[1].name === "C" && g.pageItems[2].name === "A");
    ok("interleaved: B stays above the group", aiDoc.pageItems[0].name === "B" && aiDoc.pageItems[1] === g);
    var d = findDiag("sits below");
    ok("interleaved: C's move is reported", d && d.object === "C" && d.resolution === "approximated", diags());
})();

// 11b) The reordering warning follows what was actually built.
function countDiag(text) {
    var n = 0;
    for (var i = 0; i < LazyLord.diagnostics.length; i++) {
        if (LazyLord.diagnostics[i].reason.indexOf(text) >= 0) n++;
    }
    return n;
}
(function () {
    var shape = [rectPath(100, 100)];
    var red = [{ type: "solid", color: rgba(1, 0, 0) }];
    function sq(name, clipId, extra) {
        var l = vectorLayer(name, { x: 0, y: 0, width: 10, height: 10 }, [rectPath(10, 10)], red, [], extra);
        if (clipId) l.clip = clipOf(clipId, "M" + clipId, shape);
        return l;
    }

    // The first layer of the mask fails (no contours): nothing was built in
    // between, so the next one moves nowhere.
    resetMock();
    var aiDoc = openDoc();
    build(canvasDoc([sq("A", "m1", { subpaths: [] }), sq("C", "m1")]));
    ok("failed first member: C built into the group", aiDoc.groupItems.length === 1 &&
       aiDoc.groupItems[0].pageItems.length === 2 && aiDoc.groupItems[0].pageItems[1].name === "C");
    ok("failed first member: no reordering warning", countDiag("sits below") === 0, diags());
    ok("failed first member: the failure itself is reported", !!findDiag("no contours"), diags());

    // Same with a layer type that is not rebuilt. (This used to be a group;
    // groups are rebuilt or flattened now, so an unknown type stands in.)
    resetMock();
    openDoc();
    var odd = { id: "S", name: "S", type: "slice", frame: { x: 0, y: 0, width: 10, height: 10 },
                clip: clipOf("m1", "Mm1", shape) };
    build(canvasDoc([odd, sq("C", "m1")]));
    ok("unsupported first member: no reordering warning", countDiag("sits below") === 0, diags());
    ok("unsupported first member: the type itself is reported", !!findDiag("are not rebuilt"), diags());

    // A different mask whose only layer failed leaves an empty group: nothing
    // visible sits between A and C.
    resetMock();
    openDoc();
    build(canvasDoc([sq("A", "m1"), sq("X", "m2", { subpaths: [] }), sq("C", "m1")]));
    ok("empty group in between: no reordering warning", countDiag("sits below") === 0, diags());

    // A failed unclipped layer in between built nothing either.
    resetMock();
    openDoc();
    build(canvasDoc([sq("A", "m1"), sq("B", null, { subpaths: [] }), sq("C", "m1")]));
    ok("failed layer in between: no reordering warning", countDiag("sits below") === 0, diags());

    // A layer of a later mask is not moved by an earlier mask's group sitting
    // below it: [A m1, X m2 (fails), C m1, Y m2] — m2's group is above m1's.
    resetMock();
    openDoc();
    build(canvasDoc([sq("A", "m1"), sq("X", "m2", { subpaths: [] }), sq("C", "m1"), sq("Y", "m2")]));
    ok("earlier group below: no reordering warning", countDiag("sits below") === 0, diags());

    // Every layer pulled below B is reported, not just the first of the run.
    resetMock();
    aiDoc = openDoc();
    build(canvasDoc([sq("A", "m1"), sq("B"), sq("C", "m1"), sq("D", "m1")]));
    ok("run after a gap: C and D both reported", countDiag("sits below") === 2, diags());
    ok("run after a gap: B stays above the group", aiDoc.pageItems[0].name === "B" && aiDoc.pageItems[1] === aiDoc.groupItems[0]);
})();

// 12) Rotation: text on a known baseline turns clockwise about the IR centre.
(function () {
    resetMock();
    var aiDoc = openDoc();
    build(canvasDoc([{ id: "T", name: "T", type: "text",
                       frame: { x: 100, y: 100, width: 120, height: 30, rotation: 30 },
                       characters: "Hi", fontFamily: "Arial", fontStyle: "Regular", fontSize: 24,
                       color: rgba(0, 0, 0), baseline: 124, anchorX: 100 }]));
    var tf = aiDoc.textFrames[0];
    ok("text rotation: rotate() gets -30 (Illustrator turns counter-clockwise)",
       tf.rotations.length === 1 && tf.rotations[0] === -30, String(tf.rotations));

    // Independent expectation, in Illustrator space: the anchor (100, 476) turned
    // 30 deg clockwise on screen about the box centre (160, 485).
    var r = -30 * Math.PI / 180, dx = 100 - 160, dy = 476 - 485;
    var want = [160 + dx * Math.cos(r) - dy * Math.sin(r), 485 + dx * Math.sin(r) + dy * Math.cos(r)];
    ok("text rotation: anchor lands where the turned box puts it", nearPt(tf.anchor, want, 1e-6),
       xy(tf.anchor) + " want " + xy(want));
    var ra = LazyLord.rotatedTextAnchor({ frame: { x: 100, y: 100, width: 120, height: 30, rotation: 30 },
                                          baseline: 124, anchorX: 100, fontSize: 24 });
    ok("text rotation: matches LazyLord.rotatedTextAnchor", nearPt(tf.anchor, [ra[0], 600 - ra[1]], 1e-6));
    ok("text rotation: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

// 13) Rotation without a baseline: the frame is created on the IR's estimated
//     anchor (0.8 x fontSize below the box top), then turned about the IR centre.
(function () {
    resetMock();
    var aiDoc = openDoc();
    build(canvasDoc([{ id: "T", name: "T", type: "text",
                       frame: { x: 10, y: 20, width: 120, height: 30, rotation: 90 },
                       characters: "Hi", fontFamily: "Arial", fontStyle: "Regular", fontSize: 24,
                       color: rgba(0, 0, 0) }]));
    var tf = aiDoc.textFrames[0];
    // Unrotated, the anchor is (10, 20 + 19.2) in the IR: (10, 560.8) here.
    // Turned 90 clockwise about (70, 565): (dx, dy) -> (dy, -dx), so
    // (-60, -4.2) -> (-4.2, 60).
    ok("baseline-less rotation: rotate() gets -90", tf.rotations[0] === -90, String(tf.rotations));
    ok("baseline-less rotation: anchor at (65.8, 625)", nearPt(tf.anchor, [65.8, 625], 1e-6), xy(tf.anchor));
    ok("baseline-less rotation: the frame now stands upright (30 wide, 120 tall)",
       near(tf.width, 30, 1e-6) && near(tf.height, 120, 1e-6), tf.width + "x" + tf.height);

    resetMock();
    aiDoc = openDoc();
    build(canvasDoc([{ id: "U", name: "U", type: "text", frame: { x: 10, y: 20, width: 120, height: 30 },
                       characters: "Hi", fontFamily: "Arial", fontStyle: "Regular", fontSize: 24,
                       color: rgba(0, 0, 0) }]));
    tf = aiDoc.textFrames[0];
    ok("unrotated text: no rotate() call", tf.rotations.length === 0);
    ok("unrotated text: created as point text on the estimated anchor (10, 560.8)",
       MOCK.pointTexts.length === 1 && nearPt(MOCK.pointTexts[0], [10, 560.8]) && nearPt(tf.anchor, [10, 560.8]),
       MOCK.pointTexts.join(" ") + " / " + xy(tf.anchor));
    ok("unrotated text: textFrames.add() is not used", MOCK.textAdds === 0, String(MOCK.textAdds));
})();

// 13b) Figma-shaped text (no baseline, no anchorX): "Hi" in a fixed 300-wide
//      box at x = 100. Like After Effects and Photoshop, Illustrator must put
//      it on LazyLord.textAnchor: the box's left edge, centre (x = 250) or right
//      edge by alignment, 0.8 x fontSize below the box top (y 69.2, which is
//      530.8 under the artboard top at 600).
function figmaText(align, rotation) {
    var l = { id: "F", name: "F", type: "text",
              frame: { x: 100, y: 50, width: 300, height: 30, rotation: rotation || 0 },
              characters: "Hi", fontFamily: "Inter", fontStyle: "Regular", fontSize: 24,
              color: rgba(0, 0, 0) };
    if (align) l.textAlignHorizontal = align;
    return l;
}
// The mock's 120pt line starts at the anchor, is centred on it, or ends there.
var FIGMA_CASES = [ { align: "left", x: 100, j: Justification.LEFT, lineLeft: 100 },
                    { align: "center", x: 250, j: Justification.CENTER, lineLeft: 190 },
                    { align: "right", x: 400, j: Justification.RIGHT, lineLeft: 280 } ];
/** Turn p clockwise on screen by deg about c, in Illustrator's y-up space. */
function cwUp(p, c, deg) {
    var r = -deg * Math.PI / 180, dx = p[0] - c[0], dy = p[1] - c[1];
    return [c[0] + dx * Math.cos(r) - dy * Math.sin(r), c[1] + dx * Math.sin(r) + dy * Math.cos(r)];
}
/** The fixed point of the rotation (clockwise on screen by deg) taking p to q. */
function pivotOf(p, q, deg) {
    var r = -deg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    // q = c + R(p - c)  =>  (I - R) c = q - R p, with I - R = [[1-cs, sn], [-sn, 1-cs]].
    var bx = q[0] - (cs * p[0] - sn * p[1]), by = q[1] - (sn * p[0] + cs * p[1]);
    var a = 1 - cs, det = a * a + sn * sn;
    return [(a * bx - sn * by) / det, (sn * bx + a * by) / det];
}
(function () {
    for (var i = 0; i < FIGMA_CASES.length; i++) {
        var c = FIGMA_CASES[i], tag = "figma " + c.align + ": ";
        resetMock();
        var aiDoc = openDoc();
        build(canvasDoc([figmaText(c.align)]));
        var tf = aiDoc.textFrames[0];
        ok(tag + "created once as point text, never via textFrames.add()",
           MOCK.pointTexts.length === 1 && MOCK.textAdds === 0, MOCK.pointTexts.length + " / " + MOCK.textAdds);
        ok(tag + "created on the alignment point (" + c.x + ", 530.8)",
           nearPt(MOCK.pointTexts[0], [c.x, 530.8]), xy(MOCK.pointTexts[0]));
        var ta = LazyLord.textAnchor(figmaText(c.align));
        ok(tag + "that is LazyLord.textAnchor, y-flipped", nearPt(MOCK.pointTexts[0], [ta[0], 600 - ta[1]]),
           xy(MOCK.pointTexts[0]) + " vs " + xy(ta));
        ok(tag + "justified so the anchor is the alignment point",
           tf.textRange.paragraphAttributes.justification === c.j, String(tf.textRange.paragraphAttributes.justification));
        ok(tag + "not rotated", tf.rotations.length === 0, String(tf.rotations));
        tf._layout(); // let the mock's layout catch up, as Illustrator's does
        ok(tag + "the anchor stays put and the line is laid out around it",
           nearPt(tf.anchor, [c.x, 530.8]) && near(tf.geometricBounds[0], c.lineLeft),
           xy(tf.anchor) + " line from " + tf.geometricBounds[0]);
        ok(tag + "no diagnostics", LazyLord.diagnostics.length === 0, diags());
    }
})();

// 13c) Figma-shaped text rotated 30 degrees: the anchor must end on
//      LazyLord.rotatedTextAnchor, and the text must turn about the IR frame
//      centre (250, 65), which is (250, 535) here.
(function () {
    var pivot = [250, 535];
    for (var i = 0; i < FIGMA_CASES.length; i++) {
        var c = FIGMA_CASES[i], tag = "figma " + c.align + " turned 30: ";
        resetMock();
        var aiDoc = openDoc();
        build(canvasDoc([figmaText(c.align, 30)]));
        var tf = aiDoc.textFrames[0];
        ok(tag + "rotate() gets -30 once", tf.rotations.length === 1 && tf.rotations[0] === -30, String(tf.rotations));
        ok(tag + "justified before it was turned", tf.turnedWith[0] === c.j, String(tf.turnedWith));
        ok(tag + "created on the unrotated alignment point", MOCK.pointTexts.length === 1 &&
           nearPt(MOCK.pointTexts[0], [c.x, 530.8]), MOCK.pointTexts.join(" "));

        // Independent expectation: the anchor (x, 530.8) turned 30 deg clockwise
        // on screen about the IR centre.
        var want = cwUp([c.x, 530.8], pivot, 30);
        ok(tag + "anchor lands where the turned box puts it", nearPt(tf.anchor, want, 1e-6),
           xy(tf.anchor) + " want " + xy(want));
        var ra = LazyLord.rotatedTextAnchor(figmaText(c.align, 30));
        ok(tag + "that is LazyLord.rotatedTextAnchor, y-flipped", nearPt(tf.anchor, [ra[0], 600 - ra[1]], 1e-6),
           xy(tf.anchor) + " vs " + xy(ra));

        // The pivot, from two points rigidly attached to the text: the anchor,
        // and the centre of the laid-out line (off the anchor unless centred).
        ok(tag + "pivot from the anchor is the IR centre", nearPt(pivotOf([c.x, 530.8], tf.anchor, 30), pivot, 1e-6),
           xy(pivotOf([c.x, 530.8], tf.anchor, 30)));
        var lineCentre = [c.lineLeft + 60, 530.8 + 24 - 15];
        ok(tag + "pivot from the line's centre is the IR centre", nearPt(pivotOf(lineCentre, boxCentre(tf), 30), pivot, 1e-6),
           xy(pivotOf(lineCentre, boxCentre(tf), 30)));
        ok(tag + "no diagnostics", LazyLord.diagnostics.length === 0, diags());
    }

    // Illustrator does not report the anchor: the bounds centre is tracked
    // instead. It is measured after justifying (the mock lays the line out when
    // asked), so centred text still turns about the IR centre.
    resetMock();
    MOCK.textNoAnchor = true;
    var aiDoc2 = openDoc();
    build(canvasDoc([figmaText("center", 30)]));
    var tf2 = aiDoc2.textFrames[0];
    ok("figma center turned 30, no anchor: the true anchor still lands on rotatedTextAnchor",
       nearPt(tf2._a, cwUp([250, 530.8], pivot, 30), 1e-6), xy(tf2._a));
    ok("figma center turned 30, no anchor: pivot from the line's centre is the IR centre",
       nearPt(pivotOf([250, 539.8], boxCentre(tf2), 30), pivot, 1e-6), xy(pivotOf([250, 539.8], boxCentre(tf2), 30)));
    var d = findDiag("did not report the text's baseline anchor");
    ok("figma center turned 30, no anchor: the bounds fallback is reported",
       d && d.object === "F" && d.resolution === "approximated" && LazyLord.diagnostics.length === 1, diags());
})();

// 13d) Justification that cannot be set is reported; the text keeps its anchor.
(function () {
    resetMock();
    MOCK.textNoParagraphs = true;
    var aiDoc = openDoc();
    build(canvasDoc([figmaText("center")]));
    var tf = aiDoc.textFrames[0];
    ok("no justification: still created on the alignment point", nearPt(tf.anchor, [250, 530.8]), xy(tf.anchor));
    var d = findDiag("Text alignment \"center\" could not be applied");
    ok("no justification: reported as approximated",
       d && d.object === "F" && d.resolution === "approximated" && LazyLord.diagnostics.length === 1, diags());
})();

// 14) Rotated image about its centre; embedding only for generated files.
(function () {
    resetMock();
    var aiDoc = openDoc();
    build(canvasDoc([
        { id: "G", name: "Gen", type: "image", frame: { x: 50, y: 60, width: 200, height: 100, rotation: 90, opacity: 0.5 },
          filePath: "C:\\temp\\gen.png", pixelWidth: 400, pixelHeight: 200 },
        { id: "O", name: "Photo", type: "image", frame: { x: 0, y: 0, width: 400, height: 200 },
          filePath: "D:\\art\\photo.jpg", isOriginalFile: true, pixelWidth: 400, pixelHeight: 200 }
    ]));

    ok("embed: only the generated image is embedded",
       MOCK.embedded.length === 1 && MOCK.embedded[0] === "Gen", String(MOCK.embedded));
    var raster = aiDoc.pageItems[1];
    ok("embed: generated image replaced by embedded art", raster.typename === "RasterItem", raster.typename);
    ok("embed: name and opacity restored", raster.name === "Gen" && raster.opacity === 50,
       raster.name + " / " + raster.opacity);
    ok("embed: original stays a linked PlacedItem",
       aiDoc.pageItems[0].typename === "PlacedItem" && aiDoc.pageItems[0].name === "Photo");

    // Box (50,60) 200x100 -> centre (150, 110) -> Illustrator (150, 490).
    var gb = raster.geometricBounds;
    ok("image rotation: bounds turned upright about the centre (100..200 x 390..590)",
       near(gb[0], 100) && near(gb[1], 590) && near(gb[2], 200) && near(gb[3], 390), gb.join(","));
    ok("image rotation: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

(function () {
    // Sign check on a corner: clockwise on screen, the top-left corner goes to
    // the top-right.
    resetMock();
    var aiDoc = openDoc();
    build(canvasDoc([{ id: "O", name: "Photo", type: "image", frame: { x: 50, y: 60, width: 200, height: 100, rotation: 90 },
                       filePath: "D:\\art\\photo.jpg", isOriginalFile: true, pixelWidth: 400, pixelHeight: 200 }]));
    var pl = aiDoc.placedItems[0];
    ok("image rotation: rotate() gets -90", pl.rotations.length === 1 && pl.rotations[0] === -90, String(pl.rotations));
    ok("image rotation: top-left corner ends top-right", nearPt(pl._corners[0], [200, 590], 1e-6), xy(pl._corners[0]));
})();

// 15) A new document matches the source canvas.
(function () {
    resetMock();
    app.documents.length = 0;
    build({ version: "1.0", source: "illustrator", name: "t", originSpace: "document",
            canvas: { width: 612, height: 792, name: "Letter" },
            bounds: { x: 30, y: 40, width: 100, height: 50 }, layers: [] });
    ok("canvas: document-space source gets its page size",
       MOCK.docsAdded.length === 1 && MOCK.docsAdded[0][0] === DocumentColorSpace.RGB &&
       MOCK.docsAdded[0][1] === 612 && MOCK.docsAdded[0][2] === 792, JSON.stringify(MOCK.docsAdded));

    resetMock();
    app.documents.length = 0;
    build(canvasDoc([]));
    ok("canvas: canvas-space source gets the selection size",
       MOCK.docsAdded.length === 1 && MOCK.docsAdded[0][1] === 400 && MOCK.docsAdded[0][2] === 300,
       JSON.stringify(MOCK.docsAdded));

    resetMock();
    openDoc();
    build(canvasDoc([]));
    ok("destination default: the open document is used", MOCK.docsAdded.length === 0, JSON.stringify(MOCK.docsAdded));

    resetMock();
    openDoc();
    var fresh = canvasDoc([]);
    fresh.options = { destination: "new" };
    build(fresh);
    ok("destination new: a new document although one is open, at the selection size",
       MOCK.docsAdded.length === 1 && MOCK.docsAdded[0][1] === 400 && MOCK.docsAdded[0][2] === 300,
       JSON.stringify(MOCK.docsAdded));

    resetMock();
    openDoc();
    build(canvasDoc([]));
    ok("canvas: an open document is reused", MOCK.docsAdded.length === 0);
})();

// --- Group hierarchy ---------------------------------------------------------
// Leaves are 10 x 10 squares named after themselves. A group's frame is its
// union box, which the builder does not need; only its opacity matters.
var RED = [{ type: "solid", color: rgba(1, 0, 0) }];
var CLIP_SHAPE = [{ closed: true, vertices: [[10, 20], [110, 20], [110, 70], [10, 70]],
                    inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
                    outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]] }];

function leaf(name, extra) {
    return vectorLayer(name, { x: 0, y: 0, width: 10, height: 10 }, [rectPath(10, 10)], RED, [], extra);
}
function faded(name, opacity) {
    return leaf(name, { frame: { x: 0, y: 0, width: 10, height: 10, opacity: opacity } });
}
function clipped(name, id) {
    var l = leaf(name);
    l.clip = clipOf(id, "Mask", CLIP_SHAPE);
    return l;
}
function grp(name, children, opacity, extra) {
    var g = { id: name, name: name, type: "group", frame: { x: 0, y: 0, width: 10, height: 10 }, children: children };
    if (opacity !== undefined) g.frame.opacity = opacity;
    if (extra) for (var k in extra) g[k] = extra[k];
    return g;
}
function withOptions(doc, options) { doc.options = options; return doc; }
function isOutline(it) {
    return it.clipping === true ||
        (it.typename === "CompoundPathItem" && it.pathItems.length > 0 && it.pathItems[0].clipping === true);
}
/** A container's items by name, topmost first; clip outlines read "<clip>". */
function stack(container) {
    // Not a container (a path, or missing): say so instead of aborting the suite.
    if (!container || !container.pageItems) return "(" + (container ? container.typename : "nothing") + ")";
    var out = [];
    for (var i = 0; i < container.pageItems.length; i++) {
        var it = container.pageItems[i];
        out.push(isOutline(it) ? "<clip>" : it.name);
    }
    return out.join(",");
}
function anchors(path) {
    var got = [];
    if (!path || !path.pathPoints) return got; // not a path: compares as no match
    for (var i = 0; i < path.pathPoints.length; i++) got.push(path.pathPoints[i].anchor);
    return got;
}
function sameAnchors(got, want) {
    if (got.length !== want.length) return false;
    for (var i = 0; i < want.length; i++) if (!nearPt(got[i], want[i])) return false;
    return true;
}
// CLIP_SHAPE on a canvas-space document, flipped against the artboard top (600).
var CLIP_FLIPPED = [[10, 580], [110, 580], [110, 530], [10, 530]];

// 16) Default (and explicit flatten, and "combine", which Illustrator ignores):
//     exactly the old output — every leaf straight into the document, in
//     stacking order, no GroupItem and nothing reported for an opaque group.
(function () {
    var variants = [
        { tag: "default", options: null },
        { tag: "explicit flatten", options: { hierarchy: "flatten" } },
        { tag: "combine", options: { layout: "combine" } },
        { tag: "combine + flatten", options: { layout: "combine", hierarchy: "flatten" } }
    ];
    for (var n = 0; n < variants.length; n++) {
        var v = variants[n], tag = "flatten (" + v.tag + "): ";
        resetMock();
        var aiDoc = openDoc();
        var doc = canvasDoc([leaf("A"), grp("G", [leaf("B"), leaf("C")]), leaf("D")]);
        if (v.options) doc.options = v.options;
        var res = build(doc);
        ok(tag + "every leaf built into the document, in order", stack(aiDoc) === "D,C,B,A", stack(aiDoc));
        ok(tag + "no GroupItem", aiDoc.groupItems.length === 0, String(aiDoc.groupItems.length));
        ok(tag + "four layers created", res.layersCreated === 4, String(res.layersCreated));
        ok(tag + "an opaque group leaves its layers' opacity alone",
           aiDoc.pageItems[1].opacity === 100 && aiDoc.pageItems[2].opacity === 100);
        ok(tag + "no diagnostics (the group is not reported as dropped)", LazyLord.diagnostics.length === 0, diags());
    }
})();

// 17) Flatten with group opacity: multiplied into the leaves; ONE approximated
//     diagnostic when a translucent group had several layers that may overlap.
(function () {
    resetMock();
    var aiDoc = openDoc();
    build(canvasDoc([grp("G", [faded("B", 0.8), leaf("C")], 0.5), grp("H", [leaf("E")], 0.5)]));
    ok("flatten opacity: leaves in the document", stack(aiDoc) === "E,C,B" && aiDoc.groupItems.length === 0, stack(aiDoc));
    ok("flatten opacity: 80% x 50% = 40%, and 50%",
       aiDoc.pageItems[2].opacity === 40 && aiDoc.pageItems[1].opacity === 50,
       aiDoc.pageItems[2].opacity + " / " + aiDoc.pageItems[1].opacity);
    ok("flatten opacity: a one-layer group folds exactly (50%)", aiDoc.pageItems[0].opacity === 50, String(aiDoc.pageItems[0].opacity));
    var d = findDiag("Groups are flattened");
    ok("flatten opacity: one approximated diagnostic, naming G only",
       LazyLord.diagnostics.length === 1 && d && d.resolution === "approximated" && d.object === "G" &&
       d.reason.indexOf("this group") >= 0, diags());

    // Two lossy groups (one nested in an opaque group): still one diagnostic.
    resetMock();
    openDoc();
    build(canvasDoc([grp("G1", [leaf("A"), leaf("B")], 0.5), grp("G2", [grp("G3", [leaf("C"), leaf("D")], 0.9)])]));
    d = findDiag("Groups are flattened");
    ok("flatten opacity: several groups share one diagnostic",
       countDiag("Groups are flattened") === 1 && d && d.object === "G1, G3" && d.reason.indexOf("2 groups") >= 0, diags());

    // A translucent group whose only child is a group of two overlapping
    // layers is just as lossy: what counts is its leaves, not its direct children.
    resetMock();
    aiDoc = openDoc();
    build(canvasDoc([grp("G1", [grp("G2", [leaf("A"), leaf("B")])], 0.5)]));
    ok("flatten opacity (one child group): both leaves folded to 50%",
       stack(aiDoc) === "B,A" && aiDoc.pageItems[0].opacity === 50 && aiDoc.pageItems[1].opacity === 50,
       stack(aiDoc) + " " + aiDoc.pageItems[0].opacity + "/" + aiDoc.pageItems[1].opacity);
    d = findDiag("Groups are flattened");
    ok("flatten opacity (one child group): one approximated diagnostic, naming G1",
       LazyLord.diagnostics.length === 1 && d && d.resolution === "approximated" && d.object === "G1" &&
       d.reason.indexOf("this group") >= 0, diags());

    // Both levels translucent: each fades the two layers on its own, so both count.
    resetMock();
    openDoc();
    build(canvasDoc([grp("G1", [grp("G2", [leaf("A"), leaf("B")], 0.5)], 0.5)]));
    d = findDiag("Groups are flattened");
    ok("flatten opacity (nested translucent groups): one diagnostic naming both",
       countDiag("Groups are flattened") === 1 && d && d.object === "G1, G2" && d.reason.indexOf("2 groups") >= 0, diags());

    // More than three lossy groups: the first three are named, the rest counted.
    resetMock();
    openDoc();
    build(canvasDoc([grp("P", [leaf("A"), leaf("B")], 0.5), grp("Q", [leaf("C"), leaf("D")], 0.5),
                     grp("R", [leaf("E"), leaf("F")], 0.5), grp("S", [leaf("G"), leaf("H")], 0.5)]));
    d = findDiag("Groups are flattened");
    ok("flatten opacity (four groups): three named, the rest counted",
       countDiag("Groups are flattened") === 1 && d && d.object === "P, Q, R and 1 more" &&
       d.reason.indexOf("4 groups") >= 0, diags());

    // Several direct children but a single leaf (the other child is an empty
    // group): folding into that one layer is exact, so only the empty group is reported.
    resetMock();
    aiDoc = openDoc();
    build(canvasDoc([grp("G1", [leaf("A"), grp("G2", [])], 0.5)]));
    ok("flatten opacity (one leaf, empty sibling group): the leaf is folded to 50%",
       stack(aiDoc) === "A" && aiDoc.pageItems[0].opacity === 50, stack(aiDoc));
    ok("flatten opacity (one leaf, empty sibling group): only the empty group is reported",
       LazyLord.diagnostics.length === 1 && countDiag("Groups are flattened") === 0 &&
       LazyLord.diagnostics[0].object === "G2" && LazyLord.diagnostics[0].resolution === "skipped", diags());
})();

// 18) hierarchy "groups": nested GroupItems, named, with the group's own
//     opacity, children in stacking order inside each.
(function () {
    resetMock();
    var aiDoc = openDoc();
    var res = build(withOptions(canvasDoc([
        leaf("A"),
        grp("G1", [faded("B", 0.8), grp("G2", [leaf("C"), leaf("D")], 0.25), leaf("E")], 0.5),
        leaf("F")
    ]), { hierarchy: "groups" }));
    var g1 = aiDoc.pageItems[1];
    ok("groups: the document holds F, G1, A (topmost first)", stack(aiDoc) === "F,G1,A", stack(aiDoc));
    ok("groups: G1 is the document's only GroupItem", g1.typename === "GroupItem" && aiDoc.groupItems.length === 1);
    ok("groups: G1 named after the group, at 50%", g1.name === "G1" && g1.opacity === 50, g1.name + " / " + g1.opacity);
    ok("groups: G1 holds E, G2, B (topmost first)", stack(g1) === "E,G2,B", stack(g1));
    var g2 = g1.pageItems[1];
    ok("groups: G2 nested in G1, named, at 25%",
       g2.typename === "GroupItem" && g2.parent === g1 && g2.name === "G2" && g2.opacity === 25,
       g2.typename + " " + g2.name + " / " + g2.opacity);
    ok("groups: G2 holds D over C", stack(g2) === "D,C", stack(g2));
    ok("groups: a leaf keeps its own opacity (80%), not multiplied by its group's",
       g1.pageItems[2].opacity === 80, String(g1.pageItems[2].opacity));
    ok("groups: G2's leaves untouched", g2.pageItems[0].opacity === 100 && g2.pageItems[1].opacity === 100);
    ok("groups: plain groups are not clipped", g1.clipped === false && g2.clipped === false);
    ok("groups: six leaf layers counted (groups are not)", res.layersCreated === 6, String(res.layersCreated));
    ok("groups: no diagnostics", LazyLord.diagnostics.length === 0, diags());

    // A group without a name or opacity keeps Illustrator's defaults.
    resetMock();
    aiDoc = openDoc();
    var anon = grp("", [leaf("A")]);
    build(withOptions(canvasDoc([anon]), { hierarchy: "groups" }));
    ok("groups: unnamed group keeps Illustrator's name, full opacity",
       aiDoc.groupItems.length === 1 && aiDoc.groupItems[0].name === "" && aiDoc.groupItems[0].opacity === 100,
       aiDoc.groupItems.length + " " + (aiDoc.groupItems[0] ? aiDoc.groupItems[0].name + " / " + aiDoc.groupItems[0].opacity : ""));
})();

// 18b) Text and a generated image inside a group; "combine" changes nothing.
(function () {
    resetMock();
    var aiDoc = openDoc();
    build(withOptions(canvasDoc([grp("Card", [
        { id: "I", name: "Gen", type: "image", frame: { x: 0, y: 0, width: 200, height: 100, opacity: 0.5 },
          filePath: "C:\\temp\\gen.png", pixelWidth: 400, pixelHeight: 200 },
        { id: "T", name: "Title", type: "text", frame: { x: 10, y: 20, width: 120, height: 30 },
          characters: "Hi", fontFamily: "Arial", fontStyle: "Regular", fontSize: 24, color: rgba(0, 0, 0) }
    ])]), { hierarchy: "groups", layout: "combine" }));
    var g = aiDoc.pageItems[0];
    ok("groups + combine: the group is built all the same",
       aiDoc.pageItems.length === 1 && g.typename === "GroupItem" && g.name === "Card", stack(aiDoc));
    ok("groups: text built inside the group, on top",
       g.pageItems[0].typename === "TextFrame" && g.pageItems[0].name === "Title", stack(g));
    ok("groups: generated image embedded in its slot inside the group",
       MOCK.embedded.length === 1 && g.pageItems[1].typename === "RasterItem" &&
       g.pageItems[1].name === "Gen" && g.pageItems[1].opacity === 50, stack(g));
    ok("groups + combine: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

// 19) Clipping groups form inside the IR parent's GroupItem.
(function () {
    resetMock();
    var aiDoc = openDoc();
    var res = build({ version: "1.0", source: "illustrator", name: "t", originSpace: "document",
                      bounds: { x: 5, y: 7, width: 200, height: 100 }, options: { hierarchy: "groups" },
                      layers: [grp("G", [clipped("A", "m1"), clipped("B", "m1"), leaf("C")], 0.5)] });
    var g = aiDoc.pageItems[0];
    ok("clip in group: the document holds only G", stack(aiDoc) === "G" && aiDoc.groupItems.length === 1, stack(aiDoc));
    ok("clip in group: G holds C above one clipping group", stack(g) === "C,Mask" && g.groupItems.length === 1, stack(g));
    var cg = g.pageItems[1];
    ok("clip in group: the clipping group sits in G and is clipped", cg.parent === g && cg.clipped === true);
    ok("clip in group: outline on top, then B, then A", stack(cg) === "<clip>,B,A", stack(cg));
    // Frame space (10,20)..(110,70), shifted by the document origin (5,7) inside
    // the group too, then flipped against the artboard top at y = 600.
    ok("clip in group: outline shifted by the origin and y-flipped",
       sameAnchors(anchors(cg.pageItems[0]), [[15, 573], [115, 573], [115, 523], [15, 523]]),
       anchors(cg.pageItems[0]).join(" "));
    ok("clip in group: three layers created", res.layersCreated === 3, String(res.layersCreated));
    ok("clip in group: no diagnostics", LazyLord.diagnostics.length === 0, diags());

    // Interleaved inside a group: judged, and reported, within that group.
    resetMock();
    aiDoc = openDoc();
    build(withOptions(canvasDoc([leaf("Z"), grp("G", [clipped("A", "m1"), leaf("B"), clipped("C", "m1")])]),
                      { hierarchy: "groups" }));
    g = aiDoc.pageItems[0];
    ok("interleaved in group: B stays above the clipping group, inside G", stack(g) === "B,Mask", stack(g));
    ok("interleaved in group: the clipping group holds C over A", stack(g.pageItems[1]) === "<clip>,C,A", stack(g.pageItems[1]));
    var d = findDiag("sits below");
    ok("interleaved in group: C's move is reported", countDiag("sits below") === 1 && d && d.object === "C", diags());

    // A GroupItem built between two layers of a mask counts as art in between...
    resetMock();
    aiDoc = openDoc();
    build(withOptions(canvasDoc([clipped("A", "m1"), grp("G", [leaf("B")]), clipped("C", "m1")]), { hierarchy: "groups" }));
    ok("group in between: it stays above the clipping group", stack(aiDoc) === "G,Mask", stack(aiDoc));
    d = findDiag("sits below");
    ok("group in between: C's move is reported", countDiag("sits below") === 1 && d && d.object === "C", diags());

    // ... but not when everything in it failed and it was removed.
    resetMock();
    aiDoc = openDoc();
    build(withOptions(canvasDoc([clipped("A", "m1"), grp("G", [leaf("Bad", { subpaths: [] })]), clipped("C", "m1")]),
                      { hierarchy: "groups" }));
    ok("removed group in between: only the clipping group remains", stack(aiDoc) === "Mask", stack(aiDoc));
    ok("removed group in between: no reordering warning", countDiag("sits below") === 0, diags());
})();

// 20) The same clip id under different IR parents: one clipping group per
//     parent, each with its own copy of the outline.
(function () {
    function doc() {
        return canvasDoc([grp("G1", [clipped("A", "m1")]), grp("G2", [clipped("B", "m1")]), clipped("X", "m1")]);
    }
    resetMock();
    var aiDoc = openDoc();
    var res = build(withOptions(doc(), { hierarchy: "groups" }));
    ok("clip across parents: X's clipping group above G2 and G1", stack(aiDoc) === "Mask,G2,G1", stack(aiDoc));
    var cx = aiDoc.pageItems[0], g2 = aiDoc.pageItems[1], g1 = aiDoc.pageItems[2];
    var c1 = g1.pageItems[0], c2 = g2.pageItems[0];
    ok("clip across parents: a clipping group inside each parent",
       stack(g1) === "Mask" && stack(g2) === "Mask" && c1.typename === "GroupItem" && c2.typename === "GroupItem" &&
       c1.parent === g1 && c2.parent === g2, stack(g1) + " / " + stack(g2));
    ok("clip across parents: all three are clipped", c1.clipped === true && c2.clipped === true && cx.clipped === true);
    ok("clip across parents: each holds its own layer under its own outline",
       stack(c1) === "<clip>,A" && stack(c2) === "<clip>,B" && stack(cx) === "<clip>,X",
       stack(c1) + " / " + stack(c2) + " / " + stack(cx));
    var m1 = c1.pageItems[0], m2 = c2.pageItems[0], m3 = cx.pageItems[0];
    ok("clip across parents: the outline is duplicated, not shared", m1 !== m2 && m2 !== m3 && m1 !== m3);
    ok("clip across parents: every copy has the same outline",
       sameAnchors(anchors(m1), CLIP_FLIPPED) && sameAnchors(anchors(m2), CLIP_FLIPPED) && sameAnchors(anchors(m3), CLIP_FLIPPED),
       anchors(m1).join(" "));
    ok("clip across parents: three layers created", res.layersCreated === 3, String(res.layersCreated));
    ok("clip across parents: nothing reported as moved", LazyLord.diagnostics.length === 0, diags());

    // Flattened, the same layers are consecutive leaves: ONE clipping group.
    resetMock();
    aiDoc = openDoc();
    build(doc());
    ok("clip across parents, flattened: one clipping group holds X, B, A",
       aiDoc.groupItems.length === 1 && stack(aiDoc) === "Mask" && stack(aiDoc.pageItems[0]) === "<clip>,X,B,A",
       stack(aiDoc) + " / " + (aiDoc.pageItems[0] ? stack(aiDoc.pageItems[0]) : ""));
    ok("clip across parents, flattened: no diagnostics", LazyLord.diagnostics.length === 0, diags());
})();

// 21) A group with a clip of its own.
(function () {
    resetMock();
    var aiDoc = openDoc();
    build(withOptions(canvasDoc([grp("G", [leaf("A"), leaf("B")], undefined, { clip: clipOf("m1", "Mask", CLIP_SHAPE) })]),
                      { hierarchy: "groups" }));
    var cg = aiDoc.pageItems[0];
    ok("group clip: its GroupItem is built inside a clipping group",
       stack(aiDoc) === "Mask" && cg.clipped === true && stack(cg) === "<clip>,G", stack(aiDoc) + " / " + stack(cg));
    ok("group clip: its layers inside it, with no clipping groups of their own",
       stack(cg.pageItems[1]) === "B,A" && cg.pageItems[1].groupItems.length === 0, stack(cg.pageItems[1]));
    ok("group clip: no diagnostics", LazyLord.diagnostics.length === 0, diags());

    // Flattened, the clip is handed down; a layer with its own mask keeps that
    // one (the innermost) and losing the group's is reported.
    resetMock();
    aiDoc = openDoc();
    var inner = leaf("B");
    inner.clip = clipOf("m2", "Inner", CLIP_SHAPE);
    var a = leaf("A");
    var g = grp("G", [a, leaf("C"), inner], undefined, { clip: clipOf("m1", "Mask", CLIP_SHAPE) });
    build(canvasDoc([g]));
    ok("group clip, flattened: A and C share the group's clipping group, B has its own",
       stack(aiDoc) === "Inner,Mask" && stack(aiDoc.pageItems[1]) === "<clip>,C,A" && stack(aiDoc.pageItems[0]) === "<clip>,B",
       stack(aiDoc));
    ok("group clip, flattened: each layer got its own copy", a.clip && a.clip !== g.clip && a.clip.id === "m1");
    var d = findDiag("Clipped by both");
    ok("group clip, flattened: the lost outer mask is reported for B",
       LazyLord.diagnostics.length === 1 && d && d.object === "B" && d.resolution === "approximated", diags());
})();

// 22) Empty groups and groups whose every layer failed.
(function () {
    resetMock();
    var aiDoc = openDoc();
    var res = build(withOptions(canvasDoc([grp("Empty", []), grp("Broken", [leaf("Bad", { subpaths: [] })], 0.5), leaf("A")]),
                                { hierarchy: "groups" }));
    ok("groups: only A remains (no empty GroupItem left behind)", stack(aiDoc) === "A" && aiDoc.groupItems.length === 0, stack(aiDoc));
    var d = findDiag("group is empty");
    ok("groups: the empty group is reported as skipped", d && d.object === "Empty" && d.resolution === "skipped", diags());
    ok("groups: the failed layer is reported", !!findDiag("no contours"), diags());
    ok("groups: nothing else is reported", LazyLord.diagnostics.length === 2, diags());
    ok("groups: one layer created", res.layersCreated === 1, String(res.layersCreated));

    resetMock();
    aiDoc = openDoc();
    build(canvasDoc([grp("Empty", []), leaf("A")]));
    d = findDiag("group is empty");
    ok("flatten: the empty group is reported as skipped too",
       LazyLord.diagnostics.length === 1 && d && d.object === "Empty" && d.resolution === "skipped", diags());
})();

// 23) A GroupItem that cannot be created: its layers go into the parent, with
//     its opacity (and clip) handed down, reported as approximated.
(function () {
    resetMock();
    MOCK.groupAddFailAt = 2; // 1 = G1, 2 = G2
    var aiDoc = openDoc();
    var res = build(withOptions(canvasDoc([grp("G1", [leaf("A"), grp("G2", [leaf("B"), faded("C", 0.5)], 0.5)], 0.8)]),
                                { hierarchy: "groups" }));
    var g1 = aiDoc.pageItems[0];
    ok("no group: G2's layers built into G1 in its place", stack(g1) === "C,B,A" && g1.groupItems.length === 0, stack(g1));
    ok("no group: G2's opacity folded into them (50%, 50% x 50% = 25%)",
       g1.pageItems[1].opacity === 50 && g1.pageItems[0].opacity === 25,
       g1.pageItems[1].opacity + " / " + g1.pageItems[0].opacity);
    ok("no group: G1's own opacity is still native (80%)", g1.opacity === 80, String(g1.opacity));
    var d = findDiag("could not be created");
    ok("no group: reported once, as approximated, against G2",
       LazyLord.diagnostics.length === 1 && d && d.object === "G2" && d.resolution === "approximated", diags());
    ok("no group: three layers created", res.layersCreated === 3, String(res.layersCreated));

    // With a clip of its own, its layers stay clipped together, inside G1.
    resetMock();
    MOCK.groupAddFailAt = 3; // 1 = G1, 2 = G2's clipping group, 3 = G2
    aiDoc = openDoc();
    build(withOptions(canvasDoc([grp("G1", [leaf("A"),
                                            grp("G2", [leaf("B"), leaf("C")], undefined, { clip: clipOf("m1", "Mask", CLIP_SHAPE) })])]),
                      { hierarchy: "groups" }));
    g1 = aiDoc.pageItems[0];
    ok("no group, clipped: its layers share the clipping group inside G1",
       stack(g1) === "Mask,A" && stack(g1.pageItems[0]) === "<clip>,C,B" && g1.pageItems[0].clipped === true,
       stack(g1) + " / " + (g1.pageItems[0] ? stack(g1.pageItems[0]) : ""));
    ok("no group, clipped: only the missing group is reported",
       LazyLord.diagnostics.length === 1 && !!findDiag("could not be created"), diags());
})();

// 24) A sub-group between two layers of a mask, every layer inside it clipped
//     by that mask too (an Illustrator clip group or a Figma clipping frame
//     holding a group): it joins the clipping group in its place, so the layer
//     above it keeps its place instead of being pulled down below it.
(function () {
    resetMock();
    var aiDoc = openDoc();
    var res = build(withOptions(canvasDoc([grp("Card", [
        clipped("A", "m1"), grp("Icons", [clipped("B", "m1"), clipped("C", "m1")], 0.5), clipped("D", "m1")
    ])]), { hierarchy: "groups" }));
    var card = aiDoc.pageItems[0];
    ok("join: Card holds one clipping group", stack(card) === "Mask" && card.groupItems.length === 1, stack(card));
    var cg = card.pageItems[0];
    ok("join: D, Icons, A in the clipping group, in IR order under the outline",
       cg.clipped === true && stack(cg) === "<clip>,D,Icons,A", stack(cg));
    var icons = cg.pageItems[2] || {};
    var inner = (icons.pageItems && icons.pageItems[0]) || {};
    ok("join: Icons is still a named GroupItem with its own opacity",
       icons.typename === "GroupItem" && icons.parent === cg && icons.name === "Icons" && icons.opacity === 50,
       icons.typename + " " + icons.name + " / " + icons.opacity);
    ok("join: Icons' layers still get their own clipping group inside it (per parent)",
       stack(icons) === "Mask" && inner.clipped === true && stack(inner) === "<clip>,C,B",
       stack(icons) + " / " + stack(inner));
    ok("join: each clipping group has its own copy of the outline",
       !!inner.pageItems && cg.pageItems[0] !== inner.pageItems[0] &&
       sameAnchors(anchors(cg.pageItems[0]), CLIP_FLIPPED) && sameAnchors(anchors(inner.pageItems[0]), CLIP_FLIPPED));
    ok("join: nothing reported as moved", LazyLord.diagnostics.length === 0, diags());
    ok("join: four layers created", res.layersCreated === 4, String(res.layersCreated));

    // Two groups in a row, one nested deeper: both join, still in order.
    resetMock();
    aiDoc = openDoc();
    build(withOptions(canvasDoc([clipped("A", "m1"), grp("G1", [clipped("B", "m1")]),
                                 grp("G2", [grp("G3", [clipped("C", "m1")])]), clipped("D", "m1")]),
                      { hierarchy: "groups" }));
    ok("join: two groups in a row both join, in order",
       stack(aiDoc) === "Mask" && stack(aiDoc.pageItems[0]) === "<clip>,D,G2,G1,A", stack(aiDoc) + " / " +
       (aiDoc.pageItems[0] ? stack(aiDoc.pageItems[0]) : ""));
    var g2 = aiDoc.pageItems[0] && aiDoc.pageItems[0].pageItems[2]; // <clip>, D, G2, G1, A
    ok("join: the deeper leaf is clipped inside its own parent G3",
       !!g2 && stack(g2) === "G3" && stack(g2.pageItems[0]) === "Mask" &&
       stack(g2.pageItems[0].pageItems[0]) === "<clip>,C", g2 ? stack(g2) : "");
    ok("join: two in a row, nothing reported", LazyLord.diagnostics.length === 0, diags());

    // Flattened, the same layers are consecutive leaves of one clipping group.
    resetMock();
    aiDoc = openDoc();
    build(canvasDoc([clipped("A", "m1"), grp("G", [clipped("B", "m1")]), clipped("D", "m1")]));
    ok("join, flattened: one clipping group holds D, B, A",
       stack(aiDoc) === "Mask" && stack(aiDoc.pageItems[0]) === "<clip>,D,B,A" && aiDoc.groupItems.length === 1,
       stack(aiDoc) + " / " + (aiDoc.pageItems[0] ? stack(aiDoc.pageItems[0]) : ""));
})();

// 25) When the group does NOT join its siblings' clipping group.
(function () {
    function run(layers) {
        resetMock();
        var aiDoc = openDoc();
        build(withOptions(canvasDoc(layers), { hierarchy: "groups" }));
        return aiDoc;
    }

    // Nothing of that mask above it: it already sits in order, unwrapped.
    var aiDoc = run([clipped("A", "m1"), grp("G", [clipped("B", "m1")])]);
    ok("no join, nothing above: G sits above the clipping group", stack(aiDoc) === "G,Mask", stack(aiDoc));
    ok("no join, nothing above: the clipping group holds only A", stack(aiDoc.pageItems[1]) === "<clip>,A", stack(aiDoc.pageItems[1]));
    ok("no join, nothing above: nothing reported", LazyLord.diagnostics.length === 0, diags());

    // Later siblings, but none clipped by that mask: still no need to join.
    aiDoc = run([clipped("A", "m1"), grp("G", [clipped("B", "m1")]), leaf("Z"), clipped("Y", "m2")]);
    ok("no join, later siblings of other masks: G sits above the clipping group, unwrapped",
       stack(aiDoc) === "Mask,Z,G,Mask" && stack(aiDoc.pageItems[3]) === "<clip>,A", stack(aiDoc));
    ok("no join, later siblings of other masks: nothing reported", LazyLord.diagnostics.length === 0, diags());

    // The group comes first: the clipping group forms above it, in order.
    aiDoc = run([grp("G", [clipped("B", "m1")]), clipped("C", "m1")]);
    ok("no join, group first: the clipping group forms above G", stack(aiDoc) === "Mask,G", stack(aiDoc));
    ok("no join, group first: nothing reported", LazyLord.diagnostics.length === 0, diags());

    // Something already built above the clipping group: joining would move the
    // group too, so it stays put and only C's move is reported (as before).
    aiDoc = run([clipped("A", "m1"), leaf("X"), grp("G", [clipped("B", "m1")]), clipped("C", "m1")]);
    ok("no join, art in between: G and X stay above the clipping group", stack(aiDoc) === "G,X,Mask", stack(aiDoc));
    ok("no join, art in between: C is pulled down into it", stack(aiDoc.pageItems[2]) === "<clip>,C,A", stack(aiDoc.pageItems[2]));
    var d = findDiag("sits below");
    ok("no join, art in between: only C's move is reported",
       countDiag("sits below") === 1 && d && d.object === "C" && LazyLord.diagnostics.length === 1, diags());

    // A layer in the group that the mask does not clip: it must not be clipped.
    aiDoc = run([clipped("A", "m1"), grp("G", [clipped("B", "m1"), leaf("E")]), clipped("C", "m1")]);
    ok("no join, unclipped layer inside: G stays outside the clipping group", stack(aiDoc) === "G,Mask", stack(aiDoc));
    ok("no join, unclipped layer inside: E is not clipped", stack(aiDoc.pageItems[0]) === "E,Mask", stack(aiDoc.pageItems[0]));
    d = findDiag("sits below");
    ok("no join, unclipped layer inside: C's move is reported", countDiag("sits below") === 1 && d && d.object === "C", diags());

    // The group's layers are clipped by another mask.
    aiDoc = run([clipped("A", "m1"), grp("G", [clipped("B", "m2")]), clipped("C", "m1")]);
    ok("no join, other mask inside: G stays outside", stack(aiDoc) === "G,Mask" && stack(aiDoc.pageItems[1]) === "<clip>,C,A",
       stack(aiDoc));
    ok("no join, other mask inside: C's move is reported", countDiag("sits below") === 1, diags());

    // A group inside carrying a different clip of its own.
    var h = grp("H", [clipped("B", "m1")], undefined, { clip: clipOf("m2", "Other", CLIP_SHAPE) });
    aiDoc = run([clipped("A", "m1"), grp("G", [h]), clipped("C", "m1")]);
    ok("no join, other mask on a group inside: G stays outside", stack(aiDoc) === "G,Mask", stack(aiDoc));

    // A group with a clip of its own is built into ITS mask's clipping group, never joined.
    aiDoc = run([clipped("A", "m1"), grp("G", [clipped("B", "m1")], undefined, { clip: clipOf("m2", "Own", CLIP_SHAPE) }),
                 clipped("C", "m1")]);
    ok("no join, own clip: G goes into its own clipping group", stack(aiDoc) === "Own,Mask" &&
       stack(aiDoc.pageItems[0]) === "<clip>,G", stack(aiDoc) + " / " + (aiDoc.pageItems[0] ? stack(aiDoc.pageItems[0]) : ""));
})();

WScript.Echo("");
WScript.Echo(passed + " passed, " + failed + " failed.");
WScript.Quit(failed === 0 ? 0 : 1);
