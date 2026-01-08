#include <stdint.h>

typedef struct {
  uint8_t *base;
  uint32_t cap;
  uint32_t pos;
  int failed;
} Arena;

typedef struct {
  uint32_t offset;
  uint32_t len;
  uint32_t cap;
  uint32_t elem_size;
  uint32_t align;
} Vec;

enum {
  HEADER_WORDS = 16,
  HEADER_SIZE = 64,
  LAYER_DESC_WORDS = 32,
  LAYER_DESC_SIZE = 128,
  VALUE_DESC_SIZE = 24,
  MAGIC = 0x3254564f, /* OVT2 little-endian */
  VERSION = 2
};

static uint32_t align_up(uint32_t v, uint32_t a) {
  return (v + (a - 1u)) & ~(a - 1u);
}

static void copy_bytes(uint8_t *dst, const uint8_t *src, uint32_t n) {
  for (uint32_t i = 0; i < n; i++) dst[i] = src[i];
}

static uint8_t *arena_alloc(Arena *a, uint32_t size, uint32_t align) {
  uint32_t p = align_up(a->pos, align);
  if (p > a->cap || size > a->cap - p) {
    a->failed = 1;
    return (uint8_t *)0;
  }
  a->pos = p + size;
  return a->base + p;
}

static void vec_init(Vec *v, uint32_t elem_size, uint32_t align) {
  v->offset = 0;
  v->len = 0;
  v->cap = 0;
  v->elem_size = elem_size;
  v->align = align;
}

static uint8_t *vec_ptr(Arena *a, const Vec *v) {
  return v->cap ? a->base + v->offset : (uint8_t *)0;
}

static int vec_reserve(Arena *a, Vec *v, uint32_t need) {
  if (need <= v->cap) return 1;
  uint32_t next = v->cap ? v->cap : 8u;
  while (next < need) {
    if (next > 0x7fffffffu) { a->failed = 1; return 0; }
    next *= 2u;
  }
  if (v->elem_size && next > 0xffffffffu / v->elem_size) { a->failed = 1; return 0; }
  uint32_t bytes = next * v->elem_size;
  if (v->cap) {
    uint32_t old_bytes = v->cap * v->elem_size;
    uint32_t block_end = v->offset + old_bytes;
    if (block_end == a->pos) {
      uint32_t extra = bytes - old_bytes;
      if (extra <= a->cap - a->pos) {
        a->pos += extra;
        v->cap = next;
        return 1;
      }
    }
  }
  uint8_t *fresh = arena_alloc(a, bytes, v->align);
  if (!fresh) return 0;
  if (v->len && v->cap) copy_bytes(fresh, a->base + v->offset, v->len * v->elem_size);
  v->offset = (uint32_t)(fresh - a->base);
  v->cap = next;
  return 1;
}

static uint8_t *vec_append(Arena *a, Vec *v, uint32_t count) {
  if (count > 0xffffffffu - v->len) { a->failed = 1; return (uint8_t *)0; }
  uint32_t old = v->len;
  uint32_t next = old + count;
  if (!vec_reserve(a, v, next)) return (uint8_t *)0;
  v->len = next;
  return a->base + v->offset + old * v->elem_size;
}

static int vec_push_u32(Arena *a, Vec *v, uint32_t value) {
  uint32_t *p = (uint32_t *)vec_append(a, v, 1);
  if (!p) return 0;
  *p = value;
  return 1;
}

static int vec_push_i32(Arena *a, Vec *v, int32_t value) {
  int32_t *p = (int32_t *)vec_append(a, v, 1);
  if (!p) return 0;
  *p = value;
  return 1;
}

static int vec_push_u8(Arena *a, Vec *v, uint8_t value) {
  uint8_t *p = vec_append(a, v, 1);
  if (!p) return 0;
  *p = value;
  return 1;
}

static int vec_push_f64(Arena *a, Vec *v, double value) {
  double *p = (double *)vec_append(a, v, 1);
  if (!p) return 0;
  *p = value;
  return 1;
}

