import assert from "node:assert/strict";
import test from "node:test";
import { buildHeat } from "../dist/services/heat.js";

const AREA = [{ lat: 40, lng: 0 }, { lat: 60, lng: 40 }];
const FIELD = { mode: "heatmap", backend: "wasm", cols: 96, rows: 72, scaleZoom: 5, radius: 16, blur: 12 };

/** A square patch of points around a centre, all carrying the same weight. */
function patch(lat, lng, count, weight) {
  const side = Math.ceil(Math.sqrt(count));
  const points = [];
  for (let i = 0; i < count; i++) {
    const x = (i % side) / side - 0.5;
    const y = Math.floor(i / side) / side - 0.5;
    points.push([lat + y * 2, lng + x * 2, weight]);
  }
  return points;
}

/** Highest field value inside a small box, which is how a reader sees "how hot is it there". */
function peakNear(field, lat, lng) {
  const { grid, cols, rows, westMerc, northMerc, widthMerc, heightMerc } = field;
  const toMercY = (value) => {
    const rad = (value * Math.PI) / 180;
    return 0.5 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / (2 * Math.PI);
  };
  const fx = ((lng + 180) / 360 - westMerc) / widthMerc * (cols - 1);
  const fy = (toMercY(lat) - northMerc) / heightMerc * (rows - 1);
  let peak = 0;
  for (let y = Math.max(0, Math.round(fy) - 3); y <= Math.min(rows - 1, Math.round(fy) + 3); y++) {
    for (let x = Math.max(0, Math.round(fx) - 3); x <= Math.min(cols - 1, Math.round(fx) + 3); x++) {
      peak = Math.max(peak, grid[y * cols + x]);
    }
  }
  return peak;
}

// Two patches at the same temperature but different densities. A summed field says the crowded
// one is hotter, which is what made the demo's contours follow airports rather than degrees.
const sparse = patch(45, 8, 400, 0.6);
const dense = patch(55, 30, 1600, 0.6);

test("a summed field reads density as heat", async () => {
  const result = await buildHeat([...sparse, ...dense], AREA, FIELD);
  const thin = peakNear(result.field, 45, 8);
  const thick = peakNear(result.field, 55, 30);
  assert.ok(thin > 0 && thick > 0, "both patches produced a field");
  assert.ok(thick > thin * 2, `the denser patch should dominate a sum: ${thick.toFixed(2)} vs ${thin.toFixed(2)}`);
});

test("a mean field reads the weights, whatever the density", async () => {
  const result = await buildHeat([...sparse, ...dense], AREA, { ...FIELD, fieldModel: "mean" });
  const thin = peakNear(result.field, 45, 8);
  const thick = peakNear(result.field, 55, 30);
  assert.ok(Math.abs(thick - thin) < 0.1, `equal weights should read equal: ${thick.toFixed(3)} vs ${thin.toFixed(3)}`);
  assert.ok(Math.abs(thick - 0.6) < 0.12, `values come back in weight units: ${thick.toFixed(3)}`);
});

test("a mean field separates two temperatures at one density", async () => {
  const cool = patch(45, 8, 900, 0.3);
  const warm = patch(55, 30, 900, 0.9);
  const result = await buildHeat([...cool, ...warm], AREA, { ...FIELD, fieldModel: "mean" });
  assert.ok(Math.abs(peakNear(result.field, 45, 8) - 0.3) < 0.12);
  assert.ok(Math.abs(peakNear(result.field, 55, 30) - 0.9) < 0.12);
});

test("empty space stays empty instead of averaging a stray point", async () => {
  const result = await buildHeat(patch(45, 8, 900, 1), AREA, { ...FIELD, fieldModel: "mean" });
  const far = peakNear(result.field, 58, 36);
  assert.ok(far < 0.2, `far from every point the mean must fade, got ${far.toFixed(3)}`);
});

test("the profile names the model that ran", async () => {
  const summed = await buildHeat(sparse, AREA, FIELD);
  const averaged = await buildHeat(sparse, AREA, { ...FIELD, fieldModel: "mean" });
  assert.equal(summed.profile.fieldModel, "clustered-gaussian");
  assert.equal(averaged.profile.fieldModel, "clustered-gaussian-mean");
});

test("the default is unchanged", async () => {
  const explicit = await buildHeat(sparse, AREA, { ...FIELD, fieldModel: "sum" });
  const implicit = await buildHeat(sparse, AREA, FIELD);
  assert.equal(explicit.field.peak.toFixed(6), implicit.field.peak.toFixed(6));
});
