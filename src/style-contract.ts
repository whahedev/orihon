/** Removed spellings stay forbidden even on pre-existing option variables. */
export interface RemovedPointStyleAliases {
  color?: never;
  opacity?: never;
}

export interface RemovedLineStyleAliases extends RemovedPointStyleAliases {
  width?: never;
}

export function rejectStyleAliases(value: object, kind: "point" | "line"): void {
  const fields = kind === "point"
    ? { color: "fill", opacity: "fillOpacity" }
    : { color: "stroke", opacity: "strokeOpacity", width: "strokeWidth" };
  for (const [oldName, name] of Object.entries(fields)) {
    if (oldName in value) throw new TypeError(`${oldName} was removed from ${kind} styles. Use ${name}.`);
  }
}
