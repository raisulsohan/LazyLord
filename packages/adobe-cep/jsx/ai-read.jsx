/*
 * LazyLord — Illustrator reader (push side).
 * Serialises the current Illustrator selection into LazyLord IR so it can be
 * pushed to After Effects.
 *
 * Coordinate handling: Illustrator is y-up with the ruler origin at the active
 * artboard; the IR is y-down with (0,0) at the top-left of the selection. Every
 * point goes through _air_x / _air_y, so tangents come out correctly flipped
 * because both the anchor and its handle are converted before subtracting.
 *
 * Rotation: Illustrator bakes it into path geometry, so vectors keep frame
 * rotation 0. Text frames and linked images are different: they keep their
 * turn in item.matrix, and geometricBounds is then only the upright box around
 * the turned item. For those the rotation is read from the matrix, the
 * unrotated size is recovered (see _air_turned), the IR box is centred on the
 * outer box's centre, and a point text anchor is turned back about that centre
 * so LazyLord.rotatedTextAnchor lands it where it was. Anything exported as a
 * PNG is already upright and keeps rotation 0.
 *
 * Stacking order: Illustrator lists the selection, and a group's pageItems,
 * front to back (index 0 is the topmost object). The IR lists layers bottom
 * to top, so both are walked from the end.
 *
 * Groups: every GroupItem in the selection becomes an IR group holding its
 * contents, bottom to top, with the group's own opacity; its frame is the
 * union of what its contents cover (their upright outer boxes, the same boxes
 * the selection bounds are measured from). The target decides whether to
 * rebuild groups or flatten them (LazyLord.flattenLayers, which also carries
 * the group's opacity into its leaves). Groups around a selected object that
 * were not themselves selected are not sent, only their clipping masks; an
 * opacity set on one of them, or on a layer, is reported as lost.
 *
 * Compound paths: a path picked out of one (Direct or Group Selection) is sent
 * as the whole compound path, whose paint, opacity and holes it has no copy of
 * (see _air_selection).
 *
 * Clipping groups are not flattened away: every leaf inside one carries the
 * mask outline as its own `clip`, in frame space. That holds for an object
 * picked out of a clipping group with Direct Selection too (its parents are
 * walked for their masks), and for a layer clipping mask. Gradients carry
 * their real vector (origin, angle, length, carried through the gradient's own
 * matrix), normalised to the owning layer's box. Paths that are exactly an
 * axis-aligned rectangle or ellipse are also flagged as a `primitive`, so a
 * host with live shapes can rebuild them parametrically.
 */

/**
 * Live sync: a cheap stamp of what a send would read, which the panel polls and
 * sends again when it changes — each selected item's geometry, points, paint,
 * text and linked file (the builder's conflict fingerprint), its name and blend
 * mode. A large selection stops reading points after a few thousand and goes
 * on with bounds, and looks at no more than 500 items, so the poll never
 * stalls Illustrator. "" when there is
 * nothing to send, including while text is being typed (the selection is then
 * a text range, and the frame is read once editing ends).
 */
LazyLord.liveStamp = function () {
  if (app.documents.length === 0) return "";
  var sel = app.selection;
  if (!sel || typeof sel.length !== "number" || sel.length === 0 || sel.typename === "TextRange") return "";
  var budget = { points: 4000 };
  var out = [];
  for (var i = 0; i < sel.length && i < 500; i++) {
    var it = sel[i];
    var extra = [];
    try { extra = [it.name, it.blendingMode]; } catch (e) {}
    out.push(LazyLord.printValue(extra) + LazyLord._ai_itemPrint(it, budget));
  }
  return LazyLord.hashText(out.join("|"));
};

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

LazyLord.readSelection = function (outDir) {
  if (app.documents.length === 0) throw new Error("No Illustrator document is open.");
  var doc = app.activeDocument;
  var sel = app.selection;
  if (!sel || sel.length === 0) throw new Error("Nothing selected in Illustrator.");

  var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
  var rect = ab.artboardRect; // [left, top, right, bottom]

  var ctx = {
    doc: doc,
    left: rect[0],
    top: rect[1],
    outDir: outDir,
    imageIndex: 0,
    idCounter: 1,
    clipCounter: 1,
    // Every mask record made so far, and every clipping container resolved, so
    // one reached twice keeps one id and reports its problems once.
    maskRecs: [],
    groupRes: [],
    // Groups and layers around the selection whose lost opacity was reported.
    faded: [],
    minX: 0,
    minY: 0
  };

  // 1) The selection as a tree of what we can actually convert: leaves, and
  //    the groups holding them (see _air_collect). The selection comes front
  //    to back, so it is walked from the end to stack bottom to top. An item
  //    picked out of a clipping group (Direct Selection, isolation mode)
  //    starts with the mask its parents put on it.
  var nodes = [];
  var strays = [];
  sel = LazyLord._air_selection(sel);
  for (var i = sel.length - 1; i >= 0; i--) {
    if (LazyLord._air_isMask(sel[i])) { strays.push(sel[i]); continue; }
    var parents = LazyLord._air_parents(sel[i]);
    LazyLord._air_collect(ctx, sel[i], nodes, LazyLord._air_inheritedMask(ctx, parents));
    LazyLord._air_parentFade(ctx, parents);
  }
  var leaves = LazyLord._air_leafNodes(nodes, []);
  if (leaves.length === 0) throw new Error("Nothing in the selection can be transferred.");
  for (var si = 0; si < strays.length; si++) LazyLord._air_strayMask(ctx, strays[si]);

  // 2) Selection bounds, in IR space, before normalising.
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var b = 0; b < leaves.length; b++) {
    var gb = leaves[b].gb;
    if (!gb) continue;
    var x = LazyLord._air_x(ctx, gb[0]);
    var y = LazyLord._air_y(ctx, gb[1]);
    var w = gb[2] - gb[0];
    var h = gb[1] - gb[3];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  if (minX === Infinity) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
  ctx.minX = minX;
  ctx.minY = minY;

  // 3) Convert. Masks are only turned into outlines now, because frame space
  //    needs the selection's top-left.
  var layers = LazyLord._air_layers(ctx, nodes, null);

  // The artboard the bounds are measured from, so a target that has to create
  // a document can size it to match.
  var canvas = { width: rect[2] - rect[0], height: rect[1] - rect[3] };
  try { if (ab.name) canvas.name = String(ab.name); } catch (e2) {}

  return {
    version: "1.0",
    source: "illustrator",
    name: doc.name || "Illustrator",
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    // Bounds are measured from the active artboard's top-left, so a target can
    // drop the artwork exactly where it sat.
    originSpace: "document",
    canvas: canvas,
    sourceKey: LazyLord._air_sourceKey(doc),
    layers: layers,
    // Both walk the whole document, so they are skipped when the sender did
    // not ask for them (the panel says so in the read options).
    guides: LazyLord.readOptions.guides === false ? [] : LazyLord._air_guides(ctx),
    swatches: LazyLord.readOptions.swatches === false ? [] : LazyLord._air_swatches(doc)
  };
};

/**
 * The document's straight ruler guides, in frame space. Illustrator keeps a
 * guide as a path with guides = true; only horizontal and vertical lines are
 * ruler guides.
 */
LazyLord._air_guides = function (ctx) {
  var out = [];
  var paths = null;
  try { paths = ctx.doc.pathItems; } catch (e) {}
  if (!paths || typeof paths.length !== "number") return out;
  for (var i = 0; i < paths.length; i++) {
    try {
      var p = paths[i];
      if (p.guides !== true || p.pathPoints.length !== 2) continue;
      var a = p.pathPoints[0].anchor, b = p.pathPoints[1].anchor;
      if (Math.abs(a[1] - b[1]) < 1e-6) {
        out.push({ orientation: "horizontal", position: LazyLord._air_y(ctx, a[1]) - ctx.minY });
      } else if (Math.abs(a[0] - b[0]) < 1e-6) {
        out.push({ orientation: "vertical", position: LazyLord._air_x(ctx, a[0]) - ctx.minX });
      }
    } catch (eP) {}
  }
  return out;
};

/** The document's flat-colour swatches; [None], [Registration], gradients and patterns are left out. */
LazyLord._air_swatches = function (doc) {
  var out = [];
  var sw = null;
  try { sw = doc.swatches; } catch (e) {}
  if (!sw || typeof sw.length !== "number") return out;
  for (var i = 0; i < sw.length; i++) {
    try {
      var s = sw[i];
      var t = s.color && s.color.typename;
      if (t !== "RGBColor" && t !== "CMYKColor" && t !== "GrayColor" && t !== "SpotColor") continue;
      if (t === "SpotColor" && /registration/i.test(s.name)) continue;
      var p = LazyLord._air_color(s.color, String(s.name), null);
      if (p && p.color) out.push({ name: String(s.name), color: p.color });
    } catch (eS) {}
  }
  return out;
};

/**
 * What tells this document apart from every other one, so a target can match a
 * layer id back to the thing it came from. A saved document is identified by
 * its path; an unsaved one has nothing stable to offer, and matching then falls
 * back to the layer id alone.
 */
LazyLord._air_sourceKey = function (doc) {
  try { if (doc.fullName) return doc.fullName.fsName; } catch (e) {}
  return "";
};

/* -------------------------------------------------------------------------
 * Coordinate helpers
 * ---------------------------------------------------------------------- */

LazyLord._air_x = function (ctx, aiX) { return aiX - ctx.left; };
LazyLord._air_y = function (ctx, aiY) { return ctx.top - aiY; };

/** geometricBounds, guarded — some item types throw on access. */
LazyLord._air_gb = function (item) {
  try { return item.geometricBounds; } catch (e) { return null; }
};

/**
 * An item's box in un-normalised IR space, for anything measured against it
 * (gradient handles). Carries ctx so host points can be converted.
 */
LazyLord._air_box = function (ctx, gb) {
  return {
    ctx: ctx,
    x: LazyLord._air_x(ctx, gb[0]),
    y: LazyLord._air_y(ctx, gb[1]),
    width: gb[2] - gb[0],
    height: gb[1] - gb[3]
  };
};

/** A usable number? Host properties can come back undefined or NaN. */
LazyLord._air_num = function (v) {
  return typeof v === "number" && isFinite(v);
};

