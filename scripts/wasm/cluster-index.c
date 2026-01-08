#include <stdint.h>
#include <stddef.h>

typedef union { double d; uint64_t u; } DU;

#define MAGIC 0x3143574fU /* OWC1 */
#define VERSION 1U
#define HEADER_WORDS 32U
#define HEADER_BYTES (HEADER_WORDS * 4U)
#define TILE_SIZE 256.0
#define MAX_LAT 85.0511287798066
#define PI 3.14159265358979323846264338327950288
#define LN2 0.693147180559945309417232121458176568
#define WASM_PAGE_BYTES 65536U

static uint32_t g_result_ptr = 0U;
static uint32_t g_result_bytes = 0U;
static uint32_t g_peak_end = 0U;
static uint32_t g_tree_bytes = 0U;
static uint32_t g_permanent_bytes = 0U;
static uint32_t g_transient_bytes = 0U;
static uint32_t g_grow_pages = 0U;

static inline uint32_t align8(uint32_t n) { return (n + 7U) & ~7U; }
static inline uint32_t align4(uint32_t n) { return (n + 3U) & ~3U; }
static inline uint64_t align64(uint64_t n, uint64_t a) { return (n + (a - 1ULL)) & ~(a - 1ULL); }

static inline double fast_sin(double x) {
  double x2 = x * x;
  double p = -1.0 / 6227020800.0;
  p = 1.0 / 39916800.0 + p * x2;
  p = -1.0 / 362880.0 + p * x2;
  p = 1.0 / 5040.0 + p * x2;
  p = -1.0 / 120.0 + p * x2;
  p = 1.0 / 6.0 + p * x2;
  return x * (1.0 - x2 * p);
}

static inline double fast_log(double x) {
  if (x <= 0.0) return -1.0e300;
  DU v; v.d = x;
  int e = (int)((v.u >> 52) & 0x7ffU) - 1023;
  v.u = (v.u & 0x000fffffffffffffULL) | 0x3ff0000000000000ULL;
  double m = v.d;
  if (m > 1.4142135623730950488) { m *= 0.5; e += 1; }
  double y = (m - 1.0) / (m + 1.0);
  double y2 = y * y;
  double term = y;
  double sum = term;
  term *= y2; sum += term / 3.0;
  term *= y2; sum += term / 5.0;
  term *= y2; sum += term / 7.0;
  term *= y2; sum += term / 9.0;
  term *= y2; sum += term / 11.0;
  term *= y2; sum += term / 13.0;
  term *= y2; sum += term / 15.0;
  term *= y2; sum += term / 17.0;
  return 2.0 * sum + (double)e * LN2;
}

static inline double floor_d(double x) { return __builtin_floor(x); }
static inline int32_t floor_i32(double x) { return (int32_t)floor_d(x); }

static inline uint32_t hash_cell(int32_t cx, int32_t cy) {
  uint32_t x = (uint32_t)cx;
  uint32_t y = (uint32_t)cy;
  return (x * 0x9e3779b1U) ^ (y * 0x85ebca6bU);
}

static inline void fill_i32(int32_t *a, uint32_t n, int32_t v) {
  for (uint32_t i = 0; i < n; i++) a[i] = v;
}
static inline void fill_u32(uint32_t *a, uint32_t n, uint32_t v) {
  for (uint32_t i = 0; i < n; i++) a[i] = v;
}

static uint32_t next_pow2(uint32_t v) {
  uint32_t p = 1U;
  while (p < v && p < 0x80000000U) p <<= 1U;
  return p;
}

typedef struct {
  uint8_t *p;
  uint8_t *end;
  int failed;
} Arena;

static void *arena_take(Arena *a, uint32_t bytes, uint32_t align) {
  uintptr_t p = (uintptr_t)a->p;
  uintptr_t q = (p + (align - 1U)) & ~(uintptr_t)(align - 1U);
  if (q + bytes > (uintptr_t)a->end) { a->failed = 1; return (void*)0; }
  a->p = (uint8_t*)(q + bytes);
  return (void*)q;
}

