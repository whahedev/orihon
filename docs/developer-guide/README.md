# Local developer guide

The local guide is generated from two sources:

1. The actual function exports and TypeScript declarations in `src/index.ts`.
2. A read-only snapshot of the existing Confluence child pages in `confluence-source.json`.

Run:

```bash
npm run docs:build
npm run demo:docs
```

Open `http://127.0.0.1:4179/examples/developer-guide/`. The documentation server is a
small repository-local Node server, so it does not download or depend on a global static-server package.

The generator deletes and recreates only `examples/developer-guide/functions/`.
Every current public function gets one physical `functions/<name>/index.html` page.
Legacy Confluence functions that are no longer exported are intentionally omitted.
