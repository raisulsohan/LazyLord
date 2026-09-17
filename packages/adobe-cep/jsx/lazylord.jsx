/*
 * LazyLord ExtendScript router + shared helpers.
 * The relevant host builder (ae/ai/ps) defines LazyLord.build(doc). This file is
 * host-agnostic and loaded first.
 */
#target none

if (typeof LazyLord === "undefined") { var LazyLord = {}; }

LazyLord.VERSION = "1.1.5";

/** Read a UTF-8 text file and return its contents. */
LazyLord.readFile = function (path) {
  var f = new File(path);
  f.encoding = "UTF-8";
  if (!f.exists) throw new Error("IR file not found: " + path);
  if (!f.open("r")) throw new Error("Could not open IR file: " + path);
  var content = f.read();
  f.close();
  return content;
};

/** Write a UTF-8 text file, creating parent folders as needed. */
LazyLord.writeFile = function (path, text) {
  var f = new File(path);
  f.parent.create();
  f.encoding = "UTF-8";
  if (!f.open("w")) throw new Error("Could not write: " + path);
  f.write(text);
  f.close();
  return f.fsName;
};

/** Join a directory and a name with a separator ExtendScript accepts anywhere. */
LazyLord.join = function (dir, name) {
  return String(dir).replace(/[\\\/]+$/, "") + "/" + name;
};

/* -------------------------------------------------------------------------
 * Diagnostics — every conversion that could not run natively
 * ---------------------------------------------------------------------- */

LazyLord.diagnostics = [];

LazyLord.resetDiagnostics = function () { LazyLord.diagnostics = []; };

/**
 * Record a fallback. `resolution` is the rung of the ladder that ran:
 * "approximated", "rasterized" or "skipped".
 */
LazyLord.warn = function (object, reason, resolution) {
  LazyLord.diagnostics.push({
    object: String(object || "(unnamed)"),
    reason: String(reason || "unsupported"),
    resolution: resolution || "approximated"
  });
};

/** Entry point invoked from the panel: LazyLord.run("/path/to/ir.json"). */
LazyLord.run = function (irPath) {
  var result = { ok: false, layersCreated: 0, message: "", diagnostics: [] };
  var snap = null;
  LazyLord.resetDiagnostics();
  try {
    if (typeof LazyLord.build !== "function") {
      throw new Error("No host builder is loaded for this application.");
    }
    var raw = LazyLord.readFile(irPath);
    var doc = JSON.parse(raw);
    if (!doc || !doc.layers) throw new Error("Invalid IR payload.");
    snap = LazyLord.takeSnapshot();
    result = LazyLord.build(doc);
  } catch (e) {
    result = { ok: false, layersCreated: 0, message: (e && e.message) ? e.message : String(e) };
    // All or nothing: a build that stops part-way takes back what it made.
    // One that refused before starting (nothingBuilt) has nothing to take back.
    if (snap && !(e && e.nothingBuilt)) result.message += " " + LazyLord.undoBuild(snap);
  }
  result.diagnostics = LazyLord.diagnostics;
  return JSON.stringify(result);
};

/*
 * Transactions. A host builder may define LazyLord.snapshot() — what exists
 * before a build — and LazyLord.rollback(snapshot) — remove what the build
 * added since, returning true when it all went. Rollback must only ever touch
 * things that were NOT in the snapshot (matched by id, never by position), and
 * leave anything it cannot identify alone.
 */

/** The host's snapshot, or null when it has none or cannot take one. */
LazyLord.takeSnapshot = function () {
  if (typeof LazyLord.snapshot !== "function") return null;
  try { return LazyLord.snapshot(); } catch (e) { return null; }
};

/** Roll back after a failed build; returns a sentence for the error message. */
LazyLord.undoBuild = function (snap) {
  if (typeof LazyLord.rollback !== "function") return "";
  try {
    return LazyLord.rollback(snap)
      ? "Everything this transfer had built was removed again."
      : "Some of what this transfer had built could not be identified and was left in place.";
  } catch (e) {
    return "What this transfer had built could not all be removed (" + ((e && e.message) || e) + ").";
  }
};

