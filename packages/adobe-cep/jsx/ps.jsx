/*
 * LazyLord — Photoshop builder.
 * Recreates LazyLord IR as native shape layers (solid or gradient fill layers
 * masked by their own outline), live text layers and placed smart objects.
 * Each run of consecutive layers that share a clip is gathered into a group
 * masked by the clip outline. Photoshop shares Figma's y-down, top-left pixel
 * space; path coordinates are the one exception (see _ps_pathScale).
 *
 * IR groups follow the sender's hierarchy option: "flatten" (the default)
 * builds their leaves one after another, each faded by its groups' opacity
 * and clipped by its groups' clips; "groups" rebuilds every group as a layer
 * set nested in its parent's set, masked by the group's own clip. The layout
 * option has no meaning here — every vector is its own shape layer either
 * way — so it is ignored.
 *
 * Shape layers, gradient fills, shape strokes and vector masks only exist in
 * ActionManager, which is undocumented, so every one of those steps has a
 * fallback and reports it: gradient -> flat-colour shape -> raster fill, and
 * shape stroke -> pencil stroke on a raster layer.
 */

LazyLord.build = function (doc) {
  var oldRuler = app.preferences.rulerUnits;
  var oldType = app.preferences.typeUnits;
  app.preferences.rulerUnits = Units.PIXELS;
  app.preferences.typeUnits = TypeUnits.PIXELS;

  // created: IR leaves that drew something (groups are not counted).
  var st = { psDoc: null, created: 0, clips: { groups: [], current: null } };
  try {
    LazyLord.applyOrigin(doc);
    st.psDoc = LazyLord._ps_doc(doc);

    if (LazyLord.options(doc).hierarchy === "groups") {
      LazyLord._ps_buildTree(st, doc.layers || [], { set: null, name: "" });
    } else {
      LazyLord._ps_buildFlat(st, doc.layers || []);
    }

    // Clips are applied once every layer exists, so each group can take its
    // whole run of members at once.
    for (var c = 0; c < st.clips.groups.length; c++) LazyLord._ps_clipGroup(st.psDoc, st.clips.groups[c]);
  } finally {
    app.preferences.rulerUnits = oldRuler;
    app.preferences.typeUnits = oldType;
  }
  return { ok: true, layersCreated: st.created, message: "" };
};

/**
 * Build one IR leaf and remember it for its clip run. Returns the Photoshop
 * layers made, bottom to top; an empty list means nothing was drawn, and the
 * builder has said why. `parentSet` is the layer set the leaf belongs in (null
 * for the top level), so its clip group can be made in the same set.
 */
LazyLord._ps_leaf = function (st, layer, parentSet) {
  var made = null;
  try {
    if (layer.type === "vector") made = LazyLord._ps_vector(st.psDoc, layer);
    else if (layer.type === "text") made = LazyLord._ps_text(st.psDoc, layer);
    else if (layer.type === "image") made = LazyLord._ps_image(st.psDoc, layer);
    else LazyLord.warn(layer.name, "Layers of type \"" + layer.type + "\" are not supported in Photoshop yet", "skipped");
  } catch (e) {
    LazyLord.warn(layer.name, LazyLord._ps_msg(e), "skipped");
  }
  if (!made || !made.length) return [];
  st.created++;
  // Blend mode and effects belong to every layer the leaf produced.
  for (var f = 0; f < made.length; f++) LazyLord._ps_finish(made[f], layer);
  LazyLord._ps_noteClip(st.clips, layer, made, parentSet);
  return made;
};

/* -------------------------------------------------------------------------
 * Hierarchy
 * ---------------------------------------------------------------------- */

/**
 * hierarchy "flatten" (the default): groups dissolve into their leaves, which
 * are built one after another above the active layer, exactly as a selection
 * without groups is. Each group's opacity is multiplied into its leaves, and
 * its clip is handed down to them (_ps_pushClip).
 */
LazyLord._ps_buildFlat = function (st, layers) {
  var faded = [];
  LazyLord.eachLayer(layers, function (layer) {
    if (layer.type !== "group") return;
    if (!layer.children || !layer.children.length) {
      LazyLord.warn(layer.name || "Group", "The group is empty, so there was nothing to build", "skipped");
      return;
    }
    // A group is visited before its children, so a clip travels all the way down.
    LazyLord._ps_pushClip(layer);
    // The same test flattenLayers counts as lossy, kept here for the names.
    var o = (layer.frame && typeof layer.frame.opacity === "number") ? layer.frame.opacity : 1;
    if (o < 1 && LazyLord.countLeaves(layer.children) > 1) faded.push(layer.name || "Group");
  });

  var leaves = LazyLord.flattenLayers(layers);
  if (leaves.lossy > 0) {
    var n = leaves.lossy;
    LazyLord.warn(faded.length ? faded.join(", ") : "Groups",
      (n === 1 ? "A group" : n + " groups") + " with partial opacity " + (n === 1 ? "was" : "were") +
      " flattened, so the group opacity was applied to each of its layers instead; where those layers " +
      "overlap, the lower ones now show through", "approximated");
  }
  for (var i = 0; i < leaves.length; i++) LazyLord._ps_leaf(st, leaves[i], null);
};

/**
 * hierarchy "groups": each IR group becomes a layer set nested in its
 * parent's set, named after the group, faded by the group's own opacity and
 * masked by the group's own clip.
 *
 * Photoshop makes each new layer above the active one, which once a group has
 * been built is inside that group, so nothing may rely on where a layer is
 * made: every new item is moved directly above the item placed before it in
 * the same set, and the first item of a set is moved into it. The transfer's
 * first item stays where Photoshop made it, as in a flat build — above the
 * active layer, which may be inside one of the user's own groups — and the
 * rest of the top level joins it in that container. Photoshop refuses to move
 * one layer set into another (or, on the most pessimistic reading, out of the
 * container it was made in), so a set is always made in the container it
 * belongs in and only ever moved next to a sibling there (see _ps_makeSet).
 *
 * `box` is { set, name }: the LayerSet being filled (null for the top level)
 * and its group's name, for diagnostics.
 */
