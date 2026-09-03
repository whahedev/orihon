# Orihon agent instruction

Use this instruction when a model controls a live map through the provider-neutral tool returned
by `createAITool(session)`. The same text is exported as `ORIHON_AI_SYSTEM_PROMPT`.

```text
You control an Orihon map through the orihon_execute tool.

Rules:
- Send exactly one valid Orihon AI command per tool call.
- Ordinary coordinates must be objects: {"lat": number, "lng": number}.
- Never use coordinate arrays outside GeoJSON.
- GeoJSON coordinates remain [longitude, latitude].
- Every added layer must have a stable, descriptive, unique ID.
- Reuse the same ID for update, remove and fit operations.
- Never send functions, JavaScript, HTML, DOM values or undefined.
- Popup and tooltip content must use {"text": "..."}.
- Use query before updating or removing an object whose ID is unknown.
- After adding several related objects, use fit with their IDs.
- Do not remove layers that were not created by the AI session.
- If a command returns ok:false, inspect error.code and error.path, correct only the invalid field, and retry once.
- Prefer apply_scene when creating or replacing a complete map.
- Prefer add, update and remove for incremental changes.
```

## Tool registration

The bridge deliberately does not depend on a model SDK:

```ts
import {
  ORIHON_AI_SYSTEM_PROMPT,
  createAISession,
  createAITool
} from "orihon/ai";

const session = createAISession(map);
const tool = createAITool(session);

// Register these values with the model SDK used by the application.
const systemPrompt = ORIHON_AI_SYSTEM_PROMPT;
const definition = tool.definition;

// When the model calls definition.name with parsed JSON arguments:
const result = tool.execute(argumentsFromModel);
```

`definition` has three provider-neutral fields:

```json
{
  "name": "orihon_execute",
  "description": "Apply one validated command to the current Orihon map...",
  "inputSchema": { "oneOf": [] }
}
```

Map the fields onto the equivalent function/tool shape of the selected SDK. Return the bridge
`result` object to the model. In particular, do not turn an `ok:false` result into a thrown tool
error: `error.code` and `error.path` are the feedback the model uses to repair its command.

## Recommended agent loop

1. Give the model the system prompt and the single tool definition.
2. Parse the tool arguments as JSON and pass them unchanged to `tool.execute()`.
3. Return the structured result unchanged.
4. Let the model retry a validation error once.
5. Stop automatic retries after an `EXECUTION_ERROR` or a repeated identical error.

The standalone command schema is published as `orihon/schema/command-v1.json`; the scene schema is
`orihon/schema/scene-v1.json`.

## Server engine variant

For `createAIEngineTool(engine)`, prefer `tool.systemPrompt`; it automatically matches the selected
`full`, `scene`, `objects`, `points`, `routes`, or `readonly` schema profile. The default mutation result is
compact (`op` and `revision`) while HTTP/SSE events remain complete. Pass `{resultMode:"full"}` only
for integrations that require the echoed event.

The full profile uses `ORIHON_AI_ENGINE_SYSTEM_PROMPT` and adds these rules:

```text
- Prefer points.replace for compact point maps with safe declarative popups and automatic viewport fit.
- Use visual.image for photos and visual.label for short hover text. Labels default to display:"hover"; use display:"always" only on an explicit request. Popup content is click-only.
- Use objects.add/update/remove/batch for live or large object collections rendered by ObjectManager.
- Object geometries are GeoJSON and therefore use [longitude, latitude].
- Every object must have a stable string or numeric feature.id.
- Group related changes in one objects.batch command so clients render one coherent update.
- Use route.plan for an existing point collection; do not resend coordinates already stored by the engine.
- Use layer commands for presentation layers; use object commands for domain entities that change over time.
```

The model never receives the API key of Orihon: it receives the tool schema. The host backend keeps
the model-provider key in a server environment variable, sends tool arguments to `engine.execute()`,
and returns the structured result to the model. The same engine can also accept trusted application
commands over the HTTP adapter.
