export type AIJSONSchema = Readonly<Record<string, unknown>>;
export type AIEngineSchemaProfile = "full" | "scene" | "objects" | "points" | "routes" | "readonly";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

const ref = (name: string) => ({ $ref: `#/$defs/${name}` }) as const;

const id = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
} as const;

const position = {
  type: "object",
  required: ["lat", "lng"],
  additionalProperties: false,
  properties: {
    lat: { type: "number", minimum: -90, maximum: 90 },
    lng: { type: "number", minimum: -180, maximum: 180 }
  }
} as const;

const textContent = {
  type: "object",
  required: ["text"],
  additionalProperties: false,
  properties: { text: { type: "string" } }
} as const;

const pathStyle = {
  type: "object",
  additionalProperties: false,
  properties: {
    stroke: { type: "string", minLength: 1 },
    strokeWidth: { type: "number", minimum: 0 },
    strokeOpacity: { type: "number", minimum: 0, maximum: 1 },
    fill: { type: "string", minLength: 1 },
    fillOpacity: { type: "number", minimum: 0, maximum: 1 },
    lineCap: { enum: ["butt", "round", "square"] },
    lineJoin: { enum: ["bevel", "round", "miter"] },
    dashArray: {
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "number", minimum: 0 } },
        { type: "null" }
      ]
    },
    dashOffset: { type: "number" },
    geodesic: { type: "boolean" },
    arrow: { oneOf: [{ type: "boolean" }, { enum: ["end", "start", "both"] }] },
    arrowSize: { type: "number", minimum: 0 },
    interactive: { type: "boolean" }
  }
} as const;

const commonLayerProperties = {
  id: ref("id"),
  attribution: { type: "string" },
  popup: ref("textContent"),
  tooltip: ref("textContent")
} as const;

const marker = {
  type: "object",
  required: ["type", "position"],
  additionalProperties: false,
  properties: {
    ...commonLayerProperties,
    type: { const: "marker" },
    position: ref("position"),
    title: { type: "string" },
    appearance: {
      type: "object",
      additionalProperties: false,
      properties: {
        shape: { enum: ["pin", "circle", "square", "dot", "diamond", "triangle"] },
        color: { type: "string", minLength: 1 },
        strokeColor: { type: "string", minLength: 1 },
        size: { type: "number", minimum: 1 },
        strokeWidth: { type: "number", minimum: 0 }
      }
    },
    opacity: { type: "number", minimum: 0, maximum: 1 },
    zIndexOffset: { type: "number" },
    interactive: { type: "boolean" },
    rotation: { type: "number" }
  }
} as const;

const polyline = {
  type: "object",
  required: ["type", "coordinates"],
  additionalProperties: false,
  properties: {
    ...commonLayerProperties,
    type: { const: "polyline" },
    coordinates: { type: "array", minItems: 2, items: ref("position") },
    style: ref("pathStyle")
  }
} as const;

const polygon = {
  type: "object",
  required: ["type", "rings"],
  additionalProperties: false,
  properties: {
    ...commonLayerProperties,
    type: { const: "polygon" },
    rings: {
      oneOf: [
        { type: "array", minItems: 3, items: ref("position") },
        { type: "array", minItems: 1, items: { type: "array", minItems: 3, items: ref("position") } }
      ]
    },
    style: ref("pathStyle")
  }
} as const;

const geojson = {
  type: "object",
  required: ["type", "data"],
  additionalProperties: false,
  properties: {
    ...commonLayerProperties,
    type: { const: "geojson" },
    data: { type: "object", required: ["type"] },
    style: ref("pathStyle"),
    renderer: { enum: ["svg", "canvas", "auto"] },
    maxFeatures: { type: "integer", minimum: 1 }
  }
} as const;

const rasterProperties = {
  url: { type: "string", minLength: 1 },
  minZoom: { type: "number", minimum: 0 },
  maxZoom: { type: "number", minimum: 0 },
  maxNativeZoom: { type: "number", minimum: 0 },
  tileSize: { type: "number", minimum: 1 },
  opacity: { type: "number", minimum: 0, maximum: 1 },
  subdomains: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
  noWrap: { type: "boolean" },
  tms: { type: "boolean" }
} as const;

const raster = {
  type: "object",
  required: ["type", "url"],
  additionalProperties: false,
  properties: {
    ...commonLayerProperties,
    type: { const: "raster" },
    ...rasterProperties
  }
} as const;

const layerKindRefs = ["marker", "polyline", "polygon", "geojson", "raster"].map(ref);
const layerDescription = {
  oneOf: layerKindRefs.map((schemaRef) => ({ allOf: [schemaRef, { not: { required: ["id"] } }] }))
} as const;
const layer = {
  oneOf: layerKindRefs.map((schemaRef) => ({ allOf: [schemaRef, { required: ["id"] }] }))
} as const;

