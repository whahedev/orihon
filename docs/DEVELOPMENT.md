# Development, versions and benchmarks

This document defines the reproducible development environment for Orihon. Runtime use in a browser does not require Node.js; Node is required for TypeScript compilation, tests, bundling and benchmarks.

## Supported toolchain

| Component | Policy |
| --- | --- |
| Node.js | `>=22`; Node 24.20.0 LTS is pinned in `.node-version` and recommended for development/release |
| npm | Use the version bundled with the selected Node LTS release; commit `package-lock.json` changes |
| TypeScript | 5.9.x until the TypeScript 7 migration is tested as a separate compatibility change |
| React test fixture | 18.3.x intentionally tests the minimum supported React peer (`>=18`) |
| Browsers | Chromium, Firefox and WebKit through the Playwright matrix |

Do not use Node 20 for release work. It reached end-of-life on 2026-03-24 and no longer receives security fixes. CI runs the unit/type compatibility contract on Node 22 and the full release/browser matrix on Node 24.

GitHub workflows use the current Node 24-based major lines of the official checkout, setup-node and artifact actions. When updating an action, check its official release notes for runner requirements and breaking changes instead of updating only the `node-version` input.

Major dependency versions are not upgraded solely because `npm outdated` reports them. React 19, TypeScript 7 and a new jsdom major can change public types, JSX behavior or DOM emulation and therefore require their own compatibility pass. Patch/minor updates allowed by the lock file may be adopted after the full check succeeds.

## Install and verify

```sh
npm ci
npm run typecheck
npm test
npm run test:browser
npm run test:e2e
npm run test:leaks
npm run test:plugin
npm run size
```

`npm test` rebuilds `dist` before running unit tests. `npm audit --omit=optional` checks the current lock file against the npm advisory database. Run it online before a release.

## Build outputs and package entries

`npm run build` emits modular ESM, declarations, source maps and browser bundles into `dist`. Applications must import public package entries (`orihon`, `orihon/core`, `orihon/standard` and the optional entries in `package.json`). Files under `dist/services` and `dist/layers` are build artifacts, not stable package exports.

`npm run size` enforces the gzip budgets recorded in `README.md`. `npm run dist` produces the staged publish artifact and release manifest.

## ObjectManager CPU/RAM benchmark

```powershell
npm run bench:object-manager
$env:COUNT=1000000; npm run bench:object-manager
```

The command rebuilds first, imports `objectManager` from the public Advanced entry, and prints library/runtime/OS versions. It measures ingest, layout, batched position/state/property updates, search and temporal configuration. It intentionally does not claim browser FPS or GPU paint performance.

Never import `dist/services/object-scene.js` or inspect `timeIndex`, `motions` or other internal fields in a public benchmark. Internal microbenchmarks belong in focused engineering scripts and must be labelled as implementation-specific.

## Browser engine benchmark

Run `npm run demo:bench`, then open `http://localhost:4176/examples/bench-compare/`. The command rebuilds the current checkout before starting the server. On HTTP(S), the page tries local `/dist/index.js`, then `/dist/orihon.esm.js`; only a direct-file or failed-local run falls back to the pinned Orihon CDN build.

The comparison libraries are pinned in `examples/bench-compare/index.html` for reproducibility. A version update must change both CSS and JavaScript URLs, update the example README, smoke-test every scenario, and record the browser/OS in exported results.

Interpret results by scenario. Prefer median load and p95 frame time over a single average FPS value. Engines run sequentially, the prior map is destroyed, and heap figures are still browser-dependent absolute measurements rather than portable memory guarantees.
