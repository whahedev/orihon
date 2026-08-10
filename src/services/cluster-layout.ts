export type ClusterLayoutId = string | number;

export interface ClusterLayoutRequest {
  ids: ClusterLayoutId[];
  /** Packed lat/lng pairs (Float64 preferred for geo precision). */
  coords: Float64Array | Float32Array;
  zoomBucket: number;
  /** Cluster radius in CSS/world pixels at the clustered zoom (Leaflet-style). */
  gridSize: number;
  minPoints: number;
  clusterize: boolean;
  clusterMaxZoom: number;
  clusterMinZoom?: number;
}

export interface ClusterLayoutCluster {
  key: string;
  lat: number;
  lng: number;
  ids: ClusterLayoutId[];
  /** Set when `ids` were not expanded (lazy query). */
  count?: number;
  nodeId?: number;
}

export interface ClusterLayoutSingle {
  id: ClusterLayoutId;
  lat: number;
  lng: number;
}

export interface ClusterLayoutResult {
  clusters: ClusterLayoutCluster[];
  singles: ClusterLayoutSingle[];
}

/** Compact hierarchical greedy index (Leaflet.markercluster / Supercluster family). */
export interface ClusterIndex {
  leafCount: number;
  nodeCount: number;
  maxZoom: number;
  minZoom: number;
  minPoints: number;
  radius: number;
  ids: ClusterLayoutId[];
  x: Float64Array;
  y: Float64Array;
  lat: Float64Array;
  lng: Float64Array;
  weight: Uint32Array;
  zoom: Int8Array;
  parent: Int32Array;
  firstChild: Int32Array;
  nextSibling: Int32Array;
  /** Root node indices per zoom level `minZoom…maxZoom`. */
  trees: Int32Array[];
}

const MAX_LAT = 85.0511287798066;
const TILE_SIZE = 256;

/** Normalized Web-Mercator in 0..1 (Supercluster-compatible radius scaling). */
export function projectMercator01(lat: number, lng: number): { x: number; y: number } {
  let clampedLat = lat;
  if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
  else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
  const wrappedLng = ((lng + 180) % 360 + 360) % 360 - 180;
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  return {
    x: (wrappedLng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  };
}

class DistanceGrid {
  cellSize: number;
  radius2: number;
  /** Nested maps avoid string alloc and hash collisions. */
  private readonly cols = new Map<number, Map<number, number[]>>();
  private bucketPool: number[][] = [];
  private rowPool: Map<number, number[]>[] = [];

  constructor(cellSize: number) {
    this.cellSize = Math.max(1e-12, cellSize);
    this.radius2 = this.cellSize * this.cellSize;
  }

  reset(cellSize: number): void {
    for (const row of this.cols.values()) {
      for (const bucket of row.values()) {
        bucket.length = 0;
        this.bucketPool.push(bucket);
      }
      row.clear();
      this.rowPool.push(row);
    }
    this.cols.clear();
    this.cellSize = Math.max(1e-12, cellSize);
    this.radius2 = this.cellSize * this.cellSize;
  }

  insert(x: number, y: number, id: number): void {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    let row = this.cols.get(cx);
    if (!row) {
      row = this.rowPool.pop() || new Map();
      this.cols.set(cx, row);
    }
    const bucket = row.get(cy);
    if (bucket) {
      bucket.push(id);
      return;
    }
    const fresh = this.bucketPool.pop() || [];
    fresh.push(id);
    row.set(cy, fresh);
  }

  queryNearest(x: number, y: number, xs: Float64Array, ys: Float64Array): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    let best = -1;
    let bestDist = this.radius2;
    for (let dx = -1; dx <= 1; dx++) {
      const row = this.cols.get(cx + dx);
      if (!row) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = row.get(cy + dy);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i];
          const ddx = xs[id] - x;
          const ddy = ys[id] - y;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 <= bestDist) {
            bestDist = d2;
            best = id;
          }
        }
      }
    }
    return best;
  }
}

function appendChild(
  firstChild: Int32Array,
  nextSibling: Int32Array,
  parentId: number,
  childId: number
): void {
  nextSibling[childId] = firstChild[parentId];
  firstChild[parentId] = childId;
}

/**
 * Build a full zoom hierarchy once (data change). Zoom changes only query this index.
 */
