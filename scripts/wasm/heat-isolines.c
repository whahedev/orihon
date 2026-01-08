#include <stdint.h>
#include <stddef.h>

#define MAGIC 0x31534948u /* HIS1 */
#define VERSION 1u
#define HEADER_WORDS 16u
#define HEADER_BYTES (HEADER_WORDS * 4u)
#define VERTEX_KEY_BIT 0x80000000u

static uint32_t g_line_count = 0;
static uint32_t g_vertex_count = 0;
static uint32_t g_segment_count = 0;
static uint32_t g_count_grid_ptr = 0;
static uint32_t g_count_levels_ptr = 0;
static uint32_t g_count_cols = 0;
static uint32_t g_count_rows = 0;
static uint32_t g_count_level_count = 0;

static uint32_t align4(uint32_t v) { return (v + 3u) & ~3u; }
static uint32_t align8(uint32_t v) { return (v + 7u) & ~7u; }

uint32_t heat_contour_line_count(void) { return g_line_count; }
uint32_t heat_contour_vertex_count(void) { return g_vertex_count; }
uint32_t heat_contour_segment_count(void) { return g_segment_count; }

uint32_t heat_contour_scratch_bytes(uint32_t cols, uint32_t rows) {
  if (cols < 2u || rows < 2u) return 0u;
  uint64_t cells = (uint64_t)(cols - 1u) * (uint64_t)(rows - 1u);
  uint64_t max_segments = cells * 2u;
  uint64_t edge_count = (uint64_t)rows * (cols - 1u) + (uint64_t)(rows - 1u) * cols;
  uint64_t vertex_count = (uint64_t)rows * cols;
  uint64_t bytes = 0u;
  bytes = (bytes + 3u) & ~3ull;
  bytes += max_segments * 4u; /* segA */
  bytes += max_segments * 4u; /* segB */
  bytes += max_segments * 4u; /* segNextA */
  bytes += max_segments * 4u; /* segNextB */
  bytes += edge_count * 4u;   /* edgeHead */
  bytes += vertex_count * 4u; /* vertexHead */
  bytes += max_segments;      /* used */
  bytes = (bytes + 3u) & ~3ull;
  bytes += (edge_count + vertex_count) * 4u; /* touched endpoint keys */
  bytes = (bytes + 7u) & ~7ull;
  return bytes > 0xffffffffull ? 0u : (uint32_t)bytes;
}

typedef struct Scratch {
  uint32_t *seg_a;
  uint32_t *seg_b;
  int32_t *seg_next_a;
  int32_t *seg_next_b;
  int32_t *edge_head;
  int32_t *vertex_head;
  uint8_t *used;
  uint32_t *touched_keys;
  uint32_t touched_count;
  uint32_t max_segments;
  uint32_t edge_count;
  uint32_t vertex_count;
  uint32_t horizontal_edges;
} Scratch;

static int init_scratch(uint32_t ptr, uint32_t bytes, uint32_t cols, uint32_t rows, Scratch *s) {
  uint32_t need = heat_contour_scratch_bytes(cols, rows);
  if (need == 0u || bytes < need) return 0;
  uint64_t cells = (uint64_t)(cols - 1u) * (uint64_t)(rows - 1u);
  uint32_t max_segments = (uint32_t)(cells * 2u);
  uint32_t edge_count = rows * (cols - 1u) + (rows - 1u) * cols;
  uint32_t vertex_count = rows * cols;
  uint32_t p = align4(ptr);
  s->seg_a = (uint32_t *)(uintptr_t)p; p += max_segments * 4u;
  s->seg_b = (uint32_t *)(uintptr_t)p; p += max_segments * 4u;
  s->seg_next_a = (int32_t *)(uintptr_t)p; p += max_segments * 4u;
  s->seg_next_b = (int32_t *)(uintptr_t)p; p += max_segments * 4u;
  s->edge_head = (int32_t *)(uintptr_t)p; p += edge_count * 4u;
  s->vertex_head = (int32_t *)(uintptr_t)p; p += vertex_count * 4u;
  s->used = (uint8_t *)(uintptr_t)p; p += max_segments;
  p = align4(p);
  s->touched_keys = (uint32_t *)(uintptr_t)p;
  s->touched_count = 0u;
  s->max_segments = max_segments;
  s->edge_count = edge_count;
  s->vertex_count = vertex_count;
  s->horizontal_edges = rows * (cols - 1u);
  return 1;
}

