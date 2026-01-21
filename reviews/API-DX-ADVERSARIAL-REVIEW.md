# Adversarial Developer Experience review: Orihon public API

Дата среза: 2026-08-26. Проверено текущее рабочее дерево, `package.json#exports`, 16 типизированных entry points, декларации `dist`, реализации `src`, README, `docs/API.md`, `docs/EASY.md`, examples и релевантные tests. Полный машинный inventory построен существующим `scripts/api-dx-inventory.mjs`: 1 080 экспортов с учётом повторных re-export, 465 уникальных экспортируемых имён. Ниже surface агрегирован по пользовательскому намерению, но анализ охватывает все package entry points.

Важно: текущий package уже имеет версию `1.0.6`, а `docs/API.md` называет surface stable 1.x. В соответствии с постановкой review рекомендации ниже всё равно оптимизированы как pre-stable breaking changes; фактический release status репозитория этому допущению противоречит.

## 1. Executive summary

Язык API выглядит цельным только внутри узкого слоя «factory → mutable layer → `addTo(map)` → chainable setters». На уровне всей библиотеки пользователю приходится держать одновременно не менее шести mental models:

1. object-centric Layer API (`marker(...).addTo(map)`);
2. container-centric API (`map.addLayer`, `map.add`, Easy `map.addX`);
3. declarative Easy API (`map.add({ type, ... })`);
4. class/constructor API (`new Marker`, `new Orihon`);
5. data-store API (`FeatureSource`, `ObjectManager`), где те же глаголы имеют другую lifecycle/error-семантику;
6. React/component API.

Canonical way для слоёв угадывается из документации: factory + `addTo`. Но public surface объявляет равноправными constructors, `map.addLayer`, `map.add`, Easy `addX`, Easy declarative `add` и React-компоненты. Сам Easy-уровень, который должен уменьшать число решений, предлагает три формы создания и две формы `addMarker`.

Самые опасные решения перед stable release:

- **Critical:** голые `[number, number]` означают `[lat, lng]` в `LatLngLike`, но `[lng, lat]` в GeoJSON/`ManagedGeometry`. Значение из внешнего стандарта компилируется и попадает в неправильное место без ошибки.
- **High:** `duration` означает секунды у camera API, миллисекунды у ObjectManager/WebGL motion и секунды у routing results; единица не видна.
- **High:** `circle(..., radiusMeters)` и поле `radiusMeters` становятся map units на `CRS.Simple`; `Circle.getRadius()` и `CircleMarker.getRadius()` возвращают разные units под одинаковым именем.
- **High:** публичные mutable `options`, `center`, `zoom`, `layers`, `panes` и underscored engine state позволяют компилирующийся mutation в обход rendering/events/validation.
- **High:** `MarkerOptions.html` не рендерит HTML — строка попадает в `textContent`; одновременно `icon`, `content`, `html` и appearance разрешены, но большая часть молча игнорируется.
- **High:** event name — любой `string`, payload не выводится из name, а данные дублируются в `event.foo` и `event.detail.foo`.
- **High:** Easy `map.add` меняет return contract по runtime shape аргумента; `ObjectManager.remove()` меняет смысл между detach и удалением данных.
- **High:** один и тот же `tileLayer(..., { renderer: "auto" })` меняет backend в зависимости от импортированного entry point и глобальной регистрации.

Итоговая predictability: **4/10**. API локально удобен, но знание 20% surface плохо переносится на оставшиеся 80% из-за tuple conventions, units, aliases, runtime dispatch и разных lifecycle-языков.

## 2. API inventory

### Entry points

| Entry point | Экспортов | Фактическая роль |
| --- | ---: | --- |
| `orihon/core` | 59 | map, camera, events, geometry, CRS, DOM tile layer |
| `orihon/standard` | 181 | Core + markers, vectors, GeoJSON, overlays, controls |
| `orihon` | 351 | Standard + GPU, ObjectManager, heat, services; регистрирует advanced backends |
| `orihon/bundle` | 351 | тот же type surface, другой browser bundle |
| `orihon/easy` | 15 | beginner adapter над Standard map |
| `orihon/source` | 11 | reactive GeoJSON store |
| `orihon/react` | 18 | declarative React bindings |
| `orihon/draw` | 18 | drawing/editing control and handler |
| `orihon/controls` | 13 | fullscreen, measure, minimap, graticule |
| `orihon/geo` | 15 | geographic helpers + `bufferPoint` |
| `orihon/popup-content` | 11 | declarative rich popup renderer/sanitizer |
| `orihon/pmtiles` | 9 | PMTiles archive/provider primitives |
| `orihon/mlt` | 6 | MLT encode/decode/provider |
| `orihon/mvt` | 6 | packed MVT decode/conversion |
| `orihon/mvt-wasm` | 8 | WASM MVT support/provider |
| `orihon/webgpu` | 8 | WebGPU registration, GPU tile/heat primitives |

### Полный surface, агрегированный по намерению

