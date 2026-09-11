/**
 * LazyLord — Figma builder (receive side).
 * Rebuilds LazyLord IR as native Figma nodes: vector networks, live text,
 * image fills and real groups.
 *
 * Figma shares the IR's y-down space with its origin at the page, so nothing
 * is flipped here. Two things are particular to this host:
 *
 *  - Geometry goes in as SVG path data (`vectorPaths`), not vertices, so the
 *    IR's bezier contours are written out with `subPathsToSvg`.
 *  - A font must be loaded before any text using it can be created or edited,
 *    and loading is async, so the whole build is async and fonts are loaded
 *    once up front rather than per layer.
 *
 * Everything that cannot be rebuilt natively records a diagnostic, the same
 * ladder every other host follows.
 */

import type {
  ClipPath,
  Diagnostic,
  Document,
  GroupLayer,
  ImageLayer,
  Layer,
  Paint,
  RGBA,
  Swatch,
  TextLayer,
  VectorLayer,
} from "@lazylord/core";
import { gradientTransformFromHandles, moveLayers, subPathsToSvg, transferOptions } from "@lazylord/core";

export type BuildResult = {
  ok: boolean;
  layersCreated: number;
  message: string;
  diagnostics: Diagnostic[];
};

type Ctx = {
  diagnostics: Diagnostic[];
  created: number;
  /** Every font this transfer could actually load, by "family|style". */
  fonts: Set<string>;
  fallback: FontName;
};

const FALLBACK_FONT: FontName = { family: "Inter", style: "Regular" };