/**
 * Send entry point: LazyLord.runRead("/tmp/dir", opts) serialises the host's
 * current selection to <dir>/ir.json and returns a summary for the panel.
 *
 * `opts` carries the choices that only matter while reading — the ones the
 * builder never sees because they change what is written, not how it is built:
 *   { scale }     image export scale, 1 / 2 / 3 / 4 (default 2)
 *   { sequence }  Photoshop: the selected layers as the frames of one image sequence
 *   { target }    the app it is going to ("" for all): Photoshop lifts a pixel
 *                 layer's style off its pixels only for After Effects, which
 *                 rebuilds every style it reads
 */
LazyLord.runRead = function (outDir, opts) {
  var result = { ok: false, layerCount: 0, irPath: "", message: "", diagnostics: [] };
  LazyLord.resetDiagnostics();
  LazyLord.readOptions = LazyLord.normaliseReadOptions(opts);
  try {
    if (typeof LazyLord.readSelection !== "function") {
      throw new Error("This application cannot send yet.");
    }
    var doc = LazyLord.readSelection(outDir, LazyLord.readOptions);
    if (!doc || !doc.layers || doc.layers.length === 0) {
      throw new Error("Nothing to send — select at least one object.");
    }
    doc.diagnostics = LazyLord.diagnostics;
    result.irPath = LazyLord.writeFile(LazyLord.join(outDir, "ir.json"), JSON.stringify(doc));
    result.layerCount = LazyLord.countLeaves(doc.layers);
    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.message = (e && e.message) ? e.message : String(e);
  }
  result.diagnostics = LazyLord.diagnostics;
  return JSON.stringify(result);
};

/* -------------------------------------------------------------------------
 * Shared geometry / colour helpers (host builders use these)
 * ---------------------------------------------------------------------- */

/** RGBA (0..1) -> [r,g,b] 0..255 array. */
LazyLord.to255 = function (c) {
  return [
    Math.round((c.r || 0) * 255),
    Math.round((c.g || 0) * 255),
    Math.round((c.b || 0) * 255)
  ];
};

/** First solid fill colour of a layer, or black. */
LazyLord.fillColor = function (layer) {
  if (layer.fills) {
    for (var i = 0; i < layer.fills.length; i++) {
      if (layer.fills[i].type === "solid") return layer.fills[i].color;
    }
    for (var j = 0; j < layer.fills.length; j++) {
      var g = layer.fills[j];
      if (g.stops && g.stops.length) return g.stops[0].color;
    }
  }
  if (layer.color) return layer.color;
  return { r: 0, g: 0, b: 0, a: 1 };
};

LazyLord.firstStroke = function (layer) {
  if (layer.strokes && layer.strokes.length) return layer.strokes[0];
  return null;
};

/** The paint a host will actually use for a layer's fill, or null. */
LazyLord.fillPaint = function (layer) {
  if (layer.fills && layer.fills.length) return layer.fills[0];
  return null;
};

/**
 * Record the loss when a gradient fill is about to be flattened to a single
 * colour. Call it only on the paths where a host gives up on a native gradient.
 */
LazyLord.noteGradient = function (layer) {
  var p = LazyLord.fillPaint(layer);
  if (p && p.type && p.type !== "solid") {
    LazyLord.warn(layer.name || "Shape",
      "Gradient fill rebuilt as flat colour from its first stop", "approximated");
  }
};

/** True when a paint is a linear or radial gradient with at least one stop. */
LazyLord.isGradient = function (paint) {
  return !!(paint && (paint.type === "linear-gradient" || paint.type === "radial-gradient") &&
    paint.stops && paint.stops.length);
};

/**
 * A gradient's handles in the same space as `frame.x` / `frame.y` (after
 * applyOrigin, that is document space):
 *   { type, stops, from: [x, y], to: [x, y], radius }
 * `radius` is |to - from| in px — the radial radius, or the linear length.
 */