| API | Назначение | Аргументы | Return type | Side effects | Units | Mutable state | Похожие API |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `createMap`, `new Orihon`, React `<Map>` | создать карту | DOM/id + options / props | `Orihon`, `EasyMap`, React element | DOM, listeners, observers | zoom; px; seconds | много public live fields | три грамматики creation |
| `remove`, `destroy` карты | terminal cleanup | нет | `this` | удаляет DOM/layers/listeners | — | terminal `_destroyed` | два имени, одна семантика |
| `addLayer`, `add`, `layer.addTo` | attach layer | `Layer`/map | map или layer | render, lifecycle | — | `layers` Set | container/object dialects |
| `removeLayer`, `layer.remove`, group methods | detach layer | layer/нет | map/layer/group | unmount/render | — | layer.map, group set | разные субъекты |
| panes/controls/attribution | UI registry | name/control/string | `this`, DOM, arrays | DOM/events | positions, px косвенно | public registries | add/remove pairs |
| `setView`, `pan*`, `fit*`, `fly*`, zoom methods | camera mutation | coordinates/zoom/options | `this` | render/events/animation | px, zoom, seconds | public center/zoom/origin | jump/boolean/fly dialects |
| camera getters/converters/query | inspect/project/hit-test | tuple/object/class | values/arrays | mostly none | CSS px, degrees/map units | snapshots смешаны с live state | global geo helpers |
| `Evented` + React `useMapEvent` | events | arbitrary string + handler | `this`/map | subscriptions/propagation | — | hidden registries | React prop events |
| `Point`, `Bounds`, factories | screen/projected values | tuple/object/positional | value objects | mostly none; `Bounds.extend` mutates | px or abstract units | public coordinates | LatLng family |
| `LatLng`, `LatLngBounds`, factories/helpers | geography | `[lat,lng]`, object, positional | value objects/numbers | mostly none; bounds mutates | degrees/meters/map units | public coordinates/bounds | GeoJSON positions |
| raster/GPU tile layers, WMS/WMTS | network tiles | URL/template/options | layer/provider | I/O, cache, render | px, zoom, counts | mutable options/cache internals | backend chosen by entry |
| marker/icon/marker collection | point display | position/options/data | layer/icon | DOM/GPU/events | CSS px, degrees, opacity | options + DOM handles | icon/content/appearance modes |
| polyline/polygon/rectangle/circle/circleMarker | vector display | coordinates/style/radius | layer | SVG/render/events | meters/map units/px | geometry + options | radius conflict |
| GeoJSON/text/vector-tile layers | data-driven rendering | data/source/options | layer | parse, workers, render | bytes/counts/px | data/layers/options | `FeatureSource`, ObjectManager |
| popup/tooltip/media overlays | content/geographic overlays | content/bounds/options | layer | DOM, async mount, cleanup | px/opacity | content/position/options | bind/open methods on Layer |
| standard/optional controls | map UI | options/content/layer | control | DOM, document listeners, fullscreen/geolocation | px/map/meters | public UI state | class + factory |
| Easy `add`, `addX`, basemap | beginner create+attach | description/object/positional | map or created layer | creation + attach | inherited ambiguous units | monkey-patched instance | Standard factories |
| `FeatureSource` | reactive keyed GeoJSON store | feature(s)/id/patch | `this`, snapshots, unsubscribe | subscriber notifications | version/count | private store | 3 creation names |
| ObjectManager family | large object store/render | object(s)/options/runtime modes | manager subtype/`this`/Promise | indexes, worker, DOM/GPU, events | mixed px/ms/counts | public options and stores | factory runtime dispatch |
| search/suggest/routing/traffic | providers | adapters/items/options | provider/layer/Promise | cancellation, network app-defined | meters/seconds/ms | public arrays/controllers | mixed async naming |
| heat APIs | field/render/isolines | points/bounds/options | Promise result/layer | workers/WASM/WebGPU/render | px/grid/field/ms | layer/options/field | build vs layer APIs |
| geometry workers/clustering primitives | bulk processing | iterables/options/typed arrays | pool/result/Promise | worker ownership/transfers | counts/bytes/ms | pool lifecycle | three pool constructors |
| offline/export/performance | operational helpers | map/URLs/options | service/Promise/snapshot | cache, SW, window, dynamic import | bytes/counts/ms/ratio | service lifecycle | hidden I/O varies |
| PMTiles/MLT/MVT/WASM/WebGPU | low-level formats/backends | buffers/templates/options | decode/provider/classes | fetch/WASM/GPU/registration | bytes/tile coords | caches/runtime support | multiple decode tiers |
| Draw API | drawing/editing | mode/options/data | handler/control/GeoJSON | map behaviors, DOM/events | px/meters/map units | public mode/features | handler + control proxy |
| React bindings | declarative lifecycle | props/children/hooks | elements/null/map | effects create/update/remove | inherited | React-owned | Layer/Easy equivalents |
| popup-content | safe rich content | block spec/options | mountable/fragment/renderer | DOM, optional script load | — | cleanup contract | raw Node/content APIs |

## 3. API grammar

### Хорошо соблюдаемые правила

- Standard visual entities обычно создаются noun-factory: `marker`, `polyline`, `tileLayer`, `popup`, `zoomControl`.
- Factories возвращают detached object; `addTo(map)` attaches и возвращает сам object.
- Большинство runtime mutations возвращают `this`; inspections используют `get*`, `is*`, `has*`.
- Map-centric registries используют `addX/removeX/hasX/eachX`.
- Explicit async bulk alternatives часто имеют `Async` suffix: `addDataAsync`, `setDataAsync`, `preparePointBatchAsync`, `rebuildAsync`.
- Canonical path style в новых API — `stroke`, `strokeWidth`, `strokeOpacity`, `fill`, `fillOpacity`.
- Explicit unit names уже успешно применяются в `radiusMeters`, `radiusPixels`, `distanceMeters`, `bearingDegrees`, `debounceMs`, `refreshIntervalMs`, `maxBytes`.
- Getter collections обычно возвращают snapshots (`getLayers`, `getRoutes`, `getPoints`, `getFeatures`).

### Неопределённые правила

- Что canonical для создания: factory или constructor; `createX` или noun-factory.
- Кто является субъектом attach/detach: container или child.
- Должен ли `remove` означать detach, delete data или terminal cleanup.
- Когда async виден в имени, а когда только в return type.
- Являются ли `options` readonly configuration snapshot или live mutation channel.
- Должны ли tuples быть `[lat,lng]` или стандартными `[lng,lat]`.
- Измеряется ли `duration` в seconds или milliseconds.
- Должны ли renderer/backends определяться options или import-time registration.

### Нарушенные правила