static uint32_t append_blob_string(Arena *a, const uint8_t *src, uint32_t len) {
  if (len == 0) return 0;
  uint8_t *p = arena_alloc(a, len, 1);
  if (!p) return 0;
  copy_bytes(p, src, len);
  return (uint32_t)(p - a->base);
}

static int read_varint(const uint8_t *b, uint32_t end, uint32_t *p, uint64_t *out) {
  uint64_t v = 0;
  uint32_t shift = 0;
  for (uint32_t i = 0; i < 10 && *p < end; i++) {
    uint8_t c = b[(*p)++];
    if (shift < 64) v |= ((uint64_t)(c & 0x7fu)) << shift;
    if ((c & 0x80u) == 0) { *out = v; return 1; }
    shift += 7;
  }
  return 0;
}

static int read_range(const uint8_t *b, uint32_t end, uint32_t *p, uint32_t *start, uint32_t *stop) {
  uint64_t n64;
  if (!read_varint(b, end, p, &n64) || n64 > 0xffffffffu) return 0;
  uint32_t n = (uint32_t)n64;
  if (n > end - *p) return 0;
  *start = *p;
  *stop = *p + n;
  *p += n;
  return 1;
}

static int skip_field(const uint8_t *b, uint32_t end, uint32_t *p, uint32_t wire) {
  uint64_t tmp;
  uint32_t s, e;
  if (wire == 0) return read_varint(b, end, p, &tmp);
  if (wire == 1) { if (end - *p < 8) return 0; *p += 8; return 1; }
  if (wire == 2) return read_range(b, end, p, &s, &e);
  if (wire == 5) { if (end - *p < 4) return 0; *p += 4; return 1; }
  return 0;
}

static int32_t zigzag32(uint32_t v) {
  return (int32_t)((v >> 1) ^ (uint32_t)-(int32_t)(v & 1u));
}

static uint32_t read_u32_le(const uint8_t *b, uint32_t p) {
  return (uint32_t)b[p] | ((uint32_t)b[p+1] << 8) | ((uint32_t)b[p+2] << 16) | ((uint32_t)b[p+3] << 24);
}

static uint64_t read_u64_le(const uint8_t *b, uint32_t p) {
  return (uint64_t)read_u32_le(b, p) | ((uint64_t)read_u32_le(b, p + 4) << 32);
}

static double f32_to_double(uint32_t bits) {
  union { uint32_t u; float f; } v;
  v.u = bits;
  return (double)v.f;
}

static double f64_from_bits(uint64_t bits) {
  union { uint64_t u; double d; } v;
  v.u = bits;
  return v.d;
}

static int layer_allowed(const uint8_t *b, uint32_t name_start, uint32_t name_len,
                         const uint8_t *filter, uint32_t filter_len) {
  if (filter_len == 0) return 1;
  uint32_t p = 0;
  while (p < filter_len) {
    if (filter_len - p < 4) return 0;
    uint32_t n = read_u32_le(filter, p);
    p += 4;
    if (n > filter_len - p) return 0;
    if (n == name_len) {
      uint32_t same = 1;
      for (uint32_t i = 0; i < n; i++) {
        if (filter[p + i] != b[name_start + i]) { same = 0; break; }
      }
      if (same) return 1;
    }
    p += n;
  }
  return 0;
}

typedef struct {
  uint32_t name_start;
  uint32_t name_len;
  uint32_t extent;
} LayerMeta;

/* Lightweight pre-scan: only discovers name/extent and skips feature payloads. */
static int scan_layer_meta(const uint8_t *b, uint32_t start, uint32_t end, uint32_t max_string, LayerMeta *m) {
  m->name_start = 0;
  m->name_len = 0;
  m->extent = 4096;
  uint32_t p = start;
  int have_name = 0;
  while (p < end) {
    uint64_t key;
    if (!read_varint(b, end, &p, &key)) return 0;
    uint32_t field = (uint32_t)(key >> 3);
    uint32_t wire = (uint32_t)(key & 7u);
    if (field == 1u && wire == 2u) {
      uint32_t s, e;
      if (!read_range(b, end, &p, &s, &e)) return 0;
      if (!have_name) {
        uint32_t n = e - s;
        m->name_start = s;
        m->name_len = (n > 0 && n <= max_string) ? n : 0;
        have_name = 1;
      }
    } else if (field == 5u && wire == 0u) {
      uint64_t extent;
      if (!read_varint(b, end, &p, &extent)) return 0;
      m->extent = (uint32_t)extent;
    } else if (!skip_field(b, end, &p, wire)) {
      return 0;
    }
  }
  return 1;
}

