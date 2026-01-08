import { performance } from "node:perf_hooks";
import { buildGreedyClusterLayout } from "../dist/services/cluster-layout.js";

const COUNT = Number(process.env.COUNT || 100_000);
const RUNS = Number(process.env.RUNS || (COUNT >= 1_000_000 ? 3 : 5));
const thresholds = (process.env.THRESHOLDS || "0,4,8,16,32")
  .split(",")
  .map(Number)
  .filter((value) => Number.isFinite(value) && value >= 0);
const distributions = (process.env.DISTS || "dense,regional,global")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const fmt = new Intl.NumberFormat("en-US");
const ms = (value) => `${value.toFixed(3)}ms`;
const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

function lcg(seed = 0x12345678) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeCoords(count, distribution) {
  const coords = new Float64Array(count * 2);
  const random = lcg();
  for (let i = 0; i < count; i++) {
    if (distribution === "dense") {
      const row = Math.floor(i / 1000);
      const col = i - row * 1000;
      coords[i * 2] = 45 + row * 0.0005;
      coords[i * 2 + 1] = -120 + col * 0.0005;
    } else if (distribution === "regional") {
      coords[i * 2] = 40 + (random() - 0.5) * 8;
      coords[i * 2 + 1] = -100 + (random() - 0.5) * 8;
    } else if (distribution === "global") {
      coords[i * 2] = -70 + random() * 140;
      coords[i * 2 + 1] = -180 + random() * 360;
    } else {
      throw new Error(`Unknown distribution: ${distribution}`);
    }
  }
  return coords;
}

function input(coords) {
  // Worker-format: production greedy worker deliberately omits arbitrary user ids.
  return {
    ids: [],
    coords,
    zoomBucket: 8,
    gridSize: 50,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 8,
    clusterMinZoom: 0,
    simple: false
  };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function p95(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function measure(request) {
  const values = [];
  let result = null;
  // One unmeasured warm run stabilizes V8 before medians.
  buildGreedyClusterLayout(request);
  for (let run = 0; run < RUNS; run++) {
    global.gc?.();
    const started = performance.now();
    result = buildGreedyClusterLayout(request);
    values.push(performance.now() - started);
  }
  return { median: median(values), p95: p95(values), result };
}

function membershipSignature(result) {
  const groups = [];
  for (const cluster of result.clusters) {
    const ids = cluster.ids.slice().sort((a, b) => a - b);
    groups.push(`c:${ids.join(",")}`);
  }
  for (const single of result.singles) groups.push(`s:${single.id}`);
  groups.sort();
  return groups.join("|");
}

console.log(`Orihon P1-D4 adaptive greedy benchmark · Node ${process.version} · ${process.platform}/${process.arch}`);
console.log(`COUNT=${fmt.format(COUNT)} · runs=${RUNS} · thresholds=${thresholds.join(",")} · --expose-gc=${global.gc ? "yes" : "no"}`);

for (const distribution of distributions) {
  console.log(`\n=== ${distribution} ===`);
  const coords = makeCoords(COUNT, distribution);
  const base = input(coords);

  // Semantic comparison on a bounded sample against threshold=0 (grid-only P1-D3 control).
  const semanticCount = Math.min(COUNT, 20_000);
  const semanticCoords = coords.slice(0, semanticCount * 2);
  const semanticBase = input(semanticCoords);
  const controlSignature = membershipSignature(
    buildGreedyClusterLayout({ ...semanticBase, __greedyDirectThreshold: 0 })
  );
  let semanticOk = true;
  for (const threshold of thresholds) {
    const signature = membershipSignature(
      buildGreedyClusterLayout({ ...semanticBase, __greedyDirectThreshold: threshold })
    );
    if (signature !== controlSignature) semanticOk = false;
  }
  console.log(`semantic check (${fmt.format(semanticCount)}): ${semanticOk ? "PASS" : "FAIL"}`);

  const rows = [];
  for (const threshold of thresholds) {
    const measured = measure({ ...base, __greedyDirectThreshold: threshold });
    rows.push({ threshold, ...measured });
    console.log(
      `threshold=${String(threshold).padStart(3)}  ${ms(measured.median)} median · ${ms(measured.p95)} p95` +
      ` · clusters=${fmt.format(measured.result.clusters.length)} singles=${fmt.format(measured.result.singles.length)}`
    );
  }

  const control = rows.find((row) => row.threshold === 0);
  const best = rows.reduce((a, b) => (b.median < a.median ? b : a));
  if (control) {
    console.log(`best threshold=${best.threshold} · speedup vs grid-only ${(control.median / best.median).toFixed(2)}x`);
  }

  const profile = {};
  buildGreedyClusterLayout({ ...base, __greedyDirectThreshold: 8, __greedyProfile: profile });
  console.log("profile threshold=8:");
  console.log(`  adaptive direct:      ${profile.adaptiveDirect}`);
  console.log(`  inserted origins:     ${fmt.format(Number(profile.insertedOrigins || 0))}`);
  console.log(`  direct queries:       ${fmt.format(Number(profile.directQueries || 0))}`);
  console.log(`  grid queries:         ${fmt.format(Number(profile.gridQueries || 0))}`);
  console.log(`  packed grid allocated:${profile.packedGridAllocated}`);
  console.log(`  temp projected xy:    ${mb(Number(profile.tempProjectedBytes || 0))}`);
  console.log(`  direct:               ${ms(Number(profile.directMs || 0))}`);
  console.log(`  projection:           ${ms(Number(profile.projectionMs || 0))}`);
  console.log(`  grid scan:            ${ms(Number(profile.gridScanMs ?? profile.scanMs ?? 0))}`);
  console.log(`  materialize:          ${ms(Number(profile.materializeMs || 0))}`);
  console.log(`  total(profiled):      ${ms(Number(profile.totalMs || 0))}`);
  console.log(`  hash probes:          ${fmt.format(Number(profile.hashProbes || 0))}`);
  console.log(`  candidate checks:     ${fmt.format(Number(profile.candidateChecks || 0))}`);
}
