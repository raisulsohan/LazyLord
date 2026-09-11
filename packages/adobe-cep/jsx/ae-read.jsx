/*
 * LazyLord — After Effects reader (pull side).
 * Serialises the selected layers of the active composition into LazyLord IR so
 * they can be pulled back into Illustrator.
 *
 * Coordinates: AE comp space is already y-down with the origin at the comp's
 * top-left, which is exactly the IR's convention — so unlike the Illustrator
 * reader there is no flip here.
 *
 * Stacking: the IR lists layers bottom to top, and selectedLayers comes in the
 * order the layers were clicked, so the selection is put in comp order first.
 * Layers that draw nothing of their own — nulls, adjustment layers, guide
 * layers, cameras and lights — are skipped and reported, never sent as the
 * solid or shape they are built from.
 *
 * Transforms: every layer and every nested shape group carries its own
 * anchor/position/scale/rotation, and a parented layer's transform sits in its
 * parent's layer space, so the whole parent chain is composed first. Vector
 * geometry has that full affine baked in (as Illustrator does), so a vector's
 * frame rotation stays 0 and nothing depends on pivot conventions. Text and
 * footage cannot be baked: they keep the turn as frame.rotation about their
 * unrotated box, and what a rotated box cannot hold (skew, a mirror, uneven
 * scale on text) is reported.
 *
 * Shapes: a shape layer's frame is its drawn extent, curve bulges included,
 * and its winding comes from the Fill Rule of the fill it sends. Paint is
 * scoped as After Effects scopes it: a Fill or Stroke paints every path above
 * it in its own group, nested groups included, so a layer holding a red
 * circle group and a blue square group paints two sets of paths. Each set
 * becomes a vector of its own; a layer with several becomes a group named
 * after it (nested shape groups nest, carrying their group opacity), and a
 * layer with one stays a single vector.
 *
 * Hierarchy: a selected null that selected layers are parented to becomes a
 * group holding them (chains of nulls nest). Parenting passes no opacity, so
 * the group's is 1. Grouping never reorders the stack: when other layers sit
 * between a null's layers, the null becomes one group per unbroken run of
 * them, each where that run sits, and that is reported. A layer whose parent
 * is not selected stays where it is in the stack, placed by its whole parent
 * chain.
 *
 * Masks: layer masks become the layer's clip, carried through the same layer
 * matrix as the geometry. Stacks of Add and Difference masks (what LazyLord's
 * AE builder writes) map across; everything a clip path cannot express (other
 * modes, inversion, feather, expansion, mask opacity, track mattes) is reported.
 *
 * Gradients: a Gradient Ramp effect — what LazyLord's AE builder adds for a
 * gradient fill — reads back as a 2-stop gradient on whatever the layer
 * paints, so gradients round-trip. Shape layers are continuously rasterised,
 * so AE applies their effects AFTER the layer transform: their ramp points are
 * comp space. A solid's effects run before it, so its ramp points are layer
 * pixels and go through the layer matrix.
 */

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

LazyLord.readSelection = function (outDir) {
  var comp = app.project.activeItem;
  if (!comp || !(comp instanceof CompItem)) {
    throw new Error("Open a composition and select some layers first.");
  }
  var sel = comp.selectedLayers;
  if (!sel || sel.length === 0) throw new Error("No layers selected in After Effects.");

  var ctx = {
    comp: comp,
    time: comp.time,
    outDir: outDir,
    idCounter: 1,
    minX: 0,
    minY: 0
  };

  // Pass 1 — convert each layer, bottom to top, with geometry still in comp
  // space. A selected null holding selected layers is kept for their group.
  var order = LazyLord._aer_stackOrder(sel);
  var up = LazyLord._aer_nullParents(order);
  var items = [];
  for (var i = 0; i < order.length; i++) {
    var lyr = order[i];
    items.push(null);
    if (LazyLord._aer_holds(up, i)) {
      items[i] = LazyLord._aer_nullGroup(ctx, lyr);
      continue;
    }
    try {
      if (lyr.enabled === false) continue;
      var raw = LazyLord._aer_layer(ctx, lyr);
      if (raw) {
        LazyLord._aer_extras(ctx, lyr, raw);
        items[i] = raw;
      }
    } catch (e) {
      LazyLord.warn(lyr.name, e.message, "skipped");
    }
  }
  var raws = LazyLord._aer_nest(up, items);
  if (raws.length === 0) throw new Error("Nothing in the selection can be transferred.");

  // Pass 2 — selection bounds. Clips never widen them: only drawn geometry does.
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var b = 0; b < raws.length; b++) {
    var bb = raws[b].bbox;
    if (bb.x < minX) minX = bb.x;
    if (bb.y < minY) minY = bb.y;
    if (bb.x + bb.width > maxX) maxX = bb.x + bb.width;
    if (bb.y + bb.height > maxY) maxY = bb.y + bb.height;
  }
  if (minX === Infinity) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
  ctx.minX = minX;
  ctx.minY = minY;

  // Pass 3 — normalise to the selection's top-left.
  var layers = [];
  for (var k = 0; k < raws.length; k++) layers.push(LazyLord._aer_normalise(ctx, raws[k]));

  return {
    version: "1.0",
    source: "aftereffects",
    name: comp.name || "Composition",
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    // Bounds are measured from the composition's top-left, a real page.
    originSpace: "document",
    // The comp is the page, so a target that has to create one matches it.
    canvas: { width: comp.width, height: comp.height, name: comp.name || "Composition" },
    sourceKey: LazyLord._aer_sourceKey(comp),
    layers: layers
  };
};

/**
 * What tells this composition apart from every other one, so a target can match
 * a layer id back to the thing it came from: the saved project's path plus the
 * comp's own id, since layer ids repeat across comps. An unsaved project has
 * nothing stable to offer, and matching then falls back to the layer id alone.
 */
LazyLord._aer_sourceKey = function (comp) {
  var project = "";
  try { if (app.project.file) project = app.project.file.fsName; } catch (e) {}
  var id = "";
  try { id = comp.id ? String(comp.id) : ""; } catch (eId) {}
  if (!project && !id) return "";
  return project + "#" + id;
};

/**
 * The selection in stacking order, bottom to top, as the IR lists layers.
 * selectedLayers is in the order the layers were clicked, not their order in
 * the comp (select all from the top and it runs top to bottom). AE's index 1
 * is the top layer, so the highest index comes first. When an index cannot be
 * read the selection order is kept, and reported.
 */
LazyLord._aer_stackOrder = function (sel) {
  var list = [];
  for (var i = 0; i < sel.length; i++) list.push(sel[i]);
  if (list.length < 2) return list;

  var keyed = [];
  for (var k = 0; k < list.length; k++) {
    var idx = null;
    try { idx = list[k].index; } catch (e) {}
    if (!LazyLord._aer_isNum(idx)) {
      LazyLord.warn(LazyLord._aer_nameOf(list[k]), "Its place in the layer stack could not be read, so the " +
        "selection is sent in the order it was selected and may stack out of order", "approximated");
      return list;
    }
    keyed.push({ layer: list[k], index: idx });
  }
  // Indices are unique within a comp, so the sort has no ties to keep stable.
  keyed.sort(function (a, b) { return b.index - a.index; });
  var out = [];
  for (var j = 0; j < keyed.length; j++) out.push(keyed[j].layer);
  return out;
};

/* -------------------------------------------------------------------------
 * Hierarchy — selected parent nulls become groups
 * ---------------------------------------------------------------------- */

/**
 * For each layer of `order`, the position in `order` of its parent when that
 * parent is a selected null, else -1. Only the direct parent counts: a layer
 * under an unselected parent stays flat (its world transform already carries
 * the whole chain). After Effects refuses parenting loops; should one appear
 * anyway, it is cut where it closes rather than nested forever.
 */
LazyLord._aer_nullParents = function (order) {
  var up = [];
  for (var i = 0; i < order.length; i++) {
    var p = null;
    // An unreadable parent is reported with the layer's transform; here it is just flat.
    try { p = order[i].parent || null; } catch (e) {}
    var at = p ? LazyLord._aer_find(order, p) : -1;
    if (at === i || (at >= 0 && LazyLord._aer_flag(order[at], "nullLayer") !== true)) at = -1;
    up.push(at);
  }
  for (var s = 0; s < up.length; s++) {
    var seen = {};
    seen[s] = true;
    var cur = s;
    while (up[cur] >= 0) {
      if (seen[up[cur]]) { up[cur] = -1; break; }
      seen[up[cur]] = true;
      cur = up[cur];
    }
  }
  return up;
};

/**
 * Where `layer` sits in `list`, or -1. Layers are matched as objects first,
 * then by their index in the comp (unique there), in case After Effects hands
 * out a different object for the same layer through .parent.
 */
LazyLord._aer_find = function (list, layer) {
  for (var i = 0; i < list.length; i++) {
    if (list[i] === layer) return i;
  }
  var idx = null;
  try { idx = layer.index; } catch (e) {}
  if (!LazyLord._aer_isNum(idx)) return -1;
  for (var j = 0; j < list.length; j++) {
    var other = null;
    try { other = list[j].index; } catch (e2) {}
    if (other === idx) return j;
  }
  return -1;
};

/** True when some selected layer is parented to the null at `pos`. */
LazyLord._aer_holds = function (up, pos) {
  for (var i = 0; i < up.length; i++) {
    if (up[i] === pos) return true;
  }
  return false;
};

/**
 * The template of the groups standing for a selected parent null: _aer_nest
 * makes one group from it for each unbroken run of the null's layers.
 */
LazyLord._aer_nullGroup = function (ctx, layer) {
  return {
    _aerNull: true,
    id: LazyLord._aer_id(ctx, layer),
    name: LazyLord._aer_nameOf(layer),
    // Parenting passes a null's transform on, never its opacity.
    opacity: 1
  };
};

/**
 * The converted layers (`items`, bottom to top by position in the stack) as
 * the IR's top-level list, each layer under the groups of its selected parent
 * nulls. The layers are taken strictly in stack order, so grouping never
 * moves one: a layer stays in the groups it shares with the layer below it
 * and opens the rest. A null whose layers are not next to each other thus
 * becomes one group per unbroken run of them, each where that run sits (ids
 * ae-<null>, ae-<null>-2, ...), which is reported. A null none of whose layers
 * could be sent is reported as having nothing to draw.
 */
