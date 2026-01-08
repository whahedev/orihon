#include <stdint.h>

typedef struct {
  uint8_t *base;
  uint32_t cap;
  uint32_t pos;
  int failed;
} Arena;

typedef struct {
  uint32_t name_start;
  uint32_t name_len;
  uint32_t extent;
  uint32_t key_count;
  uint32_t value_count;
  uint32_t feature_count;
  uint32_t tag_count;
  uint32_t vertex_count;
  uint32_t part_count;
} LayerMeasure;

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

static int read_varint(const uint8_t *b, uint32_t end, uint32_t *p, uint64_t *out) {
  uint64_t v = 0;
  uint32_t shift = 0;
  for (uint32_t i = 0; i < 10 && *p < end; i++) {
    uint8_t c = b[(*p)++];
    if (shift < 64) v |= ((uint64_t)(c & 0x7fu)) << shift;
    if ((c & 0x80u) == 0) {
      *out = v;
      return 1;
    }
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
  if (wire == 1) {
    if (end - *p < 8) return 0;
    *p += 8;
    return 1;
  }
  if (wire == 2) return read_range(b, end, p, &s, &e);
  if (wire == 5) {
    if (end - *p < 4) return 0;
    *p += 4;
    return 1;
  }
  return 0;
}

static int count_varints(const uint8_t *b, uint32_t start, uint32_t end, uint32_t *count) {
  uint32_t p = start;
  uint32_t n = 0;
  uint64_t v;
  while (p < end) {
    if (!read_varint(b, end, &p, &v)) return 0;
    n++;
  }
  *count = n;
  return 1;
}

static int32_t zigzag32(uint32_t v) {
  return (int32_t)((v >> 1) ^ (uint32_t)-(int32_t)(v & 1u));
}

static int measure_geometry(const uint8_t *b, uint32_t start, uint32_t end, uint32_t *vertices, uint32_t *parts) {
  uint32_t p = start;
  uint32_t write = 0;
  uint32_t part_start = 0;
  uint32_t part_count = 0;
  uint64_t raw;
  while (p < end) {
    if (!read_varint(b, end, &p, &raw)) return 0;
    uint32_t cmd = (uint32_t)raw;
    uint32_t id = cmd & 7u;
    uint32_t count = cmd >> 3;
    if (id == 1u || id == 2u) {
      if (id == 1u && write > part_start) {
        part_count++;
        part_start = write;
      }
      if (count > (0xffffffffu - write)) return 0;
      for (uint32_t i = 0; i < count; i++) {
        uint64_t dx, dy;
        if (!read_varint(b, end, &p, &dx) || !read_varint(b, end, &p, &dy)) return 0;
        (void)dx; (void)dy;
        write++;
      }
    } else if (id == 7u) {
      if (write > part_start) {
        if (write == 0xffffffffu) return 0;
        write++; /* duplicate first point for closed ring, matching JS path */
        part_count++;
        part_start = write;
      }
    } else {
      break;
    }
  }
  if (write > part_start) part_count++;
  *vertices = write;
  *parts = part_count;
  return 1;
}

static int measure_feature(const uint8_t *b, uint32_t start, uint32_t end, uint32_t *tags, uint32_t *vertices, uint32_t *parts) {
  uint32_t p = start;
  uint32_t tag_count = 0;
  uint32_t geom_start = 0, geom_end = 0;
  while (p < end) {
    uint64_t key;
    if (!read_varint(b, end, &p, &key)) return 0;
    uint32_t field = (uint32_t)(key >> 3);
    uint32_t wire = (uint32_t)(key & 7u);
    if (field == 2u && wire == 2u) {
      uint32_t s, e, n;
      if (!read_range(b, end, &p, &s, &e) || !count_varints(b, s, e, &n)) return 0;
      tag_count = n;
    } else if (field == 4u && wire == 2u) {
      if (!read_range(b, end, &p, &geom_start, &geom_end)) return 0;
    } else if (!skip_field(b, end, &p, wire)) {
      return 0;
    }
  }
  uint32_t vertex_count = 0, part_count = 0;
  if (geom_end > geom_start && !measure_geometry(b, geom_start, geom_end, &vertex_count, &part_count)) return 0;
  *tags = tag_count;
  *vertices = vertex_count;
  *parts = part_count;
  return 1;
}

static int measure_layer(const uint8_t *b, uint32_t start, uint32_t end, uint32_t max_features, uint32_t max_string, LayerMeasure *m) {
  m->name_start = 0;
  m->name_len = 0;
  m->extent = 4096;
  m->key_count = 0;
  m->value_count = 0;
  m->feature_count = 0;
  m->tag_count = 0;
  m->vertex_count = 0;
  m->part_count = 0;
  int have_name = 0;
  uint32_t p = start;
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
    } else if (field == 2u && wire == 2u) {
      uint32_t s, e;
      if (!read_range(b, end, &p, &s, &e)) return 0;
      if (m->feature_count < max_features) {
        uint32_t tags, vertices, parts;
        if (!measure_feature(b, s, e, &tags, &vertices, &parts)) return 0;
        if (vertices > 0) {
          if (m->tag_count > 0xffffffffu - tags || m->vertex_count > 0xffffffffu - vertices || m->part_count > 0xffffffffu - parts) return 0;
          m->tag_count += tags;
          m->vertex_count += vertices;
          m->part_count += parts;
          m->feature_count++;
        }
      }
    } else if (field == 3u && wire == 2u) {
      uint32_t s, e;
      if (!read_range(b, end, &p, &s, &e)) return 0;
      m->key_count++;
    } else if (field == 4u && wire == 2u) {
      uint32_t s, e;
      if (!read_range(b, end, &p, &s, &e)) return 0;
      m->value_count++;
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


static int layer_allowed(const uint8_t *b, uint32_t name_start, uint32_t name_len,
                         const uint8_t *filter, uint32_t filter_len) {
  if (filter_len == 0) return 1;
  uint32_t p = 0;
  while (p < filter_len) {
    if (filter_len - p < 4) return 0;
    uint32_t n = (uint32_t)filter[p] | ((uint32_t)filter[p + 1] << 8) |
                 ((uint32_t)filter[p + 2] << 16) | ((uint32_t)filter[p + 3] << 24);
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

static uint32_t read_u32_le(const uint8_t *b, uint32_t p) {
  return (uint32_t)b[p] | ((uint32_t)b[p+1] << 8) | ((uint32_t)b[p+2] << 16) | ((uint32_t)b[p+3] << 24);
}

static uint64_t read_u64_le(const uint8_t *b, uint32_t p) {
  uint64_t lo = read_u32_le(b, p);
  uint64_t hi = read_u32_le(b, p + 4);
  return lo | (hi << 32);
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

static int write_value_desc(const uint8_t *b, uint32_t start, uint32_t end, uint32_t max_string, uint8_t *desc, Arena *a, uint32_t out_base_addr) {
  uint32_t *u = (uint32_t *)desc;
  u[0] = 0; u[1] = 0; u[2] = 0; u[3] = 0;
  *((double *)(desc + 16)) = 0.0;
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
      u[0] = 1; /* string */
      u[1] = 0;
      u[2] = 0;
      if (n > 0 && n <= max_string) {
        uint8_t *copy = arena_alloc(a, n, 1);
        if (!copy) return 0;
        copy_bytes(copy, b + s, n);
        u[1] = (uint32_t)(copy - (uint8_t *)(uintptr_t)out_base_addr);
        u[2] = n;
      }
      *((double *)(desc + 16)) = 0.0;
    } else if (field == 2u && wire == 5u) {
      if (end - p < 4) return 0;
      u[0] = 2;
      *((double *)(desc + 16)) = f32_to_double(read_u32_le(b, p));
      p += 4;
    } else if (field == 3u && wire == 1u) {
      if (end - p < 8) return 0;
      u[0] = 2;
      *((double *)(desc + 16)) = f64_from_bits(read_u64_le(b, p));
      p += 8;
    } else if (field == 4u && wire == 0u) {
      uint64_t v;
      if (!read_varint(b, end, &p, &v)) return 0;
      u[0] = 2;
      *((double *)(desc + 16)) = (double)v;
    } else if (field == 5u && wire == 0u) {
      uint64_t v;
      if (!read_varint(b, end, &p, &v)) return 0;
      u[0] = 2;
      *((double *)(desc + 16)) = (double)zigzag32((uint32_t)v);
    } else if (field == 6u && wire == 0u) {
      uint64_t v;
      if (!read_varint(b, end, &p, &v)) return 0;
      u[0] = 3; /* bool */
      *((double *)(desc + 16)) = v ? 1.0 : 0.0;
    } else if (!skip_field(b, end, &p, wire)) {
      return 0;
    }
  }
  return 1;
}

static int write_geometry(const uint8_t *b, uint32_t start, uint32_t end, int32_t *xy, uint32_t vertex_base, uint32_t *part_ends, uint32_t part_base, uint32_t *vertices_written, uint32_t *parts_written) {
  uint32_t p = start;
  uint32_t write = 0;
  uint32_t part_start = 0;
  uint32_t part_write = 0;
  int32_t x = 0, y = 0;
  while (p < end) {
    uint64_t raw;
    if (!read_varint(b, end, &p, &raw)) return 0;
    uint32_t cmd = (uint32_t)raw;
    uint32_t id = cmd & 7u;
    uint32_t count = cmd >> 3;
    if (id == 1u || id == 2u) {
      if (id == 1u && write > part_start) {
        part_ends[part_base + part_write++] = vertex_base + write;
        part_start = write;
      }
      for (uint32_t i = 0; i < count; i++) {
        uint64_t dx, dy;
        if (!read_varint(b, end, &p, &dx) || !read_varint(b, end, &p, &dy)) return 0;
        x += zigzag32((uint32_t)dx);
        y += zigzag32((uint32_t)dy);
        uint32_t v = vertex_base + write;
        xy[v * 2u] = x;
        xy[v * 2u + 1u] = y;
        write++;
      }
    } else if (id == 7u) {
      if (write > part_start) {
        uint32_t dst = vertex_base + write;
        uint32_t src = vertex_base + part_start;
        xy[dst * 2u] = xy[src * 2u];
        xy[dst * 2u + 1u] = xy[src * 2u + 1u];
        write++;
        part_ends[part_base + part_write++] = vertex_base + write;
        part_start = write;
      }
    } else {
      break;
    }
  }
  if (write > part_start) part_ends[part_base + part_write++] = vertex_base + write;
  *vertices_written = write;
  *parts_written = part_write;
  return 1;
}

static int write_feature(const uint8_t *b, uint32_t start, uint32_t end,
                         uint32_t feature_index,
                         uint8_t *types, double *ids, uint8_t *id_present,
                         uint32_t *vertex_offsets, uint32_t *part_offsets,
                         uint32_t *part_ends, uint32_t *tag_offsets, uint32_t *tags,
                         int32_t *xy,
                         uint32_t vertex_base, uint32_t part_base, uint32_t tag_base,
                         uint32_t *out_vertices, uint32_t *out_parts, uint32_t *out_tags) {
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
      uint64_t v;
      if (!read_varint(b, end, &p, &v)) return 0;
      have_id = 1;
      id_value = (double)v;
    } else if (field == 2u && wire == 2u) {
      if (!read_range(b, end, &p, &tags_start, &tags_end)) return 0;
    } else if (field == 3u && wire == 0u) {
      uint64_t v;
      if (!read_varint(b, end, &p, &v)) return 0;
      type = (uint32_t)v;
    } else if (field == 4u && wire == 2u) {
      if (!read_range(b, end, &p, &geom_start, &geom_end)) return 0;
    } else if (!skip_field(b, end, &p, wire)) {
      return 0;
    }
  }

  uint32_t gw = 0, pw = 0;
  if (geom_end > geom_start && !write_geometry(b, geom_start, geom_end, xy, vertex_base, part_ends, part_base, &gw, &pw)) return 0;
  if (gw == 0) {
    *out_vertices = 0; *out_parts = 0; *out_tags = 0;
    return 2; /* empty geometry: skip */
  }

  types[feature_index] = (uint8_t)type;
  ids[feature_index] = id_value;
  id_present[feature_index] = have_id ? 1 : 0;
  vertex_offsets[feature_index + 1u] = vertex_base + gw;
  part_offsets[feature_index + 1u] = part_base + pw;

  uint32_t tag_write = 0;
  if (tags_end > tags_start) {
    uint32_t tp = tags_start;
    while (tp < tags_end) {
      uint64_t v;
      if (!read_varint(b, tags_end, &tp, &v)) return 0;
      tags[tag_base + tag_write++] = (uint32_t)v;
    }
  }
  tag_offsets[feature_index + 1u] = tag_base + tag_write;
  *out_vertices = gw;
  *out_parts = pw;
  *out_tags = tag_write;
  return 1;
}

static int write_layer(const uint8_t *b, uint32_t input_len, uint32_t start, uint32_t end,
                       uint32_t max_features, uint32_t max_string,
                       const LayerMeasure *m, Arena *a, uint32_t *desc, uint32_t out_base_addr) {
  (void)input_len;
  uint32_t *key_ranges = (uint32_t *)arena_alloc(a, m->key_count * 8u, 4);
  uint8_t *value_desc = arena_alloc(a, m->value_count * VALUE_DESC_SIZE, 8);
  uint8_t *types = arena_alloc(a, m->feature_count, 1);
  double *ids = (double *)arena_alloc(a, m->feature_count * 8u, 8);
  uint8_t *id_present = arena_alloc(a, m->feature_count, 1);
  uint32_t *vertex_offsets = (uint32_t *)arena_alloc(a, (m->feature_count + 1u) * 4u, 4);
  uint32_t *part_offsets = (uint32_t *)arena_alloc(a, (m->feature_count + 1u) * 4u, 4);
  uint32_t *part_ends = (uint32_t *)arena_alloc(a, m->part_count * 4u, 4);
  uint32_t *tag_offsets = (uint32_t *)arena_alloc(a, (m->feature_count + 1u) * 4u, 4);
  uint32_t *tags = (uint32_t *)arena_alloc(a, m->tag_count * 4u, 4);
  int32_t *xy = (int32_t *)arena_alloc(a, m->vertex_count * 8u, 4);
  if (a->failed) return 0;

  #define REL(ptr) ((uint32_t)((uint8_t *)(ptr) - (uint8_t *)(uintptr_t)out_base_addr))
  for (uint32_t i = 0; i < LAYER_DESC_WORDS; i++) desc[i] = 0;
  uint32_t name_offset = 0;
  if (m->name_len) {
    uint8_t *name_copy = arena_alloc(a, m->name_len, 1);
    if (!name_copy) return 0;
    copy_bytes(name_copy, b + m->name_start, m->name_len);
    name_offset = REL(name_copy);
  }
  desc[0] = name_offset;
  desc[1] = m->name_len;
  desc[2] = m->extent;
  desc[3] = m->key_count;
  desc[4] = REL(key_ranges);
  desc[5] = m->key_count * 2u;
  desc[6] = m->value_count;
  desc[7] = REL(value_desc);
  desc[8] = m->value_count * VALUE_DESC_SIZE;
  desc[9] = m->feature_count;
  desc[10] = REL(types);
  desc[11] = m->feature_count;
  desc[12] = REL(ids);
  desc[13] = m->feature_count;
  desc[14] = REL(id_present);
  desc[15] = m->feature_count;
  desc[16] = REL(vertex_offsets);
  desc[17] = m->feature_count + 1u;
  desc[18] = REL(part_offsets);
  desc[19] = m->feature_count + 1u;
  desc[20] = REL(part_ends);
  desc[21] = m->part_count;
  desc[22] = REL(tag_offsets);
  desc[23] = m->feature_count + 1u;
  desc[24] = REL(tags);
  desc[25] = m->tag_count;
  desc[26] = REL(xy);
  desc[27] = m->vertex_count * 2u;
  #undef REL

  vertex_offsets[0] = 0;
  part_offsets[0] = 0;
  tag_offsets[0] = 0;

  uint32_t key_i = 0, value_i = 0, feature_i = 0;
  uint32_t vertex_write = 0, part_write = 0, tag_write = 0;
  uint32_t p = start;
  while (p < end) {
    uint64_t key;
    if (!read_varint(b, end, &p, &key)) return 0;
    uint32_t field = (uint32_t)(key >> 3);
    uint32_t wire = (uint32_t)(key & 7u);
    if (field == 1u && wire == 2u) {
      uint32_t s, e;
      if (!read_range(b, end, &p, &s, &e)) return 0;
    } else if (field == 2u && wire == 2u) {
      uint32_t s, e;
      if (!read_range(b, end, &p, &s, &e)) return 0;
      if (feature_i < m->feature_count && feature_i < max_features) {
        uint32_t vw, pw, tw;
        int code = write_feature(b, s, e, feature_i, types, ids, id_present,
                                 vertex_offsets, part_offsets, part_ends, tag_offsets, tags, xy,
                                 vertex_write, part_write, tag_write, &vw, &pw, &tw);
        if (code == 0) return 0;
        if (code == 1) {
          vertex_write += vw;
          part_write += pw;
          tag_write += tw;
          feature_i++;
        }
      }
    } else if (field == 3u && wire == 2u) {
      uint32_t s, e;
      if (!read_range(b, end, &p, &s, &e)) return 0;
      if (key_i < m->key_count) {
        uint32_t n = e - s;
        uint32_t off = 0;
        if (n > 0 && n <= max_string) {
          uint8_t *copy = arena_alloc(a, n, 1);
          if (!copy) return 0;
          copy_bytes(copy, b + s, n);
          off = (uint32_t)(copy - (uint8_t *)(uintptr_t)out_base_addr);
        } else {
          n = 0;
        }
        key_ranges[key_i * 2u] = off;
        key_ranges[key_i * 2u + 1u] = n;
        key_i++;
      }
    } else if (field == 4u && wire == 2u) {
      uint32_t s, e;
      if (!read_range(b, end, &p, &s, &e)) return 0;
      if (value_i < m->value_count) {
        if (!write_value_desc(b, s, e, max_string, value_desc + value_i * VALUE_DESC_SIZE, a, out_base_addr)) return 0;
        value_i++;
      }
    } else if (field == 5u && wire == 0u) {
      uint64_t tmp;
      if (!read_varint(b, end, &p, &tmp)) return 0;
    } else if (!skip_field(b, end, &p, wire)) {
      return 0;
    }
  }
  return feature_i == m->feature_count && vertex_write == m->vertex_count && part_write == m->part_count && tag_write == m->tag_count;
}

__attribute__((visibility("default")))
int32_t decode_tile(uint32_t in_ptr, uint32_t in_len, uint32_t filter_ptr, uint32_t filter_len, uint32_t out_ptr, uint32_t out_cap, uint32_t max_features, uint32_t max_string) {
  const uint8_t *b = (const uint8_t *)(uintptr_t)in_ptr;
  const uint8_t *filter = (const uint8_t *)(uintptr_t)filter_ptr;
  uint8_t *out = (uint8_t *)(uintptr_t)out_ptr;
  if (in_len == 0 || out_cap < HEADER_SIZE) return -1;

  /* Count raw layer messages so we can reserve a descriptor table once. */
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
    } else if (!skip_field(b, in_len, &p, wire)) {
      return -1;
    }
  }
  if (raw_layers > (0xffffffffu - HEADER_SIZE) / LAYER_DESC_SIZE) return -1;

  uint32_t desc_bytes = raw_layers * LAYER_DESC_SIZE;
  if (HEADER_SIZE + desc_bytes > out_cap) return -2;
  uint32_t *header = (uint32_t *)out;
  uint32_t *descs = (uint32_t *)(out + HEADER_SIZE);
  Arena a;
  a.base = out;
  a.cap = out_cap;
  a.pos = HEADER_SIZE + desc_bytes;
  a.failed = 0;

  uint32_t actual_layers = 0;
  uint32_t total_features = 0;
  uint32_t remaining = max_features;
  p = 0;
  while (p < in_len && remaining > 0) {
    uint64_t key;
    if (!read_varint(b, in_len, &p, &key)) return -1;
    uint32_t field = (uint32_t)(key >> 3);
    uint32_t wire = (uint32_t)(key & 7u);
    if (field == 3u && wire == 2u) {
      uint32_t s, e;
      if (!read_range(b, in_len, &p, &s, &e)) return -1;
      LayerMeasure m;
      if (!measure_layer(b, s, e, remaining, max_string, &m)) return -1;
      if (!layer_allowed(b, m.name_start, m.name_len, filter, filter_len)) continue;
      if (m.feature_count == 0) continue;
      if (!write_layer(b, in_len, s, e, remaining, max_string, &m, &a,
                       descs + actual_layers * LAYER_DESC_WORDS, out_ptr)) {
        if (a.failed) return -2;
        return -1;
      }
      actual_layers++;
      total_features += m.feature_count;
      remaining -= m.feature_count;
    } else if (!skip_field(b, in_len, &p, wire)) {
      return -1;
    }
  }

  for (uint32_t i = 0; i < HEADER_WORDS; i++) header[i] = 0;
  header[0] = MAGIC;
  header[1] = VERSION;
  header[2] = a.pos;
  header[3] = actual_layers;
  header[4] = total_features;
  header[5] = raw_layers;
  header[6] = HEADER_SIZE;
  header[7] = actual_layers * LAYER_DESC_SIZE;
  return (int32_t)a.pos;
}