typedef struct {
  Vec key_ranges;      /* u32 pairs: string offset, length */
  Vec value_desc;      /* 24-byte descriptors */
  Vec types;           /* u8 */
  Vec ids;             /* f64 */
  Vec id_present;      /* u8 */
  Vec vertex_offsets;  /* u32 */
  Vec part_offsets;    /* u32 */
  Vec part_ends;       /* u32 */
  Vec tag_offsets;     /* u32 */
  Vec tags;            /* u32 */
  Vec xy;              /* i32 coordinate scalars */
  uint32_t feature_count;
} LayerBuilder;

static int layer_builder_init(Arena *a, LayerBuilder *lb) {
  vec_init(&lb->key_ranges, 4, 4);
  vec_init(&lb->value_desc, VALUE_DESC_SIZE, 8);
  vec_init(&lb->types, 1, 1);
  vec_init(&lb->ids, 8, 8);
  vec_init(&lb->id_present, 1, 1);
  vec_init(&lb->vertex_offsets, 4, 4);
  vec_init(&lb->part_offsets, 4, 4);
  vec_init(&lb->part_ends, 4, 4);
  vec_init(&lb->tag_offsets, 4, 4);
  vec_init(&lb->tags, 4, 4);
  vec_init(&lb->xy, 4, 4);
  lb->feature_count = 0;
  return vec_push_u32(a, &lb->vertex_offsets, 0) &&
         vec_push_u32(a, &lb->part_offsets, 0) &&
         vec_push_u32(a, &lb->tag_offsets, 0);
}

static int append_value_desc(const uint8_t *b, uint32_t start, uint32_t end, uint32_t max_string,
                             Arena *a, Vec *values) {
  uint8_t *desc = vec_append(a, values, 1);
  if (!desc) return 0;
  for (uint32_t i = 0; i < VALUE_DESC_SIZE; i++) desc[i] = 0;
  uint32_t *u = (uint32_t *)desc;
  double number = 0.0;
  uint32_t p = start;
  while (p < end) {
    uint64_t key;
    if (!read_varint(b, end, &p, &key)) return 0;
    uint32_t field = (uint32_t)(key >> 3);
    uint32_t wire = (uint32_t)(key & 7u);
    if (field == 1u && wire == 2u) {
      uint32_t s, e;
      if (!read_range(b, end, &p, &s, &e)) return 0;
      uint32_t n = e - s;
      u[0] = 1;
      if (n > 0 && n <= max_string) {
        uint32_t off = append_blob_string(a, b + s, n);
        if (a->failed) return 0;
        u[1] = off;
        u[2] = n;
      }
    } else if (field == 2u && wire == 5u) {
      if (end - p < 4) return 0;
      u[0] = 2; number = f32_to_double(read_u32_le(b, p)); p += 4;
    } else if (field == 3u && wire == 1u) {
      if (end - p < 8) return 0;
      u[0] = 2; number = f64_from_bits(read_u64_le(b, p)); p += 8;
    } else if (field == 4u && wire == 0u) {
      uint64_t v; if (!read_varint(b, end, &p, &v)) return 0;
      u[0] = 2; number = (double)v;
    } else if (field == 5u && wire == 0u) {
      uint64_t v; if (!read_varint(b, end, &p, &v)) return 0;
      u[0] = 2; number = (double)zigzag32((uint32_t)v);
    } else if (field == 6u && wire == 0u) {
      uint64_t v; if (!read_varint(b, end, &p, &v)) return 0;
      u[0] = 3; number = v ? 1.0 : 0.0;
    } else if (!skip_field(b, end, &p, wire)) {
      return 0;
    }
  }
  *((double *)(desc + 16)) = number;
  return 1;
}

