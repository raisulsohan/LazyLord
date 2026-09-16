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
  BlendMode as IRBlendMode,
  ClipPath,
  Diagnostic,
  Effect as IREffect,
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
  layersUpdated?: number;
  message: string;
  diagnostics: Diagnostic[];
};

type Ctx = {
  diagnostics: Diagnostic[];
  created: number;
  /** Every font this transfer could actually load, by "family|style". */
  fonts: Set<string>;
  fallback: FontName;
  /** The transfer, for the tags each built layer gets. */
  doc?: Document;
  /** Nodes tagged by this build, fingerprinted once it is done. */
  seal: SceneNode[];
  /** Set while updating (options.existing "update"). */
  update?: {
    index: Map<string, SceneNode>;
    keep: boolean;
    updated: number;
    conflicts: number;
    replaced: SceneNode[];
  };
};

/*
 * Updating what an earlier transfer built (options.existing "update"), the
 * way After Effects and Illustrator do it. Every node a transfer builds keeps,
 * in plugin data the user never sees and the file saves, where it came from
 * (TAG: source app | source document | source layer id) and a fingerprint of
 * how it was built (FP). An update finds each layer's node by its tag, and
 * rebuilds it in the old node's place — same parent, same position in the
 * stack — so a node the user moved into another frame or group stays there.
 * A node whose fingerprint no longer matches was edited here since: that is a
 * conflict, overwritten or kept as TransferOptions.conflict says, and reported
 * either way. Frames a transfer makes are marked (ROOT), so a layer in one is
 * placed in that frame's space, as it was built.
 */
const TAG = "lazylord.tag";
const FP = "lazylord.fp";
const ROOT = "lazylord.root";

/** Strip what would end a tag field early (as LazyLord._tagSafe does). */
function tagSafe(s: unknown): string {
  return String(s === undefined || s === null ? "" : s).replace(/[\[\]|~]/g, "");
}

/** The identity of an IR layer: source app, document, id (as LazyLord.tagKey). */
export function tagKey(doc: Document, layer: Layer, role?: string): string {
  return `${tagSafe(doc.source || "unknown")}|${tagSafe(doc.sourceKey)}|${tagSafe(layer.id)}${role ? "#" + tagSafe(role) : ""}`;
}

function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + "." + s.length.toString(36);
}

/** How a built node stands now: what an update would overwrite. */
export function nodePrint(node: SceneNode): string {
  const a = node as any;
  const r = (v: unknown) => (typeof v === "number" ? Math.round(v * 100) / 100 : v === figma.mixed ? "mixed" : v);
  const json = (v: unknown) => {
    try { return v === figma.mixed ? "mixed" : JSON.stringify(v); } catch { return "?"; }
  };
  return hashText(JSON.stringify([
    node.type, r(a.x), r(a.y), r(a.width), r(a.height), r(a.rotation), r(a.opacity), a.blendMode, a.visible,
    json(a.fills), json(a.strokes), r(a.strokeWeight), json(a.effects),
    a.vectorPaths ? a.vectorPaths.map((p: { data: string }) => p.data).join("|") : null,
    typeof a.characters === "string" ? a.characters : null, r(a.fontSize), json(a.fontName),
  ]));
}

/** Tagged nodes on the current page, tag -> node; the lower one wins (a duplicate lands above its original). */
function indexTagged(): Map<string, SceneNode> {
  const index = new Map<string, SceneNode>();
  let nodes: SceneNode[] = [];
  try {
    nodes = (figma.currentPage as any).findAllWithCriteria({ pluginData: { keys: [TAG] } });
  } catch {
    try { nodes = figma.currentPage.findAll((n) => !!n.getPluginData(TAG)); } catch { /* nothing tagged */ }
  }
  for (const n of nodes) {
    const key = n.getPluginData(TAG);
    if (key && !index.has(key)) index.set(key, n);
  }
  return index;
}

/** The frame a transfer made that holds `node`, or the page. */
function lazyRoot(node: SceneNode): BaseNode & ChildrenMixin {
  let p: BaseNode | null = node.parent;
  while (p && p.type !== "PAGE") {
    if (p.type === "FRAME" && (p as FrameNode).getPluginData(ROOT)) return p as FrameNode;
    p = p.parent;
  }
  return figma.currentPage;
}