/** An item's (or group's, or layer's) own opacity, 0..1. */
LazyLord._air_opacity = function (item) {
  var op = 1;
  try { op = (item.opacity === undefined || item.opacity === null) ? 1 : item.opacity / 100; } catch (e) {}
  return op;
};

/** An item's upright outer box (its geometricBounds) as an IR frame, in frame space. */
LazyLord._air_frame = function (ctx, item, gb) {
  return {
    x: LazyLord._air_x(ctx, gb[0]) - ctx.minX,
    y: LazyLord._air_y(ctx, gb[1]) - ctx.minY,
    width: gb[2] - gb[0],
    height: gb[1] - gb[3],
    rotation: 0,
    opacity: LazyLord._air_opacity(item)
  };
};

/** Stable-ish source id: Illustrator's uuid when available, else a counter. */
LazyLord._air_id = function (ctx, item) {
  try { if (item.uuid) return item.uuid; } catch (e) {}
  return "ai-" + (ctx.idCounter++);
};

LazyLord._air_safe = function (s) {
  return String(s || "item").replace(/[^A-Za-z0-9_-]+/g, "_").substring(0, 40);
};

/* -------------------------------------------------------------------------
 * Orientation — text frames and images keep their turn in item.matrix
 * ---------------------------------------------------------------------- */

LazyLord._air_SKEW = 1e-3; // |cos| of the angle between the item's axes: 0.06 degrees off square
LazyLord._air_WELL = 0.2;  // |cos 2a| below this (within ~6 degrees of 45) cannot be solved for size

/**
 * Does this item's matrix start from Illustrator's vertical flip? A linked
 * raster file is stored top row first, so an upright PlacedItem reads
 * mValueD = -1: undoing that flip (negating mValueB and mValueD) leaves the
 * user's own transform, which reads like any other item's. That is why
 * community scripts negate a PlacedItem's atan2(mValueB, mValueA). EPS art,
 * embedded RasterItems and text are the right way up (mValueD = +1). The
 * scripting reference does not document this; see the report.
 */
LazyLord._air_flipped = function (item, file) {
  if (item.typename !== "PlacedItem") return false;
  var n = "";
  try { n = String((file || item.file).name); } catch (e) {}
  return !/\.(eps|epsf|ps)$/i.test(n);
};

/**
 * How an item is turned, from its matrix: { rotation, sx, sy, across, skewed,
 * mirrored, flip }, or null when the matrix is unreadable or collapsed.
 * Illustrator turns counter-clockwise in its y-up space; the IR's rotation is
 * clockwise in y-down space. Both describe the same turn on screen, so
 * rotation = -atan2(mValueB, mValueA). sx / sy are how much the item's own
 * x and y axes are scaled; `across` is how much its height is scaled at right
 * angles to its x axis (sy, unless it is slanted). For a mirrored item,
 * `flip` names the item's own axis ("x" or "y") that the mirror reverses once
 * `rotation` is taken as its turn.
 */
LazyLord._air_orient = function (item, flipped) {
  var m = LazyLord._air_matrixOf(item);
  if (!m) return null;
  var a = m.a, b = flipped ? -m.b : m.b, c = m.c, d = flipped ? -m.d : m.d;
  var sx = Math.sqrt(a * a + b * b), sy = Math.sqrt(c * c + d * d);
  if (!(sx > 1e-9 && sy > 1e-9)) return null;

  var ccw = Math.atan2(b, a);
  var det = a * d - b * c;
  var mirrored = det < 0;
  var flip = null;
  if (mirrored) {
    // No turn undoes a mirror image. Drop the mirror along whichever axis
    // leaves the item nearest upright. Read from its x axis, the turn leaves
    // its y axis reversed; its y axis gives the other reading, which leaves
    // its x axis reversed.
    var ccwY = Math.atan2(-c, d);
    flip = "y";
    if (Math.abs(ccwY) < Math.abs(ccw)) { ccw = ccwY; flip = "x"; }
  }
  var rot = -ccw * 180 / Math.PI;
  if (rot <= -180) rot += 360;
  if (Math.abs(rot) < 1e-6) rot = 0;

  return {
    rotation: rot,
    sx: sx,
    sy: sy,
    across: Math.abs(det) / sx,
    // The item's own axes are no longer at right angles: a shear.
    skewed: Math.abs(a * c + b * d) > LazyLord._air_SKEW * sx * sy,
    mirrored: mirrored,
    flip: flip
  };
};

/**
 * The unrotated w x h of a box turned by `deg` whose upright outer box is
 * W x H, from W = w|cos| + h|sin| and H = w|sin| + h|cos|. Returns null where
 * that cannot be solved: near 45 degrees the two equations become one (only
 * w + h is known), and outer bounds that no turned box fits give no answer.
 */
LazyLord._air_unturn = function (W, H, deg) {
  var r = deg * Math.PI / 180;
  var c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  var den = c * c - s * s; // cos 2a
  if (Math.abs(den) < LazyLord._air_WELL) return null;
  var w = (W * c - H * s) / den, h = (H * c - W * s) / den;
  var tol = 0.01 * Math.max(W, H) + LazyLord._air_EPS;
  if (w < -tol || h < -tol) return null;
  return [Math.max(w, 0), Math.max(h, 0)];
};

/**
 * An image's unrotated w x h from its boundingBox ("the dimensions of the
 * placed art item regardless of transformations") scaled by the matrix's own
 * axes, or null. The result has to turn back into the outer box W x H. If it
 * has the right proportions but the wrong size (the box is not in points), it
 * is scaled to fit, which works at any angle, 45 degrees included. A box that
 * does not fit at all is left to _air_unturn.
 */
LazyLord._air_imageBox = function (item, W, H, o) {
  var bb = null;
  try { bb = item.boundingBox; } catch (e) {}
  if (!bb || bb.length < 4) return null;
  for (var i = 0; i < 4; i++) {
    if (!LazyLord._air_num(bb[i])) return null;
  }
  var w0 = Math.abs(bb[2] - bb[0]) * o.sx, h0 = Math.abs(bb[1] - bb[3]) * o.sy;
  if (!(w0 > 1e-9 && h0 > 1e-9)) return null;

  var r = o.rotation * Math.PI / 180;
  var c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  var kW = W / (w0 * c + h0 * s), kH = H / (w0 * s + h0 * c);
  if (!(kW > 0 && kH > 0) || Math.abs(kW - kH) > 0.01 * Math.max(kW, kH)) return null;
  var k = (kW + kH) / 2;
  return [w0 * k, h0 * k];
};

/**
 * Point text's unrotated w x h where _air_unturn cannot tell (near 45
 * degrees), or null. Left-aligned point text starts at its anchor, so that
 * anchor, turned back about the box centre `ctr`, lies on the upright box's
 * left edge (its right edge when right-aligned): that gives w, and the outer
 * box gives w + h. `edge` is { anchor: [x, y] in frame space, side: -1 for the
 * left edge, +1 for the right, hMin, hMax: the heights the text's lines can
 * plausibly take }.
 *
 * The outer box cannot confirm the answer here: near 45 degrees both of its
 * equations reduce to w + h, which holds for any w, so an anchor that is not
 * on the edge would pass them. What is checked instead is independent of it:
 * the first baseline must lie within the box, and the height must fit the
 * text's lines. Those only catch an anchor well off the edge, and the size
 * still rests on the anchor sitting exactly on it, so the caller reports it
 * as approximated.
 */
LazyLord._air_edgeBox = function (W, H, deg, ctr, edge) {
  var p = LazyLord.rotatePoint(edge.anchor, ctr, -deg);
  var w = 2 * edge.side * (p[0] - ctr[0]);
  var r = deg * Math.PI / 180;
  var c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  var h = (W + H) / (c + s) - w; // W + H = (w + h)(|cos| + |sin|)
  var tol = 0.01 * Math.max(W, H) + LazyLord._air_EPS;
  if (!(w > tol && h > tol)) return null;
  // Only a coarse check this close to 45 degrees (see above), but it still
  // refuses outer bounds that no turned box fits.
  if (Math.abs(w * c + h * s - W) > tol || Math.abs(w * s + h * c - H) > tol) return null;
  if (!(Math.abs(p[1] - ctr[1]) <= h / 2 + tol)) return null; // the baseline falls outside the box
  if (!(h >= edge.hMin && h <= edge.hMax)) return null;
  return [w, h];
};

// The height point text's lines can take, as a multiple of what they need:
// (lines - 1) line pitches plus one font size. Only a sanity bound, since the
// font's ascent and descent are unknown; it catches an anchor well off the edge.
LazyLord._air_LINES_LO = 0.5;
LazyLord._air_LINES_HI = 2;

/**
 * The { hMin, hMax } heights a point text of `lines` lines at font size `size`
 * and line pitch `pitch` can plausibly have, for _air_edgeBox.
 */
LazyLord._air_lineSpan = function (size, pitch, lines) {
  var need = (lines - 1) * pitch + size;
  return { hMin: LazyLord._air_LINES_LO * need, hMax: LazyLord._air_LINES_HI * need };
};

/** How many lines a text's contents run to: paragraphs and forced line breaks. */
LazyLord._air_lineCount = function (s) {
  var m = String(s || "").match(/\r\n|[\r\n]/g);
  return 1 + (m ? m.length : 0);
};

/**
 * The IR frame of a text frame or image that may be turned. Upright, it is
 * _air_frame's box. Turned, it is the unrotated box centred on the outer
 * box's centre, carrying the rotation. The size comes from the image's own
 * box (`useBox`) when that fits, else it is solved from the outer box and the
 * angle, else (point text, `edge`) from where its anchor sits, which is
 * reported, else the outer box itself is used and that is reported. `flipped`
 * is _air_flipped's answer; `edge` is what _air_edgeBox needs, or null.
 */
