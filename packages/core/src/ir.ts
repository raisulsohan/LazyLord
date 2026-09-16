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
  /** How the layer composites with what is under it. */
  blendMode?: BlendMode;
  /**
   * Shadows and blurs, in the order the source applies them. Hosts rebuild
   * what they have a native equivalent for and report the rest.
   */
  effects?: Effect[];
  /** Visible only inside this path. Nested masks keep the innermost one. */
  clip?: ClipPath;
  /**
   * Visible only where the layer with this id has pixels: a Photoshop
   * clipping mask. That layer sits below this one in the same list and stays
   * visible itself; every layer clipped to it names the same id.
   */
  clipTo?: string;
  /** A greyscale image that hides part of the layer: a Photoshop layer mask. */
  mask?: ImageMask;
};

/**
 * A layer mask: white shows the layer, black hides it, grey lets it through
 * partly. The image covers `frame` (frame space, like the layer's own frame);
 * the layer has nothing to show beyond it.
 */
export type ImageMask = {
  frame: { x: number; y: number; width: number; height: number };
  /** Absolute path to the PNG on this machine. */
  filePath?: string;
  /** The PNG itself, for a host that cannot read files (Figma). */
  pngBase64?: string;
};

/**
 * The blend modes every host in the ecosystem shares, in one spelling. A mode
 * a source has and a target does not is reported rather than guessed at.
 */
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

/**
 * A shadow or blur, described by what every host agrees on. Anything richer
 * than this — a Photoshop bevel, an Illustrator live effect with its own
 * parameters — has no shared vocabulary, so it is reported instead.
 *
 * `radius` is the blur radius in px; `spread` grows the shadow before it is
 * blurred, and is left out by sources that have no such control.
 */
export type Effect =
  | { kind: "drop-shadow"; color: RGBA; offset: { x: number; y: number }; radius: number; spread?: number; blendMode?: BlendMode }
  | { kind: "inner-shadow"; color: RGBA; offset: { x: number; y: number }; radius: number; spread?: number; blendMode?: BlendMode }
  | { kind: "layer-blur"; radius: number }
  | { kind: "background-blur"; radius: number }
  // Photoshop's layer styles. A shadow or glow's `color` alpha is its opacity;
  // `spread` (and an inner glow's `choke`) is in px, like a shadow's.
  | { kind: "outer-glow"; color: RGBA; radius: number; spread?: number; blendMode?: BlendMode }
  | { kind: "inner-glow"; color: RGBA; radius: number; choke?: number; source?: "edge" | "center"; blendMode?: BlendMode }
  | { kind: "stroke"; color: RGBA; width: number; position: "outside" | "inside" | "center"; blendMode?: BlendMode }
  | { kind: "color-overlay"; color: RGBA; blendMode?: BlendMode }
  | {
      kind: "gradient-overlay";
      stops: GradientStop[];
      style: "linear" | "radial";
      /** Degrees, counter-clockwise from 3 o'clock, as Photoshop measures it. */
      angle: number;
      /** Percent, 100 reaching the layer's edge. */
      scale: number;
      reverse?: boolean;
      opacity: number;
      blendMode?: BlendMode;
    }
  | { kind: "satin"; color: RGBA; angle: number; distance: number; radius: number; invert?: boolean; blendMode?: BlendMode }
  | {
      kind: "bevel";
      style: "outer" | "inner" | "emboss" | "pillow" | "stroke";
      technique: "smooth" | "hard" | "soft";
      /** Percent. */
      depth: number;
      up: boolean;
      size: number;
      soften: number;
      angle: number;
      altitude: number;
      highlight: RGBA;
      shadow: RGBA;
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

/**
 * A stretch of a text layer's characters with its own style. `start` / `end`
 * are UTF-16 offsets into `characters` (end exclusive). Runs are in order and
 * never overlap; a field left unset — and any character no run covers — takes
 * the layer's own style. Line height, case and alignment stay per layer.
 */
export type TextRun = {
  start: number;
  end: number;
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number; // px
  color?: RGBA;
  letterSpacing?: number; // px
  decoration?: "none" | "underline" | "strikethrough";
};

export type TextLayer = BaseLayer & {
  type: "text";
  characters: string;
  /** Per-character styles, when the text mixes them; the fields below are the base style. */
  runs?: TextRun[];
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
   * How the font's own spacing between letter pairs is used: "metrics" (the
   * font's kerning table, every app's default), "optical" (Adobe's spacing
   * from the letter shapes) or "none". Unset means "metrics".
   */
  autoKern?: "metrics" | "optical" | "none";
  /**
   * Manual kerning, as Adobe apps keep it: the space between character
   * `index - 1` and character `index`, in thousandths of an em, used for
   * that pair instead of automatic kerning. Non-zero pairs only, in order.
   */
  kerns?: { index: number; amount: number }[];
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
  /**
   * The box of the page-like container the group came from (a Figma frame,
   * section, component or instance), in frame space, when it is upright. A
   * target that rebuilds groups as pages of their own (After Effects
   * precomps) sizes the page to this and measures the children from its
   * top-left, whatever they happen to cover.
   */
  page?: { x: number; y: number; width: number; height: number };
  /**
   * The group is a Figma component or an instance of one. Groups naming the
   * same `id` draw the same thing, give or take their overrides, so a target
   * that rebuilds pages (After Effects precomps) can build it once and share
   * it, carrying the differences as properties of each copy.
   */
  component?: { id: string; name: string };
};

