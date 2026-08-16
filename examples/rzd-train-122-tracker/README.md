# РЖД 121В/122В — движение по OSM route relation

Поезд идёт по геометрии OSM relation поезда 121В (не по прямым между станциями).

## GitHub Pages

Статическая демо-страница:

https://whahedev.github.io/orihon/rzd/

На Pages маршрут берётся из `rail-route-cache.json` (без Overpass API).

## Локальный запуск

```text
start.cmd
```

или:

```bash
node server.mjs
```

Открыть:

```text
http://127.0.0.1:8788
```

Локальный сервер отдаёт `/api/rail-route` (relation → кэш) и при необходимости может перестроить маршрут.

## Кэш

`rail-route-cache.json` публикуется вместе с демо для GitHub Pages.