LazyLord._ps_buildTree = function (st, layers, box) {
  var prev = null; // the last item placed in box.set, bottom to top
  for (var i = 0; i < layers.length; i++) {
    var layer = layers[i];
    if (layer.type !== "group") {
      prev = LazyLord._ps_nestLeaf(st, layer, box, prev);
      continue;
    }

    var name = layer.name || "Group";
    var lset = null, why = "";
    try { lset = LazyLord._ps_makeSet(st.psDoc, layer, box.set, prev); }
    catch (e) { why = LazyLord._ps_msg(e); }

    if (lset) {
      // A set that comes first was put in place as it was made.
      if (!prev || LazyLord._ps_nestPlace(lset, box, prev, name)) prev = lset;
      // A clip run never reaches into or out of a set: the set sits between.
      st.clips.current = null;
      LazyLord._ps_buildTree(st, layer.children || [], { set: lset, name: name });
      st.clips.current = null;
      if (layer.clip) LazyLord._ps_setClip(st.psDoc, lset, layer.clip, name);
      continue;
    }

    // No set: the group's leaves go straight into this one, faded and clipped
    // by it.
    LazyLord._ps_pushClips([layer]);
    var leaves = LazyLord.flattenLayers([layer]);
    if (!leaves.length) {
      LazyLord.warn(name, "The layer group could not be created (" + why + "); it was empty, so nothing else is missing", "skipped");
      continue;
    }
    LazyLord.warn(name, "The layer group could not be created (" + why + "); its " + leaves.length +
      " layer" + (leaves.length === 1 ? " was" : "s were") + " placed ungrouped" +
      (leaves.lossy > 0 ? ", each faded by the group's opacity, so where they overlap the lower ones now show through" : ""),
      "approximated");
    for (var k = 0; k < leaves.length; k++) prev = LazyLord._ps_nestLeaf(st, leaves[k], box, prev);
  }
};

/**
 * Make the layer set for an IR group, named after it, with the group's own
 * opacity. `after` is the item it is to sit directly above (null when it is
 * the first in its set). Throws when Photoshop will not make the set, and
 * never leaves a half-made one behind.
 *
 * Document.layerSets.add() is reported to make the set at the top of the
 * document whatever is active, where LayerSet.layerSets.add() makes it in
 * that set; so the set is made with the add() of the container it belongs in:
 *  - a nested group: `parentSet`;
 *  - a top-level group: the container of `after`, which may be one of the
 *    user's own groups;
 *  - the transfer's first item: the container of a throw-away layer made
 *    where Photoshop makes any new layer, i.e. where a leaf would have gone.
 *    The set is moved directly above it, within that container, and the
 *    placeholder removed.
 * _ps_nestPlace then moves it beside `after` without leaving that container;
 * a nested set that comes first is its set's only item, so already in place.
 * `after` (or the placeholder) is also made active first, for versions that
 * do make a set beside the active layer.
 */
LazyLord._ps_makeSet = function (psDoc, group, parentSet, after) {
  var name = group.name || "Group";
  var first = !parentSet && !after;
  var home = parentSet || (after ? LazyLord._ps_parentOf(after) : null);
  var marker = null, was = null, why = "";
  if (first) {
    try { was = psDoc.activeLayer; } catch (eA) { was = null; }
    try { marker = LazyLord._ps_marker(psDoc); }
    catch (eK) { why = LazyLord._ps_msg(eK); }
    if (marker) home = LazyLord._ps_parentOf(marker);
  }

  var lset = null;
  LazyLord._ps_activate(psDoc, after || marker);
  try {
    lset = (home || psDoc).layerSets.add();
    lset.name = name;
  } catch (e) {
    LazyLord._ps_discard(lset, name);
    LazyLord._ps_discard(marker, LazyLord._ps_MARKER);
    // Whatever Photoshop activates once the placeholder is gone, the group's
    // layers, built instead, must land where the set would have.
    if (marker) LazyLord._ps_activate(psDoc, was);
    throw e;
  }

  if (first) {
    var placed = false;
    if (marker) {
      try {
        lset.move(marker, ElementPlacement.PLACEBEFORE);
        placed = true;
      } catch (eM) {
        why = LazyLord._ps_msg(eM);
        placed = LazyLord._ps_isAbove(lset, marker); // made there anyway
      }
      LazyLord._ps_discard(marker, LazyLord._ps_MARKER);
    }
    if (!placed) {
      LazyLord.warn(name, "Could not be placed above the selected layer (" + why + "); it and the layers " +
        "after it sit where Photoshop made the group, which may be the top of the layer stack", "approximated");
    }
  }

  if (group.frame && group.frame.opacity !== undefined) {
    try { lset.opacity = LazyLord.pct(group.frame.opacity); }
    catch (eO) {
      LazyLord.warn(name, "The group's opacity could not be applied (" + LazyLord._ps_msg(eO) +
        "); it is shown fully opaque", "approximated");
    }
  }
  return lset;
};

/** Build a leaf into box.set above `prev`; returns the new last item placed there. */
LazyLord._ps_nestLeaf = function (st, layer, box, prev) {
  var made = LazyLord._ps_leaf(st, layer, box.set);
  for (var k = 0; k < made.length; k++) {
    if (LazyLord._ps_nestPlace(made[k], box, prev, layer.name || "Layer")) prev = made[k];
  }
  return prev;
};

/**
 * Move `item` directly above `prev`, the last item placed in box.set; with no
 * `prev` the item is the first in its set and is moved into it, or is the
 * transfer's first and stays where Photoshop made it. When Photoshop refuses,
 * the item stays where it was made — usually above the active layer, which is
 * normally `prev`, so often exactly in place: then it counts as placed and
 * nothing is lost. Otherwise returns false, having said so, and the next item
 * is placed above `prev` instead, so only the refused item is out of order.
 */
LazyLord._ps_nestPlace = function (item, box, prev, name) {
  try {
    if (prev) item.move(prev, ElementPlacement.PLACEBEFORE);
    else if (box.set) LazyLord._ps_moveInto(item, box.set);
    return true;
  } catch (e) {
    if (prev ? LazyLord._ps_isAbove(item, prev) : LazyLord._ps_isTopOf(item, box.set)) return true;
    LazyLord.warn(name, (box.set
      ? "Could not be moved to its place in the group \"" + box.name + "\" (" + LazyLord._ps_msg(e) +
        "); it may sit outside the group or out of order"
      : "Could not be moved to its place in the layer stack (" + LazyLord._ps_msg(e) + "); it may sit out of order"),
      "approximated");
    return false;
  }
};

/**
 * Hand a group's clip to its direct children, for when the group itself is
 * not rebuilt as a set. Each child gets its own copy with the same id, so
 * they still share one clipping group. A child clipped by another mask keeps
 * that one — the IR keeps the innermost mask — and losing the group's is
 * reported.
 */
LazyLord._ps_pushClip = function (group) {
  var clip = group.clip;
  if (!clip) return;
  var kids = group.children || [];
  for (var i = 0; i < kids.length; i++) {
    var kid = kids[i];
    if (!kid.clip) {
      kid.clip = JSON.parse(JSON.stringify(clip));
    } else if (String(kid.clip.id) !== String(clip.id)) {
      LazyLord.warn(kid.name || "Layer", "Clipped both by its group's mask \"" + (clip.name || "Clipping mask") +
        "\" and by its own \"" + (kid.clip.name || "Clipping mask") + "\"; without the group, only its own is kept",
        "approximated");
    }
  }
};