export function buildClusterIndex(input: Omit<ClusterLayoutRequest, "zoomBucket">): ClusterIndex {
  const leafCount = Math.min(input.ids.length, Math.floor(input.coords.length / 2));
  const maxZoom = Math.max(0, Math.floor(input.clusterMaxZoom));
  const minZoom = Math.max(0, Math.min(maxZoom, Math.floor(input.clusterMinZoom ?? 0)));
  const radius = Math.max(20, Number(input.gridSize) || 50);
  const minPoints = Math.max(2, Math.floor(input.minPoints));
  const leafIds = input.ids.slice(0, leafCount);
  const coords = input.coords;

  let capacity = Math.max(leafCount * 2 + 64, 32);
  let x = new Float64Array(capacity);
  let y = new Float64Array(capacity);
  let lat = new Float64Array(capacity);
  let lng = new Float64Array(capacity);
  let weight = new Uint32Array(capacity);
  let zoomArr = new Int8Array(capacity);
  let parent = new Int32Array(capacity);
  let firstChild = new Int32Array(capacity);
  let nextSibling = new Int32Array(capacity);
  parent.fill(-1);
  firstChild.fill(-1);
  nextSibling.fill(-1);

  for (let i = 0; i < leafCount; i++) {
    const la = coords[i * 2];
    const ln = coords[i * 2 + 1];
    const p = projectMercator01(la, ln);
    x[i] = p.x;
    y[i] = p.y;
    lat[i] = la;
    lng[i] = ln;
    weight[i] = 1;
    zoomArr[i] = maxZoom + 1;
  }

  let nodeCount = leafCount;
  let ox = new Float64Array(capacity);
  let oy = new Float64Array(capacity);
  let clusterOf = new Int32Array(capacity);
  let visitStamp = new Uint32Array(capacity);
  let clusterStamp = new Uint32Array(capacity);
  let nextSlot = new Int32Array(capacity);
  let stamp = 1;

  const grow = () => {
    capacity *= 2;
    const enlarge = <T extends Float64Array | Uint32Array | Int8Array | Uint8Array>(
      src: T,
      Ctor: new (n: number) => T
    ): T => {
      const next = new Ctor(capacity);
      (next as Float64Array).set(src as Float64Array);
      return next;
    };
    x = enlarge(x, Float64Array);
    y = enlarge(y, Float64Array);
    lat = enlarge(lat, Float64Array);
    lng = enlarge(lng, Float64Array);
    weight = enlarge(weight, Uint32Array);
    zoomArr = enlarge(zoomArr, Int8Array);
    ox = enlarge(ox, Float64Array);
    oy = enlarge(oy, Float64Array);
    visitStamp = enlarge(visitStamp, Uint32Array);
    clusterStamp = enlarge(clusterStamp, Uint32Array);
    const np = new Int32Array(capacity);
    const nf = new Int32Array(capacity);
    const ns = new Int32Array(capacity);
    const nc = new Int32Array(capacity);
    const nslot = new Int32Array(capacity);
    np.set(parent);
    nf.set(firstChild);
    ns.set(nextSibling);
    nc.set(clusterOf);
    nslot.set(nextSlot);
    np.fill(-1, nodeCount);
    nf.fill(-1, nodeCount);
    ns.fill(-1, nodeCount);
    parent = np;
    firstChild = nf;
    nextSibling = ns;
    clusterOf = nc;
    nextSlot = nslot;
  };

  const trees: Int32Array[] = new Array(maxZoom + 1);
  for (let z = 0; z <= maxZoom; z++) trees[z] = new Int32Array(0);
  let level = new Int32Array(leafCount);
  for (let i = 0; i < leafCount; i++) level[i] = i;
  let levelLen = leafCount;
  const grid = new DistanceGrid(1);

  if (!input.clusterize || leafCount === 0) {
    const all = levelLen ? level.slice(0, levelLen) : new Int32Array(0);
    for (let z = minZoom; z <= maxZoom; z++) trees[z] = all;
  } else {
    const nextBuf = new Int32Array(Math.max(leafCount * 2, 32));

    for (let z = maxZoom; z >= minZoom; z--) {
      const r = radius / (TILE_SIZE * 2 ** z);
      grid.reset(r);
      stamp++;
      if (stamp >= 0xfffffff0) {
        visitStamp.fill(0);
        clusterStamp.fill(0);
        stamp = 1;
      }
      let nextLen = 0;

      for (let i = 0; i < levelLen; i++) {
        const id = level[i];
        if (visitStamp[id] === stamp) continue;

        const px = x[id];
        const py = y[id];
        const origin = grid.queryNearest(px, py, ox, oy);

        if (origin >= 0) {
          visitStamp[id] = stamp;
          let clusterId = clusterStamp[origin] === stamp ? clusterOf[origin] : -1;
          if (clusterId < 0) {
            if (nodeCount >= capacity) grow();
            clusterId = nodeCount++;
            clusterOf[origin] = clusterId;
            clusterStamp[origin] = stamp;
            zoomArr[clusterId] = z;
            parent[clusterId] = -1;
            firstChild[clusterId] = -1;
            nextSibling[clusterId] = -1;
            visitStamp[origin] = stamp;
            parent[origin] = clusterId;
            appendChild(firstChild, nextSibling, clusterId, origin);
            weight[clusterId] = weight[origin];
            x[clusterId] = x[origin];
            y[clusterId] = y[origin];
            lat[clusterId] = lat[origin];
            lng[clusterId] = lng[origin];
            const slot = nextSlot[origin];
            if (slot >= 0 && slot < nextLen && nextBuf[slot] === origin) {
              nextBuf[slot] = clusterId;
              nextSlot[clusterId] = slot;
            } else {
              nextSlot[clusterId] = nextLen;
              nextBuf[nextLen++] = clusterId;
            }
          }
          parent[id] = clusterId;
          appendChild(firstChild, nextSibling, clusterId, id);
          const w = weight[id];
          const cw = weight[clusterId];
          const nw = cw + w;
          x[clusterId] = (x[clusterId] * cw + px * w) / nw;
          y[clusterId] = (y[clusterId] * cw + py * w) / nw;
          lat[clusterId] = (lat[clusterId] * cw + lat[id] * w) / nw;
          lng[clusterId] = (lng[clusterId] * cw + lng[id] * w) / nw;
          weight[clusterId] = nw;
          ox[origin] = x[clusterId];
          oy[origin] = y[clusterId];
          continue;
        }

        visitStamp[id] = stamp;
        ox[id] = px;
        oy[id] = py;
        grid.insert(px, py, id);
        nextSlot[id] = nextLen;
        nextBuf[nextLen++] = id;
      }

      const tree = new Int32Array(nextLen);
      tree.set(nextBuf.subarray(0, nextLen));
      trees[z] = tree;
      level = tree;
      levelLen = nextLen;
    }
  }

  return {
    leafCount,
    nodeCount,
    maxZoom,
    minZoom,
    minPoints,
    radius,
    ids: leafIds,
    x: x.subarray(0, nodeCount),
    y: y.subarray(0, nodeCount),
    lat: lat.subarray(0, nodeCount),
    lng: lng.subarray(0, nodeCount),
    weight: weight.subarray(0, nodeCount),
    zoom: zoomArr.subarray(0, nodeCount),
    parent: parent.subarray(0, nodeCount),
    firstChild: firstChild.subarray(0, nodeCount),
    nextSibling: nextSibling.subarray(0, nodeCount),
    trees
  };
}

