/**
 * Affine geometry shared by LazyLord producers.
 * ------------------------------------------
 * Pure maths, no host APIs: baking a node's transform into its contours,
 * normalising contours to a frame, remapping gradient handles into a new box,
 * recovering where a transformed box sits, framing and moving IR layer trees
 * (groups) and finding the top-level frame a selection sits on. Deliberately
 * free of value imports so it runs as-is under Node's type stripping
 * (tools/test-core.mjs).
 *
 * An `Affine` uses Figma's layout, [[a, c, e], [b, d, f]]:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 * Everything is y-down, so a positive angle turns clockwise on screen, which
 * is the IR's `Frame.rotation` convention.
 */

import type { GradientPaint, Layer, SubPath } from "./ir";

export type Affine = [[number, number, number], [number, number, number]];
export type Vec2 = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

const EPS = 1e-9;
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

export function identityAffine(): Affine {
  return [
    [1, 0, 0],
    [0, 1, 0],
  ];
}

/** Map a point through the full affine (linear part + translation). */
export function applyAffine(t: Affine, x: number, y: number): [number, number] {
  return [t[0][0] * x + t[0][1] * y + t[0][2], t[1][0] * x + t[1][1] * y + t[1][2]];
}

/** Map a direction (e.g. a relative bezier tangent): linear part only. */
export function applyAffineLinear(t: Affine, dx: number, dy: number): [number, number] {
  return [t[0][0] * dx + t[0][1] * dy, t[1][0] * dx + t[1][1] * dy];
}

/** `m` after `n`: the transform that applies `n` first, then `m`. */
export function multiplyAffine(m: Affine, n: Affine): Affine {
  const ma = m[0][0], mc = m[0][1], me = m[0][2], mb = m[1][0], md = m[1][1], mf = m[1][2];
  const na = n[0][0], nc = n[0][1], ne = n[0][2], nb = n[1][0], nd = n[1][1], nf = n[1][2];
  return [
    [ma * na + mc * nb, ma * nc + mc * nd, ma * ne + mc * nf + me],
    [mb * na + md * nb, mb * nc + md * nd, mb * ne + md * nf + mf],
  ];
}

export function affineDeterminant(t: Affine): number {
  return t[0][0] * t[1][1] - t[0][1] * t[1][0];
}

/** Inverse transform, or null when the transform collapses to a line/point. */
export function invertAffine(t: Affine): Affine | null {
  const a = t[0][0], c = t[0][1], e = t[0][2], b = t[1][0], d = t[1][1], f = t[1][2];
  const det = a * d - b * c;
  if (!(Math.abs(det) > 1e-12)) return null;
  const ia = d / det;
  const ic = -c / det;
  const ib = -b / det;
  const id = a / det;
  return [
    [ia, ic, -(ia * e + ic * f)],
    [ib, id, -(ib * e + id * f)],
  ];
}

/** No rotation or skew, and neither axis mirrored. */
export function isAxisAligned(t: Affine, eps = 1e-6): boolean {
  return Math.abs(t[1][0]) < eps && Math.abs(t[0][1]) < eps && t[0][0] > 0 && t[1][1] > 0;
}

/**
 * Rotation, mirroring and uniform scale only: both axes the same length and
 * at right angles. A circle stays a circle under such a transform.
 */
export function isSimilarity(t: Affine, eps = 1e-6): boolean {
  const a = t[0][0], c = t[0][1], b = t[1][0], d = t[1][1];
  const lx = a * a + b * b;
  const ly = c * c + d * d;
  const tol = eps * Math.max(1, lx, ly);
  return Math.abs(lx - ly) < tol && Math.abs(a * c + b * d) < tol;
}

/** Wrap an angle in degrees to (-180, 180], snapping float dust to 0. */
export function normaliseDegrees(deg: number): number {
  let r = deg % 360;
  if (r <= -180) r += 360;
  else if (r > 180) r -= 360;
  if (Math.abs(r) < 1e-9) r = 0;
  return r;
}

// ---------------------------------------------------------------------------
// Contours
// ---------------------------------------------------------------------------

/** Deep copy of a set of subpaths moved by (dx, dy). Tangents are relative, so they only get copied. */
export function offsetSubPaths(subpaths: SubPath[], dx: number, dy: number): SubPath[] {
  return subpaths.map((sp) => ({
    closed: sp.closed,
    vertices: sp.vertices.map((v) => [v[0] + dx, v[1] + dy] as [number, number]),
    inTangents: sp.inTangents.map((v) => [v[0], v[1]] as [number, number]),
    outTangents: sp.outTangents.map((v) => [v[0], v[1]] as [number, number]),
  }));
}