/**
 * A Photoshop adjustment layer: it changes everything beneath it rather than
 * drawing anything of its own. `frame` is the canvas it covers; a layer mask
 * (`mask`) limits it, as in Photoshop. Values are Photoshop's own units.
 */
export type AdjustmentLayer = BaseLayer & {
  type: "adjustment";
  adjustment: Adjustment;
};

export type Adjustment =
  | { kind: "brightness-contrast"; brightness: number; contrast: number; legacy?: boolean }
  /** Master channel only; 0..255, gamma 0.1..9.99. */
  | { kind: "levels"; inputBlack: number; inputWhite: number; gamma: number; outputBlack: number; outputWhite: number }
  /** Master range. Hue in degrees, saturation and lightness -100..100 (colorize: hue 0..360, saturation 0..100). */
  | { kind: "hue-saturation"; hue: number; saturation: number; lightness: number; colorize?: boolean }
  | { kind: "exposure"; exposure: number; offset: number; gamma: number }
  | { kind: "vibrance"; vibrance: number; saturation: number }
  | { kind: "invert" }
  | { kind: "threshold"; level: number }
  | { kind: "posterize"; levels: number }
  | { kind: "black-white" }
  | { kind: "photo-filter"; color: RGBA; density: number; preserveLuminosity: boolean }
  /** Cyan-red, magenta-green, yellow-blue for each tonal range, -100..100. */
  | {
      kind: "color-balance";
      shadows: [number, number, number];
      midtones: [number, number, number];
      highlights: [number, number, number];
      preserveLuminosity: boolean;
    };