export function collectClusterLeaves(
  index: ClusterIndex,
  nodeId: number,
  out: ClusterLayoutId[] = []
): ClusterLayoutId[] {
  if (nodeId < index.leafCount) {
    out.push(index.ids[nodeId]);
    return out;
  }
  let child = index.firstChild[nodeId];
  while (child >= 0) {
    collectClusterLeaves(index, child, out);
    child = index.nextSibling[child];
  }
  return out;
}

/** Expand hierarchy at an integer zoom into ObjectManager layout records. */
export function queryClusterLayout(
  index: ClusterIndex,
  zoomBucket: number,
  minPoints = index.minPoints,
  options: { expandLeaves?: boolean } = {}
): ClusterLayoutResult {
  const expandLeaves = options.expandLeaves !== false;
  const singles: ClusterLayoutSingle[] = [];
  const clusters: ClusterLayoutCluster[] = [];
  const z = Math.max(index.minZoom, Math.min(index.maxZoom, Math.floor(zoomBucket)));

  if (zoomBucket > index.maxZoom) {
    for (let i = 0; i < index.leafCount; i++) {
      singles.push({ id: index.ids[i], lat: index.lat[i], lng: index.lng[i] });
    }
    return { clusters, singles };
  }

  const roots = index.trees[z] || new Int32Array(0);
  const minP = Math.max(2, Math.floor(minPoints));
  const leafPos = expandLeaves ? new Map<ClusterLayoutId, number>() : null;
  if (leafPos) {
    for (let i = 0; i < index.leafCount; i++) leafPos.set(index.ids[i], i);
  }

  for (let i = 0; i < roots.length; i++) {
    const nodeId = roots[i];
    const w = index.weight[nodeId];
    if (w < minP || nodeId < index.leafCount) {
      if (nodeId < index.leafCount) {
        singles.push({ id: index.ids[nodeId], lat: index.lat[nodeId], lng: index.lng[nodeId] });
      } else if (expandLeaves && leafPos) {
        const leaves: ClusterLayoutId[] = [];
        collectClusterLeaves(index, nodeId, leaves);
        for (const id of leaves) {
          const leafIndex = leafPos.get(id);
          if (leafIndex != null) {
            singles.push({ id, lat: index.lat[leafIndex], lng: index.lng[leafIndex] });
          }
        }
      } else {
        // Small groups still need concrete singles for markers (cheap: group is < minPoints).
        const pushLeaves = (nid: number) => {
          if (nid < index.leafCount) {
            singles.push({ id: index.ids[nid], lat: index.lat[nid], lng: index.lng[nid] });
            return;
          }
          let c = index.firstChild[nid];
          while (c >= 0) {
            pushLeaves(c);
            c = index.nextSibling[c];
          }
        };
        pushLeaves(nodeId);
      }
      continue;
    }
    if (expandLeaves) {
      const memberIds: ClusterLayoutId[] = [];
      collectClusterLeaves(index, nodeId, memberIds);
      clusters.push({
        key: `z${z}:${nodeId}`,
        lat: index.lat[nodeId],
        lng: index.lng[nodeId],
        ids: memberIds,
        count: w,
        nodeId
      });
    } else {
      clusters.push({
        key: `z${z}:${nodeId}`,
        lat: index.lat[nodeId],
        lng: index.lng[nodeId],
        ids: [],
        count: w,
        nodeId
      });
    }
  }

  return { clusters, singles };
}

