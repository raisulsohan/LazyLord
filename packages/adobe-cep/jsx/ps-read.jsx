/*
 * LazyLord — Photoshop reader (send side).
 * Serialises the selected Photoshop layers into LazyLord IR.
 *
 * Coordinates: Photoshop's document space is y-down with the origin at the
 * top-left, which is the IR's own convention, so nothing is flipped here. The
 * one exception is path data, which Photoshop keeps in POINTS rather than
 * pixels — the same conversion the builder applies, run backwards
 * (_psr_pathScale).
 *
 * Photoshop's DOM is the weakest of the three: multiple selected layers, a
 * shape layer's outline and a fill layer's colour all live in ActionManager
 * only. Every one of those has a fallback that ends in rasterising the layer,
 * which is also what carries layer effects, smart objects and adjustments
 * across — always reported, never silent.
 */

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

LazyLord.readSelection = function (outDir, opts) {
  if (app.documents.length === 0) throw new Error("No Photoshop document is open.");

  var oldRuler = app.preferences.rulerUnits;
  var oldType = app.preferences.typeUnits;
  app.preferences.rulerUnits = Units.PIXELS;
  app.preferences.typeUnits = TypeUnits.PIXELS;

  try {
    var psDoc = app.activeDocument;
    var ctx = {
      doc: psDoc,
      outDir: outDir,
      scale: (opts && opts.scale) || LazyLord.readOptions.scale,
      idCounter: 1,
      imageIndex: 0,
      minX: 0,
      minY: 0,
      pathK: LazyLord._psr_pathScale(psDoc)
    };

    var selected = LazyLord._psr_selectedLayers(psDoc);
    if (!selected.length) throw new Error("No layers selected in Photoshop.");

    // Pass 1 — convert, with every frame still in document space.
    var raws = [];
    for (var i = 0; i < selected.length; i++) {
      var raw = null;
      try {
        raw = LazyLord._psr_layer(ctx, selected[i]);
      } catch (e) {
        LazyLord.warn(selected[i].name, LazyLord._ps_msg(e), "skipped");
      }
      if (raw) raws.push(raw);
    }
    if (!raws.length) throw new Error("Nothing in the selection can be transferred.");

    // Pass 2 — selection bounds, then normalise everything to its top-left.
    var box = LazyLord._psr_bounds(raws);
    ctx.minX = box.x;
    ctx.minY = box.y;
    LazyLord._psr_shift(raws, -box.x, -box.y);

    return {
      version: "1.0",
      source: "photoshop",
      name: psDoc.name || "Photoshop",
      bounds: box,
      // The canvas is a real page, so a target can place artwork where it sat.
      originSpace: "document",
      canvas: {
        width: LazyLord._pv(psDoc.width),
        height: LazyLord._pv(psDoc.height),
        name: psDoc.name || "Photoshop"
      },
      sourceKey: LazyLord._psr_sourceKey(psDoc),
      layers: raws
    };
  } finally {
    app.preferences.rulerUnits = oldRuler;
    app.preferences.typeUnits = oldType;
  }
};

/**
 * What tells this document apart from every other one, so a target can match a
 * layer id back to the thing it came from. A saved document is identified by
 * its path; an unsaved one has nothing stable to offer.
 */
LazyLord._psr_sourceKey = function (psDoc) {
  try { if (psDoc.fullName) return psDoc.fullName.fsName; } catch (e) {}
  return "";
};

/** Photoshop keeps path data in points; the builder's scale, run backwards. */
LazyLord._psr_pathScale = function (psDoc) {
  var res = null;
  try { res = LazyLord._pv(psDoc.resolution); } catch (e) { res = null; }
  if (typeof res === "number" && res > 0) return res / 72;
  LazyLord.warn("Document", "The document resolution could not be read, so outlines were read as if the " +
    "document were 72 ppi; they may be the wrong size", "approximated");
  return 1;
};

/* -------------------------------------------------------------------------
 * Selection
 * ---------------------------------------------------------------------- */

/**
 * The layers the user has selected. Photoshop's DOM only exposes activeLayer,
 * so the real selection comes from ActionManager; that is undocumented, so a
 * failure falls back to the active layer rather than sending nothing.
 */