- Easy object-first philosophy нарушена positional `addMarker`, positional `addPolyline`/`addPolygon` и declarative generic `add`.
- «Одинаковый verb — одинаковый contract» нарушен `add`, `remove`, `distance`, `getRadius`, `duration`.
- «Factory returns one conceptual kind» нарушен `objectManager`, `icon`, `pathBatch` — runtime shape выбирает разные classes.
- «Canonical style vocabulary» нарушен aliases `width`, `opacity`, `color`, а types разрешают alias вместе с canonical property.
- «Options configure; setters mutate» нарушен публичными writable option bags и live fields.
- «Entry point changes capability, не meaning» нарушен global registration для `tileLayer(renderer:"auto")`.

### Фактическая event grammar

Сейчас имена в основном lowercase и без namespace. Camera использует тройки `movestart/move/moveend` и `zoomstart/zoom/zoomend`; I/O использует `loading/load/error/abort`; interaction — `click`, `dblclick`, `mouseover`, `mouseout`; overlays добавляют `popupopen/popupclose`, `tooltipopen/tooltipclose`; ObjectManager использует также `objectstatechange`, `select`, `routeclick`. Единого правила для present participle/past tense нет, а payload contract не выражен типами. Рекомендуемая canonical grammar: `<domain?><action><phase?>`, где phase только `start|progress|end|error|abort`, event name является ключом EventMap, а payload плоский и readonly.

## 4. Findings

### Critical — coordinate tuples позволяют тихую перестановку latitude/longitude

**API:** `LatLngLike = [number, number]` читается как `[lat,lng]`; `GeoJSONPosition` и `ManagedGeometry.coordinates` — `[lng,lat]`.

```ts
const coordinates: [number, number] = feature.geometry.coordinates;
marker(coordinates); // TypeScript принимает
```

**Фактическая семантика:** `[37.6176, 55.7558]` (Москва в GeoJSON) становится latitude 37.6176 / longitude 55.7558.

**Почему разработчик ошибётся:** обе стороны структурно один и тот же tuple. Ошибка возникает на самой естественной границе с внешним GIS-стандартом и не даёт runtime error.

**Правило:** beginner/standard APIs принимают `{lat,lng}`; стандартные GeoJSON tuples должны иметь branded/отдельный conversion path (`fromGeoJSONPosition`, `lngLatTuple`). Naked tuple нельзя использовать одновременно для двух conventions.

**Breaking change:** да.

### High — `duration` использует несовместимые единицы

```ts
map.flyTo(center, 12, { duration: 1 });          // 1 second
manager.moveObject(id, center, { duration: 1 }); // 1 millisecond
```

Map умножает duration на 1000; ObjectManager и WebGL symbols сравнивают значение напрямую с `performance.now()`. `RouteResult.duration` создаётся как distance/speed, то есть seconds. `cameraRedrawInterval`/`cameraSettleDelay` также milliseconds, но без `Ms`.

**Правило:** все public time values имеют suffix (`durationMs` или `durationSeconds`); предпочтительно один unit library-wide.

**Breaking change:** да.

### High — radius contract зависит от runtime type и CRS

```ts
circle(center, 100).getRadius();                 // meters on EPSG:3857, map units on Simple
circleMarker(center, { radius: 100 }).getRadius(); // CSS pixels
```

У `Circle` argument и public field называются `radiusMeters`, хотя на `CRS.Simple` это map units. Одинаковые `setRadius/getRadius` у Circle и CircleMarker возвращают разные units.

**Правило:** `setRadiusMeters/getRadiusMeters`, `setRadiusPixels/getRadiusPixels`; для Simple — отдельный `circleMapUnits`/`radiusMapUnits` либо CRS-neutral branded distance.

**Breaking change:** да.

### High — public mutability обещает mutation channel, которого нет

```ts
map.center.lat = 0;
map.zoom = 99;
map.options.zoom = -10;
map.layers.clear();
marker.options.opacity = 0.1;
```

Всё компилируется. Эти writes обходят clamp, DOM updates, rendering и events. `readonly options` защищает только ссылку, не поля. Дополнительно declarations публикуют `_animationFrame`, `_destroyed`, tile queues/caches и десятки других underscored members.

**Правило:** live state private; `options` — deep-readonly snapshot; mutations только через methods; диагностические internals через явно named read-only diagnostics.

**Breaking change:** да, и исправлять нужно до stable.

### High — `html` overpromises и presentation modes конфликтуют

```ts
marker(pos, {
  icon: icon({ content: "C" }),
  content: "A",
  html: "<strong>B</strong>",
  shape: "diamond",
  color: "red"
});
```

Types разрешают всё одновременно. Runtime выбирает `icon`; остальные modes игнорируются. Без icon выбирается `content ?? html`, но строка всегда записывается через `textContent`: `html` не является HTML.

**Правило:** удалить `html` или переименовать в `text`; presentation выразить discriminated union: built-in appearance | icon | content node/text. Mutually exclusive поля должны быть `never` в других branches.

**Breaking change:** да.

### High — Event API не связывает event name с payload

`on(type: string, handler)` принимает typo (`"clik"`) и позволяет caller-controlled generic утверждать произвольный payload. Runtime кладёт detail и на top level, и в `event.detail`, создавая две модели (`event.latlng` и `event.detail.latlng`). React `useMapEvent` наследует ту же проблему.

**Правило:** generic `EventMap`; `on<K extends keyof Events>(type: K, handler: (event: Events[K]) => void)`. Payload должен быть либо flat, либо `detail`, не оба.

**Breaking change:** да.

### High — `add` и `remove` скрывают разные conceptual operations

- Easy `map.add(existingLayer)` возвращает map, `map.add(description)` возвращает созданный layer.
- `ObjectManager.remove()` detaches manager; `remove(id)` deletes stored data.
- Draw `remove({destroyFeatures:true})` может превратить detach в data destruction.

Return type Easy `add` и destructive meaning `remove` определяются argument/runtime shape. Код читается плохо через шесть месяцев.

**Правило:** `attachLayer`/`addLayerDescription` или оставить `add` только для одного contract; ObjectManager — `detach()` и `removeObjects()`; Draw — `detach()` и отдельный `destroy()`.