LazyLord._aer_nest = function (up, items) {
  var top = [];
  // The groups the layer below was in, outermost first: { pos, raw }.
  var open = [];
  // Per null position: the groups made for it so far.
  var runs = [];
  for (var i = 0; i < items.length; i++) runs.push([]);

  for (var k = 0; k < items.length; k++) {
    var item = items[k];
    if (!item || item._aerNull) continue;
    var chain = LazyLord._aer_chain(up, items, k);
    var keep = 0;
    while (keep < open.length && keep < chain.length && open[keep].pos === chain[keep]) keep++;
    open.splice(keep, open.length - keep);
    for (var c = keep; c < chain.length; c++) {
      var grp = LazyLord._aer_run(items[chain[c]], runs[chain[c]]);
      (c > 0 ? open[c - 1].raw.children : top).push(grp);
      open.push({ pos: chain[c], raw: grp });
    }
    (open.length ? open[open.length - 1].raw.children : top).push(item);
  }

  for (var g = 0; g < items.length; g++) {
    if (!items[g] || !items[g]._aerNull) continue;
    if (!runs[g].length) {
      LazyLord.warn(items[g].name, "A null object has nothing to draw, and none of the selected layers parented " +
        "to it could be sent", "skipped");
    } else if (runs[g].length > 1) {
      LazyLord._aer_noteSplit(up, items, g, runs[g].length);
    }
  }
  for (var t = 0; t < top.length; t++) LazyLord._aer_boxTree(top[t]);
  return top;
};

/**
 * The positions of the selected nulls a layer sits under, outermost first.
 * _aer_nullParents has already cut any loop; the length check is only a guard.
 */
LazyLord._aer_chain = function (up, items, k) {
  var chain = [];
  for (var p = up[k]; p >= 0 && items[p] && items[p]._aerNull && chain.length < up.length; p = up[p]) {
    chain.unshift(p);
  }
  return chain;
};

/** One more group for a null (from its template), numbered after the first. */
LazyLord._aer_run = function (tpl, made) {
  var grp = {
    type: "group",
    id: made.length ? tpl.id + "-" + (made.length + 1) : tpl.id,
    name: tpl.name,
    opacity: tpl.opacity,
    bbox: null,
    children: []
  };
  made.push(grp);
  return grp;
};

/**
 * Report a null whose layers were not next to each other in the stack, naming
 * the sent layers between them: it is sent as `count` groups so that nothing
 * changes place.
 */
LazyLord._aer_noteSplit = function (up, items, g, count) {
  var mine = {};
  var lo = Infinity, hi = -Infinity;
  for (var k = 0; k < items.length; k++) {
    if (!items[k] || items[k]._aerNull) continue;
    var chain = LazyLord._aer_chain(up, items, k);
    for (var c = 0; c < chain.length; c++) {
      if (chain[c] !== g) continue;
      mine[k] = true;
      if (k < lo) lo = k;
      if (k > hi) hi = k;
    }
  }
  var names = [];
  for (var j = lo + 1; j < hi; j++) {
    if (items[j] && !items[j]._aerNull && !mine[j]) names.push("'" + items[j].name + "'");
  }
  var n = names.length;
  if (n > 3) names = names.slice(0, 3).concat([(n - 3) + " more"]);
  var list = names.length > 1
    ? names.slice(0, names.length - 1).join(", ") + " and " + names[names.length - 1]
    : names[0];
  LazyLord.warn(items[g].name, "The layers parented to it are not next to each other in the layer stack: " + list +
    (n === 1 ? " sits" : " sit") + " between them. So that nothing changes place, it is sent as " + count +
    " groups named after it, each where its layers sit", "approximated");
};

/** Fill in the drawn box of every null group in a raw tree; returns the raw's box. */
LazyLord._aer_boxTree = function (raw) {
  if (raw.type !== "group" || raw.bbox) return raw.bbox;
  var boxes = [];
  for (var i = 0; i < raw.children.length; i++) boxes.push(LazyLord._aer_boxTree(raw.children[i]));
  raw.bbox = LazyLord._aer_unionBox(boxes);
  return raw.bbox;
};

/** The box around a list of { x, y, width, height } boxes. */
LazyLord._aer_unionBox = function (boxes) {
  var pts = [];
  for (var i = 0; i < boxes.length; i++) {
    var b = boxes[i];
    if (!b) continue;
    pts.push([b.x, b.y], [b.x + b.width, b.y + b.height]);
  }
  return LazyLord._aer_bboxOf(pts);
};

/**
 * Shift a raw layer's comp-space geometry into layer-local IR form. A group's
 * children keep their own frames in the same frame space, never relative to
 * the group, whose frame is the box of what they draw.
 */
LazyLord._aer_normalise = function (ctx, raw) {
  var bb = raw.bbox;
  // Text and footage carry their unrotated box and turn; for vectors the
  // affine is already baked into the geometry, so the box is the drawn one.
  var box = raw.frame || bb;
  var layer = {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    frame: {
      x: box.x - ctx.minX,
      y: box.y - ctx.minY,
      width: box.width,
      height: box.height,
      rotation: raw.rotation || 0,
      opacity: raw.opacity
    }
  };

  if (raw.type === "group") {
    var kids = [];
    for (var c = 0; c < raw.children.length; c++) kids.push(LazyLord._aer_normalise(ctx, raw.children[c]));
    layer.children = kids;
  } else if (raw.type === "vector") {
    var subs = [];
    for (var i = 0; i < raw.subpaths.length; i++) {
      var sp = raw.subpaths[i];
      var verts = [], ins = [], outs = [];
      for (var v = 0; v < sp.vertices.length; v++) {
        verts.push([sp.vertices[v][0] - bb.x, sp.vertices[v][1] - bb.y]);
        // Tangents are relative, so unaffected; copied because a path painted
        // twice (by its own group's Fill and an outer one) is in two vectors.
        ins.push([sp.inTangents[v][0], sp.inTangents[v][1]]);
        outs.push([sp.outTangents[v][0], sp.outTangents[v][1]]);
      }
      subs.push({ closed: sp.closed, vertices: verts, inTangents: ins, outTangents: outs });
    }
    layer.subpaths = subs;
    var fills = [];
    for (var f = 0; f < raw.fills.length; f++) fills.push(LazyLord._aer_boxPaint(raw.fills[f], bb));
    layer.fills = fills;
    // A ramp can colour the stroke too, so its paint is boxed the same way.
    var strokes = [];
    for (var s = 0; s < raw.strokes.length; s++) {
      var st = raw.strokes[s];
      strokes.push({ paint: LazyLord._aer_boxPaint(st.paint, bb), weight: st.weight,
                     cap: st.cap, join: st.join, align: st.align });
    }
    layer.strokes = strokes;
    layer.windingRule = raw.windingRule || "nonzero";
  } else if (raw.type === "text") {
    layer.characters = raw.characters;
    layer.fontFamily = raw.fontFamily;
    layer.fontStyle = raw.fontStyle;
    layer.fontSize = raw.fontSize;
    layer.color = raw.color;
    layer.letterSpacing = raw.letterSpacing;
    layer.lineHeight = raw.lineHeight;
    layer.textAlignHorizontal = raw.textAlignHorizontal;
    layer.anchorX = raw.anchor[0] - ctx.minX;
    layer.baseline = raw.anchor[1] - ctx.minY;
  } else if (raw.type === "image") {
    layer.filePath = raw.filePath;
    layer.isOriginalFile = raw.isOriginalFile;
    layer.pixelWidth = raw.pixelWidth;
    layer.pixelHeight = raw.pixelHeight;
  }

  if (raw.clip) layer.clip = LazyLord._aer_frameClip(ctx, raw.clip);

  return layer;
};

/**
 * A raw clip moved into FRAME space: the selection-normalised space of
 * frame.x / frame.y — so minus the selection's top-left, not the layer's box.
 * Every array is copied, so no two layers ever share a clip object.
 */
LazyLord._aer_frameClip = function (ctx, clip) {
  var subs = [];
  for (var i = 0; i < clip.subpaths.length; i++) {
    var sp = clip.subpaths[i];
    var verts = [], ins = [], outs = [];
    for (var v = 0; v < sp.vertices.length; v++) {
      verts.push([sp.vertices[v][0] - ctx.minX, sp.vertices[v][1] - ctx.minY]);
      ins.push([sp.inTangents[v][0], sp.inTangents[v][1]]);
      outs.push([sp.outTangents[v][0], sp.outTangents[v][1]]);
    }
    subs.push({ closed: sp.closed, vertices: verts, inTangents: ins, outTangents: outs });
  }
  var out = { id: clip.id, subpaths: subs, windingRule: clip.windingRule || "nonzero" };
  if (clip.name) out.name = clip.name;
  return out;
};

/**
 * A paint with comp-space gradient handles (a Gradient Ramp read-back),
 * expressed as the IR wants it: 0..1 of the layer box. Other paints pass
 * through untouched.
 */
LazyLord._aer_boxPaint = function (paint, bb) {
  if (!paint || !paint._aerFrom) return paint;
  var w = bb.width || 0, h = bb.height || 0;
  function norm(p) {
    return { x: w ? (p[0] - bb.x) / w : 0, y: h ? (p[1] - bb.y) / h : 0 };
  }
  return { type: paint.type, stops: paint.stops, from: norm(paint._aerFrom), to: norm(paint._aerTo) };
};

LazyLord._aer_id = function (ctx, layer) {
  try { if (layer.id) return "ae-" + layer.id; } catch (e) {}
  return "ae-" + (ctx.idCounter++);
};

/* -------------------------------------------------------------------------
 * 2D affine helpers — [a, b, c, d, tx, ty]
 *   x' = a*x + c*y + tx
 *   y' = b*x + d*y + ty
 * ---------------------------------------------------------------------- */

LazyLord._aer_identity = function () { return [1, 0, 0, 1, 0, 0]; };

/** Apply `parent` after `child`. */
LazyLord._aer_compose = function (p, c) {
  return [
    p[0] * c[0] + p[2] * c[1],
    p[1] * c[0] + p[3] * c[1],
    p[0] * c[2] + p[2] * c[3],
    p[1] * c[2] + p[3] * c[3],
    p[0] * c[4] + p[2] * c[5] + p[4],
    p[1] * c[4] + p[3] * c[5] + p[5]
  ];
};

LazyLord._aer_apply = function (m, pt) {
  return [m[0] * pt[0] + m[2] * pt[1] + m[4], m[1] * pt[0] + m[3] * pt[1] + m[5]];
};