static int decode_geometry_stream(const uint8_t *b, uint32_t start, uint32_t end,
                                  Arena *a, LayerBuilder *lb, uint32_t *vertices_added, uint32_t *parts_added) {
  uint32_t xy_start_len = lb->xy.len;
  uint32_t part_start_len = lb->part_ends.len;
  uint32_t vertex_base = xy_start_len / 2u;
  uint32_t part_vertex_start = vertex_base;
  uint32_t p = start;
  int32_t x = 0, y = 0;

  while (p < end) {
    uint64_t raw;
    if (!read_varint(b, end, &p, &raw)) return 0;
    uint32_t cmd = (uint32_t)raw;
    uint32_t id = cmd & 7u;
    uint32_t count = cmd >> 3;
    if (id == 1u || id == 2u) {
      uint32_t current_vertex = lb->xy.len / 2u;
      if (id == 1u && current_vertex > part_vertex_start) {
        if (!vec_push_u32(a, &lb->part_ends, current_vertex)) return 0;
        part_vertex_start = current_vertex;
      }
      for (uint32_t i = 0; i < count; i++) {
        uint64_t dx, dy;
        if (!read_varint(b, end, &p, &dx) || !read_varint(b, end, &p, &dy)) return 0;
        x += zigzag32((uint32_t)dx);
        y += zigzag32((uint32_t)dy);
        if (!vec_push_i32(a, &lb->xy, x) || !vec_push_i32(a, &lb->xy, y)) return 0;
      }
    } else if (id == 7u) {
      uint32_t current_vertex = lb->xy.len / 2u;
      if (current_vertex > part_vertex_start) {
        int32_t *xy = (int32_t *)vec_ptr(a, &lb->xy);
        uint32_t first_scalar = part_vertex_start * 2u;
        int32_t fx = xy[first_scalar];
        int32_t fy = xy[first_scalar + 1u];
        if (!vec_push_i32(a, &lb->xy, fx) || !vec_push_i32(a, &lb->xy, fy)) return 0;
        current_vertex = lb->xy.len / 2u;
        if (!vec_push_u32(a, &lb->part_ends, current_vertex)) return 0;
        part_vertex_start = current_vertex;
      }
    } else {
      break;
    }
  }

  uint32_t current_vertex = lb->xy.len / 2u;
  if (current_vertex > part_vertex_start) {
    if (!vec_push_u32(a, &lb->part_ends, current_vertex)) return 0;
  }
  *vertices_added = (lb->xy.len - xy_start_len) / 2u;
  *parts_added = lb->part_ends.len - part_start_len;
  return 1;
}

