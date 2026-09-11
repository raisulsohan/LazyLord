/*
 * LazyLord — After Effects builder.
 * Recreates LazyLord IR as native shape layers, text layers and footage in the
 * active (or a new) composition.
 *
 * Every AE layer is described by a transform descriptor
 *   { anchor: [x, y], position: [x, y], scale: [sx, sy], rotation: deg }
 * which is both what gets written to the layer and what the builder inverts to
 * bring document-space clip masks into LAYER space. AE layer space is y-down
 * like the IR, and rotation is clockwise-positive. Gradient Ramp points are the
 * exception: shape layers render their effects after the transform, so those
 * are composition coordinates (see the Gradients section).
 *
 * After Effects recreates an indexed group whenever a property is added to it,
 * invalidating the references taken before (PropertyGroup.addProperty in the
 * scripting guide). So the builder finishes with each property before adding
 * the next, and finds earlier ones again by index rather than by reference.
 *
 * The sender's transfer options (LazyLord.options) pick the layout:
 *  - hierarchy "flatten" (default): groups dissolve into their leaves, with
 *    each group's opacity multiplied into them (LazyLord.flattenLayers).
 *  - hierarchy "groups": each group becomes a null object parenting its layers.
 *  - layout "split" (default): one AE layer per IR layer.
 *  - layout "combine": the vectors share one shape layer, one vector group per
 *    source shape (nested vector groups for IR groups); text, images and the
 *    vectors that cannot join stay layers of their own.
 */

LazyLord.build = function (doc) {
  var ctx;
  app.beginUndoGroup("LazyLord Import");
  try {
    LazyLord.applyOrigin(doc);
    var opts = LazyLord.options(doc);
    var update = LazyLord.wantsUpdate(doc);

    // Updating edits layers where they already stand, so it cannot also
    // restructure them: a matched layer keeps whatever parent and shape layer
    // it is in. Both layout choices are therefore ignored while updating.
    if (update && (opts.layout === "combine" || opts.hierarchy !== "flatten")) {
      LazyLord.warn("Transfer", "Update edits layers where they stand, so " +
        (opts.layout === "combine" ? "Combine" : (opts.hierarchy === "precomps" ? "Precomps" : "Groups")) +
        " was ignored; send with Add to change how the layers are laid out", "approximated");
      opts.layout = "split";
      opts.hierarchy = "flatten";
    }
    // One shape layer cannot span several comps.
    if (opts.hierarchy === "precomps" && opts.layout === "combine") {
      LazyLord.warn("Transfer", "Combine does not reach into precomps, so every shape keeps a layer of its own", "approximated");
      opts.layout = "split";
    }

    ctx = {
      doc: doc,
      comp: LazyLord._ae_comp(doc),
      assets: LazyLord._ae_assetContext(),
      groups: opts.hierarchy === "groups",
      precomps: opts.hierarchy === "precomps",
      precompCount: 0,
      combo: null,
      created: 0, // AE layers actually made: nulls and split stroke layers included
      nulls: 0,
      update: update,
      updated: 0,
      index: null,
      time: 0,
      always: opts.keyframes === "always",
      seal: [],      // layers written, fingerprinted once the build is done
      conflicts: 0,  // matched layers edited here since the last send
      keep: opts.conflict === "keep"
    };
    if (update) {
      ctx.index = LazyLord._ae_index(ctx.comp);
      try { ctx.time = ctx.comp.time; } catch (eT) { ctx.time = 0; }
    }

    // A group with nothing inside vanishes in every mode: say so.
    LazyLord._ae_noteEmptyGroups(doc.layers);

    var layers = doc.layers;
    if (!ctx.groups && !ctx.precomps) {
      layers = LazyLord.flattenLayers(doc.layers);
      LazyLord._ae_noteFlatOpacity(doc);
    }
    if (opts.layout === "combine") ctx.combo = LazyLord._ae_planCombine(doc, layers);
    LazyLord._ae_tree(ctx, layers, 1, { separate: 0, combined: false });
    LazyLord._ae_extras(ctx, doc);
    LazyLord._ae_seal(ctx);
  } finally {
    app.endUndoGroup();
  }
  // layersCreated counts AE layers: nulls, split stroke layers and the one
  // combined shape layer included, so it can differ from the IR's leaf count.
  var notes = [];
  if (ctx.precompCount) {
    notes.push("Includes " + LazyLord._ae_plural(ctx.precompCount, "precomp") + " made from the source frames.");
  }
  if (ctx.nulls) {
    notes.push("Includes " + LazyLord._ae_plural(ctx.nulls, "null layer") + " standing in for the source groups.");
  }
  if (ctx.combo && ctx.combo.drawn) {
    notes.push("The shape layer '" + ctx.combo.name + "' holds " + LazyLord._ae_plural(ctx.combo.drawn, "shape") + ".");
  }
  if (ctx.update) {
    if (ctx.conflicts) {
      notes.push(LazyLord._ae_plural(ctx.conflicts, "layer") + (ctx.conflicts === 1 ? " was" : " were") +
        " changed here since the last send: " + (ctx.keep ? "left as you made them." : "your changes were replaced."));
    }
    if (ctx.updated) {
      notes.push("Updated " + LazyLord._ae_plural(ctx.updated, "layer") +
        (ctx.always ? " with a key at the playhead on every property." : ", keying the ones already animated."));
    } else if (ctx.conflicts && ctx.keep) {
      // Every match was kept as the user left it: nothing to add either.
    } else {
      notes.push("Nothing matched a layer from an earlier transfer, so everything was added.");
    }
  }
  return { ok: true, layersCreated: ctx.created, layersUpdated: ctx.updated, message: notes.join(" ") };
};

/* -------------------------------------------------------------------------
 * Layer tree and group hierarchy
 * ---------------------------------------------------------------------- */

/** A layer's own opacity, 0..1 (1 when the IR leaves it out). */
LazyLord._ae_opacityOf = function (layer) {
  return (layer && layer.frame && typeof layer.frame.opacity === "number") ? layer.frame.opacity : 1;
};

LazyLord._ae_plural = function (n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
};

/** "a", "a and b", "a, b and c". */
LazyLord._ae_list = function (parts) {
  if (parts.length < 2) return parts.join("");
  return parts.slice(0, parts.length - 1).join(", ") + " and " + parts[parts.length - 1];
};

/** Report every outermost group that holds no layers at all. */
LazyLord._ae_noteEmptyGroups = function (layers) {
  for (var i = 0; layers && i < layers.length; i++) {
    var layer = layers[i];
    if (!layer || layer.type !== "group") continue;
    if (LazyLord.countLeaves(layer.children || []) === 0) {
      LazyLord.warn(layer.name || "Group", "The group has no layers inside it, so there is nothing to build", "skipped");
    } else {
      LazyLord._ae_noteEmptyGroups(layer.children);
    }
  }
};

/**
 * Flattening multiplies each group's opacity into its layers, which only
 * differs from the source where those layers overlap: so every faded group
 * holding more than one layer, at any depth, is approximate. Counted by
 * leaves, not direct children (as flattenLayers' `lossy` does), so a faded
 * group wrapping a single group of several layers is reported too, as
 * hierarchy "groups" reports it. One report for them all.
 */
LazyLord._ae_noteFlatOpacity = function (doc) {
  var names = [];
  LazyLord.eachLayer(doc.layers, function (layer) {
    if (!layer || layer.type !== "group" || LazyLord.pct(LazyLord._ae_opacityOf(layer)) >= 100) return;
    if (LazyLord.countLeaves(layer.children || []) > 1) names.push(layer.name || "Group");
  });
  if (!names.length) return;
  if (names.length === 1) {
    LazyLord.warn(names[0], "The group's opacity is applied to each layer inside it rather than to the group as a whole, " +
      "so where its layers overlap they show through each other slightly", "approximated");
    return;
  }
  var shown = names.slice(0, 3);
  for (var i = 0; i < shown.length; i++) shown[i] = "'" + shown[i] + "'";
  if (names.length > 3) shown.push(LazyLord._ae_plural(names.length - 3, "other"));
  LazyLord.warn(doc.name || "Document", names.length + " groups (" + LazyLord._ae_list(shown) + ") are faded; " +
    "each group's opacity is applied to each layer inside it rather than to the group as a whole, " +
    "so where their layers overlap they show through each other slightly", "approximated");
};

/**
 * Build `list` bottom-to-top, so later layers land on top. `fade` is the
 * opacity of the enclosing groups, which AE parenting does not pass on (with
 * hierarchy "flatten" there are no groups left and it stays 1). `tally`
 * counts what was drawn for the caller: { separate: IR leaves built as AE
 * layers, combined: whether any went into the combined shape layer }.
 * Returns the AE layers made at this level, for the caller to parent.
 */
LazyLord._ae_tree = function (ctx, list, fade, tally) {
  var out = [];
  for (var i = 0; list && i < list.length; i++) {
    var layer = list[i];
    if (!layer) continue;

    if (layer.type === "group") {
      var up = !ctx.precomps ? LazyLord._ae_group(ctx, layer, fade, tally)
        : (layer.page ? LazyLord._ae_precomp(ctx, layer, fade, tally) : LazyLord._ae_dissolve(ctx, layer, fade, tally));
      for (var u = 0; u < up.length; u++) out.push(up[u]);
      continue;
    }

    // The combined shape layer is made where its first (lowest) shape sits;
    // it stands on its own, never parented (its vector groups are the groups).
    if (LazyLord._ae_inCombo(ctx, layer)) {
      if (!ctx.combo.built) LazyLord._ae_buildCombo(ctx);
      if (LazyLord._ae_inCombo(ctx, layer)) {
        if (layer._ae_drawn === true) tally.combined = true;
        continue;
      }
      // Otherwise the combined layer could not be made: build it on its own.
    }

    if (fade < 1 && layer.frame) layer.frame.opacity = LazyLord._ae_opacityOf(layer) * fade;

    // A layer an earlier transfer built is edited where it stands; only the
    // ones with nothing to match are added.
    if (ctx.update && LazyLord._ae_update(ctx, layer)) continue;

    try {
      var made = LazyLord._ae_leaf(ctx, layer);
      ctx.created += made.length;
      if (made.length) tally.separate++;
      for (var k = 0; k < made.length; k++) out.push(made[k]);
    } catch (e) {
      LazyLord.warn(layer.name, (e && e.message) ? e.message : String(e), "skipped");
    }
  }
  return out;
};

/**
 * hierarchy "precomps": a group from a page-like frame becomes a comp of the
 * frame's size, holding its contents measured from the frame's top-left, and
 * is placed as a precomp layer where the frame sat. Nested frames nest. The
 * frame's opacity goes on the precomp layer, which is exact.
 */
LazyLord._ae_precomp = function (ctx, group, fade, outer) {
  var name = group.name || "Frame";
  var p = group.page;
  var parent = ctx.comp;
  var w = Math.max(LazyLord._ae_COMP_MIN, Math.min(LazyLord._ae_COMP_MAX, Math.round(p.width)));
  var h = Math.max(LazyLord._ae_COMP_MIN, Math.min(LazyLord._ae_COMP_MAX, Math.round(p.height)));
  var sub;
  try {
    sub = app.project.items.addComp(name, w, h, parent.pixelAspect || 1, parent.duration || 10, parent.frameRate || 30);
  } catch (e) {
    LazyLord.warn(name, "The frame could not become a precomp (" + ((e && e.message) || String(e)) +
      "), so its layers are placed in the comp directly", "approximated");
    return LazyLord._ae_dissolve(ctx, group, fade, outer);
  }

  // The contents, in the precomp's own space: a copy, moved to the frame's corner.
  var kids = JSON.parse(JSON.stringify(group.children || []));
  LazyLord.shiftLayers(kids, -p.x, -p.y);
  var tally = { separate: 0, combined: false };
  ctx.comp = sub;
  try {
    LazyLord._ae_tree(ctx, kids, 1, tally);
  } finally {
    ctx.comp = parent;
  }

  var pl = parent.layers.add(sub);
  pl.name = name;
  LazyLord._ae_setTransform(pl, { anchor: [w / 2, h / 2], position: [p.x + w / 2, p.y + h / 2], scale: [100, 100], rotation: 0 },
    LazyLord._ae_opacityOf(group) * fade);
  ctx.created++;
  ctx.precompCount++;
  outer.separate++;
  return [pl];
};

/** A plain group inside precomps mode: its layers go straight into the current comp. */
LazyLord._ae_dissolve = function (ctx, group, fade, outer) {
  var go = LazyLord._ae_opacityOf(group);
  var tally = { separate: 0, combined: false };
  var kids = LazyLord._ae_tree(ctx, group.children || [], fade * go, tally);
  outer.separate += tally.separate;
  if (LazyLord.pct(go) < 100 && tally.separate > 1) {
    LazyLord.warn(group.name || "Group", "The group's " + LazyLord.pct(go) + "% opacity is applied to each layer inside it; " +
      "where they overlap they show through each other slightly", "approximated");
  }
  return kids;
};

/** One IR leaf as AE layers; returns every layer made (a split stroke adds one). */
LazyLord._ae_leaf = function (ctx, layer) {
  if (layer.type === "vector") {
    var made = [];
    LazyLord._ae_vector(ctx.comp, layer, made);
    // made[0] is the shape itself; a second layer is its split-off stroke, and
    // takes a tag of its own so a later update can find both.
    for (var i = 0; i < made.length; i++) {
      LazyLord._ae_tag(ctx, made[i], layer, i === 0 ? null : "stroke");
    }
    return made;
  }
  if (layer.type === "text") {
    var tl = LazyLord._ae_text(ctx.comp, layer);
    LazyLord._ae_tag(ctx, tl, layer);
    return [tl];
  }
  if (layer.type === "image") {
    var il = LazyLord._ae_image(ctx.comp, layer, ctx.assets);
    LazyLord._ae_tag(ctx, il, layer);
    return [il];
  }
  LazyLord.warn(layer.name, "Layers of type '" + layer.type + "' are not rebuilt in After Effects", "skipped");
  return [];
};