static uint32_t h_edge(uint32_t x, uint32_t y, uint32_t cols) {
  return y * (cols - 1u) + x;
}
static uint32_t v_edge(uint32_t x, uint32_t y, uint32_t cols, uint32_t rows) {
  return rows * (cols - 1u) + y * cols + x;
}

static uint32_t endpoint_key_for_edge(
  uint32_t edge, const float *grid, uint32_t cols, uint32_t rows, float threshold
) {
  uint32_t horizontal = rows * (cols - 1u);
  uint32_t va, vb;
  float a, b;
  if (edge < horizontal) {
    uint32_t width = cols - 1u;
    uint32_t y = edge / width;
    uint32_t x = edge - y * width;
    va = y * cols + x; vb = va + 1u;
  } else {
    uint32_t e = edge - horizontal;
    uint32_t y = e / cols;
    uint32_t x = e - y * cols;
    va = y * cols + x; vb = va + cols;
  }
  a = grid[va]; b = grid[vb];
  /* Flat threshold edge follows legacy midpoint semantics, so keep edge identity. */
  if (a == threshold && b == threshold) return edge;
  if (a == threshold) return VERTEX_KEY_BIT | va;
  if (b == threshold) return VERTEX_KEY_BIT | vb;
  return edge;
}

static void clear_i32(int32_t *p, uint32_t n, int32_t value) {
  for (uint32_t i = 0; i < n; i++) p[i] = value;
}
static void clear_u8(uint8_t *p, uint32_t n) {
  for (uint32_t i = 0; i < n; i++) p[i] = 0u;
}

static int32_t key_head(const Scratch *s, uint32_t key) {
  if (key & VERTEX_KEY_BIT) return s->vertex_head[key & ~VERTEX_KEY_BIT];
  return s->edge_head[key];
}
static void key_set_head(Scratch *s, uint32_t key, int32_t value) {
  if (key & VERTEX_KEY_BIT) s->vertex_head[key & ~VERTEX_KEY_BIT] = value;
  else s->edge_head[key] = value;
}
static int32_t next_at_key(const Scratch *s, uint32_t seg, uint32_t key) {
  return s->seg_a[seg] == key ? s->seg_next_a[seg] : s->seg_next_b[seg];
}

static int link_key_segment(Scratch *s, uint32_t key, uint32_t seg, int side_a) {
  uint32_t index = key & ~VERTEX_KEY_BIT;
  if ((key & VERTEX_KEY_BIT) ? index >= s->vertex_count : index >= s->edge_count) return 0;
  int32_t head = key_head(s, key);
  if (head < 0) {
    if (s->touched_count >= s->edge_count + s->vertex_count) return 0;
    s->touched_keys[s->touched_count++] = key;
  }
  if (side_a) s->seg_next_a[seg] = head;
  else s->seg_next_b[seg] = head;
  key_set_head(s, key, (int32_t)seg);
  return 1;
}

static void clear_touched_edges(Scratch *s) {
  for (uint32_t i = 0; i < s->touched_count; i++) key_set_head(s, s->touched_keys[i], -1);
  s->touched_count = 0u;
}

static int emit_segment(Scratch *s, uint32_t *count, uint32_t a, uint32_t b) {
  uint32_t i = *count;
  if (i >= s->max_segments) return 0;
  s->seg_a[i] = a;
  s->seg_b[i] = b;
  s->seg_next_a[i] = -1;
  s->seg_next_b[i] = -1;
  if (!link_key_segment(s, a, i, 1) || !link_key_segment(s, b, i, 0)) return 0;
  *count = i + 1u;
  return 1;
}