/** Direction vectors ignore translation. */
LazyLord._aer_applyVec = function (m, v) {
  return [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
};

/** Uniform scale factor of a matrix — used for stroke widths and font sizes. */
LazyLord._aer_scaleOf = function (m) {
  var det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  return Math.sqrt(det) || 1;
};

/**
 * Build T(position) * R(rotation) * S(scale) * T(-anchor).
 * AE rotation is clockwise-positive in its y-down space, which is what the
 * plain [cos, sin, -sin, cos] matrix produces there.
 */
LazyLord._aer_trs = function (anchor, position, scale, rotDeg) {
  var r = (rotDeg || 0) * Math.PI / 180;
  var cos = Math.cos(r), sin = Math.sin(r);
  var sx = (scale && scale.length ? scale[0] : 100) / 100;
  var sy = (scale && scale.length > 1 ? scale[1] : 100) / 100;

  var a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
  var ax = anchor[0] || 0, ay = anchor[1] || 0;

  return [a, b, c, d,
    (position[0] || 0) - (a * ax + c * ay),
    (position[1] || 0) - (b * ax + d * ay)];
};

LazyLord._aer_val = function (group, matchName, fallback) {
  try {
    var p = group.property(matchName);
    if (p) return p.value;
  } catch (e) {}
  return fallback;
};

/** The layer's full comp-space affine (parents included), reporting what the 2D IR flattens. */
LazyLord._aer_layerMatrix = function (ctx, layer) {
  if (layer.threeDLayer === true) {
    LazyLord.warn(layer.name, "3D layer flattened to its 2D position and Z rotation", "approximated");
  }
  return LazyLord._aer_worldTRS(layer, true);
};

/** The same comp-space affine without the reports — for second readers such as masks. */
LazyLord._aer_layerTRS = function (layer) {
  return LazyLord._aer_worldTRS(layer, false);
};

/** More parents than any real rig has; a longer chain is cut there. */
LazyLord._aer_MAX_PARENTS = 100;

/**
 * Parent world x child local, all the way up. A parented layer's transform
 * sits in its parent's layer space (Position is measured from the parent's
 * top-left, like any layer-space point), so each ancestor's own affine is
 * applied in turn until comp space is reached. After Effects refuses parenting
 * loops, but a chain that repeats or runs past _aer_MAX_PARENTS is cut rather
 * than followed forever. With `report` set, a cut chain and 3D parents are
 * reported against the layer being read.
 */
LazyLord._aer_worldTRS = function (layer, report) {
  var m = LazyLord._aer_ownTRS(layer);
  var seen = [layer];
  var cur = layer;
  while (true) {
    var p = null;
    try { p = cur.parent || null; } catch (eP) {
      if (report) {
        LazyLord.warn(layer.name, "The parent of '" + LazyLord._aer_nameOf(cur) +
          "' could not be read, so it is placed as if nothing above it were parented", "approximated");
      }
    }
    if (!p) break;

    var looped = false;
    for (var i = 0; i < seen.length; i++) {
      if (seen[i] === p) { looped = true; break; }
    }
    if (looped || seen.length > LazyLord._aer_MAX_PARENTS) {
      if (report) {
        LazyLord.warn(layer.name, looped
          ? "Its parent chain loops back to '" + LazyLord._aer_nameOf(p) + "'; each parent is applied only once"
          : "Its parent chain is more than " + LazyLord._aer_MAX_PARENTS + " layers deep; only the nearest " +
            LazyLord._aer_MAX_PARENTS + " parents are applied", "approximated");
      }
      break;
    }

    var pm;
    try { pm = LazyLord._aer_ownTRS(p); } catch (eT) {
      if (report) {
        LazyLord.warn(layer.name, "The transform of its parent '" + LazyLord._aer_nameOf(p) +
          "' could not be read, so the parents from there up are ignored", "approximated");
      }
      break;
    }
    if (report && LazyLord._aer_is3D(p)) {
      LazyLord.warn(layer.name, "Its parent '" + LazyLord._aer_nameOf(p) +
        "' is 3D, flattened to its 2D position and Z rotation", "approximated");
    }
    m = LazyLord._aer_compose(pm, m);
    seen.push(p);
    cur = p;
  }
  return m;
};

/** True for a 3D layer; cameras and lights live in 3D and have no 3D switch. */
LazyLord._aer_is3D = function (layer) {
  try { if (layer.threeDLayer === true) return true; } catch (e) {}
  return LazyLord._aer_isCameraOrLight(layer);
};

LazyLord._aer_isCameraOrLight = function (layer) {
  try { if (typeof CameraLayer !== "undefined" && layer instanceof CameraLayer) return true; } catch (e) {}
  try { if (typeof LightLayer !== "undefined" && layer instanceof LightLayer) return true; } catch (e2) {}
  return false;
};

LazyLord._aer_nameOf = function (layer) {
  try { if (layer.name) return String(layer.name); } catch (e) {}
  return "(unnamed)";
};

/**
 * The layer's own affine, T(position) * R * S * T(-anchor), into its parent's
 * layer space. A camera or light (only ever met here as a parent) keeps its
 * Point of Interest under the "ADBE Anchor Point" match name; that is a target
 * it looks at, not an offset, so its layer space starts at its position.
 */
LazyLord._aer_ownTRS = function (layer) {
  var tg = layer.property("ADBE Transform Group");
  var anchor = LazyLord._aer_isCameraOrLight(layer) ? [0, 0]
    : LazyLord._aer_val(tg, "ADBE Anchor Point", [0, 0]);
  var pos = LazyLord._aer_val(tg, "ADBE Position", [0, 0]);
  var scale = LazyLord._aer_val(tg, "ADBE Scale", [100, 100]);
  var rot = LazyLord._aer_val(tg, "ADBE Rotate Z", 0);
  return LazyLord._aer_trs(anchor, pos, scale, rot);
};

LazyLord._aer_layerOpacity = function (layer) {
  var o = LazyLord._aer_val(layer.property("ADBE Transform Group"), "ADBE Opacity", 100);
  return Math.max(0, Math.min(1, o / 100));
};

/** A finite number (not NaN, not Infinity, not a string). */
LazyLord._aer_isNum = function (n) {
  return typeof n === "number" && isFinite(n);
};

/** Bounding box of a list of comp-space points. */
LazyLord._aer_bboxOf = function (points) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/* -------------------------------------------------------------------------
 * Layer dispatch
 * ---------------------------------------------------------------------- */

LazyLord._aer_layer = function (ctx, layer) {
  // Cameras and lights are not AVLayers and have none of the switches below.
  if (!(layer instanceof ShapeLayer || layer instanceof TextLayer || layer instanceof AVLayer)) {
    LazyLord.warn(layer.name, "It is not a shape, text, footage or solid layer (a camera or light, say), " +
      "so it has nothing to draw", "skipped");
    return null;
  }

  // Nulls and adjustment layers are built from a solid or a shape, so they
  // must be caught before they are read as one.
  var why = LazyLord._aer_undrawn(layer);
  if (why) {
    LazyLord.warn(layer.name, why, "skipped");
    return null;
  }

  if (layer instanceof ShapeLayer) return LazyLord._aer_shape(ctx, layer);
  if (layer instanceof TextLayer) return LazyLord._aer_text(ctx, layer);
  return LazyLord._aer_av(ctx, layer);
};

/**
 * Why a shape, text or AV layer has nothing of its own to send, or null when
 * it draws. A null object is an AVLayer with a solid source; an adjustment
 * layer is a comp-sized solid, or a shape or text layer with the Adjustment
 * Layer switch on, whose pixels only say where its effects apply to the
 * layers below; a guide layer is never rendered. Read as what they are built
 * from, each would arrive as an opaque square or shape. A layer parented to
 * one of them still follows it: a parent's transform is read whatever it is.
 * A switch that cannot be read is taken as off, and reported.
 */
LazyLord._aer_undrawn = function (layer) {
  var isNull = LazyLord._aer_flag(layer, "nullLayer");
  var guide = LazyLord._aer_flag(layer, "guideLayer");
  var adjust = LazyLord._aer_flag(layer, "adjustmentLayer");

  if (isNull === true) {
    return "A null object has nothing to draw (layers parented to it still follow it)";
  }
  if (guide === true) {
    return "It is a guide layer, which After Effects does not render; switch Guide Layer off to send it";
  }
  if (adjust === true) {
    return "It is an adjustment layer: it has nothing of its own to draw, and its effects on the layers " +
      "below are not transferred";
  }

  var unread = [];
  if (isNull === null) unread.push("a null object");
  if (adjust === null) unread.push("an adjustment layer");
  if (guide === null) unread.push("a guide layer");
  if (unread.length) {
    var last = unread.pop();
    LazyLord.warn(LazyLord._aer_nameOf(layer), "Whether it is " +
      (unread.length ? unread.join(", ") + " or " : "") + last +
      " could not be read, so it is sent as drawn", "approximated");
  }
  return null;
};

/** A layer switch: true or false, or null when it cannot be read. */
LazyLord._aer_flag = function (layer, name) {
  try {
    var v = layer[name];
    if (v === true || v === false) return v;
  } catch (e) {}
  return null;
};

/* -------------------------------------------------------------------------
 * Shape layers
 * ---------------------------------------------------------------------- */

/**
 * A shape layer as one vector per set of paths After Effects paints alike
 * (see _aer_paintSets): a single vector named after the layer when there is
 * one set, as ever; otherwise a group named after the layer, holding them
 * bottom to top, with the layer's opacity on the group. A layer that paints
 * nothing at all is sent as its bare outline, so there is still something to
 * send.
 */
LazyLord._aer_shape = function (ctx, layer) {
  var root = layer.property("ADBE Root Vectors Group");
  if (!root) return null;

  var matrix = LazyLord._aer_layerMatrix(ctx, layer);
  var scan = { paths: [], painted: [], ops: 0 };
  var tree = LazyLord._aer_walk(ctx, root, matrix, scan, layer.name, layer.name, 1);

  if (scan.paths.length === 0) {
    LazyLord.warn(layer.name, "Shape layer has no readable paths", "skipped");
    return null;
  }

  var sets;
  if (scan.ops === 0) {
    var all = [];
    for (var i = 0; i < scan.paths.length; i++) all.push(i);
    sets = [LazyLord._aer_newSet(layer.name, all)];
  } else {
    sets = LazyLord._aer_paintSets(tree, layer.name);
    LazyLord._aer_noteUnpainted(scan, layer.name);
  }

  // A Gradient Ramp recolours whatever the layer paints. Shape layers are
  // continuously rasterised (effects after the transform), so its points are
  // already comp space: no layer matrix.
  var ramp = LazyLord._aer_ramp(layer, LazyLord._aer_identity());
  var base = LazyLord._aer_id(ctx, layer);
  var opacity = LazyLord._aer_layerOpacity(layer);
  var ids = { n: 0 };

  if (sets.length === 1) {
    var one = LazyLord._aer_setRaw(scan, sets[0], base, base, ids, ramp, layer.name);
    one.name = layer.name;
    one.opacity = opacity * sets[0].opacity;
    return one;
  }
  var kids = [];
  for (var k = 0; k < sets.length; k++) {
    kids.push(LazyLord._aer_setRaw(scan, sets[k], base + "-" + (++ids.n), base, ids, ramp, layer.name));
  }
  return LazyLord._aer_groupRaw(base, layer.name, opacity, kids);
};

/**
 * A paint set: the paths it covers and the first readable fill and stroke
 * over them. While the set is filled in, `fillOp` / `strokeOp` are the paints
 * sent, `seen` the kinds met so far and `unread` the paints that could not be
 * read, each noting whether it was the first of its kind (the one listed on top).
 */
LazyLord._aer_newSet = function (name, paths) {
  return { kind: "vector", name: name, opacity: 1, paths: paths, fills: [], strokes: [], fillProp: null,
           fillOp: null, strokeOp: null, seen: {}, unread: [] };
};

/**
 * The vectors (and nested groups of them) that a scanned shape group paints,
 * bottom to top. Contents draw the first item on top, so the list is read top
 * first and turned over at the end.
 *
 * Paints in one group over exactly the same paths make one vector: its first
 * readable Fill and first Stroke, as the layer was read before, whichever of
 * the two is listed first. Paints over different paths, or from different
 * groups, stay separate vectors, stacked where After Effects draws them. A
 * nested group that paints one vector hands it up with its group opacity
 * multiplied in; one that paints several becomes a group with that opacity.
 *
 * A paint that cannot be read (a gradient, a colour that cannot be read) is
 * reported once its set is complete, saying what is sent instead
 * (_aer_noteUnread).
 */
LazyLord._aer_paintSets = function (node, layerName) {
  var sets = [];
  var own = [];
  var byPaths = {};
  var prev = null;
  for (var i = 0; i < node.items.length; i++) {
    var item = node.items[i];
    if (item.group) {
      var sub = LazyLord._aer_paintSets(item.group, layerName);
      if (sub.length === 1) {
        sub[0].opacity *= item.group.opacity;
        sets.push(sub[0]);
      } else if (sub.length > 1) {
        sets.push({ kind: "group", name: item.group.name, opacity: item.group.opacity, children: sub });
      }
      continue;
    }

    var op = item.op;
    var key = "p" + op.paths.join(",");
    var set = byPaths[key];
    if (!set) {
      set = LazyLord._aer_newSet(node.name, op.paths);
      byPaths[key] = set;
      sets.push(set);
      own.push(set);
    }
    // Stacked in contents order; a paint composited above the one before it
    // in its group would draw the other way round.
    if (op.aboveOrder && prev && prev !== set) {
      LazyLord.warn(layerName, "'" + op.name + "' is composited above the paint before it in its group; " +
        "the shapes they paint are stacked in contents order instead", "approximated");
    }
    prev = set;
    var first = set.seen[op.kind] !== true;
    set.seen[op.kind] = true;
    // An unreadable paint (a gradient, a colour that cannot be read) still
    // counts: its paths are painted, just not in a colour that can be sent.
    if (!op.paint) {
      set.unread.push({ op: op, first: first });
    } else if (op.kind === "fill" && !set.fills.length) {
      set.fills.push(op.paint);
      set.fillProp = op.prop;
      set.fillOp = op;
    } else if (op.kind === "stroke" && !set.strokes.length) {
      set.strokes.push(op.paint);
      set.strokeOp = op;
    }
  }
  for (var s = 0; s < own.length; s++) {
    for (var u = 0; u < own[s].unread.length; u++) {
      var un = own[s].unread[u];
      LazyLord._aer_noteUnread(layerName, un.op, un.first,
                               un.op.kind === "fill" ? own[s].fillOp : own[s].strokeOp);
    }
  }
  sets.reverse();
  return sets;
};

/**
 * Report a paint that could not be read, now that its set says what is sent:
 *   - the first of its kind over those paths (listed on top, so the one After
 *     Effects shows) with a readable one listed below it: that one is sent in
 *     its place, approximated;
 *   - the first of its kind with nothing readable below: the paths arrive
 *     unfilled (or without a stroke), skipped;
 *   - listed under another of its kind: it is left out, skipped.
 */
LazyLord._aer_noteUnread = function (layerName, op, first, used) {
  var lead = op.gradient
    ? "'" + op.name + "' is a gradient " + op.kind + ", and gradient " + op.kind + "s cannot be read from shape layers"
    : "The colour of '" + op.name + "' could not be read";
  if (first && used) {
    LazyLord.warn(layerName, lead + "; the " + op.kind + " listed below it, '" + used.name +
      "', is sent in its place", "approximated");
  } else if (first) {
    LazyLord.warn(layerName, lead + ", so the paths it paints arrive " +
      (op.kind === "fill" ? "unfilled" : "without a stroke"), "skipped");
  } else {
    LazyLord.warn(layerName, lead + ", so it is left out", "skipped");
  }
};

/**
 * One paint set (or group of them) as a raw layer with comp-space geometry.
 * `base` and `ids` number the pieces of one shape layer: base-1, base-2...
 */
LazyLord._aer_setRaw = function (scan, set, id, base, ids, ramp, layerName) {
  if (set.kind === "group") {
    var kids = [];
    for (var c = 0; c < set.children.length; c++) {
      kids.push(LazyLord._aer_setRaw(scan, set.children[c], base + "-" + (++ids.n), base, ids, ramp, layerName));
    }
    return LazyLord._aer_groupRaw(id, set.name, set.opacity, kids);
  }

  var subs = [];
  for (var i = 0; i < set.paths.length; i++) subs.push(scan.paths[set.paths[i]]);
  var acc = { fills: set.fills, strokes: set.strokes };
  // The fill sent decides the winding with its own Fill Rule. With no fill
  // there is nothing to wind, so several contours are read as holes, like a
  // compound path, for a target that fills the shape anyway.
  var winding = acc.fills.length ? LazyLord._aer_fillRule(set.fillProp, layerName)
    : (subs.length > 1 ? "evenodd" : "nonzero");
  if (ramp) LazyLord._aer_rampPaints(acc, ramp);

  return {
    type: "vector",
    id: id,
    name: set.name,
    opacity: set.opacity,
    // The drawn extent, curves included: gradient handles are measured against it.
    bbox: LazyLord._aer_curveBounds(subs),
    subpaths: subs,
    fills: acc.fills,
    strokes: acc.strokes,
    windingRule: winding
  };
};

/** A raw group around raw children, boxed by what they draw. */
LazyLord._aer_groupRaw = function (id, name, opacity, children) {
  var boxes = [];
  for (var i = 0; i < children.length; i++) boxes.push(children[i].bbox);
  return { type: "group", id: id, name: name, opacity: opacity, bbox: LazyLord._aer_unionBox(boxes), children: children };
};

/**
 * In a layer that paints, paths no Fill or Stroke reaches draw nothing in
 * After Effects, so they are left out rather than sent as bare outlines.
 */
LazyLord._aer_noteUnpainted = function (scan, layerName) {
  var n = 0;
  for (var i = 0; i < scan.paths.length; i++) {
    if (!scan.painted[i]) n++;
  }
  if (!n) return;
  LazyLord.warn(layerName, (n === 1 ? "One of its paths has" : n + " of its paths have") +
    " no Fill or Stroke below " + (n === 1 ? "it" : "them") + " in the same group or a group around it, " +
    "so After Effects draws nothing there; " + (n === 1 ? "it is" : "they are") + " left out", "skipped");
};

/**
 * A fill's Fill Rule as the IR's winding: 1 is Non-Zero Winding (After
 * Effects' default, and what LazyLord's AE builder writes for "nonzero"),
 * 2 is Even-Odd. An unreadable rule is taken as the default and reported.
 */
LazyLord._aer_fillRule = function (fill, layerName) {
  var rule = LazyLord._aer_val(fill, "ADBE Vector Fill Rule", null);
  if (rule === 2) return "evenodd";
  if (rule === 1) return "nonzero";
  LazyLord.warn(layerName, "Its fill rule could not be read, so After Effects' default, Non-Zero Winding, " +
    "is assumed; overlapping contours may fill where they showed holes", "approximated");
  return "nonzero";
};

/**
 * Tight box of comp-space subpaths: every vertex plus, on each segment, the
 * points where the curve turns back along x or y. Curves bulge past their
 * vertices (a turned ellipse's vertex box is some 10% short each way), and
 * the frame is what gradient handles are measured against.
 */
LazyLord._aer_curveBounds = function (subpaths) {
  var pts = [];
  for (var s = 0; s < subpaths.length; s++) {
    var sp = subpaths[s], vs = sp.vertices, n = vs.length;
    for (var i = 0; i < n; i++) {
      pts.push(vs[i]);
      // An open path has no segment back from its last vertex to its first.
      if (i === n - 1 && !sp.closed) continue;
      var j = (i + 1) % n;
      var o = sp.outTangents[i] || [0, 0], t = sp.inTangents[j] || [0, 0];
      LazyLord._aer_cubicTurns(vs[i], [vs[i][0] + o[0], vs[i][1] + o[1]],
                               [vs[j][0] + t[0], vs[j][1] + t[1]], vs[j], pts);
    }
  }
  return LazyLord._aer_bboxOf(pts);
};

/**
 * Push onto `out` the points of the cubic p0..p3 where x or y has zero
 * derivative strictly inside the segment. Per axis, B'(t)/3 = A t^2 + B t + C
 * with d0 = p1 - p0, d1 = p2 - p1, d2 = p3 - p2: A = d0 - 2 d1 + d2,
 * B = 2 (d1 - d0), C = d0; its roots come from the cancellation-free form.
 */
LazyLord._aer_cubicTurns = function (p0, p1, p2, p3, out) {
  for (var k = 0; k < 2; k++) {
    var d0 = p1[k] - p0[k], d1 = p2[k] - p1[k], d2 = p3[k] - p2[k];
    var A = d0 - 2 * d1 + d2, B = 2 * (d1 - d0), C = d0;
    var ts = [];
    if (A === 0) {
      if (B !== 0) ts.push(-C / B);
    } else {
      var disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      var q = -0.5 * (B + (B < 0 ? -1 : 1) * Math.sqrt(disc));
      ts.push(q / A);
      if (q !== 0) ts.push(C / q);
    }
    for (var r = 0; r < ts.length; r++) {
      var u = ts[r];
      if (!(u > 0 && u < 1)) continue;
      var mu = 1 - u;
      var w0 = mu * mu * mu, w1 = 3 * mu * mu * u, w2 = 3 * mu * u * u, w3 = u * u * u;
      out.push([w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
                w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1]]);
    }
  }
};