/** _ps_pushClip for every group in a tree, outermost first. */
LazyLord._ps_pushClips = function (layers) {
  LazyLord.eachLayer(layers, function (layer) {
    if (layer.type === "group") LazyLord._ps_pushClip(layer);
  });
};

/** Mask a finished layer set with its group's own clip, or say why not. */
LazyLord._ps_setClip = function (psDoc, lset, clip, name) {
  try {
    LazyLord._ps_vectorMask(psDoc, lset, clip, clip.name || name);
  } catch (e) {
    LazyLord.warn(name, "The group's clipping mask" + (clip.name ? " \"" + clip.name + "\"" : "") +
      " could not be applied (" + LazyLord._ps_msg(e) + "); its layers are unclipped", "approximated");
  }
};

/* -------------------------------------------------------------------------
 * Layer stack queries
 * ---------------------------------------------------------------------- */

LazyLord._ps_MARKER = "LazyLord placeholder";

/**
 * A throw-away layer, made where Photoshop makes any new layer, to find where
 * the transfer's first item belongs. The caller removes it with _ps_discard.
 */
LazyLord._ps_marker = function (psDoc) {
  var m = psDoc.artLayers.add();
  // Only a label, in case it cannot be removed; the layer itself is what counts.
  try { m.name = LazyLord._ps_MARKER; } catch (e) {}
  return m;
};

/** The Document or LayerSet holding `lyr`, or null when Photoshop does not say. */
LazyLord._ps_parentOf = function (lyr) {
  if (!lyr) return null;
  try { return lyr.parent || null; } catch (e) { return null; }
};

/**
 * Whether `item` sits directly above `below` in the same container. A
 * container's `layers` list runs top to bottom. False when it cannot be read,
 * so an unverified position is never taken as correct.
 */
LazyLord._ps_isAbove = function (item, below) {
  try {
    var list = below.parent.layers;
    for (var i = 0; i < list.length; i++) {
      if (LazyLord._ps_sameLayer(list[i], below)) return i > 0 && LazyLord._ps_sameLayer(list[i - 1], item);
    }
  } catch (e) {}
  return false;
};

/** Whether `item` is the topmost layer of `set` (false when it cannot be read). */
LazyLord._ps_isTopOf = function (item, set) {
  try {
    var list = set.layers;
    return list.length > 0 && LazyLord._ps_sameLayer(list[0], item);
  } catch (e) {
    return false;
  }
};

