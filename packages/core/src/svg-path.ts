/**
 * SVG path -> bezier contour converter.
 * -------------------------------------
 * Parses an SVG path `d` string into LazyLord SubPaths. Every command is
 * normalised to cubic beziers (lines, quadratics and elliptical arcs
 * included) so that every host can rebuild the geometry with a single,
 * uniform "vertex + in/out tangent" model.
 *
 * This is deliberately dependency-free and ES2019-safe so it can be bundled
 * into the Figma UI iframe and reused by the Node bridge/tooling.
 */

import type { SubPath } from "./ir";

type Pt = { x: number; y: number };

/** Internal working vertex: position + absolute control handles. */
type WorkVertex = {
  p: Pt;
  cin: Pt | null; // absolute in-control point
  cout: Pt | null; // absolute out-control point
};

type WorkPath = {
  closed: boolean;
  verts: WorkVertex[];
};

const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === ",";
const isCmd = (c: string) => "MmLlHhVvCcSsQqTtAaZz".indexOf(c) >= 0;
const isDigitLike = (c: string) => (c >= "0" && c <= "9") || c === "." || c === "+" || c === "-";

/** Cursor-based scanner that reads numbers and flags from a `d` string. */
class Scanner {
  private i = 0;
  constructor(private readonly s: string) {}

  eof(): boolean {
    this.skipWs();
    return this.i >= this.s.length;
  }

  private skipWs() {
    while (this.i < this.s.length && isWs(this.s[this.i])) this.i++;
  }

  peekCmd(): string | null {
    this.skipWs();
    if (this.i < this.s.length && isCmd(this.s[this.i])) return this.s[this.i];
    return null;
  }

  readCmd(): string | null {
    this.skipWs();
    if (this.i < this.s.length && isCmd(this.s[this.i])) return this.s[this.i++];
    return null;
  }

  /** True if another number can be read before the next command. */
  hasNumber(): boolean {
    this.skipWs();
    return this.i < this.s.length && isDigitLike(this.s[this.i]);
  }

  readNumber(): number {
    this.skipWs();
    const start = this.i;
    const s = this.s;
    if (s[this.i] === "+" || s[this.i] === "-") this.i++;
    while (this.i < s.length && s[this.i] >= "0" && s[this.i] <= "9") this.i++;
    if (s[this.i] === ".") {
      this.i++;
      while (this.i < s.length && s[this.i] >= "0" && s[this.i] <= "9") this.i++;
    }
    if (s[this.i] === "e" || s[this.i] === "E") {
      this.i++;
      if (s[this.i] === "+" || s[this.i] === "-") this.i++;
      while (this.i < s.length && s[this.i] >= "0" && s[this.i] <= "9") this.i++;
    }
    const n = parseFloat(s.slice(start, this.i));
    if (Number.isNaN(n)) throw new Error(`Invalid number in path at index ${start}`);
    return n;
  }

  /** Arc flags may be packed ("00" == two flags), so read exactly one digit. */
  readFlag(): number {
    this.skipWs();
    const c = this.s[this.i];
    if (c === "0") {
      this.i++;
      return 0;
    }
    if (c === "1") {
      this.i++;
      return 1;
    }
    // Be lenient: fall back to a full number.
    return this.readNumber() ? 1 : 0;
  }
}

function reflect(anchor: Pt, control: Pt | null): Pt {
  if (!control) return { x: anchor.x, y: anchor.y };
  return { x: 2 * anchor.x - control.x, y: 2 * anchor.y - control.y };
}

/**
 * Convert an elliptical arc to a list of cubic bezier segments.
 * Returns segments as [c1, c2, end] absolute control/end points.
 * Based on the SVG 1.1 implementation notes (endpoint -> center).
 */
