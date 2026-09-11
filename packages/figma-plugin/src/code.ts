/**
 * LazyLord — Figma plugin main thread.
 * Reads the current selection, converts it to LazyLord IR and hands it to the UI
 * iframe, which owns the WebSocket connection to the local bridge.
 *
 * Placement follows packages/core/src/ir.ts:
 *  - Vectors are baked. A node's absoluteTransform — its own rotation or mirror
 *    and every parent's — is applied to its contours, so a vector layer always
 *    arrives with rotation 0 and a frame equal to its outline's bounds.
 *  - Text keeps its unrotated box plus a clockwise rotation about its centre.
 *  - Anything rasterised is exported as it looks on the canvas (already rotated,
 *    effects included), so its frame is its render bounds.
 *  - Clipping frames and masks become per-layer clip paths in frame space.
 *  - Frames, groups, components, instances and sections become IR groups,
 *    always: the target flattens them or rebuilds them, as doc.options (set by
 *    the UI) asks. A group carries its own opacity; a frame's fill and border
 *    are leaves inside its group, below and above its contents.
 *  - A selection inside one top-level frame is placed where it sits in that
 *    frame ("document" space), and the frame sizes the target's new document.
 *    Anything else lands at the target's origin ("canvas" space).
 * Everything that cannot travel natively is listed in doc.diagnostics.
 */

import type {
  Affine,
  BlendMode,
  Effect,
  Box,
  ClipPath,
  Diagnostic,
  Document,
  GroupLayer,
  ImageLayer,
  Layer,
  Paint,
  Primitive,
  RGBA,
  Stroke,
  SubPath,
  TextLayer,
  Vec2,
  VectorLayer,
} from "@lazylord/core";
import {
  applyAffine,
  blendModeFrom,
  bakeSubPaths,
  cloneSubPaths,
  curveBounds,
  gradientHandlesFromTransform,
  groupBox,
  intersectBoxes,
  isAxisAligned,
  isSimilarity,
  layerExtent,
  linearHandlesPx,
  moveLayers,
  offsetSubPaths,
  parseSvgPath,
  placeBox,
  pointToFrameUnits,
  rectOfSubPaths,
  rectToSubPaths,
  remapHandle,
  rotatedBoxBounds,
  sharedArtboard,
  transferOptions,
  transformSubPaths,
  unionBoxes,
} from "@lazylord/core";
import { buildDocument as buildFromIr } from "./build";

/** The window opens at this, and never goes under MIN_SIZE however it is dragged. */
const DEFAULT_SIZE = { width: 320, height: 540 };
const MIN_SIZE = { width: 300, height: 360 };

figma.showUI(__html__, { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height, themeColors: true });

// ---------------------------------------------------------------------------
// Selection tracking
// ---------------------------------------------------------------------------

function postSelection() {
  const count = figma.currentPage.selection.length;
  figma.ui.postMessage({ type: "selection", count });
}

figma.on("selectionchange", postSelection);
postSelection();

// ---------------------------------------------------------------------------
// Preferences (target app, image scale and the transfer options the UI puts
// on doc.options), kept per user by figma.clientStorage
// ---------------------------------------------------------------------------

const PREFS_KEY = "lazylord.prefs";
const SCALES = [1, 2, 3, 4];
const DEFAULT_SCALE = 2;

/**
 * Where the transfer lands (the Destination option):
 *  - "auto": a new document / comp, sized to the frame or section when one is
 *    sent whole, otherwise to the selected objects.
 *  - "frame": a new document / comp the size of the top-level frame the
 *    selection sits in, with the objects where they sit in it.
 *  - "open": into the target's open document / comp, where they sit in their
 *    frame (a new one only when nothing is open).
 */
type Place = "auto" | "frame" | "open";
const PLACES: Place[] = ["auto", "frame", "open"];
const DEFAULT_PLACE: Place = "auto";

type Prefs = {
  target: string;
  scale: number;
  /** The size the user last dragged the window to. */
  width: number;
  height: number;
  layout: "split" | "combine";
  hierarchy: "flatten" | "groups";
  existing: "add" | "update";
  keyframes: "auto" | "always";
  place: Place;
};

function cleanPrefs(raw: any): Prefs {
  const target = raw && typeof raw.target === "string" ? raw.target : "";
  const scale = raw ? Number(raw.scale) : NaN;
  // Unknown or missing choices fall back to the defaults (split, flatten, add, auto).
  const options = transferOptions({ options: raw || undefined });
  const place: Place = raw && PLACES.indexOf(raw.place) >= 0 ? raw.place : DEFAULT_PLACE;
  return {
    target,
    scale: SCALES.indexOf(scale) >= 0 ? scale : DEFAULT_SCALE,
    width: size(raw && raw.width, DEFAULT_SIZE.width, MIN_SIZE.width),
    height: size(raw && raw.height, DEFAULT_SIZE.height, MIN_SIZE.height),
    layout: options.layout,
    hierarchy: options.hierarchy,
    existing: options.existing,
    keyframes: options.keyframes,
    place,
  };
}

/** A stored window dimension, or the default when it is missing or silly. */
function size(raw: unknown, fallback: number, min: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.round(n) : fallback;
}

async function postPrefs(): Promise<void> {
  let prefs = cleanPrefs(null);
  try {
    prefs = cleanPrefs(await figma.clientStorage.getAsync(PREFS_KEY));
  } catch {
    /* storage unavailable: the defaults stand */
  }
  // The window opens at its default and is put back to the size the user left
  // it at, because prefs only arrive after showUI has already run.
  try {
    figma.ui.resize(prefs.width, prefs.height);
  } catch {
    /* an unusable stored size is not worth failing the plugin over */
  }
  figma.ui.postMessage({ type: "prefs", target: prefs.target, scale: prefs.scale, layout: prefs.layout, hierarchy: prefs.hierarchy, place: prefs.place, width: prefs.width, height: prefs.height });
}

async function savePrefs(raw: any): Promise<void> {
  try {
    await figma.clientStorage.setAsync(PREFS_KEY, cleanPrefs(raw));
  } catch {
    /* not fatal: the choice simply is not remembered next time */
  }
}

postPrefs();

// Presets and transfer history, kept beside the preferences.
type ListKind = "presets" | "history";
const LIST_KEYS: Record<ListKind, string> = { presets: "lazylord.presets", history: "lazylord.history" };

async function postList(kind: ListKind): Promise<void> {
  let list: unknown[] = [];
  try {
    const stored = await figma.clientStorage.getAsync(LIST_KEYS[kind]);
    if (Array.isArray(stored)) list = stored;
  } catch {
    /* storage unavailable: an empty list stands */
  }
  figma.ui.postMessage({ type: kind, list });
}

// ---------------------------------------------------------------------------
// UI messages
// ---------------------------------------------------------------------------