LazyLord.gradientPx = function (layer, paint) {
  var f = layer.frame;
  var w = f.width || 0, h = f.height || 0;
  var from = paint.from || { x: 0, y: 0.5 };
  var to = paint.to || { x: 1, y: 0.5 };
  var fx = f.x + from.x * w, fy = f.y + from.y * h;
  var tx = f.x + to.x * w, ty = f.y + to.y * h;
  var dx = tx - fx, dy = ty - fy;
  return {
    type: paint.type,
    stops: paint.stops,
    from: [fx, fy],
    to: [tx, ty],
    radius: Math.sqrt(dx * dx + dy * dy)
  };
};

/**
 * Size for a document or composition a builder has to create: the source
 * page when the artwork is placed in document space (so it lands inside),
 * otherwise the selection bounds. Never smaller than 1x1.
 */
LazyLord.canvasSize = function (doc, fallbackW, fallbackH) {
  var src = (doc.originSpace === "document" && doc.canvas) ? doc.canvas : doc.bounds;
  var w = Math.round((src && src.width) || 0) || fallbackW || 1000;
  var h = Math.round((src && src.height) || 0) || fallbackH || 1000;
  return { width: Math.max(1, w), height: Math.max(1, h) };
};

/** Centre of a frame's unrotated box, as [x, y]. */
LazyLord.frameCenter = function (frame) {
  return [frame.x + (frame.width || 0) / 2, frame.y + (frame.height || 0) / 2];
};

/**
 * Rotate `pt` clockwise by `deg` around `center` in the IR's y-down space
 * (clockwise on screen, matching Frame.rotation).
 */
LazyLord.rotatePoint = function (pt, center, deg) {
  if (!deg) return [pt[0], pt[1]];
  var r = deg * Math.PI / 180;
  var cos = Math.cos(r), sin = Math.sin(r);
  var dx = pt[0] - center[0], dy = pt[1] - center[1];
  return [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos];
};

/**
 * Where a text layer's first baseline starts, as [x, y].
 * Sources that know the real anchor (Illustrator point text) send it; otherwise
 * fall back to estimating the baseline at 80% of the font size below the box.
 */
LazyLord.textAnchor = function (layer) {
  var y = (typeof layer.baseline === "number")
    ? layer.baseline
    : layer.frame.y + (layer.fontSize || 24) * 0.8;

  var x;
  if (typeof layer.anchorX === "number") x = layer.anchorX;
  else if (layer.textAlignHorizontal === "center") x = layer.frame.x + layer.frame.width / 2;
  else if (layer.textAlignHorizontal === "right") x = layer.frame.x + layer.frame.width;
  else x = layer.frame.x;

  return [x, y];
};

/**
 * textAnchor, carried through the frame's rotation about its centre. Place a
 * text layer's origin here and then rotate the layer about that origin by
 * frame.rotation: the result equals rotating the whole box about its centre.
 */
LazyLord.rotatedTextAnchor = function (layer) {
  var a = LazyLord.textAnchor(layer);
  return LazyLord.rotatePoint(a, LazyLord.frameCenter(layer.frame), layer.frame.rotation || 0);
};

/**
 * A text layer's runs expanded to cover every character, in order, each with
 * every style field set: the layer's own style fills gaps and unset fields.
 * [] when the text has fewer than two distinct stretches (nothing to apply).
 */
LazyLord.fullTextRuns = function (layer) {
  var text = String(layer.characters || "");
  var runs = layer.runs;
  if (!runs || !runs.length || !text.length) return [];
  var sorted = runs.slice().sort(function (a, b) { return (a.start || 0) - (b.start || 0); });
  var base = {
    fontFamily: layer.fontFamily, fontStyle: layer.fontStyle || "Regular", fontSize: layer.fontSize || 24,
    color: layer.color || { r: 0, g: 0, b: 0, a: 1 }, letterSpacing: layer.letterSpacing || 0,
    decoration: layer.decoration || "none"
  };
  function full(start, end, r) {
    var o = { start: start, end: end };
    for (var k in base) {
      if (!base.hasOwnProperty(k)) continue;
      o[k] = (r && r[k] !== undefined && r[k] !== null) ? r[k] : base[k];
    }
    return o;
  }
  var out = [], at = 0;
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    var s = Math.max(at, r.start || 0);
    var e = Math.min(text.length, r.end || 0);
    if (e <= s) continue;
    if (s > at) out.push(full(at, s, null));
    out.push(full(s, e, r));
    at = e;
  }
  if (at < text.length) out.push(full(at, text.length, null));
  return out.length > 1 ? out : [];
};