LazyLord._air_turned = function (ctx, item, gb, name, flipped, useBox, edge) {
  var frame = LazyLord._air_frame(ctx, item, gb);
  var o = LazyLord._air_orient(item, flipped);
  if (!o) {
    LazyLord.warn(name, "The object's rotation could not be read; it is carried upright at the size of its " +
      "outer bounds", "approximated");
    return frame;
  }
  if (o.skewed) LazyLord.warn(name, "The object is slanted (sheared); the slant is not carried", "approximated");
  if (o.mirrored) LazyLord.warn(name, "The object is mirrored; it is carried unmirrored", "approximated");
  if (o.rotation === 0) return frame;

  var W = frame.width, H = frame.height;
  var cx = frame.x + W / 2, cy = frame.y + H / 2;
  var box = useBox ? LazyLord._air_imageBox(item, W, H, o) : null;
  if (!box) box = LazyLord._air_unturn(W, H, o.rotation);
  if (!box && edge) {
    box = LazyLord._air_edgeBox(W, H, o.rotation, [cx, cy], edge);
    if (box) {
      LazyLord.warn(name, "At this angle the rotated text's own size cannot be measured from its outer bounds; " +
        "it was worked out from where its first line starts, so its box may be slightly off (its angle and " +
        "position are exact)", "approximated");
    }
  }
  if (!box) {
    box = [W, H];
    LazyLord.warn(name, "The rotated object's own size cannot be worked out at this angle; its box is taken " +
      "from its outer bounds, so it comes out too large (its angle and centre are exact)", "approximated");
  }
  frame.x = cx - box[0] / 2;
  frame.y = cy - box[1] / 2;
  frame.width = box[0];
  frame.height = box[1];
  frame.rotation = o.rotation;
  return frame;
};

/* -------------------------------------------------------------------------
 * Selection walk
 * ---------------------------------------------------------------------- */

/**
 * The selection as the objects to send, still front to back. A path picked
 * out of a compound path (Direct or Group Selection hands back the member
 * PathItem) stands for its compound path. On its own it would lose what the
 * compound path owns: its fill, stroke and opacity, the holes its parts cut in
 * each other, and, since the walk up to the groups and layers around it would
 * stop at the compound path, their clipping masks and faded opacity as well.
 * A member of a compound clipping path becomes that mask, so it is handled as
 * a selected mask rather than as artwork. Several parts of one compound path
 * come back as that path once, where its frontmost part was.
 */
LazyLord._air_selection = function (sel) {
  var out = [];
  var parts = []; // { cp, count } per compound path reached through its parts
  for (var i = 0; i < sel.length; i++) {
    var cp = LazyLord._air_compoundOf(sel[i]);
    if (!cp) { out.push(sel[i]); continue; }
    var rec = null;
    for (var k = 0; k < parts.length && !rec; k++) {
      if (LazyLord._air_same(parts[k].cp, cp)) rec = parts[k];
    }
    if (rec) { rec.count++; continue; }
    parts.push({ cp: cp, count: 1 });
    out.push(cp);
  }

  // Sending more than was selected is reported, so the extra parts are no
  // surprise. A compound mask sends nothing either way.
  for (var j = 0; j < parts.length; j++) {
    var c = parts[j].cp;
    var total = 0;
    try { total = c.pathItems.length; } catch (e) {}
    if (parts[j].count < total && !LazyLord._air_isMask(c)) {
      LazyLord.warn(c.name || "Compound path", "Only part of this compound path was selected; the whole compound " +
        "path is sent, because its parts share one fill, stroke and opacity and cut holes in each other",
        "approximated");
    }
  }
  return out;
};

/** The compound path an item is one of the parts of, or null. */
LazyLord._air_compoundOf = function (item) {
  try {
    var p = item.parent;
    if (p && p.typename === "CompoundPathItem") return p;
  } catch (e) {}
  return null;
};

/**
 * Collect what can be converted under `item` into `out`, bottom to top, as
 * nodes: a leaf is { item, mask, gb }, a group is { group, kids } with its
 * kids collected the same way. `mask` is the innermost clipping-mask record
 * in force (or null); it is kept on each leaf and turned into a frame-space
 * clip once bounds are known. A group left with nothing to convert (hidden
 * items, or only its mask) is left out: it would draw nothing.
 */
LazyLord._air_collect = function (ctx, item, out, mask) {
  if (!item || !item.typename) return;
  try { if (item.hidden === true) return; } catch (e) {}
  try { if (item.guides === true) return; } catch (e2) {}

  var t = item.typename;

  if (t === "GroupItem") {
    var kids = item.pageItems;
    var inner = LazyLord._air_groupMask(ctx, item, kids, mask);
    var node = { group: item, kids: [] };
    // pageItems runs front to back; the IR stacks bottom to top.
    for (var i = kids.length - 1; i >= 0; i--) {
      // The mask itself must not become a visible layer.
      if (i === inner.skip || LazyLord._air_isMask(kids[i])) continue;
      LazyLord._air_collect(ctx, kids[i], node.kids, inner.mask);
    }
    if (node.kids.length) out.push(node);
    return;
  }

  // A clipping path is a mask, never artwork. One selected by itself is
  // reported by readSelection (_air_strayMask) and never reaches here.
  if (LazyLord._air_isMask(item)) return;

  var gb = LazyLord._air_gb(item);
  if (!gb) return; // nothing we can place
  out.push({ item: item, mask: mask || null, gb: gb });
};

/** The leaf nodes of a collected tree, in stacking order, appended to `out`. */
LazyLord._air_leafNodes = function (nodes, out) {
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].group) LazyLord._air_leafNodes(nodes[i].kids, out);
    else out.push(nodes[i]);
  }
  return out;
};

/**
 * Convert collected nodes (bottom to top) into IR layers. `boxes`, when
 * given, receives what each returned layer covers in frame space, for the
 * group around them: a leaf's upright outer box, a group's own frame.
 */
LazyLord._air_layers = function (ctx, nodes, boxes) {
  var layers = [];
  for (var k = 0; k < nodes.length; k++) {
    var n = nodes[k];
    var layer = n.group ? LazyLord._air_group(ctx, n) : LazyLord._air_leaf(ctx, n);
    if (!layer) continue;
    layers.push(layer);
    if (boxes) boxes.push(n.group ? layer.frame : LazyLord._air_frame(ctx, n.item, n.gb));
  }
  return layers;
};

/** One leaf node as an IR layer carrying its clip, or null (reported) when it cannot be converted. */
LazyLord._air_leaf = function (ctx, n) {
  var layer = null;
  try {
    layer = LazyLord._air_item(ctx, n.item);
  } catch (e) {
    LazyLord.warn(n.item.name || n.item.typename, e.message, "skipped");
  }
  if (!layer) return null;
  var bm = null;
  try {
    bm = LazyLord.blendFromHost(n.item.blendingMode, typeof BlendModes !== "undefined" ? BlendModes : null,
      LazyLord._ai_BLEND || {}, n.item.name || n.item.typename);
  } catch (eB) {}
  if (bm) layer.blendMode = bm;
  var clip = LazyLord._air_clipFor(ctx, n.mask);
  // Every layer gets its own copy: targets shift clip vertices in place.
  if (clip) layer.clip = LazyLord._air_copyClip(clip);
  return layer;
};

/**
 * A group node as an IR group, or null when none of its contents could be
 * converted (each of those was reported). Its frame is the union of what its
 * contents cover, never rotated, and carries the group's own opacity; its
 * children keep their frames in frame space. A clipping group's mask stays on
 * the leaves inside it, as their clip.
 */
LazyLord._air_group = function (ctx, n) {
  var boxes = [];
  var kids = LazyLord._air_layers(ctx, n.kids, boxes);
  if (!kids.length) return null;

  var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (var i = 0; i < boxes.length; i++) {
    var f = boxes[i];
    if (f.x < l) l = f.x;
    if (f.y < t) t = f.y;
    if (f.x + f.width > r) r = f.x + f.width;
    if (f.y + f.height > b) b = f.y + f.height;
  }
  var g = n.group;
  return {
    id: LazyLord._air_id(ctx, g),
    name: g.name || "Group",
    type: "group",
    frame: { x: l, y: t, width: r - l, height: b - t, rotation: 0, opacity: LazyLord._air_opacity(g) },
    children: kids
  };
};

/* -------------------------------------------------------------------------
 * Clipping masks
 * ---------------------------------------------------------------------- */

/** A clipping path, or a compound path acting as one. */
LazyLord._air_isMask = function (item) {
  try {
    if (item.typename === "PathItem") return item.clipping === true;
    if (item.typename === "CompoundPathItem") {
      return item.pathItems.length > 0 && item.pathItems[0].clipping === true;
    }
  } catch (e) {}
  return false;
};

/** The same host object? Wrappers may differ, so fall back on the uuid. */
LazyLord._air_same = function (a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    var u = a.uuid;
    return !!u && u === b.uuid;
  } catch (e) {
    return false;
  }
};

/** A clipping container resolved before with the same outer mask, or null. */
LazyLord._air_cachedRes = function (ctx, container, outer) {
  for (var i = 0; i < ctx.groupRes.length; i++) {
    var hit = ctx.groupRes[i];
    if (hit.outer === outer && LazyLord._air_same(hit.container, container)) return hit.res;
  }
  return null;
};

/**
 * The mask a group's contents are clipped by: the group's own when it is a
 * clipping group (the innermost mask wins), otherwise the one inherited from
 * outside. `skip` is the index of a mask child that is not a path, which must
 * not be emitted as artwork either. Clipping groups are resolved once: direct-
 * selected siblings reach the same group once each.
 */
LazyLord._air_groupMask = function (ctx, group, kids, outer) {
  var clipped = false;
  try { clipped = group.clipped === true; } catch (e) {}
  if (!clipped) return { mask: outer, skip: -1 };

  var res = LazyLord._air_cachedRes(ctx, group, outer);
  if (res) return res;
  res = LazyLord._air_clipGroup(ctx, group, kids, outer);
  ctx.groupRes.push({ container: group, outer: outer, res: res });
  return res;
};