static int decode_feature_stream(const uint8_t *b, uint32_t start, uint32_t end,
                                 Arena *a, LayerBuilder *lb) {
  uint32_t p = start;
  uint32_t type = 0;
  int have_id = 0;
  double id_value = 0.0;
  uint32_t tags_start = 0, tags_end = 0;
  uint32_t geom_start = 0, geom_end = 0;
  while (p < end) {
    uint64_t key;
    if (!read_varint(b, end, &p, &key)) return 0;
    uint32_t field = (uint32_t)(key >> 3);
    uint32_t wire = (uint32_t)(key & 7u);
    if (field == 1u && wire == 0u) {
      uint64_t v; if (!read_varint(b, end, &p, &v)) return 0;
      have_id = 1; id_value = (double)v;
    } else if (field == 2u && wire == 2u) {
      if (!read_range(b, end, &p, &tags_start, &tags_end)) return 0;
    } else if (field == 3u && wire == 0u) {
      uint64_t v; if (!read_varint(b, end, &p, &v)) return 0;
      type = (uint32_t)v;
    } else if (field == 4u && wire == 2u) {
      if (!read_range(b, end, &p, &geom_start, &geom_end)) return 0;
    } else if (!skip_field(b, end, &p, wire)) {
      return 0;
    }
  }

  uint32_t old_xy = lb->xy.len;
  uint32_t old_parts = lb->part_ends.len;
  uint32_t vertices_added = 0, parts_added = 0;
  if (geom_end <= geom_start || !decode_geometry_stream(b, geom_start, geom_end, a, lb, &vertices_added, &parts_added)) return 0;
  if (vertices_added == 0) {
    lb->xy.len = old_xy;
    lb->part_ends.len = old_parts;
    return 2; /* valid empty geometry: skip */
  }

  uint32_t old_tags = lb->tags.len;
  if (tags_end > tags_start) {
    uint32_t tp = tags_start;
    while (tp < tags_end) {
      uint64_t v;
      if (!read_varint(b, tags_end, &tp, &v) || !vec_push_u32(a, &lb->tags, (uint32_t)v)) return 0;
    }
  }

  if (!vec_push_u8(a, &lb->types, (uint8_t)type) ||
      !vec_push_f64(a, &lb->ids, id_value) ||
      !vec_push_u8(a, &lb->id_present, have_id ? 1u : 0u) ||
      !vec_push_u32(a, &lb->vertex_offsets, lb->xy.len / 2u) ||
      !vec_push_u32(a, &lb->part_offsets, lb->part_ends.len) ||
      !vec_push_u32(a, &lb->tag_offsets, lb->tags.len)) return 0;
  (void)old_tags;
  lb->feature_count++;
  return 1;
}

static int parse_layer_stream(const uint8_t *b, uint32_t start, uint32_t end,
                              uint32_t max_features, uint32_t max_string,
                              Arena *a, const LayerMeta *meta,
                              LayerBuilder *lb) {
  if (!layer_builder_init(a, lb)) return 0;
  uint32_t p = start;
  while (p < end) {
    uint64_t key;
    if (!read_varint(b, end, &p, &key)) return 0;
    uint32_t field = (uint32_t)(key >> 3);
    uint32_t wire = (uint32_t)(key & 7u);
    if (field == 1u && wire == 2u) {
      uint32_t s, e; if (!read_range(b, end, &p, &s, &e)) return 0;
    } else if (field == 2u && wire == 2u) {
      uint32_t s, e; if (!read_range(b, end, &p, &s, &e)) return 0;
      if (lb->feature_count < max_features) {
        int code = decode_feature_stream(b, s, e, a, lb);
        if (code == 0) return 0;
      }
    } else if (field == 3u && wire == 2u) {
      uint32_t s, e; if (!read_range(b, end, &p, &s, &e)) return 0;
      uint32_t n = e - s;
      uint32_t off = 0;
      if (n > 0 && n <= max_string) {
        off = append_blob_string(a, b + s, n);
        if (a->failed) return 0;
      } else {
        n = 0;
      }
      if (!vec_push_u32(a, &lb->key_ranges, off) || !vec_push_u32(a, &lb->key_ranges, n)) return 0;
    } else if (field == 4u && wire == 2u) {
      uint32_t s, e; if (!read_range(b, end, &p, &s, &e)) return 0;
      if (!append_value_desc(b, s, e, max_string, a, &lb->value_desc)) return 0;
    } else if (field == 5u && wire == 0u) {
      uint64_t extent; if (!read_varint(b, end, &p, &extent)) return 0;
      (void)extent;
    } else if (!skip_field(b, end, &p, wire)) {
      return 0;
    }
  }
  (void)meta;
  return 1;
}

static uint32_t rel_offset(const Vec *v) { return v->len ? v->offset : 0u; }