const basemap = {
  type: "object",
  required: ["type", "url"],
  additionalProperties: false,
  properties: {
    type: { const: "raster" },
    attribution: { type: "string" },
    ...rasterProperties
  }
} as const;

const scene = {
  type: "object",
  required: ["version", "layers"],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    camera: {
      type: "object",
      required: ["center", "zoom"],
      additionalProperties: false,
      properties: { center: ref("position"), zoom: { type: "number", minimum: 0 } }
    },
    basemap: { oneOf: [ref("basemap"), { type: "null" }] },
    layers: { type: "array", items: ref("layer") }
  }
} as const;

const idList = { type: "array", uniqueItems: true, items: ref("id") } as const;

const commandDefinitions = {
  id,
  idList,
  position,
  textContent,
  pathStyle,
  marker,
  polyline,
  polygon,
  geojson,
  raster,
  layerDescription,
  layer,
  basemap,
  scene,
  setView: {
    type: "object", required: ["op", "center", "zoom"], additionalProperties: false,
    properties: { op: { const: "set_view" }, center: ref("position"), zoom: { type: "number", minimum: 0 } }
  },
  flyTo: {
    type: "object", required: ["op", "center"], additionalProperties: false,
    properties: {
      op: { const: "fly_to" }, center: ref("position"),
      zoom: { type: "number", minimum: 0 }, durationMs: { type: "number", minimum: 0 }
    }
  },
  add: {
    type: "object", required: ["op", "id", "layer"], additionalProperties: false,
    properties: { op: { const: "add" }, id: ref("id"), layer: ref("layerDescription") }
  },
  update: {
    type: "object", required: ["op", "id", "patch"], additionalProperties: false,
    properties: {
      op: { const: "update" }, id: ref("id"),
      patch: { type: "object", not: { anyOf: [{ required: ["id"] }, { required: ["type"] }] } }
    }
  },
  remove: {
    type: "object", required: ["op", "id"], additionalProperties: false,
    properties: { op: { const: "remove" }, id: ref("id") }
  },
  clear: {
    type: "object", required: ["op"], additionalProperties: false,
    properties: { op: { const: "clear" }, ids: ref("idList") }
  },
  fit: {
    type: "object", required: ["op"], additionalProperties: false,
    properties: {
      op: { const: "fit" }, ids: ref("idList"), padding: { type: "number", minimum: 0 },
      animation: { enum: ["none", "fly"] }, durationMs: { type: "number", minimum: 0 }
    }
  },
  query: {
    type: "object", required: ["op"], additionalProperties: false,
    properties: { op: { const: "query" }, ids: ref("idList") }
  },
  applyScene: {
    type: "object", required: ["op", "scene"], additionalProperties: false,
    properties: { op: { const: "apply_scene" }, scene: ref("scene") }
  }
} as const;

const sceneCommandNames = ["setView", "flyTo", "add", "update", "remove", "clear", "fit", "query", "applyScene"] as const;

/** Compact, self-contained input schema suitable for function/tool registration. */
export const AI_COMMAND_SCHEMA: AIJSONSchema = deepFreeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Orihon AI Command v1",
  $defs: commandDefinitions,
  oneOf: sceneCommandNames.map(ref)
});

const geoJSONPosition = {
  type: "array",
  minItems: 2,
  maxItems: 2,
  prefixItems: [
    { type: "number", minimum: -180, maximum: 180 },
    { type: "number", minimum: -90, maximum: 90 }
  ]
} as const;