figma.ui.onmessage = async (msg: { type: string; [k: string]: any }) => {
  if (msg.type === "export") {
    try {
      const asked = cleanPrefs({ scale: msg.scale, place: msg.place });
      const nodes = sortByZOrder(topmostOnly(figma.currentPage.selection));
      // Several whole frames or sections sent to new documents: one document
      // (or comp) per frame, each at its size and under its name.
      const perFrame = asked.place !== "open" && nodes.length > 1 && nodes.every(isWholeFrame);
      const sets = perFrame ? nodes.map((n) => [n]) : [nodes];
      const docs: Document[] = [];
      for (const set of sets) docs.push(await buildDocument(asked.scale, asked.place, set));
      const sendable = docs.filter((d) => d.layers.length > 0);
      if (sendable.length === 0) {
        const first = docs[0];
        const why = first && first.diagnostics && first.diagnostics.length ? ` ${first.diagnostics[0].object}: ${first.diagnostics[0].reason}.` : "";
        figma.ui.postMessage({ type: "error", message: "Nothing to send — select at least one visible layer." + why });
        return;
      }
      figma.ui.postMessage({ type: "ir", documents: sendable, target: msg.target || null });
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: (e as Error).message || String(e) });
    }
  } else if (msg.type === "receive") {
    // A transfer from another app: rebuild it on the current page.
    try {
      const result = await buildFromIr(msg.document as Document);
      figma.ui.postMessage({ type: "built", id: msg.id, result });
    } catch (e) {
      figma.ui.postMessage({
        type: "built",
        id: msg.id,
        result: { ok: false, layersCreated: 0, message: (e as Error).message || String(e), diagnostics: [] }
      });
    }
  } else if (msg.type === "prefs") {
    await savePrefs(msg);
  } else if (msg.type === "save-list" && (msg.kind === "presets" || msg.kind === "history")) {
    try {
      await figma.clientStorage.setAsync(LIST_KEYS[msg.kind as ListKind], Array.isArray(msg.list) ? msg.list.slice(0, 50) : []);
    } catch {
      /* not fatal: the list simply is not remembered next time */
    }
  } else if (msg.type === "ready") {
    // The UI finished loading: send it anything it may have missed.
    postSelection();
    await postPrefs();
    await postList("presets");
    await postList("history");
  } else if (msg.type === "notify") {
    figma.notify(msg.message, { error: !!msg.error });
  } else if (msg.type === "resize") {
    // No upper bound of our own: Figma already caps a plugin window to its
    // own window, and the point of the grip is that the user decides.
    figma.ui.resize(Math.max(MIN_SIZE.width, msg.width | 0), Math.max(MIN_SIZE.height, msg.height | 0));
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

const GEOMETRY_TYPES = new Set([
  "RECTANGLE",
  "ELLIPSE",
  "POLYGON",
  "STAR",
  "LINE",
  "VECTOR",
  "BOOLEAN_OPERATION",
]);

const CONTAINER_TYPES = new Set(["GROUP", "FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);

/** Containers that paint their own fills/strokes and can clip their children. */
const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);

/** Containers with a background of their own. A section paints one but never clips. */
const BACKGROUND_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);

const IMAGE_PAINTS = new Set(["IMAGE", "VIDEO"]);

const EFFECT_LABELS: Record<string, string> = {
  DROP_SHADOW: "drop shadow",
  INNER_SHADOW: "inner shadow",
  LAYER_BLUR: "layer blur",
  BACKGROUND_BLUR: "background blur",
  NOISE: "noise",
  TEXTURE: "texture",
  GLASS: "glass",
};

/** A clip on its way down the tree, in frame space. */
type ClipState = {
  clip: ClipPath;
  /** Tight bounds of clip.subpaths. */
  bounds: Box | null;
  /** Set when the clip is a plain axis-aligned rectangle (these can be intersected exactly). */
  rect: Box | null;
  /** Nested clips that do not overlap: nothing inside is visible. */
  empty?: boolean;
  /** Names of the outer clips given up for this one, outermost first ("" when unnamed). */
  dropped?: string[];
};

type Ctx = {
  /** Selection top-left in absolute page space; frame space = absolute - origin. */
  origin: Vec2;
  /** Export scale for rasterised nodes. */
  scale: number;
  // No inherited opacity: every container above a node is a group of its own
  // carrying its opacity, so a leaf's frame.opacity is only ever its own.
  clip: ClipState | null;
  diag: { list: Diagnostic[]; keys: Set<string> };
};

/** Record one fallback; the same object + reason is only listed once. */
function warn(ctx: Ctx, object: string, reason: string, resolution: Diagnostic["resolution"]) {
  const key = object + "\u0000" + reason + "\u0000" + resolution;
  if (ctx.diag.keys.has(key)) return;
  ctx.diag.keys.add(key);
  ctx.diag.list.push({ object: object || "(unnamed)", reason, resolution });
}

/** A frame-like node that becomes a page (document / comp) of its own when sent whole. */
function isWholeFrame(node: SceneNode): boolean {
  return node.type === "FRAME" || node.type === "SECTION" || node.type === "COMPONENT" ||
    node.type === "COMPONENT_SET" || node.type === "INSTANCE";
}

async function buildDocument(
  scale: number,
  place: Place = DEFAULT_PLACE,
  nodes: readonly SceneNode[] = figma.currentPage.selection
): Promise<Document> {
  const selection = sortByZOrder(topmostOnly(nodes));

  // Selection bounds (absolute) are the origin every frame is measured from.
  let sel: Box | null = null;
  for (const node of selection) {
    const bb = (node as any).absoluteBoundingBox as Box | null;
    if (bb) sel = unionBoxes(sel, bb);
  }
  const origin = sel ? { x: sel.x, y: sel.y } : { x: 0, y: 0 };

  const ctx: Ctx = { origin, scale, clip: null, diag: { list: [], keys: new Set() } };
  const layers: Layer[] = [];
  await collectSiblings(selection, ctx, layers, true);

  const doc: Document = {
    version: "1.0",
    source: "figma",
    // A new document or comp is named after the one thing sent, else the page.
    name: selection.length === 1 ? selection[0].name : figma.currentPage.name,
    bounds: finishBounds(layers, origin, sel || { x: 0, y: 0, width: 0, height: 0 }),
    // Figma's canvas has no page origin, so by default targets place at their
    // own origin; placeOnArtboard switches to the top-level frame's space.
    originSpace: "canvas",
    layers,
    // Node ids repeat across files, so a target that remembers what it built
    // needs to know which file they came from.
    sourceKey: sourceKey(),
    // Auto and frame-size both ask for a new document; the transfer options
    // the UI adds keep this field (see ui.ts).
    options: { destination: place === "open" ? "active" : "new" },
  };
  placeOnArtboard(doc, selection, ctx, place !== "auto");
  // One whole frame is its own page: a document its size, contents where they
  // sit in it — even when the frame has no fill to show its edges. "frame"
  // and "open" keep a nested frame on its top-level frame instead.
  const single = selection.length === 1 && isWholeFrame(selection[0]) ? selection[0] : null;
  if (single && (place === "auto" || doc.originSpace !== "document")) placeOnOwnFrame(doc, single, ctx);
  if (ctx.diag.list.length) doc.diagnostics = ctx.diag.list;
  return doc;
}

/**
 * What tells this Figma file apart from every other one, so a target can match
 * a node id back to the thing it came from. `fileKey` is the file's own
 * identifier but is only readable with the right permission, so the document
 * root's id stands in for it; either is stable for the life of the file.
 */
function sourceKey(): string {
  try {
    const key = (figma as unknown as { fileKey?: string }).fileKey;
    if (key) return key;
  } catch {
    // Reading fileKey without permission throws; the root id works just as well.
  }
  try {
    return figma.root.id || "";
  } catch {
    return "";
  }
}

// --- Traversal ------------------------------------------------------------

/** Drop selected nodes whose ancestor is also selected, so nothing is sent twice. */
function topmostOnly(nodes: readonly SceneNode[]): SceneNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes.filter((node) => {
    for (let p = node.parent as BaseNode | null; p; p = p.parent) if (ids.has(p.id)) return false;
    return true;
  });
}

/** Child indices from the page down to the node: sorting by it gives bottom-to-top z-order. */
function zPath(node: BaseNode): number[] {
  const path: number[] = [];
  for (let n: BaseNode = node; n.parent && n.type !== "PAGE"; n = n.parent as BaseNode) {
    const siblings = ((n.parent as any).children || []) as readonly BaseNode[];
    let index = 0;
    for (let i = 0; i < siblings.length; i++) {
      if (siblings[i].id === n.id) {
        index = i;
        break;
      }
    }
    path.unshift(index);
  }
  return path;
}