/**
 * Recursive scan of a shape group's contents, composing group transforms.
 * Returns the group as { name, opacity, items, paths }: `items` in contents
 * order (top first), each { group: scanned child } or { op: paint }, and
 * `paths` every path in it, nested groups' included, as indices into
 * scan.paths (comp-space subpaths). A Fill or Stroke paints every path above
 * it in its own group, nested groups included, so each paint takes the paths
 * met so far; one with none above it paints nothing and is not kept.
 */
LazyLord._aer_walk = function (ctx, group, matrix, scan, layerName, name, opacity) {
  var node = { name: name, opacity: opacity, items: [], paths: [] };
  var above = node.paths;
  for (var i = 1; i <= group.numProperties; i++) {
    var prop = group.property(i);
    var mn;
    try { mn = prop.matchName; } catch (e) { continue; }
    try { if (prop.enabled === false) continue; } catch (e2) {}

    if (mn === "ADBE Vector Group") {
      var childMatrix = matrix;
      var childOpacity = 1;
      try {
        var tg = prop.property("ADBE Vector Transform Group");
        if (tg) {
          childMatrix = LazyLord._aer_compose(matrix, LazyLord._aer_trs(
            LazyLord._aer_val(tg, "ADBE Vector Anchor", [0, 0]),
            LazyLord._aer_val(tg, "ADBE Vector Position", [0, 0]),
            LazyLord._aer_val(tg, "ADBE Vector Scale", [100, 100]),
            LazyLord._aer_val(tg, "ADBE Vector Rotation", 0)
          ));
          var go = LazyLord._aer_val(tg, "ADBE Vector Group Opacity", 100);
          if (LazyLord._aer_isNum(go)) childOpacity = Math.max(0, Math.min(1, go / 100));
        }
      } catch (e3) {}
      var inner = prop.property("ADBE Vectors Group");
      if (inner) {
        var child = LazyLord._aer_walk(ctx, inner, childMatrix, scan, layerName,
                                       LazyLord._aer_nameOf(prop), childOpacity);
        for (var c = 0; c < child.paths.length; c++) above.push(child.paths[c]);
        node.items.push({ group: child });
      }

    } else if (mn === "ADBE Vector Shape - Group") {
      LazyLord._aer_addPath(scan, above, LazyLord._aer_path(prop, matrix));

    } else if (mn === "ADBE Vector Shape - Rect") {
      LazyLord._aer_addPath(scan, above, LazyLord._aer_rect(prop, matrix));

    } else if (mn === "ADBE Vector Shape - Ellipse") {
      LazyLord._aer_addPath(scan, above, LazyLord._aer_ellipse(prop, matrix));

    } else if (mn === "ADBE Vector Shape - Star") {
      LazyLord._aer_addPath(scan, above, LazyLord._aer_star(prop, matrix, layerName));

    } else if (mn === "ADBE Vector Graphic - Fill" || mn === "ADBE Vector Graphic - Stroke") {
      var isFill = mn === "ADBE Vector Graphic - Fill";
      var paint = isFill ? LazyLord._aer_fill(prop) : LazyLord._aer_stroke(prop, matrix);
      // A colour that cannot be read is reported with its paint set
      // (_aer_paintSets), where what is sent in its place is known.
      LazyLord._aer_addOp(node, scan, prop, isFill ? "fill" : "stroke", paint, false);

    } else if (mn === "ADBE Vector Graphic - G-Fill" || mn === "ADBE Vector Graphic - G-Stroke") {
      // Its paths are still painted in After Effects, just not in a colour
      // that can be read; reported with its paint set, like an unread colour.
      LazyLord._aer_addOp(node, scan, prop, mn === "ADBE Vector Graphic - G-Fill" ? "fill" : "stroke", null, true);

    } else if (mn === "ADBE Vector Filter - Merge" || mn === "ADBE Vector Filter - Trim" ||
               mn === "ADBE Vector Filter - Repeater" || mn === "ADBE Vector Filter - Offset" ||
               mn === "ADBE Vector Filter - RC" || mn === "ADBE Vector Filter - Twist" ||
               mn === "ADBE Vector Filter - Zigzag" || mn === "ADBE Vector Filter - Wiggler" ||
               mn === "ADBE Vector Filter - Roughen" || mn === "ADBE Vector Filter - PB") {
      LazyLord.warn(layerName, "Path operator '" + prop.name + "' is not applied; the raw paths are sent", "approximated");
    }
  }
  return node;
};

