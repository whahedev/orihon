# Orihon map

A Vite project with one Orihon map.

```sh
npm install
npm run dev
```

`src/main.js` holds the whole map: the stylesheet import, the centre and zoom, the basemap with
its attribution, and one marker. Change the centre to your own city and the map follows.

The container height lives in `src/style.css`. Orihon draws into whatever size `#map` has, so a
container without a height renders nothing — the library warns about it in the console.

## Where to go next

- [Easy API](https://github.com/whahedev/orihon/blob/master/docs/EASY.md) — `map.addPolyline`, `addPolygon`, `addGeoJSON`
- [API reference](https://github.com/whahedev/orihon/blob/master/docs/API.md) — every public command
- [Troubleshooting](https://github.com/whahedev/orihon/blob/master/docs/TROUBLESHOOTING.md)