export type Layer = VectorLayer | TextLayer | ImageLayer | GroupLayer | AdjustmentLayer;

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
  /**
   * Stable identifier for the source *document*, so a layer id can be matched
   * back to the thing it came from. Layer ids are only unique within their own
   * document — a Figma node id, an Illustrator `uuid` and an After Effects
   * layer id all repeat across files — so a target that remembers where a layer
   * came from has to remember this too. Absent when the source cannot offer
   * one (an unsaved document); matching then falls back to the layer id alone.
   */
  sourceKey?: string;
  /** How the sender asked the target to lay the transfer out. */
  options?: TransferOptions;
  /** The source page's ruler guides; built only when options.guides is on. */
  guides?: Guide[];
  /** The source document's named colours; built only when options.swatches is on. */
  swatches?: Swatch[];
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
   * "precomps": After Effects makes every group with a `page` (a Figma frame)
   * a precomp of that size, nested frames nesting; other groups dissolve into
   * it. Every other target treats it as "groups".
   */
  hierarchy?: "flatten" | "groups" | "precomps";
  /**
   * "active" (default): build into the open document / composition, creating
   * one only when none is open.
   * "new": always build into a new document / composition, sized like any
   * created one (Document.canvas for "document"-space artwork, otherwise the
   * selection bounds) and named after the source page or the selection.
   */
  destination?: "active" | "new";
  /**
   * "add" (default): every transfer creates new layers.
   * "update": a layer the target already built from the same source object is
   * updated in place instead, keeping its position in the stack and anything
   * the user did to it that LazyLord does not own. Matching needs the layer
   * tags written by a previous transfer, so the first one always adds.
   */
  existing?: "add" | "update";
  /**
   * Only consulted while updating, and only by hosts with a timeline.
   * "auto" (default): a property that is already animated gets a new key at the
   * playhead; a static one is just set, so nothing becomes animated by surprise.
   * "always": every animatable property LazyLord updates is keyed at the
   * playhead, which is how you animate a shape by re-sending it.
   */
  keyframes?: "auto" | "always";
  /**
   * Only consulted while updating. A target remembers, in each layer's tag, a
   * fingerprint of what LazyLord last wrote to it; a layer whose fingerprint
   * no longer matches was edited in the target since. Either way it is reported.
   * "overwrite" (default): the update replaces those edits.
   * "keep": the layer is left as the user made it, and not updated.
   */
  conflict?: "overwrite" | "keep";
  /** Set on a Live update, one of many: the receiver keeps it out of its history. */
  live?: boolean;
  /** Rebuild the source page's ruler guides on the target (off by default). */
  guides?: boolean;
  /** Add the source's named colours to the target's swatches (off by default). */
  swatches?: boolean;
};

/** A ruler guide in frame space: `position` is an x for a vertical guide, a y for a horizontal one. */
export type Guide = { orientation: "horizontal" | "vertical"; position: number };

/** A named colour from the source's swatches (Illustrator) or colour styles (Figma). */
export type Swatch = { name: string; color: RGBA };

/** Resolved options with defaults applied. */
export function transferOptions(doc: Pick<Document, "options">): Required<TransferOptions> {
  const o = doc.options || {};
  return {
    layout: o.layout === "combine" ? "combine" : "split",
    hierarchy: o.hierarchy === "groups" || o.hierarchy === "precomps" ? o.hierarchy : "flatten",
    destination: o.destination === "new" ? "new" : "active",
    existing: o.existing === "update" ? "update" : "add",
    keyframes: o.keyframes === "always" ? "always" : "auto",
    conflict: o.conflict === "keep" ? "keep" : "overwrite",
    live: o.live === true,
    guides: o.guides === true,
    swatches: o.swatches === true,
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

/**
 * Host blend-mode names in one vocabulary. Figma and After Effects shout
 * ("MULTIPLY", "COLOR_DODGE"), Illustrator and Photoshop use their own
 * spellings, and Figma's "PASS_THROUGH" is a group idea with no leaf meaning —
 * all of it normalises to the IR's names, and anything unrecognised comes back
 * null so the caller can report it rather than guess.
 */
export function blendModeFrom(name: unknown): BlendMode | null {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  switch (key) {
    case "normal":
    case "pass-through":

      return "normal";
    case "multiply":
      return "multiply";
    case "screen":
      return "screen";
    case "overlay":
      return "overlay";
    case "darken":
      return "darken";
    case "lighten":
      return "lighten";
    case "color-dodge":
    case "colordodge":
      return "color-dodge";
    case "color-burn":
    case "colorburn":
      return "color-burn";
    case "hard-light":
    case "hardlight":
      return "hard-light";
    case "soft-light":
    case "softlight":
      return "soft-light";
    case "difference":
      return "difference";
    case "exclusion":
      return "exclusion";
    case "hue":
      return "hue";
    case "saturation":
      return "saturation";
    case "color":
      return "color";
    case "luminosity":
      return "luminosity";
    default:
      return null;
  }
}

/** The IR's name for a blend mode, as a label for a diagnostic. */
export function blendModeLabel(mode: BlendMode | string): string {
  return String(mode)
    .split("-")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}