/** Deep copy, so no two layers ever share an array (hosts mutate in place). */
export function cloneSubPaths(subpaths: SubPath[]): SubPath[] {
  return offsetSubPaths(subpaths, 0, 0);
}

/**
 * Bake a transform into a set of subpaths: vertices go through the full
 * affine, relative tangents through its linear part only. Returns new arrays.
 */
export function transformSubPaths(subpaths: SubPath[], t: Affine): SubPath[] {
  return subpaths.map((sp) => ({
    closed: sp.closed,
    vertices: sp.vertices.map((v) => applyAffine(t, v[0], v[1])),
    inTangents: sp.inTangents.map((v) => applyAffineLinear(t, v ? v[0] : 0, v ? v[1] : 0)),
    outTangents: sp.outTangents.map((v) => applyAffineLinear(t, v ? v[0] : 0, v ? v[1] : 0)),
  }));
}

/** Make subpaths local to a frame: subtract the frame's top-left. */
export function normaliseSubPaths(subpaths: SubPath[], topLeft: Vec2): SubPath[] {
  return offsetSubPaths(subpaths, -topLeft.x, -topLeft.y);
}

/** Axis-aligned bounds of a list of [x, y] points, or null when there are none. */
export function boundsOfPoints(points: ReadonlyArray<readonly [number, number]>): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Bounds of the vertices only (tangent handles ignored). */
export function vertexBounds(subpaths: SubPath[]): Box | null {
  const pts: Array<[number, number]> = [];
  for (const sp of subpaths) for (const v of sp.vertices) pts.push(v);
  return boundsOfPoints(pts);
}

/** Parameters in (0, 1) where one axis of a cubic bezier turns around. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t) / 3 = a t^2 + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const out: number[] = [];
  const keep = (t: number) => {
    if (t > EPS && t < 1 - EPS) out.push(t);
  };
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) keep(-c / b);
    return out;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return out;
  const sq = Math.sqrt(disc);
  keep((-b + sq) / (2 * a));
  keep((-b - sq) / (2 * a));
  return out;
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * Tight bounds of the drawn outline: vertices plus every point where a curve
 * segment bulges past them. A rotated circle gets its true box, not the box
 * of its four anchors.
 */
export function curveBounds(subpaths: SubPath[]): Box | null {
  const pts: Array<[number, number]> = [];
  for (const sp of subpaths) {
    const n = sp.vertices.length;
    for (let i = 0; i < n; i++) {
      pts.push(sp.vertices[i]);
      if (i === n - 1 && !sp.closed) break;
      const j = (i + 1) % n;
      if (j === i) break;
      const v0 = sp.vertices[i];
      const v3 = sp.vertices[j];
      const o = sp.outTangents[i] || [0, 0];
      const inT = sp.inTangents[j] || [0, 0];
      const p1: [number, number] = [v0[0] + o[0], v0[1] + o[1]];
      const p2: [number, number] = [v3[0] + inT[0], v3[1] + inT[1]];
      for (let axis = 0; axis < 2; axis++) {
        for (const t of cubicExtrema(v0[axis], p1[axis], p2[axis], v3[axis])) {
          pts.push([
            cubicAt(v0[0], p1[0], p2[0], v3[0], t),
            cubicAt(v0[1], p1[1], p2[1], v3[1], t),
          ]);
        }
      }
    }
  }
  return boundsOfPoints(pts);
}

/**
 * Bake node-local contours into a frame: transform to absolute space, move
 * into frame space (subtract `origin`, the selection's top-left), take the
 * frame from the outline's tight bounds and make the contours local to it.
 */
export function bakeSubPaths(
  local: SubPath[],
  t: Affine,
  origin: Vec2 = { x: 0, y: 0 }
): { subpaths: SubPath[]; frame: Box } | null {
  const abs = transformSubPaths(local, t);
  const framed = offsetSubPaths(abs, -origin.x, -origin.y);
  const box = curveBounds(framed);
  if (!box) return null;
  return { subpaths: normaliseSubPaths(framed, box), frame: box };
}

/**
 * The box described by one closed, straight-edged, axis-aligned rectangle,
 * or null for anything else (rounded corners, rotation, several contours).
 */