LazyLord._psr_selectedLayers = function (psDoc) {
  var byId = {};
  LazyLord._psr_indexLayers(psDoc.layers, byId);

  var ids = [];
  try {
    ids = LazyLord._psr_selectedIds(psDoc);
  } catch (e) {
    LazyLord.warn("Selection", "Only the active layer could be read (" + LazyLord._ps_msg(e) +
      "); select one layer at a time, or send again", "approximated");
  }

  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var lyr = byId["#" + ids[i]];
    if (lyr) out.push(lyr);
  }
  if (out.length) return out;

  try {
    if (psDoc.activeLayer) return [psDoc.activeLayer];
  } catch (e2) {}
  return [];
};

/** Map every layer and layer set in the document by its id. */
LazyLord._psr_indexLayers = function (layers, byId) {
  for (var i = 0; i < layers.length; i++) {
    var lyr = layers[i];
    try { byId["#" + lyr.id] = lyr; } catch (e) {}
    if (lyr.typename === "LayerSet") {
      try { LazyLord._psr_indexLayers(lyr.layers, byId); } catch (e2) {}
    }
  }
};

/** Selected layer ids, through ActionManager's targetLayers list. */
LazyLord._psr_selectedIds = function (psDoc) {
  var ids = [];
  var ref = new ActionReference();
  ref.putProperty(LazyLord._ps_cid("Prpr"), LazyLord._ps_sid("targetLayers"));
  ref.putEnumerated(LazyLord._ps_cid("Dcmn"), LazyLord._ps_cid("Ordn"), LazyLord._ps_cid("Trgt"));
  var desc = executeActionGet(ref);
  if (!desc.hasKey(LazyLord._ps_sid("targetLayers"))) return ids;

  // A document with a Background layer numbers its layers from 0, everything
  // else from 1; the offset is what turns a target index into a layer index.
  var offset = LazyLord._psr_hasBackground(psDoc) ? 0 : 1;

  var list = desc.getList(LazyLord._ps_sid("targetLayers"));
  for (var i = 0; i < list.count; i++) {
    var index = list.getReference(i).getIndex() + offset;
    var idRef = new ActionReference();
    idRef.putProperty(LazyLord._ps_cid("Prpr"), LazyLord._ps_sid("layerID"));
    idRef.putIndex(LazyLord._ps_cid("Lyr "), index);
    ids.push(executeActionGet(idRef).getInteger(LazyLord._ps_sid("layerID")));
  }
  return ids;
};

LazyLord._psr_hasBackground = function (psDoc) {
  try {
    var bottom = psDoc.layers[psDoc.layers.length - 1];
    return bottom.isBackgroundLayer === true;
  } catch (e) {
    return false;
  }
};

/* -------------------------------------------------------------------------
 * Geometry helpers
 * ---------------------------------------------------------------------- */

/** A layer's bounds as an IR frame box, in document pixels. */
LazyLord._psr_box = function (lyr) {
  var b;
  try { b = lyr.bounds; } catch (e) { return null; }
  if (!b || b.length < 4) return null;
  var x = LazyLord._pv(b[0]), y = LazyLord._pv(b[1]);
  return { x: x, y: y, width: LazyLord._pv(b[2]) - x, height: LazyLord._pv(b[3]) - y };
};

LazyLord._psr_frame = function (lyr, box) {
  var opacity = 1;
  try { opacity = (lyr.opacity === undefined || lyr.opacity === null) ? 1 : lyr.opacity / 100; } catch (e) {}
  return {
    x: box.x, y: box.y, width: box.width, height: box.height,
    // Photoshop bakes any rotation into the pixels or the path.
    rotation: 0,
    opacity: opacity
  };
};

LazyLord._psr_id = function (ctx, lyr) {
  try { if (lyr.id) return "ps-" + lyr.id; } catch (e) {}
  return "ps-" + (ctx.idCounter++);
};

/** The union of every raw layer's frame, groups included. */
LazyLord._psr_bounds = function (raws) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  function walk(list) {
    for (var i = 0; i < list.length; i++) {
      var f = list[i].frame;
      if (f) {
        if (f.x < minX) minX = f.x;
        if (f.y < minY) minY = f.y;
        if (f.x + f.width > maxX) maxX = f.x + f.width;
        if (f.y + f.height > maxY) maxY = f.y + f.height;
      }
      if (list[i].children) walk(list[i].children);
    }
  }
  walk(raws);

  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/** Move every frame, baseline and clip in a tree by (dx, dy). */
LazyLord._psr_shift = function (list, dx, dy) {
  for (var i = 0; i < list.length; i++) {
    var l = list[i];
    if (l.frame) { l.frame.x += dx; l.frame.y += dy; }
    if (typeof l.baseline === "number") l.baseline += dy;
    if (typeof l.anchorX === "number") l.anchorX += dx;
    if (l.children) LazyLord._psr_shift(l.children, dx, dy);
  }
};

