/*
 * LazyLord — Illustrator builder.
 * Recreates LazyLord IR as native PathItems, TextFrames and placed images on the
 * active (or a new) document. Handles the IR (y-down) -> Illustrator (y-up)
 * flip against the active artboard.
 *
 * Every builder draws into ctx.container: the document itself, the GroupItem
 * of an IR group (hierarchy "groups"), or the group of the clipping mask the
 * layer belongs to inside either (see "Groups" and "Clipping groups" below).
 *
 * Transfer options: hierarchy "flatten" (the default) builds the leaves only,
 * "groups" rebuilds every IR group as a GroupItem. layout "combine" has no
 * Illustrator meaning beyond grouping (every shape is its own path either way),
 * so it is ignored: nothing is lost and nothing is reported.
 */

LazyLord.build = function (doc) {
  LazyLord.applyOrigin(doc);
  var opts = LazyLord.options(doc);
  var aiDoc = LazyLord._ai_doc(doc);
  var ab = aiDoc.artboards[aiDoc.artboards.getActiveArtboardIndex()];
  var rect = ab.artboardRect; // [left, top, right, bottom]
  var update = LazyLord.wantsUpdate(doc);

  // Updating drops artwork back where the old artwork stood, so it cannot also
  // restructure the document: a replaced item keeps the group it was in.
  if (update && opts.hierarchy !== "flatten") {
    LazyLord.warn("Transfer", "Update puts artwork back where the old artwork stood, so Groups was ignored; " +
      "send with Add to rebuild the group structure", "approximated");
    opts.hierarchy = "flatten";
  }

  var ctx = {
    doc: aiDoc,
    ir: doc,         // the IR document, for layer tags
    container: aiDoc,
    left: rect[0],
    top: rect[1],
    created: 0,      // leaf layers built (groups themselves are not counted)
    update: update,
    updated: 0,
    index: update ? LazyLord._ai_index(aiDoc) : null
  };

  var root = LazyLord._ai_scope(aiDoc);
  // Precomps are an After Effects idea: here they are plain groups.
  var layers = (opts.hierarchy !== "flatten") ? doc.layers : LazyLord._ai_flatten(doc);
  LazyLord._ai_buildList(ctx, root, layers);
  ctx.container = aiDoc;
  LazyLord._ai_closeClips(ctx, root);
  LazyLord._ai_extras(ctx, doc, rect);
  try { app.redraw(); } catch (eR) {}

  var message = "";
  if (update) {
    message = ctx.updated
      ? "Replaced " + ctx.updated + " item" + (ctx.updated === 1 ? "" : "s") + " where they already stood."
      : "Nothing matched artwork from an earlier transfer, so everything was added.";
  }
  return { ok: true, layersCreated: ctx.created, layersUpdated: ctx.updated, message: message };
};

/**
 * Guides and swatches, when the sender asked for them: ruler guides are paths
 * marked as guides, spanning well past the artboard; named colours become
 * swatches, skipping any name the document already has.
 */
LazyLord._ai_extras = function (ctx, doc, rect) {
  var guides = LazyLord.wantedGuides(doc);
  var w = rect[2] - rect[0], h = rect[1] - rect[3];
  var lost = 0;
  for (var i = 0; i < guides.length; i++) {
    try {
      var g = guides[i];
      var p = ctx.doc.pathItems.add();
      if (g.orientation === "horizontal") p.setEntirePath([LazyLord._ai_pt(ctx, -2 * w, g.position), LazyLord._ai_pt(ctx, 3 * w, g.position)]);
      else p.setEntirePath([LazyLord._ai_pt(ctx, g.position, -2 * h), LazyLord._ai_pt(ctx, g.position, 3 * h)]);
      p.guides = true;
    } catch (e) { lost++; }
  }
  if (lost) LazyLord.warn("Guides", lost + " of " + guides.length + " guides could not be added", "skipped");

  var sw = LazyLord.wantedSwatches(doc);
  var failed = 0;
  for (var k = 0; k < sw.length; k++) {
    var exists = false;
    try { ctx.doc.swatches.getByName(sw[k].name); exists = true; } catch (eN) {}
    if (exists) continue;
    try {
      var s = ctx.doc.swatches.add();
      s.name = sw[k].name;
      s.color = LazyLord._ai_rgb(sw[k].color || {});
    } catch (eS) { failed++; }
  }
  if (failed) LazyLord.warn("Swatches", failed + " of " + sw.length + " swatches could not be added", "skipped");
};

/**
 * One container being filled: the document or the GroupItem of an IR group.
 * Clipping groups are per container, so the same clip id under two IR parents
 * makes two clipping groups.
 */
LazyLord._ai_scope = function (item) {
  return {
    item: item,
    clips: {},       // "#" + clip id -> { clip, group, members, topBuilt }
    clipOrder: [],   // the same entries, in the order their groups were created
    topBuilt: 0      // items built straight into `item` (no clipping group)
  };
};

/** Build `layers` (bottom-to-top) into `scope`. */
LazyLord._ai_buildList = function (ctx, scope, layers) {
  for (var i = 0; i < layers.length; i++) LazyLord._ai_buildOne(ctx, scope, layers, i);
};

/**
 * Build layers[i] (a layer or a group) into `scope`, inside its clipping group
 * if it has one, or inside its siblings' clipping group when it has to join it
 * to keep its place (see _ai_joinEntry).
 */
LazyLord._ai_buildOne = function (ctx, scope, layers, i) {
  var layer = layers[i];
  try {
    // Artwork an earlier transfer made is replaced where it stands, outside the
    // clipping-group bookkeeping: it is not entering the stack, it is already in it.
    if (ctx.update && layer.type !== "group" && LazyLord._ai_update(ctx, layer)) return;

    var entry = layer.clip ? LazyLord._ai_clipEntry(ctx, scope, layer) : LazyLord._ai_joinEntry(scope, layers, i);
    ctx.container = entry ? entry.group : scope.item;
    var isGroup = (layer.type === "group");
    var before = 0;
    if (!isGroup) {
      try { before = ctx.container.pageItems.length; } catch (eB) { before = -1; }
    }
    var built = isGroup ? LazyLord._ai_group(ctx, scope, layer) : LazyLord._ai_layer(ctx, layer);
    if (built) {
      if (!isGroup) {
        ctx.created++;
        if (before >= 0) LazyLord._ai_tagNew(ctx, ctx.container, before, layer);
      }
      if (entry) entry.members++;
      else scope.topBuilt++;
    }
  } catch (e) {
    LazyLord.warn(layer.name, e.message, "skipped");
  }
};

/** Build one layer into ctx.container. False when the type is not rebuilt here. */
LazyLord._ai_layer = function (ctx, layer) {
  if (layer.type === "vector") { LazyLord._ai_vector(ctx, layer); return true; }
  if (layer.type === "text") { LazyLord._ai_text(ctx, layer); return true; }
  if (layer.type === "image") { LazyLord._ai_image(ctx, layer); return true; }
  LazyLord.warn(layer.name, "Layers of type \"" + layer.type + "\" are not rebuilt in Illustrator", "skipped");
  return false;
};

/*
 * Transactions (see LazyLord.run): the documents open and the uuid of every
 * item in the active one, before a build. A failed build closes a document it
 * opened, unsaved, and removes the items whose uuids are new. Without uuids
 * (older Illustrator) nothing in an existing document is touched.
 */
LazyLord.snapshot = function () {
  var s = { docs: app.documents.length, doc: null, items: null };
  if (!app.documents.length) return s;
  s.doc = app.activeDocument;
  s.items = {};
  var all = s.doc.pageItems;
  for (var i = 0; i < all.length; i++) {
    var u = null;
    try { u = all[i].uuid; } catch (e) {}
    if (!u) { s.items = null; break; }
    s.items[u] = true;
  }
  return s;
};