/** _air_groupMask for a group already known to be a clipping group. */
LazyLord._air_clipGroup = function (ctx, group, kids, outer) {
  var res = { mask: outer, skip: -1 };
  var gname = group.name || "Clipping group";
  var found = -1;
  for (var i = 0; i < kids.length; i++) {
    if (LazyLord._air_isMask(kids[i])) { found = i; break; }
  }

  if (found < 0) {
    // Illustrator keeps the clipping object on top. With no clipping path in
    // the group it is text, whose outline scripting cannot read.
    var fate = outer ? "clipped by the outer mask only" : "unclipped";
    var top = null;
    try { top = kids.length > 0 ? kids[0] : null; } catch (e2) {}
    if (top && top.typename === "TextFrame") {
      res.skip = 0;
      LazyLord.warn(gname, "Text used as a clipping mask cannot be carried; the contents transfer " +
        fate + " and the mask text is left out", "approximated");
    } else {
      LazyLord.warn(gname, "The clipping mask could not be read; the contents transfer " + fate, "approximated");
    }
    return res;
  }

  var rec = LazyLord._air_maskRecord(ctx, kids[found]);
  if (outer) LazyLord._air_nestWarn(gname, rec, outer);
  res.mask = rec;
  return res;
};

LazyLord._air_nestWarn = function (who, inner, outer) {
  LazyLord.warn(who, "Nested clipping masks: only the innermost mask (" + inner.name +
    ") is kept; the outer mask (" + outer.name + ") is dropped for these contents", "approximated");
};

/**
 * A layer clipping mask: Illustrator makes the layer's topmost object the
 * clipping path, and it clips everything in the layer and its sublayers.
 * Scripting has no flag for it on the Layer, so the top page item is checked.
 */
LazyLord._air_layerMask = function (ctx, layer, outer) {
  var top = null;
  try { top = layer.pageItems.length > 0 ? layer.pageItems[0] : null; } catch (e) {}
  if (!top || !LazyLord._air_isMask(top)) return outer;

  var res = LazyLord._air_cachedRes(ctx, layer, outer);
  if (res) return res.mask;
  var rec = LazyLord._air_maskRecord(ctx, top);
  if (outer) LazyLord._air_nestWarn(layer.name || "Layer", rec, outer);
  ctx.groupRes.push({ container: layer, outer: outer, res: { mask: rec, skip: -1 } });
  return rec;
};

/**
 * The groups and layers around a selected item, innermost first, up to the
 * document. A part of a compound path never reaches here: _air_selection
 * hands on its compound path instead, whose parents are groups and layers.
 */
LazyLord._air_parents = function (item) {
  var chain = [];
  var p = null;
  try { p = item.parent; } catch (e) {}
  for (var guard = 0; p && guard < 100; guard++) {
    var t = null;
    try { t = p.typename; } catch (e2) {}
    if (t !== "GroupItem" && t !== "Layer") break;
    chain.push(p);
    try { p = p.parent; } catch (e3) { p = null; }
  }
  return chain;
};

/**
 * The mask an item's parents (`chain`, from _air_parents) put on it, for an
 * item selected on its own out of a clipping group or a clipped layer. The
 * containers are resolved outermost first, so nesting is handled as in
 * _air_collect.
 */
LazyLord._air_inheritedMask = function (ctx, chain) {
  var mask = null;
  for (var i = chain.length - 1; i >= 0; i--) {
    var c = chain[i];
    try {
      if (c.typename === "Layer") mask = LazyLord._air_layerMask(ctx, c, mask);
      else mask = LazyLord._air_groupMask(ctx, c, c.pageItems, mask).mask;
    } catch (e4) {
      LazyLord.warn(c.name || c.typename, "A group around the selection could not be read; any clipping mask it " +
        "puts on the selected objects is not applied", "approximated");
    }
  }
  return mask;
};

/**
 * Opacity on a group or layer around the selection (`chain`, from
 * _air_parents). Only selected groups are sent, carrying their own opacity;
 * these containers are not, so what they fade is lost. It is reported, once
 * per container, rather than multiplied into each selected object, which
 * would darken the places where those objects overlap.
 */
LazyLord._air_parentFade = function (ctx, chain) {
  for (var i = 0; i < chain.length; i++) {
    var c = chain[i];
    var op = LazyLord._air_opacity(c);
    if (!(op < 1)) continue;
    var seen = false;
    for (var j = 0; j < ctx.faded.length && !seen; j++) seen = LazyLord._air_same(ctx.faded[j], c);
    if (seen) continue;
    ctx.faded.push(c);

    var pc = LazyLord.pct(op) + "%";
    if (c.typename === "Layer") {
      LazyLord.warn(c.name || "Layer", "The layer's " + pc + " opacity is not carried; the objects selected on it " +
        "transfer at their own opacity", "approximated");
    } else {
      LazyLord.warn(c.name || "Group", "The group's " + pc + " opacity is not carried, because the group itself " +
        "was not selected; the objects selected inside it transfer at their own opacity (select the whole group " +
        "to keep it)", "approximated");
    }
  }
};

/** Is this mask the clipping path of the group or layer it sits in? */
LazyLord._air_masksParent = function (m) {
  try {
    var p = m.parent;
    if (!p) return false;
    if (p.typename === "GroupItem") return p.clipped === true;
    if (p.typename === "Layer") return p.pageItems.length > 0 && LazyLord._air_same(p.pageItems[0], m);
  } catch (e) {}
  return false;
};

/**
 * A clipping path in the selection itself (Direct Selection, or Select All on
 * a clipped layer). When it is its own group's or layer's mask, the selected
 * contents of that container already carry it as their clip, so only a paint
 * of its own can be lost. Otherwise nothing it clips can be found.
 */
LazyLord._air_strayMask = function (ctx, m) {
  if (LazyLord._air_masksParent(m)) {
    LazyLord._air_maskRecord(ctx, m); // reports a painted mask, once
    return;
  }
  LazyLord.warn(m.name || "Clipping path", "This clipping path does not belong to a clipping group or clipped " +
    "layer that LazyLord can find, so it is left out and clips nothing", "skipped");
};

/** Remember a mask item; its outline is read later, once, by _air_clipFor. */
LazyLord._air_maskRecord = function (ctx, m) {
  for (var i = 0; i < ctx.maskRecs.length; i++) {
    if (LazyLord._air_same(ctx.maskRecs[i].item, m)) return ctx.maskRecs[i];
  }
  var compound = m.typename === "CompoundPathItem";
  var id = null;
  try { if (m.uuid) id = String(m.uuid); } catch (e) {}
  if (!id) id = "clip-" + (ctx.clipCounter++);
  var name = m.name || (compound ? "Compound clipping path" : "Clipping path");

  // A mask can be given a visible fill or stroke after it is made. That paint
  // is not part of the clip region, and nothing carries it.
  var painted = false;
  try {
    var style = compound ? m.pathItems[0] : m;
    painted = style.filled === true || style.stroked === true;
  } catch (e2) {}
  if (painted) {
    LazyLord.warn(name, "The clipping path's own fill and stroke are not transferred", "skipped");
  }

  var rec = { item: m, id: id, name: name, compound: compound, clip: null, failed: false };
  ctx.maskRecs.push(rec);
  return rec;
};

/** The frame-space clip for a mask record, built once and shared by id. */
LazyLord._air_clipFor = function (ctx, rec) {
  if (!rec || rec.failed) return null;
  if (rec.clip) return rec.clip;
  try {
    rec.clip = LazyLord._air_clipPath(ctx, rec);
  } catch (e) {
    rec.clip = null;
  }
  if (!rec.clip) {
    rec.failed = true;
    LazyLord.warn(rec.name, "The clipping mask's outline could not be read; the contents transfer unclipped",
      "approximated");
  }
  return rec.clip;
};

/**
 * A mask outline in FRAME space — the space of frame.x / frame.y, i.e. IR
 * space with the selection's top-left as the origin — not layer-local space.
 */
LazyLord._air_clipPath = function (ctx, rec) {
  var m = rec.item;
  var paths = [];
  if (rec.compound) {
    for (var i = 0; i < m.pathItems.length; i++) paths.push(m.pathItems[i]);
  } else {
    paths.push(m);
  }

  var subs = [];
  for (var j = 0; j < paths.length; j++) {
    var sp = LazyLord._air_subpath(ctx, paths[j], ctx.minX, ctx.minY);
    if (sp.vertices.length === 0) continue;
    // A clip region is always closed, even when the mask path was left open.
    sp.closed = true;
    subs.push(sp);
  }
  if (subs.length === 0) return null;

  return {
    id: rec.id,
    name: rec.name,
    subpaths: subs,
    // Compound paths are how Illustrator expresses holes.
    windingRule: rec.compound ? "evenodd" : "nonzero"
  };
};

/** Deep copy of a clip, so no two layers share (and double-shift) one object. */
LazyLord._air_copyClip = function (clip) {
  var subs = [];
  for (var i = 0; i < clip.subpaths.length; i++) {
    var sp = clip.subpaths[i];
    subs.push({
      closed: sp.closed,
      vertices: LazyLord._air_copyPairs(sp.vertices),
      inTangents: LazyLord._air_copyPairs(sp.inTangents),
      outTangents: LazyLord._air_copyPairs(sp.outTangents)
    });
  }
  var out = { id: clip.id, subpaths: subs, windingRule: clip.windingRule };
  if (clip.name) out.name = clip.name;
  return out;
};

LazyLord._air_copyPairs = function (list) {
  var out = [];
  for (var i = 0; i < list.length; i++) out.push([list[i][0], list[i][1]]);
  return out;
};

/* -------------------------------------------------------------------------
 * Item dispatch — the §8 fallback ladder
 * ---------------------------------------------------------------------- */

LazyLord._air_item = function (ctx, item) {
  var t = item.typename;
  if (t === "PathItem") return LazyLord._air_path(ctx, item);
  if (t === "CompoundPathItem") return LazyLord._air_compound(ctx, item);
  if (t === "TextFrame") return LazyLord._air_text(ctx, item);
  if (t === "PlacedItem") return LazyLord._air_placed(ctx, item);
  if (t === "RasterItem") return LazyLord._air_rasterItem(ctx, item);
  // MeshItem, SymbolItem, PluginItem (live effects, blends), GraphItem, …
  return LazyLord._air_raster(ctx, item, t + " has no native equivalent; sent as a PNG");
};

/* -------------------------------------------------------------------------
 * Colour
 * ---------------------------------------------------------------------- */

