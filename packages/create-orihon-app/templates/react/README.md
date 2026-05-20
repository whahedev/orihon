# Orihon map

A Vite + React project with one Orihon map.

```sh
npm install
npm run dev
```

`src/App.jsx` holds the whole map: the basemap with its attribution and one marker. The
stylesheet import is in `src/main.jsx`, and the container height in `src/style.css` — Orihon
draws into whatever size the map element has, so without a height nothing appears.

`useMap()` gives any child component the map instance, and `useMapEvent(type, handler)`
subscribes with cleanup handled for you.

## Where to go next

- [API reference](https://github.com/whahedev/orihon/blob/master/docs/API.md) — every public command
- [Troubleshooting](https://github.com/whahedev/orihon/blob/master/docs/TROUBLESHOOTING.md)