function arcToCubics(
  x0: number,
  y0: number,
  rx: number,
  ry: number,
  xAxisRotDeg: number,
  largeArc: number,
  sweep: number,
  x: number,
  y: number
): Array<[Pt, Pt, Pt]> {
  if (rx === 0 || ry === 0) {
    // Degenerate: straight line.
    return [[{ x: x0, y: y0 }, { x, y }, { x, y }]];
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = ((xAxisRotDeg % 360) * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Correct out-of-range radii.
  let rxSq = rx * rx;
  let rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;
  const lambda = x1pSq / rxSq + y1pSq / rySq;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rxSq = rx * rx;
    rySq = ry * ry;
  }

  let num = rxSq * rySq - rxSq * y1pSq - rySq * x1pSq;
  const den = rxSq * y1pSq + rySq * x1pSq;
  if (num < 0) num = 0;
  let coef = Math.sqrt(num / den);
  if (largeArc === sweep) coef = -coef;

  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const segCount = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segCount;
  const t = ((4 / 3) * Math.tan(delta / 4));

  const out: Array<[Pt, Pt, Pt]> = [];
  let theta = theta1;
  let px = x0;
  let py = y0;

  for (let s = 0; s < segCount; s++) {
    const theta2 = theta + delta;
    const cos1 = Math.cos(theta);
    const sin1 = Math.sin(theta);
    const cos2 = Math.cos(theta2);
    const sin2 = Math.sin(theta2);

    // End point of this segment.
    const ex = cosPhi * rx * cos2 - sinPhi * ry * sin2 + cx;
    const ey = sinPhi * rx * cos2 + cosPhi * ry * sin2 + cy;

    // Derivatives for control points.
    const dx1 = -rx * sin1;
    const dy1 = ry * cos1;
    const dx2b = -rx * sin2;
    const dy2b = ry * cos2;

    const c1: Pt = {
      x: px + t * (cosPhi * dx1 - sinPhi * dy1),
      y: py + t * (sinPhi * dx1 + cosPhi * dy1),
    };
    const c2: Pt = {
      x: ex - t * (cosPhi * dx2b - sinPhi * dy2b),
      y: ey - t * (sinPhi * dx2b + cosPhi * dy2b),
    };

    out.push([c1, c2, { x: ex, y: ey }]);
    theta = theta2;
    px = ex;
    py = ey;
  }
  return out;
}

/**
 * Parse an SVG path string into LazyLord SubPaths (bezier form).
 */
export function parseSvgPath(d: string): SubPath[] {
  if (!d || !d.trim()) return [];
  const sc = new Scanner(d);

  const paths: WorkPath[] = [];
  let cur: WorkPath | null = null;

  let cx = 0;
  let cy = 0; // current point
  let sx = 0;
  let sy = 0; // subpath start
  let lastCmd = "";
  let lastCtrl: Pt | null = null; // absolute second control point of previous C/S (for S) or Q/T control (for T)

  const startSub = (x: number, y: number) => {
    cur = { closed: false, verts: [{ p: { x, y }, cin: null, cout: null }] };
    paths.push(cur);
    sx = x;
    sy = y;
  };

  const lineTo = (x: number, y: number) => {
    if (!cur) startSub(cx, cy);
    // Straight line: no tangents on either side.
    cur!.verts.push({ p: { x, y }, cin: null, cout: null });
  };

  const cubicTo = (c1: Pt, c2: Pt, end: Pt) => {
    if (!cur) startSub(cx, cy);
    const verts = cur!.verts;
    verts[verts.length - 1].cout = c1;
    verts.push({ p: { x: end.x, y: end.y }, cin: c2, cout: null });
  };

  const closeSub = () => {
    if (!cur) return;
    cur.closed = true;
    // Merge a trailing vertex that lands back on the start.
    const verts = cur.verts;
    if (verts.length > 1) {
      const first = verts[0];
      const last = verts[verts.length - 1];
      if (Math.abs(last.p.x - first.p.x) < 1e-6 && Math.abs(last.p.y - first.p.y) < 1e-6) {
        first.cin = last.cin;
        verts.pop();
      }
    }
    cx = sx;
    cy = sy;
  };

  while (!sc.eof()) {
    let cmd = sc.peekCmd();
    if (cmd) {
      sc.readCmd();
    } else {
      // Implicit repeat of the previous command (M becomes L, m becomes l).
      if (!lastCmd) throw new Error("Path must begin with a moveto command");
      cmd = lastCmd === "M" ? "L" : lastCmd === "m" ? "l" : lastCmd;
    }

    const rel = cmd >= "a" && cmd <= "z";
    const C = cmd.toUpperCase();

    switch (C) {
      case "M": {
        const x = sc.readNumber() + (rel ? cx : 0);
        const y = sc.readNumber() + (rel ? cy : 0);
        startSub(x, y);
        cx = x;
        cy = y;
        // Subsequent pairs are implicit line-to.
        while (sc.hasNumber()) {
          const lx = sc.readNumber() + (rel ? cx : 0);
          const ly = sc.readNumber() + (rel ? cy : 0);
          lineTo(lx, ly);
          cx = lx;
          cy = ly;
        }
        lastCtrl = null;
        break;
      }
      case "L": {
        do {
          const x = sc.readNumber() + (rel ? cx : 0);
          const y = sc.readNumber() + (rel ? cy : 0);
          lineTo(x, y);
          cx = x;
          cy = y;
        } while (sc.hasNumber());
        lastCtrl = null;
        break;
      }
      case "H": {
        do {
          const x = sc.readNumber() + (rel ? cx : 0);
          lineTo(x, cy);
          cx = x;
        } while (sc.hasNumber());
        lastCtrl = null;
        break;
      }
      case "V": {
        do {
          const y = sc.readNumber() + (rel ? cy : 0);
          lineTo(cx, y);
          cy = y;
        } while (sc.hasNumber());
        lastCtrl = null;
        break;
      }
      case "C": {
        do {
          const c1: Pt = { x: sc.readNumber() + (rel ? cx : 0), y: sc.readNumber() + (rel ? cy : 0) };
          const c2: Pt = { x: sc.readNumber() + (rel ? cx : 0), y: sc.readNumber() + (rel ? cy : 0) };
          const end: Pt = { x: sc.readNumber() + (rel ? cx : 0), y: sc.readNumber() + (rel ? cy : 0) };
          cubicTo(c1, c2, end);
          cx = end.x;
          cy = end.y;
          lastCtrl = c2;
        } while (sc.hasNumber());
        break;
      }
      case "S": {
        do {
          const c1 =
            lastCmd.toUpperCase() === "C" || lastCmd.toUpperCase() === "S"
              ? reflect({ x: cx, y: cy }, lastCtrl)
              : { x: cx, y: cy };
          const c2: Pt = { x: sc.readNumber() + (rel ? cx : 0), y: sc.readNumber() + (rel ? cy : 0) };
          const end: Pt = { x: sc.readNumber() + (rel ? cx : 0), y: sc.readNumber() + (rel ? cy : 0) };
          cubicTo(c1, c2, end);
          cx = end.x;
          cy = end.y;
          lastCtrl = c2;
          lastCmd = rel ? "s" : "S";
        } while (sc.hasNumber());
        break;
      }
      case "Q": {
        do {
          const qc: Pt = { x: sc.readNumber() + (rel ? cx : 0), y: sc.readNumber() + (rel ? cy : 0) };
          const end: Pt = { x: sc.readNumber() + (rel ? cx : 0), y: sc.readNumber() + (rel ? cy : 0) };
          const c1: Pt = { x: cx + (2 / 3) * (qc.x - cx), y: cy + (2 / 3) * (qc.y - cy) };
          const c2: Pt = { x: end.x + (2 / 3) * (qc.x - end.x), y: end.y + (2 / 3) * (qc.y - end.y) };
          cubicTo(c1, c2, end);
          cx = end.x;
          cy = end.y;
          lastCtrl = qc;
          lastCmd = rel ? "q" : "Q";
        } while (sc.hasNumber());
        break;
      }
      case "T": {
        do {
          const qc: Pt =
            lastCmd.toUpperCase() === "Q" || lastCmd.toUpperCase() === "T"
              ? reflect({ x: cx, y: cy }, lastCtrl)
              : { x: cx, y: cy };
          const end: Pt = { x: sc.readNumber() + (rel ? cx : 0), y: sc.readNumber() + (rel ? cy : 0) };
          const c1: Pt = { x: cx + (2 / 3) * (qc.x - cx), y: cy + (2 / 3) * (qc.y - cy) };
          const c2: Pt = { x: end.x + (2 / 3) * (qc.x - end.x), y: end.y + (2 / 3) * (qc.y - end.y) };
          cubicTo(c1, c2, end);
          cx = end.x;
          cy = end.y;
          lastCtrl = qc;
          lastCmd = rel ? "t" : "T";
        } while (sc.hasNumber());
        break;
      }
      case "A": {
        do {
          const rx = sc.readNumber();
          const ry = sc.readNumber();
          const rot = sc.readNumber();
          const large = sc.readFlag();
          const sweep = sc.readFlag();
          const end: Pt = { x: sc.readNumber() + (rel ? cx : 0), y: sc.readNumber() + (rel ? cy : 0) };
          const cubics = arcToCubics(cx, cy, rx, ry, rot, large, sweep, end.x, end.y);
          for (const [c1, c2, e] of cubics) cubicTo(c1, c2, e);
          cx = end.x;
          cy = end.y;
          lastCtrl = null;
        } while (sc.hasNumber());
        break;
      }
      case "Z": {
        closeSub();
        cur = null;
        lastCtrl = null;
        break;
      }
      default:
        throw new Error(`Unsupported path command: ${cmd}`);
    }

    lastCmd = cmd;
  }

  // Convert working vertices (absolute controls) to relative in/out tangents.
  return paths
    .filter((p) => p.verts.length > 0)
    .map<SubPath>((p) => {
      const vertices: Array<[number, number]> = [];
      const inTangents: Array<[number, number]> = [];
      const outTangents: Array<[number, number]> = [];
      for (const v of p.verts) {
        vertices.push([v.p.x, v.p.y]);
        inTangents.push(v.cin ? [v.cin.x - v.p.x, v.cin.y - v.p.y] : [0, 0]);
        outTangents.push(v.cout ? [v.cout.x - v.p.x, v.cout.y - v.p.y] : [0, 0]);
      }
      return { closed: p.closed, vertices, inTangents, outTangents };
    });
}

/** Translate every vertex of a set of subpaths by (dx, dy). */
export function translateSubPaths(subpaths: SubPath[], dx: number, dy: number): SubPath[] {
  return subpaths.map((sp) => ({
    closed: sp.closed,
    vertices: sp.vertices.map(([x, y]) => [x + dx, y + dy] as [number, number]),
    inTangents: sp.inTangents.slice(),
    outTangents: sp.outTangents.slice(),
  }));
}

/** Axis-aligned bounding box of a set of subpaths (ignoring tangents). */
export function boundsOfSubPaths(subpaths: SubPath[]): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sp of subpaths) {
    for (const [x, y] of sp.vertices) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