/* -------------------------------------------------------------------------
 * Layer dispatch — the fallback ladder
 * ---------------------------------------------------------------------- */

LazyLord._psr_layer = function (ctx, lyr) {
  try { if (lyr.visible === false) return null; } catch (e) {}

  if (lyr.typename === "LayerSet") return LazyLord._psr_group(ctx, lyr);

  var kind = null;
  try { kind = lyr.kind; } catch (e2) {}

  if (kind === LayerKind.TEXT) return LazyLord._psr_text(ctx, lyr);

  // A Photoshop shape layer is a fill layer wearing a vector mask.
  if (kind === LayerKind.SOLIDFILL) {
    var vec = LazyLord._psr_shape(ctx, lyr);
    if (vec) return vec;
  }

  return LazyLord._psr_raster(ctx, lyr, LazyLord._psr_reasonFor(kind));
};

/** Why this layer had to be rasterised, in the user's own vocabulary. */
LazyLord._psr_reasonFor = function (kind) {
  if (kind === LayerKind.SMARTOBJECT) return "Smart objects are sent as a flattened image";
  if (kind === LayerKind.GRADIENTFILL) return "Gradient fill layers are sent as a flattened image";
  if (kind === LayerKind.PATTERNFILL) return "Pattern fill layers are sent as a flattened image";
  if (kind === LayerKind.SOLIDFILL) return "This fill layer has no outline to read, so it is sent as an image";
  if (kind === LayerKind.VIDEO || kind === LayerKind.LAYER3D) return "3D and video layers are sent as a flattened image";
  if (kind && kind !== LayerKind.NORMAL) return "Adjustment layers are sent as a flattened image";
  return "Pixel layers are sent as an image";
};

LazyLord._psr_group = function (ctx, lset) {
  var children = [];
  var kids;
  try { kids = lset.layers; } catch (e) { kids = null; }

  // Photoshop lists layers front to back; the IR is bottom to top.
  for (var i = (kids ? kids.length : 0) - 1; i >= 0; i--) {
    var child = null;
    try {
      child = LazyLord._psr_layer(ctx, kids[i]);
    } catch (e2) {
      LazyLord.warn(kids[i].name, LazyLord._ps_msg(e2), "skipped");
    }
    if (child) children.push(child);
  }
  if (!children.length) return null;

  var box = LazyLord._psr_box(lset) || LazyLord._psr_bounds(children);
  var group = {
    id: LazyLord._psr_id(ctx, lset),
    name: lset.name || "Group",
    type: "group",
    frame: LazyLord._psr_frame(lset, box),
    children: children
  };

  var clip = LazyLord._psr_vectorMask(ctx, lset, group.frame);
  if (clip) group.clip = clip;
  return group;
};

/* -------------------------------------------------------------------------
 * Shape layers
 * ---------------------------------------------------------------------- */

/**
 * A fill layer masked by its own outline. Returns null when the outline or the
 * colour cannot be read, so the caller rasterises instead.
 */
LazyLord._psr_shape = function (ctx, lyr) {
  var box = LazyLord._psr_box(lyr);
  if (!box) return null;

  var subpaths = LazyLord._psr_maskPaths(ctx, lyr, box.x, box.y);
  if (!subpaths || !subpaths.length) return null;

  var colour = LazyLord._psr_solidColour(lyr);
  if (!colour) return null;

  return {
    id: LazyLord._psr_id(ctx, lyr),
    name: lyr.name || "Shape",
    type: "vector",
    frame: LazyLord._psr_frame(lyr, box),
    subpaths: subpaths,
    fills: [{ type: "solid", color: colour }],
    strokes: [],
    windingRule: "evenodd"
  };
};

/**
 * The vector mask of `lyr` as IR subpaths, local to (ox, oy). Photoshop only
 * exposes the active layer's vector mask through document.pathItems, so the
 * layer is made active first; the user's own selection is put back afterwards.
 */
LazyLord._psr_maskPaths = function (ctx, lyr, ox, oy) {
  var psDoc = ctx.doc;
  var was = null;
  try { was = psDoc.activeLayer; } catch (e) {}

  var out = null;
  try {
    psDoc.activeLayer = lyr;
    var items = psDoc.pathItems;
    for (var i = 0; i < items.length; i++) {
      var kind = null;
      try { kind = items[i].kind; } catch (eK) {}
      if (kind !== PathKind.VECTORMASK) continue;
      out = LazyLord._psr_pathToSubPaths(ctx, items[i], ox, oy);
      break;
    }
  } catch (e2) {
    out = null;
  } finally {
    try { if (was) psDoc.activeLayer = was; } catch (e3) {}
  }
  return out;
};