/**
 * An IR group as a null object (hierarchy "groups"). Its layers are built
 * first, in comp space as always, then parented to the null: assigning
 * Layer.parent offsets the child's transform so that nothing moves (scripting
 * guide, Layer.parent; setParentWithJump is the variant that keeps the raw
 * values), so every builder keeps working in comp space and masks and
 * Gradient Ramp points stay valid. Parenting is the last thing done to a layer.
 *
 * The null is made after its layers, so it sits directly above the group's
 * topmost layer; nested groups give nested nulls. It stays at 100%: parenting
 * does not pass opacity on, so the group's opacity goes into its layers.
 * Returns what the enclosing level parents: [null], plus any layer that could
 * not be parented; or the group's own layers when no null could be made.
 */
LazyLord._ae_group = function (ctx, group, fade, outer) {
  var name = group.name || "Group";
  var go = LazyLord._ae_opacityOf(group);
  var tally = { separate: 0, combined: false };
  var kids = LazyLord._ae_tree(ctx, group.children || [], fade * go, tally);
  outer.separate += tally.separate;
  if (tally.combined) outer.combined = true;

  // Faded one by one, overlapping layers show through each other. Vectors in
  // the combined layer take the opacity exactly, on their group, and count once.
  if (LazyLord.pct(go) < 100 && tally.separate + (tally.combined ? 1 : 0) > 1) {
    LazyLord.warn(name, "After Effects parenting does not pass opacity on, so the group's " + LazyLord.pct(go) +
      "% opacity is applied to each layer inside it; where they overlap they show through each other slightly", "approximated");
  }
  if (!kids.length) return [];

  var nl = null;
  try {
    var dur = ctx.comp.duration;
    nl = (typeof dur === "number" && dur > 0) ? ctx.comp.layers.addNull(dur) : ctx.comp.layers.addNull();
    nl.name = name;
    var f = group.frame || {};
    // Anchor at the null's corner, so the null sits on the group's top-left.
    LazyLord._ae_setTransform(nl, { anchor: [0, 0], position: [f.x || 0, f.y || 0], scale: [100, 100], rotation: 0 });
  } catch (e) {
    if (nl) LazyLord._ae_discard([nl]);
    LazyLord.warn(name, "The group could not be rebuilt as a null object (" + ((e && e.message) || String(e)) +
      "), so its layers are kept without it", "approximated");
    return kids;
  }
  ctx.created++;
  ctx.nulls++;

  var up = [nl];
  var loose = 0;
  for (var i = 0; i < kids.length; i++) {
    try { kids[i].parent = nl; } catch (eParent) { loose++; up.push(kids[i]); }
  }
  if (loose) {
    LazyLord.warn(name, LazyLord._ae_plural(loose, "layer") + " could not be parented to the group's null, so " +
      (loose === 1 ? "it stays" : "they stay") + " in place without it", "approximated");
  }
  return up;
};

/* -------------------------------------------------------------------------
 * Combine: the vectors in one shape layer
 *
 * Every eligible vector becomes an "ADBE Vector Group" named after it, holding
 * its live primitive or paths, stroke and fill, with the group's Position
 * offsetting it from the layer origin (the combined bounds' top-left) and its
 * opacity on the group's transform. AE draws the first item in Contents on
 * top, so groups are added top-down. With hierarchy "groups", IR groups become
 * nested vector groups carrying their own opacity.
 *
 * Not eligible, and built as layers of their own: text and images, gradient
 * fills (the Gradient Ramp colours a whole layer) and vectors whose clip
 * differs from the rest. The clip most combined vectors share (or none) wins;
 * when it is a clip, it goes on the combined layer as masks.
 * ---------------------------------------------------------------------- */

/** What sets a vector's clip apart: its mask id, "" when unclipped. */
LazyLord._ae_clipKey = function (layer, index) {
  var c = layer.clip;
  if (!c || !c.subpaths || !c.subpaths.length) return "";
  if (c.id === undefined || c.id === null || c.id === "") return "?" + index; // no id: its own mask
  return "#" + c.id;
};

/**
 * Decide which vectors join the combined layer (tagging them `_ae_combo`) and
 * report, once, the layers that stay separate. Returns the plan.
 */
LazyLord._ae_planCombine = function (doc, layers) {
  var leaves = [];
  LazyLord.eachLayer(layers, function (layer) { if (layer && layer.type !== "group") leaves.push(layer); });

  var why = { text: 0, image: 0, gradient: 0, clip: 0 };
  var vectors = [], keys = [], counts = {}, order = [];
  var i;
  for (i = 0; i < leaves.length; i++) {
    var l = leaves[i];
    l._ae_combo = false;
    l._ae_drawn = false;
    if (l.type === "text") why.text++;
    else if (l.type === "image") why.image++;
    else if (l.type === "vector") {
      if (LazyLord.isGradient(LazyLord.fillPaint(l))) { why.gradient++; continue; }
      var key = LazyLord._ae_clipKey(l, i);
      vectors.push(l);
      keys.push(key);
      if (!counts.hasOwnProperty(key)) { counts[key] = 0; order.push(key); }
      counts[key]++;
    }
  }

  // The clip most vectors share; a tie goes to the one lowest in the stack.
  var best = null, bestN = 0;
  for (i = 0; i < order.length; i++) {
    if (counts[order[i]] > bestN) { best = order[i]; bestN = counts[order[i]]; }
  }
  var members = [], clip = null;
  for (i = 0; i < vectors.length; i++) {
    if (keys[i] === best) {
      vectors[i]._ae_combo = true;
      members.push(vectors[i]);
      if (!clip && best !== "") clip = vectors[i].clip;
    } else {
      why.clip++;
    }
  }

  var name = doc.name || "LazyLord";
  var separate = why.text + why.image + why.gradient + why.clip;
  if (separate) {
    var parts = [];
    if (why.text) parts.push(LazyLord._ae_plural(why.text, "text layer"));
    if (why.image) parts.push(LazyLord._ae_plural(why.image, "image"));
    if (why.gradient) parts.push(LazyLord._ae_plural(why.gradient, "gradient-filled shape") + " (a Gradient Ramp colours a whole layer)");
    if (why.clip) parts.push(LazyLord._ae_plural(why.clip, "shape") + " with a different clipping mask");
    var reason;
    if (members.length) {
      reason = LazyLord._ae_plural(separate, "layer") + " could not join the combined shape layer '" + name +
        "' and " + (separate === 1 ? "stays a layer" : "stay layers") + " of " + (separate === 1 ? "its" : "their") +
        " own: " + LazyLord._ae_list(parts);
      // The combined layer sits where its lowest shape was, so a separate
      // layer that was between combined shapes now draws over all of them.
      var first = -1, last = -1, between = 0;
      for (i = 0; i < leaves.length; i++) {
        if (leaves[i]._ae_combo === true) { if (first < 0) first = i; last = i; }
      }
      for (i = first + 1; i < last; i++) {
        var t = leaves[i].type;
        if (leaves[i]._ae_combo !== true && (t === "vector" || t === "text" || t === "image")) between++;
      }
      if (between) {
        reason += "; " + between + (between === 1 ? " of them was" : " of them were") +
          " stacked between combined shapes and now " + (between === 1 ? "draws" : "draw") + " above all of them";
      }
    } else {
      reason = "No shape could be combined, so all " + LazyLord._ae_plural(separate, "layer") +
        " are built as layers of their own: " + LazyLord._ae_list(parts);
    }
    LazyLord.warn(name, reason, "approximated");
  }

  return { name: name, layers: layers, members: members, clip: clip, built: false, failed: false, drawn: 0 };
};

/** True when a leaf is to be drawn inside the combined shape layer. */
LazyLord._ae_inCombo = function (ctx, layer) {
  return !!(ctx.combo && !ctx.combo.failed && layer._ae_combo === true);
};

/** True when a group holds any leaf destined for the combined layer. */
LazyLord._ae_comboHas = function (group) {
  var has = false;
  LazyLord.eachLayer(group.children || [], function (layer) { if (layer._ae_combo === true) has = true; });
  return has;
};

/** The Contents group at `path` (vector group indices from the root), looked up afresh. */
LazyLord._ae_contentsAt = function (sl, path) {
  var g = sl.property("ADBE Root Vectors Group");
  for (var i = 0; i < path.length; i++) g = g.property(path[i]).property("ADBE Vectors Group");
  return g;
};

