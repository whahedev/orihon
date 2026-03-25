/** Internal boundary validation and option merging shared by public APIs. */

/**
 * Merges caller options over defaults, skipping keys explicitly set to `undefined`.
 *
 * A plain `{ ...defaults, ...options }` lets `{ zoom: undefined }` overwrite the
 * default with `undefined`, which then fails validation. React props, optional
 * chaining and conditional spreads produce that shape constantly, so every
 * defaults merge on a public constructor goes through here.
 */
export function mergeOptions<TDefaults extends object, TOptions extends object>(
  defaults: TDefaults,
  options: TOptions | undefined
): TDefaults & TOptions {
  const merged = { ...defaults } as Record<string, unknown>;
  if (options) {
    for (const key of Object.keys(options) as Array<keyof TOptions & string>) {
      const value = (options as Record<string, unknown>)[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged as TDefaults & TOptions;
}
export function nonNegativeFinite(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number.`);
  }
  return value;
}

export function rejectLegacyUnit(options: object, oldName: string, replacement: string): void {
  if (oldName in options) throw new TypeError(`${oldName} was removed. Use ${replacement} with explicit units.`);
}