/**
 * A text layer's manual kerning, checked: pairs inside the text, with a
 * finite non-zero amount, one per index, in order. [] when there are none.
 */
LazyLord.kernsOf = function (layer) {
  var list = layer && layer.kerns;
  var n = String((layer && layer.characters) || "").length;
  if (!list || typeof list.length !== "number") return [];
  var seen = {}, out = [];
  for (var i = 0; i < list.length; i++) {
    var k = list[i];
    if (!k || typeof k.index !== "number" || typeof k.amount !== "number") continue;
    if (k.index < 1 || k.index >= n || k.index !== Math.floor(k.index) || !isFinite(k.amount) || k.amount === 0) continue;
    if (seen[k.index]) continue;
    seen[k.index] = true;
    out.push({ index: k.index, amount: k.amount });
  }
  out.sort(function (a, b) { return a.index - b.index; });
  return out;
};

/** A target that cannot play an image sequence places its first frame, and says so. */
LazyLord.noteSequence = function (layer, host) {
  var s = layer && layer.sequence;
  if (!s || !s.frames || s.frames.length < 2) return;
  LazyLord.warn(layer.name || "Image", host + " has no image sequences, so only the first of its " + s.frames.length +
    " frames was placed", "approximated");
};

/**
 * Ask the user for a folder, starting in `start` when it exists. A JSON
 * string: { path } with the folder's full path, or "" when cancelled.
 */
LazyLord.chooseFolder = function (prompt, start) {
  var picked = null;
  try {
    var from = start ? new Folder(start) : null;
    picked = (from && from.exists) ? from.selectDlg(prompt) : Folder.selectDialog(prompt);
  } catch (e) {
    picked = null;
  }
  return JSON.stringify({ path: picked ? picked.fsName : "" });
};

/** Absolute path of a layer's image file, whichever field carries it. */
LazyLord.imagePath = function (layer) {
  return layer.filePath || layer.pngPath || null;
};

/**
 * Shift every layer by the document origin when the source measured its bounds
 * against a real page, so artwork lands where it sat on the artboard. A no-op
 * for canvas-space sources such as Figma. Clip paths live in frame space, so
 * they move with the frames.
 */
LazyLord.applyOrigin = function (doc) {
  if (!doc || doc.originSpace !== "document" || !doc.bounds) return;
  var ox = doc.bounds.x || 0, oy = doc.bounds.y || 0;
  LazyLord.shiftLayers(doc.layers, ox, oy);
  // Guides live in frame space too.
  for (var g = 0; doc.guides && g < doc.guides.length; g++) {
    doc.guides[g].position += (doc.guides[g].orientation === "vertical") ? ox : oy;
  }
};

/**
 * Move a layer tree by (dx, dy) in frame space, in place: frames, group
 * pages, text anchors and clip outlines. Local geometry is relative to its
 * frame and does not move.
 */
LazyLord.shiftLayers = function (layers, dx, dy) {
  if (!dx && !dy) return;
  LazyLord.eachLayer(layers, function (layer) {
    if (layer.frame) {
      layer.frame.x += dx;
      layer.frame.y += dy;
    }
    if (layer.page) {
      layer.page.x += dx;
      layer.page.y += dy;
    }
    if (typeof layer.baseline === "number") layer.baseline += dy;
    if (typeof layer.anchorX === "number") layer.anchorX += dx;
    if (layer.mask && layer.mask.frame) {
      layer.mask.frame.x += dx;
      layer.mask.frame.y += dy;
    }
    if (layer.clip && layer.clip.subpaths) {
      for (var s = 0; s < layer.clip.subpaths.length; s++) {
        var vs = layer.clip.subpaths[s].vertices;
        for (var v = 0; v < vs.length; v++) vs[v] = [vs[v][0] + dx, vs[v][1] + dy];
      }
    }
  });
};

/* -------------------------------------------------------------------------
 * Hierarchy and transfer options
 * ---------------------------------------------------------------------- */