/** A Photoshop PathItem as IR subpaths, converted from points to pixels. */
LazyLord._psr_pathToSubPaths = function (ctx, pathItem, ox, oy) {
  var subs = [];
  var k = ctx.pathK;
  var list;
  try { list = pathItem.subPathItems; } catch (e) { return null; }

  for (var s = 0; s < list.length; s++) {
    var sp = list[s];
    var pts;
    try { pts = sp.pathPoints; } catch (eP) { continue; }

    var verts = [], ins = [], outs = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var ax = p.anchor[0] * k - ox, ay = p.anchor[1] * k - oy;
      var lx = p.leftDirection[0] * k - ox, ly = p.leftDirection[1] * k - oy;
      var rx = p.rightDirection[0] * k - ox, ry = p.rightDirection[1] * k - oy;
      verts.push([ax, ay]);
      ins.push([lx - ax, ly - ay]);   // leftDirection is the incoming handle
      outs.push([rx - ax, ry - ay]);
    }
    if (!verts.length) continue;

    var closed = false;
    try { closed = sp.closed === true; } catch (eC) {}
    subs.push({ closed: closed, vertices: verts, inTangents: ins, outTangents: outs });
  }
  return subs.length ? subs : null;
};

/** A group's vector mask as an IR clip path, in frame space. */
LazyLord._psr_vectorMask = function (ctx, lset, frame) {
  var subs = null;
  try {
    subs = LazyLord._psr_maskPaths(ctx, lset, 0, 0);
  } catch (e) {
    return null;
  }
  if (!subs) return null;
  return { id: LazyLord._psr_id(ctx, lset) + "-clip", subpaths: subs };
};

/**
 * The colour of a solid fill layer, through ActionManager. Returns null when it
 * cannot be read, which sends the layer down the raster branch instead.
 */
LazyLord._psr_solidColour = function (lyr) {
  try {
    var ref = new ActionReference();
    ref.putIdentifier(LazyLord._ps_cid("Lyr "), lyr.id);
    var desc = executeActionGet(ref);
    if (!desc.hasKey(LazyLord._ps_sid("adjustment"))) return null;

    var adj = desc.getList(LazyLord._ps_sid("adjustment")).getObjectValue(0);
    if (!adj.hasKey(LazyLord._ps_sid("color"))) return null;

    var c = adj.getObjectValue(LazyLord._ps_sid("color"));
    return {
      r: c.getDouble(LazyLord._ps_sid("red")) / 255,
      g: c.getDouble(LazyLord._ps_sid("grain")) / 255,
      b: c.getDouble(LazyLord._ps_sid("blue")) / 255,
      a: 1
    };
  } catch (e) {
    return null;
  }
};

/* -------------------------------------------------------------------------
 * Text
 * ---------------------------------------------------------------------- */

LazyLord._psr_text = function (ctx, lyr) {
  var box = LazyLord._psr_box(lyr);
  if (!box) return null;

  var ti;
  try { ti = lyr.textItem; } catch (e) { return LazyLord._psr_raster(ctx, lyr, "The text could not be read, so it is sent as an image"); }

  var name = lyr.name || "Text";
  var size = 24;
  try { size = LazyLord._pv(ti.size); } catch (e1) {}

  var colour = { r: 0, g: 0, b: 0, a: 1 };
  try {
    var rgb = ti.color.rgb;
    colour = { r: rgb.red / 255, g: rgb.green / 255, b: rgb.blue / 255, a: 1 };
  } catch (e2) {}

  var family = "Helvetica", style = "Regular";
  try {
    var parsed = LazyLord._psr_font(ti.font);
    family = parsed.family;
    style = parsed.style;
  } catch (e3) {}

  var align = "left";
  try {
    if (ti.justification === Justification.CENTER) align = "center";
    else if (ti.justification === Justification.RIGHT) align = "right";
    else if (ti.justification !== Justification.LEFT) align = "justified";
  } catch (e4) {}

  var tracking = 0;
  try { tracking = ((ti.tracking || 0) / 1000) * size; } catch (e5) {}

  var leading = 0;
  try { if (ti.useAutoLeading === false) leading = LazyLord._pv(ti.leading); } catch (e6) {}

  // Point text sits on its baseline at TextItem.position; paragraph text is
  // positioned by the top-left of its box, which the IR frame already carries.
  var baseline, anchorX;
  try {
    if (ti.kind === TextType.POINTTEXT) {
      anchorX = LazyLord._pv(ti.position[0]);
      baseline = LazyLord._pv(ti.position[1]);
    } else {
      LazyLord.warn(name, "Paragraph text is rebuilt as point text; the text box is not carried over", "approximated");
    }
  } catch (e7) {}

  return {
    id: LazyLord._psr_id(ctx, lyr),
    name: name,
    type: "text",
    frame: LazyLord._psr_frame(lyr, box),
    characters: LazyLord._psr_contents(ti),
    fontFamily: family,
    fontStyle: style,
    fontSize: size,
    color: colour,
    letterSpacing: tracking,
    lineHeight: leading,
    textAlignHorizontal: align,
    baseline: baseline,
    anchorX: anchorX
  };
};