static int build_segments(
  const float *grid, uint32_t cols, uint32_t rows, float threshold,
  Scratch *s, uint32_t *segment_count
) {
  s->touched_count = 0u;
  uint32_t n = 0u;
  for (uint32_t y = 0; y + 1u < rows; y++) {
    for (uint32_t x = 0; x + 1u < cols; x++) {
      uint32_t i = y * cols + x;
      float tl = grid[i];
      float tr = grid[i + 1u];
      float br = grid[i + cols + 1u];
      float bl = grid[i + cols];
      uint32_t code = (tl >= threshold ? 8u : 0u) |
                      (tr >= threshold ? 4u : 0u) |
                      (br >= threshold ? 2u : 0u) |
                      (bl >= threshold ? 1u : 0u);
      if (code == 0u || code == 15u) continue;
      uint32_t top = endpoint_key_for_edge(h_edge(x, y, cols), grid, cols, rows, threshold);
      uint32_t right = endpoint_key_for_edge(v_edge(x + 1u, y, cols, rows), grid, cols, rows, threshold);
      uint32_t bottom = endpoint_key_for_edge(h_edge(x, y + 1u, cols), grid, cols, rows, threshold);
      uint32_t left = endpoint_key_for_edge(v_edge(x, y, cols, rows), grid, cols, rows, threshold);
      switch (code) {
        case 1u: case 14u: if (!emit_segment(s, &n, left, bottom)) return 0; break;
        case 2u: case 13u: if (!emit_segment(s, &n, bottom, right)) return 0; break;
        case 3u: case 12u: if (!emit_segment(s, &n, left, right)) return 0; break;
        case 4u: case 11u: if (!emit_segment(s, &n, top, right)) return 0; break;
        case 5u: {
          float avg = (tl + tr + br + bl) * 0.25f;
          if (avg >= threshold) {
            if (!emit_segment(s, &n, left, top) || !emit_segment(s, &n, bottom, right)) return 0;
          } else {
            if (!emit_segment(s, &n, left, bottom) || !emit_segment(s, &n, top, right)) return 0;
          }
          break;
        }
        case 6u: case 9u: if (!emit_segment(s, &n, top, bottom)) return 0; break;
        case 7u: case 8u: if (!emit_segment(s, &n, left, top)) return 0; break;
        case 10u: {
          float avg = (tl + tr + br + bl) * 0.25f;
          if (avg >= threshold) {
            if (!emit_segment(s, &n, left, bottom) || !emit_segment(s, &n, top, right)) return 0;
          } else {
            if (!emit_segment(s, &n, left, top) || !emit_segment(s, &n, bottom, right)) return 0;
          }
          break;
        }
        default: break;
      }
    }
  }
  *segment_count = n;
  return 1;
}

static int32_t other_segment(const Scratch *s, uint32_t edge, uint32_t current) {
  int32_t candidate = key_head(s, edge);
  while (candidate >= 0) {
    uint32_t seg = (uint32_t)candidate;
    if (seg != current && !s->used[seg]) return candidate;
    candidate = next_at_key(s, seg, edge);
  }
  return -1;
}

static int key_degree_one(const Scratch *s, uint32_t key, uint32_t *seg_out) {
  int32_t head = key_head(s, key);
  if (head < 0) return 0;
  if (next_at_key(s, (uint32_t)head, key) >= 0) return 0;
  *seg_out = (uint32_t)head;
  return 1;
}

static uint32_t other_edge(const Scratch *s, uint32_t seg, uint32_t edge) {
  uint32_t a = s->seg_a[seg];
  uint32_t b = s->seg_b[seg];
  return a == edge ? b : a;
}

typedef struct Writer {
  uint32_t *line_offsets;
  uint32_t *line_levels;
  float *xy;
  uint32_t line_write;
  uint32_t vertex_write;
  uint32_t level_index;
  const float *grid;
  uint32_t cols;
  uint32_t rows;
  float threshold;
  uint32_t horizontal_edges;
  int write;
} Writer;

static void edge_xy(const Writer *w, uint32_t edge, float *x, float *y) {
  if (edge & VERTEX_KEY_BIT) {
    uint32_t v = edge & ~VERTEX_KEY_BIT;
    *x = (float)(v % w->cols);
    *y = (float)(v / w->cols);
    return;
  }
  if (edge < w->horizontal_edges) {
    uint32_t width = w->cols - 1u;
    uint32_t gy = edge / width;
    uint32_t gx = edge - gy * width;
    float a = w->grid[gy * w->cols + gx];
    float b = w->grid[gy * w->cols + gx + 1u];
    float d = b - a;
    float t = (d > -1.0e-12f && d < 1.0e-12f) ? 0.5f : (w->threshold - a) / d;
    *x = (float)gx + t;
    *y = (float)gy;
  } else {
    uint32_t e = edge - w->horizontal_edges;
    uint32_t gy = e / w->cols;
    uint32_t gx = e - gy * w->cols;
    float a = w->grid[gy * w->cols + gx];
    float b = w->grid[(gy + 1u) * w->cols + gx];
    float d = b - a;
    float t = (d > -1.0e-12f && d < 1.0e-12f) ? 0.5f : (w->threshold - a) / d;
    *x = (float)gx;
    *y = (float)gy + t;
  }
}