function warn(ctx: Ctx, object: string, reason: string, resolution: Diagnostic["resolution"]) {
  ctx.diagnostics.push({ object: object || "(unnamed)", reason, resolution });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function buildDocument(doc: Document): Promise<BuildResult> {
  const ctx: Ctx = { diagnostics: [], created: 0, fonts: new Set(), fallback: FALLBACK_FONT };

  try {
    await loadFonts(doc, ctx);
  } catch {
    // Not even the fallback loaded; text layers will report it one by one.
  }

  const opts = transferOptions(doc);
  const layers = doc.layers || [];

  // Where the transfer lands: a frame of its own, or straight onto the page.
  let parent: BaseNode & ChildrenMixin = figma.currentPage;
  let frame: FrameNode | null = null;
  if (opts.destination === "new") {
    frame = makeFrame(doc);
    parent = frame;
    // A frame the size of the source page: the artwork goes where it sat on
    // that page (frames are measured from the selection's corner), as the guides do.
    if (doc.originSpace === "document" && doc.canvas && doc.bounds) moveLayers(layers, doc.bounds.x || 0, doc.bounds.y || 0);
  }

  const made = await buildList(layers, ctx, parent);

  if (frame) {
    placeFrame(frame, doc);
    figma.currentPage.appendChild(frame);
  }
  addGuides(doc, opts, frame, ctx);
  if (opts.swatches && doc.swatches && doc.swatches.length) await addSwatches(doc.swatches, ctx);

  if (made.length === 0 && !frame) {
    return { ok: false, layersCreated: 0, message: "Nothing in the transfer could be rebuilt.", diagnostics: ctx.diagnostics };
  }

  // Select and reveal what arrived, so it is not lost somewhere on the page.
  const selection = frame ? [frame] : made;
  figma.currentPage.selection = selection;
  figma.viewport.scrollAndZoomIntoView(selection);

  return {
    ok: true,
    layersCreated: ctx.created,
    message: frame ? `Built into a new frame, "${frame.name}".` : "",
    diagnostics: ctx.diagnostics,
  };
}

/**
 * Load every font the transfer asks for, once. A font Figma does not have
 * falls back to Inter, reported per family rather than per layer.
 */
async function loadFonts(doc: Document, ctx: Ctx) {
  const wanted = new Map<string, FontName>();
  const collect = (layers: ReadonlyArray<Layer>) => {
    for (const l of layers) {
      if (l.type === "text") {
        const f = { family: l.fontFamily || FALLBACK_FONT.family, style: l.fontStyle || "Regular" };
        wanted.set(`${f.family}|${f.style}`, f);
        for (const r of l.runs || []) {
          if (!r.fontFamily) continue;
          const rf = { family: r.fontFamily, style: r.fontStyle || "Regular" };
          wanted.set(`${rf.family}|${rf.style}`, rf);
        }
      } else if (l.type === "group") {
        collect(l.children || []);
      }
    }
  };
  collect(doc.layers || []);

  // The fallback is loaded whether or not anything asked for it.
  try {
    await figma.loadFontAsync(FALLBACK_FONT);
    ctx.fonts.add(`${FALLBACK_FONT.family}|${FALLBACK_FONT.style}`);
  } catch {
    /* reported by whichever text layer needs it */
  }

  for (const [key, font] of wanted) {
    if (ctx.fonts.has(key)) continue;
    try {
      await figma.loadFontAsync(font);
      ctx.fonts.add(key);
    } catch {
      warn(
        ctx,
        `${font.family} ${font.style}`,
        `This font is not available here, so the text using it is set in ${FALLBACK_FONT.family} instead`,
        "approximated"
      );
    }
  }
}

/** Ruler guides live on frames in Figma, so they need the new frame a New destination makes. */
function addGuides(doc: Document, opts: { guides: boolean }, frame: FrameNode | null, ctx: Ctx) {
  const guides = opts.guides && doc.guides ? doc.guides : [];
  if (!guides.length) return;
  if (!frame) {
    warn(ctx, "Guides", "Figma keeps guides on frames, so they are added only when the transfer makes a new frame", "skipped");
    return;
  }
  const page = doc.originSpace === "document" && doc.bounds ? doc.bounds : { x: 0, y: 0 };
  try {
    frame.guides = guides.map((g) =>
      g.orientation === "vertical" ? { axis: "X" as const, offset: g.position + page.x } : { axis: "Y" as const, offset: g.position + page.y }
    );
  } catch (e) {
    warn(ctx, "Guides", `The guides could not be added — ${message(e)}`, "skipped");
  }
}

/** Named colours as local colour styles; a name the file already has is left alone. */
async function addSwatches(swatches: Swatch[], ctx: Ctx) {
  let names = new Set<string>();
  try {
    const styles: PaintStyle[] = await (figma as any).getLocalPaintStylesAsync();
    names = new Set(styles.map((s) => s.name));
  } catch {
    /* no list: every swatch is added */
  }
  let failed = 0;
  for (const s of swatches) {
    if (names.has(s.name)) continue;
    try {
      const style = figma.createPaintStyle();
      style.name = s.name;
      style.paints = [solidPaint(s.color)];
    } catch {
      failed++;
    }
  }
  if (failed) warn(ctx, "Swatches", `${failed} of ${swatches.length} colour styles could not be added`, "skipped");
}

function makeFrame(doc: Document): FrameNode {
  const frame = figma.createFrame();
  const size = doc.canvas && doc.originSpace === "document" ? doc.canvas : doc.bounds;
  frame.resize(Math.max(1, Math.round(size.width || 1)), Math.max(1, Math.round(size.height || 1)));
  frame.name = (doc.canvas && doc.canvas.name) || doc.name || "LazyLord";
  frame.clipsContent = true;
  // A frame is opaque by default; the transfer brings its own background.
  frame.fills = [];
  return frame;
}

/** Put a new frame beside whatever is already on the page, never on top of it. */
function placeFrame(frame: FrameNode, doc: Document) {
  const siblings = figma.currentPage.children.filter((n) => n !== frame);
  let right = 0;
  let top = 0;
  let first = true;
  for (const n of siblings) {
    if (first) {
      top = n.y;
      first = false;
    } else {
      top = Math.min(top, n.y);
    }
    right = Math.max(right, n.x + n.width);
  }
  frame.x = first ? 0 : right + 100;
  frame.y = first ? 0 : top;
  void doc;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * Build `list` (bottom to top) into `parent`. Layers carry their clip each, in
 * frame space; a run of siblings sharing one clip is built as a group masked
 * by that clip, which is how Figma expresses it.
 */
async function buildList(list: ReadonlyArray<Layer>, ctx: Ctx, parent: BaseNode & ChildrenMixin): Promise<SceneNode[]> {
  const out: SceneNode[] = [];
  const clipOf = (l: Layer | undefined) => (l && l.type !== "group" ? l.clip : undefined);
  let i = 0;
  while (i < list.length) {
    const clip = clipOf(list[i]);
    if (!clip) {
      const node = await buildLayer(list[i], ctx, parent);
      if (node) out.push(node);
      i++;
      continue;
    }
    const first = list[i];
    const run: SceneNode[] = [];
    while (i < list.length && clipOf(list[i]) && clipOf(list[i])!.id === clip.id) {
      const node = await buildLayer(list[i], ctx, parent);
      if (node) run.push(node);
      i++;
    }
    if (!run.length) continue;
    const mask = buildMask(clip, first.name || "Layer", ctx, parent, run[0]);
    if (!mask) {
      out.push(...run);
      continue;
    }
    try {
      const group = figma.group([mask, ...run], parent);
      group.name = `${first.name || "Layer"} (clipped)`;
      out.push(group);
    } catch (e) {
      warn(ctx, first.name, `The clip could not be applied (${message(e)}), so the layer is not clipped`, "approximated");
      try { mask.remove(); } catch { /* already gone */ }
      out.push(...run);
    }
  }
  return out;
}

async function buildLayer(
  layer: Layer,
  ctx: Ctx,
  parent: BaseNode & ChildrenMixin
): Promise<SceneNode | null> {
  try {
    let node: SceneNode | null = null;
    if (layer.type === "vector") node = buildVector(layer, ctx, parent);
    else if (layer.type === "text") node = buildText(layer, ctx, parent);
    else if (layer.type === "image") node = buildImage(layer, ctx, parent);
    else if (layer.type === "group") node = await buildGroup(layer, ctx, parent);
    else {
      warn(ctx, (layer as Layer).name, `Layers of type "${(layer as any).type}" are not rebuilt in Figma`, "skipped");
      return null;
    }

    if (node) {
      applyBlendAndEffects(node, layer, ctx);
      if (layer.visible === false) node.visible = false;
    }
    return node;
  } catch (e) {
    warn(ctx, layer.name, message(e), "skipped");
    return null;
  }
}

function buildVector(layer: VectorLayer, ctx: Ctx, parent: BaseNode & ChildrenMixin): SceneNode | null {
  const data = subPathsToSvg(layer.subpaths || []);
  if (!data) {
    warn(ctx, layer.name, "The shape has no contours to draw", "skipped");
    return null;
  }

  const node = figma.createVector();
  parent.appendChild(node);
  node.name = layer.name || "Vector";
  node.vectorPaths = [
    { windingRule: layer.windingRule === "evenodd" ? "EVENODD" : "NONZERO", data },
  ];

  node.fills = paints(layer.fills, layer, ctx);
  applyStroke(node, layer, ctx);
  place(node, layer);
  ctx.created++;
  return node;
}

/** Per-character styles: each run's fields set on its range; unset fields keep the text's own. */
function applyRuns(node: TextNode, layer: TextLayer, ctx: Ctx) {
  const length = node.characters.length;
  let missing = false;
  for (const r of layer.runs || []) {
    const s = Math.max(0, r.start);
    const e = Math.min(length, r.end);
    if (e <= s) continue;
    if (r.fontFamily) {
      const f = { family: r.fontFamily, style: r.fontStyle || "Regular" };
      if (ctx.fonts.has(`${f.family}|${f.style}`)) node.setRangeFontName(s, e, f);
      else missing = true;
    }
    if (typeof r.fontSize === "number" && r.fontSize > 0) node.setRangeFontSize(s, e, r.fontSize);
    if (r.color) node.setRangeFills(s, e, [solidPaint(r.color)]);
    if (typeof r.letterSpacing === "number") node.setRangeLetterSpacing(s, e, { unit: "PIXELS", value: r.letterSpacing });
    if (r.decoration) {
      node.setRangeTextDecoration(s, e, r.decoration === "underline" ? "UNDERLINE" : r.decoration === "strikethrough" ? "STRIKETHROUGH" : "NONE");
    }
  }
  if (missing) warn(ctx, layer.name, "A font used in part of the text could not be loaded; that part keeps the text's font", "approximated");
}

function buildText(layer: TextLayer, ctx: Ctx, parent: BaseNode & ChildrenMixin): SceneNode | null {
  const wanted: FontName = {
    family: layer.fontFamily || FALLBACK_FONT.family,
    style: layer.fontStyle || "Regular",
  };
  const font = ctx.fonts.has(`${wanted.family}|${wanted.style}`) ? wanted : ctx.fallback;
  if (!ctx.fonts.has(`${font.family}|${font.style}`)) {
    warn(ctx, layer.name, "No font could be loaded, so the text was skipped", "skipped");
    return null;
  }

  const node = figma.createText();
  parent.appendChild(node);
  node.fontName = font;
  node.name = layer.name || "Text";
  node.characters = layer.characters || "";
  node.fontSize = layer.fontSize || 24;

  const c = layer.color || { r: 0, g: 0, b: 0, a: 1 };
  node.fills = [solidPaint(c)];

  if (layer.letterSpacing) node.letterSpacing = { unit: "PIXELS", value: layer.letterSpacing };
  if (layer.lineHeight) node.lineHeight = { unit: "PIXELS", value: layer.lineHeight };
  applyRuns(node, layer, ctx);

  // The whole text's own decoration and case; runs override them where they differ.
  if (layer.decoration === "underline") node.textDecoration = "UNDERLINE";
  else if (layer.decoration === "strikethrough") node.textDecoration = "STRIKETHROUGH";
  if (layer.textCase === "upper") node.textCase = "UPPER";
  else if (layer.textCase === "lower") node.textCase = "LOWER";
  else if (layer.textCase === "title") node.textCase = "TITLE";

  const align = layer.textAlignHorizontal;
  if (align === "center") node.textAlignHorizontal = "CENTER";
  else if (align === "right") node.textAlignHorizontal = "RIGHT";
  else if (align === "justified") node.textAlignHorizontal = "JUSTIFIED";
  // Aligned text needs its box: an auto-width box hugs the glyphs, and
  // centring inside it changes nothing.
  if (align && align !== "left" && layer.frame.width > 0) {
    try {
      node.textAutoResize = "HEIGHT";
      node.resize(layer.frame.width, Math.max(1, node.height));
    } catch { /* keeps the auto-width box */ }
  }

  // Figma positions text by its box, and the box hugs the glyphs once it is
  // auto-sized. A source that knew its baseline places the box that far above
  // it; everything else falls back to the frame the sender measured.
  node.x = layer.frame.x;
  node.y = typeof layer.baseline === "number" ? layer.baseline - node.height * 0.8 : layer.frame.y;
  applyRotation(node, layer);
  ctx.created++;
  return node;
}

function buildImage(layer: ImageLayer, ctx: Ctx, parent: BaseNode & ChildrenMixin): SceneNode | null {
  if (!layer.pngBase64) {
    // The panel turns a local file into bytes before sending to Figma; a
    // transfer that still carries only a path came from somewhere that could not.
    warn(ctx, layer.name, "The image arrived as a file path, which a Figma plugin cannot read", "skipped");
    return null;
  }

  let image: Image;
  try {
    image = figma.createImage(figma.base64Decode(layer.pngBase64));
  } catch (e) {
    warn(ctx, layer.name, `The image could not be decoded — ${message(e)}`, "skipped");
    return null;
  }

  const node = figma.createRectangle();
  parent.appendChild(node);
  node.name = layer.name || "Image";
  node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
  place(node, layer);
  ctx.created++;
  return node;
}

async function buildGroup(
  layer: GroupLayer,
  ctx: Ctx,
  parent: BaseNode & ChildrenMixin
): Promise<SceneNode | null> {
  const children = await buildList(layer.children || [], ctx, parent);
  if (children.length === 0) {
    warn(ctx, layer.name, "The group held nothing that could be rebuilt", "skipped");
    return null;
  }

  // A clip becomes a mask sitting under its siblings, which is how Figma
  // expresses one; the group is what confines it.
  const mask = layer.clip ? buildMask(layer.clip, layer.name || "Group", ctx, parent, children[0]) : null;
  const members = mask ? [mask, ...children] : children;

  let group: GroupNode;
  try {
    group = figma.group(members, parent);
  } catch (e) {
    warn(ctx, layer.name, `The group could not be made (${message(e)}), so its layers stand on their own`, "approximated");
    return children[children.length - 1];
  }
  group.name = layer.name || "Group";
  if (typeof layer.frame.opacity === "number") group.opacity = clamp01(layer.frame.opacity);
  return group;
}

/**
 * A clip as a mask vector, put directly under `below`: Figma masks the layers
 * above a mask, and grouping keeps the order the layers already have.
 */
function buildMask(
  clip: ClipPath,
  name: string,
  ctx: Ctx,
  parent: BaseNode & ChildrenMixin,
  below: SceneNode
): SceneNode | null {
  const data = subPathsToSvg(clip.subpaths || []);
  if (!data) return null;
  try {
    const mask = figma.createVector();
    const at = parent.children.indexOf(below);
    if (at >= 0) parent.insertChild(at, mask);
    else parent.appendChild(mask);
    mask.name = `${name} clip`;
    mask.vectorPaths = [
      { windingRule: clip.windingRule === "evenodd" ? "EVENODD" : "NONZERO", data },
    ];
    // Clip contours are already in frame space, so the mask sits at the origin.
    mask.x = 0;
    mask.y = 0;
    mask.fills = [solidPaint({ r: 0, g: 0, b: 0, a: 1 })];
    mask.isMask = true;
    return mask;
  } catch (e) {
    warn(ctx, name, `The clip could not be rebuilt (${message(e)}), so it is not clipped`, "approximated");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function place(node: SceneNode, layer: Layer) {
  if ("resize" in node && layer.frame.width > 0 && layer.frame.height > 0 && node.type === "RECTANGLE") {
    node.resize(layer.frame.width, layer.frame.height);
  }
  node.x = layer.frame.x;
  node.y = layer.frame.y;
  applyRotation(node, layer);
  if (typeof layer.frame.opacity === "number" && "opacity" in node) {
    (node as SceneNode & MinimalBlendMixin).opacity = clamp01(layer.frame.opacity);
  }
}

/**
 * The IR turns clockwise about the box's centre; Figma's rotation turns
 * counter-clockwise about the node's top-left. So the whole transform is set:
 * the node, placed unrotated at x/y, is turned about its own centre.
 */
function applyRotation(node: SceneNode, layer: Layer) {
  const deg = layer.frame.rotation || 0;
  if (!deg) return;
  const w = node.width;
  const h = node.height;
  const cx = node.x + w / 2;
  const cy = node.y + h / 2;
  const r = (-deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  (node as SceneNode & LayoutMixin).relativeTransform = [
    [cos, sin, cx - (cos * w) / 2 - (sin * h) / 2],
    [-sin, cos, cy + (sin * w) / 2 - (cos * h) / 2],
  ];
}

function applyStroke(node: VectorNode, layer: VectorLayer, ctx: Ctx) {
  const stroke = layer.strokes && layer.strokes.length ? layer.strokes[0] : null;
  if (!stroke || !stroke.paint) {
    node.strokes = [];
    return;
  }
  node.strokes = paints([stroke.paint], layer, ctx);
  node.strokeWeight = stroke.weight || 1;
  if (stroke.cap === "round") node.strokeCap = "ROUND";
  else if (stroke.cap === "square") node.strokeCap = "SQUARE";
  if (stroke.join === "round") node.strokeJoin = "ROUND";
  else if (stroke.join === "bevel") node.strokeJoin = "BEVEL";
  if (stroke.align === "inside") node.strokeAlign = "INSIDE";
  else if (stroke.align === "outside") node.strokeAlign = "OUTSIDE";
  if (stroke.dashPattern && stroke.dashPattern.length) node.dashPattern = stroke.dashPattern.slice();
}

function paints(list: ReadonlyArray<Paint> | undefined, layer: Layer, ctx: Ctx): Paint_[] {
  const out: Paint_[] = [];
  for (const p of list || []) {
    if (p.type === "solid") {
      out.push(solidPaint(p.color));
    } else {
      out.push(gradientPaint(p, layer, ctx));
    }
  }
  return out;
}

/** Figma's Paint, named apart from the IR's own Paint type. */
type Paint_ = SolidPaint | GradientPaint | ImagePaint;

function solidPaint(c: RGBA): SolidPaint {
  return {
    type: "SOLID",
    color: { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) },
    opacity: typeof c.a === "number" ? clamp01(c.a) : 1,
  };
}

function gradientPaint(
  paint: Extract<Paint, { type: "linear-gradient" | "radial-gradient" }>,
  layer: Layer,
  ctx: Ctx
): GradientPaint {
  const kind = paint.type === "radial-gradient" ? "radial" : "linear";
  // Handles are normalised to the box, but "perpendicular" means in pixels:
  // on a box that is not square, the third handle has to say so.
  const w = layer.frame.width;
  const h = layer.frame.height;
  const d = { x: paint.to.x - paint.from.x, y: paint.to.y - paint.from.y };
  const edge = w > 0 && h > 0 ? { x: paint.from.x - (d.y * h) / w, y: paint.from.y + (d.x * w) / h } : undefined;
  const transform = gradientTransformFromHandles(paint.from, paint.to, kind, edge);
  const stops = (paint.stops || []).map((s) => ({
    position: clamp01(s.position),
    color: {
      r: clamp01(s.color.r),
      g: clamp01(s.color.g),
      b: clamp01(s.color.b),
      a: typeof s.color.a === "number" ? clamp01(s.color.a) : 1,
    },
  }));
  if (stops.length === 0) {
    warn(ctx, layer.name, "A gradient arrived with no colours, so it is painted black", "approximated");
    stops.push({ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } });
  }
  return {
    type: kind === "radial" ? "GRADIENT_RADIAL" : "GRADIENT_LINEAR",
    gradientTransform: transform as unknown as Transform,
    gradientStops: stops,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function message(e: unknown): string {
  return e && (e as Error).message ? (e as Error).message : String(e);
}

// ---------------------------------------------------------------------------
// Blend modes and effects
//
// Figma is the one host with a native equivalent for every effect in the IR —
// it is where three of the four came from — so nothing is lost on the way in.
// ---------------------------------------------------------------------------

const BLEND_TO_FIGMA: Record<string, BlendMode_> = {
  normal: "NORMAL",
  multiply: "MULTIPLY",
  screen: "SCREEN",
  overlay: "OVERLAY",
  darken: "DARKEN",
  lighten: "LIGHTEN",
  "color-dodge": "COLOR_DODGE",
  "color-burn": "COLOR_BURN",
  "hard-light": "HARD_LIGHT",
  "soft-light": "SOFT_LIGHT",
  difference: "DIFFERENCE",
  exclusion: "EXCLUSION",
  hue: "HUE",
  saturation: "SATURATION",
  color: "COLOR",
  luminosity: "LUMINOSITY",
};

/** Figma's own BlendMode, named apart from the IR's. */
type BlendMode_ = BlendMixin["blendMode"];

function applyBlendAndEffects(node: SceneNode, layer: Layer, ctx: Ctx) {
  const mode = layer.blendMode;
  if (mode && mode !== "normal" && "blendMode" in node) {
    const figmaMode = BLEND_TO_FIGMA[mode];
    if (figmaMode) {
      try {
        (node as SceneNode & BlendMixin).blendMode = figmaMode;
      } catch {
        warn(ctx, layer.name, `The "${mode}" blend mode could not be set, so the layer is drawn as Normal`, "approximated");
      }
    }
  }

  const list = layer.effects;
  if (!list || !list.length || !("effects" in node)) return;

  const effects: Effect_[] = [];
  for (const fx of list) {
    if (fx.kind === "drop-shadow" || fx.kind === "inner-shadow") {
      effects.push({
        type: fx.kind === "drop-shadow" ? "DROP_SHADOW" : "INNER_SHADOW",
        color: { r: clamp01(fx.color.r), g: clamp01(fx.color.g), b: clamp01(fx.color.b), a: clamp01(fx.color.a) },
        offset: { x: fx.offset.x, y: fx.offset.y },
        radius: Math.max(0, fx.radius),
        spread: Math.max(0, fx.spread || 0),
        visible: true,
        blendMode: "NORMAL",
      });
    } else if (fx.kind === "layer-blur" || fx.kind === "background-blur") {
      // Figma grew progressive blurs later, so the plain kind now says so.
      effects.push({
        type: fx.kind === "layer-blur" ? "LAYER_BLUR" : "BACKGROUND_BLUR",
        blurType: "NORMAL",
        radius: Math.max(0, fx.radius),
        visible: true,
      } as Effect_);
    }
  }

  if (!effects.length) return;
  try {
    (node as SceneNode & BlendMixin).effects = effects;
  } catch (e) {
    warn(ctx, layer.name, `The effects could not be applied — ${message(e)}`, "skipped");
  }
}

/** Figma's own Effect, named apart from the IR's. */
type Effect_ = DropShadowEffect | InnerShadowEffect | BlurEffect;