export function rectOfSubPaths(subpaths: SubPath[], eps = 1e-6): Box | null {
  if (subpaths.length !== 1) return null;
  const sp = subpaths[0];
  if (!sp.closed || sp.vertices.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const it = sp.inTangents[i] || [0, 0];
    const ot = sp.outTangents[i] || [0, 0];
    if (Math.abs(it[0]) > eps || Math.abs(it[1]) > eps || Math.abs(ot[0]) > eps || Math.abs(ot[1]) > eps) {
      return null;
    }
  }
  const box = vertexBounds(subpaths);
  if (!box || box.width < eps || box.height < eps) return null;
  const x1 = box.x + box.width;
  const y1 = box.y + box.height;
  const seen: Record<string, boolean> = {};
  for (let i = 0; i < 4; i++) {
    const v = sp.vertices[i];
    const onL = Math.abs(v[0] - box.x) < eps;
    const onR = Math.abs(v[0] - x1) < eps;
    const onT = Math.abs(v[1] - box.y) < eps;
    const onB = Math.abs(v[1] - y1) < eps;
    if (!(onL || onR) || !(onT || onB)) return null;
    seen[(onL ? "L" : "R") + (onT ? "T" : "B")] = true;
    // Every edge must run along an axis, which rules out a crossed "bow tie".
    const w = sp.vertices[(i + 1) % 4];
    if (Math.abs(v[0] - w[0]) > eps && Math.abs(v[1] - w[1]) > eps) return null;
  }
  if (!(seen.LT && seen.RT && seen.LB && seen.RB)) return null;
  return box;
}