static int ensure_memory_end(uint32_t requiredEnd) {
  uint64_t pages = (uint64_t)__builtin_wasm_memory_size(0);
  uint64_t current = pages * (uint64_t)WASM_PAGE_BYTES;
  if ((uint64_t)requiredEnd <= current) {
    if (requiredEnd > g_peak_end) g_peak_end = requiredEnd;
    return 1;
  }
  uint64_t need = (uint64_t)requiredEnd - current;
  uint64_t delta = (need + WASM_PAGE_BYTES - 1U) / WASM_PAGE_BYTES;
  if (delta > 0xffffffffULL) return 0;
  uint32_t oldPages = (uint32_t)__builtin_wasm_memory_grow(0, (uint32_t)delta);
  if (oldPages == 0xffffffffU) return 0;
  g_grow_pages += (uint32_t)delta;
  if (requiredEnd > g_peak_end) g_peak_end = requiredEnd;
  return 1;
}

static void move_bytes(uint8_t *dst, const uint8_t *src, uint32_t bytes) {
  if (bytes == 0U || dst == src) return;
  __builtin_memmove(dst, src, (size_t)bytes);
}

/*
 * P2 grid entries are indexed 0..entryCount-1 instead of by node id.
 * This removes four 2N-sized node maps/stamps from P1 while preserving insertion
 * order and tie behaviour. An entry keeps the original origin id, the cluster id
 * that replaced it (if any), and the slot in nextBuf that must be replaced on
 * first merge.
 */
typedef struct {
  double cellSize;
  double radius2;
  uint32_t mask;
  uint32_t stamp;
  int32_t *keyX;
  int32_t *keyY;
  int32_t *head;
  int32_t *tail;
  uint32_t *slotStamp;
  int32_t *entryNext;
  int32_t *entryId;
  int32_t *entryCluster;
  int32_t *entrySlot;
  uint32_t entryCount;
  uint32_t entryCapacity;
  const double *x;
  const double *y;
} Grid;

static int32_t grid_find_slot(Grid *g, int32_t cx, int32_t cy, int create) {
  uint32_t slot = hash_cell(cx, cy) & g->mask;
  for (;;) {
    if (g->slotStamp[slot] != g->stamp) {
      if (!create) return -1;
      g->slotStamp[slot] = g->stamp;
      g->keyX[slot] = cx;
      g->keyY[slot] = cy;
      g->head[slot] = -1;
      g->tail[slot] = -1;
      return (int32_t)slot;
    }
    if (g->keyX[slot] == cx && g->keyY[slot] == cy) return (int32_t)slot;
    slot = (slot + 1U) & g->mask;
  }
}

static void grid_reset(Grid *g, double cellSize) {
  g->cellSize = cellSize < 1e-12 ? 1e-12 : cellSize;
  g->radius2 = g->cellSize * g->cellSize;
  g->entryCount = 0U;
  g->stamp++;
  if (g->stamp == 0U) {
    fill_u32(g->slotStamp, g->mask + 1U, 0U);
    g->stamp = 1U;
  }
}

static int32_t grid_insert(Grid *g, double x, double y, int32_t id, int32_t nextSlot) {
  if (g->entryCount >= g->entryCapacity) return -1;
  int32_t cx = floor_i32(x / g->cellSize);
  int32_t cy = floor_i32(y / g->cellSize);
  int32_t slot = grid_find_slot(g, cx, cy, 1);
  uint32_t entry = g->entryCount++;
  g->entryId[entry] = id;
  g->entryCluster[entry] = -1;
  g->entrySlot[entry] = nextSlot;
  g->entryNext[entry] = -1;
  if (g->head[slot] < 0) {
    g->head[slot] = (int32_t)entry;
    g->tail[slot] = (int32_t)entry;
  } else {
    g->entryNext[g->tail[slot]] = (int32_t)entry;
    g->tail[slot] = (int32_t)entry;
  }
  return (int32_t)entry;
}

static int32_t grid_query(Grid *g, double x, double y) {
  int32_t cx = floor_i32(x / g->cellSize);
  int32_t cy = floor_i32(y / g->cellSize);
  int32_t bestEntry = -1;
  double bestDist = g->radius2;
  for (int32_t dx = -1; dx <= 1; dx++) {
    for (int32_t dy = -1; dy <= 1; dy++) {
      int32_t slot = grid_find_slot(g, cx + dx, cy + dy, 0);
      if (slot < 0) continue;
      for (int32_t e = g->head[slot]; e >= 0; e = g->entryNext[e]) {
        int32_t id = g->entryCluster[e] >= 0 ? g->entryCluster[e] : g->entryId[e];
        double ddx = g->x[id] - x;
        double ddy = g->y[id] - y;
        double d2 = ddx * ddx + ddy * ddy;
        if (d2 <= bestDist) { bestDist = d2; bestEntry = e; }
      }
    }
  }
  return bestEntry;
}

