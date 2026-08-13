# Orihon scale showcase

Full-bleed product demo: **Core → Standard → Advanced**, then stress scenarios Leaflet tends to dislike (100k vehicles, 250k IoT, live fleet, 50k clusters, aircraft, incident heat).

Loads Orihon from local `/dist` when you serve the repo; otherwise from jsDelivr `orihon@1.0.2` (GitHub Pages).

## Run locally

```bash
npm run build
npm run demo:showcase
```

Open http://127.0.0.1:4177/examples/showcase/

Live: https://whahedev.github.io/orihon/showcase/

## Hash routes

- `#core` / `#standard` / `#advanced`
- `#vehicles` `#iot` `#fleet` `#properties` `#aircraft` `#incidents`