function sortByZOrder(nodes: SceneNode[]): SceneNode[] {
  const keyed = nodes.map((node) => ({ node, path: zPath(node) }));
  keyed.sort((a, b) => {
    const n = Math.min(a.path.length, b.path.length);
    for (let i = 0; i < n; i++) if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
    return a.path.length - b.path.length;
  });
  return keyed.map((k) => k.node);
}

function parentId(node: BaseNode): string {
  return node.parent ? node.parent.id : "";
}

/**
 * Walk sibling nodes bottom to top. A node with isMask masks the siblings after
 * it (above it) in the same parent and is not drawn itself; a later mask in the
 * same parent starts a new masked run.
 */
async function collectSiblings(nodes: readonly SceneNode[], ctx: Ctx, out: Layer[], fromSelection: boolean) {
  const masked = new Map<string, Ctx>(); // parent id -> context carrying the current mask
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.visible === false) continue;
    const pid = parentId(node);
    if ((node as any).isMask === true) {
      let masksSomething = false;
      for (let j = i + 1; j < nodes.length; j++) {
        if (nodes[j].visible !== false && parentId(nodes[j]) === pid) masksSomething = true;
      }
      if (masksSomething) {
        const clip = combineClips(ctx.clip, maskClip(node, ctx));
        masked.set(pid, Object.assign({}, ctx, { clip }));
        continue;
      }
      // A mask with nothing above it shows nothing in Figma, unless it was
      // selected on its own: then send it as the ordinary shape it is.
      if (!fromSelection) continue;
    }
    await collectNode(node, masked.get(pid) || ctx, out);
  }
}

/** Convert a node into LazyLord layers: a leaf, or a group of its contents. */
async function collectNode(node: SceneNode, ctx: Ctx, out: Layer[]): Promise<void> {
  if (node.visible === false) return;
  if (node.type === "SLICE") return; // an export region, not artwork
  if (ctx.clip && ctx.clip.empty) return; // clipped away entirely


  if (CONTAINER_TYPES.has(node.type)) {
    await collectContainer(node, ctx, out);
    return;
  }

  if (node.type === "TEXT") {
    const layer = await textToLayer(node as TextNode, ctx);
    if (layer) out.push(layer);
    return;
  }

  if (hasImageFill(node)) {
    const layer = await nodeToImage(node, ctx);
    if (layer) out.push(layer);
    return;
  }

  if (GEOMETRY_TYPES.has(node.type)) {
    const layer = vectorLayer(node, ctx);
    if (layer) {
      out.push(layer);
      return;
    }
  }

  // Fallback: rasterise anything we can't describe as vector/text.
  const layer = await nodeToImage(node, ctx);
  if (layer) {
    warn(
      ctx,
      node.name,
      GEOMETRY_TYPES.has(node.type)
        ? "Its outline could not be read, so it was sent as an image"
        : `No vector description for this kind of layer (${typeLabel(node.type)}), so it was sent as an image`,
      "rasterized"
    );
    out.push(layer);
  }
}

/**
 * A container as one IR group holding, bottom to top, its fill, its contents
 * and its border. Its opacity stays on the group, never multiplied into the
 * leaves: a target that flattens hierarchy does that itself and reports it
 * where it is approximate — wherever the group holds more than one leaf at
 * any depth, not just more than one direct child (a faded frame round a
 * single group of several shapes fades each of them) — and one that rebuilds
 * groups applies it once, to the group, exactly. The plugin reports none of
 * this itself: it cannot know which the target will do. A container that
 * draws nothing is left out rather than sent as an empty group.
 */
async function collectContainer(node: SceneNode, ctx: Ctx, out: Layer[]): Promise<void> {
  const any = node as any;

  const children = (any.children || []) as readonly SceneNode[];
  const content: Layer[] = [];
  if (children.length) {
    const inner: Ctx = Object.assign({}, ctx);
    if (FRAME_TYPES.has(node.type) && any.clipsContent === true) {
      inner.clip = combineClips(ctx.clip, frameClip(node, ctx));
    }
    await collectSiblings(children, inner, content, false);
  }

  // Figma paints a frame's fill under its children and its stroke over them.
  const own = BACKGROUND_TYPES.has(node.type) ? containerPaint(node, ctx, content.length > 0) : { below: null, above: null };
  const members: Layer[] = [];
  if (own.below) members.push(own.below);
  for (const layer of content) members.push(layer);
  if (own.above) members.push(own.above);
  if (members.length) out.push(groupLayer(node, members, ctx));
}

/**
 * The IR group for a container. Its children keep their frames in frame
 * space; its own frame is the union of what they show, or of their boxes
 * when all of them are clipped away (groupBox), and it is never rotated:
 * a rotated frame's contents are already baked or carry their own rotation.
 * The clip lives on the leaves, which each carry their own copy.
 */
function groupLayer(node: SceneNode, children: Layer[], ctx: Ctx): GroupLayer {
  const any = node as any;
  const b = groupBox(children);
  return {
    id: node.id,
    name: node.name,
    type: "group",
    frame: { x: b.x, y: b.y, width: b.width, height: b.height, rotation: 0, opacity: num(any.opacity, 1) },
    visible: true,
    blendMode: readBlend(node, ctx),
    effects: readEffects(node, ctx),
    children,
  };
}

/**
 * A frame's (or section's) own paint as vector layers: the fills go below its
 * children and the strokes above them, because Figma draws a frame's border over its
 * contents. With nothing inside, one layer carries both. Both are built in the
 * parent's context: a frame's clipsContent never clips its own fill or border.
 * The group takes the frame's id and its opacity, so these take suffixed ids
 * and opacity 1.
 */
function containerPaint(
  node: SceneNode,
  ctx: Ctx,
  hasContent: boolean
): { below: VectorLayer | null; above: VectorLayer | null } {
  const any = node as any;
  const none = { below: null, above: null };
  const fills = visiblePaints(any.fills);
  if (fills.some((p) => IMAGE_PAINTS.has(p.type))) {
    // Rasterising only the background would mean editing the user's file; don't.
    warn(ctx, node.name, `Image fill on a ${typeLabel(node.type)} is not transferred; only its other fills and its contents are`, "skipped");
  }
  const paints = fills.filter((p) => !IMAGE_PAINTS.has(p.type));
  const strokes = visiblePaints(any.strokes);
  if (!paints.length && !strokes.length) return none;

  const geometry = containerGeometry(node, ctx);
  const id = node.id + ":fill";
  if (!hasContent) return { below: vectorLayer(node, ctx, { fills: paints, geometry, id, opacity: 1 }), above: null };
  return {
    below: paints.length ? vectorLayer(node, ctx, { fills: paints, strokes: false, geometry, id, opacity: 1 }) : null,
    above: strokes.length
      ? vectorLayer(node, ctx, { fills: [], geometry, id: node.id + ":stroke", name: node.name + " (stroke)", opacity: 1 })
      : null,
  };
}

/**
 * A container's outline: its fill geometry, else (sections have none, and a
 * frame may not report one) its box rebuilt from its own corner radii.
 */
function containerGeometry(node: SceneNode, ctx: Ctx): LocalGeometry {
  const g = readPaths((node as any).fillGeometry, node, ctx);
  if (g) return Object.assign(g, { source: "fill" as const });
  return { subpaths: boxOutline(node, ctx), winding: "nonzero", source: "fill" };
}

// --- Vectors --------------------------------------------------------------

type LocalGeometry = {
  subpaths: SubPath[];
  winding: "nonzero" | "evenodd";
  /** Where the contours came from; "stroke" means an already-outlined stroke. */
  source: "fill" | "centreline" | "path" | "stroke";
};