static inline uint32_t node_weight(uint32_t leafCount, const uint32_t *clusterWeight, int32_t id) {
  return (uint32_t)id < leafCount ? 1U : clusterWeight[(uint32_t)id - leafCount];
}
static inline double node_lat(uint32_t leafCount, const double *coords, const double *clusterLat, int32_t id) {
  return (uint32_t)id < leafCount ? coords[(uint32_t)id * 2U] : clusterLat[(uint32_t)id - leafCount];
}
static inline double node_lng(uint32_t leafCount, const double *coords, const double *clusterLng, int32_t id) {
  return (uint32_t)id < leafCount ? coords[(uint32_t)id * 2U + 1U] : clusterLng[(uint32_t)id - leafCount];
}
static inline int8_t node_zoom(uint32_t leafCount, uint32_t maxZoom, const int8_t *clusterZoom, uint32_t id) {
  return id < leafCount ? (int8_t)(maxZoom + 1U) : clusterZoom[id - leafCount];
}
static inline int32_t node_first_child(uint32_t leafCount, const int32_t *clusterFirst, uint32_t id) {
  return id < leafCount ? -1 : clusterFirst[id - leafCount];
}
static inline void append_child(uint32_t leafCount, int32_t *clusterFirst, int32_t *nextSibling, int32_t parentId, int32_t childId) {
  uint32_t ci = (uint32_t)parentId - leafCount;
  nextSibling[childId] = clusterFirst[ci];
  clusterFirst[ci] = childId;
}

static uint32_t scratch_layout_bytes(uint32_t count, uint32_t maxZoom, uint32_t minZoom, uint32_t *permanentOut) {
  (void)minZoom;
  uint64_t capacity = (uint64_t)count * 2ULL + 64ULL;
  if (capacity < 32ULL) capacity = 32ULL;
  uint64_t hcap = (uint64_t)next_pow2(count < 8U ? 16U : count * 2U);
  uint64_t p = 0ULL;
#define TAKE64(B,A) do { p = align64(p,(A)); p += (uint64_t)(B); } while (0)
  TAKE64(capacity * 8ULL, 8ULL); /* x */
  TAKE64(capacity * 8ULL, 8ULL); /* y */
  TAKE64((uint64_t)count * 8ULL, 8ULL); /* cluster lat */
  TAKE64((uint64_t)count * 8ULL, 8ULL); /* cluster lng */
  TAKE64((uint64_t)count * 4ULL, 4ULL); /* cluster weight */
  TAKE64((uint64_t)count, 1ULL);       /* cluster zoom */
  TAKE64(capacity * 4ULL, 4ULL);       /* parent */
  TAKE64((uint64_t)count * 4ULL, 4ULL);/* cluster first child */
  TAKE64(capacity * 4ULL, 4ULL);       /* next sibling */
  TAKE64((uint64_t)(maxZoom + 1U) * 4ULL, 4ULL); /* tree offsets */
  TAKE64((uint64_t)(maxZoom + 1U) * 4ULL, 4ULL); /* tree lengths */
  p = align64(p, 8ULL);
  uint64_t permanent = p;
  TAKE64((uint64_t)count * 4ULL, 4ULL); /* level A */
  TAKE64((uint64_t)count * 4ULL, 4ULL); /* level B */
  TAKE64((uint64_t)count * 4ULL, 4ULL); /* entry id */
  TAKE64((uint64_t)count * 4ULL, 4ULL); /* entry cluster */
  TAKE64((uint64_t)count * 4ULL, 4ULL); /* entry slot */
  TAKE64((uint64_t)count * 4ULL, 4ULL); /* entry next */
  TAKE64(hcap * 4ULL, 4ULL); /* key x */
  TAKE64(hcap * 4ULL, 4ULL); /* key y */
  TAKE64(hcap * 4ULL, 4ULL); /* head */
  TAKE64(hcap * 4ULL, 4ULL); /* tail */
  TAKE64(hcap * 4ULL, 4ULL); /* slot stamp */
  p = align64(p, 8ULL);
#undef TAKE64
  if (p > 0xffffffffULL || permanent > 0xffffffffULL) return 0U;
  if (permanentOut) *permanentOut = (uint32_t)permanent;
  return (uint32_t)p;
}

