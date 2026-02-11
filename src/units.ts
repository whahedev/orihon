/** Internal boundary validation shared by unit-bearing public APIs. */
export function nonNegativeFinite(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number.`);
  }
  return value;
}

export function rejectLegacyUnit(options: object, oldName: string, replacement: string): void {
  if (oldName in options) throw new TypeError(`${oldName} was removed. Use ${replacement} with explicit units.`);
}