/** Build index and query one zoom — drop-in for previous grid API. */
export function buildClusterLayout(input: ClusterLayoutRequest): ClusterLayoutResult {
  if (!input.clusterize) {
    const singles: ClusterLayoutSingle[] = [];
    const count = Math.min(input.ids.length, Math.floor(input.coords.length / 2));
    for (let i = 0; i < count; i++) {
      singles.push({ id: input.ids[i], lat: input.coords[i * 2], lng: input.coords[i * 2 + 1] });
    }
    return { clusters: [], singles };
  }
  const index = buildClusterIndex(input);
  return queryClusterLayout(index, input.zoomBucket, input.minPoints);
}

/**
 * Single-zoom greedy clustering (O(n)) for fast first paint.
 * Full hierarchy is built separately via `buildClusterIndex`.
 */
export function buildGreedyClusterLayout(input: ClusterLayoutRequest): ClusterLayoutResult {
  const count = Math.min(input.ids.length, Math.floor(input.coords.length / 2));
  const singles: ClusterLayoutSingle[] = [];
  const clusters: ClusterLayoutCluster[] = [];
  if (!input.clusterize || count === 0) {
    for (let i = 0; i < count; i++) {
      singles.push({ id: input.ids[i], lat: input.coords[i * 2], lng: input.coords[i * 2 + 1] });
    }
    return { clusters, singles };
  }

  const zoomBucket = Math.floor(input.zoomBucket);
  const maxZoom = Math.max(0, Math.floor(input.clusterMaxZoom));
  if (zoomBucket > maxZoom) {
    for (let i = 0; i < count; i++) {
      singles.push({ id: input.ids[i], lat: input.coords[i * 2], lng: input.coords[i * 2 + 1] });
    }
    return { clusters, singles };
  }

  const z = Math.max(0, Math.min(maxZoom, zoomBucket));
  const radius = Math.max(20, Number(input.gridSize) || 50);
  const minPoints = Math.max(2, Math.floor(input.minPoints));
  const grid = new DistanceGrid(radius / (TILE_SIZE * 2 ** z));

  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const lats = new Float64Array(count);
  const lngs = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const la = input.coords[i * 2];
    const ln = input.coords[i * 2 + 1];
    const p = projectMercator01(la, ln);
    xs[i] = p.x;
    ys[i] = p.y;
    lats[i] = la;
    lngs[i] = ln;
  }

  const ox = new Float64Array(count);
  const oy = new Float64Array(count);
  const assigned = new Uint8Array(count);
  type Acc = { lat: number; lng: number; w: number; leaves: number[] };
  const byOrigin = new Map<number, Acc>();

  for (let i = 0; i < count; i++) {
    const px = xs[i];
    const py = ys[i];
    const origin = grid.queryNearest(px, py, ox, oy);
    if (origin >= 0) {
      let acc = byOrigin.get(origin);
      if (!acc) {
        acc = { lat: lats[origin], lng: lngs[origin], w: 1, leaves: [origin] };
        byOrigin.set(origin, acc);
        assigned[origin] = 1;
      }
      const w = acc.w;
      const nw = w + 1;
      ox[origin] = (ox[origin] * w + px) / nw;
      oy[origin] = (oy[origin] * w + py) / nw;
      acc.lat = (acc.lat * w + lats[i]) / nw;
      acc.lng = (acc.lng * w + lngs[i]) / nw;
      acc.w = nw;
      acc.leaves.push(i);
      assigned[i] = 1;
      continue;
    }
    ox[i] = px;
    oy[i] = py;
    grid.insert(px, py, i);
  }

  let clusterSeq = 0;
  for (const acc of byOrigin.values()) {
    if (acc.w < minPoints) {
      for (const leaf of acc.leaves) {
        singles.push({ id: input.ids[leaf], lat: lats[leaf], lng: lngs[leaf] });
      }
      continue;
    }
    const ids: ClusterLayoutId[] = new Array(acc.leaves.length);
    for (let i = 0; i < acc.leaves.length; i++) ids[i] = input.ids[acc.leaves[i]];
    clusters.push({
      key: `g${z}:${clusterSeq++}`,
      lat: acc.lat,
      lng: acc.lng,
      ids,
      count: acc.w,
      nodeId: -1
    });
  }

  for (let i = 0; i < count; i++) {
    if (assigned[i]) continue;
    singles.push({ id: input.ids[i], lat: lats[i], lng: lngs[i] });
  }

  return { clusters, singles };
}