LazyLord.rollback = function (s) {
  if (app.documents.length > s.docs) {
    // The build opened a document of its own: it is the active one.
    app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);
    if (!s.doc) return true;
  }
  if (!s.doc) return true;
  if (!s.items) return false;
  var all = s.doc.pageItems;
  var doomed = [];
  for (var i = 0; i < all.length; i++) {
    var u = null;
    try { u = all[i].uuid; } catch (e) {}
    if (u && !s.items[u]) doomed.push(all[i]);
  }
  // Outermost first: removing a new group removes what it holds, whose later
  // remove() then fails harmlessly.
  for (var k = 0; k < doomed.length; k++) {
    try { doomed[k].remove(); } catch (eGone) {}
  }
  return true;
};

LazyLord._ai_doc = function (doc) {
  if (app.documents.length > 0 && !LazyLord.wantsNewDocument(doc)) return app.activeDocument;
  // New or nothing open: match the source page (artboard / comp / Figma frame) so
  // document-space artwork lands inside it; canvas sources get the selection size.
  var size = LazyLord.canvasSize(doc, 1000, 1000);
  return app.documents.add(DocumentColorSpace.RGB, size.width, size.height);
};

/** Convert an absolute IR point (y-down) to Illustrator doc coords (y-up). */
LazyLord._ai_pt = function (ctx, fx, fy) {
  return [ctx.left + fx, ctx.top - fy];
};

LazyLord._ai_rgb = function (c) {
  var col = new RGBColor();
  col.red = Math.round((c.r || 0) * 255);
  col.green = Math.round((c.g || 0) * 255);
  col.blue = Math.round((c.b || 0) * 255);
  return col;
};

LazyLord._ai_clamp = function (v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
};

LazyLord._ai_findFont = function (family, style) {
  try {
    for (var i = 0; i < app.textFonts.length; i++) {
      var f = app.textFonts[i];
      if (f.family === family && (!style || f.style === style)) return f;
    }
    for (var j = 0; j < app.textFonts.length; j++) {
      if (app.textFonts[j].family === family) return app.textFonts[j];
    }
  } catch (e) {}
  return null;
};

/* -------------------------------------------------------------------------
 * Paths
 * ---------------------------------------------------------------------- */

/**
 * Draw one IR subpath into an empty PathItem. ox/oy is the offset from the
 * subpath's space to frame space: the layer's frame.x/y for layer geometry,
 * 0/0 for clip contours, which are already in frame space.
 */
LazyLord._ai_drawPath = function (ctx, path, sp, ox, oy) {
  var pts = [];
  for (var i = 0; i < sp.vertices.length; i++) {
    var cp = LazyLord.controlPoints(sp, i);
    // Convert each point and its handles before anything is subtracted, so the
    // handles flip with the anchor.
    pts.push({
      a: LazyLord._ai_pt(ctx, ox + cp.anchor[0], oy + cp.anchor[1]),
      l: LazyLord._ai_pt(ctx, ox + cp.inAbs[0], oy + cp.inAbs[1]),
      r: LazyLord._ai_pt(ctx, ox + cp.outAbs[0], oy + cp.outAbs[1])
    });
  }
  for (var k = 0; k < pts.length; k++) {
    var pp = path.pathPoints.add();
    pp.anchor = pts[k].a;
    pp.leftDirection = pts[k].l;
    pp.rightDirection = pts[k].r;
    pp.pointType = PointType.CORNER;
  }
  path.closed = !!sp.closed;
};

/** Apply an IR winding rule to a set of paths (the members of one shape). */
LazyLord._ai_winding = function (paths, rule, label) {
  if (!rule) return;
  var even = (rule === "evenodd");
  try {
    for (var i = 0; i < paths.length; i++) paths[i].evenodd = even;
  } catch (e) {
    if (even) {
      LazyLord.warn(label, "The even-odd fill rule could not be set, so overlapping contours may fill differently", "approximated");
    }
  }
};

/** Flat colour for a stroke paint: the solid colour or the first gradient stop. */
LazyLord._ai_strokeFlat = function (paint) {
  if (paint.type === "solid") return paint.color;
  if (paint.stops && paint.stops.length) return paint.stops[0].color;
  return { r: 0, g: 0, b: 0, a: 1 };
};

LazyLord._ai_vector = function (ctx, layer) {
  if (!layer.subpaths || !layer.subpaths.length) throw new Error("The shape has no contours to draw");
  var ox = layer.frame.x, oy = layer.frame.y;
  var name = layer.name || "Path";
  var paint = LazyLord.fillPaint(layer);
  var hasFill = !!paint;
  var fillC = LazyLord.fillColor(layer);
  var stroke = LazyLord.firstStroke(layer);
  var hasStroke = !!(stroke && stroke.paint);

  var multi = layer.subpaths.length > 1;
  var compound = multi ? ctx.container.compoundPathItems.add() : null;
  var paths = [];

  LazyLord.eachSubPath(layer, function (sp) {
    var path = compound ? compound.pathItems.add() : ctx.container.pathItems.add();
    path.name = name;
    LazyLord._ai_drawPath(ctx, path, sp, ox, oy);

    // Flat paint first, on the individual path (compound paths paint from their
    // members). A gradient below replaces it; if that fails, this is the fallback.
    path.filled = hasFill;
    if (hasFill) path.fillColor = LazyLord._ai_rgb(fillC);
    if (hasStroke) {
      path.stroked = true;
      path.strokeColor = LazyLord._ai_rgb(LazyLord._ai_strokeFlat(stroke.paint));
      path.strokeWidth = stroke.weight || 1;
    } else {
      path.stroked = false;
    }
    paths.push(path);
  });

  var item = compound || paths[0];
  if (compound) { try { compound.name = name; } catch (eN) {} }
  LazyLord._ai_winding(paths, layer.windingRule, name);

  var gradFill = hasFill && LazyLord.isGradient(paint);
  // True only when a native fill gradient really exists; a failed one fell back
  // to the flat colour.
  var fillNative = gradFill && LazyLord._ai_gradientPaint(ctx, item, paths, layer, paint, "fill", true);
  if (gradFill && !fillNative) {
    LazyLord.noteGradient(layer);
  } else if (hasFill && !gradFill && paint.type !== "solid") {
    LazyLord.noteGradient(layer); // a gradient without stops can only be flat
  }

  if (hasStroke && stroke.paint.type !== "solid") {
    // transform() has one switch for gradients, so a stroke gradient can only be
    // placed when there is no native fill gradient for the same transform to disturb.
    var nativeStroke = LazyLord.isGradient(stroke.paint) &&
      LazyLord._ai_gradientPaint(ctx, item, paths, layer, stroke.paint, "stroke", !fillNative);
    if (!nativeStroke) {
      LazyLord.warn(name, "Gradient stroke rebuilt as flat colour from its first stop", "approximated");
    }
  }

  // Opacity goes on the whole shape: the compound path, or the single path.
  if (layer.frame.opacity !== undefined) item.opacity = LazyLord.pct(layer.frame.opacity);
  return item;
};

