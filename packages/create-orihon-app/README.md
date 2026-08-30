# create-orihon-app

Scaffold a project that already draws a map — and shows one sample of each Easy overlay.

```sh
npm create orihon-app my-map
```

Then:

```sh
cd my-map
npm install
npm run dev
```

Or in one shot:

```sh
npm create orihon-app my-map -- --yes --install
```

## Templates

| Template | What you get |
| --- | --- |
| `vanilla` | Vite + JavaScript |
| `vanilla-ts` | Vite + TypeScript |
| `react` | Vite + React 18 (same Easy API as vanilla) |
| `react-ts` | Vite + React 18 + TypeScript |
| `cdn` | One HTML file via jsDelivr, no bundler |

```sh
npm create orihon-app my-map -- --template react-ts --yes --install
npm create orihon-app my-map -- --center 55.75,37.62 --locale ru
```

| Option | What it does |
| --- | --- |
| `-t, --template <name>` | `vanilla` / `vanilla-ts` / `react` / `react-ts` / `cdn` |
| `-y, --yes` | Take the defaults, ask nothing |
| `--center <lat,lng>` | Map centre (default Berlin `52.52,13.405`) |
| `--locale <code>` | Map UI locale (default `en`) |
| `--install` | Run the package manager install after scaffolding |
| `--no-install` | Never run it |
| `-h, --help` | Show the usage text |

## What the generated project already has

- the stylesheet import — `import "orihon/orihon.css"` (or CDN link)
- a container with a real height
- an attribution for the tile provider
- one working map with **Marker, Polyline, Polygon, GeoJSON and TileLayer** samples — delete what you do not need
- `vite --open` on Vite templates so the browser opens itself

## License

Apache-2.0, same as [Orihon](https://github.com/whahedev/orihon).
