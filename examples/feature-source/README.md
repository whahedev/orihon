# FeatureSource: live fleet example

This example uses one mutable `FeatureSource` as input for three consumers:

- `geoJSON(source)` renders status halos;
- `textLayer(source)` renders courier names;
- `objectManager({ source })` renders and selects managed points.

Run from the repository root:

```sh
npm run build
npm run test:server
```

Then open <http://127.0.0.1:4389/examples/feature-source/>.

What to verify:

1. **One step** updates every courier in `source.batch(...)`; the event log receives one `reset`.
2. **New courier** and **Remove selected** exercise incremental `add` and `remove` changes.
3. **Full sync** calls `source.replace(...)`; ObjectManager keeps selection for a retained id.
4. Every operation updates geometry, labels, and managed objects without manual `setData(...)` calls.