LazyLord._ps_doc = function (doc) {
  if (app.documents.length > 0 && !LazyLord.wantsNewDocument(doc)) return app.activeDocument;
  // The source page when there is one, so document-space artwork lands inside.
  var size = LazyLord.canvasSize(doc, 1000, 1000);
  return app.documents.add(size.width, size.height, 72, LazyLord.docName(doc), NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
};

LazyLord._ps_color = function (c) {
  var col = new SolidColor();
  col.rgb.red = Math.round((c.r || 0) * 255);
  col.rgb.green = Math.round((c.g || 0) * 255);
  col.rgb.blue = Math.round((c.b || 0) * 255);
  return col;
};

LazyLord._pv = function (u) {
  return typeof u === "number" ? u : u.as("px");
};

/** An exception's message, whatever was thrown. */
LazyLord._ps_msg = function (e) {
  return (e && e.message) ? e.message : String(e);
};

/* -------------------------------------------------------------------------
 * ActionManager plumbing
 * ---------------------------------------------------------------------- */

LazyLord._ps_cid = function (s) { return charIDToTypeID(s); };
LazyLord._ps_sid = function (s) { return stringIDToTypeID(s); };

/** { Rd, Grn, Bl } colour descriptor (class RGBC), 0..255. */
LazyLord._ps_rgbDesc = function (c) {
  var cid = LazyLord._ps_cid;
  var rgb = LazyLord.to255(c || { r: 0, g: 0, b: 0 });
  var d = new ActionDescriptor();
  d.putDouble(cid("Rd  "), rgb[0]);
  d.putDouble(cid("Grn "), rgb[1]);
  d.putDouble(cid("Bl  "), rgb[2]);
  return d;
};

/** Body of a solidColorLayer: just its colour. */
LazyLord._ps_solidDesc = function (c) {
  var d = new ActionDescriptor();
  d.putObject(LazyLord._ps_cid("Clr "), LazyLord._ps_cid("RGBC"), LazyLord._ps_rgbDesc(c));
  return d;
};

/** Stable identity for a layer: its id where the host has one, else the object. */
LazyLord._ps_sameLayer = function (a, b) {
  if (!a || !b) return false;
  var ia = null, ib = null;
  try { ia = a.id; ib = b.id; } catch (e) { ia = null; }
  if (typeof ia === "number" && typeof ib === "number") return ia === ib;
  return a === b;
};

/**
 * Whether the active layer carries a vector mask: true / false, or null when
 * Photoshop does not answer (then the caller cannot verify and carries on).
 */
LazyLord._ps_hasVectorMask = function () {
  try {
    var cid = LazyLord._ps_cid, key = LazyLord._ps_sid("hasVectorMask");
    var ref = new ActionReference();
    ref.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
    var d = executeActionGet(ref);
    if (!d.hasKey(key)) return null;
    return d.getBoolean(key);
  } catch (e) {
    return null;
  }
};

/**
 * Make `lyr` the active layer, for versions that make a new set beside the
 * active layer (others are reported to put it at the top of its container).
 * Only a hint: whoever calls this then moves the new set into place and
 * reports it if that fails, so a refusal here needs no report of its own.
 */
LazyLord._ps_activate = function (psDoc, lyr) {
  if (!lyr) return;
  try { psDoc.activeLayer = lyr; } catch (e) {}
};

/** Remove a layer this builder made but could not finish. */
LazyLord._ps_discard = function (lyr, name) {
  if (!lyr) return;
  try {
    lyr.remove();
  } catch (e) {
    LazyLord.warn(name, "A half-built layer could not be removed (" + LazyLord._ps_msg(e) +
      "); please delete it by hand", "approximated");
  }
};

/** Remove a temporary path so the Paths panel is not littered. */
LazyLord._ps_dropPath = function (pathItem, name) {
  if (!pathItem) return;
  // Deselecting is only tidiness; remove() below is what matters.
  try { pathItem.deselect(); } catch (eD) {}
  try {
    pathItem.remove();
  } catch (e) {
    LazyLord.warn(name, "A temporary path could not be removed from the Paths panel (" +
      LazyLord._ps_msg(e) + ")", "approximated");
  }
};

/**
 * Factor that turns pixel coordinates into what PathPointInfo expects.
 * Whatever the ruler units, and despite the scripting guide, Photoshop reads
 * anchor / leftDirection / rightDirection as points (1/72 inch): on a 300 ppi
 * document a 100 px outline would come out 417 px wide (ps-scripts.com,
 * "PathPointInfo.ancor units problem"). Text position, translate and resize do
 * follow the pixel ruler, so outlines are scaled by 72 / resolution to line up
 * with them. The builder reuses whatever document is open, at any resolution.
 */
LazyLord._ps_pathScale = function (psDoc, name) {
  var res = null;
  try { res = LazyLord._pv(psDoc.resolution); } catch (e) { res = null; }
  if (typeof res === "number" && res > 0) return 72 / res;
  LazyLord.warn(name, "The document resolution could not be read, so the outline was drawn as if the " +
    "document were 72 ppi; it may be the wrong size and position", "approximated");
  return 1;
};

/**
 * Build a PathItem named "LazyLord <name>" from IR subpaths, offset by
 * (ox, oy): the layer's frame origin for layer-local geometry, or 0,0 for clip
 * outlines (already in frame space). Returns null when there is nothing to draw.
 */
LazyLord._ps_pathItem = function (psDoc, name, subpaths, ox, oy) {
  var subInfos = [];
  var k = null; // pixels -> path units, read once there is something to draw
  var n = subpaths ? subpaths.length : 0;
  for (var s = 0; s < n; s++) {
    var sp = subpaths[s];
    if (!sp || !sp.vertices || !sp.vertices.length) continue;
    if (k === null) k = LazyLord._ps_pathScale(psDoc, name);
    var pts = [];
    for (var i = 0; i < sp.vertices.length; i++) {
      var cp = LazyLord.controlPoints(sp, i);
      var ppi = new PathPointInfo();
      ppi.kind = PointKind.CORNERPOINT;
      ppi.anchor = [(ox + cp.anchor[0]) * k, (oy + cp.anchor[1]) * k];
      ppi.leftDirection = [(ox + cp.inAbs[0]) * k, (oy + cp.inAbs[1]) * k];
      ppi.rightDirection = [(ox + cp.outAbs[0]) * k, (oy + cp.outAbs[1]) * k];
      pts.push(ppi);
    }
    var spi = new SubPathInfo();
    spi.operation = ShapeOperation.SHAPEXOR; // overlapping subpaths punch holes
    spi.closed = !!sp.closed;
    spi.entireSubPath = pts;
    subInfos.push(spi);
  }
  if (subInfos.length === 0) return null;
  return psDoc.pathItems.add("LazyLord " + name, subInfos);
};

/**
 * Make a fill layer ("Mk " contentLayer) whose vector mask is `pathItem`:
 * Photoshop gives a new fill layer the selected path as its mask, which is
 * exactly a shape layer. `typeClass` is solidColorLayer or gradientLayer.
 * Throws on failure, and never leaves a half-made layer behind.
 *
 * Descriptor as recorded by ScriptListener and posted on the Adobe forums
 * ("Draw Shape in Photoshop with JavaScript"; "convert path to shape layer").
 */
LazyLord._ps_makeContentLayer = function (psDoc, pathItem, typeClass, typeDesc, name) {
  var cid = LazyLord._ps_cid, sid = LazyLord._ps_sid;
  var before = null;
  try { before = psDoc.activeLayer; } catch (e0) { before = null; }
  var made = null;
  try {
    pathItem.select();
    var ref = new ActionReference();
    ref.putClass(sid("contentLayer"));
    var desc = new ActionDescriptor();
    desc.putReference(cid("null"), ref);
    var content = new ActionDescriptor();
    content.putObject(cid("Type"), typeClass, typeDesc);
    desc.putObject(cid("Usng"), sid("contentLayer"), content);
    executeAction(cid("Mk  "), desc, DialogModes.NO);

    made = psDoc.activeLayer;
    if (!made || LazyLord._ps_sameLayer(made, before)) {
      made = null;
      throw new Error("Photoshop did not create the fill layer");
    }
    // Without its mask a fill layer floods the whole canvas: never keep that.
    if (LazyLord._ps_hasVectorMask() === false) {
      throw new Error("the fill layer did not take the path as its vector mask");
    }
    made.name = name;
    return made;
  } catch (e) {
    // Only this call can have changed the active layer, so anything new is ours.
    if (!made && before) {
      var now = null;
      try { now = psDoc.activeLayer; } catch (e1) { now = null; }
      if (now && !LazyLord._ps_sameLayer(now, before)) made = now;
    }
    LazyLord._ps_discard(made, name);
    throw e;
  }
};

/* -------------------------------------------------------------------------
 * Gradients
 * ---------------------------------------------------------------------- */

// Photoshop's Gradient Fill dialog offers Scale 10%..150%; values outside that
// are clamped before they reach the descriptor.
LazyLord._ps_SCALE_MIN = 10;
LazyLord._ps_SCALE_MAX = 150;

/**
 * Distance from the centre of a box with half-extents (hw, hh) to its edge,
 * along the unit direction (ux, uy).
 */
LazyLord._ps_edgeReach = function (hw, hh, ux, uy) {
  var ax = Math.abs(ux), ay = Math.abs(uy);
  var byX = ax > 1e-9 ? hw / ax : Infinity;
  var byY = ay > 1e-9 ? hh / ay : Infinity;
  return Math.min(byX, byY);
};

/**
 * Angle / Scale / Offset of a Photoshop gradient fill (Align with layer on)
 * that reproduces LazyLord.gradientPx(layer, paint) on the box `frame`.
 * Returns { radial, angle, scale, offsetX, offsetY, wantedScale }.
 *
 * How Photoshop sizes a gradient fill against the layer box — taken from
 * Krita's Photoshop-compatible layer styles (libs/image/layerstyles/
 * kis_ls_utils.cpp, fillOverlayDevice), which rebuild PSD gradient overlays:
 *  - centre  = box centre + (Hrzn% of the width, Vrtc% of the height);
 *  - the half-extents are scaled by Scl, and R is the vector from the centre
 *    along the angle to the scaled box's EDGE (not its corner): if the angle
 *    is below the box's corner angle R = (w/2, w/2 * tan a), else
 *    (h/2 / tan a, h/2); the y component is negated (angles turn
 *    counter-clockwise on screen);
 *  - linear: stop 0 at centre - R, stop 1 at centre + R;
 *  - radial: centre as above, radius |R| at the same angle.
 * So at 100% the linear half-length and the radial radius both equal the
 * distance from the box centre to its edge along the angle.
 */
LazyLord._ps_gradientGeometry = function (frame, g) {
  var w = frame.width || 0, h = frame.height || 0;
  if (!(w > 0 && h > 0)) throw new Error("the shape has no area to align a gradient to");
  var dx = g.to[0] - g.from[0], dy = g.to[1] - g.from[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  if (!(len > 1e-9)) throw new Error("the gradient's start and end handles coincide");

  var radial = g.type === "radial-gradient";
  // Photoshop angles turn counter-clockwise on screen; the IR is y-down.
  var angle = -Math.atan2(dy, dx) * 180 / Math.PI;
  if (angle <= -180) angle += 360;

  // Linear gradients are symmetric about their centre; radial ones sit on `from`.
  var mid = radial ? g.from : [(g.from[0] + g.to[0]) / 2, (g.from[1] + g.to[1]) / 2];
  var reach = LazyLord._ps_edgeReach(w / 2, h / 2, dx / len, dy / len);
  var wanted = (radial ? len : len / 2) / reach * 100;
  var scale = Math.max(LazyLord._ps_SCALE_MIN, Math.min(LazyLord._ps_SCALE_MAX, wanted));

  return {
    radial: radial,
    angle: angle,
    scale: scale,
    wantedScale: wanted,
    offsetX: (mid[0] - (frame.x + w / 2)) / w * 100,
    offsetY: (mid[1] - (frame.y + h / 2)) / h * 100
  };
};

/**
 * Body of a gradientLayer for a gradient paint. Returns { desc, notes }, where
 * notes are approximations to report once the layer really exists.
 * Gradient object keys as recorded by ScriptListener (Adobe forums, "Utilize
 * foreground/background colour in gradient fill"): stop locations are
 * integers 0..4096, Intr (smoothness) 4096, midpoints 50.
 */
LazyLord._ps_gradientDesc = function (layer, paint) {
  var cid = LazyLord._ps_cid;
  var geo = LazyLord._ps_gradientGeometry(layer.frame, LazyLord.gradientPx(layer, paint));
  var notes = [];
  if (Math.abs(geo.scale - geo.wantedScale) > 0.01) {
    notes.push("Gradient needs a scale of " + Math.round(geo.wantedScale) + "%, beyond Photoshop's " +
      LazyLord._ps_SCALE_MIN + "-" + LazyLord._ps_SCALE_MAX + "% range; its length was clamped to " +
      Math.round(geo.scale) + "%");
  }

  // Stops in ascending order; a single stop is spread over the whole ramp.
  var stops = [];
  for (var i = 0; i < paint.stops.length; i++) stops.push(paint.stops[i]);
  stops.sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
  if (stops.length === 1) stops = [{ position: 0, color: stops[0].color }, { position: 1, color: stops[0].color }];

  var colours = new ActionList();
  var alphas = new ActionList();
  for (var s = 0; s < stops.length; s++) {
    var p = Math.max(0, Math.min(1, stops[s].position || 0));
    var loc = Math.round(p * 4096);
    var col = stops[s].color || { r: 0, g: 0, b: 0, a: 1 };

    var cs = new ActionDescriptor();
    cs.putObject(cid("Clr "), cid("RGBC"), LazyLord._ps_rgbDesc(col));
    cs.putEnumerated(cid("Type"), cid("Clry"), cid("UsrS"));
    cs.putInteger(cid("Lctn"), loc);
    cs.putInteger(cid("Mdpn"), 50);
    colours.putObject(cid("Clrt"), cs);

    var ts = new ActionDescriptor();
    ts.putUnitDouble(cid("Opct"), cid("#Prc"), LazyLord.pct(col.a));
    ts.putInteger(cid("Lctn"), loc);
    ts.putInteger(cid("Mdpn"), 50);
    alphas.putObject(cid("TrnS"), ts);
  }

  var grad = new ActionDescriptor();
  grad.putString(cid("Nm  "), (layer.name || "LazyLord") + " gradient");
  grad.putEnumerated(cid("GrdF"), cid("GrdF"), cid("CstS"));
  grad.putDouble(cid("Intr"), 4096);
  grad.putList(cid("Clrs"), colours);
  grad.putList(cid("Trns"), alphas);

  var ofst = new ActionDescriptor();
  ofst.putUnitDouble(cid("Hrzn"), cid("#Prc"), geo.offsetX);
  ofst.putUnitDouble(cid("Vrtc"), cid("#Prc"), geo.offsetY);

  var d = new ActionDescriptor();
  d.putUnitDouble(cid("Angl"), cid("#Ang"), geo.angle);
  d.putEnumerated(cid("Type"), cid("GrdT"), cid(geo.radial ? "Rdl " : "Lnr "));
  d.putBoolean(cid("Rvrs"), false);
  d.putBoolean(cid("Algn"), true); // measure against the layer's own box
  d.putUnitDouble(cid("Scl "), cid("#Prc"), geo.scale);
  d.putObject(cid("Ofst"), cid("Pnt "), ofst);
  d.putObject(cid("Grad"), cid("Grdn"), grad);
  return { desc: d, notes: notes };
};

/* -------------------------------------------------------------------------
 * Vectors
 * ---------------------------------------------------------------------- */

/** The single colour a paint falls back to: solid colour, else first stop. */
LazyLord._ps_paintColor = function (paint, fallback) {
  if (paint && paint.type === "solid" && paint.color) return paint.color;
  if (paint && paint.stops && paint.stops.length && paint.stops[0].color) return paint.stops[0].color;
  return fallback || { r: 0, g: 0, b: 0, a: 1 };
};

/**
 * Returns the layers made, bottom to top. An empty list means nothing was
 * drawn, and a diagnostic says why.
 */
LazyLord._ps_vector = function (psDoc, layer) {
  var name = layer.name || "Vector";
  var paint = LazyLord.fillPaint(layer);
  var stroke = LazyLord.firstStroke(layer);
  var stroked = !!(stroke && stroke.paint && !(stroke.weight <= 0));
  if (!paint && !stroked) {
    LazyLord.warn(name, "The shape has no visible fill or stroke, so there was nothing to draw", "skipped");
    return [];
  }

  var pathItem = LazyLord._ps_pathItem(psDoc, name, layer.subpaths, layer.frame.x, layer.frame.y);
  if (!pathItem) {
    LazyLord.warn(name, "The shape has no outline to draw", "skipped");
    return [];
  }

  // A stroke that fails on every rung reports itself as skipped below.
  var made = [];
  try {
    var fill = null;
    if (paint) {
      if (layer.fills.length > 1) {
        LazyLord.warn(name, "Only the first of " + layer.fills.length + " fills is rebuilt in Photoshop", "approximated");
      }
      fill = LazyLord._ps_fill(psDoc, layer, pathItem, paint);
      made.push(fill.layer);
    }

    if (stroked) {
      try {
        var sl = LazyLord._ps_stroke(psDoc, layer, pathItem, stroke, fill);
        if (sl) made.push(sl);
      } catch (eS) {
        LazyLord.warn(name + " stroke", LazyLord._ps_msg(eS), "skipped");
      }
    }
  } catch (e) {
    for (var k = 0; k < made.length; k++) LazyLord._ps_discard(made[k], name);
    throw e;
  } finally {
    LazyLord._ps_dropPath(pathItem, name);
  }

  if (layer.frame.opacity !== undefined) {
    for (var m = 0; m < made.length; m++) made[m].opacity = LazyLord.pct(layer.frame.opacity);
  }
  return made;
};

/**
 * Fill ladder: native gradient shape -> flat-colour shape -> raster fill.
 * Returns { layer, native, solid, opaque }.
 */
LazyLord._ps_fill = function (psDoc, layer, pathItem, paint) {
  var name = layer.name || "Vector";

  if (LazyLord.isGradient(paint)) {
    try {
      var gd = LazyLord._ps_gradientDesc(layer, paint);
      var gl = LazyLord._ps_makeContentLayer(psDoc, pathItem, LazyLord._ps_sid("gradientLayer"), gd.desc, name);
      for (var n = 0; n < gd.notes.length; n++) LazyLord.warn(name, gd.notes[n], "approximated");
      return { layer: gl, isNative: true, solid: false, opaque: true };
    } catch (eG) {
      LazyLord.warn(name, "Gradient fill could not be built natively (" + LazyLord._ps_msg(eG) +
        "); rebuilt as flat colour from its first stop", "approximated");
    }
  } else if (paint.type !== "solid") {
    LazyLord.warn(name, "Fill of type \"" + paint.type + "\" is not supported; rebuilt as flat colour", "approximated");
  }

  var color = LazyLord._ps_paintColor(paint, LazyLord.fillColor(layer));
  var alpha = (typeof color.a === "number") ? color.a : 1;

  try {
    var sl = LazyLord._ps_makeContentLayer(psDoc, pathItem, LazyLord._ps_sid("solidColorLayer"),
      LazyLord._ps_solidDesc(color), name);
    var opaque = true;
    if (alpha < 1) {
      // A fill layer has no colour alpha; Fill opacity fades it instead.
      try { sl.fillOpacity = LazyLord.pct(alpha); opaque = false; }
      catch (eA) { LazyLord.warn(name, "Fill transparency could not be applied (" + LazyLord._ps_msg(eA) + ")", "approximated"); }
    }
    return { layer: sl, isNative: true, solid: true, opaque: opaque };
  } catch (eS) {
    LazyLord.warn(name, "Could not create a native shape layer (" + LazyLord._ps_msg(eS) +
      "); the fill was painted as pixels on a raster layer", "approximated");
  }

  var art = psDoc.artLayers.add();
  try {
    art.name = name;
    psDoc.activeLayer = art;
    pathItem.fillPath(LazyLord._ps_color(color), ColorBlendMode.NORMAL, LazyLord.pct(alpha), false, 0, true, true);
  } catch (eR) {
    LazyLord._ps_discard(art, name);
    throw eR;
  }
  return { layer: art, isNative: false, solid: true, opaque: alpha >= 1 };
};

// IR stroke settings -> strokeStyle enumeration values.
LazyLord._ps_CAPS = { none: "strokeStyleButtCap", round: "strokeStyleRoundCap", square: "strokeStyleSquareCap" };
LazyLord._ps_JOINS = { miter: "strokeStyleMiterJoin", round: "strokeStyleRoundJoin", bevel: "strokeStyleBevelJoin" };
LazyLord._ps_ALIGNS = { center: "strokeStyleAlignCenter", inside: "strokeStyleAlignInside", outside: "strokeStyleAlignOutside" };

/**
 * Give the active shape layer a vector stroke ("set" shapeStyle.strokeStyle,
 * as recorded by ScriptListener; Adobe forums, "change shape stroke size").
 * `fillEnabled` false makes a stroke-only shape.
 */
LazyLord._ps_setShapeStroke = function (stroke, color, weight, fillEnabled) {
  var cid = LazyLord._ps_cid, sid = LazyLord._ps_sid;
  var ss = new ActionDescriptor();
  ss.putInteger(sid("strokeStyleVersion"), 2);
  ss.putBoolean(sid("strokeEnabled"), true);
  ss.putBoolean(sid("fillEnabled"), !!fillEnabled);
  ss.putUnitDouble(sid("strokeStyleLineWidth"), cid("#Pxl"), weight);
  ss.putEnumerated(sid("strokeStyleLineCapType"), sid("strokeStyleLineCapType"),
    sid(LazyLord._ps_CAPS[stroke.cap] || LazyLord._ps_CAPS.none));
  ss.putEnumerated(sid("strokeStyleLineJoinType"), sid("strokeStyleLineJoinType"),
    sid(LazyLord._ps_JOINS[stroke.join] || LazyLord._ps_JOINS.miter));
  ss.putEnumerated(sid("strokeStyleLineAlignment"), sid("strokeStyleLineAlignment"),
    sid(LazyLord._ps_ALIGNS[stroke.align] || LazyLord._ps_ALIGNS.center));
  ss.putUnitDouble(sid("strokeStyleOpacity"), cid("#Prc"), LazyLord.pct(color.a));
  ss.putObject(sid("strokeStyleContent"), sid("solidColorLayer"), LazyLord._ps_solidDesc(color));

  var style = new ActionDescriptor();
  style.putObject(sid("strokeStyle"), sid("strokeStyle"), ss);

  var ref = new ActionReference();
  ref.putEnumerated(sid("contentLayer"), cid("Ordn"), cid("Trgt"));
  var desc = new ActionDescriptor();
  desc.putReference(cid("null"), ref);
  desc.putObject(cid("T   "), sid("shapeStyle"), style);
  executeAction(cid("setd"), desc, DialogModes.NO);
};

/**
 * Stroke ladder: vector stroke on the fill's own shape layer (opaque solid
 * fills only — a translucent Fill opacity or a gradient's alignment box would
 * be affected by the stroke) or on a stroke-only shape layer -> pencil stroke
 * on a raster layer. Returns the extra layer it made, or null.
 */
LazyLord._ps_stroke = function (psDoc, layer, pathItem, stroke, fill) {
  var name = (layer.name || "Vector") + " stroke";
  var weight = stroke.weight || 1;
  var color = LazyLord._ps_paintColor(stroke.paint, { r: 0, g: 0, b: 0, a: 1 });
  if (stroke.paint.type !== "solid") {
    LazyLord.warn(name, "Gradient stroke rebuilt as flat colour from its first stop", "approximated");
  }
  if (stroke.dashPattern && stroke.dashPattern.length) {
    LazyLord.warn(name, "Dashed stroke rebuilt as a solid line", "approximated");
  }

  var reason;
  if (fill && fill.isNative && fill.solid && fill.opaque) {
    try {
      psDoc.activeLayer = fill.layer;
      LazyLord._ps_setShapeStroke(stroke, color, weight, true);
      return null;
    } catch (e1) {
      reason = LazyLord._ps_msg(e1);
    }
  } else {
    var own = null;
    try {
      own = LazyLord._ps_makeContentLayer(psDoc, pathItem, LazyLord._ps_sid("solidColorLayer"),
        LazyLord._ps_solidDesc(color), name);
      LazyLord._ps_setShapeStroke(stroke, color, weight, false);
      return own;
    } catch (e2) {
      LazyLord._ps_discard(own, name);
      reason = LazyLord._ps_msg(e2);
    }
  }

  LazyLord.warn(name, "Could not give the shape a native stroke (" + reason + "); stroked as pixels with " +
    "Photoshop's current pencil, so the " + weight + " px weight, cap and join are not honoured", "approximated");
  return LazyLord._ps_rasterStroke(psDoc, pathItem, color, name);
};

LazyLord._ps_rasterStroke = function (psDoc, pathItem, color, name) {
  var art = psDoc.artLayers.add();
  var savedFg = app.foregroundColor;
  try {
    art.name = name;
    psDoc.activeLayer = art;
    app.foregroundColor = LazyLord._ps_color(color);
    pathItem.strokePath(ToolType.PENCIL);
  } catch (e) {
    LazyLord._ps_discard(art, name);
    throw e;
  } finally {
    // Restoring the swatch must never mask the real error.
    try { app.foregroundColor = savedFg; } catch (eFg) {}
  }
  return art;
};

/* -------------------------------------------------------------------------
 * Clipping
 * ---------------------------------------------------------------------- */

/**
 * Remember which Photoshop layers a built IR layer became, in runs: layers
 * built one after another with the same clip id share one group, and any layer
 * built in between (unclipped, or clipped by another mask) ends the run. Each
 * run gets its own group and its own copy of the mask, so the stacking order
 * stays exactly as in the IR even when a clip id recurs further up, as it does
 * when a nested mask is reduced to its innermost clip. A layer that built
 * nothing takes no place in the stack, so it does not end a run. Nor does a
 * run cross a layer set of the "groups" hierarchy (_ps_buildTree ends it on
 * the way in and out), so `parentSet` — where the members sit, null for the
 * top level — is the same for the whole run.
 */
LazyLord._ps_noteClip = function (clips, layer, made, parentSet) {
  if (!layer.clip) {
    clips.current = null;
    return;
  }
  var key = String(layer.clip.id);
  var grp = clips.current;
  if (!grp || grp.key !== key) {
    grp = { key: key, clip: layer.clip, layers: [], parent: parentSet || null };
    clips.groups.push(grp);
    clips.current = grp;
  }
  for (var i = 0; i < made.length; i++) grp.layers.push(made[i]);
};

/** Move a layer to the top of a layer set. */
LazyLord._ps_moveInto = function (lyr, set) {
  try {
    lyr.move(set, ElementPlacement.PLACEATBEGINNING);
  } catch (e) {
    // Some versions only accept INSIDE for moves into a group.
    if (typeof ElementPlacement.INSIDE === "undefined") throw e;
    lyr.move(set, ElementPlacement.INSIDE);
  }
};

/**
 * Gather one run of layers clipped by the same mask into a layer set and give
 * the set a vector mask from the clip outline. Members keep their IR order:
 * they were built bottom to top, and each one moved to the top of the set
 * lands above the one before. A member that cannot be moved stays where it is,
 * unclipped, and the rest are still grouped and masked. Since Photoshop will
 * not move one set into another, the set is made in the members' own
 * container and then moved beside the top member there: their layer set, or
 * for a run at the top level wherever Photoshop put the top member, which may
 * be one of the user's own groups (Document.layerSets.add() would make it at
 * the top of the document instead).
 */
LazyLord._ps_clipGroup = function (psDoc, grp) {
  var clip = grp.clip;
  var name = clip.name || "Clip";
  if (!clip.subpaths || !clip.subpaths.length) {
    LazyLord.warn(name, "Clipping mask has no outline; its layers were left unclipped", "approximated");
    return;
  }

  var top = grp.layers[grp.layers.length - 1];
  var set = null;
  LazyLord._ps_activate(psDoc, top);
  try {
    set = (grp.parent || LazyLord._ps_parentOf(top) || psDoc).layerSets.add();
    set.name = name;
  } catch (e) {
    LazyLord._ps_discard(set, name);
    LazyLord.warn(name, "The clipping group could not be created (" + LazyLord._ps_msg(e) +
      "); its layers were left unclipped", "approximated");
    return;
  }

  // Sit where the top member sits, so the group keeps its depth in the stack.
  try {
    set.move(top, ElementPlacement.PLACEBEFORE);
  } catch (eP) {
    LazyLord.warn(name, "The clipping group could not be placed at its original depth (" +
      LazyLord._ps_msg(eP) + ")", "approximated");
  }

  var moved = 0, stuck = 0, reason = "";
  for (var i = 0; i < grp.layers.length; i++) {
    try {
      LazyLord._ps_moveInto(grp.layers[i], set);
      moved++;
    } catch (eM) {
      stuck++;
      if (!reason) reason = LazyLord._ps_msg(eM);
    }
  }
  if (moved === 0) {
    LazyLord._ps_discard(set, name);
    LazyLord.warn(name, "Clipped layers could not be grouped (" + reason + "); they were left unclipped", "approximated");
    return;
  }
  if (stuck > 0) {
    LazyLord.warn(name, stuck + " of " + grp.layers.length + " clipped layers could not be moved into the " +
      "clipping group (" + reason + "); they were left unclipped", "approximated");
  }

  try {
    LazyLord._ps_vectorMask(psDoc, set, clip, name);
  } catch (eM) {
    LazyLord.warn(name, "Clipping mask could not be applied (" + LazyLord._ps_msg(eM) +
      "); the layers are grouped but unclipped", "approximated");
  }
};

/**
 * Layer > Vector Mask > Current Path on `target`, from a temporary path. The
 * descriptor is ScriptListener's, as posted on the Adobe forums ("Creating a
 * vector mask from a path"). Clip outlines are already in frame space.
 */
LazyLord._ps_vectorMask = function (psDoc, target, clip, name) {
  var cid = LazyLord._ps_cid, sid = LazyLord._ps_sid;
  var tmp = LazyLord._ps_pathItem(psDoc, name, clip.subpaths, 0, 0);
  if (!tmp) throw new Error("the clip outline is empty");
  try {
    psDoc.activeLayer = target;
    tmp.select();
    var desc = new ActionDescriptor();
    var what = new ActionReference();
    what.putClass(cid("Path"));
    desc.putReference(cid("null"), what);
    var at = new ActionReference();
    at.putEnumerated(cid("Path"), cid("Path"), sid("vectorMask"));
    desc.putReference(cid("At  "), at);
    var using = new ActionReference();
    using.putEnumerated(cid("Path"), cid("Ordn"), cid("Trgt"));
    desc.putReference(cid("Usng"), using);
    executeAction(cid("Mk  "), desc, DialogModes.NO);
    if (LazyLord._ps_hasVectorMask() === false) throw new Error("Photoshop did not attach the outline as a vector mask");
  } finally {
    LazyLord._ps_dropPath(tmp, name);
  }
};

/* -------------------------------------------------------------------------
 * Rotation
 * ---------------------------------------------------------------------- */

/**
 * Turn a placed layer clockwise by frame.rotation about the IR frame centre.
 * ArtLayer.rotate only pivots on the layer's bounds (MIDDLECENTER = the centre
 * of its pixel box), which for text is the ink box, not the IR frame. A turn
 * about any other point is the same turn plus a shift, so rotate about the
 * bounds centre B, then move by rotatePoint(B, frameCentre) - B: the result is
 * exactly a turn about the frame centre.
 */
LazyLord._ps_rotate = function (lyr, frame, name) {
  var deg = frame.rotation;
  if (!deg) return;
  try {
    var b = lyr.bounds;
    var pivot = [(LazyLord._pv(b[0]) + LazyLord._pv(b[2])) / 2, (LazyLord._pv(b[1]) + LazyLord._pv(b[3])) / 2];
    lyr.rotate(deg, AnchorPosition.MIDDLECENTER); // clockwise, like Frame.rotation
    var want = LazyLord.rotatePoint(pivot, LazyLord.frameCenter(frame), deg);
    var dx = want[0] - pivot[0], dy = want[1] - pivot[1];
    if (Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3) lyr.translate(dx, dy);
  } catch (e) {
    LazyLord.warn(name, "Could not rotate by " + deg + " degrees (" + LazyLord._ps_msg(e) +
      "); placed unrotated", "approximated");
  }
};

/* -------------------------------------------------------------------------
 * Text and images
 * ---------------------------------------------------------------------- */

LazyLord._ps_text = function (psDoc, layer) {
  var name = layer.name || "Text";
  var artLayer = psDoc.artLayers.add();
  try {
    artLayer.kind = LayerKind.TEXT;
    artLayer.name = name;
    var ti = artLayer.textItem;
    ti.kind = TextType.POINTTEXT;
    ti.contents = layer.characters || "";
    ti.size = layer.fontSize || 24;
    ti.color = LazyLord._ps_color(layer.color || { r: 0, g: 0, b: 0 });

    if (layer.fontFamily) {
      try { ti.font = LazyLord._ps_font(layer.fontFamily, layer.fontStyle); }
      catch (eF) {
        LazyLord.warn(name, "Font \"" + layer.fontFamily + " " + (layer.fontStyle || "") +
          "\" was not found; Photoshop's default font was used", "approximated");
      }
    }
    if (layer.letterSpacing) {
      try { ti.tracking = Math.round((layer.letterSpacing / (layer.fontSize || 24)) * 1000); }
      catch (eT) { LazyLord.warn(name, "Letter spacing could not be applied", "approximated"); }
    }
    if (layer.lineHeight) {
      try { ti.leading = layer.lineHeight; ti.autoLeading = false; }
      catch (eL) { LazyLord.warn(name, "Line height could not be applied", "approximated"); }
    }

    var jmap = { left: Justification.LEFT, center: Justification.CENTER, right: Justification.RIGHT, justified: Justification.CENTERJUSTIFIED };
    try { ti.justification = jmap[layer.textAlignHorizontal] || Justification.LEFT; }
    catch (eJ) { LazyLord.warn(name, "Text alignment could not be applied", "approximated"); }

    // Placed unrotated on its baseline; _ps_rotate then turns it about the
    // frame centre.
    var anchor = LazyLord.textAnchor(layer);
    ti.position = [anchor[0], anchor[1]];
    if (layer.frame.opacity !== undefined) artLayer.opacity = LazyLord.pct(layer.frame.opacity);
  } catch (e) {
    LazyLord._ps_discard(artLayer, name);
    throw e;
  }
  LazyLord._ps_rotate(artLayer, layer.frame, name);
  return [artLayer];
};

/** Best-effort PostScript font name from family + style. */
LazyLord._ps_font = function (family, style) {
  var base = family.replace(/\s+/g, "");
  if (!style || style === "Regular") return base + "-Regular";
  return base + "-" + style.replace(/\s+/g, "");
};

LazyLord._ps_image = function (psDoc, layer) {
  var name = layer.name || "Image";
  var path = LazyLord.imagePath(layer);
  if (!path) throw new Error("image has no file path");
  LazyLord._ps_place(path);
  var lyr = psDoc.activeLayer;
  try {
    lyr.name = name;
    var b = lyr.bounds;
    var curW = LazyLord._pv(b[2]) - LazyLord._pv(b[0]);
    var curH = LazyLord._pv(b[3]) - LazyLord._pv(b[1]);
    var fw = layer.frame.width || curW;
    var fh = layer.frame.height || curH;
    if (curW > 0 && curH > 0) {
      lyr.resize((fw / curW) * 100, (fh / curH) * 100, AnchorPosition.TOPLEFT);
    }
    var b2 = lyr.bounds;
    lyr.translate(layer.frame.x - LazyLord._pv(b2[0]), layer.frame.y - LazyLord._pv(b2[1]));
    if (layer.frame.opacity !== undefined) lyr.opacity = LazyLord.pct(layer.frame.opacity);
  } catch (e) {
    LazyLord._ps_discard(lyr, name);
    throw e;
  }
  // The bounds now match the unrotated frame, so this pivots on its centre.
  LazyLord._ps_rotate(lyr, layer.frame, name);
  return [lyr];
};

/** Place a file as a smart object at the canvas centre. */
LazyLord._ps_place = function (path) {
  var idPlc = charIDToTypeID("Plc ");
  var desc = new ActionDescriptor();
  desc.putPath(charIDToTypeID("null"), new File(path));
  desc.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));
  var off = new ActionDescriptor();
  off.putUnitDouble(charIDToTypeID("Hrzn"), charIDToTypeID("#Pxl"), 0);
  off.putUnitDouble(charIDToTypeID("Vrtc"), charIDToTypeID("#Pxl"), 0);
  desc.putObject(charIDToTypeID("Ofst"), charIDToTypeID("Ofst"), off);
  executeAction(idPlc, desc, DialogModes.NO);
};

/* -------------------------------------------------------------------------
 * Blend modes and effects
 *
 * Photoshop has a blend mode for each of the IR's, under its own spelling
 * ("color" is COLORBLEND). Layer styles are close cousins of the IR's
 * shadows, but they live in ActionManager and their parameters do not line up
 * with anyone else's, so they are reported instead of approximated badly.
 * ---------------------------------------------------------------------- */

LazyLord._ps_BLEND = {
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

/** Apply the IR's blend mode and report any effects, on one Photoshop layer. */
LazyLord._ps_finish = function (lyr, layer) {
  if (!lyr) return;
  LazyLord.applyBlend(function (v) { lyr.blendMode = v; }, layer,
    typeof BlendMode !== "undefined" ? BlendMode : null, LazyLord._ps_BLEND);
  LazyLord.noteEffects(layer, "Photoshop layer styles are not rebuilt, so these were left off");
};