export function encodeClusterIndex(index: ClusterIndex): {
  payload: Record<string, unknown>;
  transfer: ArrayBuffer[];
} {
  const copyBuf = (arr: Float64Array | Uint32Array | Int8Array | Int32Array): ArrayBuffer =>
    arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;

  const trees = index.trees.map((tree) => ({
    buffer: copyBuf(tree),
    length: tree.length
  }));

  const payload = {
    leafCount: index.leafCount,
    nodeCount: index.nodeCount,
    maxZoom: index.maxZoom,
    minZoom: index.minZoom,
    minPoints: index.minPoints,
    radius: index.radius,
    ids: index.ids,
    x: copyBuf(index.x),
    y: copyBuf(index.y),
    lat: copyBuf(index.lat),
    lng: copyBuf(index.lng),
    weight: copyBuf(index.weight),
    zoom: copyBuf(index.zoom),
    parent: copyBuf(index.parent),
    firstChild: copyBuf(index.firstChild),
    nextSibling: copyBuf(index.nextSibling),
    trees
  };

  const transfer: ArrayBuffer[] = [
    payload.x,
    payload.y,
    payload.lat,
    payload.lng,
    payload.weight,
    payload.zoom,
    payload.parent,
    payload.firstChild,
    payload.nextSibling,
    ...trees.map((t) => t.buffer)
  ];
  return { payload, transfer };
}

export function decodeClusterIndex(data: Record<string, unknown>): ClusterIndex {
  const treesRaw = data.trees as Array<{ buffer: ArrayBuffer; length: number }>;
  return {
    leafCount: Number(data.leafCount),
    nodeCount: Number(data.nodeCount),
    maxZoom: Number(data.maxZoom),
    minZoom: Number(data.minZoom),
    minPoints: Number(data.minPoints),
    radius: Number(data.radius),
    ids: data.ids as ClusterLayoutId[],
    x: new Float64Array(data.x as ArrayBuffer),
    y: new Float64Array(data.y as ArrayBuffer),
    lat: new Float64Array(data.lat as ArrayBuffer),
    lng: new Float64Array(data.lng as ArrayBuffer),
    weight: new Uint32Array(data.weight as ArrayBuffer),
    zoom: new Int8Array(data.zoom as ArrayBuffer),
    parent: new Int32Array(data.parent as ArrayBuffer),
    firstChild: new Int32Array(data.firstChild as ArrayBuffer),
    nextSibling: new Int32Array(data.nextSibling as ArrayBuffer),
    trees: treesRaw.map((t) => new Int32Array(t.buffer, 0, t.length))
  };
}