/* -------------------------------------------------------------------------
 * Gradients
 *
 * Illustrator ignores origin/angle/length written to a GradientColor (a
 * long-standing scripting bug), so a native gradient is placed in two steps:
 * assign it and let Illustrator pick its default vector, then read that vector
 * back and move it with a gradient-only transform (changePositions false,
 * changeFillGradients true) onto the IR's handles.
 *
 * Reading the vector: a transform does not rewrite a GradientColor's origin,
 * angle and length — Illustrator concatenates it into GradientColor.matrix and
 * those three keep reading their old values. What is on screen is the origin
 * and the end point (origin + length along angle) mapped through that matrix,
 * so that EFFECTIVE vector is what every check below uses. The raw fields alone
 * would read as the untouched default after a correct transform, and a second
 * transform built from them would move the gradient twice.
 *
 * Each transform is read back. A second one runs only to fix a pure translation
 * (see _ai_moveGradient); it is never built from a read-back that did not
 * change, or that turned or scaled differently than the matrix should have.
 * In those cases, and when the vector ends more than 1pt out, the gradient is
 * kept (its colours are right) and the direction is reported as approximated.
 *
 * Compound paths: a CompoundPathItem has no paint of its own, so the gradient is
 * assigned to every member path (none is left flat, however a version stores
 * member styles). The vector is moved by ONE transform of the compound item as a
 * whole, because Illustrator paints a compound path with a single style that
 * spans all its contours — which is what the IR means by a gradient across the
 * layer box. Transforming each member instead would apply the matrix to that
 * shared style once per member. Every member is read back afterwards, and any
 * that did not follow gets its own correction; as that correction could move a
 * style other members share, every member is read back once more at the end.
 * ---------------------------------------------------------------------- */

/** IR stops sorted by position (stable insertion sort; ES3 has no reliable sort). */
LazyLord._ai_sortedStops = function (stops) {
  var out = [];
  for (var i = 0; i < stops.length; i++) out.push(stops[i]);
  for (var j = 1; j < out.length; j++) {
    var s = out[j], k = j - 1;
    while (k >= 0 && out[k].position > s.position) { out[k + 1] = out[k]; k--; }
    out[k + 1] = s;
  }
  // One stop is a flat gradient: Illustrator needs two.
  if (out.length === 1) {
    out = [{ position: 0, color: out[0].color }, { position: 1, color: out[0].color }];
  }
  return out;
};

/** A native gradient swatch carrying an IR gradient's type and stops. */
LazyLord._ai_makeGradient = function (aiDoc, paint, label) {
  var stops = LazyLord._ai_sortedStops(paint.stops);
  var grad = aiDoc.gradients.add();
  grad.type = (paint.type === "radial-gradient") ? GradientType.RADIAL : GradientType.LINEAR;

  // A new gradient already has two stops: reuse them and add the rest.
  var gs = grad.gradientStops;
  while (gs.length < stops.length) gs.add();
  while (stops.length < gs.length) stops.push(stops[stops.length - 1]);

  var alphaLost = false;
  for (var i = 0; i < stops.length; i++) {
    var s = gs[i];
    var c = stops[i].color || { r: 0, g: 0, b: 0, a: 1 };
    var alpha = (c.a === undefined || c.a === null) ? 1 : c.a;
    s.rampPoint = LazyLord._ai_clamp(stops[i].position * 100, 0, 100);
    s.midPoint = 50;
    s.color = LazyLord._ai_rgb(c);
    try { s.opacity = LazyLord._ai_clamp(alpha * 100, 0, 100); } catch (eO) { if (alpha < 1) alphaLost = true; }
  }
  if (alphaLost) {
    LazyLord.warn(label, "Gradient stop transparency is not supported by this version of Illustrator; the stops are opaque", "approximated");
  }

  // Stops are written in ascending order; check Illustrator kept them there.
  for (var r = 0; r < stops.length; r++) {
    if (Math.abs(gs[r].rampPoint - LazyLord._ai_clamp(stops[r].position * 100, 0, 100)) > 0.5) {
      LazyLord.warn(label, "Some gradient stops could not be placed at their exact positions", "approximated");
      break;
    }
  }
  return grad;
};

LazyLord._ai_gradColor = function (grad) {
  var gc = new GradientColor();
  gc.gradient = grad;
  return gc;
};

/**
 * Paint `paths` (the members of `item`) with a native gradient as their fill or
 * stroke (`which`). When `place` is false the vector keeps Illustrator's default
 * and that is reported. Returns false only when no native gradient could be
 * created; the paths then keep the flat colour they were given first.
 */
LazyLord._ai_gradientPaint = function (ctx, item, paths, layer, paint, which, place) {
  var name = layer.name || "Shape";
  var grad = null;
  try {
    grad = LazyLord._ai_makeGradient(ctx.doc, paint, name);
    for (var i = 0; i < paths.length; i++) {
      if (which === "fill") paths[i].fillColor = LazyLord._ai_gradColor(grad);
      else paths[i].strokeColor = LazyLord._ai_gradColor(grad);
    }
  } catch (e) {
    // Put every member back on the flat colour, so none is left half-converted.
    var flat = (which === "fill") ? LazyLord.fillColor(layer) : LazyLord._ai_strokeFlat(paint);
    for (var j = 0; j < paths.length; j++) {
      try {
        if (which === "fill") paths[j].fillColor = LazyLord._ai_rgb(flat);
        else paths[j].strokeColor = LazyLord._ai_rgb(flat);
      } catch (eF) {}
    }
    if (grad) { try { grad.remove(); } catch (eR) {} }
    return false;
  }

  var label = (which === "fill") ? "Gradient fill" : "Gradient stroke";
  if (!place) {
    LazyLord.warn(name, label + " is native, but keeps Illustrator's default direction because the fill is a gradient too", "approximated");
    return true;
  }
  try {
    LazyLord._ai_placeGradient(ctx, item, paths, layer, paint, which);
  } catch (e2) {
    LazyLord.warn(name, label + " is native, but its direction and length could not be set exactly (" + e2.message + ")", "approximated");
  }
  return true;
};

/**
 * A GradientColor's extra matrix as [a, b, c, d, tx, ty], or null when it has
 * none or it cannot be read. An unreadable matrix is treated as the identity:
 * if transforms did land there, the read-back after the first transform shows
 * no change and _ai_moveGradient reports it instead of transforming again.
 */
LazyLord._ai_gradMatrix = function (col) {
  var v;
  try {
    var m = col.matrix;
    if (!m) return null;
    v = [Number(m.mValueA), Number(m.mValueB), Number(m.mValueC),
         Number(m.mValueD), Number(m.mValueTX), Number(m.mValueTY)];
  } catch (e) {
    return null;
  }
  for (var i = 0; i < 6; i++) if (isNaN(v[i])) return null;
  return v;
};

/**
 * A path's gradient vector as it shows on screen:
 * { origin: [x, y], end: [x, y], angle (deg, CCW), length }. The stored origin
 * and end point are mapped through GradientColor.matrix, where Illustrator
 * keeps every transform applied to the gradient (see the notes above).
 */
LazyLord._ai_gradVector = function (path, which) {
  var col = (which === "fill") ? path.fillColor : path.strokeColor;
  var o = col.origin;
  var ox = Number(o[0]), oy = Number(o[1]);
  var ang = Number(col.angle), len = Number(col.length);
  if (isNaN(ox) || isNaN(oy) || isNaN(ang) || isNaN(len)) {
    throw new Error("Illustrator did not report where it placed the gradient");
  }
  var r = ang * Math.PI / 180;
  var p = [ox, oy];
  var e = [ox + len * Math.cos(r), oy + len * Math.sin(r)];
  var m = LazyLord._ai_gradMatrix(col);
  if (m) {
    p = [m[0] * ox + m[2] * oy + m[4], m[1] * ox + m[3] * oy + m[5]];
    e = [m[0] * e[0] + m[2] * e[1] + m[4], m[1] * e[0] + m[3] * e[1] + m[5]];
  }
  var dx = e[0] - p[0], dy = e[1] - p[1];
  return { origin: p, end: e, angle: Math.atan2(dy, dx) * 180 / Math.PI, length: Math.sqrt(dx * dx + dy * dy) };
};

/** Did two read-backs come back the same (the host reported no change)? */
LazyLord._ai_sameVector = function (a, b) {
  return Math.abs(a.origin[0] - b.origin[0]) < 1e-6 && Math.abs(a.origin[1] - b.origin[1]) < 1e-6 &&
    Math.abs(a.end[0] - b.end[0]) < 1e-6 && Math.abs(a.end[1] - b.end[1]) < 1e-6;
};