**Breaking change:** да.

### High — entry point меняет семантику одинакового `tileLayer`

Core/Standard `tileLayer(...,{renderer:"auto"})` использует DOM, а импорт full/WebGPU регистрирует GPU factory глобально, после чего такой же call может выбрать WebGPU/WebGL. Поведение зависит не только от args, но и от import graph/order.

**Правило:** backend selection должно быть локальным и явным: `domTileLayer`, `gpuTileLayer` или injected runtime/capabilities object; `auto` не должен меняться от несвязанного import side effect.

**Breaking change:** вероятно да.

### High — ObjectManager смешивает две coordinate models в одном valid object

`ManagedObject` разрешает одновременно legacy `coordinates: LatLngLike` (`[lat,lng]`) и GeoJSON `geometry.coordinates` (`[lng,lat]`). Runtime silently предпочитает `geometry`.

**Правило:** discriminated union `LegacyPointObject | GeometryObject` с `geometry?: never` / `coordinates?: never`; лучше удалить legacy field до stable.

**Breaking change:** да.

### Medium — unified factories используют property-presence dispatch без exclusive types

- `objectManager({loader, points})` выбирает RemoteObjectManager и игнорирует points.
- `icon({iconUrl, content})` выбирает image Icon и игнорирует content.
- `pathBatch` корректнее, потому что имеет explicit `mode`, но всё равно меняет concrete return class.

`objectManager` особенно дорог: одна функция возвращает три lifecycle/feature sets. Нужны distinct factories или строгий discriminated union.

### Medium — `clusterGridSize` означает radius, а не grid size

Документация прямо говорит, что имя оставлено для compatibility и теперь означает radius in CSS/world pixels. Это исторический artifact в новой библиотеке; `setClusterGridSize` закрепляет ложь ещё сильнее.

**Рекомендация:** `clusterRadiusPixels` (или точное имя для world-at-zoom semantics), удалить старое имя до stable.

### Medium — validation/error grammar непоследовательна

- `FeatureSource.add` отклоняет duplicate id;
- `ObjectManager.add` заменяет existing id;
- `Circle` принимает negative/NaN radius, `CircleMarker` clamps, `bufferPoint` throws;
- setters где-то clamp, где-то ignore invalid, где-то throw;
- async cancellation где-то rejects `AbortError`, routing returns `[]` on abort, RemoteObjectManager only emits `abort`.

Нужна единая политика duplicates, invalid numerics и cancellation.

### Medium — class + factory + `create*` vocabulary не имеет правила

Встречаются `marker/new Marker`, `createMap/new Orihon`, `featureSource/createFeatureSource/new FeatureSource`, `createGeometryWorkerPool/geometryWorkerPool/new GeometryWorkerPool`, noun factories (`routingLayer`) и create factories (`createSuggestProvider`, `createMVTProvider`). Разница не кодирует ownership, async или abstraction level.

### Medium — implicit mode switches через booleans

`fitBounds({animate:true})` и `panInsideBounds({animate:true})` фактически выбирают `flyTo`; `DrawHandler.remove({destroyFeatures:true})` добавляет destructive mode; `setView({settle:false})` включает follow-camera protocol; heat `worker`, GeoJSON `useWorker`, packed `adopt`, ObjectManager `sceneFeatures` меняют lifecycle/performance contracts.

Самые проблемные: `animate` → конкретный fly algorithm, `settle` как engine term, `adopt` как ownership transfer. Предпочтительны explicit unions: `animation:"none"|"fly"`, `updateMode:"continuous"|"settled"`, `ownership:"copy"|"transfer"`.

## 5. Competing API dialects

| Пользовательская операция | Равноправные формы | Canonical recommendation |
| --- | --- | --- |
| создать map | `createMap`, `new Orihon`, Easy `createMap`, React `<Map>` | imperative: `createMap`; constructor не экспортировать как primary API |
| создать layer | noun factory, `new Class`, Easy `addX`, Easy `add(description)`, React component | Layer API: noun factory; Easy: только object-first `addX(options)` |
| attach layer | `layer.addTo(map)`, `map.addLayer(layer)`, `map.add(layer)` | `layer.addTo(map)` for composition; один explicit container method для dynamic layers |
| detach/delete | `remove`, `removeLayer`, `clearLayers`, `destroy` | `detach`, `removeItem(s)`, `clear`, `destroy` с непересекающимися смыслами |
| position | `{lat,lng}`, `[lat,lng]`, `LatLng`, `latLng(lat,lng)`, `lngLat(lng,lat)`, GeoJSON tuple | object form в app-facing API; explicit boundary converters |
| style path/object | canonical stroke/fill + `color/width/opacity` aliases | только canonical stroke/fill vocabulary |
| marker presentation | built-in appearance, `icon`, `content`, `html` | discriminated `appearance` union |
| create FeatureSource | `featureSource`, `createFeatureSource`, `new FeatureSource` | `createFeatureSource` или noun factory, только один public shortcut |
| create worker pool | `createGeometryWorkerPool`, deprecated `geometryWorkerPool`, constructor | `createGeometryWorkerPool` (ownership visible) |
| event subscription | `.on`, `.once`, React `useMapEvent`, React props | один shared typed EventMap |
| bulk data change | `add`, `addMany`, `addAsync`, `setData`, `setDataAsync`, `replace`, `updateObjects` | verb кодирует append/replace/update; Async suffix только когда есть sync twin |
| animation | jump method, `{animate}`, `flyTo`, motion `{duration}` | explicit animation mode + единый duration unit |
| renderer selection | `renderer`, `backend`, entry-point registration, factory-specific class | explicit local option; imports не меняют meaning |

Easy не должен поддерживать одновременно generic declarative `add`, named `addX` и positional factory-like forms. Рекомендуемый Easy grammar: **object-first named commands** (`addMarker({position,...})`, `addPolyline({coordinates,style})`), всегда возвращающие созданную entity. Existing layer attachment оставить inherited `addLayer(layer)`, не перегружать `add`.