type VectorOptions = {
  /** Figma paints to use instead of node.fills. */
  fills?: any[];
  /** Set false to leave the node's strokes off this layer. */
  strokes?: boolean;
  /** Contours to use instead of reading them from the node. */
  geometry?: LocalGeometry;
  /** Layer id, when one node gives more than one layer. */
  id?: string;
  name?: string;
  /** Set false to never emit a primitive. */
  primitive?: boolean;
  /** Opacity to use instead of the node's own (a frame's paint: its group has it). */
  opacity?: number;
};

function vectorLayer(node: SceneNode, ctx: Ctx, opts: VectorOptions = {}): VectorLayer | null {
  const any = node as any;
  const geom = opts.geometry || localGeometry(node, ctx);
  if (!geom) return null;
  const t = absoluteTransform(node);
  const baked = bakeSubPaths(geom.subpaths, t, ctx.origin);
  if (!baked) return null;
  const box = baked.frame;

  let fills: Paint[];
  let strokes: Stroke[];
  if (geom.source === "stroke") {
    // The contour IS the outlined stroke: paint it with the stroke paint, and
    // draw no stroke on top of it.
    fills = convertPaints(visiblePaints(any.strokes), node, t, box, ctx);
    strokes = [];
  } else {
    const figmaFills = opts.fills !== undefined ? opts.fills : visiblePaints(any.fills);
    fills = convertPaints(figmaFills, node, t, box, ctx);
    strokes = opts.strokes === false ? [] : convertStrokes(node, t, box, ctx);
    if (figmaFills.length > 1) {
      warn(ctx, node.name, `Has ${figmaFills.length} visible fills; the target uses only the first (bottom) one`, "approximated");
    }
  }

  const layer: VectorLayer = {
    id: opts.id || node.id,
    name: opts.name || node.name,
    type: "vector",
    frame: {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      rotation: 0,
      opacity: opts.opacity !== undefined ? opts.opacity : num(any.opacity, 1),
    },
    visible: true,
    blendMode: readBlend(node, ctx),
    effects: readEffects(node, ctx),
    subpaths: baked.subpaths,
    fills,
    strokes,
    windingRule: geom.winding,
  };
  if (geom.source === "fill" && opts.primitive !== false) {
    const primitive = primitiveFor(node, t, box);
    if (primitive) layer.primitive = primitive;
  }
  attachClip(layer, ctx, strokedExtent(box, strokes));
  return layer;
}

/**
 * How far past its outline a target may draw a stroke. Targets centre every
 * stroke, and the IR carries no miter limit: Illustrator's default of 10 lets
 * a sharp miter reach 5 stroke weights out, and every other join or cap stays
 * within one weight.
 */
function strokedExtent(box: Box, strokes: Stroke[]): Box {
  let pad = 0;
  for (const s of strokes) pad = Math.max(pad, s.weight * (s.join === "round" || s.join === "bevel" ? 1 : 5));
  return { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
}

/** A node's contours in its own local, unrotated space. */
function localGeometry(node: SceneNode, ctx: Ctx): LocalGeometry | null {
  const any = node as any;
  if (node.type === "LINE") {
    // A line runs along its local x axis; keep it a stroked path, not an outline.
    const w = num(any.width, 0);
    return {
      subpaths: [{ closed: false, vertices: [[0, 0], [w, 0]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]] }],
      winding: "nonzero",
      source: "centreline",
    };
  }
  // A stroke-only vector: its own paths keep open ends open, where the fill
  // geometry would close them.
  if (node.type === "VECTOR" && visiblePaints(any.fills).length === 0) {
    const own = readPaths(any.vectorPaths, node, ctx);
    if (own) return Object.assign(own, { source: "path" as const });
  }
  const fill = readPaths(any.fillGeometry, node, ctx);
  if (fill) return Object.assign(fill, { source: "fill" as const });
  if (node.type === "VECTOR") {
    const own = readPaths(any.vectorPaths, node, ctx);
    if (own) return Object.assign(own, { source: "path" as const });
  }
  const stroke = readPaths(any.strokeGeometry, node, ctx);
  if (stroke) return Object.assign(stroke, { source: "stroke" as const });
  return null;
}

/** Parse Figma VectorPaths ({ windingRule, data }[]) into subpaths. */
function readPaths(paths: unknown, node: SceneNode, ctx: Ctx): { subpaths: SubPath[]; winding: "nonzero" | "evenodd" } | null {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const subpaths: SubPath[] = [];
  let evenodd = false;
  let broken = 0;
  for (const g of paths as any[]) {
    if (!g || typeof g.data !== "string") continue;
    if (g.windingRule === "EVENODD") evenodd = true;
    try {
      for (const sp of parseSvgPath(g.data)) subpaths.push(sp);
    } catch {
      broken++;
    }
  }
  if (broken) warn(ctx, node.name, `${broken} contour${broken === 1 ? "" : "s"} could not be read and ${broken === 1 ? "was" : "were"} left out`, "skipped");
  if (subpaths.length === 0) return null;
  return { subpaths, winding: evenodd ? "evenodd" : "nonzero" };
}

/**
 * The parametric shape a node's outline is, when it is exactly one: an
 * axis-aligned rectangle with one corner radius (frames' backgrounds too), or
 * a whole, un-arced ellipse. In local space, where the frame IS its box.
 */
function primitiveFor(node: SceneNode, t: Affine, box: Box): Primitive | null {
  const any = node as any;
  if (node.type === "RECTANGLE" || BACKGROUND_TYPES.has(node.type)) {
    if (!isAxisAligned(t)) return null;
    const r = any.cornerRadius;
    if (typeof r !== "number") return null; // figma.mixed: corners differ
    // Smoothed ("squircle") corners are not circular arcs.
    if (r > 0 && num(any.cornerSmoothing, 0) > 0) return null;
    return {
      kind: "rect",
      x: 0,
      y: 0,
      width: box.width,
      height: box.height,
      roundness: Math.max(0, Math.min(r, box.width / 2, box.height / 2)),
    };
  }
  if (node.type === "ELLIPSE") {
    const arc = any.arcData;
    if (arc) {
      const sweep = num(arc.endingAngle, 2 * Math.PI) - num(arc.startingAngle, 0);
      if (Math.abs(sweep - 2 * Math.PI) > 1e-6 || num(arc.innerRadius, 0) > 1e-6) return null;
    }
    // Upright (mirroring is harmless to an ellipse), or a circle under any rotation.
    const upright = Math.abs(t[1][0]) < 1e-6 && Math.abs(t[0][1]) < 1e-6 && t[0][0] !== 0 && t[1][1] !== 0;
    const circle = Math.abs(num(any.width, 0) - num(any.height, 0)) < 1e-6 && isSimilarity(t);
    if (!upright && !circle) return null;
    return { kind: "ellipse", x: 0, y: 0, width: box.width, height: box.height };
  }
  return null;
}

// --- Paints ---------------------------------------------------------------