/** Record a drawn path (comp space) as one more path above what follows. */
LazyLord._aer_addPath = function (scan, above, sp) {
  if (!sp) return;
  above.push(scan.paths.length);
  scan.paths.push(sp);
};

/**
 * Record a paint over every path met so far in `node` (its `paths`). `paint`
 * is the IR fill or stroke, or null for one that cannot be read; `gradient`
 * marks a Gradient Fill or Stroke, which never can be. One with no paths above
 * it paints nothing, so it is neither kept nor reported. A paint composited
 * "Above Previous in Same Group" (Composite 2) is flagged, since contents
 * order is what the stack follows.
 */
LazyLord._aer_addOp = function (node, scan, prop, kind, paint, gradient) {
  if (!node.paths.length) return;
  var paths = node.paths.slice(0);
  for (var i = 0; i < paths.length; i++) scan.painted[paths[i]] = true;
  scan.ops++;
  node.items.push({ op: {
    kind: kind,
    paint: paint,
    gradient: gradient === true,
    prop: prop,
    name: LazyLord._aer_nameOf(prop),
    aboveOrder: LazyLord._aer_val(prop, "ADBE Vector Composite Order", 1) === 2,
    paths: paths
  }});
};

/** A drawn path: read the Shape value and bake the matrix into it. */
LazyLord._aer_path = function (pathGroup, matrix) {
  var shape;
  try { shape = pathGroup.property("ADBE Vector Shape").value; } catch (e) { return null; }
  return LazyLord._aer_shapeToSub(shape, matrix);
};

/** Any AE Shape value (shape path or mask path), baked through `matrix`. */
LazyLord._aer_shapeToSub = function (shape, matrix) {
  if (!shape || !shape.vertices || shape.vertices.length === 0) return null;

  var verts = [], ins = [], outs = [];
  for (var i = 0; i < shape.vertices.length; i++) {
    verts.push(LazyLord._aer_apply(matrix, shape.vertices[i]));
    ins.push(LazyLord._aer_applyVec(matrix, (shape.inTangents && shape.inTangents[i]) || [0, 0]));
    outs.push(LazyLord._aer_applyVec(matrix, (shape.outTangents && shape.outTangents[i]) || [0, 0]));
  }
  return { closed: shape.closed === true, vertices: verts, inTangents: ins, outTangents: outs };
};

/** Kappa: the circle-to-bezier constant. */
LazyLord._aer_K = 0.5522847498307936;

LazyLord._aer_rect = function (prop, matrix) {
  var size = LazyLord._aer_val(prop, "ADBE Vector Rect Size", [100, 100]);
  var pos = LazyLord._aer_val(prop, "ADBE Vector Rect Position", [0, 0]);
  var round = LazyLord._aer_val(prop, "ADBE Vector Rect Roundness", 0);

  var hw = size[0] / 2, hh = size[1] / 2;
  var cx = pos[0], cy = pos[1];
  var r = Math.max(0, Math.min(round, Math.min(hw, hh)));

  var verts = [], ins = [], outs = [];

  function push(p, i, o) {
    verts.push(LazyLord._aer_apply(matrix, p));
    ins.push(LazyLord._aer_applyVec(matrix, i || [0, 0]));
    outs.push(LazyLord._aer_applyVec(matrix, o || [0, 0]));
  }

  if (r <= 0) {
    // AE draws rectangles clockwise starting from the top-right.
    push([cx + hw, cy - hh]);
    push([cx + hw, cy + hh]);
    push([cx - hw, cy + hh]);
    push([cx - hw, cy - hh]);
  } else {
    var k = LazyLord._aer_K * r;
    push([cx + hw, cy - hh + r], [0, -k], [0, 0]);          // right edge, top
    push([cx + hw, cy + hh - r], [0, 0], [0, k]);           // right edge, bottom
    push([cx + hw - r, cy + hh], [k, 0], [0, 0]);           // bottom edge, right
    push([cx - hw + r, cy + hh], [0, 0], [-k, 0]);          // bottom edge, left
    push([cx - hw, cy + hh - r], [0, k], [0, 0]);           // left edge, bottom
    push([cx - hw, cy - hh + r], [0, 0], [0, -k]);          // left edge, top
    push([cx - hw + r, cy - hh], [-k, 0], [0, 0]);          // top edge, left
    push([cx + hw - r, cy - hh], [0, 0], [k, 0]);           // top edge, right
  }

  return { closed: true, vertices: verts, inTangents: ins, outTangents: outs };
};

LazyLord._aer_ellipse = function (prop, matrix) {
  var size = LazyLord._aer_val(prop, "ADBE Vector Ellipse Size", [100, 100]);
  var pos = LazyLord._aer_val(prop, "ADBE Vector Ellipse Position", [0, 0]);

  var rx = size[0] / 2, ry = size[1] / 2;
  var cx = pos[0], cy = pos[1];
  var kx = LazyLord._aer_K * rx, ky = LazyLord._aer_K * ry;

  var raw = [
    { p: [cx, cy - ry], i: [-kx, 0], o: [kx, 0] },  // top
    { p: [cx + rx, cy], i: [0, -ky], o: [0, ky] },  // right
    { p: [cx, cy + ry], i: [kx, 0], o: [-kx, 0] },  // bottom
    { p: [cx - rx, cy], i: [0, ky], o: [0, -ky] }   // left
  ];

  var verts = [], ins = [], outs = [];
  for (var i = 0; i < raw.length; i++) {
    verts.push(LazyLord._aer_apply(matrix, raw[i].p));
    ins.push(LazyLord._aer_applyVec(matrix, raw[i].i));
    outs.push(LazyLord._aer_applyVec(matrix, raw[i].o));
  }
  return { closed: true, vertices: verts, inTangents: ins, outTangents: outs };
};