static void write_vertex(Writer *w, uint32_t edge) {
  if (w->write) {
    float x, y;
    edge_xy(w, edge, &x, &y);
    w->xy[w->vertex_write * 2u] = x;
    w->xy[w->vertex_write * 2u + 1u] = y;
  }
  w->vertex_write++;
}

static void begin_line(Writer *w) {
  if (w->write) {
    w->line_offsets[w->line_write] = w->vertex_write;
    w->line_levels[w->line_write] = w->level_index;
  }
  w->line_write++;
}

static void traverse_chain(Scratch *s, uint32_t start_edge, uint32_t start_seg, Writer *w) {
  begin_line(w);
  write_vertex(w, start_edge);
  uint32_t edge = start_edge;
  uint32_t seg = start_seg;
  for (;;) {
    if (seg >= s->max_segments || s->used[seg]) break;
    s->used[seg] = 1u;
    uint32_t next_edge = other_edge(s, seg, edge);
    write_vertex(w, next_edge);
    int32_t next_seg = other_segment(s, next_edge, seg);
    if (next_seg < 0 || s->used[(uint32_t)next_seg]) break;
    edge = next_edge;
    seg = (uint32_t)next_seg;
  }
}

static void traverse_all(Scratch *s, uint32_t segment_count, Writer *w) {
  clear_u8(s->used, segment_count);
  /* Open chains first: edge degree 1. */
  for (uint32_t i = 0; i < s->touched_count; i++) {
    uint32_t edge = s->touched_keys[i];
    uint32_t seg = 0u;
    if (!key_degree_one(s, edge, &seg)) continue;
    if (!s->used[seg]) traverse_chain(s, edge, seg, w);
  }
  /* Remaining components are closed loops (or degenerate leftovers). */
  for (uint32_t seg = 0; seg < segment_count; seg++) {
    if (s->used[seg]) continue;
    traverse_chain(s, s->seg_a[seg], seg, w);
  }
}

uint32_t heat_contour_count(
  uint32_t grid_ptr, uint32_t cols, uint32_t rows,
  uint32_t levels_ptr, uint32_t level_count,
  uint32_t scratch_ptr, uint32_t scratch_bytes
) {
  g_line_count = 0u; g_vertex_count = 0u; g_segment_count = 0u;
  g_count_grid_ptr = 0u; g_count_levels_ptr = 0u; g_count_cols = 0u; g_count_rows = 0u; g_count_level_count = 0u;
  if (!grid_ptr || !levels_ptr || !scratch_ptr || cols < 2u || rows < 2u || level_count == 0u) return 0u;
  Scratch s;
  if (!init_scratch(scratch_ptr, scratch_bytes, cols, rows, &s)) return 0u;
  clear_i32(s.edge_head, s.edge_count, -1);
  clear_i32(s.vertex_head, s.vertex_count, -1);
  const float *grid = (const float *)(uintptr_t)grid_ptr;
  const float *levels = (const float *)(uintptr_t)levels_ptr;
  Writer w;
  w.line_offsets = 0; w.line_levels = 0; w.xy = 0;
  w.line_write = 0u; w.vertex_write = 0u; w.grid = grid; w.cols = cols; w.rows = rows;
  w.horizontal_edges = s.horizontal_edges; w.write = 0;
  uint64_t total_segments = 0u;
  for (uint32_t level = 0; level < level_count; level++) {
    uint32_t segs = 0u;
    if (!build_segments(grid, cols, rows, levels[level], &s, &segs)) return 0u;
    total_segments += segs;
    w.level_index = level;
    w.threshold = levels[level];
    traverse_all(&s, segs, &w);
    clear_touched_edges(&s);
  }
  if (w.line_write > 0xffffffffu || w.vertex_write > 0xffffffffu || total_segments > 0xffffffffull) return 0u;
  g_line_count = w.line_write;
  g_vertex_count = w.vertex_write;
  g_segment_count = (uint32_t)total_segments;
  g_count_grid_ptr = grid_ptr;
  g_count_levels_ptr = levels_ptr;
  g_count_cols = cols;
  g_count_rows = rows;
  g_count_level_count = level_count;
  uint64_t p = HEADER_BYTES;
  p = (p + 3u) & ~3ull; p += (uint64_t)level_count * 4u;
  p = (p + 3u) & ~3ull; p += (uint64_t)(g_line_count + 1u) * 4u;
  p = (p + 3u) & ~3ull; p += (uint64_t)g_line_count * 4u;
  p = (p + 3u) & ~3ull; p += (uint64_t)g_vertex_count * 2u * 4u;
  p = (p + 7u) & ~7ull;
  return p > 0xffffffffull ? 0u : (uint32_t)p;
}