/** Leaves with each group's opacity multiplied in: an update edits layers where they stand. */
function flattenLeaves(list: ReadonlyArray<Layer>, fade = 1, out: Layer[] = []): Layer[] {
  for (const l of list || []) {
    if (!l) continue;
    if (l.type === "group") {
      flattenLeaves(l.children || [], fade * (typeof l.frame.opacity === "number" ? l.frame.opacity : 1), out);
    } else {
      const own = typeof l.frame.opacity === "number" ? l.frame.opacity : 1;
      out.push(fade < 1 ? ({ ...l, frame: { ...l.frame, opacity: own * fade } } as Layer) : l);
    }
  }
  return out;
}

/** 2x3 affine product and inverse, for keeping a node where it shows when it changes parent. */
type M = [[number, number, number], [number, number, number]];
function mul(a: M, b: M): M {
  return [
    [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
    [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]],
  ];
}
function inv(m: M): M | null {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  if (!det) return null;
  const a = m[1][1] / det, b = -m[0][1] / det, c = -m[1][0] / det, d = m[0][0] / det;
  return [[a, b, -(a * m[0][2] + b * m[1][2])], [c, d, -(c * m[0][2] + d * m[1][2])]];
}

/**
 * Update the node an earlier transfer built from `layer`. True when there was
 * one (updated, kept as the user edited it, or reported), false to add it.
 */
async function updateLeaf(layer: Layer, ctx: Ctx): Promise<boolean> {
  const up = ctx.update!;
  const old = up.index.get(tagKey(ctx.doc!, layer));
  if (!old || old.removed) return false;
  const parent = old.parent as (BaseNode & ChildrenMixin) | null;
  if (!parent) return false;
  const name = layer.name || "Layer";

  const fp = old.getPluginData(FP);
  if (fp && fp !== nodePrint(old)) {
    up.conflicts++;
    if (up.keep) {
      warn(ctx, name, "Was changed in Figma since it was last sent, so it was left as you made it (On conflict: Keep my edits)", "skipped");
      return true;
    }
    warn(ctx, name, "Was changed in Figma since it was last sent; the update replaced it, and those changes with it", "approximated");
  }

  // Built where the first transfer put it — in its frame's space when that
  // frame was the transfer's own — then moved into the old node's place.
  const root = lazyRoot(old);
  let leaf = layer;
  if (root.type === "FRAME" && ctx.doc!.originSpace === "document" && ctx.doc!.canvas && ctx.doc!.bounds) {
    leaf = JSON.parse(JSON.stringify(layer));
    moveLayers([leaf], ctx.doc!.bounds.x || 0, ctx.doc!.bounds.y || 0);
  }
  const created = ctx.created;
  const node = await buildLayer(leaf, ctx, root);
  ctx.created = created; // an update, not a new layer
  if (!node) return true; // reported by buildLayer; the old node stays

  let rel: M | null = null;
  if (parent !== root) {
    try {
      const pInv = inv((parent as any).absoluteTransform as M);
      if (pInv) rel = mul(pInv, (node as any).absoluteTransform as M);
    } catch { /* keeps its values relative to the new parent */ }
  }
  try {
    parent.insertChild(Math.max(0, parent.children.indexOf(old)), node);
    if (rel) (node as any).relativeTransform = rel;
    old.remove();
  } catch (e) {
    warn(ctx, name, `The new version could not take the old one's place (${message(e)}), so both are on the page`, "approximated");
  }
  up.updated++;
  up.replaced.push(node);
  return true;
}

const FALLBACK_FONT: FontName = { family: "Inter", style: "Regular" };

