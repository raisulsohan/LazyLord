/**
 * LazyLord Intermediate Representation (IR)
 * ---------------------------------------
 * A host-neutral description of a design selection. The Figma side produces it,
 * the Adobe hosts (Photoshop / Illustrator / After Effects) consume it.
 *
 * Coordinate conventions:
 *  - All geometry is Y-DOWN (same as Figma and After Effects comp space).
 *    Illustrator/Photoshop importers flip Y as needed for their host.
 *  - Each layer stores its own local geometry with the layer's top-left at (0,0),
 *    and a separate `frame` giving the absolute position/size on the document.
 *  - Bezier tangents are RELATIVE to their vertex (After Effects convention):
 *    a vertex at V with an out control point C has outTangent = C - V.
 */

export const IR_VERSION = "1.0" as const;

export type RGBA = {
  r: number; // 0..1
  g: number; // 0..1
  b: number; // 0..1
  a: number; // 0..1
};

export type Frame = {
  /** Absolute position of the layer's top-left on the document, in px. */
  x: number;
  y: number;
  /** Bounding size in px. */
  width: number;
  height: number;
  /**
   * Clockwise rotation in degrees around the frame's centre. x/y/width/height
   * describe the box BEFORE rotation. Vector geometry is always baked (rotation
   * 0); only text and images carry a rotation, since neither can be baked.
   */
  rotation?: number;
  /** 0..1 layer opacity. */
  opacity?: number;
};

export type GradientStop = {
  position: number; // 0..1
  color: RGBA;
};

export type SolidPaint = {
  type: "solid";
  color: RGBA;
};

export type GradientPaint = {
  type: "linear-gradient" | "radial-gradient";
  stops: GradientStop[];
  /**
   * Normalized handle positions (0..1 of the layer box, in the layer's local
   * space, so px = frame.x + from.x * frame.width).
   *  - linear: the gradient line runs from `from` (stop 0) to `to` (stop 1).
   *  - radial: `from` is the centre; `to` is a point on the outer circle, and
   *    the radius is |to - from| measured in px (circular, not elliptical).
   */
  from: { x: number; y: number };
  to: { x: number; y: number };
};

export type Paint = SolidPaint | GradientPaint;

export type Stroke = {
  paint: Paint;
  weight: number; // px
  cap?: "none" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  align?: "center" | "inside" | "outside";
  dashPattern?: number[];
};

/** A single closed/open contour, ready for direct bezier reconstruction. */
export type SubPath = {
  closed: boolean;
  /** [x, y] vertices in the layer's local, Y-down space. */
  vertices: Array<[number, number]>;
  /** [dx, dy] in-tangent handles, relative to the matching vertex. */
  inTangents: Array<[number, number]>;
  /** [dx, dy] out-tangent handles, relative to the matching vertex. */
  outTangents: Array<[number, number]>;
};

/**
 * A clipping mask applied to a layer. Every layer clipped by the same source
 * mask carries a copy with the same `id`, so a host can rebuild one clipping
 * group (Illustrator, Photoshop) or one mask per layer (After Effects).
 */
export type ClipPath = {
  /** Shared by every layer clipped by the same source mask. */
  id: string;
  /** Name of the source mask object, as the user sees it. */
  name?: string;
  /**
   * Clip contours in FRAME space: the same space as `frame.x` / `frame.y`
   * (selection-normalised document space), NOT the layer's local space.
   */
  subpaths: SubPath[];
  windingRule?: "nonzero" | "evenodd";
};

export type BaseLayer = {
  id: string;
  name: string;
  frame: Frame;
  visible?: boolean;
  blendMode?: string;
  /** Visible only inside this path. Nested masks keep the innermost one. */
  clip?: ClipPath;
};

/**
 * An axis-aligned parametric shape, in the layer's local space (the same
 * space as `subpaths`). Hosts that have live primitives (After Effects) rebuild
 * it natively; everything else keeps using `subpaths`, which always describe
 * the same outline.
 */
export type Primitive =
  | { kind: "rect"; x: number; y: number; width: number; height: number; roundness?: number }
  | { kind: "ellipse"; x: number; y: number; width: number; height: number };

export type VectorLayer = BaseLayer & {
  type: "vector";
  subpaths: SubPath[];
  fills: Paint[];
  strokes: Stroke[];
  /** SVG "nonzero" | "evenodd" winding for fills. */
  windingRule?: "nonzero" | "evenodd";
  /** Set only when the outline is exactly this primitive. */
  primitive?: Primitive;
};

export type TextLayer = BaseLayer & {
  type: "text";
  characters: string;
  fontFamily: string;
  fontStyle: string; // e.g. "Regular", "Bold", "Bold Italic"
  fontSize: number; // px
  color: RGBA;
  letterSpacing?: number; // px
  lineHeight?: number; // px (0 / undefined = auto)
  textAlignHorizontal?: "left" | "center" | "right" | "justified";
  textAlignVertical?: "top" | "center" | "bottom";
  textCase?: "original" | "upper" | "lower" | "title";
  decoration?: "none" | "underline" | "strikethrough";
  /**
   * Y of the first baseline in the same space as `frame.y`. Sources that know
   * the true baseline (Illustrator) set it; hosts that receive it place text
   * exactly instead of approximating from the font size.
   */
  baseline?: number;
  /**
   * X of the text anchor in the same space as `frame.x` — the alignment point,
   * not the left edge of the glyphs. Set alongside `baseline`.
   */
  anchorX?: number;
};