uint32_t heat_contour_build(
  uint32_t grid_ptr, uint32_t cols, uint32_t rows,
  uint32_t levels_ptr, uint32_t level_count,
  uint32_t scratch_ptr, uint32_t scratch_bytes,
  uint32_t output_ptr, uint32_t output_capacity
) {
  if (!output_ptr) return 0u;
  if (g_count_grid_ptr != grid_ptr || g_count_levels_ptr != levels_ptr ||
      g_count_cols != cols || g_count_rows != rows || g_count_level_count != level_count) return 0u;
  uint64_t need64 = HEADER_BYTES;
  need64 = (need64 + 3u) & ~3ull; need64 += (uint64_t)level_count * 4u;
  need64 = (need64 + 3u) & ~3ull; need64 += (uint64_t)(g_line_count + 1u) * 4u;
  need64 = (need64 + 3u) & ~3ull; need64 += (uint64_t)g_line_count * 4u;
  need64 = (need64 + 3u) & ~3ull; need64 += (uint64_t)g_vertex_count * 2u * 4u;
  need64 = (need64 + 7u) & ~7ull;
  if (need64 > 0xffffffffull) return 0u;
  uint32_t need = (uint32_t)need64;
  if (output_capacity < need) return 0u;
  uint32_t *h = (uint32_t *)(uintptr_t)output_ptr;
  for (uint32_t i = 0; i < HEADER_WORDS; i++) h[i] = 0u;
  uint32_t p = output_ptr + HEADER_BYTES;
  p = align4(p);
  uint32_t levels_off = p - output_ptr; p += level_count * 4u;
  p = align4(p);
  uint32_t line_offsets_off = p - output_ptr; p += (g_line_count + 1u) * 4u;
  p = align4(p);
  uint32_t line_levels_off = p - output_ptr; p += g_line_count * 4u;
  p = align4(p);
  uint32_t xy_off = p - output_ptr; p += g_vertex_count * 2u * 4u;
  p = align8(p);
  if (p - output_ptr > output_capacity) return 0u;

  const float *grid = (const float *)(uintptr_t)grid_ptr;
  const float *levels = (const float *)(uintptr_t)levels_ptr;
  float *out_levels = (float *)(uintptr_t)(output_ptr + levels_off);
  uint32_t *line_offsets = (uint32_t *)(uintptr_t)(output_ptr + line_offsets_off);
  uint32_t *line_levels = (uint32_t *)(uintptr_t)(output_ptr + line_levels_off);
  float *xy = (float *)(uintptr_t)(output_ptr + xy_off);
  for (uint32_t i = 0; i < level_count; i++) out_levels[i] = levels[i];

  Scratch s;
  if (!init_scratch(scratch_ptr, scratch_bytes, cols, rows, &s)) return 0u;
  clear_i32(s.edge_head, s.edge_count, -1);
  clear_i32(s.vertex_head, s.vertex_count, -1);
  Writer w;
  w.line_offsets = line_offsets; w.line_levels = line_levels; w.xy = xy;
  w.line_write = 0u; w.vertex_write = 0u; w.grid = grid; w.cols = cols; w.rows = rows;
  w.horizontal_edges = s.horizontal_edges; w.write = 1;
  for (uint32_t level = 0; level < level_count; level++) {
    uint32_t segs = 0u;
    if (!build_segments(grid, cols, rows, levels[level], &s, &segs)) return 0u;
    w.level_index = level;
    w.threshold = levels[level];
    traverse_all(&s, segs, &w);
    clear_touched_edges(&s);
  }
  if (w.line_write != g_line_count || w.vertex_write != g_vertex_count) return 0u;
  line_offsets[g_line_count] = g_vertex_count;

  h[0] = MAGIC;
  h[1] = VERSION;
  h[2] = need;
  h[3] = cols;
  h[4] = rows;
  h[5] = level_count;
  h[6] = g_line_count;
  h[7] = g_vertex_count;
  h[8] = levels_off;
  h[9] = level_count;
  h[10] = line_offsets_off;
  h[11] = g_line_count + 1u;
  h[12] = line_levels_off;
  h[13] = g_line_count;
  h[14] = xy_off;
  h[15] = g_vertex_count * 2u;
  return need;
}