## 6. Contradiction matrix

| Концепция | API A | API B | Противоречие | Оправдано? | Рекомендация |
| --- | --- | --- | --- | --- | --- |
| creation | `marker()` | `new Marker()` / Easy / React | 4 grammars | уровни частично оправданы, constructor нет | factory canonical, constructors secondary |
| add | Easy `add(layer) → map` | Easy `add(description) → layer` | same name, different result | нет | разделить |
| remove | `Layer.remove()` detach | `ObjectManager.remove(id)` delete | same verb, different domain+lifecycle | нет | `detach` / `removeObjects` |
| positioning | `LatLngLike [lat,lng]` | GeoJSON `[lng,lat]` | identical tuple, inverse meaning | стандарт требует GeoJSON order, structural overlap не оправдан | object/branded forms |
| coordinates | `ManagedObject.coordinates` | `.geometry.coordinates` | обе формы в одном object, inverse order, geometry wins | legacy не стоит цены | exclusive union/remove legacy |
| style | `strokeWidth` | `width` | same concept, aliases coexist | нет до stable | удалить aliases |
| units/radius | Circle `getRadius` | CircleMarker `getRadius` | meters/map units vs pixels | domain difference есть, имя не отражает | unit suffix |
| units/distance | global/LatLng distance | `map.distance` on Simple | meters vs map units | CRS difference реальна | `distanceMeters` / `distanceInCrsUnits` |
| content | `html` | actual `textContent` | name promises markup | нет | remove/rename |
| events | `event.latlng` | `event.detail.latlng` | duplicate payload models | нет | выбрать одну |
| mutation | setter | `object.options.x =` | setter renders/validates, direct write нет | нет | deep readonly options |
| return semantics | mutations → `this` | Easy create+add → layer | локально оба разумны, `add` смешивает | нет в одном method | distinct verbs |
| async | `addDataAsync` | `route`, `search`, `exportPng` | suffix rule не выводится | иногда inherent async | задокументировать правило |
| errors | FeatureSource duplicate throws | ObjectManager duplicate replaces | same `add`, different duplicate policy | возможно разные stores, но скрыто | explicit `insert`/`upsert` |
| animation | `flyTo` | `fitBounds({animate:true})` | boolean скрывает fly algorithm | нет | `animation:"fly"` |
| lifecycle | map `remove === destroy` | layer `remove` reversible | same method terminal vs reversible | нет | map `destroy`, layer `detach` |
| renderer | Standard `tileLayer(auto)` | full `tileLayer(auto)` | import graph changes backend | нет | local explicit selection |

## 7. Valid TypeScript, wrong or ambiguous intent

Все примеры ниже собраны в `reviews/api-dx-valid-typescript-probes.ts`; файл проходит `tsc --noEmit`.

```ts
const p: [number, number] = [37.6176, 55.7558]; // GeoJSON Moscow
marker(p); // interpreted as [lat,lng]
```

```ts
map.flyTo(center, 12, { duration: 1 });           // seconds
manager.moveObject("train", center, { duration: 1 }); // milliseconds
```

```ts
map.center.lat = 0;
map.zoom = 99;
map.options.zoom = -10;
map.layers.clear(); // bypass lifecycle
```

```ts
marker.options.opacity = 0.1; // mounted DOM is not updated
```

```ts
easy.add({ type:"polyline", coordinates, style:{ width:20, strokeWidth:2 } });
// strokeWidth silently wins
```

```ts
icon({ iconUrl:"/pin.png", content:"ignored" } as IconOptions & DivIconOptions);
```

```ts
objectManager({ loader, points } as RemoteObjectManagerOptions & PointObjectManagerOptions);
// Remote mode wins, points ignored
```

```ts
manager.add({ coordinates:[55.75,37.61], geometry:{type:"Point",coordinates:[13.4,52.5]} });
// geometry silently wins; tuple conventions differ
```

```ts
map.on("clik", () => {}); // typo accepted
map.on<FabricatedEvent>("click", e => e.detail.impossible); // payload assertion accepted
```

```ts
marker(pos, { icon, content:"A", html:"<b>B</b>", shape:"diamond" });
// icon wins; others ignored; html is text even without icon
```

## 8. Hidden knowledge required

- `LatLngLike` tuple order is latitude-first; GeoJSON/ManagedGeometry is longitude-first.
- `geometry` wins over legacy `coordinates` in ManagedObject.
- map animation duration is seconds; object/symbol motion is milliseconds; route duration is seconds.
- Circle radius changes from meters to map units on Simple CRS.
- CircleMarker radius, stroke widths, hit tolerances, offsets and padding are CSS pixels.
- `clusterGridSize` is a radius, not a grid size.
- `fitBounds({animate:true})` chooses fly animation.
- `setView({settle:false})` suppresses `moveend` and starts a protocol that caller must later settle.
- canonical style fields beat aliases when both exist.
- marker precedence: icon > content > html > built-in appearance.
- heat `levels` beats `step`; contour-only options do nothing in `mode:"heatmap"`.
- `objectManager` subtype is selected by existence of `loader` then `points`.
- `icon` subtype is selected by existence of `iconUrl`.
- `map.add` return value depends on argument shape.
- ObjectManager `remove()` detaches, `remove(id)` deletes data.
- direct options/live-state mutation is not equivalent to setters.
- event data exists twice; handler payload is not inferred from event name.
- `tileLayer(auto)` depends on imported registration side effects.
- some cancellation rejects, some returns empty result, some only emits an event.
- `renderer:"auto"`, `layoutWorker:"auto"`, heat backend auto and visualization auto each use unrelated thresholds/policies.

## 9. Vocabulary budget

### Vocabulary inflation