/** Remove the vector group at `path` from its parent's Contents. True when gone. */
LazyLord._ae_removeGroupAt = function (sl, path) {
  try {
    LazyLord._ae_contentsAt(sl, path.slice(0, path.length - 1)).property(path[path.length - 1]).remove();
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Make the combined shape layer and fill it. If the layer itself cannot be
 * made, the plan is dropped and every vector is built as a layer of its own.
 */
LazyLord._ae_buildCombo = function (ctx) {
  var combo = ctx.combo;
  combo.built = true;
  var ox = Infinity, oy = Infinity;
  for (var i = 0; i < combo.members.length; i++) {
    var f = combo.members[i].frame || {};
    if ((f.x || 0) < ox) ox = f.x || 0;
    if ((f.y || 0) < oy) oy = f.y || 0;
  }
  if (ox === Infinity) { ox = 0; oy = 0; }
  var xf = { anchor: [0, 0], position: [ox, oy], scale: [100, 100], rotation: 0 };

  var sl = null;
  try {
    sl = ctx.comp.layers.addShape();
    sl.name = combo.name;
    LazyLord._ae_setTransform(sl, xf);
  } catch (e) {
    if (sl) LazyLord._ae_discard([sl]);
    combo.failed = true;
    LazyLord.warn(combo.name, "The combined shape layer could not be made (" + ((e && e.message) || String(e)) +
      "), so each shape is built as a layer of its own", "approximated");
    return;
  }

  var n = LazyLord._ae_comboList(sl, [], combo.layers, [ox, oy]);
  if (!n) { LazyLord._ae_discard([sl]); return; } // every shape failed, and each was reported
  combo.drawn = n;
  ctx.created++;
  if (combo.clip) LazyLord._ae_clip(sl, { name: combo.name, clip: combo.clip }, xf);
};

/**
 * Add the combined leaves of `list` (and groups holding any) to the Contents
 * at `path`, topmost first. `origin` is where the enclosing group's (0, 0)
 * sits in comp space. Returns how many shapes were drawn.
 */
LazyLord._ae_comboList = function (sl, path, list, origin) {
  var n = 0;
  for (var i = list.length - 1; i >= 0; i--) {
    var layer = list[i];
    if (!layer) continue;
    if (layer.type === "group") {
      if (LazyLord._ae_comboHas(layer)) n += LazyLord._ae_comboGroup(sl, path, layer, origin);
    } else if (layer._ae_combo === true) {
      if (LazyLord._ae_comboLeaf(sl, path, layer, origin)) n++;
    }
  }
  return n;
};

/**
 * Write a vector group's transform: `xf` is a comp-space descriptor, placed
 * relative to `origin`. The group's opacity is taken as exact: it fades what
 * the group composites to as a whole, so a fill does not show through its
 * stroke, nor one shape through another. Adobe does not say so outright; the
 * Lottie specification, which models AE's shape-layer semantics, states that
 * group opacity "applies to the result of compositing all group content",
 * and a vector group carries a blend mode of its own, which suggests it is
 * composited as one image. Unverified in AE itself. (Paint ORDER is
 * documented: the bottom of Contents is painted first.)
 */
LazyLord._ae_setGroupXf = function (grp, xf, origin, opacity) {
  var tg = grp.property("ADBE Vector Transform Group");
  tg.property("ADBE Vector Anchor").setValue([xf.anchor[0], xf.anchor[1]]);
  tg.property("ADBE Vector Position").setValue([xf.position[0] - origin[0], xf.position[1] - origin[1]]);
  if (xf.rotation) tg.property("ADBE Vector Rotation").setValue(xf.rotation);
  if (typeof opacity === "number" && LazyLord.pct(opacity) < 100) {
    tg.property("ADBE Vector Group Opacity").setValue(LazyLord.pct(opacity));
  }
};

/** An IR group as a nested vector group. Returns how many shapes it drew. */
LazyLord._ae_comboGroup = function (sl, path, group, origin) {
  var name = group.name || "Group";
  var f = group.frame || {};
  var at = null;
  try {
    var grp = LazyLord._ae_contentsAt(sl, path).addProperty("ADBE Vector Group");
    at = grp.propertyIndex;
    grp.name = name;
    // Finished before anything goes inside, which would invalidate `grp`'s transform.
    LazyLord._ae_setGroupXf(grp, { anchor: [0, 0], position: [f.x || 0, f.y || 0], rotation: 0 },
      origin, LazyLord._ae_opacityOf(group));
  } catch (e) {
    if (at !== null && !LazyLord._ae_removeGroupAt(sl, path.concat([at]))) {
      LazyLord.warn(name, "A half-built group could not be removed from the combined shape layer; delete it from the layer's contents", "approximated");
    }
    LazyLord.warn(name, "The group could not be rebuilt inside the combined shape layer (" +
      ((e && e.message) || String(e)) + "), so its shapes are left out", "skipped");
    return 0;
  }
  var n = LazyLord._ae_comboList(sl, path.concat([at]), group.children || [], [f.x || 0, f.y || 0]);
  if (!n) LazyLord._ae_removeGroupAt(sl, path.concat([at])); // each failed shape was reported
  return n;
};

/** One vector as a vector group in the combined layer. True when drawn. */
LazyLord._ae_comboLeaf = function (sl, path, layer, origin) {
  var name = layer.name || "Vector";
  var at = null;
  try {
    var grp = LazyLord._ae_contentsAt(sl, path).addProperty("ADBE Vector Group");
    at = grp.propertyIndex;
    grp.name = name;
    LazyLord._ae_setGroupXf(grp, LazyLord._ae_vectorXf(layer.frame), origin, layer.frame.opacity);
    var g = grp.property("ADBE Vectors Group");
    if (!LazyLord._ae_primitive(g, layer, false)) LazyLord._ae_paths(g, layer);
    // Paint above in Contents renders in front, so the stroke goes before the
    // fill and draws over it, as the source does (and as AE's own tools lay
    // out); _ae_vector does the same for a layer of its own.
    var stroke = LazyLord.firstStroke(layer);
    if (stroke && stroke.paint) LazyLord._ae_stroke(g, layer, stroke);
    if (layer.fills && layer.fills.length) LazyLord._ae_fill(g, layer, LazyLord.fillColor(layer));
    layer._ae_drawn = true;
    return true;
  } catch (e) {
    if (at !== null && !LazyLord._ae_removeGroupAt(sl, path.concat([at]))) {
      LazyLord.warn(name, "A half-built shape could not be removed from the combined shape layer; delete its group from the layer's contents", "approximated");
    }
    LazyLord.warn(name, (e && e.message) ? e.message : String(e), "skipped");
    return false;
  }
};

/* -------------------------------------------------------------------------
 * Composition
 * ---------------------------------------------------------------------- */

/** After Effects accepts composition sizes of 4..30000 px. */
LazyLord._ae_COMP_MIN = 4;
LazyLord._ae_COMP_MAX = 30000;

/*
 * Transactions (see LazyLord.run): the ids of every project item, and of the
 * layers in the comp that is open, before a build. A failed build removes
 * the layers and items whose ids are new. Layer ids exist from After Effects
 * 22; without them the open comp's layers are left alone.
 */
LazyLord.snapshot = function () {
  var items = {};
  for (var i = 1; i <= app.project.numItems; i++) items[app.project.item(i).id] = true;
  var comp = app.project.activeItem;
  if (!(comp && comp instanceof CompItem)) comp = null;
  var layers = null;
  if (comp) {
    layers = {};
    for (var j = 1; j <= comp.numLayers; j++) {
      var id = comp.layer(j).id;
      if (id === undefined || id === null) { layers = null; break; }
      layers[id] = true;
    }
  }
  return { items: items, comp: comp, layers: layers };
};

LazyLord.rollback = function (s) {
  var complete = true;
  if (s.comp) {
    if (s.layers) {
      for (var j = s.comp.numLayers; j >= 1; j--) {
        var lyr = s.comp.layer(j);
        if (!s.layers[lyr.id]) lyr.remove();
      }
    } else {
      complete = false;
    }
  }
  // New comps, footage and folders, newest first; a new comp takes its layers with it.
  for (var i = app.project.numItems; i >= 1; i--) {
    var item = app.project.item(i);
    if (!s.items[item.id]) item.remove();
  }
  return complete;
};

/*
 * Guides and swatches, when the sender asked for them: the source page's
 * ruler guides become comp guides (After Effects 16.1+), and its named
 * colours a "Swatches" guide layer — a row of squares, one vector group per
 * colour and named after it, that is visible in the comp but never renders.
 */
LazyLord._ae_extras = function (ctx, doc) {
  var guides = LazyLord.wantedGuides(doc);
  var added = 0;
  for (var i = 0; i < guides.length; i++) {
    try { ctx.comp.addGuide(guides[i].orientation === "vertical" ? 1 : 0, guides[i].position); added++; } catch (e) {}
  }
  if (added < guides.length) {
    LazyLord.warn("Guides", (guides.length - added) + " of " + LazyLord._ae_plural(guides.length, "guide") +
      " could not be added; After Effects 16.1 or newer adds guides from scripts", "skipped");
  }
  var sw = LazyLord.wantedSwatches(doc);
  if (!sw.length) return;
  try {
    LazyLord._ae_swatchLayer(ctx, sw);
  } catch (e2) {
    LazyLord.warn("Swatches", "The swatch palette could not be built (" + ((e2 && e2.message) || String(e2)) + ")", "skipped");
  }
};

LazyLord._ae_swatchLayer = function (ctx, sw) {
  var size = 40, gap = 8;
  var sl = ctx.comp.layers.addShape();
  sl.name = "Swatches";
  var root = sl.property("ADBE Root Vectors Group");
  for (var i = 0; i < sw.length; i++) {
    var grp = root.addProperty("ADBE Vector Group");
    grp.name = sw[i].name;
    var inner = grp.property("ADBE Vectors Group");
    var rect = inner.addProperty("ADBE Vector Shape - Rect");
    rect.property("ADBE Vector Rect Size").setValue([size, size]);
    rect.property("ADBE Vector Rect Position").setValue([i * (size + gap) + size / 2, size / 2]);
    var fill = inner.addProperty("ADBE Vector Graphic - Fill");
    var c = sw[i].color || {};
    fill.property("ADBE Vector Fill Color").setValue([c.r || 0, c.g || 0, c.b || 0, 1]);
  }
  LazyLord._ae_setTransform(sl, { anchor: [0, 0], position: [0, 0], scale: [100, 100], rotation: 0 });
  try { sl.guideLayer = true; } catch (eG) {}
  ctx.created++;
};

/**
 * Import a PSD as a composition whose layers keep their own sizes, and open
 * it. With no path, a file dialog asks for one. Layer styles follow After
 * Effects' own import preference (scripts cannot choose it).
 */
LazyLord.importPsd = function (path) {
  var res = { ok: false, message: "" };
  var f = path ? new File(path) : File.openDialog("Choose a Photoshop file to import", "*.psd;*.psb");
  if (!f) { res.message = "No file chosen."; return JSON.stringify(res); }
  if (!f.exists) { res.message = "The file is not there any more: " + f.fsName; return JSON.stringify(res); }
  app.beginUndoGroup("LazyLord Import PSD");
  try {
    var io = new ImportOptions(f);
    var how = "composition";
    try { io.importAs = ImportAsType.COMP_CROPPED_LAYERS; how = "composition with layer sizes kept"; }
    catch (eAs) { io.importAs = ImportAsType.COMP; }
    var item = app.project.importFile(io);
    try { if (item && item instanceof CompItem) item.openInViewer(); } catch (eView) {}
    res.ok = true;
    res.message = "Imported '" + ((item && item.name) || f.name) + "' as a " + how + ".";
  } catch (e) {
    res.message = "Import failed: " + ((e && e.message) || String(e));
  } finally {
    app.endUndoGroup();
  }
  return JSON.stringify(res);
};

/* -------------------------------------------------------------------------
 * Precomp helpers — the panel's Precompose / Decompose buttons. Each returns
 * JSON { ok, message } for the panel's log, and is one undo step.
 * ---------------------------------------------------------------------- */

LazyLord._ae_activeComp = function () {
  var comp = app.project.activeItem;
  return (comp && comp instanceof CompItem) ? comp : null;
};

/** Precompose the selected layers, keeping their attributes, into one precomp. */
LazyLord.precomposeSelection = function (name) {
  var res = { ok: false, message: "" };
  var comp = LazyLord._ae_activeComp();
  var sel = comp ? comp.selectedLayers : null;
  if (!sel || !sel.length) {
    res.message = "Open a composition and select the layers to precompose.";
    return JSON.stringify(res);
  }
  var idx = [];
  for (var i = 0; i < sel.length; i++) idx.push(sel[i].index);
  idx.sort(function (a, b) { return a - b; });
  var nm = name || (sel.length === 1 ? sel[0].name + " precomp" : "Precomp of " + sel.length + " layers");
  app.beginUndoGroup("LazyLord Precompose");
  try {
    var sub = comp.layers.precompose(idx, nm, true);
    res.ok = true;
    res.message = "Precomposed " + LazyLord._ae_plural(idx.length, "layer") + " into '" + ((sub && sub.name) || nm) + "'.";
  } catch (e) {
    res.message = "Precompose failed: " + ((e && e.message) || String(e));
  } finally {
    app.endUndoGroup();
  }
  return JSON.stringify(res);
};

/**
 * Decompose the selected precomp layers: their contents move into this comp,
 * where they showed, and the precomp layer goes (the precomp itself stays in
 * the project). A null carrying the precomp layer's transform does the maths:
 * the copies are parented to it keeping their raw values, then unparented
 * keeping what they show.
 */
LazyLord.decomposeSelection = function () {
  var res = { ok: false, message: "" };
  var comp = LazyLord._ae_activeComp();
  var sel = comp ? comp.selectedLayers : null;
  var targets = [];
  for (var i = 0; sel && i < sel.length; i++) {
    try { if (sel[i].source && sel[i].source instanceof CompItem) targets.push(sel[i]); } catch (e) {}
  }
  if (!targets.length) {
    res.message = "Select a precomp layer to decompose.";
    return JSON.stringify(res);
  }
  var notes = [], moved = 0;
  app.beginUndoGroup("LazyLord Decompose");
  try {
    for (var t = 0; t < targets.length; t++) moved += LazyLord._ae_decompose(comp, targets[t], notes);
    res.ok = true;
    res.message = "Decomposed " + LazyLord._ae_plural(targets.length, "precomp") + " into " +
      LazyLord._ae_plural(moved, "layer") + "." + (notes.length ? " Not carried: " + notes.join("; ") + "." : "");
  } catch (e2) {
    res.message = "Decompose failed: " + ((e2 && e2.message) || String(e2));
  } finally {
    app.endUndoGroup();
  }
  return JSON.stringify(res);
};

LazyLord._ae_decompose = function (comp, pl, notes) {
  var sub = pl.source;
  var name = pl.name;
  var tg = pl.property("ADBE Transform Group");
  var keys = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z"];

  // What the precomp layer itself carries, which its contents cannot.
  try { if (pl.property("ADBE Effect Parade").numProperties) notes.push(name + "'s effects"); } catch (e1) {}
  try { if (pl.property("ADBE Mask Parade").numProperties) notes.push(name + "'s masks"); } catch (e2) {}
  for (var a = 0; a < keys.length; a++) {
    try { if (tg.property(keys[a]).numKeys > 0) { notes.push(name + "'s animated transform (its current value was used)"); break; } } catch (e3) {}
  }
  try { if (pl.timeRemapEnabled) notes.push(name + "'s time remapping"); } catch (e4) {}
  for (var j = 1; j <= sub.numLayers; j++) {
    try { if (sub.layer(j).parent) { notes.push("parenting inside " + name); break; } } catch (e5) {}
  }

  // The precomp layer's values are in its parent's space when it has one: the
  // helper null takes the same values under the same parent, and the copies end
  // up under that parent too.
  var pp = null;
  try { pp = pl.parent; } catch (eP) {}
  var nl = comp.layers.addNull();
  var ng = nl.property("ADBE Transform Group");
  for (var k = 0; k < keys.length; k++) ng.property(keys[k]).setValue(tg.property(keys[k]).value);
  if (pp) nl.setParentWithJump(pp);
  var fade = tg.property("ADBE Opacity").value / 100;
  var offset = 0;
  try { offset = pl.startTime || 0; } catch (e6) {}

  // Top to bottom, each copy placed just above the precomp layer: the stack keeps its order.
  var copies = [];
  var locked = [];
  try {
    for (var i = 1; i <= sub.numLayers; i++) {
      var before = comp.numLayers;
      sub.layer(i).copyToComp(comp);
      if (comp.numLayers !== before + 1) throw new Error("After Effects did not copy '" + sub.layer(i).name + "'");
      var copy = comp.layer(1);
      // A locked copy refuses every edit below, and its own removal on failure.
      var wasLocked = false;
      try { wasLocked = copy.locked === true; if (wasLocked) copy.locked = false; } catch (eL) {}
      locked.push(wasLocked);
      copy.moveBefore(pl);
      copies.push(copy);
    }
    for (var c = 0; c < copies.length; c++) {
      copies[c].setParentWithJump(nl);
      copies[c].parent = pp;
      if (offset) copies[c].startTime += offset;
      if (fade < 1) {
        var op = copies[c].property("ADBE Transform Group").property("ADBE Opacity");
        if (op.numKeys > 0) notes.push("the precomp's opacity on animated layers");
        else op.setValue(op.value * fade);
      }
    }
  } catch (e) {
    // Leave the comp as it was: the copies and the helper null go.
    for (var r = 0; r < copies.length; r++) { try { copies[r].remove(); } catch (eR) {} }
    try { nl.remove(); } catch (eN) {}
    throw e;
  }
  for (var q = 0; q < copies.length; q++) { if (locked[q]) { try { copies[q].locked = true; } catch (eQ) {} } }
  nl.remove();
  pl.remove();
  return copies.length;
};

LazyLord._ae_comp = function (doc) {
  var item = app.project.activeItem;
  if (item && item instanceof CompItem && !LazyLord.wantsNewDocument(doc)) return item;

  // The source page when the artwork is placed in document space, so it lands inside.
  var size = LazyLord.canvasSize(doc, 1920, 1080);
  var name = LazyLord.docName(doc);
  var w = Math.max(LazyLord._ae_COMP_MIN, Math.min(LazyLord._ae_COMP_MAX, Math.round(size.width)));
  var h = Math.max(LazyLord._ae_COMP_MIN, Math.min(LazyLord._ae_COMP_MAX, Math.round(size.height)));
  if (size.width > LazyLord._ae_COMP_MAX || size.height > LazyLord._ae_COMP_MAX) {
    LazyLord.warn(name, "The page is " + size.width + " x " + size.height +
      " px, beyond After Effects' 30000 px limit, so the composition is " + w + " x " + h +
      " px and artwork past its edge sits outside the frame", "approximated");
  }
  var comp = app.project.items.addComp(name, w, h, 1, 10, 30);
  // Show the new comp, as opening a new document does in the other apps.
  try { comp.openInViewer(); } catch (eView) {}
  return comp;
};

/* -------------------------------------------------------------------------
 * Transforms: T(position) * R(rotation) * S(scale) * T(-anchor)
 * ---------------------------------------------------------------------- */

/** Write a transform descriptor (and the layer opacity) to an AE layer. */
LazyLord._ae_setTransform = function (lyr, xf, opacity) {
  var tg = lyr.property("ADBE Transform Group");
  tg.property("ADBE Anchor Point").setValue([xf.anchor[0], xf.anchor[1]]);
  tg.property("ADBE Position").setValue([xf.position[0], xf.position[1]]);
  if (xf.scale[0] !== 100 || xf.scale[1] !== 100) tg.property("ADBE Scale").setValue([xf.scale[0], xf.scale[1]]);
  if (xf.rotation) tg.property("ADBE Rotate Z").setValue(xf.rotation);
  if (opacity !== undefined && opacity !== null) tg.property("ADBE Opacity").setValue(LazyLord.pct(opacity));
};

/**
 * A vector layer's transform. Vectors normally arrive baked (rotation 0), so
 * the layer origin is the frame's top-left. A vector that still carries a
 * rotation (older producers) turns about the frame centre, as the IR says.
 */
LazyLord._ae_vectorXf = function (frame) {
  var rot = frame.rotation || 0;
  if (rot) {
    return {
      anchor: [(frame.width || 0) / 2, (frame.height || 0) / 2],
      position: LazyLord.frameCenter(frame),
      scale: [100, 100],
      rotation: rot
    };
  }
  return { anchor: [0, 0], position: [frame.x, frame.y], scale: [100, 100], rotation: 0 };
};

/** Document point -> the layer's own space: the inverse of the descriptor. */
LazyLord._ae_toLayer = function (xf, pt) {
  var v = LazyLord._ae_vecToLayer(xf, [pt[0] - xf.position[0], pt[1] - xf.position[1]]);
  return [v[0] + xf.anchor[0], v[1] + xf.anchor[1]];
};

/** Direction vector (bezier tangent) -> layer space: the linear part only. */
LazyLord._ae_vecToLayer = function (xf, v) {
  var r = (xf.rotation || 0) * Math.PI / 180;
  var cos = Math.cos(r), sin = Math.sin(r);
  // Undo the clockwise rotation, then the scale.
  var ux = v[0] * cos + v[1] * sin;
  var uy = -v[0] * sin + v[1] * cos;
  var sx = (xf.scale[0] / 100) || 1;
  var sy = (xf.scale[1] / 100) || 1;
  return [ux / sx, uy / sy];
};

/** Remove layers made for an IR layer whose rebuild failed part-way. */
LazyLord._ae_discard = function (layers) {
  for (var i = layers.length - 1; i >= 0; i--) {
    try { layers[i].remove(); } catch (e) {}
  }
};

/* -------------------------------------------------------------------------
 * Clip masks
 * ---------------------------------------------------------------------- */

/**
 * Signed area of a closed bezier contour, sampled; only its sign is used, to
 * tell which way the contour winds.
 */
LazyLord._ae_area = function (sp) {
  var n = sp.vertices.length;
  if (n < 2) return 0;
  var sum = 0, px = 0, py = 0, x0 = 0, y0 = 0, started = false;
  for (var i = 0; i < n; i++) {
    var a = LazyLord.controlPoints(sp, i);
    var b = LazyLord.controlPoints(sp, (i + 1) % n);
    for (var k = 0; k < 8; k++) {
      var t = k / 8, u = 1 - t;
      var c0 = u * u * u, c1 = 3 * u * u * t, c2 = 3 * u * t * t, c3 = t * t * t;
      var x = c0 * a.anchor[0] + c1 * a.outAbs[0] + c2 * b.inAbs[0] + c3 * b.anchor[0];
      var y = c0 * a.anchor[1] + c1 * a.outAbs[1] + c2 * b.inAbs[1] + c3 * b.anchor[1];
      if (started) sum += px * y - x * py;
      else { x0 = x; y0 = y; started = true; }
      px = x; py = y;
    }
  }
  sum += px * y0 - x0 * py;
  return sum / 2;
};

/** A clip contour (frame/document space) as an AE Shape in layer space. */
LazyLord._ae_maskShape = function (sp, xf) {
  var verts = [], ins = [], outs = [];
  for (var i = 0; i < sp.vertices.length; i++) {
    verts.push(LazyLord._ae_toLayer(xf, sp.vertices[i]));
    ins.push(LazyLord._ae_vecToLayer(xf, (sp.inTangents && sp.inTangents[i]) || [0, 0]));
    outs.push(LazyLord._ae_vecToLayer(xf, (sp.outTangents && sp.outTangents[i]) || [0, 0]));
  }
  var shape = new Shape();
  shape.vertices = verts;
  shape.inTangents = ins;
  shape.outTangents = outs;
  shape.closed = true; // a clip region is always a closed area
  return shape;
};

/**
 * Rebuild layer.clip as AE masks on `lyr`, whose transform is `xf`. One mask
 * per contour: the first adds; with evenodd every later one is DIFFERENCE
 * (exclusive-or is exactly even-odd). With nonzero a later contour adds when it
 * winds the same way as the first and is DIFFERENCE when it winds the other
 * way, which is how nonzero cuts holes. All or nothing: a clip that cannot be
 * built completely is removed and reported, never left half-applied.
 */
LazyLord._ae_clip = function (lyr, layer, xf) {
  var clip = layer.clip;
  if (!clip || !clip.subpaths || !clip.subpaths.length) return;
  var base = clip.name || "Clip mask";

  var parade = null;
  try { parade = lyr.property("ADBE Mask Parade"); } catch (e) {}
  if (!parade) {
    LazyLord.warn(layer.name, "This layer cannot take masks, so the clipping mask '" + base +
      "' is dropped and the layer shows unclipped", "skipped");
    return;
  }

  var subs = [];
  for (var i = 0; i < clip.subpaths.length; i++) {
    var sp = clip.subpaths[i];
    if (sp && sp.vertices && sp.vertices.length) subs.push(sp);
  }
  if (!subs.length) return;

  var evenodd = clip.windingRule === "evenodd";
  // Each new mask invalidates the references to those added before it, so a
  // failed clip is cleared by index: everything past the masks there were.
  var before = 0;
  try { before = parade.numProperties || 0; } catch (eCount) {}
  try {
    var firstSign = 0;
    for (var s = 0; s < subs.length; s++) {
      var area = LazyLord._ae_area(subs[s]);
      var sign = area > 0 ? 1 : (area < 0 ? -1 : 0);
      var mode = MaskMode.ADD;
      if (s === 0) firstSign = sign;
      else if (evenodd || (sign && firstSign && sign !== firstSign)) mode = MaskMode.DIFFERENCE;

      var m = parade.addProperty("ADBE Mask Atom");
      m.name = subs.length > 1 ? base + " " + (s + 1) : base;
      m.maskMode = mode;
      m.property("ADBE Mask Shape").setValue(LazyLord._ae_maskShape(subs[s], xf));
    }
  } catch (eMask) {
    var why = (eMask && eMask.message) || String(eMask);
    if (LazyLord._ae_trimMasks(lyr, before)) {
      LazyLord.warn(layer.name, "The clipping mask '" + base + "' could not be rebuilt as layer masks (" +
        why + "), so the layer shows unclipped", "skipped");
    } else {
      LazyLord.warn(layer.name, "The clipping mask '" + base + "' could not be rebuilt completely (" + why +
        ") and the masks already added could not be taken off again, so the layer is only partly clipped; " +
        "delete its '" + base + "' masks to show it unclipped", "approximated");
    }
  }
};

/**
 * An update of a clipped layer: the masks LazyLord cut from the clip were cut
 * for the old frame (they travel with the layer), so they are taken off and
 * cut again for the new one. The user's own masks, named otherwise, stay.
 */
LazyLord._ae_reclip = function (lyr, layer, xf) {
  var clip = layer.clip;
  if (!clip || !clip.subpaths || !clip.subpaths.length) return;
  var base = clip.name || "Clip mask";
  try {
    // Last first, each looked up afresh: removing one invalidates the others.
    for (var i = lyr.property("ADBE Mask Parade").numProperties; i >= 1; i--) {
      var m = lyr.property("ADBE Mask Parade").property(i);
      var nm = String(m.name);
      var rest = nm.substring(base.length + 1);
      if (nm === base || (nm.indexOf(base + " ") === 0 && /^\d+$/.test(rest))) m.remove();
    }
  } catch (e) {
    LazyLord.warn(layer.name, "Its clipping mask could not be redrawn for the new position, so it was left as it was", "approximated");
    return;
  }
  LazyLord._ae_clip(lyr, layer, xf);
};

/**
 * Remove a layer's masks past the first `keep`, last first, each looked up
 * afresh by index. True when none are left over.
 */
LazyLord._ae_trimMasks = function (lyr, keep) {
  try {
    for (var guard = 0; guard < 10000; guard++) {
      var parade = lyr.property("ADBE Mask Parade");
      var n = parade.numProperties;
      if (n <= keep) return true;
      parade.property(n).remove();
    }
  } catch (e) {}
  return false;
};

/* -------------------------------------------------------------------------
 * Vector layers
 * ---------------------------------------------------------------------- */

/** Colour stops sorted by position (a copy; the IR is left alone). */
LazyLord._ae_sortedStops = function (paint) {
  var stops = paint.stops.slice(0);
  stops.sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
  return stops;
};

/** RGBA (0..1) -> an AE colour value, [r, g, b, a] in 0..1. */
LazyLord._ae_rgba = function (c) {
  c = c || {};
  return [c.r || 0, c.g || 0, c.b || 0, 1];
};

LazyLord._ae_alpha = function (c) {
  return (c && typeof c.a === "number") ? c.a : 1;
};

/**
 * A solid fill in colour `c` (its alpha as the fill opacity) with the layer's
 * fill rule, added to the group contents `g`. Returns the fill.
 */
LazyLord._ae_fill = function (g, layer, c) {
  var fill = g.addProperty("ADBE Vector Graphic - Fill");
  fill.property("ADBE Vector Fill Color").setValue(LazyLord._ae_rgba(c));
  fill.property("ADBE Vector Fill Opacity").setValue(LazyLord.pct(LazyLord._ae_alpha(c)));
  try {
    fill.property("ADBE Vector Fill Rule").setValue(layer.windingRule === "evenodd" ? 2 : 1);
  } catch (eRule) {
    if (layer.windingRule === "evenodd") {
      LazyLord.warn(layer.name || "Vector", "The even-odd fill rule could not be set, so overlapping contours may fill in holes", "approximated");
    }
  }
  return fill;
};

/**
 * One IR vector as a shape layer (two when a gradient fill has a stroke).
 * Every AE layer made is appended to `out`, when given; returns the main one.
 */
LazyLord._ae_vector = function (comp, layer, out) {
  var name = layer.name || "Vector";
  var paint = LazyLord.fillPaint(layer);
  var gradient = LazyLord.isGradient(paint);
  var stroke = LazyLord.firstStroke(layer);
  if (stroke && !stroke.paint) stroke = null;
  // A Gradient Ramp colours the whole layer, stroke included, so a
  // gradient-filled shape keeps its stroke on a layer of its own.
  var splitStroke = !!(gradient && stroke);
  var xf = LazyLord._ae_vectorXf(layer.frame);
  var made = [];
  var main;

  try {
    main = LazyLord._ae_shapeLayer(comp, layer, name, made, false);

    // AE paints a group's contents from the bottom of the Timeline up, so paint
    // above in Contents renders in front: the stroke goes before the fill and
    // draws over it, as the source does (and as the combined layer lays out).
    if (stroke && !splitStroke) LazyLord._ae_stroke(main.vectors, layer, stroke);

    // Where the fill sits, by index: the ramp needs it again after adding an
    // effect, which invalidates a kept reference.
    var fillAt = null;
    if (layer.fills && layer.fills.length) {
      var c = gradient ? LazyLord._ae_sortedStops(paint)[0].color : LazyLord.fillColor(layer);
      var fill = LazyLord._ae_fill(main.vectors, layer, c);
      fillAt = { group: main.group, fill: fill.propertyIndex };
    }

    LazyLord._ae_setTransform(main.layer, xf, layer.frame.opacity);
    if (gradient && fillAt) LazyLord._ae_ramp(main.layer, fillAt, layer, paint);
    LazyLord._ae_clip(main.layer, layer, xf);
    LazyLord._ae_applyBlend(main.layer, layer);
    LazyLord._ae_applyEffects(main.layer, layer);

    if (splitStroke) {
      // Created second, so it sits directly above the fill layer.
      var top = LazyLord._ae_shapeLayer(comp, layer, name + " stroke", made, true);
      LazyLord._ae_stroke(top.vectors, layer, stroke);
      LazyLord._ae_setTransform(top.layer, xf, layer.frame.opacity);
      LazyLord._ae_clip(top.layer, layer, xf);
      // The stroke layer composites with the fill under it, so it needs the same
      // blend mode; the effects stay on the fill, or every shadow would double.
      LazyLord._ae_applyBlend(top.layer, layer);
      if (layer.effects && layer.effects.length) {
        LazyLord.warn(name, "The stroke is on a layer of its own, so the shape's effects apply to the fill only", "approximated");
      }
      // Faded as one, the source hides the fill under the stroke; faded as two
      // layers, that part of the fill shows through the stroke.
      var op = layer.frame.opacity;
      if (typeof op === "number" && LazyLord.pct(op) < 100) {
        LazyLord.warn(name, "Layer opacity of " + LazyLord.pct(op) + "% is applied to the fill and the stroke layer separately, " +
          "so the fill shows faintly through the stroke where they overlap", "approximated");
      }
    }
  } catch (e) {
    LazyLord._ae_discard(made);
    throw e;
  }
  if (out) for (var k = 0; k < made.length; k++) out.push(made[k]);
  return main.layer;
};

/**
 * A new shape layer holding one group with the layer's outline: a live
 * rectangle/ellipse when the IR says it is one, otherwise the drawn paths.
 * Returns { layer, vectors, group } where `vectors` is the group's contents
 * and `group` the group's index under the layer's Contents.
 */
LazyLord._ae_shapeLayer = function (comp, layer, name, made, quiet) {
  var sl = comp.layers.addShape();
  made.push(sl);
  sl.name = name;
  var grp = sl.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
  grp.name = name;
  var at = grp.propertyIndex;
  var g = grp.property("ADBE Vectors Group");
  if (!LazyLord._ae_primitive(g, layer, quiet)) LazyLord._ae_paths(g, layer);
  return { layer: sl, vectors: g, group: at };
};

/** Drawn bezier paths, one path group per contour. */
/** One IR subpath as an AE Shape, in the layer's own space. */
LazyLord._ae_shapeOf = function (sp) {
  var shape = new Shape();
  var verts = [], ins = [], outs = [];
  for (var i = 0; i < sp.vertices.length; i++) {
    verts.push([sp.vertices[i][0], sp.vertices[i][1]]);
    ins.push(sp.inTangents[i] || [0, 0]);
    outs.push(sp.outTangents[i] || [0, 0]);
  }
  shape.vertices = verts;
  shape.inTangents = ins;
  shape.outTangents = outs;
  shape.closed = !!sp.closed;
  return shape;
};

LazyLord._ae_paths = function (g, layer) {
  LazyLord.eachSubPath(layer, function (sp) {
    var pathGroup = g.addProperty("ADBE Vector Shape - Group");
    pathGroup.property("ADBE Vector Shape").setValue(LazyLord._ae_shapeOf(sp));
  });
};

/**
 * Build layer.primitive as a live AE rectangle or ellipse, in the same local
 * space the path would use. Returns false (and the caller draws the path,
 * which is the same outline) when there is no usable primitive.
 */
LazyLord._ae_primitive = function (g, layer, quiet) {
  var p = layer.primitive;
  if (!p || !layer.subpaths || layer.subpaths.length !== 1) return false;
  if (p.kind !== "rect" && p.kind !== "ellipse") return false;
  if (typeof p.width !== "number" || typeof p.height !== "number") return false;

  var x = p.x || 0, y = p.y || 0;
  var size = [p.width, p.height];
  var centre = [x + p.width / 2, y + p.height / 2];
  var node = null;
  try {
    if (p.kind === "rect") {
      node = g.addProperty("ADBE Vector Shape - Rect");
      node.property("ADBE Vector Rect Size").setValue(size);
      node.property("ADBE Vector Rect Position").setValue(centre);
      if (p.roundness) node.property("ADBE Vector Rect Roundness").setValue(p.roundness);
    } else {
      node = g.addProperty("ADBE Vector Shape - Ellipse");
      node.property("ADBE Vector Ellipse Size").setValue(size);
      node.property("ADBE Vector Ellipse Position").setValue(centre);
    }
    return true;
  } catch (e) {
    var kind = p.kind === "rect" ? "rectangle" : "ellipse";
    if (node) {
      try { node.remove(); } catch (eRm) {
        LazyLord.warn(layer.name || "Shape", "A half-built live " + kind +
          " could not be removed and may show beside the drawn outline; delete it from the layer's contents", "approximated");
      }
    }
    if (!quiet) {
      LazyLord.warn(layer.name || "Shape", "Could not build a live " + kind +
        ", so it is drawn as a path with the same outline", "approximated");
    }
    return false;
  }
};

LazyLord._ae_stroke = function (g, layer, stroke) {
  var sc;
  if (LazyLord.isGradient(stroke.paint)) {
    sc = LazyLord._ae_sortedStops(stroke.paint)[0].color;
    LazyLord.warn(layer.name || "Shape", "Gradient stroke rebuilt as flat colour from its first stop", "approximated");
  } else if (stroke.paint.color) {
    sc = stroke.paint.color;
  } else {
    sc = { r: 0, g: 0, b: 0, a: 1 };
  }

  var st = g.addProperty("ADBE Vector Graphic - Stroke");
  st.property("ADBE Vector Stroke Color").setValue(LazyLord._ae_rgba(sc));
  st.property("ADBE Vector Stroke Width").setValue(stroke.weight || 1);
  st.property("ADBE Vector Stroke Opacity").setValue(LazyLord.pct(LazyLord._ae_alpha(sc)));
  try {
    var capMap = { none: 1, round: 2, square: 3 };
    var joinMap = { miter: 1, round: 2, bevel: 3 };
    if (capMap[stroke.cap]) st.property("ADBE Vector Stroke Line Cap").setValue(capMap[stroke.cap]);
    if (joinMap[stroke.join]) st.property("ADBE Vector Stroke Line Join").setValue(joinMap[stroke.join]);
  } catch (e2) {
    LazyLord.warn(layer.name || "Shape", "Stroke cap and join could not be set, so After Effects' defaults are used", "approximated");
  }
  return st;
};

/* -------------------------------------------------------------------------
 * Gradients: the Gradient Ramp effect
 *
 * Shape-layer gradient fills cannot be scripted (their colours are not
 * settable), so a gradient-filled shape keeps a solid fill for its pixels and
 * a Gradient Ramp recolours them. The ramp is two-colour and opaque.
 *
 * Shape layers are continuously rasterised: their effects render after the
 * layer transform, so the ramp's points are COMPOSITION coordinates, not the
 * layer's own (which is also why a ramp stays put when the layer is moved).
 * The IR handles are in document space, which is comp space here, so they are
 * written as they are. ae-read.jsx reads them back the same way.
 * ---------------------------------------------------------------------- */

/** A Gradient Ramp control by match name, falling back to its display order. */
LazyLord._ae_fxProp = function (fx, matchName, index) {
  var p = null;
  try { p = fx.property(matchName); } catch (e) {}
  if (!p) { try { p = fx.property(index); } catch (e2) {} }
  if (!p) throw new Error("the Gradient Ramp has no '" + matchName + "' control");
  return p;
};

/**
 * The solid fill's Opacity, looked up afresh from the layer through its
 * indices `at` = { group, fill }: a reference kept from earlier is invalid
 * once another property has been added.
 */
LazyLord._ae_fillOpacity = function (sl, at) {
  return sl.property("ADBE Root Vectors Group").property(at.group)
    .property("ADBE Vectors Group").property(at.fill)
    .property("ADBE Vector Fill Opacity");
};

/**
 * Recolour a gradient-filled shape layer with a Gradient Ramp. Its solid fill
 * (found through `at`) already holds the first stop's colour and alpha, which
 * is what shows if the ramp cannot be built. True when the ramp is in place.
 */
LazyLord._ae_ramp = function (sl, at, layer, paint) {
  var name = layer.name || "Shape";
  var stops = LazyLord._ae_sortedStops(paint);
  var first = stops[0], last = stops[stops.length - 1];
  var radial = paint.type === "radial-gradient";

  // Handles in document (= comp) space, carried through a legacy vector rotation.
  var gp = LazyLord.gradientPx(layer, paint);
  var centre = LazyLord.frameCenter(layer.frame);
  var rot = layer.frame.rotation || 0;
  var from = LazyLord.rotatePoint(gp.from, centre, rot);
  var to = LazyLord.rotatePoint(gp.to, centre, rot);
  var dx = to[0] - from[0], dy = to[1] - from[1];

  // Linear: the ramp runs between the first and last stops' positions on the
  // line. Radial: it starts at the centre and reaches the last stop's radius.
  var t0 = radial ? 0 : (first.position || 0);
  var t1 = (typeof last.position === "number") ? last.position : 1;
  var start = [from[0] + dx * t0, from[1] + dy * t0];
  var end = [from[0] + dx * t1, from[1] + dy * t1];

  // The ramp is opaque, so transparency rides on the fill's opacity: exact
  // when every stop shares one alpha, an average otherwise.
  var minA = 1, maxA = 0, sumA = 0;
  for (var i = 0; i < stops.length; i++) {
    var a = LazyLord._ae_alpha(stops[i].color);
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    sumA += a;
  }
  var alpha = (maxA - minA < 0.001) ? maxA : sumA / stops.length;
  var firstA = LazyLord._ae_alpha(first.color);

  // Written before the effect is added, since adding it invalidates references.
  var fillA = firstA; // what the fill holds now
  if (LazyLord.pct(alpha) !== LazyLord.pct(firstA)) {
    try {
      LazyLord._ae_fillOpacity(sl, at).setValue(LazyLord.pct(alpha));
      fillA = alpha;
    } catch (eOp) {}
  }

  var fx = null;
  try {
    fx = sl.property("ADBE Effect Parade").addProperty("ADBE Ramp");
    LazyLord._ae_fxProp(fx, "ADBE Ramp-0001", 1).setValue([start[0], start[1]]);
    LazyLord._ae_fxProp(fx, "ADBE Ramp-0002", 2).setValue(LazyLord._ae_rgba(first.color));
    LazyLord._ae_fxProp(fx, "ADBE Ramp-0003", 3).setValue([end[0], end[1]]);
    LazyLord._ae_fxProp(fx, "ADBE Ramp-0004", 4).setValue(LazyLord._ae_rgba(last.color));
    LazyLord._ae_fxProp(fx, "ADBE Ramp-0005", 5).setValue(radial ? 2 : 1);
    LazyLord._ae_fxProp(fx, "ADBE Ramp-0006", 6).setValue(0);
    LazyLord._ae_fxProp(fx, "ADBE Ramp-0007", 7).setValue(0);
  } catch (e) {
    if (fx) {
      try { fx.remove(); } catch (eRm) {
        LazyLord.warn(name, "A half-built Gradient Ramp could not be removed from the layer; switch it off to see the flat fill", "approximated");
      }
    }
    // Flattened to the first stop, so the fill takes that stop's alpha back.
    if (fillA !== firstA) {
      try { LazyLord._ae_fillOpacity(sl, at).setValue(LazyLord.pct(firstA)); } catch (eBack) {
        LazyLord.warn(name, "The flat fill keeps the gradient's overall opacity of " + LazyLord.pct(fillA) +
          "% rather than its first stop's " + LazyLord.pct(firstA) + "%", "approximated");
      }
    }
    LazyLord.noteGradient(layer);
    return false;
  }

  if (LazyLord.pct(fillA) !== LazyLord.pct(alpha)) {
    LazyLord.warn(name, "The gradient's opacity could not be set on the fill, so the ramp shows at its first stop's " +
      LazyLord.pct(fillA) + "%", "approximated");
  }
  if (maxA - minA >= 0.001) {
    LazyLord.warn(name, "Gradient transparency changes between its stops, which the Gradient Ramp cannot show; the fill uses one overall opacity of " +
      LazyLord.pct(fillA) + "%", "approximated");
  }

  if (stops.length > 2) {
    var dropped = stops.length - 2;
    LazyLord.warn(name, "Gradient has " + stops.length + " colour stops but the Gradient Ramp takes two, so the first and last are kept and " +
      dropped + (dropped === 1 ? " stop" : " stops") + " in between " + (dropped === 1 ? "is" : "are") + " dropped", "approximated");
  }
  if (radial && (first.position || 0) > 0.001) {
    LazyLord.warn(name, "Radial gradient's first stop sits " + Math.round(first.position * 100) +
      "% out from the centre; the Gradient Ramp starts blending at the centre", "approximated");
  }
  return true;
};

/* -------------------------------------------------------------------------
 * Text layers
 * ---------------------------------------------------------------------- */

/** A font name compared loosely: case, spaces, hyphens and underscores ignored. */
LazyLord._ae_fontKey = function (s) {
  return String(s || "").replace(/[\s_\-]+/g, "").toLowerCase();
};

/**
 * PostScript names to try for a family and style, best first. After Effects
 * sets a text font by PostScript name only (TextDocument.fontFamily and
 * fontStyle are read-only), and the IR carries family and style.
 */
LazyLord._ae_fontNames = function (family, style) {
  var out = [];
  function add(n) {
    n = String(n || "");
    if (!n) return;
    for (var k = 0; k < out.length; k++) if (out[k] === n) return;
    out.push(n);
  }
  // After Effects 24+ can look a font up by family and style.
  try {
    if (app.fonts) {
      var found = app.fonts.getFontsByFamilyNameAndStyleName(family, style);
      for (var i = 0; found && i < found.length; i++) add(found[i].postScriptName);
    }
  } catch (e) {}
  // Otherwise the usual PostScript pattern, "Family-Style" without spaces; a
  // regular face is often named after its family alone.
  add((family + "-" + style).replace(/\s+/g, ""));
  if (/^(regular|normal|book|roman)$/i.test(style)) add(family.replace(/\s+/g, ""));
  return out;
};

/** Whether a text document shows the wanted font (`psName` is the name just set). */
LazyLord._ae_fontIs = function (td, family, style, psName) {
  if (!td) return false;
  // After Effects 24+ flags a font it only stands in for a missing one.
  try { if (td.fontObject && td.fontObject.isSubstitute === true) return false; } catch (e) {}
  // Without a family read-back, the name must at least have stuck.
  if (typeof td.fontFamily !== "string") return String(td.font) === psName;
  return LazyLord._ae_fontKey(td.fontFamily) === LazyLord._ae_fontKey(family) &&
    LazyLord._ae_fontKey(td.fontStyle) === LazyLord._ae_fontKey(style);
};

/**
 * Give a text layer the IR font, trying each candidate PostScript name and
 * reading back what After Effects actually shows. A font that cannot be
 * matched is reported with the one used instead. True when it matched.
 */
LazyLord._ae_font = function (prop, layer) {
  var name = layer.name || "Text";
  var family = String(layer.fontFamily || "");
  var style = String(layer.fontStyle || "Regular");
  if (!family) {
    LazyLord.warn(name, "The text names no font, so After Effects' current font is used", "approximated");
    return false;
  }
  var names = LazyLord._ae_fontNames(family, style);
  for (var i = 0; i < names.length; i++) {
    try {
      var td = prop.value;
      td.font = names[i];
      prop.setValue(td);
      if (LazyLord._ae_fontIs(prop.value, family, style, names[i])) return true;
    } catch (e) {} // try the next name; a miss is reported below
  }
  var shown = "";
  try {
    var now = prop.value;
    shown = String(now.fontFamily || now.font || "") + (now.fontStyle ? " " + now.fontStyle : "");
  } catch (eNow) {}
  var wanted = family + " " + style;
  // After Effects keeps a missing font's name and draws it with a stand-in, so
  // the read-back can match the request and still be a substitute.
  if (shown && LazyLord._ae_fontKey(shown) === LazyLord._ae_fontKey(wanted)) {
    LazyLord.warn(name, "Font '" + wanted + "' is not installed on this computer; After Effects keeps its name " +
      "but draws it with a substitute until it is installed (Figma's Google fonts are not installed with Figma)",
      "approximated");
  } else {
    LazyLord.warn(name, "Font '" + wanted + "' is not available in After Effects, so " +
      (shown ? "'" + shown + "'" : "its current font") + " is used instead", "approximated");
  }
  return false;
};

/**
 * Per-character styles, through TextDocument.characterRange (After Effects
 * 24.3 and newer): each run's size, colour, tracking and font are set on its
 * range, and the document is written back once.
 */
LazyLord._ae_textRuns = function (prop, layer) {
  var runs = LazyLord.fullTextRuns(layer);
  if (!runs.length) return;
  var name = layer.name || "Text";
  var td = prop.value;
  if (typeof td.characterRange !== "function") {
    LazyLord.warn(name, "Mixed character styles need After Effects 24.3 or newer, so the whole text uses its first style", "approximated");
    return;
  }
  var lost = [], deco = false;
  for (var i = 0; i < runs.length; i++) {
    var r = runs[i];
    var cr;
    try { cr = td.characterRange(r.start, r.end); } catch (e) { lost.push("a character range"); continue; }
    try { cr.fontSize = r.fontSize; } catch (e1) { lost.push("sizes"); }
    try { cr.applyFill = true; cr.fillColor = [r.color.r || 0, r.color.g || 0, r.color.b || 0]; } catch (e2) { lost.push("colours"); }
    try { cr.tracking = (r.letterSpacing / (r.fontSize || 24)) * 1000; } catch (e3) { lost.push("letter spacing"); }
    if (r.fontFamily) {
      var names = LazyLord._ae_fontNames(r.fontFamily, r.fontStyle);
      try { if (names.length) cr.font = names[0]; } catch (e4) { lost.push("fonts"); }
    }
    if (r.decoration !== (layer.decoration || "none")) deco = true;
  }
  prop.setValue(td);
  if (lost.length) {
    LazyLord.warn(name, "Some mixed character styles could not be applied (" + LazyLord._ae_unique(lost).join(", ") + ")", "approximated");
  }
  if (deco) LazyLord.warn(name, "Underline and strikethrough on part of the text are not rebuilt in After Effects", "approximated");
};

/** A list without repeats, first occurrence kept. */
LazyLord._ae_unique = function (list) {
  var out = [], seen = {};
  for (var i = 0; i < list.length; i++) if (!seen[list[i]]) { seen[list[i]] = true; out.push(list[i]); }
  return out;
};

LazyLord._ae_text = function (comp, layer) {
  var name = layer.name || "Text";
  var tl = comp.layers.addText(layer.characters || "");
  try {
    tl.name = name;
    var prop = tl.property("ADBE Text Properties").property("ADBE Text Document");
    var td = prop.value;
    td.resetCharStyle();
    td.text = layer.characters || "";
    td.fontSize = layer.fontSize || 24;

    var c = layer.color || { r: 0, g: 0, b: 0, a: 1 };
    td.applyFill = true;
    td.fillColor = [c.r || 0, c.g || 0, c.b || 0];
    td.applyStroke = false;

    if (layer.letterSpacing) td.tracking = (layer.letterSpacing / (layer.fontSize || 24)) * 1000;
    if (layer.lineHeight) td.leading = layer.lineHeight;

    try {
      var jmap = {
        left: ParagraphJustification.LEFT_JUSTIFY,
        center: ParagraphJustification.CENTER_JUSTIFY,
        right: ParagraphJustification.RIGHT_JUSTIFY,
        justified: ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT
      };
      td.justification = jmap[layer.textAlignHorizontal] || ParagraphJustification.LEFT_JUSTIFY;
    } catch (eJ) {
      LazyLord.warn(name, "Paragraph alignment could not be set, so the text keeps After Effects' current alignment", "approximated");
    }

    prop.setValue(td);
    // The font goes last: it is set by PostScript name and checked by reading back.
    LazyLord._ae_font(prop, layer);
    LazyLord._ae_textRuns(prop, layer);

    // fillColor has no alpha, so the colour's alpha joins the layer opacity:
    // exact, as the text has no stroke.
    var opacity = layer.frame.opacity;
    var ca = LazyLord._ae_alpha(c);
    if (ca < 1) opacity = (typeof opacity === "number" ? opacity : 1) * ca;

    // The text origin is its first baseline (exact when the source sent one),
    // carried through the frame rotation; turning the layer about that origin
    // equals turning the whole box about its centre.
    var xf = {
      anchor: [0, 0],
      position: LazyLord.rotatedTextAnchor(layer),
      scale: [100, 100],
      rotation: layer.frame.rotation || 0
    };
    LazyLord._ae_setTransform(tl, xf, opacity);
    LazyLord._ae_clip(tl, layer, xf);
    LazyLord._ae_applyBlend(tl, layer);
    LazyLord._ae_applyEffects(tl, layer);
  } catch (e) {
    LazyLord._ae_discard([tl]);
    throw e;
  }
  return tl;
};

/* -------------------------------------------------------------------------
 * Images and the project asset folder
 * ---------------------------------------------------------------------- */

LazyLord._ae_ASSET_FOLDER = "LazyLord Assets";

/**
 * Where generated images are kept for this transfer: a folder next to the
 * saved project, or null while the project is unsaved.
 */
LazyLord._ae_assetContext = function () {
  var ctx = { dir: null, noted: false };
  try {
    var f = app.project.file;
    if (f) ctx.dir = LazyLord.join(f.parent.fsName, LazyLord._ae_ASSET_FOLDER);
  } catch (e) {}
  return ctx;
};

/** A readable file name for a copied asset: the layer name, the source extension. */
LazyLord._ae_assetName = function (layer, path) {
  var file = String(path).replace(/^.*[\\\/]/, "");
  var dot = file.lastIndexOf(".");
  var ext = dot > 0 ? file.substring(dot) : ".png";
  var base = String(layer.name || "")
    .replace(/[\\\/:*?"<>|\x00-\x1f]+/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if (!base) base = dot > 0 ? file.substring(0, dot) : file;
  if (base.length > 100) base = base.substring(0, 100);
  return base + ext;
};

/** `dir/name`, or `dir/name-1`, `dir/name-2`… — never an existing file. */
LazyLord._ae_uniquePath = function (dir, fileName) {
  var dot = fileName.lastIndexOf(".");
  var base = dot > 0 ? fileName.substring(0, dot) : fileName;
  var ext = dot > 0 ? fileName.substring(dot) : "";
  var candidate = LazyLord.join(dir, fileName);
  for (var n = 1; new File(candidate).exists; n++) {
    if (n > 9999) throw new Error("no free file name was found");
    candidate = LazyLord.join(dir, base + "-" + n + ext);
  }
  return candidate;
};

/**
 * The file to import for an image layer. The user's own files are always used
 * in place. Images LazyLord generated are copied next to a saved project so
 * the project keeps working after the temp folder is cleaned up.
 */
LazyLord._ae_assetFile = function (assets, layer, path) {
  if (layer.isOriginalFile === true) return path;

  if (!assets.dir) {
    if (!assets.noted) {
      assets.noted = true;
      LazyLord.warn("Project", "The project has not been saved, so generated images are linked from the temporary folder " +
        "and go missing once LazyLord clears it (after a week). Save the project and later transfers copy them into a '" +
        LazyLord._ae_ASSET_FOLDER + "' folder beside it.", "approximated");
    }
    return path;
  }

  try {
    var folder = new Folder(assets.dir);
    if (!folder.exists && !folder.create()) throw new Error("the folder could not be created");
    var target = LazyLord._ae_uniquePath(assets.dir, LazyLord._ae_assetName(layer, path));
    if (!new File(path).copy(target)) throw new Error("the file could not be copied");
    return new File(target).fsName;
  } catch (e) {
    LazyLord.warn(layer.name || "Image", "Could not copy the generated image into '" + LazyLord._ae_ASSET_FOLDER +
      "' (" + ((e && e.message) || String(e)) + "), so it is linked from the temporary folder", "approximated");
    return path;
  }
};

LazyLord._ae_image = function (comp, layer, assets) {
  var path = LazyLord.imagePath(layer);
  if (!path) throw new Error("The image has no file to import");
  var src = LazyLord._ae_assetFile(assets || { dir: null, noted: true }, layer, path);

  var io = new ImportOptions(new File(src));
  var footage = app.project.importFile(io);
  footage.name = layer.name || "Image";
  var il = comp.layers.add(footage);
  try {
    var fw = layer.frame.width || footage.width;
    var fh = layer.frame.height || footage.height;
    // Footage turns about its own centre, which is the frame centre.
    var xf = {
      anchor: [footage.width / 2, footage.height / 2],
      position: [layer.frame.x + fw / 2, layer.frame.y + fh / 2],
      scale: [(fw / footage.width) * 100, (fh / footage.height) * 100],
      rotation: layer.frame.rotation || 0
    };
    LazyLord._ae_setTransform(il, xf, layer.frame.opacity);
    LazyLord._ae_clip(il, layer, xf);
    LazyLord._ae_applyBlend(il, layer);
    LazyLord._ae_applyEffects(il, layer);
  } catch (e) {
    LazyLord._ae_discard([il]);
    throw e;
  }
  return il;
};

/* -------------------------------------------------------------------------
 * Updating what an earlier transfer built (options.existing "update")
 *
 * Every layer this builder makes records where it came from in its comment
 * (LazyLord.makeTag). When the sender asks to update, those tags are read back
 * into an index and a matching layer is edited in place instead of a new one
 * being added — so it keeps its place in the stack, its parent, its effects
 * and anything else the user did to it.
 *
 * What gets written is only what LazyLord owns: the transform, the outline and
 * the paint. The layer's contents are searched for those properties rather
 * than assumed to be where they were left, and if the shape no longer holds
 * what the source describes (contours added, a group deleted) the mismatch is
 * reported and the rest is still updated. Nothing is ever deleted.
 *
 * Timeline behaviour is the point of the exercise: a property that is already
 * animated cannot take a plain value at all, so it gets a key at the playhead.
 * keyframes "always" keys every property instead, which is how re-sending a
 * shape animates it.
 * ---------------------------------------------------------------------- */

/** Layers in `comp` that carry a LazyLord tag, as tag key -> layer. */
LazyLord._ae_index = function (comp) {
  var index = {};
  // Bottom up (layer 1 is the top): a duplicate the user made (Ctrl+D) lands
  // above the original, tag and all, and must not be the one updated.
  for (var i = comp.numLayers; i >= 1; i--) {
    var lyr = comp.layer(i);
    var key = null;
    try { key = LazyLord.readTagKey(lyr.comment); } catch (e) { continue; }
    // First match wins: the lowest layer is the one an earlier transfer made.
    if (key && !index[key]) index[key] = lyr;
  }
  return index;
};

/** Record on a freshly built layer where it came from, keeping any comment. */
LazyLord._ae_tag = function (ctx, lyr, layer, role) {
  if (!ctx || !ctx.doc || !lyr || !layer) return;
  try {
    lyr.comment = LazyLord.withTag(lyr.comment, LazyLord.makeTag(ctx.doc, layer, role));
    if (ctx.seal) ctx.seal.push(lyr);
  } catch (e) {
    // A layer that cannot be tagged simply will not match next time.
  }
};

/*
 * Conflict detection. When a build or an update is finished — after parenting,
 * which rewrites a transform — every layer LazyLord wrote gets a fingerprint of
 * what an update would write to it (transform, outline, paint, text, footage)
 * in its tag. The next update reads the same things back: a different
 * fingerprint means the layer was edited here since. An animated property is
 * read as its keys and a still one as its value before expressions, so neither
 * the playhead nor an expression reads as an edit.
 */

LazyLord._ae_state = function (lyr) {
  var out = [];
  function add(prop) { out.push(LazyLord._ae_propPrint(prop)); }
  try {
    var tg = lyr.property("ADBE Transform Group");
    add(tg.property("ADBE Anchor Point"));
    add(tg.property("ADBE Position"));
    add(tg.property("ADBE Scale"));
    add(tg.property("ADBE Rotate Z"));
    add(tg.property("ADBE Opacity"));
  } catch (e) {
    out.push("no transform");
  }
  var parts = LazyLord._ae_findParts(lyr);
  for (var i = 0; i < parts.paths.length; i++) add(parts.paths[i]);
  try {
    if (parts.rect) {
      add(parts.rect.property("ADBE Vector Rect Size"));
      add(parts.rect.property("ADBE Vector Rect Position"));
      add(parts.rect.property("ADBE Vector Rect Roundness"));
    }
    if (parts.ellipse) {
      add(parts.ellipse.property("ADBE Vector Ellipse Size"));
      add(parts.ellipse.property("ADBE Vector Ellipse Position"));
    }
    if (parts.fill) {
      add(parts.fill.property("ADBE Vector Fill Color"));
      add(parts.fill.property("ADBE Vector Fill Opacity"));
    }
    if (parts.stroke) {
      add(parts.stroke.property("ADBE Vector Stroke Color"));
      add(parts.stroke.property("ADBE Vector Stroke Width"));
      add(parts.stroke.property("ADBE Vector Stroke Opacity"));
    }
  } catch (eP) {}
  try {
    var tp = lyr.property("ADBE Text Properties");
    if (tp) add(tp.property("ADBE Text Document"));
  } catch (eT) {}
  try {
    if (lyr.source && lyr.source.file) out.push("file " + lyr.source.file.fsName);
  } catch (eF) {}
  return LazyLord.hashText(out.join("|"));
};

/** One property for a fingerprint: its keys when animated, else its value. */
LazyLord._ae_propPrint = function (prop) {
  if (!prop) return "-";
  try {
    var n = 0;
    try { n = prop.numKeys || 0; } catch (eK) {}
    if (n > 0) {
      var keys = [];
      for (var k = 1; k <= n; k++) {
        keys.push(LazyLord.printValue(prop.keyTime(k)) + "=" + LazyLord._ae_valuePrint(prop.keyValue(k)));
      }
      return "k" + keys.join(";");
    }
    var v;
    try { v = prop.valueAtTime(0, true); } catch (eV) { v = prop.value; }
    return LazyLord._ae_valuePrint(v);
  } catch (e) {
    return "?";
  }
};

/** A property value as text: a Shape and a TextDocument by their parts. */
LazyLord._ae_valuePrint = function (v) {
  if (v && typeof v === "object" && v.vertices) {
    return "S" + LazyLord.printValue(v.vertices) + LazyLord.printValue(v.inTangents) +
      LazyLord.printValue(v.outTangents) + (v.closed ? "c" : "o");
  }
  if (v && typeof v === "object" && typeof v.text === "string") {
    var names = ["text", "font", "fontSize", "applyFill", "fillColor", "tracking", "leading", "justification"];
    var parts = [];
    for (var i = 0; i < names.length; i++) {
      // Some fields throw when they do not apply (fillColor without a fill).
      try { parts.push(LazyLord.printValue(v[names[i]])); } catch (e) { parts.push("-"); }
    }
    return "T" + parts.join(",");
  }
  return LazyLord.printValue(v);
};

/** Write the fingerprint of every layer this build or update wrote into its tag. */
LazyLord._ae_seal = function (ctx) {
  for (var i = 0; ctx.seal && i < ctx.seal.length; i++) {
    var lyr = ctx.seal[i];
    try { lyr.comment = LazyLord.sealTag(lyr.comment, LazyLord._ae_state(lyr)); } catch (e) {}
  }
};

/** Whether a tagged layer was edited here since LazyLord last wrote it. */
LazyLord._ae_edited = function (lyr) {
  if (!lyr) return false;
  try { return LazyLord.edited(lyr.comment, LazyLord._ae_state(lyr)); } catch (e) { return false; }
};

/**
 * Write `value` to `prop`: as a keyframe at the playhead when the property is
 * animated (a plain setValue throws on an animated property) or when the
 * sender asked for keys, otherwise as a plain value. Returns true when written.
 */
LazyLord._ae_put = function (ctx, prop, value) {
  if (!prop) return false;
  try {
    var animated = false;
    try { animated = prop.numKeys > 0; } catch (eKeys) {}
    if (animated || ctx.always) prop.setValueAtTime(ctx.time, value);
    else prop.setValue(value);
    return true;
  } catch (e) {
    return false;
  }
};

/** Keep a third component (a 3D layer's Z) that the IR has nothing to say about. */
LazyLord._ae_keepZ = function (prop, x, y) {
  try {
    var cur = prop.value;
    if (cur && cur.length > 2) return [x, y, cur[2]];
  } catch (e) {}
  return [x, y];
};

/** The transform half of an update. Returns how many properties were written. */
LazyLord._ae_putTransform = function (ctx, lyr, xf, opacity) {
  // The values are comp space, and a parented layer's are its parent's: take
  // it off its parent (Layer.parent keeps it where it shows), write, put it back.
  var parent = null;
  try { parent = lyr.parent; } catch (eP) {}
  if (parent) { try { lyr.parent = null; } catch (eU) { parent = null; } }
  try {
    return LazyLord._ae_writeTransform(ctx, lyr, xf, opacity);
  } finally {
    if (parent) { try { lyr.parent = parent; } catch (eR) {} }
  }
};

LazyLord._ae_writeTransform = function (ctx, lyr, xf, opacity) {
  var tg = lyr.property("ADBE Transform Group");
  var n = 0;
  var anchor = tg.property("ADBE Anchor Point");
  var position = tg.property("ADBE Position");
  var scale = tg.property("ADBE Scale");

  if (LazyLord._ae_put(ctx, anchor, LazyLord._ae_keepZ(anchor, xf.anchor[0], xf.anchor[1]))) n++;
  if (LazyLord._ae_put(ctx, position, LazyLord._ae_keepZ(position, xf.position[0], xf.position[1]))) n++;
  if (LazyLord._ae_put(ctx, scale, LazyLord._ae_keepZ(scale, xf.scale[0], xf.scale[1]))) n++;
  if (LazyLord._ae_put(ctx, tg.property("ADBE Rotate Z"), xf.rotation || 0)) n++;
  if (opacity !== undefined && opacity !== null) {
    if (LazyLord._ae_put(ctx, tg.property("ADBE Opacity"), LazyLord.pct(opacity))) n++;
  }
  return n;
};

/**
 * The properties LazyLord owns inside a shape layer, found by walking its
 * contents rather than assuming the shape was left as it was built.
 */
LazyLord._ae_findParts = function (sl) {
  var parts = { paths: [], rect: null, ellipse: null, fill: null, stroke: null };

  function walk(group) {
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      var mn;
      try { mn = p.matchName; } catch (e) { continue; }

      if (mn === "ADBE Vector Group") {
        var inner = null;
        try { inner = p.property("ADBE Vectors Group"); } catch (eG) {}
        if (inner) walk(inner);
      } else if (mn === "ADBE Vector Shape - Group") {
        try { parts.paths.push(p.property("ADBE Vector Shape")); } catch (eP) {}
      } else if (mn === "ADBE Vector Shape - Rect") {
        if (!parts.rect) parts.rect = p;
      } else if (mn === "ADBE Vector Shape - Ellipse") {
        if (!parts.ellipse) parts.ellipse = p;
      } else if (mn === "ADBE Vector Graphic - Fill") {
        if (!parts.fill) parts.fill = p;
      } else if (mn === "ADBE Vector Graphic - Stroke") {
        if (!parts.stroke) parts.stroke = p;
      }
    }
  }

  try { walk(sl.property("ADBE Root Vectors Group")); } catch (e) {}
  return parts;
};

/** Update a shape layer's outline. Returns how many properties were written. */
LazyLord._ae_putOutline = function (ctx, parts, layer, name) {
  var n = 0;
  var p = layer.primitive;
  var live = null;
  if (p && p.kind === "rect") live = parts.rect;
  else if (p && p.kind === "ellipse") live = parts.ellipse;

  if (live && typeof p.width === "number" && typeof p.height === "number") {
    var size = [p.width, p.height];
    var centre = [(p.x || 0) + p.width / 2, (p.y || 0) + p.height / 2];
    if (p.kind === "rect") {
      if (LazyLord._ae_put(ctx, live.property("ADBE Vector Rect Size"), size)) n++;
      if (LazyLord._ae_put(ctx, live.property("ADBE Vector Rect Position"), centre)) n++;
      if (LazyLord._ae_put(ctx, live.property("ADBE Vector Rect Roundness"), p.roundness || 0)) n++;
    } else {
      if (LazyLord._ae_put(ctx, live.property("ADBE Vector Ellipse Size"), size)) n++;
      if (LazyLord._ae_put(ctx, live.property("ADBE Vector Ellipse Position"), centre)) n++;
    }
    return n;
  }

  var subs = layer.subpaths || [];
  if (parts.paths.length === 0) {
    if (subs.length) {
      LazyLord.warn(name, "The layer no longer holds a path to update, so its outline was left alone", "skipped");
    }
    return n;
  }
  if (parts.paths.length !== subs.length) {
    LazyLord.warn(name, "The shape now has " + LazyLord._ae_plural(parts.paths.length, "contour") +
      " but the source sends " + subs.length + ", so only the ones that pair up were updated", "approximated");
  }
  var count = Math.min(parts.paths.length, subs.length);
  for (var i = 0; i < count; i++) {
    if (LazyLord._ae_put(ctx, parts.paths[i], LazyLord._ae_shapeOf(subs[i]))) n++;
  }
  return n;
};

/**
 * Update a shape layer's paint. Returns how many properties were written.
 * `part`: "fill" for the fill layer of a shape whose stroke has a layer of its
 * own, "stroke" for that stroke layer, else both.
 */
LazyLord._ae_putPaint = function (ctx, parts, layer, name, part) {
  var n = 0;
  var paint = LazyLord.fillPaint(layer);
  var gradient = LazyLord.isGradient(paint);

  if (part !== "stroke" && parts.fill && layer.fills && layer.fills.length) {
    var stops = gradient ? LazyLord._ae_sortedStops(paint) : null;
    var c = gradient ? stops[0].color : LazyLord.fillColor(layer);
    // A gradient's transparency rides on the fill, as the build put it there.
    var fa = gradient ? LazyLord._ae_stopsAlpha(stops) : LazyLord._ae_alpha(c);
    if (LazyLord._ae_put(ctx, parts.fill.property("ADBE Vector Fill Color"), LazyLord._ae_rgba(c))) n++;
    if (LazyLord._ae_put(ctx, parts.fill.property("ADBE Vector Fill Opacity"), LazyLord.pct(fa))) n++;
    if (gradient) {
      LazyLord.warn(name, "The gradient's colours were updated on the solid fill, but its Gradient Ramp was left as it was", "approximated");
    }
  }

  var stroke = part === "fill" ? null : LazyLord.firstStroke(layer);
  if (stroke && stroke.paint && parts.stroke) {
    var sc;
    if (LazyLord.isGradient(stroke.paint)) sc = LazyLord._ae_sortedStops(stroke.paint)[0].color;
    else sc = stroke.paint.color || { r: 0, g: 0, b: 0, a: 1 };
    if (LazyLord._ae_put(ctx, parts.stroke.property("ADBE Vector Stroke Color"), LazyLord._ae_rgba(sc))) n++;
    if (LazyLord._ae_put(ctx, parts.stroke.property("ADBE Vector Stroke Width"), stroke.weight || 1)) n++;
    if (LazyLord._ae_put(ctx, parts.stroke.property("ADBE Vector Stroke Opacity"), LazyLord.pct(LazyLord._ae_alpha(sc)))) n++;
  } else if (stroke && stroke.paint && !parts.stroke) {
    LazyLord.warn(name, "The source has a stroke but the layer has none to update; re-send with Add to rebuild it", "skipped");
  }

  return n;
};

LazyLord._ae_updateVector = function (ctx, lyr, layer, part) {
  var name = layer.name || "Vector";
  var parts = LazyLord._ae_findParts(lyr);
  var xf = LazyLord._ae_vectorXf(layer.frame);
  var n = 0;
  n += LazyLord._ae_putTransform(ctx, lyr, xf, layer.frame.opacity);
  n += LazyLord._ae_putOutline(ctx, parts, layer, name);
  n += LazyLord._ae_putPaint(ctx, parts, layer, name, part);
  LazyLord._ae_reclip(lyr, layer, xf);
  return n;
};

/** The stops' shared alpha, or their average when they differ (as _ae_ramp writes it). */
LazyLord._ae_stopsAlpha = function (stops) {
  var minA = 1, maxA = 0, sumA = 0;
  for (var i = 0; i < stops.length; i++) {
    var a = LazyLord._ae_alpha(stops[i].color);
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    sumA += a;
  }
  return (maxA - minA < 0.001) ? maxA : sumA / stops.length;
};

LazyLord._ae_updateText = function (ctx, lyr, layer) {
  var name = layer.name || "Text";
  var prop;
  try {
    prop = lyr.property("ADBE Text Properties").property("ADBE Text Document");
  } catch (e) {
    LazyLord.warn(name, "The matching layer is no longer a text layer, so it was left alone", "skipped");
    return 0;
  }

  // Start from what the layer has, so styling LazyLord never set is kept.
  var td = prop.value;
  td.text = layer.characters || "";
  td.fontSize = layer.fontSize || 24;

  var c = layer.color || { r: 0, g: 0, b: 0, a: 1 };
  td.applyFill = true;
  td.fillColor = [c.r || 0, c.g || 0, c.b || 0];

  if (layer.letterSpacing) td.tracking = (layer.letterSpacing / (layer.fontSize || 24)) * 1000;
  if (layer.lineHeight) td.leading = layer.lineHeight;

  try {
    var jmap = {
      left: ParagraphJustification.LEFT_JUSTIFY,
      center: ParagraphJustification.CENTER_JUSTIFY,
      right: ParagraphJustification.RIGHT_JUSTIFY,
      justified: ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT
    };
    td.justification = jmap[layer.textAlignHorizontal] || ParagraphJustification.LEFT_JUSTIFY;
  } catch (eJ) {}

  // A keyed Source Text takes no plain value, so the font and the character
  // styles (both written with setValue) go into this one keyed write instead.
  var keyed = ctx.always;
  try { if (prop.numKeys > 0) keyed = true; } catch (eK) {}
  if (keyed && layer.fontFamily) {
    try { td.font = LazyLord._ae_fontNames(String(layer.fontFamily), String(layer.fontStyle || "Regular"))[0]; } catch (eFN) {}
  }

  var n = LazyLord._ae_put(ctx, prop, td) ? 1 : 0;
  if (!keyed) {
    try { LazyLord._ae_font(prop, layer); } catch (eF) {}
    if (layer.runs && layer.runs.length) {
      try { LazyLord._ae_textRuns(prop, layer); } catch (eR) {}
    }
  } else if (layer.runs && layer.runs.length > 1) {
    LazyLord.warn(name, "The text is animated, so its mixed character styles were not re-applied; the key holds the first style", "approximated");
  }

  var opacity = layer.frame.opacity;
  var ca = LazyLord._ae_alpha(c);
  if (ca < 1) opacity = (typeof opacity === "number" ? opacity : 1) * ca;

  n += LazyLord._ae_putTransform(ctx, lyr, {
    anchor: [0, 0],
    position: LazyLord.rotatedTextAnchor(layer),
    scale: [100, 100],
    rotation: layer.frame.rotation || 0
  }, opacity);
  return n;
};

/** Whether two files hold the same bytes; false when either cannot be read. */
LazyLord._ae_sameFile = function (a, b) {
  try {
    var fa = new File(a), fb = new File(b);
    if (!fa.exists || !fb.exists || fa.length !== fb.length) return false;
    fa.encoding = fb.encoding = "BINARY";
    if (!fa.open("r")) return false;
    if (!fb.open("r")) { fa.close(); return false; }
    var same = fa.read() === fb.read();
    fa.close();
    fb.close();
    return same;
  } catch (e) {
    return false;
  }
};

LazyLord._ae_updateImage = function (ctx, lyr, layer) {
  var name = layer.name || "Image";
  var n = 0;
  var source = null;
  try { source = lyr.source; } catch (e) {}

  // Point the footage at the picture the source now sends, when it changed.
  // A generated image arrives at a new temporary path every time, so it is
  // compared by content, and a new one goes into the project's assets folder
  // like a built one (the temporary folder is cleared after a week).
  var path = LazyLord.imagePath(layer);
  if (path && source) {
    var current = null;
    try { current = source.file ? source.file.fsName : null; } catch (eF) {}
    var changed = current && String(current) !== String(path) &&
      (layer.isOriginalFile === true || !LazyLord._ae_sameFile(current, path));
    if (changed) {
      try {
        source.replace(new File(LazyLord._ae_assetFile(ctx.assets, layer, path)));
        n++;
      } catch (eR) {
        LazyLord.warn(name, "The image file changed but the footage could not be relinked, so the layer still shows the old one", "skipped");
      }
    }
  }

  var w = 0, h = 0;
  try { w = lyr.width || 0; h = lyr.height || 0; } catch (eW) {}
  var fw = layer.frame.width || w;
  var fh = layer.frame.height || h;

  var xf = {
    anchor: [w / 2, h / 2],
    position: [layer.frame.x + fw / 2, layer.frame.y + fh / 2],
    scale: [w ? (fw / w) * 100 : 100, h ? (fh / h) * 100 : 100],
    rotation: layer.frame.rotation || 0
  };
  n += LazyLord._ae_putTransform(ctx, lyr, xf, layer.frame.opacity);
  LazyLord._ae_reclip(lyr, layer, xf);
  return n;
};

/**
 * Update the layer an earlier transfer built from this source object.
 * Returns true when one was found and updated, false to build a new one.
 */
LazyLord._ae_update = function (ctx, layer) {
  var lyr = ctx.index[LazyLord.tagKey(ctx.doc, layer)];
  if (!lyr) return false;
  var strokeLyr = layer.type === "vector" ? ctx.index[LazyLord.tagKey(ctx.doc, layer, "stroke")] : null;

  var name = layer.name || "Layer";
  // Edited here since LazyLord last wrote it: keep those edits, or say they went.
  if (LazyLord._ae_edited(lyr) || LazyLord._ae_edited(strokeLyr)) {
    ctx.conflicts++;
    if (ctx.keep) {
      LazyLord.warn(name, "Was changed in After Effects since it was last sent, so it was left as you made it " +
        "(On conflict: Keep my edits)", "skipped");
      return true; // matched: do not add a duplicate either
    }
    LazyLord.warn(name, "Was changed in After Effects since it was last sent; the update replaced those changes", "approximated");
  }
  try {
    // With a stroke layer of its own, this one holds only the fill.
    if (layer.type === "vector") LazyLord._ae_updateVector(ctx, lyr, layer, strokeLyr ? "fill" : null);
    else if (layer.type === "text") LazyLord._ae_updateText(ctx, lyr, layer);
    else if (layer.type === "image") LazyLord._ae_updateImage(ctx, lyr, layer);
    else return false;
  } catch (e) {
    var why = (e && e.message) ? e.message : String(e);
    LazyLord.warn(name, "Could not be updated (" + why + "), so it was left as it was", "skipped");
    ctx.seal.push(lyr); // whatever was written before the failure is LazyLord's
    return true; // matched: do not also add a duplicate
  }

  // A gradient-filled shape keeps its stroke on a layer of its own; it carries
  // its own tag, so update it alongside (it has no fill to touch).
  if (strokeLyr) {
    try {
      LazyLord._ae_updateVector(ctx, strokeLyr, layer, "stroke");
      try { if (layer.name) strokeLyr.name = layer.name + " stroke"; } catch (eSN) {}
    } catch (eS) {
      LazyLord.warn(name, "The shape updated but its separate stroke layer did not", "approximated");
    }
    ctx.seal.push(strokeLyr);
  }

  // Keep the layer's name in step with the source; the comment tag stays.
  try { if (layer.name) lyr.name = layer.name; } catch (eN) {}
  ctx.seal.push(lyr);
  ctx.updated++;
  return true;
};

/* -------------------------------------------------------------------------
 * Blend modes and effects
 *
 * The two things a layer wears rather than is. After Effects has a native
 * blend mode for every one in the IR's vocabulary, and effects for the
 * shadows and blurs that travel — but not for all of them: an inner shadow
 * has no stock AE effect, and a background blur is a Figma idea with nothing
 * to map onto. Those are reported, as is any effect on a layer whose pixels
 * already carry it.
 * ---------------------------------------------------------------------- */

/** IR blend mode -> the BlendingMode constant of the same name. */
LazyLord._ae_BLEND = {
  "normal": "NORMAL",
  "multiply": "MULTIPLY",
  "screen": "SCREEN",
  "overlay": "OVERLAY",
  "darken": "DARKEN",
  "lighten": "LIGHTEN",
  "color-dodge": "CLASSIC_COLOR_DODGE",
  "color-burn": "CLASSIC_COLOR_BURN",
  "hard-light": "HARD_LIGHT",
  "soft-light": "SOFT_LIGHT",
  "difference": "DIFFERENCE",
  "exclusion": "EXCLUSION",
  "hue": "HUE",
  "saturation": "SATURATION",
  "color": "COLOR",
  "luminosity": "LUMINOSITY"
};

LazyLord._ae_applyBlend = function (lyr, layer) {
  var mode = layer.blendMode;
  if (!mode || mode === "normal") return;

  var name = LazyLord._ae_BLEND[mode];
  var value = name ? BlendingMode[name] : undefined;
  if (value === undefined) {
    LazyLord.warn(layer.name || "Layer", "After Effects has no '" + LazyLord.blendLabel(mode) +
      "' blend mode, so the layer is drawn as Normal", "approximated");
    return;
  }
  try {
    lyr.blendingMode = value;
  } catch (e) {
    LazyLord.warn(layer.name || "Layer", "The '" + LazyLord.blendLabel(mode) +
      "' blend mode could not be set, so the layer is drawn as Normal", "approximated");
  }
};

/**
 * Rebuild the IR's effects on `lyr`. Drop shadows and layer blurs become the
 * stock AE effects of the same name; the rest is reported.
 */
LazyLord._ae_applyEffects = function (lyr, layer) {
  var list = layer.effects;
  if (!list || !list.length) return;

  var name = layer.name || "Layer";
  for (var i = 0; i < list.length; i++) {
    var fx = list[i];
    if (!fx || !fx.kind) continue;
    try {
      if (fx.kind === "drop-shadow") LazyLord._ae_dropShadow(lyr, fx, name);
      else if (fx.kind === "layer-blur") LazyLord._ae_blur(lyr, fx, name);
      else if (fx.kind === "inner-shadow") {
        LazyLord.warn(name, "After Effects has no inner-shadow effect, so it was left off", "skipped");
      } else if (fx.kind === "background-blur") {
        LazyLord.warn(name, "A background blur blurs what is behind the layer, which After Effects " +
          "cannot do from the layer itself, so it was left off", "skipped");
      }
    } catch (e) {
      LazyLord.warn(name, "The " + LazyLord._ae_fxLabel(fx.kind) + " could not be rebuilt — " +
        ((e && e.message) ? e.message : String(e)), "skipped");
    }
  }
};

LazyLord._ae_fxLabel = function (kind) {
  return String(kind || "effect").replace(/-/g, " ");
};

/**
 * The stock Drop Shadow effect. AE describes a shadow by direction and
 * distance rather than by an x/y offset, so the IR's offset is turned into
 * one: AE measures its direction clockwise from straight up.
 */
LazyLord._ae_dropShadow = function (lyr, fx, name) {
  var fxGroup = lyr.property("ADBE Effect Parade");
  var shadow = fxGroup.addProperty("ADBE Drop Shadow");

  var dx = (fx.offset && fx.offset.x) || 0;
  var dy = (fx.offset && fx.offset.y) || 0;
  var distance = Math.sqrt(dx * dx + dy * dy);
  // atan2(dx, -dy) is 0 straight up and grows clockwise, which is AE's dial.
  var direction = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;

  var c = fx.color || { r: 0, g: 0, b: 0, a: 1 };
  LazyLord._ae_setFx(shadow, "ADBE Drop Shadow-0001", [c.r || 0, c.g || 0, c.b || 0, 1]);
  LazyLord._ae_setFx(shadow, "ADBE Drop Shadow-0002", LazyLord.pct(LazyLord._ae_alpha(c)) * 255 / 100);
  LazyLord._ae_setFx(shadow, "ADBE Drop Shadow-0003", direction);
  LazyLord._ae_setFx(shadow, "ADBE Drop Shadow-0004", distance);
  LazyLord._ae_setFx(shadow, "ADBE Drop Shadow-0005", fx.radius || 0);

  if (fx.spread) {
    LazyLord.warn(name, "The shadow's spread of " + Math.round(fx.spread) +
      " px has no equivalent in After Effects' Drop Shadow, so it was left off", "approximated");
  }
  return shadow;
};

/** The stock Gaussian Blur effect. */
LazyLord._ae_blur = function (lyr, fx, name) {
  var fxGroup = lyr.property("ADBE Effect Parade");
  var blur = fxGroup.addProperty("ADBE Gaussian Blur 2");
  // Figma's radius is the standard deviation; AE's Blurriness is roughly twice
  // it for the same visual spread.
  LazyLord._ae_setFx(blur, "ADBE Gaussian Blur 2-0001", (fx.radius || 0) * 2);
  try { blur.property("ADBE Gaussian Blur 2-0003").setValue(true); } catch (eEdge) {}
  void name;
  return blur;
};

/** Set one effect control, by match name, without failing the whole effect. */
LazyLord._ae_setFx = function (effect, matchName, value) {
  try {
    var prop = effect.property(matchName);
    if (prop) prop.setValue(value);
  } catch (e) {
    /* one control of an effect; the rest of it still applies */
  }
};
