// Sanity checks for @lazylord/core (run after `npm run build:core`).
//   node tools/smoke-test.mjs
import assert from "node:assert";
import { parseSvgPath, boundsOfSubPaths } from "../packages/core/dist/index.js";

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log("  ✓ " + name);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log("LazyLord core — SVG path parser");

// 1) A simple closed triangle.
{
  const sp = parseSvgPath("M0 0 L100 0 L100 100 Z");
  ok("triangle: one subpath", sp.length === 1);
  ok("triangle: closed", sp[0].closed === true);
  ok("triangle: 3 vertices (closing dup merged)", sp[0].vertices.length === 3);
  const b = boundsOfSubPaths(sp);
  ok("triangle: bounds 100x100", near(b.width, 100) && near(b.height, 100));
}

// 2) Cubic bezier tangents are stored relative to the vertex.
{
  const sp = parseSvgPath("M0 0 C10 0 20 10 20 20");
  ok("cubic: 2 vertices", sp[0].vertices.length === 2);
  ok("cubic: start out-tangent = (10,0)", near(sp[0].outTangents[0][0], 10) && near(sp[0].outTangents[0][1], 0));
  ok("cubic: end in-tangent = (0,-10)", near(sp[0].inTangents[1][0], 0) && near(sp[0].inTangents[1][1], -10));
}

// 3) Relative commands and H/V.
{
  const sp = parseSvgPath("m10 10 h20 v20 z");
  const b = boundsOfSubPaths(sp);
  ok("relative: origin (10,10)", near(b.x, 10) && near(b.y, 10));
  ok("relative: size 20x20", near(b.width, 20) && near(b.height, 20));
}

// 4) Arc converts to cubics without throwing and spans the diameter.
{
  const sp = parseSvgPath("M0 50 A50 50 0 1 1 100 50 A50 50 0 1 1 0 50 Z");
  const b = boundsOfSubPaths(sp);
  ok("arc: circle width ~100", b.width > 95 && b.width < 105);
  ok("arc: circle height ~100", b.height > 95 && b.height < 105);
}

// 5) Multiple subpaths (compound path with a hole).
{
  const sp = parseSvgPath("M0 0 H100 V100 H0 Z M25 25 H75 V75 H25 Z");
  ok("compound: two subpaths", sp.length === 2);
}

console.log(`\n${passed} checks passed.`);