/**
 * Depth-first walk over layers and group children, bottom-to-top, calling
 * cb(layer, parents) for groups and leaves alike. `parents` lists the
 * enclosing groups, outermost first (do not keep a reference to it).
 */
LazyLord.eachLayer = function (layers, cb, parents) {
  if (!layers) return;
  parents = parents || [];
  for (var i = 0; i < layers.length; i++) {
    var layer = layers[i];
    cb(layer, parents);
    if (layer.type === "group" && layer.children) {
      parents.push(layer);
      LazyLord.eachLayer(layer.children, cb, parents);
      parents.pop();
    }
  }
};

/**
 * The leaves of a layer tree in stacking order (bottom-to-top), for targets
 * that flatten hierarchy. Each group's opacity is multiplied into its
 * leaves' frame.opacity, which is exact unless leaves overlap; `lossy` counts
 * the groups where that approximation applied.
 */
LazyLord.flattenLayers = function (layers) {
  var out = [];
  var lossy = 0;
  function walk(list, opacity) {
    for (var i = 0; i < list.length; i++) {
      var layer = list[i];
      if (layer.type === "group") {
        var go = (layer.frame && typeof layer.frame.opacity === "number") ? layer.frame.opacity : 1;
        // Leaves, not direct children: a faded frame round one group of several
        // shapes is just as lossy, and one shape beside an empty group is exact.
        if (go < 1 && LazyLord.countLeaves(layer.children || []) > 1) lossy++;
        walk(layer.children || [], opacity * go);
      } else {
        if (opacity < 1 && layer.frame) {
          var lo = (typeof layer.frame.opacity === "number") ? layer.frame.opacity : 1;
          layer.frame.opacity = lo * opacity;
        }
        out.push(layer);
      }
    }
  }
  walk(layers || [], 1);
  out.lossy = lossy;
  return out;
};

/** Number of leaf layers in a tree (groups themselves are not counted). */
LazyLord.countLeaves = function (layers) {
  var n = 0;
  LazyLord.eachLayer(layers, function (layer) { if (layer.type !== "group") n++; });
  return n;
};

/** Image export scales a reader offers, matching the Figma plugin's. */
LazyLord.SCALES = [1, 2, 3, 4];
LazyLord.DEFAULT_SCALE = 2;

/** Read-time options with defaults applied. Set by runRead, read by the readers. */
LazyLord.normaliseReadOptions = function (opts) {
  var scale = opts ? Number(opts.scale) : NaN;
  var ok = false;
  for (var i = 0; i < LazyLord.SCALES.length; i++) if (LazyLord.SCALES[i] === scale) ok = true;
  return {
    scale: ok ? scale : LazyLord.DEFAULT_SCALE,
    sequence: !!(opts && opts.sequence === true),
    target: (opts && typeof opts.target === "string") ? opts.target : ""
  };
};

/** What runRead was last asked for; readers use it when rasterising. */
LazyLord.readOptions = { scale: 2 };

/** The document's transfer options with defaults applied (mirrors core's transferOptions). */
LazyLord.options = function (doc) {
  var o = (doc && doc.options) || {};
  return {
    layout: o.layout === "combine" ? "combine" : "split",
    hierarchy: (o.hierarchy === "groups" || o.hierarchy === "precomps") ? o.hierarchy : "flatten",
    destination: o.destination === "new" ? "new" : "active",
    existing: o.existing === "update" ? "update" : "add",
    keyframes: o.keyframes === "always" ? "always" : "auto",
    conflict: o.conflict === "keep" ? "keep" : "overwrite",
    guides: o.guides === true,
    swatches: o.swatches === true
  };
};

/** The guides and swatches a builder should add: [] unless asked for and sent. */
LazyLord.wantedGuides = function (doc) {
  return (LazyLord.options(doc).guides && doc.guides && doc.guides.length) ? doc.guides : [];
};
LazyLord.wantedSwatches = function (doc) {
  return (LazyLord.options(doc).swatches && doc.swatches && doc.swatches.length) ? doc.swatches : [];
};