| Концепция | Используемые названия | Нужны ли все | Canonical |
| --- | --- | --- | --- |
| create | noun factory, constructor, `createX` | нет | noun factory for layers; `createX` for owned services |
| attach | `addTo`, `addLayer`, `add` | максимум 2 уровня | `addTo`; `addLayer` |
| detach | `remove`, `removeLayer`, `close`, `destroy` | meanings надо разделить | `detach`, `close`, `destroy` |
| delete records | `remove`, `removeObjects`, `clear`, `clearLayers` | plural distinction полезен | `removeX`, `clear` |
| point color | `fill`, `color` | нет | `fill` |
| line color | `stroke`, `color` | нет | `stroke` |
| line width | `strokeWidth`, `width` | нет | `strokeWidth` |
| opacity | `fillOpacity`, `strokeOpacity`, `opacity` | generic только для whole-layer | semantic-specific names |
| position | `position`, `center`, `latlng`, `coordinates` | domain roles частично нужны | `position` for entities; `coordinates` only standards |
| create source | `featureSource`, `createFeatureSource`, constructor | нет | `createFeatureSource` |
| worker pool | `createGeometryWorkerPool`, `geometryWorkerPool`, constructor | нет | `createGeometryWorkerPool` |
| update | `setData`, `replace`, `update`, `rebuild`, `redraw` | разные effects, но правило не видно | formalize replace/patch/recompute/repaint |
| async | suffix `Async` или только Promise | оба нужны, но правило | suffix only when sync twin exists |

## 10. Overload audit

| API | Только форма input? | Семантика/return различается? | Predictable? | Решение |
| --- | --- | --- | --- | --- |
| `point(value)` / `(x,y)` | да | нет | да, но swapped numeric risk | оставить; object form preferred |
| `latLng(value)` / `(lat,lng)` | да | нет | частично | positional удалить из beginner docs |
| `icon(IconOptions/DivIconOptions)` | нет | concrete type/mode | только по hidden discriminator presence | split `imageIcon`/`divIcon` |
| `objectManager(remote/points/objects)` | нет | три classes/lifecycles | нет при combined shapes | split factories/discriminated `kind` |
| `pathBatch(uniform/feature)` | нет | две classes | да благодаря `mode` | допустимо, лучше union return docs |
| `searchProvider(array/adapter)` | input source only | return same | да | оставить |
| Easy `add(layer/descriptions)` | нет | attach vs create; map vs layer | нет | разделить |
| Easy `addMarker(options/position,options)` | форма input | semantics same | да, но лишний dialect | object form only |
| `FeatureSource.update(feature/id,patch)` | форма patch | same merge intent | да | оставить |
| `ObjectManager.remove()` / `(ids)` | нет | detach vs delete | нет | split |
| `RemoteObjectManager.remove()` / `(ids)` | нет | cancel+detach vs delete | нет | split |

Отдельно: многие constructors используют большие union parameters вместо overloads (`Bounds`, `LatLngBounds`). Они сохраняют один return contract, но runtime-shape branching всё равно затрудняет autocomplete и validation.

## 11. Units audit

Таблица агрегирует все публичные numeric domain values; counters/indices одной семантики сведены в группы.

| Property/method | Unit | Видна из имени? | Может быть перепутана? |
| --- | --- | --- | --- |
| lat/lng/bearings/rotation | degrees | иногда (`bearingDegrees`), чаще нет | да |
| `LatLngLike` tuple | degrees, ordered lat/lng | нет | Critical |
| GeoJSON/geometry tuple | degrees, ordered lng/lat | только из domain type | Critical |
| global `distance`, `LatLng.distanceTo` | meters | нет | да |
| `map.distance` | meters or CRS map units | нет | да |
| Circle radius | meters or Simple map units | argument claims meters | да |
| CircleMarker radius | CSS px | нет (`radius`) | да |
| heat `radius` | CSS px at `scaleZoom` | нет | да |
| cluster `gridSize`/radius | CSS/world px at clustered zoom | нет/misleading | да |
| marker/icon/point/font/halo/style sizes | CSS px | обычно нет | средне |
| stroke widths, hit tolerance, offsets, padding | CSS px | обычно нет | средне |
| tileSize, buffer | CSS/tile pixels and tile counts | нет | средне |
| map `panBy`, keyboard delta, query tolerance | CSS px | нет | средне |
| map `duration`, `zoomAnimationDuration` | seconds | нет | High |
| object/symbol motion `duration` | milliseconds | нет | High |
| routing duration | seconds | нет | High |
| `debounceMs`, `refreshIntervalMs` | milliseconds | да | нет |
| camera redraw/settle delay | milliseconds | нет | да |
| trail `maxAge` | milliseconds | нет | да |
| performance/profile `*Ms` | milliseconds | да | нет |
| `RouteResult.distance` | meters | нет | да |
| `maxBytes`, `gpuBytesApprox`, buffer bytes | bytes | да | нет |
| opacity/viscosity/ratios/weights | normalized ratio or coefficient | контекстно | иногда |
| counts, limits, thresholds, indices | count/index | обычно контекстно | низко |
| zoom/minZoom/maxZoom | zoom level | да | низко |
| grid length/area | grid cells / cells² | docs/type comments | да для low-level callers |
| mercator width/kernel | normalized Mercator | suffix `Merc` | низко |
| timestamp/startTime | Unix/performance milliseconds depending API | нет | да |

## 12. Option conflict audit

| Option A | Option B | Можно вместе? | Что победит? | Выражено типами? |
| --- | --- | ---: | --- | ---: |
| marker `icon` | `content`/`html`/appearance | да | icon | нет |
| marker `content` | `html` | да | non-null content | нет |
| Easy `width` | `strokeWidth` | да | strokeWidth | нет |
| Easy `opacity` | `strokeOpacity` | да | strokeOpacity | нет |
| ObjectStyle `color` | `fill`/`stroke` | да | canonical field | нет |
| ObjectStyle `width` | `strokeWidth` | да | strokeWidth | нет |
| MarkerCollection `color` | `fill` | да | fill | нет |
| ManagedObject `coordinates` | `geometry` | да | geometry | нет |
| objectManager `loader` | `points` | через intersection/variable | loader mode | нет |
| icon `iconUrl` | `content` | через intersection/variable | image mode | нет |
| heat `levels` | `step` | да | levels | нет |
| heat `mode:"heatmap"` | contour labels/bands/step | да | contour options ignored | нет |
| `renderer:"auto"` | imported GPU registration | да | global runtime decides | нет |
| Draw `remove` | `destroyFeatures:true` | да | detach + destructive clear | boolean only |