export type ImageLayer = BaseLayer & {
  type: "image";
  /**
   * Base64-encoded PNG data (no data: prefix). Used when the source has bytes
   * but no file on disk — e.g. Figma. Exactly one of `pngBase64` / `filePath`
   * is set by the producer; the receiving panel materialises base64 to a file
   * and fills in `filePath` before the host builder runs.
   */
  pngBase64?: string;
  /** Absolute path to an image file on this machine. */
  filePath?: string;
  /**
   * True when `filePath` is the user's own linked asset rather than something
   * LazyLord generated. Never move, rewrite or clean up an original.
   */
  isOriginalFile?: boolean;
  /** Pixel dimensions of the encoded image (may exceed frame for @2x). */
  pixelWidth: number;
  pixelHeight: number;
};

/**
 * A source group (Illustrator group, Figma frame/group, AE parent null or
 * multi-group shape layer). Purely structural:
 *  - `frame` is the union box of its descendants, in frame space; rotation 0.
 *  - children keep their own frames in the SAME frame space as everything
 *    else — never relative to the group — so flattening a group is free.
 *  - `frame.opacity` is the group's own opacity, on top of its children's.
 *  - children are listed bottom-to-top, like `Document.layers`.
 * Targets that do not rebuild hierarchy flatten groups to their leaves.
 */
export type GroupLayer = BaseLayer & {
  type: "group";
  children: Layer[];
};

export type Layer = VectorLayer | TextLayer | ImageLayer | GroupLayer;

/** Which application produced an IR document. */
export type SourceApp = "figma" | "illustrator" | "photoshop" | "aftereffects";

/**
 * One thing the conversion could not do natively. Collected during
 * serialisation and during host rebuild, and reported back to the user.
 */
export type Diagnostic = {
  /** Name of the offending object, as the user sees it in the source app. */
  object: string;
  /** What happened, in plain language. */
  reason: string;
  /** How the pipeline coped: the step of the fallback ladder that ran. */
  resolution: "approximated" | "rasterized" | "skipped";
};

export type Document = {
  version: typeof IR_VERSION;
  source: SourceApp;
  /** Document / page name for reference. */
  name: string;
  /** Bounding box of the whole selection on the source canvas. */
  bounds: { x: number; y: number; width: number; height: number };
  layers: Layer[];
  /** Anything that could not be converted natively on the way out. */
  diagnostics?: Diagnostic[];
  /**
   * How a target should read `bounds.x` / `bounds.y`:
   *  - "document" — an offset inside the source document or artboard, so the
   *    target can place the artwork where it sat on the page (Illustrator).
   *  - "canvas" — a point on an unbounded canvas, meaningless to a target, so
   *    the artwork is placed at the target's own origin (Figma).
   * Layer frames are always normalised to the selection's top-left either way.
   */
  originSpace?: "document" | "canvas";
  /**
   * Size of the source page the selection sits on (Illustrator artboard, AE
   * composition, Figma top-level frame). A target that has to create a new
   * document/comp sizes it to this, so "document"-space artwork lands inside it.
   * Only meaningful with originSpace "document"; informational otherwise.
   */
  canvas?: { width: number; height: number; name?: string };
  /** How the sender asked the target to lay the transfer out. */
  options?: TransferOptions;
};

/**
 * Sender-chosen layout, carried on the document so the target's builder sees
 * it. Every field is optional; the defaults reproduce the pre-options output.
 */
export type TransferOptions = {
  /**
   * "split" (default): one target layer per vector.
   * "combine": all vectors merged into as few target layers as the host
   * allows (one After Effects shape layer, one vector group per source shape).
   * Text and images are never combined.
   */
  layout?: "split" | "combine";
  /**
   * "flatten" (default): groups dissolve into their leaves.
   * "groups": rebuild them — Illustrator groups, Photoshop layer sets, After
   * Effects null parents (or nested shape groups when combining).
   */
  hierarchy?: "flatten" | "groups";
  /**
   * "active" (default): build into the open document / composition, creating
   * one only when none is open.
   * "new": always build into a new document / composition, sized like any
   * created one (Document.canvas for "document"-space artwork, otherwise the
   * selection bounds) and named after the source page or the selection.
   */
  destination?: "active" | "new";
};

/** Resolved options with defaults applied. */
export function transferOptions(doc: Pick<Document, "options">): Required<TransferOptions> {
  const o = doc.options || {};
  return {
    layout: o.layout === "combine" ? "combine" : "split",
    hierarchy: o.hierarchy === "groups" ? "groups" : "flatten",
    destination: o.destination === "new" ? "new" : "active",
  };
}

export function emptyDocument(name = "Untitled", source: SourceApp = "figma"): Document {
  return {
    version: IR_VERSION,
    source,
    name,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    layers: [],
  };
}