LazyLord._psr_contents = function (ti) {
  try { return ti.contents || ""; } catch (e) { return ""; }
};

/**
 * Split a PostScript font name into family and style, undoing what the builder
 * joins: "Helvetica-BoldOblique" -> Helvetica / BoldOblique.
 */
LazyLord._psr_font = function (psName) {
  var s = String(psName || "");
  var dash = s.indexOf("-");
  if (dash > 0) {
    return { family: s.substring(0, dash), style: s.substring(dash + 1) || "Regular" };
  }
  return { family: s || "Helvetica", style: "Regular" };
};

/* -------------------------------------------------------------------------
 * Rasterising — the last rung, and what carries effects across
 * ---------------------------------------------------------------------- */

/**
 * Duplicate the layer into a scratch document its own size and save a PNG.
 * The source document is never modified: the duplicate is made in the copy.
 */
LazyLord._psr_raster = function (ctx, lyr, reason) {
  var box = LazyLord._psr_box(lyr);
  if (!box || box.width <= 0 || box.height <= 0) {
    LazyLord.warn(lyr.name || "Layer", "The layer is empty, so there was nothing to send", "skipped");
    return null;
  }

  var name = lyr.name || "Layer";
  var file = LazyLord.join(ctx.outDir, LazyLord._psr_safe(name) + "-" + (ctx.imageIndex++) + ".png");

  try {
    LazyLord._psr_export(ctx, lyr, box, file);
  } catch (e) {
    LazyLord.warn(name, "Could not be rasterised — " + LazyLord._ps_msg(e), "skipped");
    return null;
  }

  LazyLord.warn(name, reason, "rasterized");
  return {
    id: LazyLord._psr_id(ctx, lyr),
    name: name,
    type: "image",
    frame: LazyLord._psr_frame(lyr, box),
    filePath: file,
    isOriginalFile: false,
    pixelWidth: Math.round(box.width * ctx.scale),
    pixelHeight: Math.round(box.height * ctx.scale)
  };
};

LazyLord._psr_export = function (ctx, lyr, box, outPath) {
  var src = ctx.doc;
  var res = LazyLord._pv(src.resolution) || 72;
  var w = Math.max(1, Math.ceil(box.width));
  var h = Math.max(1, Math.ceil(box.height));

  var tmp = app.documents.add(w, h, res, "LazyLord export", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
  try {
    app.activeDocument = src;
    var copy = lyr.duplicate(tmp, ElementPlacement.PLACEATBEGINNING);

    app.activeDocument = tmp;
    // The duplicate keeps the source document's coordinates: bring its
    // top-left to the scratch document's origin.
    var b = copy.bounds;
    copy.translate(-LazyLord._pv(b[0]), -LazyLord._pv(b[1]));

    if (ctx.scale !== 1) {
      tmp.resizeImage(UnitValue(w * ctx.scale, "px"), UnitValue(h * ctx.scale, "px"), res, ResampleMethod.BICUBIC);
    }

    var png = new PNGSaveOptions();
    png.compression = 6;
    png.interlaced = false;
    tmp.saveAs(new File(outPath), png, true, Extension.LOWERCASE);
  } finally {
    try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (e1) {}
    try { app.activeDocument = src; } catch (e2) {}
  }
};

LazyLord._psr_safe = function (s) {
  return String(s || "layer").replace(/[^A-Za-z0-9_-]+/g, "_").substring(0, 40);
};