/** CMYK -> linear 0..1 RGB, via Illustrator's own conversion when available. */
LazyLord._air_cmyk = function (col) {
  try {
    var out = app.convertSampleColor(
      ImageColorSpace.CMYK,
      [col.cyan, col.magenta, col.yellow, col.black],
      ImageColorSpace.RGB,
      ColorConvertPurpose.defaultpurpose
    );
    return [out[0] / 255, out[1] / 255, out[2] / 255];
  } catch (e) {
    var c = col.cyan / 100, m = col.magenta / 100, y = col.yellow / 100, k = col.black / 100;
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  }
};

/**
 * Illustrator colour -> IR Paint, or null when there is nothing to paint.
 * `box` (from _air_box) is the owning item's box, which gradient handles are
 * normalised against. The item's opacity is deliberately NOT folded into the
 * paint: it travels once, as frame.opacity, and folding it in as well made
 * targets apply it twice.
 */
LazyLord._air_color = function (col, label, box) {
  if (!col || !col.typename) return null;
  var t = col.typename;

  if (t === "RGBColor") {
    return { type: "solid", color: { r: col.red / 255, g: col.green / 255, b: col.blue / 255, a: 1 } };
  }
  if (t === "GrayColor") {
    var g = 1 - (col.gray / 100); // Illustrator gray is ink percentage
    return { type: "solid", color: { r: g, g: g, b: g, a: 1 } };
  }
  if (t === "CMYKColor") {
    var rgb = LazyLord._air_cmyk(col);
    return { type: "solid", color: { r: rgb[0], g: rgb[1], b: rgb[2], a: 1 } };
  }
  if (t === "SpotColor") {
    var base = null;
    try { base = LazyLord._air_color(col.spot.color, label, box); } catch (e) { return null; }
    // A tint is the spot colour thinned towards paper white.
    var tint = LazyLord._air_num(col.tint) ? Math.max(0, Math.min(100, col.tint)) / 100 : 1;
    if (base && base.type === "solid" && tint < 1) {
      var bc = base.color;
      base.color = { r: 1 - (1 - bc.r) * tint, g: 1 - (1 - bc.g) * tint, b: 1 - (1 - bc.b) * tint, a: bc.a };
    }
    return base;
  }
  if (t === "GradientColor") {
    return LazyLord._air_gradient(col, label, box);
  }
  if (t === "PatternColor") {
    LazyLord.warn(label || "Object", "Pattern fills are not supported; the object was left unfilled", "skipped");
    return null;
  }
  return null; // NoColor
};

LazyLord._air_gradient = function (gc, label, box) {
  var who = label || "Object";
  var g = null, n = 0;
  try { g = gc.gradient; n = g.gradientStops.length; } catch (e) { n = 0; }

  // Each stop is read on its own, so one unreadable stop cannot silently take
  // the ones after it along.
  var stops = [];
  var midpoints = false, lost = 0, black = 0;
  for (var i = 0; i < n; i++) {
    try {
      var s = g.gradientStops[i];
      if (!LazyLord._air_num(s.rampPoint)) throw new Error("the stop has no position");
      var p = LazyLord._air_color(s.color, label);
      var c = (p && p.color) ? p.color : null;
      var sa = (s.opacity === undefined || s.opacity === null) ? 1 : s.opacity / 100;
      var mid = s.midPoint;
      stops.push({
        position: s.rampPoint / 100,
        color: c ? { r: c.r, g: c.g, b: c.b, a: sa } : { r: 0, g: 0, b: 0, a: sa }
      });
      if (!c) black++;
      if (LazyLord._air_num(mid) && Math.abs(mid - 50) > 0.5) midpoints = true;
    } catch (e1) {
      lost++;
    }
  }
  if (stops.length === 0) {
    LazyLord.warn(who, "Gradient colours could not be read; the object was left unfilled", "skipped");
    return null;
  }
  if (lost > 0) {
    LazyLord.warn(who, "Some gradient colours could not be read and were left out", "approximated");
  }
  if (black > 0) {
    LazyLord.warn(who, "Some gradient colours could not be read and are carried as black", "approximated");
  }
  if (midpoints) {
    LazyLord.warn(who, "Gradient midpoints are not carried; each colour blend is evened out", "approximated");
  }

  var isRadial = false;
  try { isRadial = (g.type === GradientType.RADIAL); } catch (e2) {}

  var m = LazyLord._air_gradMatrix(gc);
  var ends = LazyLord._air_gradVector(gc, who, box, m || LazyLord._air_IDENTITY, isRadial);
  if (!ends) {
    LazyLord.warn(who, "The gradient's position could not be read; it is centred across the object", "approximated");
    ends = LazyLord._air_gradGuess(gc, isRadial, m || LazyLord._air_IDENTITY);
  } else if (!m) {
    LazyLord.warn(who, "The gradient's transform could not be read; if the object was moved, scaled or rotated " +
      "after the gradient was applied, the gradient may sit off", "approximated");
  }
  if (isRadial) LazyLord._air_radialLimits(gc, who, m);

  return {
    type: isRadial ? "radial-gradient" : "linear-gradient",
    stops: stops,
    from: ends.from,
    to: ends.to
  };
};

LazyLord._air_IDENTITY = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/**
 * GradientColor.matrix as { a, b, c, d, tx, ty }, or null when unreadable.
 * Illustrator keeps origin / angle / length as they were when the gradient was
 * applied; every later move, scale, rotation or shear of the object is
 * concatenated into this matrix instead. The scripting Matrix names its
 * coefficients mValueA .. mValueTY.
 */
LazyLord._air_gradMatrix = function (gc) {
  return LazyLord._air_matrixOf(gc);
};

/**
 * Any object's `matrix` (a GradientColor's, or a text frame's or image's own)
 * as { a, b, c, d, tx, ty }, or null when it is missing or not all numbers.
 */
LazyLord._air_matrixOf = function (obj) {
  try {
    var m = obj.matrix;
    if (!m) return null;
    var v = [m.mValueA, m.mValueB, m.mValueC, m.mValueD, m.mValueTX, m.mValueTY];
    for (var i = 0; i < 6; i++) {
      if (!LazyLord._air_num(v[i])) return null;
    }
    return { a: v[0], b: v[1], c: v[2], d: v[3], tx: v[4], ty: v[5] };
  } catch (e) {
    return null;
  }
};

/** A point through a matrix, in Illustrator coordinates: x' = a*x + c*y + tx, y' = b*x + d*y + ty. */
LazyLord._air_mapPt = function (m, x, y) {
  return [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty];
};

/**
 * For a linear gradient under matrix m: the Illustrator-space step from the
 * stop 0 point to the stop 1 point, or null when the matrix is flat.
 *
 * Mapping the far end point is not enough once the matrix stops keeping right
 * angles (a non-uniform scale or a shear): the colour bands stay parallel lines,
 * but they are no longer perpendicular to the mapped vector. So the step is
 * taken perpendicular to the transformed bands, as long as the distance between
 * the stop 0 and stop 1 bands. That reproduces the gradient exactly with the
 * IR's plain from / to line. `ux, uy` is the unit direction of the angle.
 */
LazyLord._air_linearStep = function (m, ux, uy, len) {
  var det = m.a * m.d - m.b * m.c;
  if (!(Math.abs(det) > 1e-12) || !(len > 0)) return null;
  // The gradient's rate of change across the page: the inverse-transpose of
  // the matrix applied to the direction, divided by the length.
  var gx = (m.d * ux - m.b * uy) / (det * len);
  var gy = (m.a * uy - m.c * ux) / (det * len);
  var g2 = gx * gx + gy * gy;
  if (!(g2 > 0)) return null;
  return [gx / g2, gy / g2];
};

/**
 * The gradient's real vector, normalised to the owning item's box, or null
 * when it cannot be read. Illustrator gives the origin in document coordinates
 * (y-up) and the angle counter-clockwise in degrees, both before the gradient
 * matrix `m`. Linear: stop 0 sits at the origin and stop 1 `length` along the
 * angle. Radial: the origin is the centre and `length` the radius. Both ends
 * are carried through the matrix and converted to IR space before normalising,
 * so the y-flip turns the direction around correctly.
 */
LazyLord._air_gradVector = function (gc, who, box, m, isRadial) {
  if (!box) return null;
  var o, ang, len;
  try { o = gc.origin; ang = gc.angle; len = gc.length; } catch (e) { return null; }
  if (!o || !LazyLord._air_num(o[0]) || !LazyLord._air_num(o[1])) return null;
  if (!LazyLord._air_num(len) || len <= 0) return null;
  if (!LazyLord._air_num(ang)) ang = 0;

  var ctx = box.ctx;
  var r = ang * Math.PI / 180;
  var ux = Math.cos(r), uy = Math.sin(r);
  var s = LazyLord._air_mapPt(m, o[0], o[1]);
  var e;
  if (isRadial) {
    // A point on the circle; under a stretching matrix the circle is really
    // an ellipse, which _air_radialLimits reports.
    e = LazyLord._air_mapPt(m, o[0] + len * ux, o[1] + len * uy);
  } else {
    var step = LazyLord._air_linearStep(m, ux, uy, len);
    if (!step) return null;
    e = [s[0] + step[0], s[1] + step[1]];
  }
  var sx = LazyLord._air_x(ctx, s[0]);
  var sy = LazyLord._air_y(ctx, s[1]);
  var ex = LazyLord._air_x(ctx, e[0]);
  var ey = LazyLord._air_y(ctx, e[1]);

  // A box with no width (or height) cannot hold any of the vector along it.
  var flatW = Math.abs(box.width) < 1e-9, flatH = Math.abs(box.height) < 1e-9;
  if ((flatW && Math.abs(ex - sx) > 1e-6) || (flatH && Math.abs(ey - sy) > 1e-6)) {
    LazyLord.warn(who, "The object has no width or height, so its gradient direction is approximated",
      "approximated");
  }

  return {
    from: { x: LazyLord._air_unit(sx, box.x, box.width), y: LazyLord._air_unit(sy, box.y, box.height) },
    to: { x: LazyLord._air_unit(ex, box.x, box.width), y: LazyLord._air_unit(ey, box.y, box.height) }
  };
};