const objectDefinitions = {
  objectId: { oneOf: [ref("id"), { type: "number" }] },
  objectIds: { type: "array", uniqueItems: true, items: ref("objectId") },
  geoJSONPosition,
  objectGeometry: {
    oneOf: [ref("pointGeometry"), ref("lineStringGeometry"), ref("polygonGeometry")]
  },
  pointGeometry: {
    type: "object", required: ["type", "coordinates"], additionalProperties: false,
    properties: { type: { const: "Point" }, coordinates: ref("geoJSONPosition") }
  },
  lineStringGeometry: {
    type: "object", required: ["type", "coordinates"], additionalProperties: false,
    properties: {
      type: { const: "LineString" },
      coordinates: { type: "array", minItems: 2, items: ref("geoJSONPosition") }
    }
  },
  polygonGeometry: {
    type: "object", required: ["type", "coordinates"], additionalProperties: false,
    properties: {
      type: { const: "Polygon" },
      coordinates: {
        type: "array", minItems: 1,
        items: { type: "array", minItems: 3, items: ref("geoJSONPosition") }
      }
    }
  },
  objectFeature: {
    type: "object", required: ["type", "id", "geometry"], additionalProperties: false,
    properties: {
      type: { const: "Feature" }, id: ref("objectId"), geometry: ref("objectGeometry"),
      properties: { oneOf: [{ type: "object" }, { type: "null" }] }
    }
  },
  objectList: { type: "array", items: ref("objectFeature") },
  addChange: {
    type: "object", required: ["type", "objects"], additionalProperties: false,
    properties: { type: { const: "add" }, objects: ref("objectList") }
  },
  updateChange: {
    type: "object", required: ["type", "objects"], additionalProperties: false,
    properties: { type: { const: "update" }, objects: ref("objectList") }
  },
  removeChange: {
    type: "object", required: ["type", "ids"], additionalProperties: false,
    properties: { type: { const: "remove" }, ids: ref("objectIds") }
  },
  objectChange: { oneOf: [ref("addChange"), ref("updateChange"), ref("removeChange")] },
  objectsAdd: {
    type: "object", required: ["op", "collection", "objects"], additionalProperties: false,
    properties: { op: { const: "objects.add" }, collection: ref("id"), objects: ref("objectList") }
  },
  objectsUpdate: {
    type: "object", required: ["op", "collection", "objects"], additionalProperties: false,
    properties: { op: { const: "objects.update" }, collection: ref("id"), objects: ref("objectList") }
  },
  objectsReplace: {
    type: "object", required: ["op", "collection", "objects"], additionalProperties: false,
    properties: { op: { const: "objects.replace" }, collection: ref("id"), objects: ref("objectList") }
  },
  objectsRemove: {
    type: "object", required: ["op", "collection", "ids"], additionalProperties: false,
    properties: { op: { const: "objects.remove" }, collection: ref("id"), ids: ref("objectIds") }
  },
  objectsClear: {
    type: "object", required: ["op", "collection"], additionalProperties: false,
    properties: { op: { const: "objects.clear" }, collection: ref("id") }
  },
  objectsBatch: {
    type: "object", required: ["op", "collection", "changes"], additionalProperties: false,
    properties: {
      op: { const: "objects.batch" }, collection: ref("id"),
      changes: { type: "array", items: ref("objectChange") }
    }
  }
} as const;

const objectCommandNames = ["objectsAdd", "objectsUpdate", "objectsReplace", "objectsRemove", "objectsClear", "objectsBatch"] as const;

const pointCategory = { enum: ["alpha", "beta", "gamma", "alert"] } as const;

const pointDefinitions = {
  pointCategory,
  pointPopupImage: {
    type: "object", required: ["url"], additionalProperties: false,
    properties: {
      url: { type: "string", minLength: 1, maxLength: 2048 },
      alt: { type: "string", maxLength: 500 },
      caption: { type: "string", maxLength: 1000 }
    }
  },
  pointPopupRich: {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: {
      text: { type: "string", maxLength: 4000 },
      image: ref("pointPopupImage")
    }
  },
  pointPopup: {
    oneOf: [{ type: "string" }, ref("pointPopupRich")]
  },
  pointVisualImage: {
    type: "object", required: ["url"], additionalProperties: false,
    properties: {
      url: { type: "string", minLength: 1, maxLength: 2048 },
      alt: { type: "string", maxLength: 500 },
      shape: { enum: ["circle", "rectangle"] },
      fit: { enum: ["cover", "contain", "fill"] },
      borderColor: { type: "string", minLength: 1, maxLength: 64 },
      borderWidth: { type: "number", minimum: 0, maximum: 16 }
    }
  },
  pointVisualOffset: {
    type: "object", required: ["x", "y"], additionalProperties: false,
    properties: {
      x: { type: "number", minimum: -256, maximum: 256 },
      y: { type: "number", minimum: -256, maximum: 256 }
    }
  },
  pointVisualLabel: {
    type: "object", additionalProperties: false,
    properties: {
      text: { type: "string", maxLength: 500 },
      display: { enum: ["hover", "always"] },
      fontSize: { type: "number", minimum: 8, maximum: 48 },
      fontWeight: { type: "number", minimum: 100, maximum: 900 },
      color: { type: "string", minLength: 1, maxLength: 64 },
      haloColor: { type: "string", minLength: 1, maxLength: 64 },
      haloWidth: { type: "number", minimum: 0, maximum: 8 },
      offset: ref("pointVisualOffset"), priority: { type: "number" },
      minZoom: { type: "number", minimum: 0, maximum: 30 },
      maxZoom: { type: "number", minimum: 0, maximum: 30 }
    }
  },
  pointVisual: {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: {
      image: ref("pointVisualImage"),
      label: { oneOf: [{ type: "string", maxLength: 500 }, ref("pointVisualLabel")] },
      size: { type: "number", minimum: 8, maximum: 256 },
      collisionMode: { enum: ["auto", "always", "hide"] }
    }
  },
  pointItem: {
    type: "object", required: ["id", "position"], additionalProperties: false,
    properties: {
      id: ref("objectId"), position: ref("position"), title: { type: "string" },
      popup: ref("pointPopup"), visual: ref("pointVisual"), category: ref("pointCategory")
    }
  },
  pointDefaults: {
    type: "object", additionalProperties: false,
    properties: {
      category: ref("pointCategory"),
      visual: {
        type: "object", additionalProperties: false,
        properties: {
          image: {
            type: "object", additionalProperties: false,
            properties: {
              url: { type: "string", minLength: 1, maxLength: 2048 },
              alt: { type: "string", maxLength: 500 },
              shape: { enum: ["circle", "rectangle"] },
              fit: { enum: ["cover", "contain", "fill"] },
              borderColor: { type: "string", minLength: 1, maxLength: 64 },
              borderWidth: { type: "number", minimum: 0, maximum: 16 }
            }
          },
          label: { oneOf: [{ type: "string", maxLength: 500 }, ref("pointVisualLabel")] },
          size: { type: "number", minimum: 8, maximum: 256 },
          collisionMode: { enum: ["auto", "always", "hide"] }
        }
      }
    }
  },
  pointViewport: {
    type: "object", required: ["mode"], additionalProperties: false,
    properties: {
      mode: { const: "fit" }, padding: { type: "number", minimum: 0 },
      animation: { enum: ["none", "fly"] }, durationMs: { type: "number", minimum: 0 }
    }
  },
  pointsReplace: {
    type: "object", required: ["op", "collection", "points"], additionalProperties: false,
    properties: {
      op: { const: "points.replace" }, collection: ref("id"),
      points: { type: "array", items: ref("pointItem") },
      defaults: ref("pointDefaults"), viewport: ref("pointViewport"), clearMap: { type: "boolean" }
    }
  }
} as const;

