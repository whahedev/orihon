# Orihon AI API

`orihon/ai` is a small JSON-only boundary for structured output, tool calling, and agents.
It owns only the layers created through its session; ordinary Orihon layers remain untouched.

```ts
import { createMap } from "orihon/easy";
import { createAISession } from "orihon/ai";
import "orihon/orihon.css";

const map = createMap("map");
const session = createAISession(map);

const result = session.applyScene({
  version: 1,
  camera: { center: { lat: 55.7558, lng: 37.6176 }, zoom: 11 },
  basemap: {
    type: "raster",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors"
  },
  layers: [{
    id: "moscow",
    type: "marker",
    position: { lat: 55.7558, lng: 37.6176 },
    popup: { text: "Москва" }
  }]
});

if (!result.ok) console.error(result.error);
```

Coordinates are always `{lat,lng}` objects, except inside standards-compliant GeoJSON,
whose coordinates remain `[longitude, latitude]`. Arrays are intentionally rejected for
ordinary coordinates.

## Commands

`session.execute(payload)` validates untrusted input and never throws validation errors.
It supports `set_view`, `fly_to`, `add`, `update`, `remove`, `clear`, `fit`, `query`, and
`apply_scene`.

```ts
session.execute({
  op: "add",
  id: "kremlin",
  layer: {
    type: "marker",
    position: { lat: 55.752, lng: 37.6175 },
    popup: { text: "Московский Кремль" }
  }
});

session.execute({
  op: "update",
  id: "kremlin",
  patch: { position: { lat: 55.7521, lng: 37.6177 } }
});

session.execute({ op: "fit", ids: ["kremlin"] });
session.execute({ op: "remove", id: "kremlin" });
```

Updates deep-merge JSON objects and replace arrays. Layer IDs and types are immutable.
Use `query` to obtain a serializable scene snapshot.

## Errors

Invalid input produces a repairable result:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_COORDINATE",
    "path": "$command.layer.position.lat",
    "message": "Latitude must be between -90 and 90",
    "received": 137.6
  }
}
```

The JSON Schema is exported as `orihon/schema/scene-v1.json`.

## Agent tool bridge

Bind a live session to one provider-neutral tool instead of exposing separate functions for every
map operation:

```ts
import {
  ORIHON_AI_SYSTEM_PROMPT,
  createAISession,
  createAITool
} from "orihon/ai";

const tool = createAITool(createAISession(map));

// Give these to the model SDK used by the host application.
const systemPrompt = ORIHON_AI_SYSTEM_PROMPT;
const { name, description, inputSchema } = tool.definition;

// Route parsed tool arguments back to the map.
const result = tool.execute(argumentsFromModel);
```

The complete command schema is exported as `orihon/schema/command-v1.json`. See
[`AI_SYSTEM_PROMPT.md`](./AI_SYSTEM_PROMPT.md) for the canonical instruction and integration loop.

## Server command engine and live objects

For a shared or remotely controlled map, keep the canonical JSON state on the server. The library
provides a headless engine; the application chooses where and how it is hosted:

```ts
import {
  createAICommandEngine,
  createAIEngineTool,
  createAIHTTPHandler
} from "orihon/ai";

const engine = createAICommandEngine();
const tool = createAIEngineTool(engine);       // compact model-facing result by default
const handleRequest = createAIHTTPHandler(engine); // mount in a Fetch-compatible server
```

HTTP and SSE keep full revisioned events. The model-facing bridge returns only
`{ok:true,value:{op,revision}}` for mutations, so accepted commands are not echoed into the next
model context. Use `{resultMode:"full"}` only when an integration needs the event payload; `query`
keeps its snapshot in compact mode.

Choose a self-contained schema profile when an agent needs only one command family:

```ts
const pointsTool = createAIEngineTool(engine, { profile: "points" });
model.registerTool(pointsTool.definition);
model.setSystemPrompt(pointsTool.systemPrompt);
```

Profiles are `full`, `scene`, `objects`, `points`, `routes`, and `readonly`. Their schemas are exported as
`AI_ENGINE_COMMAND_SCHEMAS` and through `getAIEngineCommandSchema(profile)`.

The built-in HTTP adapter exposes:

- `GET /api/orihon/snapshot` — complete state and current revision;
- `POST /api/orihon/commands` — `{ "command": {...}, "baseRevision": 12 }`;
- `GET /api/orihon/events` — SSE stream of accepted revisioned commands.

## Semantic agent runtime

The command bridge remains available as the low-level execution boundary. For deeper integration,
use the semantic runtime: the model states one goal, the runtime discovers native model
capabilities, builds a dependency plan, previews it on an isolated engine fork, and commits the
whole plan as one revision.

```ts
import {
  createAIAgentRuntime,
  createAICommandEngine,
  createAIIntentTool
} from "orihon/ai";

const engine = createAICommandEngine();
const runtime = createAIAgentRuntime(engine);
const tool = createAIIntentTool(runtime);