/** Within 1pt of the target? A radial gradient's angle does not show, so it is not compared. */
LazyLord._ai_vectorNear = function (v, tgt, radial) {
  var dx = v.origin[0] - tgt.origin[0], dy = v.origin[1] - tgt.origin[1];
  if (Math.sqrt(dx * dx + dy * dy) > 1) return false;
  if (radial) return Math.abs(v.length - tgt.length) <= 1;
  var a = v.angle * Math.PI / 180, b = tgt.angle * Math.PI / 180;
  var ex = v.origin[0] + v.length * Math.cos(a) - (tgt.origin[0] + tgt.length * Math.cos(b));
  var ey = v.origin[1] + v.length * Math.sin(a) - (tgt.origin[1] + tgt.length * Math.sin(b));
  return Math.sqrt(ex * ex + ey * ey) <= 1;
};

/**
 * Is `pt` (Illustrator coords) on or near the layer's box? Illustrator's default
 * vector always starts on the object, so a default origin far away means it is
 * reported in a space this code cannot map, and moving it would be guesswork.
 */
LazyLord._ai_nearBox = function (ctx, frame, pt) {
  var w = frame.width || 0, h = frame.height || 0;
  var m = 2 + Math.max(w, h) / 2;
  var l = ctx.left + frame.x, t = ctx.top - frame.y;
  return pt[0] >= l - m && pt[0] <= l + w + m && pt[1] <= t + m && pt[1] >= t - h - m;
};

/**
 * Does matrix `m` hold the coefficients `want`? The tolerance is relative:
 * Illustrator stores matrices in single precision, so a translation of a few
 * thousand points can read back 1e-4 off while the matrix is right.
 */
