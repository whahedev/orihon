# Orihon public API design rules

These rules describe the conventions used by the public Orihon API. New APIs must follow them; existing deviations should either be migrated or documented explicitly.

## Creation and ownership

- A `create...()` factory returns a new caller-owned instance unless its documentation explicitly says otherwise.
- Caller-owned resources expose an idempotent `destroy()` and must not share destructible state with library-managed components.
- Shared caches and workers are internal implementation details. Internal accessors use `getShared...()` and are not re-exported from package entrypoints.
- Short layer factories such as `marker()` and `tileLayer()` return normal reusable layers. They do not perform network or DOM work until their documented lifecycle starts.

## Lifecycle verbs

- `addTo(map)` attaches a reusable object to a map and returns that object.
- `remove()` detaches a layer or control but allows it to be added again. `Map.remove()` is the documented ecosystem-compatible terminal alias of `Map.destroy()`.
- `clear()` removes contained data without destroying the container.
- ObjectManager uses `detach()` for map disconnection and `removeObjects()` for record deletion; it has no overloaded `remove()`.
- `cancel()` stops the current operation while leaving its owner reusable.
- `destroy()` is terminal and idempotent. Methods that require a live resource fail after destruction.
- Cleanup must settle every outstanding promise. It must never turn cancellation or failure into an empty successful business result.

## Asynchronous operations and errors

- Operations involving network, Worker, filesystem-like storage or cooperative ingestion expose an asynchronous API.
- Cancellation uses an `AbortSignal` where the caller controls one operation and rejects with an error named `AbortError`.
- Resource shutdown also rejects unfinished work with `AbortError`.
- Operational failures reject with an actionable message, a stable `name`, and the original failure in `cause` when available.
- An error message identifies the failed resource or operation. It must not require parsing to distinguish success from failure.
- Sync and async variants use the same input and result vocabulary. The async variant adds only scheduling, progress and cancellation concerns.

## Values and return shapes

- Geographic and CRS positions use named `{ lat, lng }` values, never untagged numeric pairs. GeoJSON remains `[longitude, latitude]` and crosses the boundary through `fromGeoJSONPosition()` / `toGeoJSONPosition()`.

- Collection reads return an empty collection rather than `null`.
- Optional singular values use `null` when absence is an expected result and an exception when the operation itself failed.
- Mutation methods return `this` when chaining is already the local convention; computation functions return their computed value.
- Inputs accepted as multiple structural forms are normalized at the public boundary and represented by a named public type.
- Public results must not expose mutable internal buffers unless ownership transfer is explicit in the method name or options.

## Options and extensibility

- Public durations use milliseconds and an `Ms` suffix. External seconds are converted at provider boundaries; animation duration zero means an immediate move.
- Radius inputs distinguish `radiusMeters`, `radiusMapUnits` and `radiusPixels`. CRS-dependent units are explicit and incompatible combinations fail before mutation.

- Options objects are preferred once an operation has more than two independent arguments of the same primitive type.
- Defaults represent the normal happy path and are documented in the public type or API guide.
- Options that select mutually exclusive modes use a string union or discriminated union rather than several competing booleans.
- When legacy aliases and canonical options coexist, the canonical option wins and the precedence is documented and tested.
- Unsupported option combinations fail early with an actionable error instead of silently selecting an unrelated mode.
- Dependencies that perform I/O are accepted through provider interfaces so applications can supply fakes and deterministic implementations.

## Naming and discovery

- `get...` reads current state without starting I/O; `set...` replaces state; `add...` appends; `remove...` deletes or detaches.
- Public factories use lower camel case and match their class concept: `tileLayer()` / `TileLayer`.
- Low-level or optional capabilities live in explicit subpath entrypoints. Internal wiring helpers are not exported merely for implementation convenience.
- One concept has one recommended public name. Compatibility aliases are deprecated, documented with their replacement, and removed in the next major release.

## Required contract tests

Every resource-owning public API must cover:

1. normal creation and use;
2. cleanup called twice;
3. calls made after terminal cleanup;
4. cleanup while asynchronous work is pending;
5. dependency failure with the original `cause` preserved;
6. isolation between caller-owned and library-owned resources.

Every documentation change must pass `npm run docs:check`, which regenerates the Developer Guide and verifies that the committed output is current.
