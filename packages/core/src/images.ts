/**
 * Image size limits
 * -----------------
 * A rasterised layer is exported at the Image scale asked for. A layer the
 * size of a large canvas at 2x is a hundred-megapixel picture: the host
 * renders and encodes it, the receiving app embeds it, and a stack of them
 * stalls both apps and the machine. So one export is held under
 * IMAGE_MAX_PIXELS and IMAGE_MAX_SIDE by lowering its scale (below 1x when it
 * must, down to IMAGE_MIN_SCALE), and the generated images of one transfer
 * together under TRANSFER_MAX_PIXELS, after which the rest are left out. The
 * layer still sits at its full size on the page; only its resolution drops.
 * Every change is reported.
 *
 * The Adobe readers apply the same limits with the same numbers, in
 * packages/adobe-cep/jsx/lazylord.jsx (ExtendScript cannot import this).
 */

export const IMAGE_MAX_PIXELS = 30000000;
export const IMAGE_MAX_SIDE = 12000;
export const IMAGE_MIN_SCALE = 0.25;
export const TRANSFER_MAX_PIXELS = 300000000;

/** What one transfer may still spend on generated images, in pixels. */
export type ImageBudget = { left: number };

export function imageBudget(): ImageBudget {
  return { left: TRANSFER_MAX_PIXELS };
}

export type ImageScale = {
  /** The scale to export at; 0 when `skip`. */
  scale: number;
  /** The scale that was asked for. */
  asked: number;
  /** Whether `scale` is below `asked`. */
  clamped: boolean;
  /** The budget cannot take it even at IMAGE_MIN_SCALE: leave it out. */
  skip: boolean;
  /** What held the scale down: "side", "pixels", "budget" or "". */
  why: "side" | "pixels" | "budget" | "";
};

/**
 * The scale to export `count` images of `width` x `height` px at, when
 * `scale` was asked for. `budget` is charged what the export costs; with too
 * little left even at the smallest scale, `skip` is true and nothing is
 * charged.
 */
export function imageScale(width: number, height: number, scale: number, budget?: ImageBudget, count = 1): ImageScale {
  const w = Math.max(1, width || 0);
  const h = Math.max(1, height || 0);
  const n = Math.max(1, count || 1);
  const asked = scale > 0 ? scale : 1;
  let s = asked;
  let why: ImageScale["why"] = "";
  const side = IMAGE_MAX_SIDE / Math.max(w, h);
  if (side < s) { s = side; why = "side"; }
  const each = Math.sqrt(IMAGE_MAX_PIXELS / (w * h));
  if (each < s) { s = each; why = "pixels"; }
  const left = budget && typeof budget.left === "number" ? budget.left : TRANSFER_MAX_PIXELS;
  const least = w * h * n * IMAGE_MIN_SCALE * IMAGE_MIN_SCALE;
  if (left < least) return { scale: 0, asked, clamped: true, skip: true, why: "budget" };
  const all = Math.sqrt(left / (w * h * n));
  if (all < s) { s = all; why = "budget"; }
  if (s < IMAGE_MIN_SCALE) s = IMAGE_MIN_SCALE;
  // Two decimals keep the note readable; the pixel size follows the rounded scale.
  s = Math.floor(s * 100 + 1e-9) / 100;
  if (s >= asked) { s = asked; why = ""; }
  if (budget) budget.left = left - w * h * n * s * s;
  return { scale: s, asked, clamped: s < asked, skip: false, why };
}

/**
 * What to report for an export imageScale held down: `fit` is its result,
 * `what` the opening words ("Exported" by default). Ends without a full stop.
 */
export function imageScaleNote(fit: ImageScale, width: number, height: number, what = "Exported"): string {
  const mp = (px: number) => `${Math.round(px / 100000) / 10} MP`;
  const w = Math.max(1, width || 0);
  const h = Math.max(1, height || 0);
  if (fit.skip) {
    return `this transfer already carries ${mp(TRANSFER_MAX_PIXELS)} of generated images, as much as the apps take at once; ` +
      "send fewer layers, or send this one on its own";
  }
  const held = fit.why === "budget"
    ? `this transfer's generated images are kept under ${mp(TRANSFER_MAX_PIXELS)} together; send fewer layers at once for full resolution`
    : `LazyLord keeps one image under ${mp(IMAGE_MAX_PIXELS)} (${IMAGE_MAX_SIDE} px a side) so the apps stay responsive`;
  return `${what} at ${fit.scale}x rather than ${fit.asked}x: at ${fit.asked}x it would be ` +
    `${Math.round(w * fit.asked)} x ${Math.round(h * fit.asked)} px (${mp(w * h * fit.asked * fit.asked)}), and ${held}`;
}