LazyLord._aer_star = function (prop, matrix, layerName) {
  var type = LazyLord._aer_val(prop, "ADBE Vector Star Type", 1); // 1 star, 2 polygon
  var points = Math.max(3, Math.round(LazyLord._aer_val(prop, "ADBE Vector Star Points", 5)));
  var pos = LazyLord._aer_val(prop, "ADBE Vector Star Position", [0, 0]);
  var rot = LazyLord._aer_val(prop, "ADBE Vector Star Rotation", 0);
  var outerR = LazyLord._aer_val(prop, "ADBE Vector Star Outer Radius", 50);
  var innerR = LazyLord._aer_val(prop, "ADBE Vector Star Inner Radius", 25);

  // AE spells these "Roundess" in its match names.
  var outerRound = LazyLord._aer_val(prop, "ADBE Vector Star Outer Roundess", 0);
  var innerRound = LazyLord._aer_val(prop, "ADBE Vector Star Inner Roundess", 0);
  if (outerRound || innerRound) {
    LazyLord.warn(layerName, "Star roundness is dropped; corners come through sharp", "approximated");
  }

  var isStar = (type === 1);
  var count = isStar ? points * 2 : points;
  var step = 360 / count;

  var verts = [];
  for (var i = 0; i < count; i++) {
    // AE starts at the top and turns clockwise.
    var deg = -90 + rot + i * step;
    var rad = deg * Math.PI / 180;
    var r = (!isStar || i % 2 === 0) ? outerR : innerR;
    verts.push(LazyLord._aer_apply(matrix, [pos[0] + r * Math.cos(rad), pos[1] + r * Math.sin(rad)]));
  }

  var ins = [], outs = [];
  for (var v = 0; v < verts.length; v++) { ins.push([0, 0]); outs.push([0, 0]); }
  return { closed: true, vertices: verts, inTangents: ins, outTangents: outs };
};

LazyLord._aer_fill = function (prop) {
  var c = LazyLord._aer_val(prop, "ADBE Vector Fill Color", null);
  if (!c) return null;
  var op = LazyLord._aer_val(prop, "ADBE Vector Fill Opacity", 100);
  return { type: "solid", color: { r: c[0], g: c[1], b: c[2], a: op / 100 } };
};

LazyLord._aer_stroke = function (prop, matrix) {
  var c = LazyLord._aer_val(prop, "ADBE Vector Stroke Color", null);
  if (!c) return null;
  var op = LazyLord._aer_val(prop, "ADBE Vector Stroke Opacity", 100);
  var w = LazyLord._aer_val(prop, "ADBE Vector Stroke Width", 1);
  var cap = LazyLord._aer_val(prop, "ADBE Vector Stroke Line Cap", 1);
  var join = LazyLord._aer_val(prop, "ADBE Vector Stroke Line Join", 1);

  var capNames = { 1: "none", 2: "round", 3: "square" };
  var joinNames = { 1: "miter", 2: "round", 3: "bevel" };

  return {
    paint: { type: "solid", color: { r: c[0], g: c[1], b: c[2], a: op / 100 } },
    // Stroke width lives in layer space, so it scales with the baked transform.
    weight: w * LazyLord._aer_scaleOf(matrix),
    cap: capNames[cap] || "none",
    join: joinNames[join] || "miter",
    align: "center"
  };
};

/* -------------------------------------------------------------------------
 * Turned boxes — text and footage keep their turn
 * ---------------------------------------------------------------------- */

LazyLord._aer_SKEW = 1e-3; // |cos| of the angle between the layer's axes: 0.06 degrees off square
LazyLord._aer_EVEN = 1e-3; // relative difference between the axis scales still taken as even

/**
 * How the comp-space affine `m` carries a layer-space rect
 * { left, top, width, height } that cannot be baked (text, footage):
 *   frame    the unrotated box: the rect scaled by the matrix's own axis
 *            lengths, centred on M * (rect centre), in comp space;
 *   rotation clockwise degrees about that box's centre, atan2(m[1], m[0]):
 *            AE turns clockwise in its y-down space, which is the IR's convention;
 *   bbox     the upright outer box of the turned rect — the selection bounds only;
 *   origin   where the layer's own (0,0) lies once the box is turned back
 *            upright, which is how a text anchor is stored (the builders call
 *            LazyLord.rotatedTextAnchor, which turns it forward again).
 * No turn undoes a mirror, so it is dropped along whichever axis leaves the
 * layer nearest upright (as the Illustrator reader does), reflected about the
 * rect centre so the box stays where AE shows it. Skew (only a parent's uneven
 * scale can make it), a mirror and, on text, uneven scale — glyphs cannot be
 * stretched — are reported against `name`.
 */
LazyLord._aer_turnedBox = function (name, m, rect, isText) {
  var a = m[0], b = m[1], c = m[2], d = m[3];
  var sx = Math.sqrt(a * a + b * b), sy = Math.sqrt(c * c + d * d);
  var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  var centre = LazyLord._aer_apply(m, [cx, cy]);
  var width = Math.abs(rect.width) * sx, height = Math.abs(rect.height) * sy;

  // The turn of the x axis; the y axis gives it when x is collapsed to nothing.
  var rad = sx > 1e-9 ? Math.atan2(b, a) : Math.atan2(-c, d);
  var origin = [0, 0];
  var skewed = Math.abs(a * c + b * d) > LazyLord._aer_SKEW * sx * sy;
  if (a * d - b * c < 0) {
    // Keeping the y axis drops the mirror along x, and the other way round.
    var radY = Math.atan2(-c, d);
    if (Math.abs(radY) < Math.abs(rad)) {
      rad = radY;
      origin = [2 * cx, 0];
    } else {
      origin = [0, 2 * cy];
    }
    LazyLord.warn(name, "It is mirrored, which a turned box cannot hold; it is sent unmirrored in the same place",
      "approximated");
  }
  if (skewed) {
    LazyLord.warn(name, "It is skewed by an unevenly scaled parent, which a turned box cannot hold; " +
      "it is sent as the nearest turned box", "approximated");
  } else if (isText && Math.abs(sx - sy) > LazyLord._aer_EVEN * Math.max(sx, sy)) {
    LazyLord.warn(name, "Its uneven scale (" + Math.round(sx * 100) + "% x " + Math.round(sy * 100) +
      "%) stretches the glyphs, which live text cannot hold; the font is sized at the average scale",
      "approximated");
  }

  var rot = rad * 180 / Math.PI;
  if (rot <= -180) rot += 360;
  if (Math.abs(rot) < 1e-9) rot = 0;

  var left = rect.left, top = rect.top, right = rect.left + rect.width, bottom = rect.top + rect.height;
  return {
    frame: { x: centre[0] - width / 2, y: centre[1] - height / 2, width: width, height: height },
    rotation: rot,
    bbox: LazyLord._aer_bboxOf([
      LazyLord._aer_apply(m, [left, top]),
      LazyLord._aer_apply(m, [right, top]),
      LazyLord._aer_apply(m, [right, bottom]),
      LazyLord._aer_apply(m, [left, bottom])
    ]),
    origin: LazyLord.rotatePoint(LazyLord._aer_apply(m, origin), centre, -rot)
  };
};

/* -------------------------------------------------------------------------
 * Text layers
 * ---------------------------------------------------------------------- */

LazyLord._aer_text = function (ctx, layer) {
  var td;
  try {
    td = layer.property("ADBE Text Properties").property("ADBE Text Document").value;
  } catch (e) {
    LazyLord.warn(layer.name, "Could not read the text properties", "skipped");
    return null;
  }

  var matrix = LazyLord._aer_layerMatrix(ctx, layer);
  var scale = LazyLord._aer_scaleOf(matrix);

  var family = "Helvetica", style = "Regular";
  try {
    if (td.fontFamily) { family = td.fontFamily; style = td.fontStyle || "Regular"; }
    else if (td.font) { family = td.font; }
  } catch (e2) {}

  var color = { r: 0, g: 0, b: 0, a: 1 };
  try {
    if (td.applyFill !== false && td.fillColor) {
      color = { r: td.fillColor[0], g: td.fillColor[1], b: td.fillColor[2], a: 1 };
    }
  } catch (e3) {}

  var size = (td.fontSize || 24) * scale;

  var align = "left";
  try {
    if (td.justification === ParagraphJustification.CENTER_JUSTIFY) align = "center";
    else if (td.justification === ParagraphJustification.RIGHT_JUSTIFY) align = "right";
    else if (td.justification !== ParagraphJustification.LEFT_JUSTIFY) align = "justified";
  } catch (e4) {}

  try { if (td.boxText === true) LazyLord.warn(layer.name, "Paragraph text is rebuilt as point text", "approximated"); } catch (e5) {}

  // sourceRectAtTime gives the drawn extent in layer space, where point text
  // sits on its baseline at the layer's own origin.
  var rect = null;
  try { rect = layer.sourceRectAtTime(ctx.time, false); } catch (e6) {}
  if (!rect || !LazyLord._aer_isNum(rect.left) || !LazyLord._aer_isNum(rect.top) ||
      !LazyLord._aer_isNum(rect.width) || !LazyLord._aer_isNum(rect.height)) {
    var fs = td.fontSize || 24;
    rect = { left: 0, top: -fs, width: fs, height: fs };
    LazyLord.warn(layer.name, "Its text extent could not be measured, so its box is estimated from the font size; " +
      "its baseline and turn are exact", "approximated");
  }
  // The unrotated box and its turn; the baseline anchor is stored unturned.
  var tb = LazyLord._aer_turnedBox(layer.name, matrix, rect, true);

  return {
    type: "text",
    id: LazyLord._aer_id(ctx, layer),
    name: layer.name,
    opacity: LazyLord._aer_layerOpacity(layer),
    bbox: tb.bbox,
    frame: tb.frame,
    rotation: tb.rotation,
    anchor: tb.origin,
    characters: td.text || "",
    fontFamily: family,
    fontStyle: style,
    fontSize: size,
    color: color,
    letterSpacing: ((td.tracking || 0) / 1000) * size,
    lineHeight: td.autoLeading === false ? (td.leading || 0) * scale : 0,
    textAlignHorizontal: align
  };
};

/* -------------------------------------------------------------------------
 * Footage and solid layers
 * ---------------------------------------------------------------------- */