const routeDefinitions = {
  routePlan: {
    type: "object", required: ["op", "routeId", "collection"], additionalProperties: false,
    properties: {
      op: { const: "route.plan" }, routeId: ref("id"), collection: ref("id"),
      ids: ref("objectIds"), startId: ref("objectId"), endId: ref("objectId"),
      optimize: { const: "shortest" }, closeLoop: { type: "boolean" }, annotateStops: { type: "boolean" },
      reactive: { type: "boolean" }
    }
  }
} as const;

const engineDefinitions = { ...commandDefinitions, ...objectDefinitions, ...pointDefinitions, ...routeDefinitions } as const;
const engineCommandNames = [...sceneCommandNames, ...objectCommandNames, "pointsReplace", "routePlan"] as const;

function selectSchema(title: string, names: readonly string[]): AIJSONSchema {
  const selected = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const schema = value as Record<string, unknown>;
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/$defs/")) {
      const name = schema.$ref.slice(8);
      if (!selected.has(name)) {
        selected.add(name);
        visit((engineDefinitions as Record<string, unknown>)[name]);
      }
    }
    for (const child of Object.values(schema)) visit(child);
  };
  for (const name of names) {
    selected.add(name);
    visit((engineDefinitions as Record<string, unknown>)[name]);
  }
  return deepFreeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title,
    $defs: Object.fromEntries([...selected].map((name) => [name, (engineDefinitions as Record<string, unknown>)[name]])),
    oneOf: names.map(ref)
  });
}

/** Scene commands plus incremental ObjectManager collection commands. */
export const AI_ENGINE_COMMAND_SCHEMA: AIJSONSchema = deepFreeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Orihon AI Engine Command v1",
  $defs: engineDefinitions,
  oneOf: engineCommandNames.map(ref)
});

/** Self-contained schemas that let hosts avoid sending unrelated command families. */
export const AI_ENGINE_COMMAND_SCHEMAS: Readonly<Record<AIEngineSchemaProfile, AIJSONSchema>> = deepFreeze({
  full: AI_ENGINE_COMMAND_SCHEMA,
  scene: AI_COMMAND_SCHEMA,
  objects: selectSchema("Orihon AI Object Commands v1", objectCommandNames),
  points: selectSchema("Orihon AI Point Collection Command v1", ["pointsReplace"]),
  routes: selectSchema("Orihon AI Route Command v1", ["routePlan"]),
  readonly: selectSchema("Orihon AI Readonly Command v1", ["query"])
});

export function getAIEngineCommandSchema(profile: AIEngineSchemaProfile = "full"): AIJSONSchema {
  const schema = AI_ENGINE_COMMAND_SCHEMAS[profile];
  if (!schema) throw new TypeError(`Unknown Orihon AI schema profile: ${String(profile)}`);
  return schema;
}