/** IR-space coordinate -> fraction of a box span (0.5 when it has no size). */
LazyLord._air_unit = function (v, start, size) {
  return Math.abs(size) < 1e-9 ? 0.5 : (v - start) / size;
};

/**
 * Fallback when the real vector is unreadable: centred on the box, pointing
 * along the gradient angle as the matrix `m` turns it. Illustrator measures
 * counter-clockwise; the IR is y-down, hence the minus.
 */
LazyLord._air_gradGuess = function (gc, isRadial, m) {
  var ang = 0;
  try { ang = (gc.angle || 0) * Math.PI / 180; } catch (e) {}
  var ux = Math.cos(ang), uy = Math.sin(ang);
  var dir = isRadial ? [m.a * ux + m.c * uy, m.b * ux + m.d * uy] : LazyLord._air_linearStep(m, ux, uy, 1);
  var n = dir ? Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1]) : 0;
  if (n > 1e-12) { ux = dir[0] / n; uy = dir[1] / n; }
  var dx = ux * 0.5;
  var dy = -uy * 0.5;
  if (isRadial) return { from: { x: 0.5, y: 0.5 }, to: { x: 0.5 + dx, y: 0.5 + dy } };
  return { from: { x: 0.5 - dx, y: 0.5 - dy }, to: { x: 0.5 + dx, y: 0.5 + dy } };
};

/**
 * Report what an Illustrator radial gradient has that the IR's circle lacks.
 * `m` is the gradient matrix from _air_gradMatrix (null when unreadable, which
 * the caller has already reported).
 */
LazyLord._air_radialLimits = function (gc, who, m) {
  var hl = 0;
  try { hl = gc.hiliteLength; } catch (e) {}
  if (LazyLord._air_num(hl) && Math.abs(hl) > 1e-6) {
    LazyLord.warn(who, "The radial gradient's off-centre highlight is not carried; it is centred", "approximated");
  }

  // An aspect ratio other than 100%, or stretching the object after the
  // gradient was applied, turns the circle into an ellipse: that shows up as
  // a non-uniform or skewed gradient matrix.
  if (!m) return;
  var a = m.a, b = m.b, c = m.c, d = m.d;
  var sx = Math.sqrt(a * a + b * b), sy = Math.sqrt(c * c + d * d);
  var big = Math.max(sx, sy);
  if (big > 0 && (Math.abs(sx - sy) > 0.01 * big || Math.abs(a * c + b * d) > 0.01 * big * big)) {
    LazyLord.warn(who, "The radial gradient is stretched into an ellipse; it is carried as a circle",
      "approximated");
  }
};

LazyLord._air_strokeOf = function (item, label, box) {
  var stroked = false;
  try { stroked = item.stroked === true; } catch (e) { return null; }
  if (!stroked) return null;

  var paint = LazyLord._air_color(item.strokeColor, label, box);
  if (!paint) return null;

  var cap = "none", join = "miter", dashes;
  try {
    if (item.strokeCap === StrokeCap.ROUNDENDED) cap = "round";
    else if (item.strokeCap === StrokeCap.PROJECTINGENDED) cap = "square";
  } catch (e2) {}
  try {
    if (item.strokeJoin === StrokeJoin.ROUNDENDED) join = "round";
    else if (item.strokeJoin === StrokeJoin.BEVELENDED) join = "bevel";
  } catch (e3) {}
  try {
    if (item.strokeDashes && item.strokeDashes.length) dashes = [].concat(item.strokeDashes);
  } catch (e4) {}

  var weight = 1;
  try { weight = item.strokeWidth; } catch (e5) {}

  return {
    paint: paint,
    weight: weight,
    cap: cap,
    join: join,
    align: "center", // Illustrator does not expose stroke alignment to scripting
    dashPattern: dashes
  };
};

/* -------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------- */

/**
 * One PathItem -> one IR subpath, expressed in the owning layer's local space.
 * ox/oy are the layer's IR-space top-left (un-normalised).
 */
LazyLord._air_subpath = function (ctx, path, ox, oy) {
  var pts = path.pathPoints;
  var verts = [], ins = [], outs = [];
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    var ax = LazyLord._air_x(ctx, p.anchor[0]) - ox;
    var ay = LazyLord._air_y(ctx, p.anchor[1]) - oy;
    var lx = LazyLord._air_x(ctx, p.leftDirection[0]) - ox;
    var ly = LazyLord._air_y(ctx, p.leftDirection[1]) - oy;
    var rx = LazyLord._air_x(ctx, p.rightDirection[0]) - ox;
    var ry = LazyLord._air_y(ctx, p.rightDirection[1]) - oy;
    verts.push([ax, ay]);
    ins.push([lx - ax, ly - ay]);   // leftDirection = incoming handle
    outs.push([rx - ax, ry - ay]);  // rightDirection = outgoing handle
  }
  var closed = false;
  try { closed = path.closed === true; } catch (e) {}
  return { closed: closed, vertices: verts, inTangents: ins, outTangents: outs };
};

LazyLord._air_path = function (ctx, p) {
  var gb = p.geometricBounds;
  var box = LazyLord._air_box(ctx, gb);
  var name = p.name || "Path";

  var fills = [];
  var filled = false;
  try { filled = p.filled === true; } catch (e) {}
  if (filled) {
    var f = LazyLord._air_color(p.fillColor, name, box);
    if (f) fills.push(f);
  }

  var strokes = [];
  var st = LazyLord._air_strokeOf(p, name, box);
  if (st) strokes.push(st);

  var frame = LazyLord._air_frame(ctx, p, gb);
  var sp = LazyLord._air_subpath(ctx, p, box.x, box.y);
  var layer = {
    id: LazyLord._air_id(ctx, p),
    name: name,
    type: "vector",
    frame: frame,
    subpaths: [sp],
    fills: fills,
    strokes: strokes,
    windingRule: "nonzero"
  };

  var prim = LazyLord._air_primitive(sp, frame.width, frame.height);
  if (prim) layer.primitive = prim;
  return layer;
};

LazyLord._air_compound = function (ctx, cp) {
  var gb = cp.geometricBounds;
  var box = LazyLord._air_box(ctx, gb);
  var name = cp.name || "Compound path";

  var subs = [];
  var style = null;
  for (var i = 0; i < cp.pathItems.length; i++) {
    var p = cp.pathItems[i];
    if (!style) style = p; // a compound path paints from its member paths
    subs.push(LazyLord._air_subpath(ctx, p, box.x, box.y));
  }
  if (subs.length === 0) return null;

  var fills = [];
  var strokes = [];
  if (style) {
    var filled = false;
    try { filled = style.filled === true; } catch (e) {}
    if (filled) {
      var f = LazyLord._air_color(style.fillColor, name, box);
      if (f) fills.push(f);
    }
    var st = LazyLord._air_strokeOf(style, name, box);
    if (st) strokes.push(st);
  }

  return {
    id: LazyLord._air_id(ctx, cp),
    name: name,
    type: "vector",
    frame: LazyLord._air_frame(ctx, cp, gb),
    subpaths: subs,
    fills: fills,
    strokes: strokes,
    // Compound paths are how Illustrator expresses holes.
    windingRule: "evenodd"
  };
};

/* -------------------------------------------------------------------------
 * Primitives — exact axis-aligned rectangles and ellipses
 * ---------------------------------------------------------------------- */

LazyLord._air_KAPPA = 0.5522847498307936; // bezier handle / radius for a quarter circle
LazyLord._air_EPS = 1e-3; // pt: far below anything visible, far above float noise

/**
 * The primitive one closed subpath exactly is, in its local space (a w x h
 * box at 0,0), or null. Starting point and winding are free, since both
 * depend on how the shape was drawn in Illustrator.
 */
LazyLord._air_primitive = function (sp, w, h) {
  if (!sp || sp.closed !== true) return null;
  var E = LazyLord._air_EPS;
  if (!(w > E && h > E)) return null;
  var n = sp.vertices.length;
  if (n === 4) return LazyLord._air_primRect(sp, w, h) || LazyLord._air_primEllipse(sp, w, h);
  if (n === 8) return LazyLord._air_primRoundRect(sp, w, h);
  return null;
};

/** 0 or 1 when v sits on the low or high end of a 0..size span, else -1. */
LazyLord._air_side = function (v, size) {
  var E = LazyLord._air_EPS;
  if (Math.abs(v) <= E) return 0;
  if (Math.abs(v - size) <= E) return 1;
  return -1;
};

/** A retracted handle (the tangent sits on its anchor). */
LazyLord._air_isZero = function (t) {
  var E = LazyLord._air_EPS;
  return !!t && Math.abs(t[0]) <= E && Math.abs(t[1]) <= E;
};

/** A handle within 2% of the expected [x, y], measured against length `len`. */
LazyLord._air_nearHandle = function (t, x, y, len) {
  if (!t) return false;
  var tol = 0.02 * len + LazyLord._air_EPS;
  return Math.abs(t[0] - x) <= tol && Math.abs(t[1] - y) <= tol;
};

/** Four sharp anchors, one on each corner of the box, joined along its edges. */
LazyLord._air_primRect = function (sp, w, h) {
  var E = LazyLord._air_EPS, v = sp.vertices, seen = {};
  for (var i = 0; i < 4; i++) {
    if (!LazyLord._air_isZero(sp.inTangents[i]) || !LazyLord._air_isZero(sp.outTangents[i])) return null;
    var cx = LazyLord._air_side(v[i][0], w), cy = LazyLord._air_side(v[i][1], h);
    if (cx < 0 || cy < 0 || seen[cx + "," + cy]) return null;
    seen[cx + "," + cy] = true;
    // Each edge runs along the box, never across it (that would be a bow-tie).
    var nx = v[(i + 1) % 4];
    if (Math.abs(nx[0] - v[i][0]) > E && Math.abs(nx[1] - v[i][1]) > E) return null;
  }
  return { kind: "rect", x: 0, y: 0, width: w, height: h };
};

/** Which edge midpoint of the box a point sits on: "t", "b", "l", "r", or null. */
LazyLord._air_midRole = function (p, w, h) {
  var E = LazyLord._air_EPS;
  if (Math.abs(p[0] - w / 2) <= E) {
    if (Math.abs(p[1]) <= E) return "t";
    if (Math.abs(p[1] - h) <= E) return "b";
  }
  if (Math.abs(p[1] - h / 2) <= E) {
    if (Math.abs(p[0]) <= E) return "l";
    if (Math.abs(p[0] - w) <= E) return "r";
  }
  return null;
};