LazyLord._aer_av = function (ctx, layer) {
  var src = layer.source;

  if (src instanceof CompItem) {
    LazyLord.warn(layer.name, "Precomps are not transferred; send their contents instead", "skipped");
    return null;
  }
  if (!(src instanceof FootageItem)) {
    LazyLord.warn(layer.name, "Unsupported layer source", "skipped");
    return null;
  }

  var w = layer.width || 0;
  var h = layer.height || 0;

  // Preferred branch: hand over the user's own file untouched.
  var filePath = null;
  try { if (src.file && src.file.exists) filePath = src.file.fsName; } catch (e) {}
  if (filePath) {
    // Footage cannot be baked: it keeps its unrotated box and turn.
    var tb = LazyLord._aer_turnedBox(layer.name, LazyLord._aer_layerMatrix(ctx, layer),
                                     { left: 0, top: 0, width: w, height: h }, false);
    return {
      type: "image",
      id: LazyLord._aer_id(ctx, layer),
      name: layer.name,
      opacity: LazyLord._aer_layerOpacity(layer),
      bbox: tb.bbox,
      frame: tb.frame,
      rotation: tb.rotation,
      filePath: filePath,
      isOriginalFile: true,
      pixelWidth: w,
      pixelHeight: h
    };
  }

  // A solid has no file, but it is just a coloured rectangle, baked like any vector.
  var solid = null;
  try { if (src.mainSource instanceof SolidSource) solid = src.mainSource.color; } catch (e2) {}
  if (solid) {
    var matrix = LazyLord._aer_layerMatrix(ctx, layer);
    var bbox = LazyLord._aer_bboxOf([
      LazyLord._aer_apply(matrix, [0, 0]),
      LazyLord._aer_apply(matrix, [w, 0]),
      LazyLord._aer_apply(matrix, [w, h]),
      LazyLord._aer_apply(matrix, [0, h])
    ]);
    return LazyLord._aer_solidRect(ctx, layer, matrix, w, h, bbox, solid);
  }

  LazyLord.warn(layer.name, "This footage has no file on disk to hand over", "skipped");
  return null;
};

/** Turn a solid layer into a filled rectangle. */
LazyLord._aer_solidRect = function (ctx, layer, matrix, w, h, bbox, color) {
  var corners = [[0, 0], [w, 0], [w, h], [0, h]];
  var verts = [], ins = [], outs = [];
  for (var i = 0; i < corners.length; i++) {
    verts.push(LazyLord._aer_apply(matrix, corners[i]));
    ins.push([0, 0]);
    outs.push([0, 0]);
  }

  // A solid with a Gradient Ramp is the classic AE gradient background. Its
  // effects run before the transform, so the ramp's points are layer pixels.
  var fill = LazyLord._aer_ramp(layer, matrix) ||
    { type: "solid", color: { r: color[0], g: color[1], b: color[2], a: 1 } };

  return {
    type: "vector",
    id: LazyLord._aer_id(ctx, layer),
    name: layer.name,
    opacity: LazyLord._aer_layerOpacity(layer),
    bbox: bbox,
    subpaths: [{ closed: true, vertices: verts, inTangents: ins, outTangents: outs }],
    fills: [fill],
    strokes: [],
    windingRule: "nonzero"
  };
};

/* -------------------------------------------------------------------------
 * Gradient Ramp — the gradient round trip
 * ---------------------------------------------------------------------- */

/**
 * An enabled Gradient Ramp effect read back as a 2-stop gradient paint with
 * comp-space handles; _aer_normalise expresses them in the layer box once
 * that is known. Returns null when AE shows no ramp: none enabled, the
 * layer's effects switched off (the fx switch), or a ramp blended away.
 *
 * `matrix` carries the ramp's points into comp space: the identity for shape
 * layers (their effects run after the transform, so the points are comp
 * space already), the layer matrix for solids (effects before the transform).
 */
LazyLord._aer_ramp = function (layer, matrix) {
  try { if (layer.effectsActive === false) return null; } catch (e0) {}
  var parade = null;
  try { parade = layer.property("ADBE Effect Parade"); } catch (e) {}
  if (!parade) return null;
  var count = 0;
  try { count = parade.numProperties || 0; } catch (e2) {}

  var ramp = null;
  for (var i = 1; i <= count; i++) {
    var fx = parade.property(i);
    try {
      if (!fx || fx.matchName !== "ADBE Ramp" || fx.enabled === false) continue;
    } catch (e3) { continue; }
    if (ramp) {
      LazyLord.warn(layer.name, "Only the first Gradient Ramp is read; '" + fx.name + "' is not sent", "approximated");
      continue;
    }
    ramp = fx;
  }
  if (!ramp) return null;

  // Match names first; the fixed parameter order as the fallback.
  var start = LazyLord._aer_fxVal(ramp, "ADBE Ramp-0001", 1, null);
  var startColour = LazyLord._aer_fxVal(ramp, "ADBE Ramp-0002", 2, null);
  var end = LazyLord._aer_fxVal(ramp, "ADBE Ramp-0003", 3, null);
  var endColour = LazyLord._aer_fxVal(ramp, "ADBE Ramp-0004", 4, null);
  var rampShape = LazyLord._aer_fxVal(ramp, "ADBE Ramp-0005", 5, 1); // 1 linear, 2 radial

  if (!start || !end || !startColour || !endColour) {
    LazyLord.warn(layer.name, "Its Gradient Ramp could not be read; the layer keeps its flat fill", "approximated");
    return null;
  }

  var blend = LazyLord._aer_fxVal(ramp, "ADBE Ramp-0007", 7, 0);
  // Fully blended, AE shows only the original, which the caller keeps as is.
  if (blend >= 100) return null;
  if (blend > 0) {
    LazyLord.warn(layer.name, "Gradient Ramp is blended " + blend + "% with the original; only the ramp is sent", "approximated");
  }

  var radial = rampShape === 2;
  var h = LazyLord._aer_rampHandles(layer.name, matrix, start, end, radial);
  return {
    type: radial ? "radial-gradient" : "linear-gradient",
    stops: [
      { position: 0, color: LazyLord._aer_rgba(startColour) },
      { position: 1, color: LazyLord._aer_rgba(endColour) }
    ],
    // Comp-space handles; replaced by 0..1 box coordinates in _aer_normalise.
    _aerFrom: h.from,
    _aerTo: h.to
  };
};

/**
 * Ramp handles from the effect's own space into comp space through `m`.
 *
 * Linear: what must survive is the ramp's value at every pixel, and its
 * isolines run perpendicular to the handle line in the effect's space. A
 * non-uniform scale tilts them, so the end handle is not moved as a point but
 * rebuilt from the carried gradient direction g = M^-T d / |d|^2 (d = end -
 * start): the IR line then runs from M*start to M*start + g / |g|^2. Under
 * rotation and uniform scale that is simply M*end.
 *
 * Radial: the IR holds circles only. Exact under rotation and uniform scale;
 * otherwise AE draws an ellipse, sent as the circle of the same area.
 */
LazyLord._aer_rampHandles = function (layerName, m, start, end, radial) {
  var from = LazyLord._aer_apply(m, start);
  var dx = end[0] - start[0], dy = end[1] - start[1];
  var len2 = dx * dx + dy * dy;
  if (!len2) return { from: from, to: [from[0], from[1]] };
  var a = m[0], b = m[1], c = m[2], d = m[3];

  if (radial) {
    var c1 = a * a + b * b, c2 = c * c + d * d, dot = a * c + b * d;
    var tol = 1e-6 * Math.max(c1, c2);
    if (Math.abs(c1 - c2) > tol || Math.abs(dot) > tol) {
      LazyLord.warn(layerName, "Its radial Gradient Ramp is stretched into an ellipse by the layer's uneven scale, " +
        "which a radial gradient cannot hold; it is sent as the circle of the same area", "approximated");
    }
    var v = LazyLord._aer_applyVec(m, [dx, dy]);
    var vl = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    if (!vl) return { from: from, to: [from[0], from[1]] };
    var r = Math.sqrt(len2) * LazyLord._aer_scaleOf(m);
    return { from: from, to: [from[0] + v[0] / vl * r, from[1] + v[1] / vl * r] };
  }

  var det = a * d - b * c;
  if (!det) return { from: from, to: LazyLord._aer_apply(m, end) };
  var gx = (d * dx - b * dy) / det / len2;
  var gy = (-c * dx + a * dy) / det / len2;
  var g2 = gx * gx + gy * gy;
  return { from: from, to: [from[0] + gx / g2, from[1] + gy / g2] };
};

/**
 * Put a shape layer's ramp on what AE actually recolours with it: the fill
 * and the stroke, whichever the layer has. The ramp keeps the pixels' alpha,
 * so each takes it at its own opacity — which is where LazyLord's AE builder
 * puts a gradient's transparency. A paint the layer lacks is never added.
 */
LazyLord._aer_rampPaints = function (acc, ramp) {
  if (acc.fills.length) {
    acc.fills = [LazyLord._aer_rampAlpha(ramp, LazyLord._aer_paintAlpha(acc.fills[0]))];
  }
  if (acc.strokes.length) {
    var s = acc.strokes[0];
    acc.strokes = [{ paint: LazyLord._aer_rampAlpha(ramp, LazyLord._aer_paintAlpha(s.paint)),
                     weight: s.weight, cap: s.cap, join: s.join, align: s.align }];
  }
};

/** A solid paint's alpha, 1 for anything else. */
LazyLord._aer_paintAlpha = function (paint) {
  return (paint && paint.color && typeof paint.color.a === "number") ? paint.color.a : 1;
};

/** A copy of a ramp paint with every stop's alpha multiplied by `alpha`. */
LazyLord._aer_rampAlpha = function (ramp, alpha) {
  var stops = [];
  for (var i = 0; i < ramp.stops.length; i++) {
    var c = ramp.stops[i].color;
    stops.push({ position: ramp.stops[i].position, color: { r: c.r, g: c.g, b: c.b, a: c.a * alpha } });
  }
  return {
    type: ramp.type,
    stops: stops,
    _aerFrom: [ramp._aerFrom[0], ramp._aerFrom[1]],
    _aerTo: [ramp._aerTo[0], ramp._aerTo[1]]
  };
};

/** An effect parameter by match name, else by its position in the effect. */
LazyLord._aer_fxVal = function (fx, matchName, index, fallback) {
  try {
    var p = fx.property(matchName);
    if (p) return p.value;
  } catch (e) {}
  try {
    var q = fx.property(index);
    if (q) return q.value;
  } catch (e2) {}
  return fallback;
};

/** AE colour array [r, g, b(, a)] 0..1 -> IR RGBA. */
LazyLord._aer_rgba = function (c) {
  return { r: c[0], g: c[1], b: c[2], a: (typeof c[3] === "number") ? c[3] : 1 };
};

/* -------------------------------------------------------------------------
 * Masks and track mattes — these apply to every layer type
 * ---------------------------------------------------------------------- */