/** True when the builder must make a new document / comp even if one is open. */
LazyLord.wantsNewDocument = function (doc) {
  return LazyLord.options(doc).destination === "new";
};

/**
 * True when the sender asked to update what a previous transfer built. A new
 * document has nothing to update, so the two options cannot combine.
 */
LazyLord.wantsUpdate = function (doc) {
  var o = LazyLord.options(doc);
  return o.existing === "update" && o.destination !== "new";
};

/* -------------------------------------------------------------------------
 * Layer tags — the mapping between a source object and what was built from it
 *
 * A target layer records where it came from in the one writable string its
 * host gives every layer (an After Effects comment, an Illustrator note). The
 * tag is a single bracketed token, so whatever else the user keeps in that
 * field survives a re-tag untouched:
 *
 *   [[LazyLord figma|abc123|1:42]]
 *            source app  |  source document  |  source layer
 *
 * The document key is what stops a layer id from one file matching the same id
 * in another; when the source could not offer one it is empty, and a tag with
 * an empty key only ever matches another empty one.
 *
 * Once a build or an update is finished, the tag also carries a fingerprint of
 * what LazyLord wrote to the layer — `[[LazyLord figma|abc123|1:42~k3f9.2a]]`.
 * The next update compares it with the layer as it is now: a difference means
 * the layer was edited in this app since, which is a conflict (see
 * TransferOptions.conflict). The fingerprint is not part of the lookup key.
 * ---------------------------------------------------------------------- */

LazyLord.TAG_RE = /\[\[LazyLord ([a-zA-Z]+)\|([^|\]]*)\|([^\]]*)\]\]/;

/** Strip the characters that would end the tag, or its id, early. */
LazyLord._tagSafe = function (s) {
  return String(s === undefined || s === null ? "" : s).replace(/[\[\]|~]/g, "");
};

/**
 * A host's blend-mode value as the IR's name, for a reader: `modes` is the
 * host's enum (BlendingMode, BlendModes, BlendMode) and `map` the builder's IR
 * name -> enum member table, read backwards. null for Normal (and pass
 * through), which the IR leaves out; a mode the IR cannot name is reported and
 * sent as Normal.
 */
LazyLord.blendFromHost = function (value, modes, map, object) {
  if (value === undefined || value === null || !modes) return null;
  try {
    if (value === modes.NORMAL || value === modes.PASSTHROUGH) return null;
  } catch (e) {}
  for (var ir in map) {
    if (map.hasOwnProperty(ir) && modes[map[ir]] !== undefined && modes[map[ir]] === value) return ir;
  }
  LazyLord.warn(object || "Layer", "Its blend mode (" + String(value) + ") has no match in the other apps, so it is sent as Normal", "approximated");
  return null;
};

/** A short, stable hash of a string (djb2 plus the length), as the panels use. */
LazyLord.hashText = function (s) {
  s = String(s);
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + "." + s.length.toString(36);
};

/**
 * A value read back from a host, as text for a fingerprint: numbers rounded to
 * a thousandth so float noise never reads as an edit, arrays element by element.
 */
LazyLord.printValue = function (v) {
  if (v === undefined || v === null) return "-";
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  if (typeof v === "boolean" || typeof v === "string") return String(v);
  if (typeof v.length === "number" && typeof v !== "function") {
    var parts = [];
    for (var i = 0; i < v.length; i++) parts.push(LazyLord.printValue(v[i]));
    return "[" + parts.join(",") + "]";
  }
  return String(v);
};

/**
 * The identity of an IR layer as an opaque string: source app, document, id.
 * `role` separates several host layers built from one source object — After
 * Effects splits a gradient-filled shape's stroke onto a layer of its own — so
 * each gets its own tag and each can be updated.
 */
LazyLord.tagKey = function (doc, layer, role) {
  return LazyLord._tagSafe((doc && doc.source) || "unknown") + "|" +
         LazyLord._tagSafe(doc && doc.sourceKey) + "|" +
         LazyLord._tagSafe(layer && layer.id) +
         (role ? "#" + LazyLord._tagSafe(role) : "");
};