__attribute__((export_name("cluster_scratch_bytes")))
uint32_t cluster_scratch_bytes(uint32_t count, uint32_t maxZoom, uint32_t minZoom) {
  if (minZoom > maxZoom) minZoom = maxZoom;
  return scratch_layout_bytes(count, maxZoom, minZoom, (uint32_t*)0);
}

/* Kept as telemetry: P1's old worst-case output reservation. P2 does not reserve it. */
__attribute__((export_name("cluster_output_max_bytes")))
uint32_t cluster_output_max_bytes(uint32_t count, uint32_t maxZoom, uint32_t minZoom) {
  if (minZoom > maxZoom) minZoom = maxZoom;
  uint64_t cap = (uint64_t)count * 2ULL + 64ULL;
  uint64_t levels = (uint64_t)(maxZoom - minZoom + 1U);
  uint64_t bytes = HEADER_BYTES + (uint64_t)(maxZoom + 1U) * 8ULL + 64ULL;
  bytes += cap * (8ULL * 4ULL + 4ULL * 4ULL + 1ULL);
  bytes += (uint64_t)count * levels * 4ULL;
  if (bytes > 0xffffffffULL) return 0U;
  return align8((uint32_t)bytes);
}

__attribute__((export_name("cluster_result_ptr"))) uint32_t cluster_result_ptr(void) { return g_result_ptr; }
__attribute__((export_name("cluster_peak_end"))) uint32_t cluster_peak_end(void) { return g_peak_end; }
__attribute__((export_name("cluster_tree_bytes"))) uint32_t cluster_tree_bytes(void) { return g_tree_bytes; }
__attribute__((export_name("cluster_permanent_bytes"))) uint32_t cluster_permanent_bytes(void) { return g_permanent_bytes; }
__attribute__((export_name("cluster_transient_bytes"))) uint32_t cluster_transient_bytes(void) { return g_transient_bytes; }
__attribute__((export_name("cluster_grow_pages"))) uint32_t cluster_grow_pages(void) { return g_grow_pages; }