/**
 * Attach a layer's masks as its clip, and report a track matte. A shape layer
 * sent as a group is clipped as a whole, so every vector in it takes the clip
 * (each its own copy once normalised, under the one mask id).
 */
LazyLord._aer_extras = function (ctx, layer, raw) {
  try {
    var clip = LazyLord._aer_masks(layer, raw);
    if (clip) LazyLord._aer_clipLeaves(raw, clip);
  } catch (e) {
    LazyLord.warn(layer.name, "Its masks could not be read; the layer arrives unclipped", "approximated");
  }
  try {
    LazyLord._aer_trackMatte(ctx, layer);
  } catch (e2) {}
};

/** Give every leaf of a raw layer tree the same raw clip. */
LazyLord._aer_clipLeaves = function (raw, clip) {
  if (raw.type !== "group") { raw.clip = clip; return; }
  for (var i = 0; i < raw.children.length; i++) LazyLord._aer_clipLeaves(raw.children[i], clip);
};

/**
 * A layer's masks -> one clip in comp space (baked through the layer matrix,
 * exactly like the geometry). Returns null when nothing clips.
 *
 * AE combines masks top to bottom, each with the result so far. A clip holds
 * the stacks made of Add and Difference masks, which is what LazyLord's AE
 * builder writes:
 *  - one Add followed only by Differences is exclusive-or in order, which is
 *    exactly even-odd parity: all contours, "evenodd", orientation untouched;
 *  - otherwise "nonzero", with the Adds turned one way (they union) and the
 *    Differences the other (they cut holes). That is the inverse of how the
 *    builder writes a nonzero clip, so those come back unchanged.
 * Other modes and inverted masks are dropped and reported. A stack that does
 * not open with a plain Add starts from the whole layer (layer minus a
 * Subtract mask, say), so it is not clipped at all rather than cut to its Adds.
 */
LazyLord._aer_masks = function (layer, raw) {
  var parade = null;
  try { parade = layer.property("ADBE Mask Parade"); } catch (e) {}
  if (!parade) return null;
  var count = 0;
  try { count = parade.numProperties || 0; } catch (e2) {}
  if (!count) return null;

  var matrix = LazyLord._aer_layerTRS(layer);

  // The masks that shape the layer: enabled, not None, with a closed path.
  var used = [];
  for (var i = 1; i <= count; i++) {
    var mask = parade.property(i);
    if (!mask) continue;
    var maskName = "Mask " + i;
    try { if (mask.name) maskName = mask.name; } catch (e3) {}
    var label = "Mask '" + maskName + "'";

    try { if (mask.enabled === false) continue; } catch (e4) {}

    var mode = LazyLord._aer_maskMode(mask);
    if (mode === "None") continue; // draws nothing and clips nothing

    var shape = null;
    try { shape = mask.property("ADBE Mask Shape").value; } catch (e5) {}
    var sp = LazyLord._aer_shapeToSub(shape, matrix);
    if (!sp) {
      LazyLord.warn(layer.name, label + " has no readable path; it is dropped", "skipped");
      continue;
    }
    // An open mask path never cuts anything away in AE, so it has no clip to give.
    if (!sp.closed) continue;

    var inverted = false;
    try { inverted = mask.inverted === true; } catch (e6) {}
    used.push({ mask: mask, name: maskName, label: label, mode: mode,
                inverted: inverted, shape: shape, sp: sp });
  }
  if (used.length === 0) return null;

  var firstAdd = -1;
  for (var f = 0; f < used.length; f++) {
    if (used[f].mode === "Add" && !used[f].inverted) { firstAdd = f; break; }
  }
  if (firstAdd > 0) {
    var lead = used[0];
    LazyLord.warn(layer.name, "Its masks start with " + lead.label +
      (lead.inverted ? ", which is inverted" : " in " + lead.mode + " mode") +
      ", so they cut from the whole layer, which a clip cannot express; the layer arrives unclipped", "approximated");
    return null;
  }

  // Keep plain Adds and Differences (only after an Add); report the rest.
  var kept = [], adds = 0, diffs = 0;
  for (var k = 0; k < used.length; k++) {
    var u = used[k];
    var keepable = firstAdd === 0 && (u.mode === "Add" || u.mode === "Difference");
    if (!keepable && u.mode !== "Add") {
      LazyLord.warn(layer.name, u.label + " uses " + u.mode + " mode, which a clip cannot express; it is dropped", "approximated");
      continue;
    }
    if (u.inverted || !keepable) {
      LazyLord.warn(layer.name, u.label + " is inverted, which a clip cannot express; it is dropped", "approximated");
      continue;
    }
    LazyLord._aer_maskLosses(layer.name, u.mask, u.label, u.shape);
    if (u.mode === "Add") adds++; else diffs++;
    kept.push(u);
  }
  if (kept.length === 0) return null;

  var evenodd = adds === 1 && diffs > 0;
  var subs = [];
  for (var s = 0; s < kept.length; s++) {
    var sub = kept[s].sp;
    if (!evenodd && kept.length > 1) {
      var want = kept[s].mode === "Add" ? 1 : -1;
      if (want * LazyLord._aer_signedArea(sub) < 0) sub = LazyLord._aer_reverse(sub);
    }
    subs.push(sub);
  }

  return {
    id: "ae-mask-" + String(raw.id).replace(/^ae-/, ""),
    name: kept[0].name,
    subpaths: subs,
    windingRule: evenodd ? "evenodd" : "nonzero"
  };
};

/** A mask's mode as a word for messages: "Add", "Subtract", "None"… */
LazyLord._aer_maskMode = function (mask) {
  var mode;
  try { mode = mask.maskMode; } catch (e) { return "an unreadable"; }
  if (mode === undefined || mode === null) return "an unreadable";
  var names = ["NONE", "None", "ADD", "Add", "SUBTRACT", "Subtract", "INTERSECT", "Intersect",
               "LIGHTEN", "Lighten", "DARKEN", "Darken", "DIFFERENCE", "Difference"];
  for (var i = 0; i < names.length; i += 2) {
    try { if (mode === MaskMode[names[i]]) return names[i + 1]; } catch (e2) {}
  }
  return "an unrecognised";
};

/** Report what a used mask carries that a hard-edged clip path cannot. */
LazyLord._aer_maskLosses = function (layerName, mask, label, shape) {
  var feather = LazyLord._aer_val(mask, "ADBE Mask Feather", [0, 0]);
  var soft = (typeof feather === "number") ? feather !== 0
    : !!(feather && ((feather[0] || 0) !== 0 || (feather[1] || 0) !== 0));
  if (soft) {
    LazyLord.warn(layerName, label + " has a feather, which is dropped; the clip edge arrives hard", "approximated");
  }

  // Variable-width feather (the Mask Feather tool) lives on the path value
  // itself, not on Mask Feather; inner points carry negative radii.
  var points = false;
  try {
    var radii = shape ? shape.featherRadii : null;
    if (radii && radii.length) {
      for (var r = 0; r < radii.length; r++) {
        if (radii[r]) { points = true; break; }
      }
    }
  } catch (e) {}
  if (points) {
    LazyLord.warn(layerName, label + " has variable feather points, which are dropped; the clip edge arrives hard", "approximated");
  }

  var grow = LazyLord._aer_val(mask, "ADBE Mask Offset", 0);
  if (grow) {
    LazyLord.warn(layerName, label + " has a " + grow + " px expansion, which is dropped; the clip follows the drawn path", "approximated");
  }

  var opacity = LazyLord._aer_val(mask, "ADBE Mask Opacity", 100);
  if (opacity < 100) {
    LazyLord.warn(layerName, label + " is at " + opacity + "% opacity; the clip is applied fully opaque", "approximated");
  }
};

/**
 * Signed area of a subpath's control polygon. Positive is clockwise on screen
 * in the y-down space; the control polygon keeps the curve's orientation.
 */
LazyLord._aer_signedArea = function (sp) {
  var n = sp.vertices.length, pts = [];
  for (var i = 0; i < n; i++) {
    var v = sp.vertices[i], o = sp.outTangents[i] || [0, 0];
    var w = sp.vertices[(i + 1) % n], t = sp.inTangents[(i + 1) % n] || [0, 0];
    pts.push(v, [v[0] + o[0], v[1] + o[1]], [w[0] + t[0], w[1] + t[1]]);
  }
  var a = 0;
  for (var k = 0; k < pts.length; k++) {
    var p = pts[k], q = pts[(k + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

/** The same contour walked the other way: order reversed, in/out handles swapped. */
LazyLord._aer_reverse = function (sp) {
  var verts = [], ins = [], outs = [];
  for (var i = sp.vertices.length - 1; i >= 0; i--) {
    verts.push(sp.vertices[i]);
    ins.push(sp.outTangents[i] || [0, 0]);
    outs.push(sp.inTangents[i] || [0, 0]);
  }
  return { closed: sp.closed, vertices: verts, inTangents: ins, outTangents: outs };
};

/**
 * Track mattes live outside the layer (another layer's pixels), so the IR has
 * nothing to carry them in. AE 2023+ names the matte layer directly, and a
 * matte removed there keeps its trackMatteType, so only trackMatteLayer (or
 * hasTrackMatte) decides. Older versions always use the layer just above.
 */
LazyLord._aer_trackMatte = function (ctx, layer) {
  var modern = false, matte = null, has = null;
  try {
    if (typeof layer.trackMatteLayer !== "undefined") {
      modern = true;
      matte = layer.trackMatteLayer || null;
    }
  } catch (e) {}
  try { if (typeof layer.hasTrackMatte === "boolean") has = layer.hasTrackMatte; } catch (e2) {}

  var uses = false;
  if (modern) {
    uses = matte !== null || has === true;
  } else if (has !== null) {
    uses = has;
  } else {
    try {
      uses = layer.trackMatteType !== undefined && layer.trackMatteType !== null &&
        layer.trackMatteType !== TrackMatteType.NO_TRACK_MATTE;
    } catch (e3) {}
  }
  if (!uses) return;

  var matteName = null;
  try { if (matte) matteName = matte.name; } catch (e4) {}
  // The layer above is the matte only before 2023; later it can be any layer.
  if (!matteName && !modern) {
    try {
      var above = ctx.comp.layer(layer.index - 1);
      if (above) matteName = above.name;
    } catch (e5) {}
  }

  LazyLord.warn(layer.name, "Its track matte" + (matteName ? " ('" + matteName + "')" : "") +
    " is not transferred; the layer arrives unmatted", "approximated");
};