function warn(ctx: Ctx, object: string, reason: string, resolution: Diagnostic["resolution"]) {
  ctx.diagnostics.push({ object: object || "(unnamed)", reason, resolution });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function buildDocument(doc: Document): Promise<BuildResult> {
  const ctx: Ctx = { diagnostics: [], created: 0, fonts: new Set(), fallback: FALLBACK_FONT, doc, seal: [] };

  try {
    await loadFonts(doc, ctx);
  } catch {
    // Not even the fallback loaded; text layers will report it one by one.
  }

  const opts = transferOptions(doc);
  let layers = doc.layers || [];
  // Updating needs somewhere to update, so it never makes a frame.
  const updating = opts.existing === "update";
  if (updating) {
    ctx.update = { index: indexTagged(), keep: opts.conflict === "keep", updated: 0, conflicts: 0, replaced: [] };
    layers = flattenLeaves(layers);
  }

  // Where the transfer lands: a frame of its own, or straight onto the page.
  let parent: BaseNode & ChildrenMixin = figma.currentPage;
  let frame: FrameNode | null = null;
  if (opts.destination === "new" && !updating) {
    frame = makeFrame(doc);
    parent = frame;
    // A frame the size of the source page: the artwork goes where it sat on
    // that page (frames are measured from the selection's corner), as the guides do.
    if (doc.originSpace === "document" && doc.canvas && doc.bounds) moveLayers(layers, doc.bounds.x || 0, doc.bounds.y || 0);
  }

  // Updating: each layer an earlier transfer built is rebuilt in its place;
  // the rest are added as usual.
  let toAdd: ReadonlyArray<Layer> = layers;
  if (ctx.update) {
    const rest: Layer[] = [];
    for (const leaf of layers) {
      let done = false;
      try {
        done = await updateLeaf(leaf, ctx);
      } catch (e) {
        warn(ctx, leaf.name, `Could not be updated (${message(e)}), so it was left as it was`, "skipped");
        done = true;
      }
      if (!done) rest.push(leaf);
    }
    toAdd = rest;
  }
  const made = await buildList(toAdd, ctx, parent);
  // Fingerprints last, once every node stands where it will stay.
  for (const n of ctx.seal) {
    try { if (!n.removed) n.setPluginData(FP, nodePrint(n)); } catch { /* not tagged, then */ }
  }

  if (frame) {
    placeFrame(frame, doc);
    figma.currentPage.appendChild(frame);
  }
  addGuides(doc, opts, frame, ctx);
  if (opts.swatches && doc.swatches && doc.swatches.length) await addSwatches(doc.swatches, ctx);

  const up = ctx.update;
  if (made.length === 0 && !frame && !(up && (up.updated || up.conflicts))) {
    return { ok: false, layersCreated: 0, message: "Nothing in the transfer could be rebuilt.", diagnostics: ctx.diagnostics };
  }

  // Select and reveal what arrived, so it is not lost somewhere on the page.
  const selection = frame ? [frame] : made.concat(up ? up.replaced : []);
  if (selection.length) {
    figma.currentPage.selection = selection;
    figma.viewport.scrollAndZoomIntoView(selection);
  }

  const notes: string[] = [];
  if (frame) notes.push(`Built into a new frame, "${frame.name}".`);
  if (up) {
    if (up.conflicts) {
      notes.push(`${up.conflicts} layer${up.conflicts === 1 ? " was" : "s were"} changed here since the last send: ` +
        (up.keep ? "left as you made them." : "your changes were replaced."));
    }
    if (up.updated) notes.push(`Updated ${up.updated} layer${up.updated === 1 ? "" : "s"} where they stood.`);
    else if (!(up.conflicts && up.keep)) notes.push("Nothing matched a layer from an earlier transfer, so everything was added.");
  }
  return {
    ok: true,
    layersCreated: ctx.created,
    layersUpdated: up ? up.updated : 0,
    message: notes.join(" "),
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
  // An update places layers found in it in its space (see updateLeaf).
  try { frame.setPluginData(ROOT, "1"); } catch { /* then they go by the page */ }
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
  // What each layer became, for a clipping mask to find its base.
  const made = new Map<string, SceneNode>();
  const clipOf = (l: Layer | undefined) => (l && l.type !== "group" ? l.clip : undefined);
  let i = 0;
  while (i < list.length) {
    const clip = clipOf(list[i]);
    if (!clip) {
      let node = await buildLayer(list[i], ctx, parent);
      if (node) {
        node = applyLayerMask(list[i], node, ctx, parent);
        made.set(list[i].id, node);
        out.push(node);
      }
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
  return applyClipping(list, made, out, ctx, parent);
}

/**
 * A layer mask (IR `mask`, a Photoshop layer mask) as Figma expresses one: the
 * mask image directly under the layer as a luminance mask, the two grouped.
 * Returns what now stands for the layer: the group, or the layer itself when
 * there is no mask or it cannot be applied.
 */
function applyLayerMask(layer: Layer, node: SceneNode, ctx: Ctx, parent: BaseNode & ChildrenMixin): SceneNode {
  const m = layer.mask;
  if (!m) return node;
  const name = layer.name || "Layer";
  if (!m.pngBase64) {
    warn(ctx, name, "Its layer mask arrived as a file path, which a Figma plugin cannot read, so it is not masked", "approximated");
    return node;
  }
  let rect: RectangleNode | null = null;
  try {
    const image = figma.createImage(figma.base64Decode(m.pngBase64));
    rect = figma.createRectangle();
    const at = parent.children.indexOf(node);
    if (at >= 0) parent.insertChild(at, rect);
    else parent.appendChild(rect);
    rect.name = `${name} mask`;
    rect.resize(Math.max(0.01, m.frame.width), Math.max(0.01, m.frame.height));
    rect.x = m.frame.x;
    rect.y = m.frame.y;
    rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
    rect.isMask = true;
    // White shows and black hides, as the source meant it.
    if ("maskType" in rect) (rect as RectangleNode & { maskType: string }).maskType = "LUMINANCE";
    const group = figma.group([rect, node], parent);
    group.name = `${name} (masked)`;
    ctx.created++;
    return group;
  } catch (e) {
    if (rect) { try { rect.remove(); } catch { /* already gone */ } }
    warn(ctx, name, `Its layer mask could not be applied (${message(e)}), so it is not masked`, "approximated");
    return node;
  }
}

/**
 * Photoshop clipping masks (IR `clipTo`): each run of layers clipped to the same
 * base goes into a group over an alpha mask copied from that base, placed
 * directly above it, so the base still shows and the run shows only where it
 * does. `made` maps this list's layer ids to what they became; the returned
 * list has the groups where their layers were.
 */
function applyClipping(
  list: ReadonlyArray<Layer>,
  made: Map<string, SceneNode>,
  out: SceneNode[],
  ctx: Ctx,
  parent: BaseNode & ChildrenMixin
): SceneNode[] {
  let result = out;
  let i = 0;
  while (i < list.length) {
    const baseId = list[i].clipTo;
    if (!baseId) { i++; continue; }
    const run: SceneNode[] = [];
    const names: string[] = [];
    while (i < list.length && list[i].clipTo === baseId) {
      const n = made.get(list[i].id);
      if (n) { run.push(n); names.push(list[i].name || "Layer"); }
      i++;
    }
    if (!run.length) continue;
    const base = made.get(baseId);
    if (!base) {
      for (const n of names) warn(ctx, n, "It is clipped to a layer that was not rebuilt here, so it is not clipped", "approximated");
      continue;
    }
    let mask: SceneNode | null = null;
    try {
      mask = base.clone();
      const at = parent.children.indexOf(base);
      parent.insertChild(at + 1, mask);
      mask.name = `${base.name} clip`;
      if ("isMask" in mask) (mask as SceneNode & { isMask: boolean }).isMask = true;
      if ("maskType" in mask) (mask as SceneNode & { maskType: string }).maskType = "ALPHA";
      const group = figma.group([mask, ...run], parent);
      group.name = `${base.name} (clipping)`;
      const first = result.indexOf(run[0]);
      result = result.filter((n) => run.indexOf(n) < 0);
      result.splice(first < 0 ? result.length : Math.min(first, result.length), 0, group);
    } catch (e) {
      if (mask) { try { mask.remove(); } catch { /* already gone */ } }
      for (const n of names) warn(ctx, n, `Its clipping mask could not be rebuilt (${message(e)}), so it is not clipped`, "approximated");
    }
  }
  return result;
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
    else if ((layer as Layer).type === "adjustment") {
      warn(ctx, (layer as Layer).name, "Figma has no adjustment layers, so this adjustment was left out", "skipped");
      return null;
    } else {
      warn(ctx, (layer as Layer).name, `Layers of type "${(layer as any).type}" are not rebuilt in Figma`, "skipped");
      return null;
    }

    if (node) {
      applyBlendAndEffects(node, layer, ctx);
      if (layer.visible === false) node.visible = false;
      // Where it came from, for the next update to find it.
      if (layer.type !== "group" && ctx.doc) {
        try {
          node.setPluginData(TAG, tagKey(ctx.doc, layer));
          ctx.seal.push(node);
        } catch { /* it simply will not match next time */ }
      }
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
  const left: string[] = [];
  const shadowBlend = (bm: IRBlendMode | undefined): BlendMode_ => (bm && BLEND_TO_FIGMA[bm]) || "NORMAL";
  for (const fx of list) {
    if (fx.kind === "drop-shadow" || fx.kind === "inner-shadow") {
      effects.push({
        type: fx.kind === "drop-shadow" ? "DROP_SHADOW" : "INNER_SHADOW",
        color: { r: clamp01(fx.color.r), g: clamp01(fx.color.g), b: clamp01(fx.color.b), a: clamp01(fx.color.a) },
        offset: { x: fx.offset.x, y: fx.offset.y },
        radius: Math.max(0, fx.radius),
        spread: Math.max(0, fx.spread || 0),
        visible: true,
        blendMode: shadowBlend(fx.blendMode),
      });
    } else if (fx.kind === "outer-glow" || fx.kind === "inner-glow") {
      // A glow is a shadow that does not move: Figma draws one exactly that way.
      effects.push({
        type: fx.kind === "outer-glow" ? "DROP_SHADOW" : "INNER_SHADOW",
        color: { r: clamp01(fx.color.r), g: clamp01(fx.color.g), b: clamp01(fx.color.b), a: clamp01(fx.color.a) },
        offset: { x: 0, y: 0 },
        radius: Math.max(0, fx.radius),
        spread: Math.max(0, (fx.kind === "outer-glow" ? fx.spread : fx.choke) || 0),
        visible: true,
        blendMode: shadowBlend(fx.blendMode),
      });
      if (fx.kind === "inner-glow" && fx.source === "center") {
        warn(ctx, layer.name, "Its inner glow comes from the centre, which Figma cannot do, so it glows from the edges", "approximated");
      }
    } else if (fx.kind === "stroke") {
      if (!applyStyleStroke(node, fx)) left.push("Layer Style stroke (the layer already has a stroke)");
    } else if (fx.kind === "color-overlay") {
      if (!applyColourOverlay(node, fx)) left.push("colour overlay");
    } else if (fx.kind === "gradient-overlay" || fx.kind === "satin" || fx.kind === "bevel") {
      left.push(fx.kind === "bevel" ? "bevel and emboss" : fx.kind.replace(/-/g, " "));
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

  if (left.length) {
    warn(ctx, layer.name, `Figma has no ${left.join(", ")}, so ${left.length === 1 ? "it was" : "they were"} left off`, "skipped");
  }
  if (!effects.length) return;
  try {
    (node as SceneNode & BlendMixin).effects = effects;
  } catch (e) {
    warn(ctx, layer.name, `The effects could not be applied — ${message(e)}`, "skipped");
  }
}

/** Figma's own Effect and BlendMode, named apart from the IR's. */
type Effect_ = DropShadowEffect | InnerShadowEffect | BlurEffect;

/** A Photoshop Layer Style stroke as the node's own stroke, when it has none. */
function applyStyleStroke(node: SceneNode, fx: Extract<IREffect, { kind: "stroke" }>): boolean {
  if (!("strokes" in node)) return false;
  const n = node as SceneNode & GeometryMixin & MinimalStrokesMixin;
  if (n.strokes && n.strokes.length) return false;
  n.strokes = [solidPaint(fx.color)];
  n.strokeWeight = Math.max(0, fx.width);
  if ("strokeAlign" in n) {
    (n as SceneNode & { strokeAlign: string }).strokeAlign = fx.position === "inside" ? "INSIDE" : (fx.position === "center" ? "CENTER" : "OUTSIDE");
  }
  return true;
}

/** A colour overlay as a paint over the node's fills, at the overlay's opacity and blend mode. */
function applyColourOverlay(node: SceneNode, fx: Extract<IREffect, { kind: "color-overlay" }>): boolean {
  if (!("fills" in node)) return false;
  const n = node as SceneNode & MinimalFillsMixin;
  const fills: unknown[] = Array.isArray(n.fills) ? (n.fills as ReadonlyArray<unknown>).slice() : [];
  const paint = solidPaint(fx.color) as SolidPaint & { blendMode?: string };
  const mode = fx.blendMode && BLEND_TO_FIGMA[fx.blendMode];
  if (mode) paint.blendMode = mode;
  fills.push(paint);
  n.fills = fills as unknown as typeof n.fills;
  return true;
}