__attribute__((export_name("build_cluster_index")))
int32_t build_cluster_index(
  uint32_t coordsPtr,
  uint32_t count,
  double radius,
  uint32_t minPoints,
  uint32_t clusterize,
  uint32_t maxZoom,
  uint32_t minZoom,
  uint32_t simple,
  uint32_t scratchPtr,
  uint32_t scratchBytes,
  uint32_t unusedOutputPtr,
  uint32_t unusedOutputCapacity
) {
  (void)unusedOutputPtr; (void)unusedOutputCapacity;
  g_result_ptr = 0U; g_result_bytes = 0U; g_peak_end = scratchPtr + scratchBytes;
  g_tree_bytes = 0U; g_permanent_bytes = 0U; g_transient_bytes = 0U; g_grow_pages = 0U;

  if (minZoom > maxZoom) minZoom = maxZoom;
  if (radius < 20.0) radius = 20.0;
  if (minPoints < 2U) minPoints = 2U;
  uint32_t expectedPermanent = 0U;
  uint32_t expectedScratch = scratch_layout_bytes(count, maxZoom, minZoom, &expectedPermanent);
  if (expectedScratch == 0U || scratchBytes < expectedScratch) return -1;
  if (!ensure_memory_end(scratchPtr + expectedScratch)) return -5;

  uint32_t capacity = count * 2U + 64U;
  if (capacity < 32U) capacity = 32U;
  Arena a = { (uint8_t*)(uintptr_t)scratchPtr, (uint8_t*)(uintptr_t)(scratchPtr + expectedScratch), 0 };

  double *x = (double*)arena_take(&a, capacity * 8U, 8U);
  double *y = (double*)arena_take(&a, capacity * 8U, 8U);
  double *clusterLat = (double*)arena_take(&a, count * 8U, 8U);
  double *clusterLng = (double*)arena_take(&a, count * 8U, 8U);
  uint32_t *clusterWeight = (uint32_t*)arena_take(&a, count * 4U, 4U);
  int8_t *clusterZoom = (int8_t*)arena_take(&a, count, 1U);
  int32_t *parent = (int32_t*)arena_take(&a, capacity * 4U, 4U);
  int32_t *clusterFirst = (int32_t*)arena_take(&a, count * 4U, 4U);
  int32_t *nextSibling = (int32_t*)arena_take(&a, capacity * 4U, 4U);
  uint32_t *treeOffsets = (uint32_t*)arena_take(&a, (maxZoom + 1U) * 4U, 4U);
  uint32_t *treeLens = (uint32_t*)arena_take(&a, (maxZoom + 1U) * 4U, 4U);
  uintptr_t permanentEnd = ((uintptr_t)a.p + 7U) & ~(uintptr_t)7U;
  a.p = (uint8_t*)permanentEnd;
  uint32_t outputPtr = (uint32_t)permanentEnd;

  int32_t *levelA = (int32_t*)arena_take(&a, count * 4U, 4U);
  int32_t *levelB = (int32_t*)arena_take(&a, count * 4U, 4U);
  int32_t *entryId = (int32_t*)arena_take(&a, count * 4U, 4U);
  int32_t *entryCluster = (int32_t*)arena_take(&a, count * 4U, 4U);
  int32_t *entrySlot = (int32_t*)arena_take(&a, count * 4U, 4U);
  int32_t *entryNext = (int32_t*)arena_take(&a, count * 4U, 4U);

  uint32_t hcap = next_pow2(count < 8U ? 16U : count * 2U);
  int32_t *keyX = (int32_t*)arena_take(&a, hcap * 4U, 4U);
  int32_t *keyY = (int32_t*)arena_take(&a, hcap * 4U, 4U);
  int32_t *gridHead = (int32_t*)arena_take(&a, hcap * 4U, 4U);
  int32_t *gridTail = (int32_t*)arena_take(&a, hcap * 4U, 4U);
  uint32_t *slotStamp = (uint32_t*)arena_take(&a, hcap * 4U, 4U);
  if (a.failed) return -1;

  g_permanent_bytes = outputPtr - scratchPtr;
  g_transient_bytes = expectedScratch - g_permanent_bytes;

  fill_i32(parent, capacity, -1);
  fill_i32(nextSibling, capacity, -1);
  fill_i32(clusterFirst, count, -1);
  fill_u32(slotStamp, hcap, 0U);
  fill_u32(treeOffsets, maxZoom + 1U, 0U);
  fill_u32(treeLens, maxZoom + 1U, 0U);

  const double *coords = (const double*)(uintptr_t)coordsPtr;
  const double degToRad = PI / 180.0;
  const double invFourPi = 1.0 / (4.0 * PI);
  for (uint32_t i = 0; i < count; i++) {
    double la = coords[i * 2U];
    double ln = coords[i * 2U + 1U];
    if (simple) {
      x[i] = ln / TILE_SIZE;
      y[i] = la / TILE_SIZE;
    } else {
      double clampedLat = la;
      if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
      else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
      double wrappedLng = ln;
      if (!(ln >= -180.0 && ln < 180.0)) {
        wrappedLng = ln + 180.0;
        wrappedLng -= floor_d(wrappedLng / 360.0) * 360.0;
        wrappedLng -= 180.0;
      }
      double s = fast_sin(clampedLat * degToRad);
      double ratio = (1.0 + s) / (1.0 - s);
      x[i] = (wrappedLng + 180.0) / 360.0;
      y[i] = 0.5 - fast_log(ratio) * invFourPi;
    }
    levelA[i] = (int32_t)i;
  }

  uint32_t nodeCount = count;
  uint32_t levelLen = count;
  int32_t *level = levelA;
  int32_t *nextBuf = levelB;
  uint32_t treeStoreLen = 0U;
  uint32_t treeBase = align8(scratchPtr + expectedScratch);

  Grid grid;
  grid.mask = hcap - 1U;
  grid.stamp = 0U;
  grid.keyX = keyX; grid.keyY = keyY; grid.head = gridHead; grid.tail = gridTail;
  grid.slotStamp = slotStamp;
  grid.entryNext = entryNext; grid.entryId = entryId; grid.entryCluster = entryCluster; grid.entrySlot = entrySlot;
  grid.entryCapacity = count;
  grid.x = x; grid.y = y;

  if (!clusterize || count == 0U) {
    for (uint32_t z = minZoom; z <= maxZoom; z++) {
      treeOffsets[z] = treeStoreLen;
      treeLens[z] = levelLen;
      uint64_t nextTreeBytes64 = ((uint64_t)treeStoreLen + levelLen) * 4ULL;
      if (nextTreeBytes64 > 0xffffffffULL) return -3;
      uint32_t nextTreeBytes = (uint32_t)nextTreeBytes64;
      if (!ensure_memory_end(treeBase + nextTreeBytes)) return -5;
      int32_t *treeStore = (int32_t*)(uintptr_t)treeBase;
      for (uint32_t i = 0; i < levelLen; i++) treeStore[treeStoreLen + i] = level[i];
      treeStoreLen += levelLen;
    }
  } else {
    for (int32_t z = (int32_t)maxZoom; z >= (int32_t)minZoom; z--) {
      double cell = radius / (TILE_SIZE * (double)(1U << (z > 30 ? 30 : z)));
      if (z > 30) for (int32_t k = 30; k < z; k++) cell *= 0.5;
      grid_reset(&grid, cell);
      uint32_t nextLen = 0U;

      for (uint32_t i = 0; i < levelLen; i++) {
        int32_t id = level[i];
        double px = x[id], py = y[id];
        int32_t entry = grid_query(&grid, px, py);
        if (entry >= 0) {
          int32_t origin = entryId[entry];
          int32_t clusterId = entryCluster[entry];
          if (clusterId < 0) {
            if (nodeCount >= capacity) return -2;
            clusterId = (int32_t)nodeCount++;
            uint32_t ci = (uint32_t)clusterId - count;
            if (ci >= count) return -2;
            entryCluster[entry] = clusterId;
            clusterZoom[ci] = (int8_t)z;
            parent[clusterId] = -1;
            clusterFirst[ci] = -1;
            nextSibling[clusterId] = -1;
            parent[origin] = clusterId;
            append_child(count, clusterFirst, nextSibling, clusterId, origin);
            uint32_t ow = node_weight(count, clusterWeight, origin);
            clusterWeight[ci] = ow;
            x[clusterId] = x[origin]; y[clusterId] = y[origin];
            clusterLat[ci] = node_lat(count, coords, clusterLat, origin);
            clusterLng[ci] = node_lng(count, coords, clusterLng, origin);
            int32_t slot = entrySlot[entry];
            if (slot >= 0 && (uint32_t)slot < nextLen && nextBuf[slot] == origin) {
              nextBuf[slot] = clusterId;
            } else {
              slot = (int32_t)nextLen;
              nextBuf[nextLen++] = clusterId;
              entrySlot[entry] = slot;
            }
          }

          parent[id] = clusterId;
          append_child(count, clusterFirst, nextSibling, clusterId, id);
          uint32_t ci = (uint32_t)clusterId - count;
          uint32_t w = node_weight(count, clusterWeight, id);
          uint32_t cw = clusterWeight[ci];
          uint32_t nw = cw + w;
          x[clusterId] = (x[clusterId] * (double)cw + px * (double)w) / (double)nw;
          y[clusterId] = (y[clusterId] * (double)cw + py * (double)w) / (double)nw;
          double ila = node_lat(count, coords, clusterLat, id);
          double iln = node_lng(count, coords, clusterLng, id);
          clusterLat[ci] = (clusterLat[ci] * (double)cw + ila * (double)w) / (double)nw;
          clusterLng[ci] = (clusterLng[ci] * (double)cw + iln * (double)w) / (double)nw;
          clusterWeight[ci] = nw;
          continue;
        }

        int32_t slot = (int32_t)nextLen;
        nextBuf[nextLen++] = id;
        if (grid_insert(&grid, px, py, id, slot) < 0) return -6;
      }

      treeOffsets[(uint32_t)z] = treeStoreLen;
      treeLens[(uint32_t)z] = nextLen;
      uint64_t nextTreeBytes64 = ((uint64_t)treeStoreLen + nextLen) * 4ULL;
      if (nextTreeBytes64 > 0xffffffffULL) return -3;
      uint32_t nextTreeBytes = (uint32_t)nextTreeBytes64;
      if (!ensure_memory_end(treeBase + nextTreeBytes)) return -5;
      int32_t *treeStore = (int32_t*)(uintptr_t)treeBase;
      for (uint32_t i = 0; i < nextLen; i++) treeStore[treeStoreLen + i] = nextBuf[i];
      treeStoreLen += nextLen;
      int32_t *tmp = level; level = nextBuf; nextBuf = tmp;
      levelLen = nextLen;
    }
  }

  g_tree_bytes = treeStoreLen * 4U;

  /* Final compact OWC1 blob starts exactly where transient scratch begins. */
  uint32_t treeDescBytes = (maxZoom + 1U) * 8U;
  uint32_t off = align8(HEADER_BYTES + treeDescBytes);
  uint32_t xOff = off; off = align8(off + nodeCount * 8U);
  uint32_t yOff = off; off = align8(off + nodeCount * 8U);
  uint32_t latOff = off; off = align8(off + nodeCount * 8U);
  uint32_t lngOff = off; off = align8(off + nodeCount * 8U);
  uint32_t weightOff = off; off = align4(off + nodeCount * 4U);
  uint32_t zoomOff = off; off = align4(off + nodeCount);
  uint32_t parentOff = off; off = align4(off + nodeCount * 4U);
  uint32_t firstOff = off; off = align4(off + nodeCount * 4U);
  uint32_t nextOff = off; off = align4(off + nodeCount * 4U);
  uint32_t treesOff = off; off = align8(off + treeStoreLen * 4U);
  uint32_t totalBytes = off;
  if (!ensure_memory_end(outputPtr + totalBytes)) return -5;

  /* Move tree store before overwriting transient scratch. memmove handles overlap. */
  move_bytes((uint8_t*)(uintptr_t)(outputPtr + treesOff), (const uint8_t*)(uintptr_t)treeBase, treeStoreLen * 4U);

  uint8_t *out = (uint8_t*)(uintptr_t)outputPtr;
  uint32_t *h = (uint32_t*)out;
  for (uint32_t i = 0; i < HEADER_WORDS; i++) h[i] = 0U;
  h[0]=MAGIC; h[1]=VERSION; h[2]=totalBytes; h[3]=count; h[4]=nodeCount;
  h[5]=maxZoom; h[6]=minZoom; h[7]=minPoints; h[8]=maxZoom+1U;
  DU rr; rr.d = radius; h[10]=(uint32_t)rr.u; h[11]=(uint32_t)(rr.u>>32);
  h[12]=xOff; h[13]=nodeCount; h[14]=yOff; h[15]=nodeCount;
  h[16]=latOff; h[17]=nodeCount; h[18]=lngOff; h[19]=nodeCount;
  h[20]=weightOff; h[21]=nodeCount; h[22]=zoomOff; h[23]=nodeCount;
  h[24]=parentOff; h[25]=nodeCount; h[26]=firstOff; h[27]=nodeCount;
  h[28]=nextOff; h[29]=nodeCount; h[30]=HEADER_BYTES; h[31]=maxZoom+1U;

  uint32_t *td = (uint32_t*)(out + HEADER_BYTES);
  for (uint32_t z=0; z<=maxZoom; z++) {
    td[z*2U] = treesOff + treeOffsets[z] * 4U;
    td[z*2U+1U] = treeLens[z];
  }

  double *dx=(double*)(out+xOff), *dy=(double*)(out+yOff), *dla=(double*)(out+latOff), *dln=(double*)(out+lngOff);
  uint32_t *dw=(uint32_t*)(out+weightOff);
  int8_t *dz=(int8_t*)(out+zoomOff);
  int32_t *dp=(int32_t*)(out+parentOff), *df=(int32_t*)(out+firstOff), *dn=(int32_t*)(out+nextOff);
  for (uint32_t i=0;i<nodeCount;i++) {
    dx[i]=x[i]; dy[i]=y[i];
    dla[i]=node_lat(count, coords, clusterLat, (int32_t)i);
    dln[i]=node_lng(count, coords, clusterLng, (int32_t)i);
    dw[i]=node_weight(count, clusterWeight, (int32_t)i);
    dz[i]=node_zoom(count, maxZoom, clusterZoom, i);
    dp[i]=parent[i];
    df[i]=node_first_child(count, clusterFirst, i);
    dn[i]=nextSibling[i];
  }

  g_result_ptr = outputPtr;
  g_result_bytes = totalBytes;
  return (int32_t)totalBytes;
}