function convertPaints(paints: any[], node: SceneNode, t: Affine, box: Box, ctx: Ctx): Paint[] {
  const any = node as any;
  const w = num(any.width, 0);
  const h = num(any.height, 0);
  const out: Paint[] = [];
  for (const p of paints) {
    const opacity = p.opacity == null ? 1 : p.opacity;
    if (p.type === "SOLID") {
      out.push({ type: "solid", color: rgba(p.color, opacity) });
    } else if (
      p.type === "GRADIENT_LINEAR" ||
      p.type === "GRADIENT_RADIAL" ||
      p.type === "GRADIENT_ANGULAR" ||
      p.type === "GRADIENT_DIAMOND"
    ) {
      const radial = p.type !== "GRADIENT_LINEAR";
      if (p.type === "GRADIENT_ANGULAR" || p.type === "GRADIENT_DIAMOND") {
        warn(ctx, node.name, `${p.type === "GRADIENT_ANGULAR" ? "Angular" : "Diamond"} gradient sent as a radial gradient`, "approximated");
      }
      // Handles live in the node's own 0..1 box; carry them into the baked frame.
      const gt = toAffine(p.gradientTransform);
      let from: Vec2;
      let to: Vec2;
      if (radial) {
        const hd = gradientHandlesFromTransform(gt, "radial");
        const px = (v: Vec2) => applyAffine(t, v.x * w, v.y * h);
        const c = px(hd.from);
        const r1 = px(hd.to);
        const r2 = px(hd.edge);
        const d1 = Math.hypot(r1[0] - c[0], r1[1] - c[1]);
        const d2 = Math.hypot(r2[0] - c[0], r2[1] - c[1]);
        if (Math.abs(d1 - d2) > 0.01 * Math.max(d1, d2)) {
          warn(ctx, node.name, "Elliptical radial gradient rebuilt as a circle", "approximated");
        }
        from = remapHandle(hd.from, w, h, t, box, ctx.origin);
        to = remapHandle(hd.to, w, h, t, box, ctx.origin);
      } else {
        // Figma's bands follow its normalised box, not the mapped handle
        // line: rebuild the handles so the target's bands match (see
        // linearHandlesPx).
        const px = linearHandlesPx(gt, w, h, t);
        from = pointToFrameUnits(px.from, box, ctx.origin);
        to = pointToFrameUnits(px.to, box, ctx.origin);
      }
      out.push({
        type: radial ? "radial-gradient" : "linear-gradient",
        stops: (p.gradientStops || []).map((s: any) => ({
          position: s.position,
          color: rgba(s.color, (s.color && s.color.a != null ? s.color.a : 1) * opacity),
        })),
        from,
        to,
      });
    } else if (IMAGE_PAINTS.has(p.type)) {
      warn(ctx, node.name, "Image paint is not transferred on a vector or stroke", "skipped");
    } else {
      warn(ctx, node.name, `${typeLabel(String(p.type))} paint is not supported`, "skipped");
    }
  }
  return out;
}

const CAPS: Record<string, Stroke["cap"]> = { NONE: "none", ROUND: "round", SQUARE: "square" };
const JOINS: Record<string, Stroke["join"]> = { MITER: "miter", ROUND: "round", BEVEL: "bevel" };
const ALIGNS: Record<string, Stroke["align"]> = { CENTER: "center", INSIDE: "inside", OUTSIDE: "outside" };

function convertStrokes(node: SceneNode, t: Affine, box: Box, ctx: Ctx): Stroke[] {
  const any = node as any;
  const visible = visiblePaints(any.strokes);
  if (visible.length === 0) return [];
  const paints = convertPaints(visible, node, t, box, ctx);
  if (paints.length === 0) return [];

  let weight = typeof any.strokeWeight === "number" ? any.strokeWeight : NaN;
  if (!(weight >= 0)) {
    // figma.mixed: rectangles and frames can weigh each side differently.
    const sides = [any.strokeTopWeight, any.strokeRightWeight, any.strokeBottomWeight, any.strokeLeftWeight].filter(
      (v) => typeof v === "number"
    ) as number[];
    weight = sides.length ? Math.max(...sides) : 1;
    warn(ctx, node.name, `Stroke weight differs per side; ${fmt(weight)}px is used all round`, "approximated");
  }
  const align = ALIGNS[String(any.strokeAlign)] || "center";
  if (align !== "center") {
    warn(ctx, node.name, `${align === "inside" ? "Inside" : "Outside"} stroke will be centred on the path (the Adobe hosts centre strokes)`, "approximated");
  }
  if (visible.length > 1) {
    warn(ctx, node.name, `Has ${visible.length} visible strokes; the target uses only the first one`, "approximated");
  }
  const cap = CAPS[String(any.strokeCap)];
  if (!cap && any.strokeCap !== undefined) {
    // Arrowheads and the filled end shapes have no counterpart in the IR;
    // figma.mixed means a vector's ends carry different caps.
    warn(
      ctx,
      node.name,
      any.strokeCap === figma.mixed
        ? "Its line ends use different end caps (arrowheads or shapes), which are not transferred; the stroke ends flat"
        : `Its ${typeLabel(String(any.strokeCap))} end cap is not transferred; the stroke ends flat`,
      "skipped"
    );
  }
  return paints.map((paint) => ({
    paint,
    weight,
    cap: cap || "none",
    join: JOINS[String(any.strokeJoin)] || "miter",
    align,
    dashPattern: Array.isArray(any.dashPattern) && any.dashPattern.length ? any.dashPattern.slice() : undefined,
  }));
}

// --- Text -----------------------------------------------------------------

/** Text properties that can vary per character, and how to name them to a user. */
const MIXED_TEXT: Array<[string, string]> = [
  ["fontName", "fonts"],
  ["fontSize", "sizes"],
  ["fills", "colours"],
  ["letterSpacing", "letter spacing"],
  ["lineHeight", "line heights"],
  ["textCase", "letter cases"],
  ["textDecoration", "decorations"],
];

async function textToLayer(node: TextNode, ctx: Ctx): Promise<Layer | null> {
  const any = node as any;
  const mixed = MIXED_TEXT.filter(([key]) => any[key] === figma.mixed).map(([, label]) => label);

  // Mixed styles stay live: each styled stretch becomes a run. Outlines are
  // only the fallback when Figma cannot list the stretches.
  let segs: any[] | null = null;
  if (mixed.length) {
    try {
      segs = any.getStyledTextSegments(["fontName", "fontSize", "fills", "letterSpacing", "lineHeight", "textCase", "textDecoration"]);
    } catch {
      segs = null;
    }
  }
  if (mixed.length && (!segs || !segs.length)) {
    // Preserve appearance by sending outlines instead of live text.
    const mixedFills = any.fills === figma.mixed;
    const vec = vectorLayer(node, ctx, {
      fills: mixedFills ? firstCharacterFills(node) : undefined,
      name: node.name + " (outlined)",
      primitive: false,
    });
    if (vec) {
      warn(ctx, node.name, `Text mixes ${listing(mixed)}, so it was converted to outlines to keep its look`, "approximated");
      if (mixedFills) warn(ctx, node.name, "Outlined text is filled with the colour of its first character", "approximated");
      return vec;
    }
    const img = await nodeToImage(node, ctx);
    if (img) warn(ctx, node.name, `Text mixes ${listing(mixed)} and could not be outlined, so it was sent as an image`, "rasterized");
    return img;
  }

  // The base style is the text's own, or its first stretch's where it mixes.
  const first = segs && segs.length ? segs[0] : null;
  const pick = (key: string) => (any[key] === figma.mixed && first ? first[key] : any[key]);
  const fn = pick("fontName") as FontName;
  const fontSize = pick("fontSize") as number;
  const w = num(any.width, 0);
  const h = num(any.height, 0);

  // The box stays unrotated; its centre and clockwise angle come from the
  // absolute transform, so rotated parents count too.
  const placed = placeBox(w, h, absoluteTransform(node));
  if (placed.flipped) {
    warn(ctx, node.name, "Mirrored text cannot stay live and mirrored, so it was sent unmirrored", "approximated");
  }
  const frame = {
    x: placed.centre.x - w / 2 - ctx.origin.x,
    y: placed.centre.y - h / 2 - ctx.origin.y,
    width: w,
    height: h,
    rotation: placed.rotation,
    opacity: num(any.opacity, 1),
  };

  const color = any.fills === figma.mixed && first ? paintsColour(first.fills, node.name, ctx) : textColour(node, ctx);
  if (visiblePaints(any.strokes).length) warn(ctx, node.name, "Text stroke is not transferred", "skipped");

  const letterSpacing = spacingToPx(pick("letterSpacing") as LetterSpacing, fontSize);
  const lineHeight = lineHeightToPx(pick("lineHeight") as LineHeight, fontSize);
  if (any.lineHeight === figma.mixed) warn(ctx, node.name, "Line height varies within the text; its first line height is used throughout", "approximated");
  if (any.textCase === figma.mixed) warn(ctx, node.name, "Letter case varies within the text; its first case is used throughout", "approximated");

  const align = (node.textAlignHorizontal || "LEFT").toLowerCase() as TextLayer["textAlignHorizontal"];
  const valign = (node.textAlignVertical || "TOP").toLowerCase() as TextLayer["textAlignVertical"];
  const caseMap: Record<string, TextLayer["textCase"]> = {
    ORIGINAL: "original",
    UPPER: "upper",
    LOWER: "lower",
    TITLE: "title",
    SMALL_CAPS: "original",
    SMALL_CAPS_FORCED: "original",
  };
  const decoMap: Record<string, TextLayer["decoration"]> = {
    NONE: "none",
    UNDERLINE: "underline",
    STRIKETHROUGH: "strikethrough",
  };

  const layer: TextLayer = {
    id: node.id,
    name: node.name,
    type: "text",
    frame,
    visible: true,
    blendMode: readBlend(node, ctx),
    effects: readEffects(node, ctx),
    characters: node.characters,
    fontFamily: fn.family,
    fontStyle: fn.style,
    fontSize,
    color,
    letterSpacing,
    lineHeight,
    textAlignHorizontal: align,
    textAlignVertical: valign,
    textCase: caseMap[pick("textCase") as string] || "original",
    decoration: decoMap[pick("textDecoration") as string] || "none",
  };
  if (segs && segs.length > 1) {
    layer.runs = segs.map((s) => ({
      start: s.start,
      end: s.end,
      fontFamily: s.fontName && s.fontName.family,
      fontStyle: s.fontName && s.fontName.style,
      fontSize: s.fontSize,
      color: paintsColour(s.fills, node.name, ctx),
      letterSpacing: spacingToPx(s.letterSpacing as LetterSpacing, s.fontSize),
      decoration: decoMap[s.textDecoration as string] || "none",
    }));
  }
  // Glyphs can spill out of a fixed-size text box: count their render bounds too.
  const rb = any.absoluteRenderBounds as Box | null;
  const ext = rotatedBoxBounds(frame);
  attachClip(layer, ctx, (rb && unionBoxes(ext, { x: rb.x - ctx.origin.x, y: rb.y - ctx.origin.y, width: rb.width, height: rb.height })) || ext);
  return layer;
}