/** The token to store on a built layer. */
LazyLord.makeTag = function (doc, layer, role) {
  return "[[LazyLord " + LazyLord.tagKey(doc, layer, role) + "]]";
};

/**
 * Parse a tag out of a host's comment/note field, or null when there is none.
 * `fp` is the fingerprint of what LazyLord last wrote ("" on an older tag).
 */
LazyLord.readTag = function (text) {
  if (!text) return null;
  var m = LazyLord.TAG_RE.exec(String(text));
  if (!m) return null;
  var id = m[3], fp = "";
  var cut = id.indexOf("~");
  if (cut >= 0) {
    fp = id.substring(cut + 1);
    id = id.substring(0, cut);
  }
  return { app: m[1], key: m[2], id: id, fp: fp, token: m[0] };
};

/** The field with its tag's fingerprint set to `fp` (unchanged when it holds no tag). */
LazyLord.sealTag = function (text, fp) {
  var t = LazyLord.readTag(text);
  if (!t) return text;
  var token = "[[LazyLord " + t.app + "|" + t.key + "|" + t.id + (fp ? "~" + LazyLord._tagSafe(fp) : "") + "]]";
  return String(text).replace(t.token, token);
};

/**
 * Whether a tagged layer was edited since LazyLord last wrote it: its tag holds
 * a fingerprint and `current` (the layer's fingerprint now) differs from it.
 */
LazyLord.edited = function (text, current) {
  var t = LazyLord.readTag(text);
  return !!(t && t.fp && current && t.fp !== current);
};

/** The lookup key of whatever tag a comment/note holds, or null. */
LazyLord.readTagKey = function (text) {
  var t = LazyLord.readTag(text);
  return t ? (t.app + "|" + t.key + "|" + t.id) : null;
};

/**
 * The user's text with our tag set to `tag` — replacing an existing tag in
 * place, or appended on its own line. Anything else in the field is kept.
 */
LazyLord.withTag = function (text, tag) {
  var s = (text === undefined || text === null) ? "" : String(text);
  var existing = LazyLord.readTag(s);
  if (existing) return s.replace(existing.token, tag);
  if (!s) return tag;
  return s + "\n" + tag;
};

/** The user's text with our tag removed, trimmed of the gap it leaves. */
LazyLord.stripTag = function (text) {
  var s = (text === undefined || text === null) ? "" : String(text);
  var existing = LazyLord.readTag(s);
  if (!existing) return s;
  return s.replace(existing.token, "").replace(/[ \t]+\n/g, "\n").replace(/^\s+|\s+$/g, "");
};

/**
 * Name for a document or comp a builder creates: the source page (artboard,
 * comp, Figma frame) when the transfer names one, otherwise the document's own
 * name (Figma uses the selected object's name when one thing is sent).
 */
LazyLord.docName = function (doc, fallback) {
  return String((doc.canvas && doc.canvas.name) || doc.name || fallback || "LazyLord");
};

/**
 * Iterate a layer's subpaths, calling cb(subpath) for each. Subpath shape:
 *   { closed, vertices:[[x,y]...], inTangents:[[dx,dy]...], outTangents:[[dx,dy]...] }
 */
LazyLord.eachSubPath = function (layer, cb) {
  if (!layer.subpaths) return;
  for (var i = 0; i < layer.subpaths.length; i++) cb(layer.subpaths[i], i);
};

/** Absolute in/out control points for a vertex index of a subpath. */
LazyLord.controlPoints = function (sp, i) {
  var v = sp.vertices[i];
  var it = sp.inTangents[i] || [0, 0];
  var ot = sp.outTangents[i] || [0, 0];
  return {
    anchor: [v[0], v[1]],
    inAbs: [v[0] + it[0], v[1] + it[1]],
    outAbs: [v[0] + ot[0], v[1] + ot[1]]
  };
};

/** Convenience: clamp opacity 0..1 to 0..100 percent. */
LazyLord.pct = function (o) {
  if (o === undefined || o === null) return 100;
  return Math.max(0, Math.min(100, Math.round(o * 100)));
};