## 13. Names that overpromise or mislead

- `MarkerOptions.html`: plain text, not HTML.
- `clusterGridSize`: radius, not grid size.
- `Circle.radiusMeters`: map units on Simple CRS.
- `remove`: reversible detach on Layer, terminal destruction on map, record deletion on ObjectManager overload.
- `options`: looks like live mutable configuration, but direct changes are not a supported equivalent of setters.
- `settle`: engine implementation language; does not reveal suppressed `moveend` and caller obligation.
- `adopt`: understates ownership transfer and caller prohibition on later mutation.
- `auto`: several unrelated, environment/data/import-dependent algorithms hidden behind one word.

## 14. Entry-point consistency

| Entry | Design philosophy | Canonical usage | Нарушения |
| --- | --- | --- | --- |
| Core | minimal imperative foundation | `createMap`, `tileLayer().addTo` | constructors/internal fields public; string events |
| Standard | composable factory-based Layer API | noun factory + `addTo` | class dialect equally public; aliases/content conflicts |
| Advanced `orihon` | Standard + explicit high-scale tools | Standard grammar + explicit service factories | unified runtime-dispatch factories; import side effects alter auto renderer |
| Easy | self-documenting object-first common tasks | должно быть `addMarker({…})` | generic declarative add + positional overloads + inherited Standard methods |
| Source | small reactive keyed store | one factory + subscribe | 3 creation names; duplicate policy differs from ObjectManager |
| React | declarative ownership via props/effects | components + typed hooks | event typing remains stringly; separate creation dialect unavoidable but should map 1:1 |
| Draw | stateful handler/control | `drawControl().addTo` | proxy class+handler, overloaded destructive remove, public mutable mode/state |
| Controls | optional UI factories | noun control factory | measure units contextual; class state public |
| Geo | explicit standard-boundary helpers | `{lat,lng}` + named unit helpers | naked tuple collision remains |
| Popup content | explicit safe rich-content mode | `popupContent(spec)` | `type` includes arbitrary string, weakening discrimination |
| PMTiles/MLT/MVT/WASM | expert low-level codecs/providers | `create*Provider`, explicit decode | naming mostly coherent within entry; several decode tiers need capability guide |
| WebGPU | explicit optional backend | advanced low-level import | registration side effect changes existing `tileLayer(auto)` semantics |

## 15. Autocomplete and code-review tests

- После ввода `map.add…` видны `add`, `addLayer`, `addControl`, Easy `addMarker/addPolyline/...`; canonical choice не очевиден.
- После ввода `marker.` одновременно видны setter methods и mutable `options`, DOM handles и underscored arrays.
- `setRadius(100)` и `getRadius()` не показывают unit.
- `duration: 250` невозможно проверить без declaration/implementation; даже declaration не раскрывает unit.
- `on("click", ...)` не даёт event-specific payload.
- `objectManager(...)` autocomplete не объясняет, что property presence меняет returned class.
- `remove()` в review требует знать receiver type и иногда argument absence.
- `html` читается как markup через шесть месяцев, хотя contract text-only.
- `map.options.x =` выглядит sanctioned из-за public property, хотя effect отличается от setter.
- `renderer:"auto"` невозможно review-нуть без знания entry imports.

## 16. Historical compatibility artifacts

- `eachLayer(callback, context?)` — manual `thisArg`.
- `Evented.on(string)` + manual generic — pre-typed-event emitter style.
- mutable options bags и public underscored state.
- chainable `this` повсеместно, включая operations, где result/changed status мог бы быть полезнее.
- aliases `color/opacity/width`, `createFeatureSource`, `geometryWorkerPool`.
- `clusterGridSize` сохранён после изменения meaning.
- legacy `ManagedObject.coordinates` использует противоположный GeoJSON order.

Если библиотека действительно новая, ни один из этих artifacts не оправдан backward compatibility до первого stable release.

## 17. Smell catalogue verification

| Smell | Проверено | Результат |
| --- | ---: | --- |
| same method name, different return semantics | да | Easy `add` |
| same method name, different units | да | radius/distance/duration families |
| same property name, different meaning | да | duration, radius, coordinates, opacity |
| same operation, different verbs | да | detach/remove/close/destroy; replace/setData |
| same operation, competing call forms | да | creation/add/event/position |
| hidden side effects / I/O | да | imports register backend; tile/provider/cache/export operations |
| hidden animation choice | да | `animate:true` → fly |
| hidden mutation | да | public state/options; `adopt` ownership |
| behavior determined by runtime type | да | Easy add, icon, objectManager, union constructors |
| contradictory valid TypeScript | да | aliases/modes/coordinates/options |
| stringly typed concepts | да | events; popup block type allows arbitrary string |
| primitive obsession | да | ids, coordinates, units, duration |
| tuples with interchangeable primitives | да | coordinate pairs, anchors/offsets |
| booleans encoding modes | да | animate, settle, destroyFeatures, adopt, worker |
| overloads with materially different semantics | да | Easy add, ObjectManager remove, objectManager/icon factories |
| public states needing unions | да | marker presentation, manager input/mode |
| event names disconnected from payload | да | base and React |
| name overpromises | да | html, radiusMeters on Simple |
| implementation terminology public | да | settle, adopt, camera settle tuning |
| ambiguous units | да | несколько High findings |
| aliases/inconsistent abbreviations | да | style aliases, factory aliases, latlng spelling variants |
| getter/setter semantics differ across types | да | getRadius; direct state vs getters |
| multiple configuration paths | да | constructor/options/setters/public properties |
| undocumented/weakly documented precedence | да | marker modes, manager modes, heat levels/step |
| ignored options | да | marker conflicts, heatmap contour options |
| sibling-dependent options | да | heat options/mode, marker appearance/icon |
| mutable config not updating runtime | да | options bags |
| object/container syntax mixed | да | layers and Easy |
| factory/declarative both canonical | да | Easy/docs |
| Easy multiple conventions | да | explicit |
| same names across entry points, different contracts | да | tile auto via registration; createMap returns EasyMap vs Orihon |
| docs teach equivalent styles without one canonical | да | Easy explicitly promotes both |
| multiple coordinate conventions | да | Critical |
| multiple units | да | High |
| external standard interpreted differently | да | Critical |
| invariants only in docs | да | CRS/units/precedence/ownership |