/** Live text carries one colour: the first solid fill, else a gradient's first stop. */
function textColour(node: TextNode, ctx: Ctx): RGBA {
  return paintsColour((node as any).fills, node.name, ctx);
}

/** One colour from a text's (or a stretch of it's) paints. */
function paintsColour(paints: any, name: string, ctx: Ctx): RGBA {
  const fills = visiblePaints(paints);
  if (fills.length > 1) warn(ctx, name, `Text has ${fills.length} visible fills; only one colour is used`, "approximated");
  for (const f of fills) {
    if (f.type === "SOLID") return rgba(f.color, f.opacity == null ? 1 : f.opacity);
  }
  for (const f of fills) {
    if (Array.isArray(f.gradientStops) && f.gradientStops.length) {
      warn(ctx, name, "Gradient text fill sent as a flat colour from its first stop", "approximated");
      const s = f.gradientStops[0];
      return rgba(s.color, (s.color && s.color.a != null ? s.color.a : 1) * (f.opacity == null ? 1 : f.opacity));
    }
  }
  if (fills.length) warn(ctx, name, "Text fill is not a colour or gradient; sent as black", "approximated");
  return { r: 0, g: 0, b: 0, a: 1 };
}

/** The paints of the first character, for outlining text whose colours vary. */
function firstCharacterFills(node: TextNode): any[] {
  try {
    if (node.characters.length > 0) {
      const f = (node as any).getRangeFills(0, 1);
      if (Array.isArray(f)) return visiblePaints(f);
    }
  } catch {
    /* fall through to black */
  }
  return [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
}

function spacingToPx(ls: LetterSpacing, fontSize: number): number {
  if (!ls) return 0;
  if (ls.unit === "PERCENT") return (ls.value / 100) * fontSize;
  return ls.value;
}

function lineHeightToPx(lh: LineHeight, fontSize: number): number {
  if (!lh || lh.unit === "AUTO") return 0;
  if (lh.unit === "PERCENT") return (lh.value / 100) * fontSize;
  return lh.value;
}

// --- Images ---------------------------------------------------------------

function hasImageFill(node: SceneNode): boolean {
  const fills = (node as any).fills;
  if (!Array.isArray(fills)) return false;
  return fills.some((f: any) => f && f.visible !== false && IMAGE_PAINTS.has(f.type));
}

/**
 * Rasterise a node. exportAsync renders it as it looks on the canvas —
 * rotated, effects and its own opacity included — within its absolute render
 * bounds, so that is the frame (rotation 0) and its opacity is 1: its
 * parents' opacity travels on their groups.
 */
async function nodeToImage(node: SceneNode, ctx: Ctx): Promise<ImageLayer | null> {
  const any = node as any;
  let bytes: Uint8Array;
  try {
    bytes = await any.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: ctx.scale } });
  } catch (e) {
    warn(ctx, node.name, `Could not be exported as an image (${(e as Error).message || e}), so it was left out`, "skipped");
    return null;
  }
  const rb = (any.absoluteRenderBounds || any.absoluteBoundingBox) as Box | null;
  if (!rb) {
    warn(ctx, node.name, "Has no visible area to export, so it was left out", "skipped");
    return null;
  }
  const frame = { x: rb.x - ctx.origin.x, y: rb.y - ctx.origin.y, width: rb.width, height: rb.height, rotation: 0, opacity: 1 };
  const size = pngSize(bytes);
  const layer: ImageLayer = {
    id: node.id,
    name: node.name,
    type: "image",
    frame,
    visible: true,
    // Blend mode still travels: an export renders the node, not how it
    // composites with what is under it. Effects do not — they are already in
    // these pixels, and sending them too would draw every shadow twice.
    blendMode: readBlend(node, ctx),
    pngBase64: figma.base64Encode(bytes),
    pixelWidth: size ? size.width : Math.max(1, Math.round(frame.width * ctx.scale)),
    pixelHeight: size ? size.height : Math.max(1, Math.round(frame.height * ctx.scale)),
  };
  attachClip(layer, ctx, frame);
  return layer;
}

/** Width/height from a PNG's IHDR chunk, or null if the bytes are not a PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!bytes || bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const u32 = (i: number) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  const width = u32(16);
  const height = u32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

// --- Clipping -------------------------------------------------------------

function clipState(id: string, name: string, subpaths: SubPath[], winding: "nonzero" | "evenodd"): ClipState {
  return {
    clip: { id, name, subpaths, windingRule: winding },
    bounds: curveBounds(subpaths),
    rect: rectOfSubPaths(subpaths),
  };
}

/** Local contours -> absolute -> frame space (absolute - selection origin). */
function toFrameSpace(local: SubPath[], t: Affine, ctx: Ctx): SubPath[] {
  return offsetSubPaths(transformSubPaths(local, t), -ctx.origin.x, -ctx.origin.y);
}

function localBox(node: SceneNode): SubPath[] {
  return rectToSubPaths({ x: 0, y: 0, width: num((node as any).width, 0), height: num((node as any).height, 0) });
}

const KAPPA = 0.5522847498;