/** A blend mode's name as a label for a diagnostic ("color-dodge" -> "Color Dodge"). */
LazyLord.blendLabel = function (mode) {
  var parts = String(mode || "").split("-");
  for (var i = 0; i < parts.length; i++) {
    if (parts[i]) parts[i] = parts[i].charAt(0).toUpperCase() + parts[i].substring(1);
  }
  return parts.join(" ");
};

/**
 * Apply a layer's blend mode through a host's own enum.
 *
 * `enumObj` is the host's blend-mode enum (Illustrator's BlendModes,
 * Photoshop's BlendMode) and `map` turns the IR's names into its keys. A mode
 * the host does not have, or will not take, is reported rather than guessed.
 * Returns true when something was set.
 */
LazyLord.applyBlend = function (setter, layer, enumObj, map) {
  var mode = layer.blendMode;
  if (!mode || mode === "normal") return false;

  var key = map[mode];
  var value = (key && enumObj) ? enumObj[key] : undefined;
  if (value === undefined) {
    LazyLord.warn(layer.name || "Layer", "This app has no '" + LazyLord.blendLabel(mode) +
      "' blend mode, so the layer is drawn as Normal", "approximated");
    return false;
  }
  try {
    setter(value);
    return true;
  } catch (e) {
    LazyLord.warn(layer.name || "Layer", "The '" + LazyLord.blendLabel(mode) +
      "' blend mode could not be set, so the layer is drawn as Normal", "approximated");
    return false;
  }
};

/** An effect kind as the diagnostics name it ("drop-shadow" -> "drop shadow"). */
LazyLord.effectLabel = function (kind) {
  return String(kind || "effect").replace(/-/g, " ");
};

/**
 * Photoshop clipping masks (clipTo) and layer masks (mask) that `host` does
 * not rebuild, reported once per layer so nothing is dropped silently.
 */
LazyLord.noteMasks = function (layers, host) {
  LazyLord.eachLayer(layers, function (layer) {
    if (!layer) return;
    if (layer.mask) {
      LazyLord.warn(layer.name, "Its layer mask is not rebuilt in " + host + ", so it shows unmasked", "approximated");
    }
    if (layer.clipTo) {
      LazyLord.warn(layer.name, "Its clipping mask is not rebuilt in " + host + ", so it shows unclipped", "approximated");
    }
  });
};

/*
 * Gradient notes
 *
 * A real Gradient Fill or Stroke in After Effects has colours no script can
 * read back, so the AE builder notes the stops it gave each one in the layer's
 * comment, filed under where the property sits (vector group indices, then its
 * index in that group's contents, then fill or stroke):
 *   {{LazyLord gradients 1:3|fill|0,1,0,0,1;1,0,0,1,0.5}}
 * each stop "position,r,g,b,a". ae-read.jsx reads the note back.
 */

/** The {{LazyLord gradients …}} token in a layer comment. */
LazyLord.GRADIENT_STASH_RE = /\s*\{\{LazyLord gradients ([^}]*)\}\}/;

/** Gradient entries from a comment: { "path:index|kind": "pos,r,g,b,a;…" }. */
LazyLord.readGradientStash = function (text) {
  var out = {};
  var m = LazyLord.GRADIENT_STASH_RE.exec(String(text || ""));
  if (!m) return out;
  var items = m[1].split(" ");
  for (var i = 0; i < items.length; i++) {
    var bar = items[i].lastIndexOf("|");
    if (bar > 0) out[items[i].substr(0, bar)] = items[i].substr(bar + 1);
  }
  return out;
};

/** The key a stashed gradient is filed under. */
LazyLord.gradientStashKey = function (path, index, kind) {
  return path.join(".") + ":" + index + "|" + kind;
};

/** Stops parsed back from a stash value, or null when it does not read. */
LazyLord.parseGradientStops = function (value) {
  var stops = [];
  var rows = String(value || "").split(";");
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i].split(",");
    if (v.length !== 5) return null;
    var n = [];
    for (var k = 0; k < 5; k++) {
      n.push(parseFloat(v[k]));
      if (isNaN(n[k])) return null;
    }
    stops.push({ position: n[0], color: { r: n[1], g: n[2], b: n[3], a: n[4] } });
  }
  return stops.length >= 2 ? stops : null;
};