## 18. Top 10 changes до stable release

1. Удалить naked geographic tuple из beginner/Standard boundaries или brand-разделить `[lat,lng]` и GeoJSON `[lng,lat]`; добавить explicit converters.
2. Сделать все duration units явными и едиными (`durationMs` рекомендован для browser API); мигрировать camera, routing и motion contracts.
3. Закрыть public mutable/internal state: private/protected internals, deep-readonly option snapshots, setter-only mutation.
4. Ввести typed EventMap per emitter; убрать дублирование flat/detail payload.
5. Упростить Easy до одной object-first grammar; убрать return-changing `add` overload и positional `addMarker`.
6. Разделить `detach`, record removal, clear и destroy; убрать `ObjectManager.remove` overload и map `remove` alias.
7. Заменить marker option bag discriminated union; удалить/переименовать ложный `html`.
8. Удалить pre-stable aliases (`width/color/opacity`, `createFeatureSource` duplicate, `geometryWorkerPool`) и переименовать `clusterGridSize`.
9. Разделить `objectManager` modes на named factories либо обязательный discriminant; сделать data representations mutually exclusive.
10. Убрать import-time изменение `tileLayer(auto)`; backend resolution сделать локальным/явным.

## 19. Quick wins

- Переименовать `html` в `text` или удалить alias.
- Добавить unit suffix к camera settle/redraw, trail age и all duration fields.
- Пометить public `options` как deep readonly и убрать underscored members из declarations.
- Удалить Easy `width/opacity` aliases: canonical properties уже документированы.
- Удалить `createFeatureSource` и deprecated `geometryWorkerPool` до stable.
- Переименовать `clusterGridSize` сейчас.
- Заменить `PopupContentBlockType = known | string` на registry-aware generic или known union.
- Добавить lint/type tests с `@ts-expect-error` для conflicting options и reversed coordinate boundaries.
- Документировать единое duplicate-id и cancellation правило, затем закрепить tests.
- Сделать `MapOptions`, `MarkerOptions`, heat modes и manager modes exact/exclusive unions там, где options конфликтуют.

## 20. API debt that will compound

- Каждый новый Easy description умножит generic `add` overloads и return union.
- Каждый новый renderer/backend усилит глобальную `auto`-семантику и import-order coupling.
- Каждый style-bearing subsystem размножает canonical fields + aliases + precedence tests.
- Каждый новый event без EventMap увеличивает string vocabulary и ручные casts.
- Unified `objectManager` будет получать новые property-presence branches и конфликтующие combinations.
- Public internals становятся de facto compatibility surface сразу после использования потребителями.
- Legacy coordinate field закрепляет две conventions внутри каждой будущей geometry feature.
- Mixed time units будут распространяться в animation, telemetry, routing и providers.
- Constructor + factory + Easy + React требуют четыре документации и четыре parity matrices на каждую capability.
- Boolean modes превращаются в невозможные комбинации по мере появления третьего algorithm/state.

## 21. Итоговый predictability test

Предполагается, что разработчик изучил базовые `createMap`, `marker`, `addTo`, `setView` и `.on`.

| Новая операция | Предсказанное имя/shape/return/unit/error/mutation | Результат |
| --- | --- | --- |
| круг фиксированного screen size | ожидание `circle(...,{radius})` | **surprising**: отдельный CircleMarker, тот же getRadius с px |
| анимированный fit | ожидание explicit animation mode | **partially predictable**: boolean выбирает fly, seconds hidden |
| удалить object из ObjectManager | ожидание `removeObject` | **surprising**: `remove(id)`, но `remove()` detach |
| использовать GeoJSON point как marker position | ожидание прямой совместимости | **surprising/Critical**: tuple переставлен |
| изменить opacity | ожидание единообразного `setOpacity` | **partially predictable**: некоторые setters, setStyle, aliases и mutable options |
| подписаться на tileerror | ожидание typed payload from name | **surprising**: arbitrary string/unknown payload |
| создать reactive source | ожидание одного factory | **partially predictable**: 3 creation names в отдельном entry |
| выбрать GPU tiles | ожидание renderer option полностью определяет behavior | **surprising**: entry import registration matters |
| bulk replace features | ожидание `setData` | **partially predictable**: replace/setData/addData/updateObjects различаются по type |
| cleanup drawing | ожидание `remove` detach, `destroy` terminal | **surprising**: boolean `destroyFeatures` внутри remove |

**Оценка: 4/10.** Изучив 20% API, разработчик сможет предсказать factory naming и chainable setters, но не coordinate order, units, precedence, concrete return types, cancellation/error model или lifecycle semantics значительной части остальных API.

## Verification

- Type-level probes: `tsc --noEmit ... reviews/api-dx-valid-typescript-probes.ts` — pass.
- Runtime regression sample: `easy`, `events`, `geo`, `object-manager-style`, `public-api` — 45/45 tests pass.
- Выводы основаны на совпадении public name → declaration → runtime implementation → docs/tests; pass существующих tests подтверждает текущие contracts, но не устраняет DX contradictions.