/**
 * A container's width x height box as one contour, rounded by its own corner
 * radii. When adjacent corners would overlap, the radii are scaled down
 * together, so a single radius stops at half the shorter side, as in
 * primitiveFor. Smoothed corners are drawn as plain circular ones.
 */
function boxOutline(node: SceneNode, ctx: Ctx): SubPath[] {
  const any = node as any;
  const w = Math.max(0, num(any.width, 0));
  const h = Math.max(0, num(any.height, 0));
  const u = any.cornerRadius;
  const r = (typeof u === "number" ? [u, u, u, u] : [any.topLeftRadius, any.topRightRadius, any.bottomRightRadius, any.bottomLeftRadius]).map(
    (v) => Math.max(0, num(v, 0))
  );
  if (r.every((v) => v <= 0)) return localBox(node);
  let f = 1;
  const fit = (side: number, a: number, b: number) => {
    if (a + b > side) f = Math.min(f, side / (a + b));
  };
  fit(w, r[0], r[1]);
  fit(h, r[1], r[2]);
  fit(w, r[3], r[2]);
  fit(h, r[0], r[3]);
  if (num(any.cornerSmoothing, 0) > 0) {
    warn(ctx, node.name, "Its smoothed corners are drawn as plain rounded corners", "approximated");
  }
  // Clockwise from the top-left: each corner, the direction its incoming edge
  // runs in and the direction its outgoing edge runs in.
  const corners: Array<[number, number, number, number, number, number]> = [
    [0, 0, 0, -1, 1, 0],
    [w, 0, 1, 0, 0, 1],
    [w, h, 0, 1, -1, 0],
    [0, h, -1, 0, 0, -1],
  ];
  const sp: SubPath = { closed: true, vertices: [], inTangents: [], outTangents: [] };
  corners.forEach(([cx, cy, ix, iy, ox, oy], i) => {
    const rad = r[i] * f;
    if (rad <= 1e-9) {
      sp.vertices.push([cx, cy]);
      sp.inTangents.push([0, 0]);
      sp.outTangents.push([0, 0]);
      return;
    }
    const k = rad * KAPPA;
    sp.vertices.push([cx - ix * rad, cy - iy * rad]);
    sp.inTangents.push([0, 0]);
    sp.outTangents.push([ix * k, iy * k]);
    sp.vertices.push([cx + ox * rad, cy + oy * rad]);
    sp.inTangents.push([-ox * k, -oy * k]);
    sp.outTangents.push([0, 0]);
  });
  return [sp];
}

/** A clipping frame's outline (its fill geometry, so rounded corners count). */
function frameClip(node: SceneNode, ctx: Ctx): ClipState {
  const g = containerGeometry(node, ctx);
  return clipState(node.id, node.name, toFrameSpace(g.subpaths, absoluteTransform(node), ctx), g.winding);
}

/**
 * A mask node's outline. Only hard-edged shape masks survive exactly; the
 * rest are rebuilt from their outline and reported.
 */
function maskClip(node: SceneNode, ctx: Ctx): ClipState {
  const any = node as any;
  const fills = visiblePaints(any.fills);
  const strokes = visiblePaints(any.strokes);
  let g = readPaths(any.fillGeometry, node, ctx);
  let fromStroke = false;
  if (!g && strokes.length) {
    g = readPaths(any.strokeGeometry, node, ctx);
    fromStroke = !!g;
  }
  const maskType = any.maskType === "LUMINANCE" || any.maskType === "VECTOR" ? any.maskType : "ALPHA";

  let reason = "";
  if (!g) reason = "Its mask shape could not be read, so its bounding box is used as the mask";
  else if (fills.some((p) => IMAGE_PAINTS.has(p.type))) reason = "Image mask rebuilt as a hard-edged mask from its outline";
  else if (maskType === "LUMINANCE") reason = "Luminance mask rebuilt as a hard-edged mask from its outline";
  else if (maskType === "ALPHA" && !isOpaqueFill(node)) {
    reason = "Alpha mask with soft or partial transparency rebuilt as a hard-edged mask from its outline";
  } else if (!fromStroke && fills.length && strokes.length) {
    reason = "The mask's stroke is not part of the rebuilt mask; only its fill outline is used";
  }
  if (reason) warn(ctx, node.name, reason, "approximated");

  const local = g ? g.subpaths : localBox(node);
  return clipState(node.id, node.name, toFrameSpace(local, absoluteTransform(node), ctx), g ? g.winding : "nonzero");
}

/** True when an alpha mask's alpha is exactly 1 inside its fill outline. */
function isOpaqueFill(node: SceneNode): boolean {
  const any = node as any;
  if (num(any.opacity, 1) < 0.999) return false;
  if (visibleEffects(node).length) return false;
  return visiblePaints(any.fills).some((p) => p.type === "SOLID" && (p.opacity == null ? 1 : p.opacity) >= 0.999);
}

function contains(outer: Box, inner: Box, eps = 1e-6): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.width <= outer.x + outer.width + eps &&
    inner.y + inner.height <= outer.y + outer.height + eps
  );
}

/**
 * Nest a new clip inside the one already in force. When one clip lies wholly
 * inside a rectangular other, the inner one alone is exact; two rectangles
 * intersect exactly; anything else keeps the innermost clip and is reported.
 */
function combineClips(outer: ClipState | null, inner: ClipState): ClipState {
  if (!outer) return inner;
  if (outer.empty) return outer;
  // Clips the outer one had already given up stay given up, and reported.
  if (outer.rect && inner.bounds && contains(outer.rect, inner.bounds)) return withDropped(inner, outer.dropped);
  if (inner.rect && outer.bounds && contains(inner.rect, outer.bounds)) return outer;
  if (outer.rect && inner.rect) {
    const box = intersectBoxes(outer.rect, inner.rect);
    const state = clipState(inner.clip.id, inner.clip.name || "", rectToSubPaths(box), "nonzero");
    state.rect = box;
    state.empty = box.width < 1e-6 || box.height < 1e-6;
    return withDropped(state, outer.dropped);
  }
  return withDropped(inner, (outer.dropped || []).concat([outer.clip.name || ""]));
}

function withDropped(state: ClipState, dropped: string[] | undefined): ClipState {
  return dropped && dropped.length ? Object.assign({}, state, { dropped: dropped.slice() }) : state;
}

/**
 * Give a leaf its own deep copy of the clip in force (hosts mutate clips in
 * place). A rectangular clip that the leaf's drawn extent lies wholly inside
 * changes nothing and is left off, so a clipping frame nested among its
 * siblings does not split their clip id into separate runs.
 */
function attachClip(layer: Layer, ctx: Ctx, extent: Box) {
  const state = ctx.clip;
  if (!state) return;
  if (state.dropped) {
    const names = state.dropped.map((n) => (n ? `"${n}"` : "an unnamed clip"));
    warn(
      ctx,
      state.clip.name || layer.name,
      `Clipping inside ${listing(names)}: only this innermost clip is kept, so ${names.length === 1 ? names[0] + " no longer clips" : "they no longer clip"} these layers`,
      "approximated"
    );
  }
  if (state.rect && contains(state.rect, extent)) return;
  const clip: ClipPath = { id: state.clip.id, subpaths: cloneSubPaths(state.clip.subpaths) };
  if (state.clip.name) clip.name = state.clip.name;
  if (state.clip.windingRule) clip.windingRule = state.clip.windingRule;
  layer.clip = clip;
}

// --- Document bounds & canvas -----------------------------------------------

/**
 * Normalise every frame to the top-left of what is actually drawn (render
 * bounds of rasters, rotated text boxes, clipped extents: layerExtent) and
 * return the document bounds. Nothing ends up at a negative position.
 * Groups and their children move alike, clips with them (moveLayers).
 */
