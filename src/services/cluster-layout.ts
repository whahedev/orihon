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

class PackedDistanceGrid {
  readonly cellSize: number;
  readonly radius2: number;
  queries = 0;
  inserts = 0;
  probes = 0;
  candidateChecks = 0;
  private readonly trackStats: boolean;
  private readonly mask: number;
  private readonly keyX: Int32Array;
  private readonly keyY: Int32Array;
  private readonly head: Int32Array;
  private readonly next: Int32Array;

  constructor(cellSize: number, pointCapacity: number, trackStats = false) {
    this.cellSize = Math.max(1e-12, cellSize);
    this.trackStats = trackStats;
    this.radius2 = this.cellSize * this.cellSize;
    let tableCapacity = 16;
    const target = Math.max(16, pointCapacity * 2);
    while (tableCapacity < target) tableCapacity *= 2;
    this.mask = tableCapacity - 1;
    this.keyX = new Int32Array(tableCapacity);
    this.keyY = new Int32Array(tableCapacity);
    this.head = new Int32Array(tableCapacity);
    this.head.fill(-1);
    this.next = new Int32Array(pointCapacity);
  }

  private hash(cx: number, cy: number): number {
    return (Math.imul(cx, 0x9e3779b1) ^ Math.imul(cy, 0x85ebca6b)) >>> 0;
  }

  /** Existing slot >= 0; otherwise bitwise-complement insertion slot. */
  private findSlot(cx: number, cy: number): number {
    let slot = this.hash(cx, cy) & this.mask;
    for (;;) {
      if (this.trackStats) this.probes++;
      const head = this.head[slot];
      if (head < 0) return ~slot;
      if (this.keyX[slot] === cx && this.keyY[slot] === cy) return slot;
      slot = (slot + 1) & this.mask;
    }
  }

  insert(x: number, y: number, id: number): void {
    if (this.trackStats) this.inserts++;
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    let slot = this.findSlot(cx, cy);
    if (slot < 0) {
      slot = ~slot;
      this.keyX[slot] = cx;
      this.keyY[slot] = cy;
      this.next[id] = -1;
    } else {
      this.next[id] = this.head[slot];
    }
    this.head[slot] = id;
  }