/** A closed rectangle contour, clockwise on screen from the top-left. */
export function rectToSubPaths(box: Box): SubPath[] {
  const x0 = box.x, y0 = box.y, x1 = box.x + box.width, y1 = box.y + box.height;
  return [
    {
      closed: true,
      vertices: [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ],
      inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
      outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
    },
  ];
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

/** Overlap of two boxes; width/height are 0 when they do not overlap. */
export function intersectBoxes(a: Box, b: Box): Box {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

export function unionBoxes(a: Box | null, b: Box | null): Box | null {
  if (!a) return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
  if (!b) return { x: a.x, y: a.y, width: a.width, height: a.height };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Axis-aligned bounds of a frame after its clockwise rotation about its
 * centre (the IR's Frame convention).
 */
export function rotatedBoxBounds(frame: { x: number; y: number; width: number; height: number; rotation?: number }): Box {
  const deg = frame.rotation || 0;
  if (!deg) return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
  const r = deg / DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const pts: Array<[number, number]> = [];
  for (const [dx, dy] of [
    [-frame.width / 2, -frame.height / 2],
    [frame.width / 2, -frame.height / 2],
    [frame.width / 2, frame.height / 2],
    [-frame.width / 2, frame.height / 2],
  ]) {
    pts.push([cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);
  }
  return boundsOfPoints(pts) as Box;
}

/**
 * Where a node's own (unrotated) width x height box ends up under a
 * transform: its centre, its size along each transformed axis, and its
 * clockwise rotation in degrees.
 *
 * rotation = atan2(b, a). When the transform mirrors (negative determinant)
 * no rotation alone can reproduce it; the angle is then taken from the y axis
 * instead, atan2(-c, d), which keeps the box's "up" pointing the same way and
 * drops only the left/right mirror — the least surprising result for text.
 */
export function placeBox(
  width: number,
  height: number,
  t: Affine
): { centre: Vec2; width: number; height: number; rotation: number; flipped: boolean } {
  const a = t[0][0], c = t[0][1], b = t[1][0], d = t[1][1];
  const [cx, cy] = applyAffine(t, width / 2, height / 2);
  const flipped = a * d - b * c < 0;
  const rotation = normaliseDegrees((flipped ? Math.atan2(-c, d) : Math.atan2(b, a)) * DEG);
  return {
    centre: { x: cx, y: cy },
    width: width * Math.sqrt(a * a + b * b),
    height: height * Math.sqrt(c * c + d * d),
    rotation,
    flipped,
  };
}

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

/**
 * Handle positions of a Figma-style gradient, normalised to the node's own
 * box (0..1, node-local, unrotated). `gradientTransform` maps that box INTO
 * gradient space, where a linear gradient runs (0, 0.5) -> (1, 0.5) and a
 * radial one is centred on (0.5, 0.5) with radius 0.5; the handles are those
 * points mapped back through the inverse. `edge` is the radial's second
 * radius handle, (0.5, 1), used to spot an elliptical gradient.
 */
export function gradientHandlesFromTransform(
  gradientTransform: Affine | null | undefined,
  kind: "linear" | "radial"
): { from: Vec2; to: Vec2; edge: Vec2 } {
  const inv = gradientTransform ? invertAffine(gradientTransform) : identityAffine();
  const m = inv || identityAffine();
  const at = (x: number, y: number): Vec2 => {
    const p = applyAffine(m, x, y);
    return { x: p[0], y: p[1] };
  };
  if (kind === "radial") return { from: at(0.5, 0.5), to: at(1, 0.5), edge: at(0.5, 1) };
  return { from: at(0, 0.5), to: at(1, 0.5), edge: at(0, 1) };
}

/**
 * An absolute point carried into a frame: frame space (minus `origin`) ->
 * local to `frame` -> divided by the frame's size. A frame with no extent on
 * an axis maps that axis to 0.
 */
export function pointToFrameUnits(p: Vec2, frame: Box, origin: Vec2 = { x: 0, y: 0 }): Vec2 {
  const lx = p.x - origin.x - frame.x;
  const ly = p.y - origin.y - frame.y;
  return {
    x: frame.width > EPS ? lx / frame.width : 0,
    y: frame.height > EPS ? ly / frame.height : 0,
  };
}

/**
 * One gradient handle carried from a node's box into a new frame:
 * node-normalised -> node px -> absolute (via `t`) -> frame units
 * (pointToFrameUnits). Exact for a radial centre or any single point; a
 * linear gradient's pair of handles needs linearHandlesPx instead.
 */
export function remapHandle(
  h: Vec2,
  nodeWidth: number,
  nodeHeight: number,
  t: Affine,
  frame: Box,
  origin: Vec2 = { x: 0, y: 0 }
): Vec2 {
  const [ax, ay] = applyAffine(t, h.x * nodeWidth, h.y * nodeHeight);
  return pointToFrameUnits({ x: ax, y: ay }, frame, origin);
}

/**
 * A Figma linear gradient as the IR's two handles, in `t`'s output space
 * (absolute px).
 *
 * Figma evaluates a linear gradient in the node's normalised 0..1 box: the
 * value at a point is the x of that point mapped through `gradientTransform`,
 * so its bands run along the width handle in THAT space. The IR draws bands
 * perpendicular to from -> to in px, and once the box is stretched to
 * width x height and carried through `t` (any non-square node, or uneven
 * scale or skew) the mapped handle line no longer is. So the handles are
 * rebuilt from the value itself:
 *   M    = t * diag(w, h) * inverse(gradientTransform), gradient space -> px;
 *   from = M(0, 0.5), where the value is 0 (Figma's start handle);
 *   n    = L^-T (1, 0), with L the linear part of M: the value's gradient in
 *          px, i.e. the band normal, |n| = 1 / the gradient's length;
 *   to   = from + n / |n|^2, the nearest point where the value is 1.
 * When the mapped handle line is already perpendicular to the bands (a square
 * node under a similarity, with Figma's default width handle) `to` is Figma's
 * own end handle. When L collapses (a zero-height line) no band direction
 * exists, and the two handles are simply mapped as points.
 */
export function linearHandlesPx(
  gradientTransform: Affine | null | undefined,
  nodeWidth: number,
  nodeHeight: number,
  t: Affine
): { from: Vec2; to: Vec2 } {
  const inv = (gradientTransform ? invertAffine(gradientTransform) : null) || identityAffine();
  const scale: Affine = [
    [nodeWidth, 0, 0],
    [0, nodeHeight, 0],
  ];
  const m = multiplyAffine(t, multiplyAffine(scale, inv));
  const at = (x: number, y: number): Vec2 => {
    const p = applyAffine(m, x, y);
    return { x: p[0], y: p[1] };
  };
  const from = at(0, 0.5);
  const a = m[0][0], c = m[0][1], b = m[1][0], d = m[1][1];
  const det = a * d - b * c;
  // Relative to the size of L, so a tiny node is not mistaken for a flat one.
  const size = Math.max(a * a + b * b, c * c + d * d);
  if (!(Math.abs(det) > 1e-9 * size) || !(size > 0)) return { from, to: at(1, 0.5) };
  // First row of L^-1, i.e. L^-T (1, 0).
  const nx = d / det;
  const ny = -c / det;
  const nn = nx * nx + ny * ny;
  return { from, to: { x: from.x + nx / nn, y: from.y + ny / nn } };
}

/**
 * A copy of an IR gradient paint with both handles remapped into `frame`,
 * each carried as a point (remapHandle). Exact for a radial gradient, and for
 * a linear one while `t` keeps right angles (a similarity); under uneven scale
 * or skew a linear gradient's bands tilt, as described at linearHandlesPx.
 */
export function remapGradientHandles(
  paint: GradientPaint,
  nodeWidth: number,
  nodeHeight: number,
  t: Affine,
  frame: Box,
  origin: Vec2 = { x: 0, y: 0 }
): GradientPaint {
  return {
    type: paint.type,
    stops: paint.stops.map((s) => ({ position: s.position, color: { ...s.color } })),
    from: remapHandle(paint.from, nodeWidth, nodeHeight, t, frame, origin),
    to: remapHandle(paint.to, nodeWidth, nodeHeight, t, frame, origin),
  };
}

// ---------------------------------------------------------------------------
// Layer trees
// ---------------------------------------------------------------------------
// An IR group's children keep their frames in the same frame space as every
// other layer (never relative to the group), so framing, measuring and moving
// a tree never has to compose offsets.

/**
 * What a layer shows, in frame space: its box (rotated, for text and images)
 * cut to the bounds of its clip, or null when it lies wholly outside its clip
 * and so shows nothing. A box that only touches its clip still counts. A
 * group shows the union of what its children show, null when none does.
 */
export function layerExtent(layer: Layer): Box | null {
  if (layer.type === "group") {
    let u: Box | null = null;
    for (const child of layer.children) u = unionBoxes(u, layerExtent(child));
    return u;
  }
  const ext = rotatedBoxBounds(layer.frame);
  const cb = layer.clip ? curveBounds(layer.clip.subpaths) : null;
  if (!cb) return ext;
  if (cb.x > ext.x + ext.width || ext.x > cb.x + cb.width || cb.y > ext.y + ext.height || ext.y > cb.y + cb.height) {
    return null;
  }
  return intersectBoxes(ext, cb);
}

/**
 * The frame box of an IR group holding `children`: the union of what they
 * show (layerExtent). When every one of them is clipped away it is the union
 * of their boxes instead (a nested group's own frame, a leaf's rotated box),
 * so a group with children always has somewhere to be. A zero box at the
 * origin when there are no children at all.
 */
export function groupBox(children: ReadonlyArray<Layer>): Box {
  let box: Box | null = null;
  for (const child of children) box = unionBoxes(box, layerExtent(child));
  if (!box) {
    for (const child of children) box = unionBoxes(box, child.type === "group" ? child.frame : rotatedBoxBounds(child.frame));
  }
  return box || { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * Move a layer tree by (dx, dy), in place: every frame, groups' and their
 * children's alike, and every clip, whose contours are replaced by moved
 * copies (clips are in frame space too).
 */
export function moveLayers(layers: Layer[], dx: number, dy: number): void {
  for (const layer of layers) {
    layer.frame.x += dx;
    layer.frame.y += dy;
    if (layer.clip) layer.clip.subpaths = offsetSubPaths(layer.clip.subpaths, dx, dy);
    if (layer.type === "group") moveLayers(layer.children, dx, dy);
  }
}

/** Leaf layers in a tree, groups themselves not counted (as LazyLord.countLeaves). */
export function countLeaves(layers: ReadonlyArray<Layer> | null | undefined): number {
  let n = 0;
  for (const layer of layers || []) n += layer.type === "group" ? countLeaves(layer.children) : 1;
  return n;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** What the placement decision needs to know about a scene node. */
export type ScenePathNode = { id: string; type: string };

/** Figma containers that can be the page a selection sits on. */
const ARTBOARD_TYPES = ["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION"];

/**
 * A node's artboard — the top-level frame, component, component set or
 * section it sits on — as an index into `path`, the node's ancestors-or-self
 * outermost first (path[0] is a direct child of the page, the last entry the
 * node itself). Sections only organise a page: a frame-like node directly
 * inside a section is the artboard in its place (nested sections likewise).
 * -1 when there is none: a loose layer, or a group on the page.
 */
export function artboardIndex(path: ReadonlyArray<ScenePathNode>): number {
  if (!path.length || ARTBOARD_TYPES.indexOf(path[0].type) < 0) return -1;
  let i = 0;
  while (path[i].type === "SECTION" && i + 1 < path.length && ARTBOARD_TYPES.indexOf(path[i + 1].type) >= 0) i++;
  return i;
}

/**
 * The one artboard every selected node sits on, or null when they span
 * several or some sit on none. `inside` is false when a selected node is the
 * artboard itself: the selection then has no position within a page to keep.
 */
export function sharedArtboard<N extends ScenePathNode>(
  paths: ReadonlyArray<ReadonlyArray<N>>
): { node: N; inside: boolean } | null {
  let node: N | null = null;
  let inside = true;
  for (const path of paths) {
    const i = artboardIndex(path);
    if (i < 0) return null;
    if (node && path[i].id !== node.id) return null;
    node = path[i];
    if (i === path.length - 1) inside = false;
  }
  return node ? { node, inside } : null;
}