model.registerTool(tool.definition);
model.setSystemPrompt(tool.systemPrompt);
```

`orihon_plan` currently accepts `create_visit_route`. The intent carries the place collection and
semantic route constraints, not a precomputed route. The runtime compiles it into
`ObjectManager.replace_points -> RouteModel.plan`, validates both steps on a private fork, and then
publishes one atomic `transaction` event. Routes created this way are reactive by default:
updating or removing a source object makes the route model recalculate the remaining stops without
another model call.

```json
{
  "goal": "create_visit_route",
  "collection": "rome-places",
  "routeId": "rome-tour",
  "points": [
    { "id": "vatican", "position": { "lat": 41.9022, "lng": 12.4573 }, "title": "Vatican" },
    { "id": "colosseum", "position": { "lat": 41.8902, "lng": 12.4922 }, "title": "Colosseum" }
  ],
  "route": { "startId": "vatican", "endId": "colosseum", "optimize": "shortest" },
  "presentation": { "clearMap": true, "viewport": { "mode": "fit", "padding": 48 } }
}
```

Semantic HTTP endpoints are mounted beside the command API:

- `GET /api/orihon/capabilities` — discover registered model operations;
- `GET /api/orihon/context` — compact resource references and state summary;
- `POST /api/orihon/intents/preview` — validate and preview without mutation;
- `POST /api/orihon/intents` — atomically commit `{intent,baseRevision?}`.

Authentication, permissions, rate limits, persistence, audit logs and selecting the engine for a
particular tenant/map remain host-application responsibilities. `baseRevision` implements
optimistic concurrency; a stale writer receives `REVISION_CONFLICT` and should reload the snapshot.

The browser is a projection of server state:

```ts
import { createAIMapProjection } from "orihon/ai";

const projection = createAIMapProjection(map);
projection.applySnapshot(await fetch("/api/orihon/snapshot").then((r) => r.json()));

const events = new EventSource("/api/orihon/events");
events.addEventListener("command", (message) => {
  const result = projection.applyEvent(JSON.parse(message.data));
  if (!result.ok && result.error.code === "REVISION_CONFLICT") {
    // An event was missed: fetch and apply a fresh snapshot.
  }
});
```

`AIMapProjection` sends presentation commands to `AISession`. Object commands go through one
`FeatureSource` per collection; the subscribed `ObjectManager` receives incremental add/update/
remove/batch deltas and does not rebuild the whole map.

```json
{
  "op": "objects.batch",
  "collection": "vehicles",
  "changes": [
    {
      "type": "update",
      "objects": [{
        "type": "Feature",
        "id": "bus-17",
        "geometry": { "type": "Point", "coordinates": [13.3977, 52.518] },
        "properties": { "status": "moving" }
      }]
    },
    { "type": "remove", "ids": ["bus-24"] }
  ]
}
```

Object geometry follows GeoJSON (`[longitude, latitude]`) and currently supports `Point`,
`LineString` and `Polygon`, matching ObjectManager. Object operations are transactional: if any
change is invalid, neither the collection nor the revision changes. The complete server command
schema is exported as `orihon/schema/engine-command-v1.json` and as
`AI_ENGINE_COMMAND_SCHEMA`.

## Compact point collections

`points.replace` avoids repeated GeoJSON Feature and geometry keys for maps made primarily of
named points. The engine normalizes points into canonical GeoJSON objects, while the browser uses
one FeatureSource/ObjectManager collection. `popup` accepts plain text or safe declarative
text/image content. `visual` controls circular/rectangular image markers and hover-first labels.

```json
{
  "op": "points.replace",
  "collection": "places",
  "clearMap": true,
  "defaults": { "category": "alpha" },
  "viewport": { "mode": "fit", "padding": 48 },
  "points": [
    {
      "id": "kremlin",
      "position": { "lat": 55.752, "lng": 37.6175 },
      "title": "Московский Кремль",
      "visual": {
        "image": {
          "url": "https://images.example.org/kremlin.jpg",
          "alt": "Московский Кремль",
          "shape": "circle",
          "fit": "cover",
          "borderColor": "#ffffff",
          "borderWidth": 3
        },
        "label": {
          "text": "Кремль",
          "display": "hover"
        },
        "size": 56,
        "collisionMode": "auto"
      },
      "popup": "Историческая крепость и музейный ансамбль."
    }
  ]
}
```

`clearMap:true` clears only AI-owned layers and collections. It never removes ordinary layers
created by the host application. `viewport.mode:"fit"` is applied from the same SSE event, so the
model does not need a second `fit` tool call.

`visual.image` is rendered as the point itself and remains clickable; `popup.image` is shown only
after that point is opened. External images must use HTTPS, while application assets may use local
paths. AI labels default to an ObjectManager tooltip shown only on pointer hover. Set
`visual.label.display:"always"` to opt into the persistent label layer, where collision, zoom
range, halo and priority are handled by ObjectManager. Direct ObjectManager consumers can return
`image` and `label` from their `style` resolver;
`icon({iconUrl, shape:"circle", fit:"cover"})` provides the same circular image primitive for a
standalone Marker. DOM images are intended for UI-sized collections; force `clusterRenderer:"dom"`
when a collection above the automatic WebGL threshold must preserve them.

## Route planning from an object collection

`route.plan` lets the model reference points already stored in ObjectManager instead of repeating
their coordinates. The headless engine orders the selected stops with a deterministic
nearest-neighbour + 2-opt planner, annotates their canonical features with `visitOrder`, and uses
Orihon's existing `RoutingProvider`/`RouteResult` contract. The browser projection restores the
result through `RoutingLayer`, including after a snapshot resync.

```json
{
  "op": "route.plan",
  "routeId": "berlin-tour",
  "collection": "berlin-places",
  "startId": "charlottenburg-palace",
  "optimize": "shortest"
}
```

Omit `ids` to visit every point, or provide a subset. The built-in MVP provider connects the
optimized stops directly; a road-network provider can replace it without changing the AI command.
The compact tool result includes route ID, stop count, distance and estimated duration.