LazyLord._ai_matrixIs = function (m, want) {
  try {
    var got = [m.mValueA, m.mValueB, m.mValueC, m.mValueD, m.mValueTX, m.mValueTY];
    for (var i = 0; i < 6; i++) {
      var tol = 1e-5 * Math.max(1, Math.abs(want[i]));
      if (typeof got[i] !== "number" || Math.abs(got[i] - want[i]) > tol) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * The Illustrator Matrix taking gradient vector `cur` onto `tgt`:
 * translate(-cur.origin), rotate(tgt.angle - cur.angle), scale(tgt.length /
 * cur.length), translate(tgt.origin). Points map as x' = a*x + c*y + tx,
 * y' = b*x + d*y + ty, angles counter-clockwise in Illustrator's y-up space.
 */
LazyLord._ai_vectorMatrix = function (cur, tgt) {
  if (!(cur.length > 1e-6)) throw new Error("Illustrator reported a zero-length gradient");
  var k = tgt.length / cur.length;
  var delta = tgt.angle - cur.angle;
  var r = delta * Math.PI / 180;
  var cs = Math.cos(r) * k, sn = Math.sin(r) * k;
  var want = [
    cs, sn, -sn, cs,
    tgt.origin[0] - (cs * cur.origin[0] - sn * cur.origin[1]),
    tgt.origin[1] - (sn * cur.origin[0] + cs * cur.origin[1])
  ];

  var m = null;
  try {
    m = app.getIdentityMatrix();
    m = app.concatenateTranslationMatrix(m, -cur.origin[0], -cur.origin[1]);
    m = app.concatenateRotationMatrix(m, delta);
    m = app.concatenateScaleMatrix(m, k * 100, k * 100);
    m = app.concatenateTranslationMatrix(m, tgt.origin[0], tgt.origin[1]);
  } catch (e) {
    m = null;
  }
  // The scripting reference does not say which side concatenate* multiply on.
  // When the host composed the steps the other way round, write the
  // coefficients directly so the matrix is right either way. Only a write that
  // evidently did not take (off by more than rounding) stops here: transforming
  // with a matrix known to be wrong would leave the gradient worse than
  // Illustrator's default.
  if (!m || !LazyLord._ai_matrixIs(m, want)) {
    if (!m) m = app.getIdentityMatrix();
    m.mValueA = want[0]; m.mValueB = want[1];
    m.mValueC = want[2]; m.mValueD = want[3];
    m.mValueTX = want[4]; m.mValueTY = want[5];
    if (!LazyLord._ai_matrixIs(m, want)) throw new Error("the gradient matrix could not be built");
  }
  return m;
};

/** Move only the gradients of `item` by `m` (the object and its strokes stay put). */
LazyLord._ai_gradTransform = function (item, m) {
  // transform(matrix, changePositions, changeFillPatterns, changeFillGradients,
  //           changeStrokePattern, changeLineWidths, transformAbout)
  item.transform(m, false, false, true, false, 1, Transformation.DOCUMENTORIGIN);
};

/** Stroke widths of some paths, so a gradient transform cannot change them. */
LazyLord._ai_strokeWidths = function (paths) {
  var out = [];
  for (var i = 0; i < paths.length; i++) {
    try { if (paths[i].stroked) out.push({ path: paths[i], width: paths[i].strokeWidth }); } catch (e) {}
  }
  return out;
};

LazyLord._ai_restoreWidths = function (list) {
  for (var i = 0; i < list.length; i++) {
    try {
      if (list[i].path.strokeWidth !== list[i].width) list[i].path.strokeWidth = list[i].width;
    } catch (e) {}
  }
};

/**
 * Transform `item`'s gradients until the vector read from `probe` matches
 * `tgt`. The first pass sets angle and length exactly, and the origin too when
 * DOCUMENTORIGIN coincides with the scripting origin. If it does not, what is
 * left over is a pure translation, which does not depend on the reference
 * point, so a second, translation-only pass is exact.
 *
 * The second pass is only built from a read-back that proves the first one
 * landed as modelled: one that shows no change at all (the host keeps the move
 * somewhere this code does not read) or a different angle or length would make
 * any further transform guesswork, and applying the same move twice. Those
 * cases stop with an error, which the caller reports as approximated.
 */
LazyLord._ai_moveGradient = function (item, probe, which, tgt, radial) {
  var cur = LazyLord._ai_gradVector(probe, which);
  if (LazyLord._ai_vectorNear(cur, tgt, radial)) return;
  LazyLord._ai_gradTransform(item, LazyLord._ai_vectorMatrix(cur, tgt));

  var now = LazyLord._ai_gradVector(probe, which);
  if (LazyLord._ai_vectorNear(now, tgt, radial)) return;
  if (LazyLord._ai_sameVector(now, cur)) {
    throw new Error("Illustrator did not report the moved gradient, so its placement could not be confirmed");
  }
  // Same angle and length as the target, measured from where it now starts?
  if (!LazyLord._ai_vectorNear(now, { origin: now.origin, angle: tgt.angle, length: tgt.length }, radial)) {
    throw new Error("Illustrator turned or scaled it differently than expected");
  }
  LazyLord._ai_gradTransform(item, LazyLord._ai_vectorMatrix(now,
    { origin: tgt.origin, angle: now.angle, length: now.length }));

  if (!LazyLord._ai_vectorNear(LazyLord._ai_gradVector(probe, which), tgt, radial)) {
    throw new Error("it is still more than 1pt away after the gradient transform");
  }
};

/** Move the gradient on `item` (and its member `paths`) onto the IR's handles. */
LazyLord._ai_placeGradient = function (ctx, item, paths, layer, paint, which) {
  var gp = LazyLord.gradientPx(layer, paint);
  if (!(gp.radius > 0.01)) throw new Error("its start and end handles coincide");
  var o = LazyLord._ai_pt(ctx, gp.from[0], gp.from[1]);
  var e = LazyLord._ai_pt(ctx, gp.to[0], gp.to[1]);
  var tgt = {
    origin: o,
    angle: Math.atan2(e[1] - o[1], e[0] - o[0]) * 180 / Math.PI,
    length: gp.radius // the linear length or the radial radius, 1px = 1pt
  };
  var radial = (paint.type === "radial-gradient");

  if (!LazyLord._ai_nearBox(ctx, layer.frame, LazyLord._ai_gradVector(paths[0], which).origin)) {
    throw new Error("Illustrator reported its default position in an unexpected coordinate space");
  }

  var widths = LazyLord._ai_strokeWidths(paths);
  try {
    LazyLord._ai_moveGradient(item, paths[0], which, tgt, radial);
    for (var i = 0; i < paths.length; i++) {
      if (paths[i] === item) continue;
      if (!LazyLord._ai_vectorNear(LazyLord._ai_gradVector(paths[i], which), tgt, radial)) {
        LazyLord._ai_moveGradient(paths[i], paths[i], which, tgt, radial);
      }
    }
    // A member's own correction may have moved a style other members share,
    // including ones already checked: read every member back once more.
    if (paths.length > 1) {
      for (var j = 0; j < paths.length; j++) {
        if (!LazyLord._ai_vectorNear(LazyLord._ai_gradVector(paths[j], which), tgt, radial)) {
          throw new Error("the gradient direction could not be set on every contour");
        }
      }
    }
  } finally {
    // changeLineWidths is documented inconsistently (percentage or factor), so
    // put back any stroke width the transform touched.
    LazyLord._ai_restoreWidths(widths);
  }
};

/* -------------------------------------------------------------------------
 * Groups
 *
 * hierarchy "groups": each IR group becomes a GroupItem, created in the
 * current container when the walk reaches it, named after the group and
 * carrying the group's own opacity; its children are then built into it.
 * Illustrator puts every new item on top of its container and the IR lists
 * layers bottom-to-top, so building in IR order stacks everything correctly:
 * a group lands above what was built before it and below what comes after,
 * and its children stack the same way inside it. A group with a clip of its
 * own is built inside a clipping group of its parent, like any other layer;
 * so is a group whose every layer is clipped by the same mask as the siblings
 * on both sides of it, when that keeps them in order (see _ai_joinEntry).
 *
 * hierarchy "flatten": groups dissolve into their leaves (LazyLord.flattenLayers
 * multiplies each group's opacity into them). A group's clip is handed down to
 * the layers under it first, so they stay clipped.
 * ---------------------------------------------------------------------- */

/** The document's leaves in stacking order, for hierarchy "flatten". */
LazyLord._ai_flatten = function (doc) {
  var names = [];
  LazyLord.eachLayer(doc.layers, function (layer) {
    if (layer.type !== "group") return;
    var kids = layer.children || [];
    if (!kids.length) LazyLord._ai_noteEmpty(layer);
    // Before the walk reaches the children, so a clip travels all the way down.
    LazyLord._ai_pushClip(layer);
    var go = (layer.frame && typeof layer.frame.opacity === "number") ? layer.frame.opacity : 1;
    // Folding the opacity is only approximate when it lands on several
    // layers. Count the group's leaves, not its direct children: a translucent
    // group whose only child is a group of several layers fades each of them
    // too, and one leaf beside an empty group folds exactly.
    if (go < 1 && LazyLord.countLeaves(kids) > 1) names.push(layer.name || "Group");
  });

  // Counted from the walk above rather than from the result's .lossy, so the
  // number and the names always describe the same groups.
  var leaves = LazyLord.flattenLayers(doc.layers);
  var lossy = names.length;
  if (lossy > 0) {
    var who = names.slice(0, 3).join(", ") + (lossy > 3 ? " and " + (lossy - 3) + " more" : "");
    LazyLord.warn(who, "Groups are flattened, so the opacity of " +
      (lossy === 1 ? "this group" : lossy + " groups") +
      " was applied to each layer inside it instead: where those layers overlap, they now show " +
      "through each other. Send with Hierarchy set to Groups to keep it exact", "approximated");
  }
  return leaves;
};

LazyLord._ai_noteEmpty = function (group) {
  LazyLord.warn(group.name || "Group", "The group is empty, so there is nothing to rebuild", "skipped");
};

/**
 * Hand a group's clip to its direct children, for when the group itself is
 * not rebuilt. Each child gets its own copy with the same id, so they still
 * share one clipping group. A child clipped by another mask keeps that one:
 * the IR keeps the innermost mask, and losing the group's is reported.
 */
LazyLord._ai_pushClip = function (group) {
  var clip = group.clip;
  if (!clip) return;
  var kids = group.children || [];
  for (var i = 0; i < kids.length; i++) {
    var kid = kids[i];
    if (!kid.clip) {
      kid.clip = JSON.parse(JSON.stringify(clip));
    } else if (kid.clip.id !== clip.id) {
      LazyLord.warn(kid.name || "Layer", "Clipped by both \"" + (clip.name || "Clipping mask") + "\" and \"" +
        (kid.clip.name || "Clipping mask") + "\": without their group, only the inner one is kept", "approximated");
    }
  }
};

/** Multiply a group's opacity into its direct children (layers and groups alike). */
LazyLord._ai_foldOpacity = function (group) {
  var go = (group.frame && typeof group.frame.opacity === "number") ? group.frame.opacity : 1;
  if (go >= 1) return;
  var kids = group.children || [];
  for (var i = 0; i < kids.length; i++) {
    var f = kids[i].frame;
    if (!f) continue;
    f.opacity = ((typeof f.opacity === "number") ? f.opacity : 1) * go;
  }
};

/** How many items were built into a scope, directly or inside its clipping groups. */
LazyLord._ai_scopeBuilt = function (scope) {
  var n = scope.topBuilt;
  for (var i = 0; i < scope.clipOrder.length; i++) n += scope.clipOrder[i].members;
  return n;
};

/**
 * Rebuild an IR group as a GroupItem in ctx.container (hierarchy "groups").
 * True when it holds anything; a group whose layers all failed is removed.
 * If no GroupItem can be created, its layers are built into the parent
 * instead, with its opacity and clip handed down to them.
 */
LazyLord._ai_group = function (ctx, scope, layer) {
  var name = layer.name || "Group";
  var kids = layer.children || [];
  if (!kids.length) {
    LazyLord._ai_noteEmpty(layer);
    return false;
  }

  var g;
  try {
    g = ctx.container.groupItems.add();
  } catch (e) {
    LazyLord.warn(name, "The group could not be created (" + e.message + "), so its layers were built without it", "approximated");
    LazyLord._ai_foldOpacity(layer);
    LazyLord._ai_pushClip(layer);
    // Its layers count (and join clipping groups) as the parent's own.
    LazyLord._ai_buildList(ctx, scope, kids);
    return false;
  }

  if (layer.name) { try { g.name = layer.name; } catch (eN) {} }
  if (layer.frame && layer.frame.opacity !== undefined) {
    try {
      g.opacity = LazyLord.pct(layer.frame.opacity);
    } catch (eO) {
      LazyLord._ai_foldOpacity(layer);
      LazyLord.warn(name, "The group's opacity could not be set (" + eO.message +
        "), so it was applied to each layer inside it instead", "approximated");
    }
  }

  var inner = LazyLord._ai_scope(g);
  LazyLord._ai_buildList(ctx, inner, kids);
  LazyLord._ai_closeClips(ctx, inner);
  if (!LazyLord._ai_scopeBuilt(inner)) {
    // Every layer it was meant to hold failed (and was reported); an empty
    // group is harmless if it cannot be removed.
    try { g.remove(); } catch (eR) {}
    return false;
  }
  return true;
};

/* -------------------------------------------------------------------------
 * Clipping groups
 *
 * Within one container (the document, or the GroupItem of an IR group), every
 * layer whose clip carries the same id is built inside ONE GroupItem, created
 * in that container at the first such layer in stacking order. Once the
 * container's layers are built, the clip outline is added as the group's
 * topmost item, marked as the clipping path, and the group is clipped. Layers
 * sharing a clip id under different IR parents get a clipping group each, with
 * its own copy of the outline.
 *
 * Z-order: the group sits where it was created, at the first layer carrying
 * that clip id. If layers sharing a clip id are not consecutive in the IR, the
 * later ones are pulled down into that group, below every layer actually built
 * above the group in between — Illustrator cannot interleave a clipping group
 * with outside art. That reordering is reported for each layer it affects.
 *
 * One case in between needs no reordering: an IR group (hierarchy "groups")
 * whose every layer carries the same clip, sitting between two layers of that
 * mask — an Illustrator clip group or a Figma clipping frame with a sub-group
 * among its layers. The mask already clips everything in it, so the group is
 * built inside the clipping group, in its place, and the layer above it joins
 * without moving (_ai_joinEntry). Its own layers still get their clipping
 * group inside it, per parent as above: clipping twice by one outline changes
 * nothing on screen.
 * ---------------------------------------------------------------------- */

/** "#" + clip id when a layer carries a clip that can be built, else null. */
LazyLord._ai_clipKey = function (layer) {
  var clip = layer && layer.clip;
  if (!clip || !clip.subpaths || !clip.subpaths.length) return null;
  return "#" + clip.id;
};

/**
 * The clip key every leaf inside `group` carries, or null when there are no
 * leaves, one is unclipped, or they differ. A group inside it may carry that
 * same clip, but no other.
 */
LazyLord._ai_leafClip = function (group) {
  var key = null, same = true, leaves = 0;
  LazyLord.eachLayer(group.children || [], function (layer) {
    if (!same) return;
    var k = LazyLord._ai_clipKey(layer);
    if (layer.type === "group") {
      if (!layer.clip) return;
      if (!k || (key && k !== key)) same = false;
      else key = k;
      return;
    }
    leaves++;
    if (!k || (key && k !== key)) same = false;
    else key = k;
  });
  return (same && leaves > 0) ? key : null;
};

/**
 * The clipping group a group without a clip of its own (layers[i]) joins, or
 * null to build it straight into the container. It joins only when:
 *  - every leaf inside it is clipped by that mask, so clipping it changes nothing;
 *  - the mask's clipping group already exists in this container, with nothing
 *    built above it, so the group keeps its exact place;
 *  - a later sibling is clipped by the same mask directly, which would
 *    otherwise be pulled down below the group. Without one, the group already
 *    sits in order above the clipping group and is not wrapped for nothing.
 */
LazyLord._ai_joinEntry = function (scope, layers, i) {
  var layer = layers[i];
  if (layer.type !== "group" || layer.clip || !scope.clipOrder.length) return null;
  var key = LazyLord._ai_leafClip(layer);
  if (!key || !scope.clips.hasOwnProperty(key)) return null;
  var entry = scope.clips[key];
  if (!entry.group || LazyLord._ai_builtAbove(scope, entry) > 0) return null;
  for (var j = i + 1; j < layers.length; j++) {
    if (LazyLord._ai_clipKey(layers[j]) === key) return entry;
  }
  return null;
};

/**
 * How many built items sit above `entry`'s group in its container: those
 * built straight into the container since the group was created, plus the
 * members of every group created after it (new items and groups go on top).
 * Layers that failed built nothing, and groups created earlier sit below, so
 * neither counts.
 */
LazyLord._ai_builtAbove = function (scope, entry) {
  var n = scope.topBuilt - entry.topBuilt;
  var later = false;
  for (var i = 0; i < scope.clipOrder.length; i++) {
    var other = scope.clipOrder[i];
    if (later && other.group) n += other.members;
    if (other === entry) later = true;
  }
  return n;
};

/** The clip entry (and group) a layer is built into, or null for the scope's own container. */
LazyLord._ai_clipEntry = function (ctx, scope, layer) {
  var clip = layer.clip;
  if (!clip) return null;
  var label = clip.name || "Clipping mask";
  if (!clip.subpaths || !clip.subpaths.length) {
    LazyLord.warn(layer.name, "Clipping mask \"" + label + "\" has no outline, so the layer is unclipped", "skipped");
    return null;
  }

  var key = "#" + clip.id;
  if (scope.clips.hasOwnProperty(key)) {
    var known = scope.clips[key];
    if (!known.group) return null; // creating it failed; already reported
    if (LazyLord._ai_builtAbove(scope, known) > 0) {
      LazyLord.warn(layer.name, "Shares clipping mask \"" + label + "\" with layers further down, so it was grouped " +
        "with them and now sits below the layers in between", "approximated");
    }
    return known;
  }

  // Each layer carries its own copy of the clip; the first one describes the
  // mask (applyOrigin shifted every copy identically).
  var entry = { clip: clip, group: null, members: 0, topBuilt: scope.topBuilt };
  scope.clips[key] = entry;
  scope.clipOrder.push(entry);
  try {
    entry.group = scope.item.groupItems.add();
    try { entry.group.name = label; } catch (eN) {}
  } catch (e) {
    entry.group = null;
    LazyLord.warn(label, "Clipping group could not be created (" + e.message + "), so the layers it masks are unclipped", "skipped");
    return null;
  }
  return entry;
};

/** Add every clip outline of one container to its group and switch the clipping on. */
LazyLord._ai_closeClips = function (ctx, scope) {
  for (var i = 0; i < scope.clipOrder.length; i++) {
    var entry = scope.clipOrder[i];
    if (!entry.group) continue;
    if (!entry.members) {
      // Every layer it was meant to hold failed (and was reported); an empty
      // group is harmless if it cannot be removed.
      try { entry.group.remove(); } catch (eR) {}
      continue;
    }
    var label = entry.clip.name || "Clipping mask";
    var mask = null;
    try {
      mask = LazyLord._ai_clipOutline(ctx, entry.group, entry.clip);
      entry.group.clipped = true;
    } catch (e) {
      if (mask) { try { mask.remove(); } catch (eM) {} }
      try { entry.group.clipped = false; } catch (eC) {}
      LazyLord.warn(label, "Clipping mask could not be applied (" + e.message + "), so its contents are unclipped", "skipped");
    }
  }
};

/**
 * The clip outline as the topmost item of `group`: a path for one contour, a
 * compound path for several. New items are created at the top of their
 * container, and this runs after every member was built.
 */
LazyLord._ai_clipOutline = function (ctx, group, clip) {
  var multi = clip.subpaths.length > 1;
  var compound = null;
  var paths = [];
  try {
    compound = multi ? group.compoundPathItems.add() : null;
    for (var i = 0; i < clip.subpaths.length; i++) {
      var p = compound ? compound.pathItems.add() : group.pathItems.add();
      paths.push(p);
      // Clip contours are already absolute (frame space, moved by applyOrigin
      // with the frames), so there is no layer offset to add.
      LazyLord._ai_drawPath(ctx, p, clip.subpaths[i], 0, 0);
      p.filled = false;
      p.stroked = false;
      p.clipping = true;
    }
  } catch (e) {
    var partial = compound || paths[0];
    if (partial) { try { partial.remove(); } catch (eR) {} }
    throw e;
  }
  var item = compound || paths[0];
  try { item.name = clip.name || "Clipping path"; } catch (eN) {}
  LazyLord._ai_winding(paths, clip.windingRule, clip.name || "Clipping mask");
  return item;
};

/* -------------------------------------------------------------------------
 * Rotation
 *
 * IR rotation is clockwise about the frame centre. Illustrator's rotate() is
 * counter-clockwise for positive angles, so it is given -deg. Where Illustrator
 * puts its pivot does not matter: a rigid motion is fixed by its angle plus the
 * image of one point, so after rotating, the item is translated until a point
 * rigidly attached to it (the text anchor, or an image's centre) lands exactly
 * where rotating the IR box about its centre would put that point.
 * ---------------------------------------------------------------------- */

/** Rotate an Illustrator point (y-up) clockwise on screen by `deg` about `c`. */
LazyLord._ai_rot = function (pt, c, deg) {
  // Clockwise on screen is a negative angle in y-up space.
  var r = -deg * Math.PI / 180;
  var cos = Math.cos(r), sin = Math.sin(r);
  var dx = pt[0] - c[0], dy = pt[1] - c[1];
  return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos];
};

LazyLord._ai_anchorOf = function (item) {
  var a = item.anchor;
  var p = [Number(a[0]), Number(a[1])];
  if (isNaN(p[0]) || isNaN(p[1])) throw new Error("no anchor");
  return p;
};

LazyLord._ai_centreOf = function (item) {
  var gb = item.geometricBounds; // [left, top, right, bottom]
  return [(gb[0] + gb[2]) / 2, (gb[1] + gb[3]) / 2];
};

/**
 * Turn `item` clockwise by `deg`, then move it so the point `track` reads lands
 * on `target`. On failure the rotation is undone before the error propagates.
 */
LazyLord._ai_turn = function (item, deg, track, target) {
  item.rotate(-deg, true, true, true, true, Transformation.CENTER);
  try {
    var now = track(item);
    item.translate(target[0] - now[0], target[1] - now[1]);
  } catch (e) {
    try { item.rotate(deg, true, true, true, true, Transformation.CENTER); } catch (eU) {}
    throw e;
  }
};

/**
 * Rotate a text frame as if its IR box turned about its centre. _ai_text
 * created the frame unrotated with its anchor on LazyLord.textAnchor, and the
 * anchor is rigidly attached to the text, so it is tracked through the turn and
 * must end exactly on LazyLord.rotatedTextAnchor, whether the source sent a
 * real baseline or the target estimated one. If Illustrator does not report the
 * anchor, the bounds centre is tracked instead: the unrotated frame already
 * stands where it belongs, so that centre turned about the IR centre is where
 * it must end.
 */
LazyLord._ai_turnText = function (ctx, tf, layer, deg) {
  var name = layer.name || "Text";
  try {
    var track = LazyLord._ai_anchorOf;
    var target;
    try {
      track(tf);
      var ra = LazyLord.rotatedTextAnchor(layer);
      target = LazyLord._ai_pt(ctx, ra[0], ra[1]);
    } catch (eA) {
      track = LazyLord._ai_centreOf;
      var c = LazyLord.frameCenter(layer.frame);
      target = LazyLord._ai_rot(track(tf), LazyLord._ai_pt(ctx, c[0], c[1]), deg);
      LazyLord.warn(name, "Illustrator did not report the text's baseline anchor, so its rotation was placed from the text bounds", "approximated");
    }
    LazyLord._ai_turn(tf, deg, track, target);
  } catch (e) {
    // _ai_turn undoes its own turn, so the text stays unrotated on its anchor.
    LazyLord.warn(name, "Rotation could not be applied (" + e.message + "), so the text is placed unrotated", "approximated");
  }
};

/* -------------------------------------------------------------------------
 * Text and images
 * ---------------------------------------------------------------------- */

/**
 * Point text sits on its anchor: the alignment point of its first baseline,
 * which is the baseline's left end, its centre or its right end as the
 * paragraph is left-, centre- or right-justified. LazyLord.textAnchor is that
 * same point in the IR box, so the frame is created on it: exactly when the
 * source sent its real baseline (Illustrator point text, After Effects text),
 * on the IR estimate otherwise (Figma), as After Effects and Photoshop do.
 */
/** Per-character styles: each run's attributes set on its characters. */
LazyLord._ai_textRuns = function (tf, layer) {
  var runs = LazyLord.fullTextRuns(layer);
  if (!runs.length) return;
  var name = layer.name || "Text";
  var chars = null;
  try { chars = tf.textRange.characters; } catch (e) {}
  if (!chars || typeof chars.length !== "number") {
    LazyLord.warn(name, "Mixed character styles could not be applied, so the whole text uses its first style", "approximated");
    return;
  }
  var lost = false, missing = {};
  for (var i = 0; i < runs.length; i++) {
    var r = runs[i];
    var font = r.fontFamily ? LazyLord._ai_findFont(r.fontFamily, r.fontStyle) : null;
    if (r.fontFamily && !font) missing[r.fontFamily + " " + r.fontStyle] = true;
    var color = LazyLord._ai_rgb(r.color);
    var tracking = Math.round((r.letterSpacing / (r.fontSize || 24)) * 1000);
    for (var k = r.start; k < r.end && k < chars.length; k++) {
      try {
        var a = chars[k].characterAttributes;
        a.size = r.fontSize;
        a.fillColor = color;
        a.tracking = tracking;
        if (font) a.textFont = font;
        a.underline = r.decoration === "underline";
        a.strikeThrough = r.decoration === "strikethrough";
      } catch (eC) { lost = true; }
    }
  }
  for (var m in missing) {
    if (missing.hasOwnProperty(m)) LazyLord.warn(name, "Font '" + m + "' used in part of the text was not found; that part keeps the text's font", "approximated");
  }
  if (lost) LazyLord.warn(name, "Some mixed character styles could not be applied", "approximated");
};

LazyLord._ai_text = function (ctx, layer) {
  var name = layer.name || "Text";
  var anchor = LazyLord.textAnchor(layer);
  var tf = ctx.container.textFrames.pointText(LazyLord._ai_pt(ctx, anchor[0], anchor[1]));

  tf.contents = layer.characters || "";
  tf.name = name;

  var attr = tf.textRange.characterAttributes;
  attr.size = layer.fontSize || 24;
  attr.fillColor = LazyLord._ai_rgb(layer.color || { r: 0, g: 0, b: 0 });
  if (layer.letterSpacing) attr.tracking = Math.round((layer.letterSpacing / (layer.fontSize || 24)) * 1000);
  if (layer.lineHeight) {
    try { attr.autoLeading = false; attr.leading = layer.lineHeight; } catch (eL) {}
  }

  var font = LazyLord._ai_findFont(layer.fontFamily, layer.fontStyle);
  if (font) attr.textFont = font;
  LazyLord._ai_textRuns(tf, layer);

  // Justify once the contents and their size are final, and before anything
  // is measured or turned: point text keeps its anchor where it was created
  // and lays its lines out around it, so the anchor becomes the alignment
  // point textAnchor chose.
  var jmap = { left: Justification.LEFT, center: Justification.CENTER, right: Justification.RIGHT, justified: Justification.FULLJUSTIFY };
  try {
    tf.textRange.paragraphAttributes.justification = jmap[layer.textAlignHorizontal] || Justification.LEFT;
  } catch (eJ) {
    LazyLord.warn(name, "Text alignment \"" + (layer.textAlignHorizontal || "left") +
      "\" could not be applied, so the text runs from its alignment point with Illustrator's default alignment", "approximated");
  }

  var deg = layer.frame.rotation || 0;
  if (deg) LazyLord._ai_turnText(ctx, tf, layer, deg);

  if (layer.frame.opacity !== undefined) tf.opacity = LazyLord.pct(layer.frame.opacity);
  return tf;
};

LazyLord._ai_image = function (ctx, layer) {
  var path = LazyLord.imagePath(layer);
  if (!path) throw new Error("image has no file path");
  var name = layer.name || "Image";
  var pl = ctx.container.placedItems.add();
  pl.file = new File(path);
  pl.name = name;
  // placedItem.position is the top-left of its bounds.
  pl.position = LazyLord._ai_pt(ctx, layer.frame.x, layer.frame.y);
  var fw = layer.frame.width || pl.width;
  var fh = layer.frame.height || pl.height;
  var sx = (fw / pl.width) * 100;
  var sy = (fh / pl.height) * 100;
  try {
    pl.resize(sx, sy, true, true, true, true, sx, Transformation.TOPLEFT);
  } catch (e) {
    pl.width = fw; pl.height = fh;
  }
  var opacity;
  if (layer.frame.opacity !== undefined) {
    opacity = LazyLord.pct(layer.frame.opacity);
    pl.opacity = opacity;
  }

  var deg = layer.frame.rotation || 0;
  if (deg) {
    // The image now fills the IR box, so its bounds centre is a point rigidly
    // attached to it: that centre turned about the IR centre is where it must end.
    try {
      var c = LazyLord.frameCenter(layer.frame);
      var pivot = LazyLord._ai_pt(ctx, c[0], c[1]);
      LazyLord._ai_turn(pl, deg, LazyLord._ai_centreOf,
        LazyLord._ai_rot(LazyLord._ai_centreOf(pl), pivot, deg));
    } catch (eRot) {
      LazyLord.warn(name, "Rotation could not be applied (" + eRot.message + "), so the image is placed unrotated", "approximated");
    }
  }

  // Files LazyLord generated (Figma exports, rasterised fallbacks) live in its
  // temp folder: embed them so the .ai does not depend on it. The user's own
  // linked originals are never embedded.
  if (layer.isOriginalFile !== true) LazyLord._ai_embed(pl, name, opacity);
  return pl;
};

/** Embed a generated image and restore the name/opacity on what replaces it. */
LazyLord._ai_embed = function (pl, name, opacity) {
  var parent = null;
  try { parent = pl.parent; } catch (eP) {}
  try {
    pl.embed();
  } catch (e) {
    LazyLord.warn(name, "The generated image could not be embedded (" + e.message +
      "), so it stays linked to LazyLord's temporary folder", "approximated");
    return;
  }
  // embed() deletes the PlacedItem and leaves the embedded art in its stacking
  // slot — the top of its parent, since the image was created there just now.
  try {
    var emb = parent.pageItems[0];
    if (!emb || emb.typename === "PlacedItem") throw new Error("embedded copy not found");
    emb.name = name;
    if (opacity !== undefined) emb.opacity = opacity;
  } catch (e2) {
    LazyLord.warn(name, "The image was embedded, but its name and opacity could not be restored", "approximated");
  }
};

/* -------------------------------------------------------------------------
 * Updating what an earlier transfer built (options.existing "update")
 *
 * Illustrator has no timeline, so "update" means something plainer here than
 * it does in After Effects: the artwork is rebuilt and dropped into the exact
 * stacking position the old item held, inside the same layer or group, and the
 * old item is removed. What that preserves is where the artwork sits in the
 * document — re-sending a logo does not send it to the front of the stack, and
 * does not leave a duplicate behind.
 *
 * What it does not preserve is anything done to the item itself: an appearance
 * added in Illustrator goes with the item it was added to. The panel says so.
 * ---------------------------------------------------------------------- */

/** Items in the document that carry a LazyLord tag, as tag key -> [items]. */
LazyLord._ai_index = function (aiDoc) {
  var index = {};
  var items;
  try { items = aiDoc.pageItems; } catch (e) { return index; }
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var key = null;
    try { key = LazyLord.readTagKey(it.note); } catch (eN) { continue; }
    if (!key) continue;
    if (!index[key]) index[key] = [];
    index[key].push(it);
  }
  return index;
};

/**
 * Tag every item added to `container` since it held `before` items. They all
 * take the same tag: an update replaces the whole set, so they have to be
 * found as a set.
 */
LazyLord._ai_tagNew = function (ctx, container, before, layer) {
  if (!ctx.ir || !container) return;
  var made = [];
  try {
    var n = container.pageItems.length - before;
    for (var i = 0; i < n; i++) made.push(container.pageItems[i]);
  } catch (e) {
    return;
  }
  LazyLord._ai_tagItems(ctx, made, layer);
  // Blend mode and effects belong to every item the layer produced.
  for (var f = 0; f < made.length; f++) LazyLord._ai_finish(made[f], layer);
};

/** Put this layer's tag on each of `items`, keeping whatever note they hold. */
LazyLord._ai_tagItems = function (ctx, items, layer) {
  if (!ctx.ir || !items || !items.length) return;
  var tag = LazyLord.makeTag(ctx.ir, layer);
  for (var i = 0; i < items.length; i++) {
    // An item that cannot be tagged simply will not match next time.
    try { items[i].note = LazyLord.withTag(items[i].note, tag); } catch (eI) {}
  }
};

/**
 * Rebuild `layer` over the items an earlier transfer made from it.
 * Returns true when a match was found and replaced, false to build normally.
 */
LazyLord._ai_update = function (ctx, layer) {
  var old = ctx.index[LazyLord.tagKey(ctx.ir, layer)];
  if (!old || !old.length) return false;

  var anchor = old[0];
  var parent;
  try { parent = anchor.parent; } catch (e) { return false; }
  if (!parent) return false;

  var name = layer.name || "Layer";
  var before, made;
  var saved = ctx.container;
  ctx.container = parent;
  try {
    before = parent.pageItems.length;
    if (!LazyLord._ai_layer(ctx, layer)) { ctx.container = saved; return false; }
    made = parent.pageItems.length - before;
  } catch (eBuild) {
    ctx.container = saved;
    LazyLord.warn(name, "Could not be rebuilt over the old artwork (" + eBuild.message + "), so that was left alone", "skipped");
    return true; // matched: adding a second copy would be worse
  }
  ctx.container = saved;

  // Take the new items before moving any of them: the indices shift as they go.
  var fresh = [];
  for (var i = 0; i < made; i++) {
    try { fresh.push(parent.pageItems[i]); } catch (eF) {}
  }

  // New items land at the front. Walk back to front, each one moving in front
  // of the last one moved, so they end up where the old artwork stood.
  var at = anchor;
  for (var m = fresh.length - 1; m >= 0; m--) {
    try {
      fresh[m].move(at, ElementPlacement.PLACEBEFORE);
      at = fresh[m];
    } catch (eM) {
      LazyLord.warn(name, "The rebuilt artwork could not be put back in its old place in the stack", "approximated");
      break;
    }
  }

  // Tag the items themselves, not by index: moving them shuffled the indices.
  LazyLord._ai_tagItems(ctx, fresh, layer);
  for (var q = 0; q < fresh.length; q++) LazyLord._ai_finish(fresh[q], layer);

  var removed = 0;
  for (var r = 0; r < old.length; r++) {
    try { old[r].remove(); removed++; } catch (eR) {}
  }
  if (removed < old.length) {
    LazyLord.warn(name, "The old artwork could not be removed, so it is still under the new version", "approximated");
  }

  ctx.updated++;
  return true;
};

/* -------------------------------------------------------------------------
 * Blend modes and effects
 *
 * Illustrator has a blend mode for each of the IR's, under its own spelling
 * ("color" is COLORBLEND). It has no stock live effect matching the IR's
 * shadows and blurs that can be scripted safely, so those are reported.
 * ---------------------------------------------------------------------- */

LazyLord._ai_BLEND = {
  "multiply": "MULTIPLY",
  "screen": "SCREEN",
  "overlay": "OVERLAY",
  "darken": "DARKEN",
  "lighten": "LIGHTEN",
  "color-dodge": "COLORDODGE",
  "color-burn": "COLORBURN",
  "hard-light": "HARDLIGHT",
  "soft-light": "SOFTLIGHT",
  "difference": "DIFFERENCE",
  "exclusion": "EXCLUSION",
  "hue": "HUE",
  "saturation": "SATURATION",
  "color": "COLORBLEND",
  "luminosity": "LUMINOSITY"
};

/** Apply the IR's blend mode and report any effects, on one Illustrator item. */
LazyLord._ai_finish = function (item, layer) {
  if (!item) return;
  LazyLord.applyBlend(function (v) { item.blendingMode = v; }, layer,
    typeof BlendModes !== "undefined" ? BlendModes : null, LazyLord._ai_BLEND);
  LazyLord.noteEffects(layer, "Illustrator live effects cannot be scripted, so these were left off");
};