static void write_layer_desc(uint32_t *d, const LayerMeta *m, uint32_t name_offset, const LayerBuilder *lb) {
  for (uint32_t i = 0; i < LAYER_DESC_WORDS; i++) d[i] = 0;
  d[0] = name_offset;
  d[1] = m->name_len;
  d[2] = m->extent;
  d[3] = lb->key_ranges.len / 2u;
  d[4] = rel_offset(&lb->key_ranges);
  d[5] = lb->key_ranges.len;
  d[6] = lb->value_desc.len;
  d[7] = rel_offset(&lb->value_desc);
  d[8] = lb->value_desc.len * VALUE_DESC_SIZE;
  d[9] = lb->feature_count;
  d[10] = rel_offset(&lb->types);
  d[11] = lb->types.len;
  d[12] = rel_offset(&lb->ids);
  d[13] = lb->ids.len;
  d[14] = rel_offset(&lb->id_present);
  d[15] = lb->id_present.len;
  d[16] = rel_offset(&lb->vertex_offsets);
  d[17] = lb->vertex_offsets.len;
  d[18] = rel_offset(&lb->part_offsets);
  d[19] = lb->part_offsets.len;
  d[20] = rel_offset(&lb->part_ends);
  d[21] = lb->part_ends.len;
  d[22] = rel_offset(&lb->tag_offsets);
  d[23] = lb->tag_offsets.len;
  d[24] = rel_offset(&lb->tags);
  d[25] = lb->tags.len;
  d[26] = rel_offset(&lb->xy);
  d[27] = lb->xy.len;
}

__attribute__((visibility("default")))
int32_t decode_tile(uint32_t in_ptr, uint32_t in_len, uint32_t filter_ptr, uint32_t filter_len,
                    uint32_t out_ptr, uint32_t out_cap, uint32_t max_features, uint32_t max_string) {
  const uint8_t *b = (const uint8_t *)(uintptr_t)in_ptr;
  const uint8_t *filter = (const uint8_t *)(uintptr_t)filter_ptr;
  uint8_t *out = (uint8_t *)(uintptr_t)out_ptr;
  if (in_len == 0 || out_cap < HEADER_SIZE) return -1;

  Arena a;
  a.base = out;
  a.cap = out_cap;
  a.pos = HEADER_SIZE;
  a.failed = 0;

  Vec descs;
  vec_init(&descs, LAYER_DESC_SIZE, 8);

  uint32_t total_features = 0;
  uint32_t raw_layers = 0;
  uint32_t p = 0;
  while (p < in_len) {
    uint64_t key;
    if (!read_varint(b, in_len, &p, &key)) return -1;
    uint32_t field = (uint32_t)(key >> 3);
    uint32_t wire = (uint32_t)(key & 7u);
    if (field == 3u && wire == 2u) {
      uint32_t s, e;
      if (!read_range(b, in_len, &p, &s, &e)) return -1;
      raw_layers++;
      LayerMeta meta;
      if (!scan_layer_meta(b, s, e, max_string, &meta)) return -1;
      if (!layer_allowed(b, meta.name_start, meta.name_len, filter, filter_len)) continue;
      if (total_features >= max_features) continue;

      uint32_t name_offset = 0;
      if (meta.name_len) {
        name_offset = append_blob_string(&a, b + meta.name_start, meta.name_len);
        if (a.failed) return -2;
      }

      LayerBuilder lb;
      if (!parse_layer_stream(b, s, e, max_features - total_features, max_string, &a, &meta, &lb)) {
        return a.failed ? -2 : -1;
      }
      if (lb.feature_count == 0) continue;
      uint32_t *desc = (uint32_t *)vec_append(&a, &descs, 1);
      if (!desc) return -2;
      write_layer_desc(desc, &meta, name_offset, &lb);
      total_features += lb.feature_count;
    } else if (!skip_field(b, in_len, &p, wire)) {
      return -1;
    }
  }

  uint32_t *header = (uint32_t *)out;
  for (uint32_t i = 0; i < HEADER_WORDS; i++) header[i] = 0;
  header[0] = MAGIC;
  header[1] = VERSION;
  header[2] = a.pos;
  header[3] = descs.len;
  header[4] = total_features;
  header[5] = raw_layers;
  header[6] = rel_offset(&descs);
  header[7] = descs.len * LAYER_DESC_SIZE;
  header[8] = 0;
  header[9] = 0;
  return (int32_t)a.pos;
}