  queryNearest(x: number, y: number, xs: Float64Array, ys: Float64Array): number {
    if (this.trackStats) this.queries++;
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    let best = -1;
    let bestDist = this.radius2;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const slot = this.findSlot(cx + dx, cy + dy);
        if (slot < 0) continue;
        for (let id = this.head[slot]; id >= 0; id = this.next[id]) {
          if (this.trackStats) this.candidateChecks++;
          const ddx = xs[id] - x;
          const ddy = ys[id] - y;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < bestDist || (best < 0 && d2 <= bestDist)) {
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

  const simpleProjection = input.simple === true;
  for (let i = 0; i < leafCount; i++) {
    const la = coords[i * 2];
    const ln = coords[i * 2 + 1];
    if (simpleProjection) {
      x[i] = ln / TILE_SIZE;
      y[i] = la / TILE_SIZE;
    } else {
      let clampedLat = la;
      if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
      else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
      const wrappedLng = ((ln + 180) % 360 + 360) % 360 - 180;
      const sin = Math.sin((clampedLat * Math.PI) / 180);
      x[i] = (wrappedLng + 180) / 360;
      y[i] = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
    }
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
type GreedyProfile = Record<string, number | boolean | string>;
type GreedyInternalRequest = ClusterLayoutRequest & {
  __greedyProfile?: GreedyProfile;
  /** Internal benchmark knob. 0 forces the pre-D4 grid-only path. */
  __greedyDirectThreshold?: number;
};

function shouldUseAdaptiveDirectGreedy(
  coords: Float64Array | Float32Array,
  count: number,
  cellSize: number,
  directThreshold: number
): boolean {
  const sampleCount = Math.min(count, 64);
  if (sampleCount <= 0 || directThreshold <= 0) return false;
  // Origins can merge across adjacent cells, so allow a modestly wider sample
  // footprint than the live-origin threshold itself. Sparse/regional datasets
  // still fail this gate quickly.
  const sampleCellLimit = Math.min(64, Math.max(directThreshold, directThreshold * 4));
  const sampleX = new Int32Array(sampleCellLimit);
  const sampleY = new Int32Array(sampleCellLimit);
  const degToRad = Math.PI / 180;
  const invFourPi = 1 / (4 * Math.PI);
  let uniqueCells = 0;
  for (let sample = 0; sample < sampleCount; sample++) {
    const i = sampleCount === 1
      ? 0
      : Math.floor((sample * (count - 1)) / (sampleCount - 1));
    const la = coords[i * 2];
    const ln = coords[i * 2 + 1];
    let clampedLat = la;
    if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
    else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
    const wrappedLng = ln >= -180 && ln < 180
      ? ln
      : ((ln + 180) % 360 + 360) % 360 - 180;
    const sin = Math.sin(clampedLat * degToRad);
    const px = (wrappedLng + 180) / 360;
    const py = 0.5 - Math.log((1 + sin) / (1 - sin)) * invFourPi;
    const cx = Math.floor(px / cellSize);
    const cy = Math.floor(py / cellSize);
    let seen = false;
    for (let j = 0; j < uniqueCells; j++) {
      if (sampleX[j] === cx && sampleY[j] === cy) {
        seen = true;
        break;
      }
    }
    if (seen) continue;
    if (uniqueCells >= sampleCellLimit) return false;
    sampleX[uniqueCells] = cx;
    sampleY[uniqueCells] = cy;
    uniqueCells++;
  }
  return true;
}

function buildAdaptiveDirectGreedyLayout(
  input: ClusterLayoutRequest,
  count: number,
  idAt: (index: number) => ClusterLayoutId,
  z: number,
  cellSize: number,
  minPoints: number,
  directThreshold: number,
  profile: GreedyProfile | undefined,
  started: number
): ClusterLayoutResult {
  const now = (): number => typeof performance !== "undefined" ? performance.now() : Date.now();
  const coords = input.coords;
  const degToRad = Math.PI / 180;
  const invFourPi = 1 / (4 * Math.PI);
  const singles: ClusterLayoutSingle[] = [];
  const clusters: ClusterLayoutCluster[] = [];

  const setupStarted = profile ? now() : 0;
  const ox = new Float64Array(count);
  const oy = new Float64Array(count);
  const assigned = new Uint8Array(count);
  const clusterWeight = new Uint32Array(count);
  const clusterTail = new Int32Array(count);
  const nextLeaf = new Int32Array(count);
  const clusterOrigins = new Int32Array(count);
  let clusterOriginCount = 0;

  const directCapacity = directThreshold + 1;
  const directOriginId = new Int32Array(directCapacity);
  const directCellX = new Int32Array(directCapacity);
  const directCellY = new Int32Array(directCapacity);
  const directInsertX = new Float64Array(directCapacity);
  const directInsertY = new Float64Array(directCapacity);
  let insertedOriginCount = 0;
  let directQueries = 0;
  let directOriginScans = 0;
  let directCandidateChecks = 0;
  let grid: PackedDistanceGrid | null = null;
  const setupFinished = profile ? now() : 0;

  const directStarted = profile ? now() : 0;
  let cursor = 0;
  while (cursor < count && insertedOriginCount <= directThreshold) {
    const la = coords[cursor * 2];
    const ln = coords[cursor * 2 + 1];
    let clampedLat = la;
    if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
    else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
    const wrappedLng = ln >= -180 && ln < 180
      ? ln
      : ((ln + 180) % 360 + 360) % 360 - 180;
    const sin = Math.sin(clampedLat * degToRad);
    const px = (wrappedLng + 180) / 360;
    const py = 0.5 - Math.log((1 + sin) / (1 - sin)) * invFourPi;
    const cx = Math.floor(px / cellSize);
    const cy = Math.floor(py / cellSize);
    const radius2 = cellSize * cellSize;
    let origin = -1;
    let bestDist = radius2;
    let bestCellOrder = 10;
    let bestSequence = -1;
    directQueries++;

    for (let sequence = 0; sequence < insertedOriginCount; sequence++) {
      directOriginScans++;
      const dx = directCellX[sequence] - cx;
      if (dx < -1 || dx > 1) continue;
      const dy = directCellY[sequence] - cy;
      if (dy < -1 || dy > 1) continue;
      directCandidateChecks++;
      const candidate = directOriginId[sequence];
      const ddx = ox[candidate] - px;
      const ddy = oy[candidate] - py;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 > bestDist) continue;
      const cellOrder = (dx + 1) * 3 + (dy + 1);
      const precedesBest = cellOrder < bestCellOrder
        || (cellOrder === bestCellOrder && sequence > bestSequence);
      if (d2 < bestDist || origin < 0 || (d2 === bestDist && precedesBest)) {
        bestDist = d2;
        bestCellOrder = cellOrder;
        bestSequence = sequence;
        origin = candidate;
      }
    }

    if (origin >= 0) {
      let w = clusterWeight[origin];
      if (w === 0) {
        w = 1;
        clusterWeight[origin] = 1;
        clusterTail[origin] = origin;
        nextLeaf[origin] = -1;
        clusterOrigins[clusterOriginCount++] = origin;
        assigned[origin] = 1;
      }
      const nw = w + 1;
      ox[origin] = (ox[origin] * w + px) / nw;
      oy[origin] = (oy[origin] * w + py) / nw;
      const tail = clusterTail[origin];
      nextLeaf[tail] = cursor;
      nextLeaf[cursor] = -1;
      clusterTail[origin] = cursor;
      clusterWeight[origin] = nw;
      assigned[cursor] = 1;
    } else {
      ox[cursor] = px;
      oy[cursor] = py;
      directOriginId[insertedOriginCount] = cursor;
      directCellX[insertedOriginCount] = cx;
      directCellY[insertedOriginCount] = cy;
      directInsertX[insertedOriginCount] = px;
      directInsertY[insertedOriginCount] = py;
      insertedOriginCount++;
      if (insertedOriginCount === directCapacity) {
        grid = new PackedDistanceGrid(cellSize, count, Boolean(profile));
        for (let sequence = 0; sequence < directCapacity; sequence++) {
          grid.insert(
            directInsertX[sequence],
            directInsertY[sequence],
            directOriginId[sequence]
          );
        }
      }
    }
    cursor++;
  }
  const directFinished = profile ? now() : 0;

  let projectionMs = 0;
  let gridScanMs = 0;
  let tempProjectedBytes = 0;
  const remaining = count - cursor;
  if (remaining > 0) {
    const projectionStarted = profile ? now() : 0;
    const xs = new Float64Array(remaining);
    const ys = new Float64Array(remaining);
    tempProjectedBytes = remaining * 16;
    for (let j = 0; j < remaining; j++) {
      const i = cursor + j;
      const la = coords[i * 2];
      const ln = coords[i * 2 + 1];
      let clampedLat = la;
      if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
      else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
      const wrappedLng = ln >= -180 && ln < 180
        ? ln
        : ((ln + 180) % 360 + 360) % 360 - 180;
      const sin = Math.sin(clampedLat * degToRad);
      xs[j] = (wrappedLng + 180) / 360;
      ys[j] = 0.5 - Math.log((1 + sin) / (1 - sin)) * invFourPi;
    }
    const projectionFinished = profile ? now() : 0;
    projectionMs = projectionFinished - projectionStarted;
    if (!grid) grid = new PackedDistanceGrid(cellSize, count, Boolean(profile));

    const scanStarted = profile ? now() : 0;
    for (let j = 0; j < remaining; j++) {
      const i = cursor + j;
      const px = xs[j];
      const py = ys[j];
      const origin = grid.queryNearest(px, py, ox, oy);
      if (origin >= 0) {
        let w = clusterWeight[origin];
        if (w === 0) {
          w = 1;
          clusterWeight[origin] = 1;
          clusterTail[origin] = origin;
          nextLeaf[origin] = -1;
          clusterOrigins[clusterOriginCount++] = origin;
          assigned[origin] = 1;
        }
        const nw = w + 1;
        ox[origin] = (ox[origin] * w + px) / nw;
        oy[origin] = (oy[origin] * w + py) / nw;
        const tail = clusterTail[origin];
        nextLeaf[tail] = i;
        nextLeaf[i] = -1;
        clusterTail[origin] = i;
        clusterWeight[origin] = nw;
        assigned[i] = 1;
        continue;
      }
      ox[i] = px;
      oy[i] = py;
      grid.insert(px, py, i);
      insertedOriginCount++;
    }
    const scanFinished = profile ? now() : 0;
    gridScanMs = scanFinished - scanStarted;
  }

  const materializeStarted = profile ? now() : 0;
  let clusterSeq = 0;
  for (let clusterIndex = 0; clusterIndex < clusterOriginCount; clusterIndex++) {
    const origin = clusterOrigins[clusterIndex];
    const weight = clusterWeight[origin];
    if (weight < minPoints) {
      for (let leaf = origin; leaf >= 0; leaf = nextLeaf[leaf]) {
        singles.push({ id: idAt(leaf), lat: coords[leaf * 2], lng: coords[leaf * 2 + 1] });
      }
      continue;
    }
    const ids: ClusterLayoutId[] = new Array(weight);
    let meanLat = 0;
    let meanLng = 0;
    let position = 0;
    for (let leaf = origin; leaf >= 0; leaf = nextLeaf[leaf]) {
      const la = coords[leaf * 2];
      const ln = coords[leaf * 2 + 1];
      ids[position] = idAt(leaf);
      const nextCount = position + 1;
      meanLat = (meanLat * position + la) / nextCount;
      meanLng = (meanLng * position + ln) / nextCount;
      position = nextCount;
    }
    clusters.push({
      key: `g${z}:${clusterSeq++}`,
      lat: meanLat,
      lng: meanLng,
      ids,
      count: weight,
      nodeId: -1
    });
  }
  for (let i = 0; i < count; i++) {
    if (assigned[i]) continue;
    singles.push({ id: idAt(i), lat: coords[i * 2], lng: coords[i * 2 + 1] });
  }
  const materializeFinished = profile ? now() : 0;

  if (profile) {
    const directMs = directFinished - directStarted;
    profile.count = count;
    profile.packedGrid = true;
    profile.adaptiveDirect = true;
    profile.fusedProjection = true;
    profile.fusedProjectionPoints = directQueries;
    profile.bulkProjectionPoints = remaining;
    profile.tempProjectedBytes = tempProjectedBytes;
    profile.projectionMs = projectionMs;
    profile.directMs = directMs;
    profile.gridScanMs = gridScanMs;
    profile.scanMs = directMs + gridScanMs;
    profile.setupMs = setupFinished - setupStarted;
    profile.materializeMs = materializeFinished - materializeStarted;
    profile.totalMs = materializeFinished - started;
    profile.clusterOrigins = clusterOriginCount;
    profile.insertedOrigins = insertedOriginCount;
    profile.clusters = clusters.length;
    profile.singles = singles.length;
    profile.directThreshold = directThreshold;
    profile.directQueries = directQueries;
    profile.directOriginScans = directOriginScans;
    profile.directCandidateChecks = directCandidateChecks;
    profile.packedGridAllocated = Boolean(grid);
    profile.gridQueries = grid?.queries ?? 0;
    profile.gridInserts = grid?.inserts ?? 0;
    profile.hashProbes = grid?.probes ?? 0;
    profile.candidateChecks = grid?.candidateChecks ?? 0;
  }
  return { clusters, singles };
}

function buildGreedyClusterLayout(input: ClusterLayoutRequest): ClusterLayoutResult {
  const coordCount = Math.floor(input.coords.length / 2);
  // The worker deliberately omits arbitrary user ids and returns leaf indices,
  // which GeometryWorkerPool remaps after the transferable result arrives.
  // Keep that compact wire format working alongside the normal id-bearing path.
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

  const internalInput = input as GreedyInternalRequest;
  const profile = internalInput.__greedyProfile;
  const now = (): number => typeof performance !== "undefined" ? performance.now() : Date.now();
  const started = profile ? now() : 0;

  const z = Math.max(0, Math.min(maxZoom, zoomBucket));
  const radius = Math.max(20, Number(input.gridSize) || 50);
  const minPoints = Math.max(2, Math.floor(input.minPoints));
  const cellSize = radius / (TILE_SIZE * 2 ** z);

  const projectionStarted = profile ? now() : 0;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const coords = input.coords;
  const simpleProjection = input.simple === true;
  const degToRad = Math.PI / 180;
  const invFourPi = 1 / (4 * Math.PI);
  for (let i = 0; i < count; i++) {
    const la = coords[i * 2];
    const ln = coords[i * 2 + 1];
    if (simpleProjection) {
      xs[i] = ln / TILE_SIZE;
      ys[i] = la / TILE_SIZE;
    } else {
      let clampedLat = la;
      if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
      else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
      const wrappedLng = ln >= -180 && ln < 180
        ? ln
        : ((ln + 180) % 360 + 360) % 360 - 180;
      const sin = Math.sin(clampedLat * degToRad);
      xs[i] = (wrappedLng + 180) / 360;
      ys[i] = 0.5 - Math.log((1 + sin) / (1 - sin)) * invFourPi;
    }
  }
  const projectionFinished = profile ? now() : 0;

  const packedGridSafe = !simpleProjection
    && count >= 4096
    && count <= 2_000_000
    && cellSize >= 1 / 0x7fffffff;
  const requestedDirectThreshold = Number(internalInput.__greedyDirectThreshold ?? 8);
  const directThreshold = packedGridSafe && Number.isFinite(requestedDirectThreshold)
    ? Math.max(0, Math.min(256, Math.floor(requestedDirectThreshold)))
    : 0;
  if (
    directThreshold > 0
    && shouldUseAdaptiveDirectGreedy(coords, count, cellSize, directThreshold)
  ) {
    return buildAdaptiveDirectGreedyLayout(
      input,
      count,
      idAt,
      z,
      cellSize,
      minPoints,
      directThreshold,
      profile,
      started
    );
  }

  const setupStarted = profile ? now() : 0;
  const grid: DistanceGrid | PackedDistanceGrid = packedGridSafe
    ? new PackedDistanceGrid(cellSize, count, Boolean(profile))
    : new DistanceGrid(cellSize);
  const ox = new Float64Array(count);
  const oy = new Float64Array(count);
  const assigned = new Uint8Array(count);
  const clusterWeight = new Uint32Array(count);
  const clusterTail = new Int32Array(count);
  const nextLeaf = new Int32Array(count);
  const clusterOrigins = new Int32Array(count);
  let clusterOriginCount = 0;
  const setupFinished = profile ? now() : 0;

  const scanStarted = profile ? now() : 0;
  for (let i = 0; i < count; i++) {
    const px = xs[i];
    const py = ys[i];
    const origin = grid.queryNearest(px, py, ox, oy);
    if (origin >= 0) {
      let w = clusterWeight[origin];
      if (w === 0) {
        w = 1;
        clusterWeight[origin] = 1;
        clusterTail[origin] = origin;
        nextLeaf[origin] = -1;
        clusterOrigins[clusterOriginCount++] = origin;
        assigned[origin] = 1;
      }
      const nw = w + 1;
      ox[origin] = (ox[origin] * w + px) / nw;
      oy[origin] = (oy[origin] * w + py) / nw;
      const tail = clusterTail[origin];
      nextLeaf[tail] = i;
      nextLeaf[i] = -1;
      clusterTail[origin] = i;
      clusterWeight[origin] = nw;
      assigned[i] = 1;
      continue;
    }
    ox[i] = px;
    oy[i] = py;
    grid.insert(px, py, i);
  }
  const scanFinished = profile ? now() : 0;

  const materializeStarted = profile ? now() : 0;
  let clusterSeq = 0;
  for (let clusterIndex = 0; clusterIndex < clusterOriginCount; clusterIndex++) {
    const origin = clusterOrigins[clusterIndex];
    const weight = clusterWeight[origin];
    if (weight < minPoints) {
      for (let leaf = origin; leaf >= 0; leaf = nextLeaf[leaf]) {
        singles.push({ id: idAt(leaf), lat: coords[leaf * 2], lng: coords[leaf * 2 + 1] });
      }
      continue;
    }

    const ids: ClusterLayoutId[] = new Array(weight);
    let meanLat = 0;
    let meanLng = 0;
    let position = 0;
    for (let leaf = origin; leaf >= 0; leaf = nextLeaf[leaf]) {
      const la = coords[leaf * 2];
      const ln = coords[leaf * 2 + 1];
      ids[position] = idAt(leaf);
      const nextCount = position + 1;
      meanLat = (meanLat * position + la) / nextCount;
      meanLng = (meanLng * position + ln) / nextCount;
      position = nextCount;
    }
    clusters.push({
      key: `g${z}:${clusterSeq++}`,
      lat: meanLat,
      lng: meanLng,
      ids,
      count: weight,
      nodeId: -1
    });
  }
  for (let i = 0; i < count; i++) {
    if (assigned[i]) continue;
    singles.push({ id: idAt(i), lat: coords[i * 2], lng: coords[i * 2 + 1] });
  }
  const materializeFinished = profile ? now() : 0;

  if (profile) {
    profile.count = count;
    profile.packedGrid = packedGridSafe;
    profile.adaptiveDirect = false;
    profile.fusedProjection = false;
    profile.fusedProjectionPoints = 0;
    profile.bulkProjectionPoints = count;
    profile.tempProjectedBytes = count * 16;
    profile.directThreshold = directThreshold;
    profile.directQueries = 0;
    profile.directOriginScans = 0;
    profile.directCandidateChecks = 0;
    profile.projectionMs = projectionFinished - projectionStarted;
    profile.setupMs = setupFinished - setupStarted;
    profile.scanMs = scanFinished - scanStarted;
    profile.materializeMs = materializeFinished - materializeStarted;
    profile.totalMs = materializeFinished - started;
    profile.clusterOrigins = clusterOriginCount;
    profile.clusters = clusters.length;
    profile.singles = singles.length;
    profile.packedGridAllocated = grid instanceof PackedDistanceGrid;
    if (grid instanceof PackedDistanceGrid) {
      profile.gridQueries = grid.queries;
      profile.gridInserts = grid.inserts;
      profile.insertedOrigins = grid.inserts;
      profile.hashProbes = grid.probes;
      profile.candidateChecks = grid.candidateChecks;
    } else {
      profile.gridQueries = count;
      profile.gridInserts = 0;
      profile.insertedOrigins = 0;
      profile.hashProbes = 0;
      profile.candidateChecks = 0;
    }
  }

  return { clusters, singles };
}
function encodeClusterIndex(index: ClusterIndex): {
  payload: Record<string, unknown>;
  transfer: ArrayBuffer[];
} {
  const view = (arr: Float64Array | Uint32Array | Int8Array | Int32Array) => ({
    buffer: arr.buffer as ArrayBuffer,
    byteOffset: arr.byteOffset,
    length: arr.length
  });

  const x = view(index.x);
  const y = view(index.y);
  const lat = view(index.lat);
  const lng = view(index.lng);
  const weight = view(index.weight);
  const zoom = view(index.zoom);
  const parent = view(index.parent);
  const firstChild = view(index.firstChild);
  const nextSibling = view(index.nextSibling);
  const trees = index.trees.map((tree) => ({
    buffer: tree.buffer as ArrayBuffer,
    byteOffset: tree.byteOffset,
    length: tree.length
  }));

  const payload = {
    leafCount: index.leafCount,
    nodeCount: index.nodeCount,
    maxZoom: index.maxZoom,
    minZoom: index.minZoom,
    minPoints: index.minPoints,
    radius: index.radius,
    x,
    y,
    lat,
    lng,
    weight,
    zoom,
    parent,
    firstChild,
    nextSibling,
    trees
  };

  const transfer: ArrayBuffer[] = [];
  const seen = new Set<ArrayBuffer>();
  const add = (buffer: ArrayBuffer): void => {
    if (buffer.byteLength === 0 || seen.has(buffer)) return;
    seen.add(buffer);
    transfer.push(buffer);
  };

  add(x.buffer);
  add(y.buffer);
  add(lat.buffer);
  add(lng.buffer);
  add(weight.buffer);
  add(zoom.buffer);
  add(parent.buffer);
  add(firstChild.buffer);
  add(nextSibling.buffer);
  for (const tree of trees) add(tree.buffer);

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
  type EncodedClusterView = ArrayBuffer | {
    buffer: ArrayBuffer;
    byteOffset: number;
    length: number;
  };

  const f64 = (value: EncodedClusterView): Float64Array =>
    value instanceof ArrayBuffer
      ? new Float64Array(value)
      : new Float64Array(value.buffer, value.byteOffset, value.length);

  const u32 = (value: EncodedClusterView): Uint32Array =>
    value instanceof ArrayBuffer
      ? new Uint32Array(value)
      : new Uint32Array(value.buffer, value.byteOffset, value.length);

  const i32 = (value: EncodedClusterView): Int32Array =>
    value instanceof ArrayBuffer
      ? new Int32Array(value)
      : new Int32Array(value.buffer, value.byteOffset, value.length);

  const i8 = (value: EncodedClusterView): Int8Array =>
    value instanceof ArrayBuffer
      ? new Int8Array(value)
      : new Int8Array(value.buffer, value.byteOffset, value.length);

  const treesRaw = data.trees as Array<{
    buffer: ArrayBuffer;
    byteOffset?: number;
    length: number;
  }>;

  return {
    leafCount: Number(data.leafCount),
    nodeCount: Number(data.nodeCount),
    maxZoom: Number(data.maxZoom),
    minZoom: Number(data.minZoom),
    minPoints: Number(data.minPoints),
    radius: Number(data.radius),
    ids: (data.ids as ClusterLayoutId[]) || [],
    x: f64(data.x as EncodedClusterView),
    y: f64(data.y as EncodedClusterView),
    lat: f64(data.lat as EncodedClusterView),
    lng: f64(data.lng as EncodedClusterView),
    weight: u32(data.weight as EncodedClusterView),
    zoom: i8(data.zoom as EncodedClusterView),
    parent: i32(data.parent as EncodedClusterView),
    firstChild: i32(data.firstChild as EncodedClusterView),
    nextSibling: i32(data.nextSibling as EncodedClusterView),
    trees: treesRaw.map((tree) =>
      new Int32Array(tree.buffer, tree.byteOffset ?? 0, tree.length)
    )
  };
}function clusterWorkerMain(createRuntime: () => ReturnType<typeof createClusterLayoutRuntime>): void {
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
