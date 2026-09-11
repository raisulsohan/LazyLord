/*
 * LazyLord ExtendScript router + shared helpers.
 * The relevant host builder (ae/ai/ps) defines LazyLord.build(doc). This file is
 * host-agnostic and loaded first.
 */
#target none

if (typeof LazyLord === "undefined") { var LazyLord = {}; }

LazyLord.VERSION = "0.1.0";

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
    if (snap) result.message += " " + LazyLord.undoBuild(snap);
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
 *   { scale }  image export scale, 1 / 2 / 3 / 4 (default 2)
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
  var ox = doc.bounds.x || 0;
  var oy = doc.bounds.y || 0;
  if (!ox && !oy) return;
  LazyLord.eachLayer(doc.layers, function (layer) {
    if (layer.frame) {
      layer.frame.x += ox;
      layer.frame.y += oy;
    }
    if (typeof layer.baseline === "number") layer.baseline += oy;
    if (typeof layer.anchorX === "number") layer.anchorX += ox;
    if (layer.clip && layer.clip.subpaths) {
      for (var s = 0; s < layer.clip.subpaths.length; s++) {
        var vs = layer.clip.subpaths[s].vertices;
        for (var v = 0; v < vs.length; v++) vs[v] = [vs[v][0] + ox, vs[v][1] + oy];
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
  return { scale: ok ? scale : LazyLord.DEFAULT_SCALE };
};

/** What runRead was last asked for; readers use it when rasterising. */
LazyLord.readOptions = { scale: 2 };

/** The document's transfer options with defaults applied (mirrors core's transferOptions). */
LazyLord.options = function (doc) {
  var o = (doc && doc.options) || {};
  return {
    layout: o.layout === "combine" ? "combine" : "split",
    hierarchy: o.hierarchy === "groups" ? "groups" : "flatten",
    destination: o.destination === "new" ? "new" : "active",
    existing: o.existing === "update" ? "update" : "add",
    keyframes: o.keyframes === "always" ? "always" : "auto"
  };
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
 * ---------------------------------------------------------------------- */

LazyLord.TAG_RE = /\[\[LazyLord ([a-zA-Z]+)\|([^|\]]*)\|([^\]]*)\]\]/;

/** Strip the characters that would end the tag early. */
LazyLord._tagSafe = function (s) {
  return String(s === undefined || s === null ? "" : s).replace(/[\[\]|]/g, "");
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

/** Parse a tag out of a host's comment/note field, or null when there is none. */
LazyLord.readTag = function (text) {
  if (!text) return null;
  var m = LazyLord.TAG_RE.exec(String(text));
  if (!m) return null;
  return { app: m[1], key: m[2], id: m[3], token: m[0] };
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

/**
 * Report the effects a host cannot rebuild. Only After Effects has stock
 * effects that match the IR's, so the others say what was lost rather than
 * dropping it in silence.
 */
LazyLord.noteEffects = function (layer, why) {
  var list = layer.effects;
  if (!list || !list.length) return;

  var names = [];
  for (var i = 0; i < list.length; i++) {
    var label = String(list[i] && list[i].kind ? list[i].kind : "effect").replace(/-/g, " ");
    var seen = false;
    for (var j = 0; j < names.length; j++) if (names[j] === label) seen = true;
    if (!seen) names.push(label);
  }
  LazyLord.warn(layer.name || "Layer", (why || "Effects are not rebuilt here") + ": " + names.join(", "), "skipped");
};
