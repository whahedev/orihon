import type { ObjectId } from "./object-types.js";

export interface SearchableObject {
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ObjectSearchOptions {
  fields?: string[];
  limit?: number;
  caseSensitive?: boolean;
}

export interface ObjectSearchResult {
  id: ObjectId;
  object: SearchableObject;
  score: number;
}

export interface ObjectSearchConfig {
  fields: string[];
  normalize?: boolean;
}

function getPath(object: SearchableObject, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = object;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function normalizeSearchText(value: string, normalize = true): string {
  let text = String(value ?? "");
  if (!normalize) return text;
  text = text.replace(/[\u0300-\u036f]/g, "");
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(text: string): string[] {
  return text.split(/[^a-z0-9а-яё_+-]+/i).filter(Boolean);
}

/**
 * Lightweight inverted token index for local ObjectManager search.
 * Updates incrementally on property changes only.
 */
export class ObjectSearchIndex {
  private readonly config: ObjectSearchConfig;
  private readonly tokensById = new Map<ObjectId, string[]>();
  private readonly inverted = new Map<string, Set<ObjectId>>();

  constructor(config: ObjectSearchConfig) {
    this.config = {
      fields: [...config.fields],
      normalize: config.normalize !== false
    };
  }

  get fields(): readonly string[] {
    return this.config.fields;
  }

  clear(): void {
    this.tokensById.clear();
    this.inverted.clear();
  }

  remove(id: ObjectId): void {
    const prev = this.tokensById.get(id);
    if (!prev) return;
    for (const token of prev) {
      const set = this.inverted.get(token);
      if (!set) continue;
      set.delete(id);
      if (!set.size) this.inverted.delete(token);
    }
    this.tokensById.delete(id);
  }

  upsert(id: ObjectId, object: SearchableObject): void {
    this.remove(id);
    const bag = new Set<string>();
    for (const field of this.config.fields) {
      const value = getPath(object, field);
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          for (const token of tokenize(normalizeSearchText(String(item), this.config.normalize))) {
            bag.add(token);
          }
        }
        continue;
      }
      for (const token of tokenize(normalizeSearchText(String(value), this.config.normalize))) {
        bag.add(token);
      }
    }
    if (!bag.size) return;
    const tokens = [...bag];
    this.tokensById.set(id, tokens);
    for (const token of tokens) {
      let set = this.inverted.get(token);
      if (!set) {
        set = new Set();
        this.inverted.set(token, set);
      }
      set.add(id);
    }
  }

  search(
    query: string,
    objects: Map<ObjectId, SearchableObject>,
    options: ObjectSearchOptions = {}
  ): ObjectSearchResult[] {
    const limit = Math.max(1, Math.floor(Number(options.limit) || 20));
    const normalizedQuery = options.caseSensitive
      ? String(query ?? "").trim()
      : normalizeSearchText(String(query ?? ""), this.config.normalize);
    if (!normalizedQuery) return [];
    const terms = tokenize(normalizedQuery);
    if (!terms.length) return [];

    const scores = new Map<ObjectId, number>();
    for (const term of terms) {
      for (const [token, ids] of this.inverted) {
        if (!token.startsWith(term) && token !== term) continue;
        const weight = token === term ? 3 : 1 + term.length / Math.max(token.length, 1);
        for (const id of ids) {
          scores.set(id, (scores.get(id) ?? 0) + weight);
        }
      }
    }

    const results: ObjectSearchResult[] = [];
    for (const [id, score] of scores) {
      const object = objects.get(id);
      if (!object) continue;
      results.push({ id, object, score });
    }
    results.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    return results.slice(0, limit);
  }
}
