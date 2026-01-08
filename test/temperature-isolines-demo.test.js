import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../examples/temperature-isolines/index.html", import.meta.url), "utf8");

test("temperature isolines demo keeps million-point buffers across visibility toggles", () => {
  assert.match(html, /observationLayer\.setHidden\(!visible\)/);
  assert.doesNotMatch(html, /observationLayer\.remove\(\)/);
});

test("temperature isolines demo provides collision-managed reference labels", () => {
  assert.match(html, /textLayer\(CITY_STATIONS\.map/);
  assert.match(html, /properties\.temperature\.toFixed\(1\)/);
  assert.match(html, /stationLabels\.addTo\(map\)/);
});

test("temperature isolines demo exposes field, rendering and adaptive contour controls", () => {
  for (const id of [
    "backend", "evaluation", "palette", "worker", "adaptive",
    "cols", "rows", "webgpuThreshold", "scaleZoom", "radius", "blur",
    "opacity", "domainOpacity", "levels", "step", "maxLevels", "lineWidth",
    "quantileLow", "quantileHigh", "candidates", "coverageRadius", "minCells",
    "minLength", "minArea", "coverageWeight", "rangeWeight", "redundancyWeight",
    "fragmentWeight"
  ]) assert.match(html, new RegExp(`\\["${id}"`), `missing ${id} control`);
  assert.match(html, /surface\.options\.outlierQuantiles=/);
  assert.match(html, /surface\.options\.step=/);
  assert.match(html, /surface\.options\.coverageWeight=/);
});

test("temperature isolines demo identifies, highlights and opens overlays for contour features", () => {
  assert.match(html, /interactive:true/);
  assert.match(html, /surface\.bindTooltip/);
  assert.match(html, /surface\.bindPopup/);
  assert.match(html, /surface\.on\("hover"/);
  assert.match(html, /surface\.on\("select"/);
  assert.match(html, /surface\.clearSelection\(\)/);
});