function finishBounds(layers: Layer[], origin: Vec2, fallback: Box): Document["bounds"] {
  let u: Box | null = null;
  for (const layer of layers) u = unionBoxes(u, layerExtent(layer));
  if (!u) return { x: fallback.x, y: fallback.y, width: fallback.width, height: fallback.height };
  const dx = u.x;
  const dy = u.y;
  if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) moveLayers(layers, -dx, -dy);
  return { x: origin.x + dx, y: origin.y + dy, width: u.width, height: u.height };
}

/** A node's ancestors-or-self below the page, outermost first. */
function scenePath(node: BaseNode): BaseNode[] {
  const path: BaseNode[] = [];
  for (let n: BaseNode | null = node; n && n.type !== "PAGE" && n.type !== "DOCUMENT"; n = n.parent) path.unshift(n);
  return path;
}

/**
 * Where the selection sits. When every selected node lies inside the same
 * top-level frame (or section; see sharedArtboard), that frame is the source
 * page: bounds are measured from its top-left ("document" space, which
 * LazyLord.applyOrigin adds back) and its size is the canvas a target sizes a
 * new document or comp to, so an icon keeps its place in a 1920x1080 frame.
 * A selection that is the frame itself, spans several frames or sits loose on
 * the page stays in "canvas" space; `canvas` is still sent, for information,
 * whenever the selection belongs to one frame. Call after finishBounds.
 *
 * With `keepPlace` false (Destination "auto"), objects inside a frame are sent
 * on their own: no frame page and no frame canvas, so a new document or comp
 * takes the objects' size and name. A frame sent whole is unaffected.
 */
function placeOnArtboard(doc: Document, selection: readonly SceneNode[], ctx: Ctx, keepPlace = true) {
  const shared = sharedArtboard(selection.map(scenePath));
  if (!shared) return;
  if (!keepPlace && shared.inside) return;
  const board = shared.node as SceneNode;
  const width = num((board as any).width, 0);
  const height = num((board as any).height, 0);
  if (!(width > 0 && height > 0)) return;
  doc.canvas = { width, height, name: board.name };
  if (!shared.inside) return;

  const t = absoluteTransform(board);
  if (!isAxisAligned(t)) {
    warn(ctx, board.name, "Its frame is rotated or mirrored, so the selection is placed at the target's origin rather than where it sits in the frame", "approximated");
    return;
  }
  const bx = t[0][2];
  const by = t[1][2];
  const b = doc.bounds;
  // Wholly off the frame (a child of a frame that does not clip): there is no
  // place on the page to keep, and a frame-sized comp would show nothing.
  if (b.x > bx + width || b.x + b.width < bx || b.y > by + height || b.y + b.height < by) return;
  doc.originSpace = "document";
  doc.bounds = { x: b.x - bx, y: b.y - by, width: b.width, height: b.height };
}

/**
 * Make one selected frame the page: bounds measured from its top-left
 * ("document" space) and its box as the canvas, so the target creates a
 * document or comp exactly the frame's size and name. A rotated or mirrored
 * frame has no upright page to keep and stays as it is.
 */
function placeOnOwnFrame(doc: Document, frame: SceneNode, ctx: Ctx) {
  const width = num((frame as any).width, 0);
  const height = num((frame as any).height, 0);
  if (!(width > 0 && height > 0)) return;
  const t = absoluteTransform(frame);
  if (!isAxisAligned(t)) {
    warn(ctx, frame.name, "The frame is rotated or mirrored, so the document is sized to its contents rather than the frame", "approximated");
    return;
  }
  const b = doc.bounds;
  doc.canvas = { width, height, name: frame.name };
  doc.originSpace = "document";
  doc.bounds = { x: b.x - t[0][2], y: b.y - t[1][2], width: b.width, height: b.height };
}

// --- Diagnostics helpers ----------------------------------------------------

function visibleEffects(node: SceneNode): any[] {
  const effects = (node as any).effects;
  return Array.isArray(effects) ? effects.filter((e: any) => e && e.visible !== false) : [];
}

/**
 * Figma effects as IR effects. Drop shadows, inner shadows and layer blurs
 * have a shared vocabulary; a background blur has no equivalent outside Figma,
 * and anything else Figma grows later is reported rather than guessed at.
 */
function readEffects(node: SceneNode, ctx: Ctx): Effect[] | undefined {
  const out: Effect[] = [];
  const unsupported: string[] = [];

  for (const e of visibleEffects(node)) {
    const radius = Number(e.radius) || 0;
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      out.push({
        kind: e.type === "DROP_SHADOW" ? "drop-shadow" : "inner-shadow",
        color: rgbaOf(e.color),
        offset: { x: Number(e.offset && e.offset.x) || 0, y: Number(e.offset && e.offset.y) || 0 },
        radius,
        spread: Number(e.spread) || 0,
      });
    } else if (e.type === "LAYER_BLUR") {
      out.push({ kind: "layer-blur", radius });
    } else if (e.type === "BACKGROUND_BLUR") {
      out.push({ kind: "background-blur", radius });
    } else {
      const label = EFFECT_LABELS[e.type] || typeLabel(String(e.type));
      if (unsupported.indexOf(label) < 0) unsupported.push(label);
    }
  }

  if (unsupported.length) {
    warn(ctx, node.name, `Effects with no equivalent elsewhere are not transferred: ${unsupported.join(", ")}`, "skipped");
  }
  return out.length ? out : undefined;
}

/** A Figma RGBA (0..1, alpha optional) as the IR's. */
function rgbaOf(c: any): RGBA {
  return {
    r: Number(c && c.r) || 0,
    g: Number(c && c.g) || 0,
    b: Number(c && c.b) || 0,
    a: c && typeof c.a === "number" ? c.a : 1,
  };
}

/** The node's blend mode in the IR's vocabulary, or undefined for Normal. */
function readBlend(node: SceneNode, ctx: Ctx): BlendMode | undefined {
  const raw = (node as any).blendMode;
  if (typeof raw !== "string") return undefined;
  const mode = blendModeFrom(raw);
  if (mode === null) {
    warn(ctx, node.name, `Blend mode "${typeLabel(raw)}" has no equivalent elsewhere, so the layer is drawn as Normal`, "approximated");
    return undefined;
  }
  return mode === "normal" ? undefined : mode;
}

// --- Small helpers ----------------------------------------------------------

/** The node's transform relative to the page, as an Affine. */
function absoluteTransform(node: SceneNode): Affine {
  const t = (node as any).absoluteTransform;
  const m = toAffine(t);
  if (m) return m;
  const bb = (node as any).absoluteBoundingBox as Box | null;
  return [
    [1, 0, bb ? bb.x : 0],
    [0, 1, bb ? bb.y : 0],
  ];
}

function toAffine(t: any): Affine | null {
  if (!Array.isArray(t) || t.length < 2 || !Array.isArray(t[0]) || !Array.isArray(t[1])) return null;
  const m: Affine = [
    [Number(t[0][0]), Number(t[0][1]), Number(t[0][2])],
    [Number(t[1][0]), Number(t[1][1]), Number(t[1][2])],
  ];
  for (const row of m) for (const v of row) if (!Number.isFinite(v)) return null;
  return m;
}

function visiblePaints(paints: unknown): any[] {
  if (!Array.isArray(paints)) return [];
  return paints.filter((p: any) => p && p.visible !== false);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** "SHAPE_WITH_TEXT" -> "shape with text". */
function typeLabel(type: string): string {
  return type.toLowerCase().replace(/_/g, " ");
}

/** ["a", "b", "c"] -> "a, b and c". */
function listing(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

function rgba(c: { r: number; g: number; b: number } | undefined, a: number): RGBA {
  if (!c) return { r: 0, g: 0, b: 0, a };
  return { r: c.r, g: c.g, b: c.b, a };
}