/** Four anchors on the edge midpoints, with quarter-circle (kappa) handles. */
LazyLord._air_primEllipse = function (sp, w, h) {
  var K = LazyLord._air_KAPPA, v = sp.vertices, roles = [], seen = {};
  for (var i = 0; i < 4; i++) {
    var role = LazyLord._air_midRole(v[i], w, h);
    if (!role || seen[role]) return null;
    seen[role] = true;
    roles.push(role);
  }
  for (var j = 0; j < 4; j++) {
    var nj = (j + 1) % 4, pj = (j + 3) % 4;
    // At the top and bottom the outline runs horizontally, at the sides vertically.
    var horiz = roles[j] === "t" || roles[j] === "b";
    var nextHoriz = roles[nj] === "t" || roles[nj] === "b";
    if (horiz === nextHoriz) return null; // jumps straight across to the opposite side
    var len = K * (horiz ? w / 2 : h / 2);
    // Each handle points along the tangent, toward the neighbour it curves to.
    var outDir = horiz ? (v[nj][0] > v[j][0] ? 1 : -1) : (v[nj][1] > v[j][1] ? 1 : -1);
    var inDir = horiz ? (v[pj][0] > v[j][0] ? 1 : -1) : (v[pj][1] > v[j][1] ? 1 : -1);
    var ot = horiz ? [outDir * len, 0] : [0, outDir * len];
    var it = horiz ? [inDir * len, 0] : [0, inDir * len];
    if (!LazyLord._air_nearHandle(sp.outTangents[j], ot[0], ot[1], len)) return null;
    if (!LazyLord._air_nearHandle(sp.inTangents[j], it[0], it[1], len)) return null;
  }
  return { kind: "ellipse", x: 0, y: 0, width: w, height: h };
};

/** The box edge a point lies on: "t", "b", "l", "r", or null. */
LazyLord._air_edgeOf = function (p, w, h) {
  var E = LazyLord._air_EPS;
  if (p[0] < -E || p[0] > w + E || p[1] < -E || p[1] > h + E) return null;
  if (Math.abs(p[1]) <= E) return "t";
  if (Math.abs(p[1] - h) <= E) return "b";
  if (Math.abs(p[0]) <= E) return "l";
  if (Math.abs(p[0] - w) <= E) return "r";
  return null;
};

/**
 * Eight anchors: straight sides alternating with quarter-circle corners of
 * one radius. The path may start on either kind of segment, so both phases
 * are tried.
 */
LazyLord._air_primRoundRect = function (sp, w, h) {
  for (var phase = 0; phase < 2; phase++) {
    var r = LazyLord._air_roundRadius(sp, w, h, phase);
    if (r !== null) return { kind: "rect", x: 0, y: 0, width: w, height: h, roundness: r };
  }
  return null;
};

/** The corner radius when the outline is a rounded rectangle in this phase, else null. */
LazyLord._air_roundRadius = function (sp, w, h, phase) {
  var K = LazyLord._air_KAPPA, E = LazyLord._air_EPS;
  var v = sp.vertices, dists = [], corners = {}, count = 0;

  for (var i = 0; i < 8; i++) {
    var j = (i + 1) % 8;
    var a = v[i], b = v[j];
    var ea = LazyLord._air_edgeOf(a, w, h), eb = LazyLord._air_edgeOf(b, w, h);
    if (!ea || !eb) return null;
    var outT = sp.outTangents[i], inT = sp.inTangents[j];

    if ((i + phase) % 2 === 0) {
      // Straight side: no handles, both ends on the same edge.
      if (ea !== eb || !LazyLord._air_isZero(outT) || !LazyLord._air_isZero(inT)) return null;
      continue;
    }

    // Corner: from one edge onto the adjacent one, turning about a box corner.
    var aH = (ea === "t" || ea === "b"), bH = (eb === "t" || eb === "b");
    if (aH === bH) return null;
    var c = aH ? [b[0], a[1]] : [a[0], b[1]];
    var key = (c[0] > w / 2 ? "r" : "l") + (c[1] > h / 2 ? "b" : "t");
    if (corners[key]) return null;
    corners[key] = true;
    count++;

    var da = aH ? Math.abs(c[0] - a[0]) : Math.abs(c[1] - a[1]);
    var db = aH ? Math.abs(c[1] - b[1]) : Math.abs(c[0] - b[0]);
    // Both handles point at the corner, kappa of the way there.
    if (!LazyLord._air_nearHandle(outT, K * (c[0] - a[0]), K * (c[1] - a[1]), K * da)) return null;
    if (!LazyLord._air_nearHandle(inT, K * (c[0] - b[0]), K * (c[1] - b[1]), K * db)) return null;
    dists.push(da, db);
  }
  if (count !== 4) return null;

  var sum = 0;
  for (var k = 0; k < dists.length; k++) sum += dists[k];
  var r = sum / dists.length;
  if (r <= E || r > Math.min(w, h) / 2 + E) return null;
  for (var m = 0; m < dists.length; m++) {
    if (Math.abs(dists[m] - r) > 0.02 * r + E) return null; // one radius for every corner
  }
  return r;
};

/* -------------------------------------------------------------------------
 * Text
 * ---------------------------------------------------------------------- */

/**
 * How much a text frame's matrix scales its type, or 1. Type that was scaled
 * as an object (rotated or slanted type above all) can keep that scale in the
 * frame's matrix while characterAttributes keep the sizes set before it, so
 * the point sizes are scaled by it here to match the box, which geometricBounds
 * measures as drawn (UNVERIFIED in a real Illustrator; see the report). Where
 * the matrix is unscaled, as when Illustrator has folded a scale into the font
 * size, this is 1 and changes nothing. The glyphs' height follows the scale at
 * right angles to the baseline (`across`); a different scale along the
 * baseline stretches them, which the IR cannot, and is reported.
 */
LazyLord._air_textScale = function (name, o) {
  if (!o) return 1;
  var k = o.across, along = o.sx;
  if (Math.abs(along - k) > 0.01 * Math.max(along, k)) {
    LazyLord.warn(name, "The text is stretched more one way than the other; it is carried at its height without " +
      "the stretch, so it comes out " + (along > k ? "narrower" : "wider") + " than it was", "approximated");
  }
  return Math.abs(k - 1) < 1e-6 ? 1 : k;
};

LazyLord._air_text = function (ctx, tf) {
  var gb = tf.geometricBounds;
  var name = tf.name || "Text";
  var attr = tf.textRange.characterAttributes;

  // How the frame is turned, scaled or mirrored (_air_turned reads it again).
  var o = LazyLord._air_orient(tf, false);
  var k = LazyLord._air_textScale(name, o);

  var size = 12;
  try { size = attr.size; } catch (e) {}
  if (LazyLord._air_num(size)) size *= k;

  var family = "Helvetica", style = "Regular";
  try { family = attr.textFont.family; style = attr.textFont.style; } catch (e2) {}

  var paint = null;
  try { paint = LazyLord._air_color(attr.fillColor, name, LazyLord._air_box(ctx, gb)); } catch (e3) {}
  var color = { r: 0, g: 0, b: 0, a: 1 };
  if (paint && paint.color) {
    color = paint.color;
  } else if (paint && paint.stops && paint.stops.length) {
    // IR text has a single colour.
    color = paint.stops[0].color;
    LazyLord.warn(name, "Gradient text colour is carried as its first colour", "approximated");
  }

  var tracking = 0;
  try { tracking = (attr.tracking / 1000) * size; } catch (e4) {}

  var leading = 0;
  try { if (attr.autoLeading !== true) leading = attr.leading; } catch (e5) {}
  if (LazyLord._air_num(leading)) leading *= k;

  var justify = "left";
  try {
    var j = tf.textRange.paragraphAttributes.justification;
    if (j === Justification.CENTER) justify = "center";
    else if (j === Justification.RIGHT) justify = "right";
    else if (j === Justification.FULLJUSTIFY || j === Justification.FULLJUSTIFYLASTLINELEFT) justify = "justified";
  } catch (e6) {}

  var vertical = false;
  try { vertical = tf.orientation === TextOrientation.VERTICAL; } catch (eV) {}
  if (vertical) {
    LazyLord.warn(name, "Vertical text is rebuilt as horizontal text", "approximated");
  }

  // Point text exposes its true baseline; use it so the target places the text
  // exactly instead of guessing from the font size.
  var anchor = null, point = false;
  try { point = tf.kind === TextType.POINTTEXT; } catch (e7) {}
  if (point) {
    try {
      var ax = LazyLord._air_x(ctx, tf.anchor[0]) - ctx.minX;
      var ay = LazyLord._air_y(ctx, tf.anchor[1]) - ctx.minY;
      if (LazyLord._air_num(ax) && LazyLord._air_num(ay)) anchor = [ax, ay];
    } catch (e8) {}
    if (!anchor) {
      LazyLord.warn(name, "The text's anchor point could not be read; its baseline is estimated from the font size",
        "approximated");
    }
  } else {
    LazyLord.warn(name, "Area text is rebuilt as point text; the text box is not carried over", "approximated");
  }

  // A turned text frame keeps its turn in its matrix: carry it on the frame.
  // Left- (or fully) justified horizontal point text starts at its anchor and
  // right-aligned text ends there, which pins the box's size near 45 degrees.
  // Mirrored across, it runs the other way from its anchor.
  var side = justify === "right" ? 1 : (justify === "center" ? 0 : -1);
  if (o && o.mirrored && o.flip === "x") side = -side;
  var edge = null;
  if (anchor && side && !vertical) {
    var pitch = leading > 0 ? leading : size * LazyLord._air_autoLeading(tf) / 100;
    var span = LazyLord._air_lineSpan(size, pitch, LazyLord._air_lineCount(tf.contents));
    edge = { anchor: anchor, side: side, hMin: span.hMin, hMax: span.hMax };
  }
  var frame = LazyLord._air_turned(ctx, tf, gb, name, false, false, edge);

  // On turned text, tf.anchor is where the turned baseline starts, but the IR
  // keeps the anchor inside the unrotated box: it is turned back about the
  // frame centre here, and LazyLord.rotatedTextAnchor turns it forward again
  // in the builders.
  var baseline, anchorX;
  if (anchor) {
    var ctr = LazyLord.frameCenter(frame);
    if (frame.rotation) anchor = LazyLord.rotatePoint(anchor, ctr, -frame.rotation);
    // Mirrored text reads backwards from its anchor (mirrored across) or hangs
    // from it (mirrored top to bottom), so the same anchor would push the
    // unmirrored text out of its box. Mirroring the anchor across the box's
    // centre, along the same axis, keeps the text over the box it came from.
    if (o && o.mirrored && o.flip === "x") anchor = [2 * ctr[0] - anchor[0], anchor[1]];
    else if (o && o.mirrored) anchor = [anchor[0], 2 * ctr[1] - anchor[1]];
    anchorX = anchor[0];
    baseline = anchor[1];
  }

  var out = {
    id: LazyLord._air_id(ctx, tf),
    name: name,
    type: "text",
    frame: frame,
    characters: tf.contents,
    fontFamily: family,
    fontStyle: style,
    fontSize: size,
    color: color,
    letterSpacing: tracking,
    lineHeight: leading,
    textAlignHorizontal: justify,
    baseline: baseline,
    anchorX: anchorX
  };
  // Mixed character styles travel as runs rather than being flattened.
  var runs = LazyLord._air_textRuns(tf, name, size);
  if (runs) out.runs = runs;
  LazyLord._air_kerning(tf, out);
  return out;
};

