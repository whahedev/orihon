# create-orihon-app

Scaffold a project that already draws a map.

```sh
npm create orihon-app my-map
```

Then:

```sh
cd my-map
npm install
npm run dev
```

## Templates

| Template | What you get |
| --- | --- |
| `vanilla` | Vite + JavaScript |
| `react` | Vite + React 18 with `orihon/react` |

Pick one without the prompt:

```sh
npm create orihon-app my-map -- --template react --yes
```

| Option | What it does |
| --- | --- |
| `-t, --template <name>` | `vanilla` or `react` |
| `-y, --yes` | Take the defaults, ask nothing |
| `-h, --help` | Show the usage text |

## What the generated project already has

The four things a first map is usually missing:

- the stylesheet import — `import "orihon/orihon.css"`
- a container with a real height, so the map has somewhere to draw
- an attribution for the tile provider
- one working map with a marker and a popup

That makes the starter the shortest path to a running map, and it is also what the repository
runs as an integration test: `test/create-orihon-app.test.js` scaffolds every template and
asserts those four properties in the generated files.

## License

Apache-2.0, same as [Orihon](https://github.com/whahedev/orihon).