/**
 * Worker-safe JS source: hierarchical greedy + DistanceGrid (no imports).
 * Exposes buildClusterIndex / queryClusterLayout / buildClusterLayout.
 */
export const CLUSTER_LAYOUT_WORKER_SOURCE = `
var MAX_LAT = 85.0511287798066;
var TILE_SIZE = 256;
function projectMercator01(lat, lng) {
  var clampedLat = lat;
  if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
  else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
  var wrappedLng = ((lng + 180) % 360 + 360) % 360 - 180;
  var sin = Math.sin((clampedLat * Math.PI) / 180);
  return {
    x: (wrappedLng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  };
}
function DistanceGrid(cellSize) {
  this.cellSize = Math.max(1e-12, cellSize);
  this.radius2 = this.cellSize * this.cellSize;
  this.cells = Object.create(null);
}
DistanceGrid.prototype.key = function(cx, cy) {
  return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) | 0;
};
DistanceGrid.prototype.insert = function(x, y, id) {
  var cx = Math.floor(x / this.cellSize);
  var cy = Math.floor(y / this.cellSize);
  var k = this.key(cx, cy);
  var bucket = this.cells[k];
  if (bucket) bucket.push(id);
  else this.cells[k] = [id];
};
DistanceGrid.prototype.queryNearest = function(x, y, xs, ys) {
  var cx = Math.floor(x / this.cellSize);
  var cy = Math.floor(y / this.cellSize);
  var best = -1;
  var bestDist = this.radius2;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      var bucket = this.cells[this.key(cx + dx, cy + dy)];
      if (!bucket) continue;
      for (var i = 0; i < bucket.length; i++) {
        var id = bucket[i];
        var ddx = xs[id] - x;
        var ddy = ys[id] - y;
        var d2 = ddx * ddx + ddy * ddy;
        if (d2 <= bestDist) {
          bestDist = d2;
          best = id;
        }
      }
    }
  }
  return best;
};
function appendChild(firstChild, nextSibling, parentId, childId) {
  nextSibling[childId] = firstChild[parentId];
  firstChild[parentId] = childId;
}
function buildClusterIndex(input) {
  var ids = input.ids;
  var coords = input.coords;
  var leafCount = Math.min(ids.length, Math.floor(coords.length / 2));
  var maxZoom = Math.max(0, Math.floor(input.clusterMaxZoom));
  var minZoom = Math.max(0, Math.min(maxZoom, Math.floor(input.clusterMinZoom || 0)));
  var radius = Math.max(20, Number(input.gridSize) || 50);
  var minPoints = Math.max(2, Math.floor(input.minPoints));
  var leafIds = ids.slice(0, leafCount);
  var capacity = Math.max(leafCount * 2 + 64, 32);
  var x = new Float64Array(capacity);
  var y = new Float64Array(capacity);
  var lat = new Float64Array(capacity);
  var lng = new Float64Array(capacity);
  var weight = new Uint32Array(capacity);
  var zoomArr = new Int8Array(capacity);
  var parent = new Int32Array(capacity);
  var firstChild = new Int32Array(capacity);
  var nextSibling = new Int32Array(capacity);
  parent.fill(-1);
  firstChild.fill(-1);
  nextSibling.fill(-1);
  for (var i = 0; i < leafCount; i++) {
    var la = coords[i * 2];
    var ln = coords[i * 2 + 1];
    var p = projectMercator01(la, ln);
    x[i] = p.x;
    y[i] = p.y;
    lat[i] = la;
    lng[i] = ln;
    weight[i] = 1;
    zoomArr[i] = maxZoom + 1;
  }
  var nodeCount = leafCount;
  var ox = new Float64Array(capacity);
  var oy = new Float64Array(capacity);
  var clusterOf = new Int32Array(capacity);
  var visited = new Uint8Array(capacity);
  var nextSlot = new Int32Array(capacity);
  clusterOf.fill(-1);
  nextSlot.fill(-1);
  function grow() {
    capacity *= 2;
    function enlarge(src, Ctor) {
      var next = new Ctor(capacity);
      next.set(src);
      return next;
    }
    x = enlarge(x, Float64Array);
    y = enlarge(y, Float64Array);
    lat = enlarge(lat, Float64Array);
    lng = enlarge(lng, Float64Array);
    weight = enlarge(weight, Uint32Array);
    zoomArr = enlarge(zoomArr, Int8Array);
    ox = enlarge(ox, Float64Array);
    oy = enlarge(oy, Float64Array);
    visited = enlarge(visited, Uint8Array);
    var np = new Int32Array(capacity);
    var nf = new Int32Array(capacity);
    var ns = new Int32Array(capacity);
    var nc = new Int32Array(capacity);
    var nslot = new Int32Array(capacity);
    np.set(parent);
    nf.set(firstChild);
    ns.set(nextSibling);
    nc.set(clusterOf);
    nslot.set(nextSlot);
    np.fill(-1, nodeCount);
    nf.fill(-1, nodeCount);
    ns.fill(-1, nodeCount);
    nc.fill(-1, nodeCount);
    nslot.fill(-1, nodeCount);
    parent = np;
    firstChild = nf;
    nextSibling = ns;
    clusterOf = nc;
    nextSlot = nslot;
  }
  var trees = new Array(maxZoom + 1);
  for (var tz = 0; tz <= maxZoom; tz++) trees[tz] = new Int32Array(0);
  var level = [];
  for (var li = 0; li < leafCount; li++) level.push(li);
  if (!input.clusterize || leafCount === 0) {
    var all = new Int32Array(leafCount);
    for (var ai = 0; ai < leafCount; ai++) all[ai] = ai;
    for (var az = minZoom; az <= maxZoom; az++) trees[az] = all;
  } else {
    for (var z = maxZoom; z >= minZoom; z--) {
      var r = radius / (TILE_SIZE * Math.pow(2, z));
      var grid = new DistanceGrid(r);
      clusterOf.fill(-1);
      visited.fill(0);
      nextSlot.fill(-1);
      var next = [];
      for (var j = 0; j < level.length; j++) {
        var id = level[j];
        if (visited[id]) continue;
        var px = x[id];
        var py = y[id];
        var origin = grid.queryNearest(px, py, ox, oy);
        if (origin >= 0) {
          visited[id] = 1;
          var clusterId = clusterOf[origin];
          if (clusterId < 0) {
            if (nodeCount >= capacity) grow();
            clusterId = nodeCount++;
            clusterOf[origin] = clusterId;
            zoomArr[clusterId] = z;
            parent[clusterId] = -1;
            firstChild[clusterId] = -1;
            nextSibling[clusterId] = -1;
            visited[origin] = 1;
            parent[origin] = clusterId;
            appendChild(firstChild, nextSibling, clusterId, origin);
            weight[clusterId] = weight[origin];
            x[clusterId] = x[origin];
            y[clusterId] = y[origin];
            lat[clusterId] = lat[origin];
            lng[clusterId] = lng[origin];
            var slot = nextSlot[origin];
            if (slot >= 0) {
              next[slot] = clusterId;
              nextSlot[origin] = -1;
              nextSlot[clusterId] = slot;
            } else {
              nextSlot[clusterId] = next.length;
              next.push(clusterId);
            }
          }
          parent[id] = clusterId;
          appendChild(firstChild, nextSibling, clusterId, id);
          var w = weight[id];
          var cw = weight[clusterId];
          var nw = cw + w;
          x[clusterId] = (x[clusterId] * cw + px * w) / nw;
          y[clusterId] = (y[clusterId] * cw + py * w) / nw;
          lat[clusterId] = (lat[clusterId] * cw + lat[id] * w) / nw;
          lng[clusterId] = (lng[clusterId] * cw + lng[id] * w) / nw;
          weight[clusterId] = nw;
          ox[origin] = x[clusterId];
          oy[origin] = y[clusterId];
          continue;
        }
        visited[id] = 1;
        ox[id] = px;
        oy[id] = py;
        clusterOf[id] = -1;
        grid.insert(px, py, id);
        nextSlot[id] = next.length;
        next.push(id);
      }
      trees[z] = Int32Array.from(next);
      level = next;
    }
  }
  return {
    leafCount: leafCount,
    nodeCount: nodeCount,
    maxZoom: maxZoom,
    minZoom: minZoom,
    minPoints: minPoints,
    radius: radius,
    ids: leafIds,
    x: x.slice(0, nodeCount),
    y: y.slice(0, nodeCount),
    lat: lat.slice(0, nodeCount),
    lng: lng.slice(0, nodeCount),
    weight: weight.slice(0, nodeCount),
    zoom: zoomArr.slice(0, nodeCount),
    parent: parent.slice(0, nodeCount),
    firstChild: firstChild.slice(0, nodeCount),
    nextSibling: nextSibling.slice(0, nodeCount),
    trees: trees
  };
}
function collectLeaves(index, nodeId, out) {
  if (nodeId < index.leafCount) {
    out.push(index.ids[nodeId]);
    return;
  }
  var child = index.firstChild[nodeId];
  while (child >= 0) {
    collectLeaves(index, child, out);
    child = index.nextSibling[child];
  }
}
function queryClusterLayout(index, zoomBucket, minPoints) {
  var singles = [];
  var clusters = [];
  var z = Math.max(index.minZoom, Math.min(index.maxZoom, Math.floor(zoomBucket)));
  if (zoomBucket > index.maxZoom) {
    for (var i = 0; i < index.leafCount; i++) {
      singles.push({ id: index.ids[i], lat: index.lat[i], lng: index.lng[i] });
    }
    return { clusters: clusters, singles: singles };
  }
  var roots = index.trees[z] || [];
  var minP = Math.max(2, Math.floor(minPoints == null ? index.minPoints : minPoints));
  for (var r = 0; r < roots.length; r++) {
    var nodeId = roots[r];
    var w = index.weight[nodeId];
    if (w < minP || nodeId < index.leafCount) {
      if (nodeId < index.leafCount) {
        singles.push({ id: index.ids[nodeId], lat: index.lat[nodeId], lng: index.lng[nodeId] });
      } else {
        var leaves = [];
        collectLeaves(index, nodeId, leaves);
        for (var li = 0; li < leaves.length; li++) {
          var id = leaves[li];
          var leafIndex = -1;
          for (var si = 0; si < index.leafCount; si++) {
            if (index.ids[si] === id) { leafIndex = si; break; }
          }
          if (leafIndex >= 0) singles.push({ id: id, lat: index.lat[leafIndex], lng: index.lng[leafIndex] });
        }
      }
      continue;
    }
    var memberIds = [];
    collectLeaves(index, nodeId, memberIds);
    clusters.push({ key: "z" + z + ":" + nodeId, lat: index.lat[nodeId], lng: index.lng[nodeId], ids: memberIds });
  }
  return { clusters: clusters, singles: singles };
}
function buildClusterLayout(input) {
  if (!input.clusterize) {
    var singles = [];
    var count = Math.min(input.ids.length, Math.floor(input.coords.length / 2));
    for (var i = 0; i < count; i++) {
      singles.push({ id: input.ids[i], lat: input.coords[i * 2], lng: input.coords[i * 2 + 1] });
    }
    return { clusters: [], singles: singles };
  }
  var index = buildClusterIndex(input);
  return queryClusterLayout(index, input.zoomBucket, input.minPoints);
}
function encodeClusterIndex(index) {
  function copyBuf(arr) {
    return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
  }
  var trees = [];
  for (var t = 0; t < index.trees.length; t++) {
    var tree = index.trees[t];
    trees.push({ buffer: copyBuf(tree), length: tree.length });
  }
  var payload = {
    leafCount: index.leafCount,
    nodeCount: index.nodeCount,
    maxZoom: index.maxZoom,
    minZoom: index.minZoom,
    minPoints: index.minPoints,
    radius: index.radius,
    ids: index.ids,
    x: copyBuf(index.x),
    y: copyBuf(index.y),
    lat: copyBuf(index.lat),
    lng: copyBuf(index.lng),
    weight: copyBuf(index.weight),
    zoom: copyBuf(index.zoom),
    parent: copyBuf(index.parent),
    firstChild: copyBuf(index.firstChild),
    nextSibling: copyBuf(index.nextSibling),
    trees: trees
  };
  var transfer = [payload.x, payload.y, payload.lat, payload.lng, payload.weight, payload.zoom, payload.parent, payload.firstChild, payload.nextSibling];
  for (var u = 0; u < trees.length; u++) transfer.push(trees[u].buffer);
  return { payload: payload, transfer: transfer };
}
`;
