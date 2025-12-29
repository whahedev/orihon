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
  /** Simple CRS coordinates use x=lng/TILE_SIZE, y=lat/TILE_SIZE. */
  simple?: boolean;
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

function createClusterLayoutRuntime() {
const MAX_LAT = 85.0511287798066;
const TILE_SIZE = 256;

/** Normalized Web-Mercator in 0..1 (Supercluster-compatible radius scaling). */
function projectMercator01(lat: number, lng: number): { x: number; y: number } {
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

function projectCoordinate01(lat: number, lng: number, simple = false): { x: number; y: number } {
  return simple ? { x: lng / TILE_SIZE, y: lat / TILE_SIZE } : projectMercator01(lat, lng);
}

class DistanceGrid {
  cellSize: number;
  radius2: number;
  /** Packed cell key → ids. One hash lookup beats nested Maps at 100k–1M. */
  private readonly cells = new Map<number, number[]>();
  private bucketPool: number[][] = [];

  constructor(cellSize: number) {
    this.cellSize = Math.max(1e-12, cellSize);
    this.radius2 = this.cellSize * this.cellSize;
  }

  reset(cellSize: number): void {
    for (const bucket of this.cells.values()) {
      bucket.length = 0;
      this.bucketPool.push(bucket);
    }
    this.cells.clear();
    this.cellSize = Math.max(1e-12, cellSize);
    this.radius2 = this.cellSize * this.cellSize;
  }

  insert(x: number, y: number, id: number): void {
    const key = cellKey(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
    const bucket = this.cells.get(key);
    if (bucket) {
      bucket.push(id);
      return;
    }
    const fresh = this.bucketPool.pop() || [];
    fresh.push(id);
    this.cells.set(key, fresh);
  }

  queryNearest(x: number, y: number, xs: Float64Array, ys: Float64Array): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    let best = -1;
    let bestDist = this.radius2;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.cells.get(cellKey(cx + dx, cy + dy));
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

function cellKey(cx: number, cy: number): number {
  return (cx + 0x1000000) * 0x2000000 + (cy + 0x1000000);
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
function buildClusterIndex(input: Omit<ClusterLayoutRequest, "zoomBucket">): ClusterIndex {
  const coordCount = Math.floor(input.coords.length / 2);
  const leafCount = input.ids.length > 0 ? Math.min(input.ids.length, coordCount) : coordCount;
  const maxZoom = Math.max(0, Math.floor(input.clusterMaxZoom));
  const minZoom = Math.max(0, Math.min(maxZoom, Math.floor(input.clusterMinZoom ?? 0)));
  const radius = Math.max(20, Number(input.gridSize) || 50);
  const minPoints = Math.max(2, Math.floor(input.minPoints));
  const leafIds = input.ids;
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
    const p = projectCoordinate01(la, ln, input.simple);
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

function collectClusterLeaves(
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
function queryClusterLayout(
  index: ClusterIndex,
  zoomBucket: number,
  minPoints = index.minPoints,
  options: { expandLeaves?: boolean; leafMask?: Uint8Array | null } = {}
): ClusterLayoutResult {
  const expandLeaves = options.expandLeaves !== false;
  const leafMask = options.leafMask && options.leafMask.length >= index.leafCount ? options.leafMask : null;
  const singles: ClusterLayoutSingle[] = [];
  const clusters: ClusterLayoutCluster[] = [];
  const z = Math.max(index.minZoom, Math.min(index.maxZoom, Math.floor(zoomBucket)));
  const weights = leafMask ? filteredNodeWeights(index, leafMask) : index.weight;

  if (zoomBucket > index.maxZoom) {
    for (let i = 0; i < index.leafCount; i++) {
      if (leafMask && !leafMask[i]) continue;
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

  const pushFilteredLeaves = (nid: number) => {
    if (nid < index.leafCount) {
      if (!leafMask || leafMask[nid]) {
        singles.push({ id: index.ids[nid], lat: index.lat[nid], lng: index.lng[nid] });
      }
      return;
    }
    let c = index.firstChild[nid];
    while (c >= 0) {
      if (!leafMask || weights[c] > 0) pushFilteredLeaves(c);
      c = index.nextSibling[c];
    }
  };

  for (let i = 0; i < roots.length; i++) {
    const nodeId = roots[i];
    const w = weights[nodeId];
    if (leafMask && w === 0) continue;
    if (w < minP || nodeId < index.leafCount) {
      if (nodeId < index.leafCount) {
        singles.push({ id: index.ids[nodeId], lat: index.lat[nodeId], lng: index.lng[nodeId] });
      } else if (expandLeaves && leafPos) {
        const leaves: ClusterLayoutId[] = [];
        collectClusterLeaves(index, nodeId, leaves);
        for (const id of leaves) {
          const leafIndex = leafPos.get(id);
          if (leafIndex == null) continue;
          if (leafMask && !leafMask[leafIndex]) continue;
          singles.push({ id, lat: index.lat[leafIndex], lng: index.lng[leafIndex] });
        }
      } else {
        pushFilteredLeaves(nodeId);
      }
      continue;
    }
    if (expandLeaves) {
      const memberIds: ClusterLayoutId[] = [];
      collectClusterLeaves(index, nodeId, memberIds);
      const ids = leafMask
        ? memberIds.filter((id) => {
          const leafIndex = leafPos?.get(id);
          return leafIndex == null ? true : Boolean(leafMask[leafIndex]);
        })
        : memberIds;
      clusters.push({
        key: `z${z}:${nodeId}`,
        lat: index.lat[nodeId],
        lng: index.lng[nodeId],
        ids,
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

/** Parents have higher ids than children, so one forward pass sums a filter mask. */
function filteredNodeWeights(index: ClusterIndex, mask: Uint8Array): Uint32Array {
  const weights = new Uint32Array(index.nodeCount);
  for (let i = 0; i < index.leafCount; i++) weights[i] = mask[i];
  for (let i = index.leafCount; i < index.nodeCount; i++) {
    let sum = 0;
    let child = index.firstChild[i];
    while (child >= 0) {
      sum += weights[child];
      child = index.nextSibling[child];
    }
    weights[i] = sum;
  }
  return weights;
}

/** Build index and query one zoom — drop-in for previous grid API. */
function buildClusterLayout(input: ClusterLayoutRequest): ClusterLayoutResult {
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
function buildGreedyClusterLayout(input: ClusterLayoutRequest): ClusterLayoutResult {
  const coordCount = Math.floor(input.coords.length / 2);
  // Workers intentionally omit arbitrary user ids to avoid cloning a 1M-element
  // JS array. In that mode layout ids are leaf indices and the caller remaps only
  // the small result set that crosses the worker boundary.
  const hasIds = input.ids.length > 0;
  const count = hasIds ? Math.min(input.ids.length, coordCount) : coordCount;
  const idAt = (index: number): ClusterLayoutId => hasIds ? input.ids[index] : index;
  const singles: ClusterLayoutSingle[] = [];
  const clusters: ClusterLayoutCluster[] = [];
  if (!input.clusterize || count === 0) {
    for (let i = 0; i < count; i++) {
      singles.push({ id: idAt(i), lat: input.coords[i * 2], lng: input.coords[i * 2 + 1] });
    }
    return { clusters, singles };
  }

  const zoomBucket = Math.floor(input.zoomBucket);
  const maxZoom = Math.max(0, Math.floor(input.clusterMaxZoom));
  if (zoomBucket > maxZoom) {
    for (let i = 0; i < count; i++) {
      singles.push({ id: idAt(i), lat: input.coords[i * 2], lng: input.coords[i * 2 + 1] });
    }
    return { clusters, singles };
  }

  const z = Math.max(0, Math.min(maxZoom, zoomBucket));
  const radius = Math.max(20, Number(input.gridSize) || 50);
  const minPoints = Math.max(2, Math.floor(input.minPoints));
  const grid = new DistanceGrid(radius / (TILE_SIZE * 2 ** z));

  const coords = input.coords;
  const ox = new Float64Array(count);
  const oy = new Float64Array(count);
  const assigned = new Uint8Array(count);
  type Acc = { lat: number; lng: number; w: number; leaves: number[] | null };
  const byOrigin = new Map<number, Acc>();
  /** Keep leaf ids only for small clusters — 1M greedy must not allocate 1M id arrays. */
  const expandLeavesUntil = 256;

  for (let i = 0; i < count; i++) {
    const la = coords[i * 2];
    const ln = coords[i * 2 + 1];
    let px: number;
    let py: number;
    if (input.simple) {
      px = ln / TILE_SIZE;
      py = la / TILE_SIZE;
    } else {
      let clampedLat = la;
      if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
      else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
      const wrappedLng = ((ln + 180) % 360 + 360) % 360 - 180;
      const sin = Math.sin((clampedLat * Math.PI) / 180);
      px = (wrappedLng + 180) / 360;
      py = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
    }
    const origin = grid.queryNearest(px, py, ox, oy);
    if (origin >= 0) {
      let acc = byOrigin.get(origin);
      if (!acc) {
        acc = { lat: coords[origin * 2], lng: coords[origin * 2 + 1], w: 1, leaves: [origin] };
        byOrigin.set(origin, acc);
        assigned[origin] = 1;
      }
      const w = acc.w;
      const nw = w + 1;
      ox[origin] = (ox[origin] * w + px) / nw;
      oy[origin] = (oy[origin] * w + py) / nw;
      acc.lat = (acc.lat * w + la) / nw;
      acc.lng = (acc.lng * w + ln) / nw;
      acc.w = nw;
      if (acc.leaves) {
        if (nw >= minPoints && acc.leaves.length >= expandLeavesUntil) acc.leaves = null;
        else acc.leaves.push(i);
      }
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
      for (const leaf of acc.leaves ?? []) {
        singles.push({ id: idAt(leaf), lat: coords[leaf * 2], lng: coords[leaf * 2 + 1] });
      }
      continue;
    }
    const ids: ClusterLayoutId[] = acc.leaves
      ? acc.leaves.map((leaf) => idAt(leaf))
      : [];
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
    singles.push({ id: idAt(i), lat: coords[i * 2], lng: coords[i * 2 + 1] });
  }

  return { clusters, singles };
}

function encodeClusterIndex(index: ClusterIndex): {
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


  return {
    projectMercator01,
    buildClusterIndex,
    collectClusterLeaves,
    queryClusterLayout,
    buildClusterLayout,
    buildGreedyClusterLayout,
    encodeClusterIndex
  };
}

const clusterRuntime = createClusterLayoutRuntime();
export const projectMercator01 = clusterRuntime.projectMercator01;
export const buildClusterIndex = clusterRuntime.buildClusterIndex;
export const collectClusterLeaves = clusterRuntime.collectClusterLeaves;
export const queryClusterLayout = clusterRuntime.queryClusterLayout;
export const buildClusterLayout = clusterRuntime.buildClusterLayout;
export const buildGreedyClusterLayout = clusterRuntime.buildGreedyClusterLayout;
export const encodeClusterIndex = clusterRuntime.encodeClusterIndex;

export function decodeClusterIndex(data: Record<string, unknown>): ClusterIndex {
  const treesRaw = data.trees as Array<{ buffer: ArrayBuffer; length: number }>;
  return {
    leafCount: Number(data.leafCount),
    nodeCount: Number(data.nodeCount),
    maxZoom: Number(data.maxZoom),
    minZoom: Number(data.minZoom),
    minPoints: Number(data.minPoints),
    radius: Number(data.radius),
    ids: (data.ids as ClusterLayoutId[]) || [],
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

function clusterWorkerMain(createRuntime: () => ReturnType<typeof createClusterLayoutRuntime>): void {
  const api = createRuntime();
  const scope = globalThis as typeof globalThis & {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
  };
  function normalizePoint(value: unknown): [number, number] | null {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
    const source = Array.isArray(value) || (record && typeof record.lat === "number" && typeof record.lng === "number")
      ? value
      : record && (record.coordinates || record.latlng);
    if (!source) return null;
    const lat = Array.isArray(source) ? Number(source[0]) : Number((source as { lat: number }).lat);
    const lng = Array.isArray(source) ? Number(source[1]) : Number((source as { lng: number }).lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return [lat, lng];
  }
  function asCoords(value: unknown): Float64Array {
    if (value instanceof Float64Array) return value;
    if (value instanceof Float32Array) return new Float64Array(value);
    return new Float64Array((value ?? []) as ArrayLike<number>);
  }
  scope.onmessage = function (event: MessageEvent) {
    const data = (event.data || {}) as {
      id?: unknown;
      type?: string;
      ids?: ClusterLayoutId[];
      coords?: ArrayLike<number>;
      gridSize?: number;
      minPoints?: number;
      clusterize?: boolean;
      clusterMaxZoom?: number;
      clusterMinZoom?: number;
      zoomBucket?: number;
      simple?: boolean;
      points?: unknown[];
    };
    const id = data.id;
    if (data.type === "clusterIndex") {
      const index = api.buildClusterIndex({
        ids: [],
        coords: asCoords(data.coords),
        gridSize: data.gridSize ?? 50,
        minPoints: data.minPoints ?? 2,
        clusterize: Boolean(data.clusterize),
        clusterMaxZoom: data.clusterMaxZoom ?? 0,
        clusterMinZoom: data.clusterMinZoom
      });
      const encoded = api.encodeClusterIndex(index);
      scope.postMessage({ id, type: "clusterIndex", index: encoded.payload }, encoded.transfer);
      return;
    }
    if (data.type === "clusterLayout") {
      const result = api.buildClusterLayout({
        ids: data.ids ?? [],
        coords: asCoords(data.coords),
        zoomBucket: data.zoomBucket ?? 0,
        gridSize: data.gridSize ?? 50,
        minPoints: data.minPoints ?? 2,
        clusterize: Boolean(data.clusterize),
        clusterMaxZoom: data.clusterMaxZoom ?? 0,
        clusterMinZoom: data.clusterMinZoom
      });
      scope.postMessage({ id, type: "clusterLayout", clusters: result.clusters, singles: result.singles });
      return;
    }
    if (data.type === "greedyClusterLayout") {
      const result = api.buildGreedyClusterLayout({
        ids: [],
        coords: asCoords(data.coords),
        zoomBucket: data.zoomBucket ?? 0,
        gridSize: data.gridSize ?? 50,
        minPoints: data.minPoints ?? 2,
        clusterize: Boolean(data.clusterize),
        clusterMaxZoom: data.clusterMaxZoom ?? 0,
        clusterMinZoom: data.clusterMinZoom,
        simple: Boolean(data.simple)
      });
      scope.postMessage({ id, type: "greedyClusterLayout", clusters: result.clusters, singles: result.singles });
      return;
    }
    const values: number[] = [];
    let skipped = 0;
    const points = data.points || [];
    for (let i = 0; i < points.length; i++) {
      const point = normalizePoint(points[i]);
      if (!point) {
        skipped++;
        continue;
      }
      values.push(point[0], point[1]);
    }
    const output = new Float32Array(values);
    scope.postMessage({ id, type: "preparePoints", points: output.buffer, count: output.length / 2, skipped }, [output.buffer]);
  };
}

/** Runtime worker blob: same clustering functions as the main thread (no second copy in the bundle). */
export function clusterLayoutWorkerSource(): string {
  return "var c=" + createClusterLayoutRuntime.toString() + ";\n(" + clusterWorkerMain.toString() + ")(c);";
}