/**
 * Per-character styles: consecutive characters sharing font, size, colour,
 * tracking and decoration become one run, in the IR's units. Sizes follow the
 * same scale as the text's own (a scaled frame scales its characters). null
 * when the whole text has one style, or its characters cannot be read.
 */
LazyLord._air_textRuns = function (tf, name, size) {
  var chars = null;
  try { chars = tf.textRange.characters; } catch (e) {}
  if (!chars || typeof chars.length !== "number" || chars.length < 2) return null;
  var raw = 0;
  try { raw = tf.textRange.characterAttributes.size; } catch (e0) {}
  var factor = (LazyLord._air_num(raw) && raw > 0) ? size / raw : 1;

  var runs = [], cur = null;
  for (var i = 0; i < chars.length; i++) {
    var st = {};
    try {
      var a = chars[i].characterAttributes;
      st.fontSize = a.size * factor;
      try { st.fontFamily = a.textFont.family; st.fontStyle = a.textFont.style; } catch (eF) {}
      var p = null;
      // No box: a gradient on a character has no box of its own, and reads as its first colour.
      try { p = LazyLord._air_color(a.fillColor, name, null); } catch (eC) {}
      if (p && p.type !== "solid") p = p.stops && p.stops.length ? { type: "solid", color: p.stops[0].color } : null;
      if (p && p.color) st.color = p.color;
      st.letterSpacing = ((a.tracking || 0) / 1000) * st.fontSize;
      st.decoration = a.underline ? "underline" : (a.strikeThrough ? "strikethrough" : "none");
    } catch (eA) {
      LazyLord.warn(name, "The text's character styles could not be read, so it keeps one style", "approximated");
      return null;
    }
    var c = st.color;
    var key = [st.fontFamily, st.fontStyle, st.fontSize, c ? [c.r, c.g, c.b, c.a].join(",") : "", st.letterSpacing, st.decoration].join("|");
    if (cur && cur.key === key) { cur.end = i + 1; continue; }
    cur = { key: key, start: i, end: i + 1, st: st };
    runs.push(cur);
  }
  if (runs.length < 2) return null;

  var out = [];
  for (var r = 0; r < runs.length; r++) {
    var run = { start: runs[r].start, end: runs[r].end };
    for (var k in runs[r].st) if (runs[r].st.hasOwnProperty(k)) run[k] = runs[r].st[k];
    out.push(run);
  }
  return out;
};

/** Past this many characters, manual kerning is not read: each pair is a call to Illustrator. */
LazyLord._air_KERN_LIMIT = 2000;

/**
 * The text's kerning method, and its manually kerned pairs: a character's
 * kerning is the space before it, in thousandths of an em.
 */
LazyLord._air_kerning = function (tf, out) {
  try {
    var m = tf.textRange.characterAttributes.kerningMethod;
    if (typeof AutoKernType !== "undefined") {
      if (m === AutoKernType.OPTICAL) out.autoKern = "optical";
      else if (m === AutoKernType.NOAUTOKERN) out.autoKern = "none";
    }
  } catch (e) {}
  var chars = null;
  try { chars = tf.textRange.characters; } catch (e1) {}
  if (!chars || typeof chars.length !== "number" || chars.length < 2 || chars.length > LazyLord._air_KERN_LIMIT) return;
  var kerns = [];
  for (var i = 1; i < chars.length; i++) {
    var k = 0;
    try { k = chars[i].kerning; } catch (e2) { return; }
    if (LazyLord._air_num(k) && k !== 0) kerns.push({ index: i, amount: k });
  }
  if (kerns.length) out.kerns = kerns;
};

/** Auto leading as a percentage of the font size: the paragraph's own, else Illustrator's default 120. */
LazyLord._air_autoLeading = function (tf) {
  var pct = 120;
  try {
    var v = tf.textRange.paragraphAttributes.autoLeadingAmount;
    if (LazyLord._air_num(v) && v > 0) pct = v;
  } catch (e) {}
  return pct;
};

/* -------------------------------------------------------------------------
 * Images — prefer the user's original file, rasterize only as a fallback
 * ---------------------------------------------------------------------- */

LazyLord._air_linkedFile = function (item) {
  try {
    var f = item.file;
    if (f && f.exists) return f;
  } catch (e) {}
  return null;
};

/** `frame` is the image's IR frame; pixel sizes follow its unrotated box. */
LazyLord._air_imageLayer = function (ctx, item, frame, path, isOriginal, scale) {
  return {
    id: LazyLord._air_id(ctx, item),
    name: item.name || "Image",
    type: "image",
    frame: frame,
    filePath: path,
    isOriginalFile: !!isOriginal,
    pixelWidth: Math.round(frame.width * (scale || 1)),
    pixelHeight: Math.round(frame.height * (scale || 1))
  };
};

/**
 * The user's own file, sent as it is. A target places a file upright, so the
 * turn the item has on the page travels as frame.rotation, around its
 * unrotated size.
 */
LazyLord._air_original = function (ctx, item, f) {
  var frame = LazyLord._air_turned(ctx, item, item.geometricBounds, item.name || "Image",
    LazyLord._air_flipped(item, f), true);
  return LazyLord._air_imageLayer(ctx, item, frame, f.fsName, true, 1);
};

LazyLord._air_placed = function (ctx, item) {
  var f = LazyLord._air_linkedFile(item);
  if (f) return LazyLord._air_original(ctx, item, f);
  return LazyLord._air_raster(ctx, item, "Linked file is missing, so a PNG was exported instead");
};

LazyLord._air_rasterItem = function (ctx, item) {
  var f = LazyLord._air_linkedFile(item);
  if (f) return LazyLord._air_original(ctx, item, f);
  return LazyLord._air_raster(ctx, item, "Embedded raster image exported as a PNG");
};

/** Last rung of the ladder: duplicate into a temp document and export a PNG. */
LazyLord._air_raster = function (ctx, item, reason) {
  // The PNG covers what shows — strokes and effects included — so its frame does too.
  var gb = LazyLord._air_visible(item) || LazyLord._air_gb(item);
  if (!gb) { LazyLord.warn(item.name || item.typename, "No bounds to export", "skipped"); return null; }

  var name = item.name || item.typename;
  var outPath = LazyLord.join(ctx.outDir, LazyLord._air_safe(name) + "-" + (ctx.imageIndex++) + ".png");

  var scale = LazyLord.readOptions.scale;
  try {
    LazyLord._air_export(item, outPath, scale * 100);
  } catch (e) {
    LazyLord.warn(name, "Could not rasterize — " + e.message, "skipped");
    return null;
  }

  LazyLord.warn(name, reason, "rasterized");
  // The export is of the item as it looks on the page, already turned, so the
  // PNG fills the outer box upright.
  return LazyLord._air_imageLayer(ctx, item, LazyLord._air_frame(ctx, item, gb), outPath, false, scale);
};

/** An item's visible bounds (strokes and effects included), else its geometric ones; null when neither reads. */
LazyLord._air_visible = function (item) {
  var b = null;
  try { b = item.visibleBounds; } catch (e) {}
  if (!b || b.length !== 4) { try { b = item.geometricBounds; } catch (e2) { b = null; } }
  return (b && b.length === 4) ? b : null;
};

/**
 * Export a single item to PNG by duplicating it into a scratch document sized
 * to its bounds. The source document is never modified.
 */
LazyLord._air_export = function (item, outPath, scalePct) {
  var src = app.activeDocument;
  // Visible bounds: strokes and effects reach past the geometry, and the
  // scratch artboard clips whatever lies outside it.
  var gb = LazyLord._air_visible(item);
  var w = Math.max(1, Math.ceil(gb[2] - gb[0]));
  var h = Math.max(1, Math.ceil(gb[1] - gb[3]));

  var tmp = app.documents.add(DocumentColorSpace.RGB, w, h);
  try {
    var dup = item.duplicate(tmp, ElementPlacement.PLACEATEND);
    var ar = tmp.artboards[0].artboardRect; // [0, h, w, 0]
    var dgb = LazyLord._air_visible(dup);
    dup.translate(ar[0] - dgb[0], ar[1] - dgb[1]);

    var opts = new ExportOptionsPNG24();
    opts.antiAliasing = true;
    opts.transparency = true;
    opts.artBoardClipping = true;
    opts.horizontalScale = scalePct;
    opts.verticalScale = scalePct;

    tmp.exportFile(new File(outPath), ExportType.PNG24, opts);
  } finally {
    try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (e1) {}
    try { app.activeDocument = src; } catch (e2) {}
  }
};
