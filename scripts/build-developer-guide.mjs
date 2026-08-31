import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const sourceEntry = join(root, "src", "index.ts");
/**
 * Optional entries are part of the published surface, so the catalogue covers them too. Each
 * one is listed with the specifier a reader actually imports; low-level helpers that exist to
 * build those entries are excluded below rather than documented as if they were product API.
 */
const optionalEntries = [
  ["orihon/object-manager", join(root, "src", "object-manager-entry.ts")],
  ["orihon/source", join(root, "src", "feature-source.ts")],
  ["orihon/draw", join(root, "src", "draw", "index.ts")],
  ["orihon/controls", join(root, "src", "controls.ts")],
  ["orihon/geo", join(root, "src", "geo-entry.ts")],
  ["orihon/popup-content", join(root, "src", "popup-content.ts")],
  ["orihon/pmtiles", join(root, "src", "layers", "pmtiles.ts")],
  ["orihon/mlt", join(root, "src", "layers", "mlt.ts")]
];
const guideRoot = join(root, "examples", "developer-guide");
const functionsRoot = join(guideRoot, "functions");
const confluenceFile = join(root, "docs", "developer-guide", "confluence-source.json");
const playgroundFile = join(root, "docs", "developer-guide", "playground-examples.json");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const confluence = JSON.parse(await readFile(confluenceFile, "utf8"));
const playgroundExamples = JSON.parse(await readFile(playgroundFile, "utf8"));
const configFile = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const program = ts.createProgram({ rootNames: parsedConfig.fileNames, options: parsedConfig.options });
const checker = program.getTypeChecker();

const groupOrder = [
  "Карта и камера",
  "Вычисления без отрисовки",
  "Растровые тайлы",
  "Векторные данные",
  "Маркеры и оверлеи",
  "Элементы управления",
  "ObjectManager и поиск",
  "WebGL",
  "Тепловые карты и изолинии",
  "Производительность и инфраструктура",
  "Локализация"
];

const groupDescriptions = {
  "Карта и камера": "Создание карты, управление камерой и группировка слоёв.",
  "Вычисления без отрисовки": "Чистые вычисления и преобразования данных: геодезия, проекции, bounds, декодирование, heat field и packed-геометрия. Эти функции сами ничего не добавляют на карту.",
  "Растровые тайлы": "DOM, WebGL, WMS и WMTS-источники подложки.",
  "Векторные данные": "GeoJSON, MVT, линии, полигоны и текстовые слои.",
  "Маркеры и оверлеи": "DOM-маркеры, popup, tooltip, изображения, видео и SVG.",
  "Элементы управления": "Стандартные и пользовательские контролы карты.",
  "ObjectManager и поиск": "Большие коллекции объектов, кластеризация, маршруты и providers.",
  "WebGL": "GPU-слои для точек, символов, линий и полигонов.",
  "Тепловые карты и изолинии": "Общее scalar field, WASM/WebGPU backend и интерактивные изолинии.",
  "Производительность и инфраструктура": "Workers, offline-кэш, адаптеры, инспекция и служебные структуры.",
  "Локализация": "Загрузка, регистрация и разрешение языковых пакетов."
};

// Short, user-facing answers to “why would I call this?”. Source JSDoc remains
// the type-level authority, but it is often too terse or implementation-oriented
// for a guide page.
const clearSummaries = {
  latLngs: "Преобразует список координат «широта, долгота» в именованные координаты Orihon: одно слово на массив вместо `lat` и `lng` у каждой точки.",
  lngLats: "То же для порядка «долгота, широта» — так координаты отдают MapLibre и большинство серверных API.",
  fromGeoJSONPositions: "Преобразует массив `coordinates` из GeoJSON в список именованных координат, игнорируя необязательную высоту.",
  featureSource: "Создаёт реактивное хранилище GeoJSON-объектов, которое одновременно питает geoJSON, textLayer и ObjectManager.",
  drawControl: "Добавляет на карту панель рисования точек, линий и полигонов с редактированием, undo/redo и снапом.",
  drawHandle: "Описывает одну точку редактирования геометрии: её координату, роль и место в кольце.",
  snapLatLng: "Притягивает координату к ближайшей вершине или ребру указанных слоёв в пределах заданного радиуса.",
  resolveDrawLocale: "Возвращает набор подписей Draw для языка или сливает пользовательские строки с базовым набором.",
  fullscreenControl: "Добавляет кнопку перехода карты в полноэкранный режим и обратно.",
  measureControl: "Добавляет инструмент измерения расстояний и площадей прямо на карте.",
  miniMap: "Добавляет обзорную мини-карту с собственной подложкой и рамкой текущего вида.",
  popupConditionMatches: "Проверяет условие описания попапа против данных объекта, не собирая сам попап.",
  createEChartsPopupRenderer: "Создаёт renderer графиков ECharts для блоков popupContent с типом chart.",
  createPMTilesProvider: "Создаёт провайдер векторных тайлов, читающий один PMTiles-архив по HTTP Range-запросам.",
  createPMTilesRasterSource: "Открывает PMTiles-архив как источник растровых тайлов для собственного конвейера отрисовки.",
  deserializePMTilesDirectory: "Разбирает каталог PMTiles из varint-потока в список записей о тайлах.",
  findPMTilesEntry: "Находит в каталоге PMTiles запись, покрывающую указанный tileId, с учётом run-length.",
  zxyToTileId: "Переводит координаты тайла z/x/y в идентификатор кривой Гильберта, которым PMTiles адресует данные.",
  createMLTProvider: "Создаёт провайдер векторных тайлов формата MLT с тем же контрактом, что и createMVTProvider.",
  decodeMLT: "Декодирует MLT-тайл в массив GeoJSON-объектов.",
  decodePackedMLT: "Декодирует MLT-тайл в упакованные типизированные массивы без промежуточных объектов.",
  encodePackedMLT: "Кодирует упакованный тайл в бинарный формат MLT.",
  looksLikeMLT: "Быстро определяет по сигнатуре, является ли буфер тайлом MLT.",
  popupContent: "Собирает содержимое попапа из декларативного описания вместо ручной сборки HTML.",
  sanitizePopupHtml: "Очищает произвольный HTML до безопасного фрагмента, пригодного для вставки в попап.",
  bufferPoint: "Строит геодезический круг заданного радиуса вокруг координаты как GeoJSON-полигон.",
  attributionControl: "Показывает на карте авторство и лицензии активных источников данных.",
  bounds: "Создаёт расширяемую географическую область по двум углам, массиву координат или существующему объекту границ.",
  buildHeat: "Вычисляет поле значений и изолинии без создания слоя карты — для предварительной обработки, анализа или собственного renderer.",
  circle: "Рисует круг с явным радиусом: radiusMeters для EPSG:3857 или radiusMapUnits для CRS.Simple; экранный размер меняется с масштабом карты.",
  circleMarker: "Рисует точечный круг фиксированного размера в пикселях — удобно для станций, событий и небольших выборок.",
  clampLat: "Ограничивает широту диапазоном, который корректно отображается проекцией Web Mercator.",
  createMap: "Создаёт карту Orihon внутри указанного HTML-контейнера и настраивает начальный центр, масштаб и элементы управления.",
  createMapAdapter: "Оборачивает жизненный цикл карты в небольшой adapter для интеграции с UI-фреймворками.",
  createMVTProvider: "Создаёт загрузчик бинарных MVT-тайлов, который можно передать в vectorTileLayer.",
  searchProvider: "Создаёт единый поисковый provider из локального массива или пользовательского адаптера search/geocode/reverse.",
  createStraightLineRoutingProvider: "Создаёт демонстрационный routing provider, соединяющий путевые точки прямыми отрезками без дорожного графа.",
  createSuggestProvider: "Добавляет задержку, отмену устаревших запросов и нормализацию результатов к пользовательской функции подсказок.",
  createSuggestWidget: "Создаёт готовое поле ввода с выпадающими подсказками и обработкой выбора результата.",
  createWMTSFromCapabilities: "Извлекает из WMTS GetCapabilities шаблон URL и параметры слоя для последующего вызова wmtsTileLayer.",
  customControl: "Размещает пользовательский HTML-элемент в одной из стандартных областей управления карты.",
  decodeMVT: "Декодирует бинарный MVT-тайл в набор геометрий и свойств, доступных JavaScript-коду.",
  defineOrihonElement: "Регистрирует Web Component, позволяющий создавать карту декларативным HTML-тегом.",
  destination: "Находит координату, расположенную на заданном расстоянии и азимуте от исходной точки по поверхности Земли.",
  distance: "Вычисляет кратчайшее геодезическое расстояние между двумя координатами в метрах.",
  ensureLocalePacks: "Асинхронно загружает дополнительные встроенные переводы перед использованием языка, отличного от английского.",
  featureGroup: "Объединяет несколько интерактивных слоёв: события, добавление на карту и вычисление общей области выполняются как для одного объекта.",
  fromGeoJSONPosition: "Явно преобразует GeoJSON-пару [долгота, широта] в именованную координату Orihon.",
  toGeoJSONPosition: "Преобразует именованную координату Orihon в новую GeoJSON-пару [долгота, широта].",
  geodesicInterpolate: "Добавляет промежуточные точки вдоль дуги большого круга, чтобы длинная линия корректно следовала кривизне Земли.",
  geoJSON: "Создаёт отображаемый слой из GeoJSON Geometry, Feature или FeatureCollection.",
  geolocationControl: "Добавляет кнопку определения текущего положения пользователя и перемещения карты к найденной координате.",
  createGeometryWorkerPool: "Создаёт принадлежащий вызывающему пул Web Workers для подготовки больших массивов геометрии вне main thread.",
  heatLayer: "Показывает тепловую поверхность, изолинии или оба представления одного поля значений.",
  heatSupport: "Проверяет, доступны ли в текущем браузере ускоренные WASM- и WebGPU-backend теплового pipeline.",
  icon: "Создаёт иконку маркера из изображения либо безопасного текста/Node; задаёт размер и anchor.",
  imageOverlay: "Растягивает изображение по заданной географической области и синхронизирует его с картой.",
  latLng: "Нормализует поддерживаемый формат координаты в объект LatLng с широтой и долготой.",
  lngLat: "Создаёт LatLng из longitude-first координат MapLibre, GeoJSON и совместимых API.",
  layersControl: "Добавляет панель выбора одной базовой подложки и включения независимых overlay-слоёв.",
  marker: "Создаёт интерактивный DOM-маркер в географической точке с popup, tooltip и обработчиками событий.",
  markerCollection: "Создаёт лёгкую коллекцию однотипных точек — явная альтернатива вызову objectManager({ points }).",
  markerShapeMetrics: "Возвращает размеры и точки привязки встроенной формы маркера для собственного layout или renderer.",
  metersToPixels: "Переводит реальное расстояние в экранные пиксели для заданной широты и масштаба Web Mercator.",
  objectManager: "Хранит, индексирует, фильтрует, кластеризует и отображает большие наборы разнородных объектов карты.",
  remoteObjectManager: "Создаёт менеджер объектов, который подгружает данные через loader по текущему виду карты.",
  offlineTileCache: "Управляет предварительной загрузкой тайлов в Cache Storage для последующей работы без сети.",
  performanceInspector: "Собирает и показывает FPS, задержки кадров, количество слоёв и другие показатели работающей карты.",
  point: "Создаёт двумерную точку в экранных или мировых пиксельных координатах; это не широта и долгота.",
  pointBounds: "Создаёт прямоугольную область в пиксельной системе координат по двум точкам или набору точек.",
  polygon: "Рисует замкнутую географическую область с заливкой, обводкой и интерактивными событиями.",
  polyline: "Рисует географическую ломаную по упорядоченному массиву координат.",
  popup: "Создаёт информационное окно, которое можно открыть в координате или привязать к слою.",
  preparePointBatch: "Синхронно упаковывает точки в типизированные массивы, пригодные для массовой GPU-отрисовки.",
  preparePointBatchAsync: "Упаковывает большой поток точек порциями, не блокируя интерфейс на длительное время.",
  project: "Переводит географическую координату в мировые пиксели Web Mercator на указанном zoom.",
  rectangle: "Создаёт полигон прямоугольной формы по географическим границам.",
  registerLocalePacks: "Регистрирует встроенные или пользовательские таблицы переводов, доступные всем новым картам.",
  resolveLocale: "Преобразует имя языка или частичный словарь переводов в полный набор текстов интерфейса.",
  routingLayer: "Запрашивает маршруты у provider и отображает основной и альтернативные варианты на карте.",
  sanitizeSvgElement: "Удаляет из SVG скрипты, обработчики событий и опасные внешние URL перед вставкой в DOM.",
  scale: "Возвращает ширину мира Web Mercator в пикселях на заданном уровне масштаба.",
  scaleControl: "Показывает линейку, связывающую экранную длину с реальным расстоянием на текущей широте.",
  spatialGridIndex: "Индексирует объекты по ячейкам, чтобы быстро находить элементы в прямоугольной области.",
  svgOverlay: "Размещает безопасное SVG-изображение внутри заданных географических границ.",
  textLayer: "Размещает текстовую подпись в географической точке без создания полноценного DOM-маркера.",
  tileLayer: "Создаёт обычную растровую подложку из URL-шаблона тайлов и автоматически выбирает доступный renderer.",
  tooltip: "Создаёт компактную подсказку для наведения или постоянного отображения рядом с объектом.",
  trafficLayer: "Отображает пробки или другую дорожную обстановку из переданного тайлового источника.",
  unproject: "Преобразует мировую пиксельную точку Web Mercator обратно в широту и долготу.",
  vectorTileLayer: "Запрашивает векторные тайлы через provider и отображает их геометрию по правилам paint.",
  videoOverlay: "Размещает видео внутри географической области и синхронизирует его положение с картой.",
  pathBatch: "Создаёт единый пакетный слой линий: быстрый WebGL для общего стиля либо feature-режим для индивидуальных цветов, штрихов, gradients и picking.",
  webglPointLayer: "Рисует десятки тысяч и миллионы точек через WebGL с компактным хранением данных.",
  webglPolygonBatch: "Триангулирует и рисует множество полигонов пакетно через WebGL.",
  webglSymbolLayer: "Рисует большое число иконок из общего texture atlas с индивидуальным масштабом и поворотом.",
  wmsTileLayer: "Формирует WMS GetMap-запросы и показывает ответ сервера как растровую подложку.",
  wmtsTileLayer: "Загружает растровые тайлы WMTS с учётом TileMatrixSet и идентификаторов матриц.",
  wrapLng: "Переносит долготу в стандартный диапазон от −180° включительно до 180°.",
  wTinyLfu: "Создаёт ограниченный кэш с политикой W-TinyLFU, устойчивой к вытеснению часто используемых записей случайным потоком.",
  zoomControl: "Добавляет стандартные кнопки увеличения и уменьшения масштаба карты.",
  zoomForBounds: "Подбирает максимальный zoom, при котором заданная географическая область целиком помещается в viewport."
};

const special = {
  createMap: {
    note: "Камера движется только через методы: \`setView(center, zoom)\` завершает движение и шлёт moveend/zoomend, \`updateView(center, zoom)\` выполняет один шаг непрерывного движения (follow-cam, кадр анимации, живой поток позиций) и оставляет жест открытым. \`center\`, \`zoom\`, \`size\`, \`pixelOrigin\`, \`layers\`, \`controls\`, \`panes\` и \`options\` — только для чтения; диапазон масштаба меняется через \`setMinZoom\` / \`setMaxZoom\`, границы — через \`setMaxBounds\`, язык — через \`setLocale\`. \`fitBounds\` и \`fitWorld\` принимают \`animation: 'none' | 'fly'\` вместо булева флага. \`localeReady\` сообщает, когда запрошенная локаль реально применена (в Core паки грузятся лениво). \`destroy()\` терминален: камера после него бездействует, а \`addLayer\` / \`addControl\` / \`createPane\` бросают DestroyedError; \`isDestroyed\` позволяет это проверить."
  },
  offlineTileCache: {
    note: "\`prefetch(urls)\` возвращает счётчики queued/cached/failed, но одного числа отказов для офлайна мало: передайте \`onError(failure)\` и получайте \`{ url, stage, cause }\`, где \`stage\` различает отклонение по \`urlPrefixes\` (\`'url'\`), сетевой сбой (\`'fetch'\`) и отказ Cache Storage, например по квоте (\`'cache'\`). Бросок внутри колбэка не прерывает загрузку. \`prefetchTileLayer\` требует bounds или явные xRange/yRange и отказывается качать мир целиком."
  },
  marker: {
    note: "Выберите один режим: встроенная фигура (shape/color/size), content или icon. Смешанные режимы и устаревший html отклоняются. Пустой content остаётся пустым. setContent(), setIcon() и setAppearance() явно переключают режим; anchor для иконки задаётся через iconAnchor."
  },
  fromGeoJSONPosition: {
    example: `import { fromGeoJSONPosition, marker } from "orihon";
const position = fromGeoJSONPosition([37.618423, 55.751244]);
marker(position).addTo(map);`,
    note: "GeoJSON хранит долготу первой. Altitude игнорируется; первые два компонента должны быть конечными числами."
  },
  toGeoJSONPosition: {
    example: `import { toGeoJSONPosition } from "orihon";
const coordinates = toGeoJSONPosition({ lat: 55.751244, lng: 37.618423 });
console.log(coordinates); // [37.618423, 55.751244]`,
    note: "Возвращает новый массив: изменение результата не изменяет исходную координату."
  },
  bounds: {
    signature: `function bounds(): LatLngBounds
function bounds(value: LatLngBoundsLike): LatLngBounds
function bounds(a: LatLngLike, b: LatLngLike): LatLngBounds`,
    note: "Это географические границы. Для прямоугольника в экранных или мировых пикселях используйте `pointBounds()`.",
    example: `import { bounds, rectangle } from "orihon";

const deliveryArea = bounds([
  { lat: 55.55, lng: 37.20 },
  { lat: 55.95, lng: 38.05 },
  { lat: 55.72, lng: 38.18 }
]);

rectangle(deliveryArea).addTo(map);
map.fitBounds(deliveryArea, { padding: 30 });`
  },
  lngLat: {
    note: "Результат — обычный `LatLng`: функция меняет только порядок входных аргументов и не вводит второй тип координат.",
    example: `import { lngLat, marker } from "orihon";

// MapLibre и GeoJSON используют longitude, latitude.
const berlin = lngLat(13.405, 52.52);

marker(berlin).bindPopup("Берлин").addTo(map);
// Карта выше создана с центром в Москве, поэтому переводим вид на маркер.
map.setView(berlin, 10);
showResult(berlin);`
  },
  latLng: {
    signature: `function latLng(value: LatLngLike): LatLng
function latLng(latitude: number, longitude: number): LatLng`,
    note: "Используйте объект `{ lat, lng }` или два числовых аргумента `latitude, longitude`. Массивы не принимаются. Для GeoJSON используйте `fromGeoJSONPosition(position)`.",
    example: `import { latLng, marker } from "orihon";

const moscow = latLng(55.751244, 37.618423);

marker(moscow).addTo(map);`
  },
  heatLayer: {
    summary: "Создаёт единый интерактивный слой тепловой поверхности, изолиний или их комбинации.",
    example: `import { heatLayer } from "orihon/advanced";

const heat = heatLayer(points, {
  mode: "both",
  backend: "auto",
  evaluation: "static",
  worker: true,
  labels: true,
  step: "auto",
  bands: true,
  cover: true,
  interactive: true
}).addTo(map);

// getHoveredFeature() отдаёт типизированный объект под курсором: в контексте tooltip
// он лежит в data, который статически типизирован как unknown.
heat.bindTooltip(() => {
  const feature = heat.getHoveredFeature();
  if (!feature) return "";
  return feature.kind === "line"
    ? "Изолиния: " + feature.fieldValue.toFixed(1)
    : "Зона: " + feature.lowerValue.toFixed(1) + "–" + (feature.upperValue?.toFixed(1) ?? "∞");
});`,
    note: "В режиме \`both\` цвет и линии используют одно scalar field. \`auto\` выбирает WebGPU для проверенного диапазона heatmap-only и WASM для contour-режимов; при ошибке ускорителя есть детерминированный fallback.",
    sections: [
      {
        title: "Режимы и вычислительный backend",
        rows: [
          ["mode", "\`heatmap\` · \`isolines\` · \`both\`", "Что отображать. В both поле вычисляется один раз."],
          ["backend", "\`auto\` · \`wasm\` · \`webgpu\`", "Auto учитывает режим, объём данных и стоимость GPU readback."],
          ["evaluation", "\`static\` · \`zoom\`", "Полное неизменяемое поле или уточнение после завершения zoom."],
          ["worker", "\`boolean\`", "Переносит field/contour rebuild с main thread; по умолчанию true."]
        ]
      },
      {
        title: "Поверхность и изолинии",
        rows: [
          ["labels", "\`boolean\`", "Подписи выбранных уровней."],
          ["step", "\`auto | number\`", "Адаптивный выбор уровней или абсолютный интервал."],
          ["bands", "\`boolean\`", "Заливка зон между изолиниями."],
          ["cover", "\`boolean\`", "Сохраняет холодную нулевую зону без прямоугольной рамки."],
          ["radius / blur", "\`number\`", "Радиус агрегации и сглаживание scalar field."],
          ["cols / rows", "\`number\`", "Разрешение вычислительной сетки; не равно количеству экранных пикселей."]
        ]
      },
      {
        title: "Runtime API",
        bullets: [
          "\`setData()\`, \`setDataAsync()\`, \`setPackedMercator()\` — замена источника.",
          "\`setMode()\`, \`setBackend()\`, \`setEvaluation()\`, \`setLabels()\` — переключение без пересоздания слоя.",
          "\`rebuildAsync()\`, \`getField()\`, \`getIsolines()\`, \`getStats()\` — управление вычислением и диагностика.",
          "\`getFeatureAt()\`, \`selectFeature()\`, \`clearSelection()\` — интерактивные линии и зоны.",
          "События: \`hover\`, \`mouseover\`, \`mousemove\`, \`mouseout\`, \`click\`, \`contextmenu\`, \`select\`, \`unselect\`."
        ]
      }
    ]
  },
  buildHeat: {
    summary: "Строит scalar field и, при необходимости, изолинии без создания слоя карты.",
    example: `import { bounds, buildHeat } from "orihon/advanced";

const area = bounds({ lat: 55.45, lng: 37.05 }, { lat: 56.03, lng: 38.15 });

const result = await buildHeat(points, area, {
  mode: "both",
  backend: "auto",
  cols: 512,
  rows: 384,
  step: "auto"
});

if (result) {
  console.log(result.field, result.rings, result.thresholds);
  console.table(result.profile);
}`,
    note: "Возвращаемый \`profile\` отдельно показывает \`fieldMs\`, \`contoursMs\`, \`readbackMs\` и \`totalMs\`. Это правильная точка входа для preprocessing, тестов и собственного renderer.",
    sections: [
      {
        title: "Результат",
        rows: [
          ["field", "HeatGrid", "Float32 scalar grid и географическая привязка."],
          ["rings", "HeatContour[]", "Сшитые линии/кольца уровней."],
          ["thresholds", "number[]", "Фактически использованные уровни."],
          ["levelSelection", "AdaptiveIsolineLevelSelection?", "Диагностика адаптивного выбора уровней."],
          ["profile", "HeatProfile", "Backend, размеры, времена и причина fallback."]
        ]
      }
    ]
  },
  heatSupport: {
    summary: "Асинхронно сообщает, доступны ли ускоренные WASM и WebGPU backend’ы в текущей среде.",
    example: `import { heatSupport } from "orihon/advanced";

const support = await heatSupport();
console.log({
  wasm: support.wasm,
  webgpu: support.webgpu
});`,
    note: "Наличие WebGPU не означает, что auto обязательно выберет его: политика учитывает режим, размер набора и стоимость readback."
  },
  icon: {
    signature: `function icon(options: IconOptions): Icon
function icon(options?: DivIconOptions): DivIcon`,
    returnType: "Icon | DivIcon",
    note: "Передайте `iconUrl` для растровой иконки или `content` (либо ни одного аргумента) для текстовой/Node-иконки. Одновременные iconUrl/content отклоняются; image-only поля недопустимы в DivIcon. Строки — безопасный текст, пустая строка и 0 сохраняются."
  },
  searchProvider: {
    signature: `function searchProvider<T extends SearchResult>(source: T[], options?: SearchProviderOptions<T>): SearchProvider<T>
function searchProvider<T extends SearchResult>(source: SearchAdapter<T>, options?: { limit?: number }): SearchProvider<T>`,
    note: "Локальный массив получает встроенный поиск по тексту; адаптер позволяет подключить серверные search, geocode и reverse без второй фабрики. Границы нормализуются: \`search()\` возвращает \`[]\`, \`geocode()\` и \`reverse()\` — \`null\`. Если адаптер не реализует \`reverse()\`, вызов возвращает \`null\`: отсутствующая возможность остаётся видимой, а не маскируется синтетическим результатом с координатами в поле \`name\`. Прежнее поведение включается явно — \`{ fallbackReverse: 'coordinates' }\`."
  },
  objectManager: {
    signature: `function objectManager(options?: LocalObjectManagerOptions): ObjectManager
function objectManager(options: RemoteObjectManagerOptions): RemoteObjectManager
function objectManager(options: PointObjectManagerOptions): MarkerCollection
function objectManager(options: UnifiedObjectManagerOptions): ObjectManager | RemoteObjectManager | MarkerCollection`,
    returnType: "ObjectManager | RemoteObjectManager | MarkerCollection",
    note: "Одна фабрика покрывает обычные объекты, удалённый loader с отменой устаревших запросов и points-режим с DOM/SVG/WebGL/hybrid renderer. Remote \`reload({ signal }?)\` запускает загрузку сразу и возвращает Promise объектов; отмена отклоняет его с AbortError. Автоматические загрузки используют debounceMs и события load/error/abort. ObjectManager отключается от карты через \`detach()\`, удаляет записи через \`removeObjects(ids)\`; \`destroy()\` терминален: операция, начатая до него, отклоняется с AbortError, а новый вызов у уничтоженного менеджера — с DestroyedError (\`code: 'ERR_DESTROYED'\`). Класс выбирается формой опций, поэтому для настроек, собранных динамически, предпочитайте именованные \`remoteObjectManager({ loader })\` и \`markerCollection(points)\`, оставив \`objectManager()\` локальному менеджеру. Для миллионов объектов используйте \`addAsync(..., { render:false })\`, затем \`prepareLayout()\`.",
    sections: [{
      title: "Взаимоисключающие источники",
      bullets: ["Выберите локальные опции/source, loader или points; смешанные источники отклоняются до подписок и чтения итератора.", "debounceMs/replace требуют loader. points использует renderer и не принимает clusterize/clusterRenderer/style."]
    }, {
      title: "Единый язык стилей",
      rows: [
        ["Точка", "`fill`, `fillOpacity`, `size`", "`color` и `opacity` поддерживаются как совместимые aliases; fill-поля имеют приоритет."],
        ["Линия", "`line.stroke`, `strokeOpacity`, `strokeWidth`", "Старые line.color, opacity и width продолжают работать."],
        ["Полигон", "`polygon.fill`, `fillOpacity`, `stroke`, `strokeOpacity`, `strokeWidth`", "Совпадает с vocabulary обычных vector paths."]
      ]
    }],
    example: `import { objectManager, remoteObjectManager, markerCollection } from "orihon/object-manager";

const local = objectManager({ clusterize: true }).addTo(map);
await local.addAsync(objects, { render: false });
await local.prepareLayout();

// Удалённый режим лучше запрашивать именованной фабрикой: класс виден в вызове.
const remote = remoteObjectManager({
  loader: async ({ bounds, zoom, signal }) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    signal?.throwIfAborted?.();
    return objects.slice(0, 100);
  },
  debounceMs: 120
});

const accessiblePoints = markerCollection(points.slice(0, 1000), {
  renderer: "svg",
  htmlButtonLimit: 500
});

showResult(local.getStats());`
  },
  webglPointLayer: {
    note: "Для крупных iterable/async-iterable используйте \`setDataAsync()\`: слой готовит приватные packed buffers и атомарно заменяет активный GPU snapshot только после успешного импорта."
  },
  tileLayer: {
    summary: "Создаёт растровую подложку: по умолчанию DOM во всех tier, а renderer \"auto\" дополнительно разрешает WebGL и WebGPU.",
    example: `import { tileLayer } from "orihon/advanced";

const basemap = tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  renderer: "auto",
  cacheSize: 256,
  maxRequests: 16,
  maxNewPerFrame: 12,
  maxDpr: 2,
  attribution: "© OpenStreetMap contributors"
}).addTo(map);

console.log(basemap.getStats?.());`,
    note: "Без \`renderer\` слой всегда DOM — одинаково в \`orihon/core\`, \`orihon/standard\` и \`orihon/advanced\`: импорт Advanced entry расширяет выбор, но не меняет то, что строит уже написанный вызов. \`renderer:'auto'\` — предпочтение: WebGPU, затем WebGL, затем DOM, и молча деградирует. \`renderer:'webgl'\` и \`renderer:'webgpu'\` — требование: они дают именно эту реализацию либо бросают UnsupportedCapabilityError (\`code: 'ERR_UNSUPPORTED_CAPABILITY'\`), потому что тихий откат на DOM выглядел бы как GPU-путь в разработке и профилировался бы как DOM в продакшене. Обе GPU-реализации делят общий cache/request/prefetch/zoom-backstop pipeline.",
    sections: [{
      title: "Выбор backend",
      rows: [
        ["renderer", "\`dom\` (по умолчанию) · \`auto\` · \`webgl\` · \`webgpu\`", "\`dom\` — значение по умолчанию во всех tier. \`auto\` выбирает лучший доступный путь и молча откатывается до DOM. \`webgl\` и \`webgpu\` — требование без fallback: недоступная реализация приводит к UnsupportedCapabilityError."],
        ["cacheSize", "\`number\`", "Максимальное число тайлов в общем WTinyLFU-кэше."],
        ["maxRequests", "\`number\`", "Ограничивает параллельные запросы изображений."],
        ["maxNewPerFrame", "\`number\`", "Ограничивает создание новых записей за кадр, защищая main thread."],
        ["getStats()", "\`GPUTileLayerStats\`", "Показывает фактический renderer, покрытие, очередь, кэш и приблизительную GPU-память."]
      ]
    }]
  },
  geoJSON: {
    note: "Координаты GeoJSON всегда имеют порядок [longitude, latitude]. Принимает реактивный \`FeatureSource\` из \`orihon/source\`: пока слой на карте, дельты add/update/remove применяются инкрементально по идентификаторам — нетронутые слои не пересоздаются, — и только \`reset\` заменяет коллекцию целиком. Canvas- и WebGL-батчи перестраиваются на любое изменение, потому что у батча нет отдельного слоя на объект. Для больших источников используйте асинхронную загрузку и \`renderer:'auto' | 'webgl'\`."
  },
  preparePointBatchAsync: {
    summary: "Кооперативно подготавливает большой iterable или async iterable точек без длительной блокировки main thread."
  },
  wmtsTileLayer: {
    summary: "Создаёт WMTS raster layer с матрицей тайлов и параметрами выбранного TileMatrixSet."
  },
  createWMTSFromCapabilities: {
    summary: "Разбирает XML WMTS GetCapabilities в конфигурацию, пригодную для wmtsTileLayer."
  },
  webglSymbolLayer: {
    summary: "Рисует большой набор GPU-символов с atlas-текстурами, поворотом и масштабированием."
  },
  pathBatch: {
    signature: `function pathBatch(options?: UniformPathBatchOptions): WebGLPathBatch
function pathBatch(options: FeaturePathBatchOptions): WebGLStyledPathBatch`,
    returnType: "WebGLPathBatch | WebGLStyledPathBatch",
    summary: "Создаёт единый пакетный слой линий с выбором реализации по требуемому стилю.",
    note: "\`mode:'uniform'\` использует instanced WebGL для общего стиля. \`mode:'feature'\` сохраняет индивидуальные strokeWidth/stroke/dash/gradient, picking и Canvas fallback."
  },
  webglPolygonBatch: {
    summary: "Триангулирует и рисует пакет полигонов через WebGL."
  },
  textLayer: {
    summary: "Размещает текст в географической точке как лёгкий слой с управлением стилем и видимостью.",
    note: "Принимает общий \`FeatureSource\`, но, в отличие от \`geoJSON\`, перестраивает раскладку подписей на любое изменение источника: жадное разрешение коллизий зависит от полного видимого набора, поэтому одна сдвинувшаяся подпись способна вытеснить соседние. Это свойство алгоритма, а не недостающая оптимизация."
  }
};

const explicitExamples = {
  createGeometryWorkerPool: `import { createGeometryWorkerPool } from "orihon/advanced";

const pool = createGeometryWorkerPool();
try {
  const packed = await pool.preparePoints(points.slice(0, 5000));
  showResult({ count: packed.count, skipped: packed.skipped, useWorker: pool.useWorker });
} finally {
  pool.destroy();
}`,
  markerCollection: `import { markerCollection } from "orihon/object-manager";

const collection = markerCollection(points.slice(0, 2000), { renderer: "auto" }).addTo(map);
showResult({ size: collection.size, renderer: collection.renderer });`,
  remoteObjectManager: `import { remoteObjectManager } from "orihon/object-manager";

const manager = remoteObjectManager({
  debounceMs: 150,
  loader: async ({ bounds, zoom, signal }) => {
    // Здесь был бы запрос к серверу по текущему виду карты.
    await new Promise((resolve) => setTimeout(resolve, 60));
    signal?.throwIfAborted?.();
    return objects.slice(0, 200);
  }
}).addTo(map);
const loaded = await manager.reload();
showResult({ loaded: loaded.length, stats: manager.getStats() });`,
  registerLocalePacks: `import { registerLocalePacks, resolveLocale } from "orihon";

registerLocalePacks({ ru: { ...resolveLocale("ru"), zoomIn: "Ближе", zoomOut: "Дальше" } });
map.setLocale("ru");
await map.localeReady;
showResult({ zoomIn: map.locale.zoomIn, zoomOut: map.locale.zoomOut });`,
  wTinyLfu: `import { wTinyLfu } from "orihon/advanced";

const cache = wTinyLfu(64);
let evicted = 0;
for (const point of points.slice(0, 500)) {
  // add() возвращает ключ, вытесненный этой вставкой, или undefined.
  if (cache.add(point.lat.toFixed(3) + ":" + point.lng.toFixed(3))) evicted++;
}
showResult({ size: cache.size, capacity: 64, evicted });`,
  wmtsTileLayer: `import { wmtsTileLayer } from "orihon";

// Первый аргумент — REST-шаблон WMTS. {TileMatrix}, {TileRow} и {TileCol} обязательны,
// остальные плейсхолдеры подставляются из options.
wmtsTileLayer("https://example.test/wmts/{Layer}/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png", {
  layer: "basemap",
  tileMatrixSet: "EPSG:3857",
  format: "image/png"
}).addTo(map);`,
  createWMTSFromCapabilities: `import { createWMTSFromCapabilities, wmtsTileLayer } from "orihon";

// В реальном проекте XML приходит из GetCapabilities сервиса.
const xml = \`<Capabilities xmlns="http://www.opengis.net/wmts/1.0">
  <Layer>
    <ows:Identifier>basemap</ows:Identifier>
    <Style><ows:Identifier>default</ows:Identifier></Style>
    <Format>image/png</Format>
    <TileMatrixSet>EPSG:3857</TileMatrixSet>
    <ResourceURL format="image/png" resourceType="tile"
      template="https://example.test/wmts/basemap/default/EPSG:3857/{TileMatrix}/{TileRow}/{TileCol}.png" />
  </Layer>
</Capabilities>\`;

const config = createWMTSFromCapabilities(xml);
wmtsTileLayer(config.template, config.options).addTo(map);
showResult(config);`,
  webglSymbolLayer: `import { webglSymbolLayer } from "orihon/advanced";

// Каждый instance описан полностью: слой не додумывает размер, поворот и цвет.
const layer = webglSymbolLayer().addTo(map);
layer.setInstances(points.slice(0, 500).map((point) => ({
  lat: point.lat,
  lng: point.lng,
  icon: "dot",
  size: 14,
  rotation: 0,
  opacity: 1,
  tint: [0.26, 0.84, 0.78, 1]
})));
showResult({ count: layer.getCount() });`,
  textLayer: `import { textLayer } from "orihon";

// Слой подписывает GeoJSON-объекты, а текст берёт из функции text(feature).
textLayer([
  { type: "Feature", properties: { name: "Москва" }, geometry: { type: "Point", coordinates: [37.618, 55.751] } },
  { type: "Feature", properties: { name: "Зеленоград" }, geometry: { type: "Point", coordinates: [37.214, 55.991] } }
], {
  text: (feature) => String(feature.properties?.name ?? ""),
  font: "600 14px system-ui",
  fill: "#0f172a",
  halo: "#ffffff",
  haloWidth: 3
}).addTo(map);`,
  preparePointBatchAsync: `import { preparePointBatchAsync } from "orihon/advanced";

// Готовит типизированный буфер, не блокируя main thread: результат — данные, а не слой.
const packed = await preparePointBatchAsync(points, {
  chunkSize: 20_000,
  yieldMode: "task"
});
showResult({ count: packed.count, skipped: packed.skipped, floats: packed.points.length });`
};

function parseConfluence(markdown) {
  const lines = String(markdown).replaceAll("Defaultnone", "").replaceAll("Defaulthtml", "").split(/\r?\n/);
  const sections = new Map();
  let current = "Введение";
  sections.set(current, []);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trimEnd();
    if (index + 1 < lines.length && /^[-=]{3,}\s*$/.test(lines[index + 1]) && line.trim()) {
      current = line.trim();
      if (!sections.has(current)) sections.set(current, []);
      index++;
      continue;
    }
    sections.get(current).push(line);
  }
  const get = (...names) => {
    for (const name of names) {
      const found = [...sections.entries()].find(([key]) => key.toLowerCase() === name.toLowerCase());
      if (found) return cleanMarkdown(found[1].join("\n"));
    }
    return "";
  };
  return {
    summary: get("Назначение"),
    example: get("Пример", "Базовый пример", "Импорт"),
    note: get("Особенности", "Где применять", "Отличие", "Ограничение", "Безопасность")
  };
}

function cleanMarkdown(value) {
  return value
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*Default(?:none|html)\s*/gm, "")
    .replaceAll("\\_", "_")
    .replaceAll("1.0.2", pkg.version)
    .trim();
}

function exportedFunctionRecords(entryPath) {
  const entrySource = program.getSourceFile(entryPath);
  if (!entrySource) throw new Error(`TypeScript entry not found: ${entryPath}`);
  const records = [];
  // Optional entries mostly declare their functions in place rather than re-exporting them.
  for (const statement of entrySource.statements) {
    const exported = ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export;
    if (!exported || !ts.isFunctionDeclaration(statement) || !statement.name) continue;
    records.push(toRecord(statement.name.text, statement, entrySource, entryPath));
  }
  for (const statement of entrySource.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.moduleSpecifier ||
        !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const modulePath = resolve(dirname(entryPath), moduleName.replace(/\.js$/, ".ts"));
    const source = program.getSourceFile(modulePath);
    if (!source) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const exportedName = element.name.text;
      const localName = element.propertyName?.text ?? exportedName;
      const declaration = findFunctionDeclaration(source, localName);
      if (!declaration) continue;
      records.push(toRecord(exportedName, declaration, source, modulePath));
    }
  }
  return records;
}

function findFunctionDeclaration(source, name) {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
      if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) return declaration;
      const type = checker.getTypeAtLocation(declaration.name);
      if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) return declaration;
    }
  }
  return null;
}

function toRecord(name, declaration, source, sourcePath) {
  const line = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
  const declaredType = checker.getTypeAtLocation(declaration.name ?? declaration);
  const callableSignature = checker.getSignaturesOfType(declaredType, ts.SignatureKind.Call)[0];
  const functionNode = ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
      ? declaration.initializer
      : ts.isFunctionDeclaration(declaration)
        ? declaration
        : callableSignature?.getDeclaration();
  if (!functionNode || !("parameters" in functionNode)) {
    throw new Error(`Callable declaration not found for exported function ${name}`);
  }
  const parameters = functionNode.parameters.map((parameter) => {
    const rawName = parameter.name.getText();
    const parameterType = checker.getTypeAtLocation(parameter);
    return {
      name: rawName,
      type: typeText(parameterType, parameter),
      required: !parameter.questionToken && !parameter.initializer && !parameter.dotDotDotToken,
      default: parameter.initializer?.getText() ?? "",
      description: documentationFor(parameter.name),
      properties: expandParameterProperties(parameter, parameterType)
    };
  });
  const typeParameters = functionNode.typeParameters?.length
    ? `<${functionNode.typeParameters.map((item) => item.getText(source)).join(", ")}>`
    : "";
  const asyncPrefix = functionNode.modifiers?.some((item) => item.kind === ts.SyntaxKind.AsyncKeyword) ? "async " : "";
  const paramsText = functionNode.parameters.map((item) => item.getText()).join(", ");
  const signatureObject = checker.getSignatureFromDeclaration(functionNode) ?? callableSignature;
  const returnType = signatureObject ? typeText(checker.getReturnTypeOfSignature(signatureObject), functionNode) : functionNode.type?.getText(source) ?? "inferred";
  return {
    name,
    sourcePath,
    sourceLine: line,
    signature: `${asyncPrefix}function ${name}${typeParameters}(${paramsText}): ${returnType}`,
    parameters,
    returnType,
    sourceDescription: documentationFor(declaration.name ?? functionNode)
  };
}

function expandParameterProperties(parameter, type) {
  const objectType = checker.getNonNullableType(type);
  const typeName = typeText(objectType, parameter);
  const parameterName = parameter.name.getText();
  if (checker.isArrayType(objectType) || checker.isTupleType(objectType) || /Iterable|Array<|\[\]/.test(typeName)) return [];
  const shouldExpand = /options?|config|appearance|style|context|input/i.test(parameterName) || /Options|Config|Appearance|Style|Context|Input/.test(typeName);
  if (!shouldExpand) return [];
  const properties = checker.getPropertiesOfType(checker.getApparentType(objectType));
  return properties.flatMap((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration || ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)) return [];
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    // Optional `never` fields only prohibit another union branch; they are not
    // available user options (the checker represents them as `undefined`).
    if (checker.getNonNullableType(propertyType).flags & ts.TypeFlags.Never) return [];
    return [{
      name: property.getName(),
      type: typeText(propertyType, declaration),
      required: (property.flags & ts.SymbolFlags.Optional) === 0,
      description: describeOption(property.getName(), ts.displayPartsToString(property.getDocumentationComment(checker)), typeText(propertyType, declaration))
    }];
  }).slice(0, 96);
}

function documentationFor(node) {
  const symbol = node ? checker.getSymbolAtLocation(node) : null;
  return symbol ? ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim() : "";
}

function typeText(type, node) {
  return checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
}

function describeOption(name, sourceDescription = "", propertyType = "") {
  const known = {
    content: "Безопасный текст, число или DOM Node. Пустая строка остаётся пустым содержимым.",
    icon: "Готовая иконка; не комбинируется с content или полями встроенной фигуры.",
    shape: "Форма встроенного маркера; выбирает режим фигуры, несовместимый с content/icon.",
    options: "Объект настроек функции; его поля перечислены в таблице ниже.",
    mode: "Режим результата или визуализации. Для heat: heatmap, isolines либо оба слоя из одного поля.",
    backend: "Вычислительный backend: auto выбирает доступное ускорение, wasm фиксирует WASM, webgpu — WebGPU.",
    evaluation: "Стратегия поля: static считает весь набор один раз, zoom уточняет поле после изменения масштаба.",
    worker: "Выполняет тяжёлую подготовку вне main thread, если Worker доступен.",
    labels: "Показывает подписи значений на изолиниях.",
    step: "Абсолютный интервал между соседними изолиниями либо auto для адаптивного шага.",
    bands: "Заливает диапазоны значений между соседними изолиниями.",
    cover: "Продолжает нижнюю зону до границы вычислительного домена, включая нулевые значения.",
    gradient: "Соответствие значений поля цветам: ключи ≤ 1 — доли referenceMax или текущего пика, ключи > 1 — абсолютные значения поля (нужен referenceMax), как в levels.",
    opacity: "Общая непрозрачность слоя в диапазоне от 0 до 1.",
    transferInput: "Передать буфер воркеру вместо копирования. Вызывающий код после этого не должен трогать буфер: передача его отцепляет. Целиком переносятся только полные буферы — вид на часть большего и SharedArrayBuffer копируются.",
    rotation: "Поворот по часовой стрелке в градусах вокруг точки привязки объекта.",
    minOpacity: "Минимальная непрозрачность ненулевой части тепловой поверхности.",
    domainOpacity: "Непрозрачность нулевой/нижней зоны полного домена.",
    domainPadding: "Доля дополнительного пространства вокруг полного extent источника в static-режиме.",
    dynamic: "Разрешает автоматическое обновление результата при изменениях карты или данных.",
    pad: "Экранный запас вокруг viewport, используемый при вычислении и отрисовке.",
    isolineWidth: "Толщина изолиний в CSS-пикселях.",
    isolineOpacity: "Непрозрачность штрихов изолиний от 0 до 1.",
    isolineLabelFormat: "Функция, преобразующая метаданные контура в текст подписи.",
    isolineLabelFont: "CSS-описание шрифта подписей изолиний.",
    isolineLabelColor: "Цвет подписей; auto подбирает контраст к поверхности.",
    isolineLabelMinVertices: "Минимальное число вершин контура, при котором разрешается подпись.",
    interactive: "Включает hit testing, hover, click, popup, tooltip и query для объектов слоя.",
    hitTolerance: "Дополнительный радиус hit testing вокруг геометрии в экранных пикселях.",
    hoverHighlight: "Подсвечивает линию или границы зоны под указателем.",
    selectOnClick: "Сохраняет выбранную кликом линию или зону до снятия выбора.",
    highlightColor: "Цвет объекта при наведении.",
    selectionColor: "Цвет зафиксированного выбранного объекта.",
    highlightWidth: "Толщина подсвеченной линии или границы зоны в CSS-пикселях.",
    pane: "Имя pane карты, определяющее DOM-контейнер и порядок наложения слоя.",
    attribution: "Текст источника данных для элемента управления attribution.",
    webgpuThreshold: "Минимальное число точек, после которого auto рассматривает WebGPU backend.",
    zoom: "Масштаб карты, используемый при выборе плотности сетки; географический kernel остаётся стабильным.",
    cols: "Количество столбцов scalar grid: выше точность, но больше память и время вычисления.",
    rows: "Количество строк scalar grid: выше точность, но больше память и время вычисления.",
    radius: "Географический радиус влияния точки, заданный через CSS-пиксели на опорном масштабе.",
    blur: "Радиус сглаживания поля; большие значения дают более мягкие переходы.",
    scaleZoom: "Опорный zoom, на котором CSS-радиус переводится в постоянный world-space kernel.",
    levels: "Число уровней либо явный массив пороговых значений изолиний.",
    maxIsolineLevels: "Жёсткий верхний предел числа уровней, защищающий время и память.",
    adaptiveLevels: "Подбирает информативные уровни по структуре scalar field вместо равномерного набора.",
    validMask: "Маска ячеек, участвующих в анализе и построении контуров.",
    outlierQuantiles: "Нижний и верхний квантили для подавления выбросов при выборе уровней.",
    candidateMultiplier: "Во сколько раз больше уровней-кандидатов анализировать перед финальным отбором.",
    coverageRadius: "Радиус соседства в ячейках для оценки пространственного покрытия уровня.",
    minCandidateCells: "Минимальное число подходящих ячеек, чтобы уровень стал кандидатом.",
    minIsolineLength: "Минимальная длина сохраняемого контура в единицах grid-ячеек.",
    minIsolineArea: "Минимальная площадь сохраняемого замкнутого контура в квадратных grid-ячейках.",
    coverageWeight: "Вес пространственного покрытия при ранжировании адаптивных уровней.",
    rangeWeight: "Вес охвата диапазона значений при ранжировании уровней.",
    redundancyWeight: "Штраф за уровни, геометрически дублирующие уже выбранные.",
    fragmentWeight: "Штраф за чрезмерно фрагментированные контуры.",
    referenceMax: "Фиксированный максимум шкалы, позволяющий сравнивать кадры без плавающей нормализации.",
    minPeak: "Минимальный пик поля, ниже которого результат считается пустым.",
    renderer: "Предпочитаемый renderer; auto выбирает подходящий DOM/Canvas/WebGL путь.",
    className: "Дополнительный CSS-класс корневого элемента.",
    minZoom: "Минимальный zoom, на котором объект доступен или видим.",
    maxZoom: "Максимальный zoom, на котором объект доступен или видим.",
    color: "Основной CSS-цвет объекта.",
    fill: "CSS-цвет внутренней заливки геометрии.",
    fillOpacity: "Непрозрачность внутренней заливки от 0 до 1.",
    stroke: "CSS-цвет линии или границы.",
    strokeWidth: "Толщина линии в CSS-пикселях.",
    strokeOpacity: "Непрозрачность линии от 0 до 1.",
    center: "Начальный центр карты: именованная координата { lat, lng }.",
    zoomSnap: "Шаг округления zoom; 1 разрешает только целые уровни, 0 отключает округление.",
    wheelZoomStep: "Изменение zoom за один нормализованный шаг колеса или trackpad.",
    maxBounds: "Географическая область, за пределы которой пользователю нельзя переместить центр карты; null снимает ограничение.",
    maxBoundsViscosity: "Сопротивление выходу за maxBounds от 0 до 1; 1 полностью удерживает карту внутри области.",
    inertia: "Включает продолжение движения карты после отпускания указателя.",
    inertiaDeceleration: "Замедление инерционного перемещения в CSS-пикселях за секунду в квадрате.",
    inertiaMaxSpeed: "Максимальная скорость инерционного перемещения в CSS-пикселях в секунду.",
    zoomAnimationDurationMs: "Продолжительность программной анимации zoom в миллисекундах.",
    controls: "Автоматически добавляет стандартные элементы управления карты.",
    locale: "Язык интерфейса или пользовательский словарь переводов.",
    ariaLabel: "Доступное имя контейнера или элемента для screen reader.",
    keyboard: "Включает управление картой с клавиатуры.",
    keyboardPanDelta: "Смещение карты одним нажатием стрелки в CSS-пикселях.",
    behaviors: "Точечно включает или отключает drag, wheel, double-click и другие способы взаимодействия.",
    crs: "Система координат карты; по умолчанию используется Web Mercator.",
    position: "Положение контрола в одном из углов карты.",
    prefix: "Текст или HTML-префикс перед динамической атрибуцией источников.",
    limit: "Максимальное количество элементов в результате.",
    text: "Функция, возвращающая индексируемый или отображаемый текст элемента.",
    lineCap: "Форма окончания линии: butt, round или square.",
    lineJoin: "Форма соединения соседних сегментов: round, bevel или miter.",
    dashArray: "Шаблон штрихов и промежутков в CSS-пикселях; строка, массив чисел или null для сплошной линии.",
    dashOffset: "Сдвиг начала штрихового шаблона в CSS-пикселях.",
    geodesic: "Соединяет координаты по дуге большого круга вместо прямой в проекции.",
    arrow: "Добавляет стрелку в начале, конце или на обоих концах линии.",
    arrowSize: "Размер наконечника стрелки в CSS-пикселях.",
    smoothFactor: "Допуск упрощения линии в экранных пикселях; большее значение уменьшает число вершин.",
    noClip: "Отключает отсечение геометрии по границам viewport.",
    clipPadding: "Запас области отсечения вокруг viewport в CSS-пикселях.",
    maxDpr: "Верхний предел devicePixelRatio для внутреннего canvas; ограничивает расход GPU-памяти.",
    fallbackCanvas: "Переключается на Canvas 2D, если инициализация WebGL невозможна.",
    cameraRedrawIntervalMs: "Минимальный интервал между точными GPU-перерисовками во время движения карты, в миллисекундах.",
    cameraSettleDelayMs: "Задержка финальной точной перерисовки после остановки камеры, в миллисекундах.",
    tileSize: "Размер одной стороны растрового тайла в пикселях.",
    cacheSize: "Максимальное количество готовых тайлов или записей, удерживаемых в памяти.",
    maxRequests: "Максимальное число одновременно выполняемых сетевых запросов.",
    subdomains: "Поддомены для распределения запросов; placeholder {s} заменяется по кругу.",
    crossOrigin: "Значение атрибута crossOrigin загружаемых изображений, например anonymous.",
    referrerPolicy: "Политика передачи HTTP Referer при загрузке ресурса.",
    errorTileUrl: "Изображение-заглушка, показываемое при ошибке загрузки тайла.",
    noWrap: "Запрещает повторение мира по долготе за пределами исходной матрицы тайлов.",
    tms: "Инвертирует координату Y для серверов со схемой TMS.",
    detectRetina: "Учитывает devicePixelRatio при выборе разрешения тайлов.",
    bounds: "Ограничивает загрузку и отображение тайлов указанной географической областью.",
    zIndex: "Порядок наложения слоя внутри его pane; большее значение рисуется выше.",
    layer: "Идентификатор слоя на WMS/WMTS-сервере.",
    tileMatrixSet: "Идентификатор TileMatrixSet, обычно WebMercatorQuad или значение из GetCapabilities.",
    format: "MIME-тип ответа сервера, например image/png или image/jpeg.",
    style: "Идентификатор серверного стиля; пустая строка выбирает стиль по умолчанию.",
    tileMatrixPrefix: "Префикс, добавляемый к номеру zoom при формировании TileMatrix.",
    dimensions: "Дополнительные WMTS dimensions, например time, elevation или пользовательские параметры.",
    maxNativeZoom: "Максимальный zoom, реально существующий на сервере; выше него тайлы масштабируются локально."
  };
  if (known[name]) return known[name];
  if (sourceDescription && /[а-яё]/i.test(sourceDescription)) return sourceDescription;
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
  if (/^(show|enable|use|allow|auto|keep|cache|wrap|clip|select|hover)/i.test(name)) return `Включает или отключает поведение «${words}».`;
  if (/color$/i.test(name)) return `CSS-цвет параметра «${words}».`;
  if (/opacity$/i.test(name)) return `Непрозрачность «${words}» в диапазоне от 0 до 1.`;
  if (/duration|interval|delay/i.test(name)) return `Временной параметр «${words}» в миллисекундах.`;
  if (/width|height|size|radius|padding|buffer|tolerance/i.test(name)) return `Размер «${words}» в CSS-пикселях.`;
  if (/limit|max|min|count|threshold/i.test(name)) return `Числовое ограничение «${words}».`;
  if (/=>|Function|Callback/.test(propertyType)) return `Функция обратного вызова для «${words}»; аргументы и результат указаны в столбце «Тип».`;
  if (/boolean/.test(propertyType)) return `Если true, включает параметр «${words}»; false отключает его.`;
  if (/number/.test(propertyType)) return `Числовая настройка «${words}».`;
  if (/string/.test(propertyType)) return `Строковое значение «${words}». Допустимые литералы перечислены в столбце «Тип».`;
  return `Настройка «${words}» типа ${propertyType || "unknown"}.`;
}

const textCache = new Map();
function requireText(path) {
  if (!textCache.has(path)) {
    textCache.set(path, ts.sys.readFile(path) ?? "");
  }
  return textCache.get(path);
}

/**
 * Within a section the order is by expected reach, not alphabet: what almost every application
 * calls comes first, then the common-but-optional, then the specialised. Alphabetical order put
 * `attributionControl` above `zoomControl` and `icon` above `marker`, which buries the entry
 * points a reader is actually looking for. Anything absent from this list sorts after it, by name.
 */
const usageRank = [
  // Карта и камера
  "createMap", "featureGroup",
  // Растровые тайлы
  "tileLayer", "vectorTileLayer", "wmsTileLayer", "wmtsTileLayer", "createPMTilesRasterSource", "wTinyLfu",
  // Векторные данные
  "geoJSON", "polyline", "polygon", "circle", "circleMarker", "rectangle", "textLayer",
  "featureSource", "createMVTProvider", "createPMTilesProvider", "createMLTProvider",
  // Маркеры и оверлеи
  "marker", "popup", "tooltip", "icon", "imageOverlay", "popupContent", "svgOverlay", "videoOverlay",
  "sanitizeSvgElement", "sanitizePopupHtml", "createEChartsPopupRenderer", "popupConditionMatches",
  // Элементы управления
  "zoomControl", "scaleControl", "layersControl", "attributionControl", "geolocationControl",
  "customControl", "drawControl", "fullscreenControl", "miniMap", "measureControl", "snapLatLng", "drawHandle",
  // ObjectManager и поиск
  "objectManager", "remoteObjectManager", "markerCollection", "searchProvider", "routingLayer",
  "createSuggestWidget", "createSuggestProvider", "trafficLayer", "spatialGridIndex",
  "createStraightLineRoutingProvider",
  // WebGL
  "webglPointLayer", "pathBatch", "webglSymbolLayer", "webglPolygonBatch",
  // Тепловые карты — buildHeat остаётся среди вычислений: он не создаёт слой.
  "heatLayer", "heatSupport",
  // Вычисления без отрисовки
  "latLng", "lngLat", "latLngs", "lngLats", "bounds", "point", "distance", "destination",
  "fromGeoJSONPosition", "fromGeoJSONPositions",
  "toGeoJSONPosition", "bufferPoint", "geodesicInterpolate", "project", "unproject", "zoomForBounds",
  "pointBounds", "metersToPixels", "clampLat", "wrapLng", "scale", "decodeMVT",
  "createWMTSFromCapabilities", "buildClusterIndex", "queryClusterLayout", "buildClusterLayout",
  "preparePointBatch", "preparePointBatchAsync", "buildHeat", "markerShapeMetrics",
  // Локализация
  "resolveLocale", "ensureLocalePacks", "registerLocalePacks", "resolveDrawLocale",
  // Производительность и инфраструктура
  "offlineTileCache", "performanceInspector", "createMapAdapter", "defineOrihonElement",
  "createGeometryWorkerPool"
];
const usageIndex = new Map(usageRank.map((name, index) => [name, index]));
function rankOf(name) {
  return usageIndex.has(name) ? usageIndex.get(name) : Number.MAX_SAFE_INTEGER;
}

/**
 * The example on a page is both the snippet a reader copies and the code the playground runs, so
 * it has to be a whole program: a snippet that calls `.addTo(map)` without ever creating a map is
 * not something anyone can paste into an empty project. Snippets stay authored as the interesting
 * part only; this builds the map around them and folds the extra names into the existing import
 * lines so the result still reads as one file.
 */
const ENTRY_ORDER = ["orihon/core", "orihon/standard", "orihon", "orihon/advanced", ...optionalEntries.map(([entry]) => entry)];

function exportedNames(path) {
  const source = program.getSourceFile(path);
  const symbol = source ? checker.getSymbolAtLocation(source) : null;
  return symbol ? checker.getExportsOfModule(symbol).map((item) => item.name) : [];
}

// Which entry actually exports a name decides which import line an example may use. Folding
// `createMap` into `import { … } from "orihon/geo"` produced code that ran here — the frame strips
// imports — and failed the moment a reader pasted it into a project.
const entryExports = new Map([
  ["orihon/core", new Set(exportedNames(join(root, "src", "core.ts")))],
  ["orihon/standard", new Set(exportedNames(join(root, "src", "standard.ts")))],
  ["orihon", new Set(exportedNames(join(root, "src", "standard.ts")))],
  ["orihon/advanced", new Set(exportedNames(sourceEntry))],
  ...optionalEntries.map(([entry, path]) => [entry, new Set(exportedNames(path))])
]);

function resolveImportEntry(name, pageEntry) {
  if (entryExports.get(pageEntry)?.has(name)) return pageEntry;
  for (const candidate of ENTRY_ORDER) if (entryExports.get(candidate)?.has(name)) return candidate;
  return null;
}

function freeIdentifiers(code) {
  const source = ts.createSourceFile("example.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declared = new Set();
  const used = new Set();
  const visit = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      declared.add(node.name.text);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) declared.add(node.name.text);
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!isMemberName) used.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...used].filter((name) => !declared.has(name));
}

function importLinesFor(body, entry, name, rendersMap) {
  const grouped = new Map();
  const claim = (identifier) => {
    const target = resolveImportEntry(identifier, entry);
    if (!target) return;
    if (!grouped.has(target)) grouped.set(target, new Set());
    grouped.get(target).add(identifier);
  };
  for (const identifier of freeIdentifiers(body)) claim(identifier);
  const order = [entry, ...ENTRY_ORDER.filter((candidate) => candidate !== entry)];
  const lines = [];
  for (const target of order) {
    const names = grouped.get(target);
    if (!names) continue;
    const sorted = [...names].sort((a, b) => (a === name ? -1 : b === name ? 1 : a.localeCompare(b)));
    lines.push(`import { ${sorted.join(", ")} } from "${target}";`);
  }
  if (rendersMap) lines.push('import "orihon/orihon.css";');
  return lines;
}

const PREAMBLE_NAMES = ["map", "center", "OSM"];

// The playground used to inject demo data into every snippet, so the page showed code that ran
// here and nowhere else. An example now declares what it uses, which is also what a reader needs
// in order to paste it into an empty project.
const DEMO_DATA = {
  weightedPoints: {
    code: `const weightedPoints = Array.from({ length: 2500 }, (item, index) => ({
  lat: 55.45 + Math.random() * 0.58,
  lng: 37.05 + Math.random() * 1.1,
  weight: 1 + (index % 9)
}));`
  },
  points: {
    needs: ["weightedPoints"],
    code: "const points = weightedPoints.map((point, index) => ({ ...point, data: { id: index, value: point.weight } }));"
  },
  objects: {
    needs: ["points"],
    code: `const objects = points.slice(0, 1200).map((point, index) => ({
  id: \`object-\${index}\`,
  coordinates: { lat: point.lat, lng: point.lng },
  properties: { title: \`Объект \${index + 1}\`, value: point.weight, active: index % 7 !== 0 }
}));`
  },
  demoBounds: {
    code: "const demoBounds = bounds({ lat: 55.45, lng: 37.05 }, { lat: 56.03, lng: 38.15 });"
  },
  geojson: {
    code: `const geojson = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { name: "Маршрут" }, geometry: { type: "LineString", coordinates: [[37.35, 55.65], [37.62, 55.75], [37.92, 55.86]] } },
    { type: "Feature", properties: { name: "Зона" }, geometry: { type: "Polygon", coordinates: [[[37.42, 55.62], [37.78, 55.62], [37.78, 55.88], [37.42, 55.88], [37.42, 55.62]]] } }
  ]
};`
  },
  nextFeature: {
    needs: ["geojson"],
    code: "const nextFeature = geojson.features[0];"
  }
};

function demoDeclarations(body) {
  const declared = new Set(
    [...body.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((match) => match[1])
  );
  // A property key is not a use of the demo data: `{ points: route.length }` was pulling in a
  // 2500-point fixture the example never read.
  const identifiers = new Set(freeIdentifiers(body));
  const wanted = [];
  const add = (key) => {
    if (wanted.includes(key)) return true;
    // The example already builds this value itself; injecting a second declaration would shadow
    // or redeclare it, so leave the whole dependency chain alone.
    if (declared.has(key)) return false;
    for (const dependency of DEMO_DATA[key].needs ?? []) if (!add(dependency)) return false;
    wanted.push(key);
    return true;
  };
  for (const key of Object.keys(DEMO_DATA)) if (identifiers.has(key)) add(key);
  return wanted.map((key) => DEMO_DATA[key].code);
}

// `return` at the top level is a syntax error in a module, so an example ending with one is not
// something a reader can paste anywhere. Turn it into the statement it was standing in for.
function normalizeReturn(body) {
  const lines = body.split("\n");
  const index = lines.findIndex((line) => /^return\b/.test(line));
  if (index < 0) return body;
  const head = lines.slice(0, index).join("\n").trimEnd();
  const match = /^return\s+([\s\S]*?);?\s*$/.exec(lines.slice(index).join("\n").trim());
  const expression = match ? match[1].trim() : "";
  if (!expression) return head;
  const prints = /showResult\s*\(|console\s*\./.test(head);
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expression) || /^[{[]/.test(expression)) {
    return prints ? head : `${head}\nconsole.log(${expression});`;
  }
  return `${head}\n${expression};`;
}

// A snippet that only declares a value runs to completion with an empty output panel, which reads
// as a broken example. Print the last thing it computed, the way a reader would while exploring.
function withVisibleResult(body, rendersMap) {
  if (rendersMap || /\bshowResult\s*\(|\bconsole\s*\./.test(body)) return body;
  const declared = [...body.matchAll(/^\s*(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/gm)];
  const last = declared.at(-1);
  return last ? `${body}\nconsole.log(${last[1]});` : body;
}

function runnableExample(code, entry, name) {
  const foreignImports = [];
  const bodyLines = [];
  for (const line of code.split("\n")) {
    if (!/^\s*import\b/.test(line)) { bodyLines.push(line); continue; }
    // Orihon imports are regenerated from what the code actually uses; anything else is the
    // reader's own dependency and stays exactly as written.
    if (!/["']orihon(\/|["'])/.test(line)) foreignImports.push(line.trim());
  }
  let body = normalizeReturn(bodyLines.join("\n").trim());
  // `showResult` only exists inside the playground frame. The example is the code a reader copies
  // into their own project, so it prints the way that project would.
  body = body.replaceAll("showResult(", "console.log(");
  const declarations = demoDeclarations(body);
  const ownsMap = /\bcreateMap\s*\(/.test(body);
  const needsMap = !ownsMap && PREAMBLE_NAMES.some((key) => freeIdentifiers(body).includes(key));
  body = withVisibleResult(body, needsMap || ownsMap);

  const preamble = needsMap
    ? [
      'const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";',
      "const center = { lat: 55.751244, lng: 37.618423 };",
      'const map = createMap("map", { center, zoom: 9 });',
      'tileLayer(OSM, { attribution: "© OpenStreetMap contributors" }).addTo(map);'
    ].join("\n")
    : "";
  const source = [preamble, declarations.join("\n\n"), body].filter(Boolean).join("\n\n");
  const imports = [...foreignImports, ...importLinesFor(source, entry, name, needsMap || ownsMap)];
  return [imports.join("\n"), source].filter(Boolean).join("\n\n");
}

function groupFor(path, name) {
  const p = path.replaceAll("\\", "/");
  const computationFunctions = new Set([
    "buildClusterIndex", "buildClusterLayout",
    "bounds", "clampLat", "destination", "distance", "geodesicInterpolate",
    "latLng", "lngLat", "latLngs", "lngLats", "fromGeoJSONPositions",
    "metersToPixels", "point", "pointBounds", "project", "scale",
    "unproject", "wrapLng", "zoomForBounds", "buildHeat", "createWMTSFromCapabilities",
    "decodeMVT", "markerShapeMetrics", "queryClusterLayout",
    "preparePointBatch", "preparePointBatchAsync"
  ]);
  // The optional entries land outside the path heuristics below, so they are placed by name:
  // otherwise drawControl, featureSource and popupContent all fall into the infrastructure bin.
  const byName = {
    bufferPoint: "Вычисления без отрисовки",
    fromGeoJSONPosition: "Вычисления без отрисовки",
    toGeoJSONPosition: "Вычисления без отрисовки",
    pathBatch: "WebGL",
    featureSource: "Векторные данные",
    popupContent: "Маркеры и оверлеи",
    sanitizePopupHtml: "Маркеры и оверлеи",
    popupConditionMatches: "Маркеры и оверлеи",
    createEChartsPopupRenderer: "Маркеры и оверлеи",
    drawControl: "Элементы управления",
    drawHandle: "Элементы управления",
    snapLatLng: "Элементы управления",
    fullscreenControl: "Элементы управления",
    measureControl: "Элементы управления",
    miniMap: "Элементы управления",
    createPMTilesProvider: "Векторные данные",
    createPMTilesRasterSource: "Растровые тайлы",
    createMLTProvider: "Векторные данные",
    decodeMLT: "Вычисления без отрисовки",
    decodePackedMLT: "Вычисления без отрисовки",
    encodePackedMLT: "Вычисления без отрисовки",
    looksLikeMLT: "Вычисления без отрисовки",
    deserializePMTilesDirectory: "Вычисления без отрисовки",
    findPMTilesEntry: "Вычисления без отрисовки",
    zxyToTileId: "Вычисления без отрисовки"
  };
  if (byName[name]) return byName[name];
  if (computationFunctions.has(name)) return "Вычисления без отрисовки";
  if (name === "createMap" || name === "featureGroup" || p.endsWith("/camera.ts")) return "Карта и камера";
  if (/tile-layer|\/wms-|\/wmts-|tiny-lfu/.test(p)) return "Растровые тайлы";
  if (/vector|geojson|mvt|text-layer/.test(p)) return "Векторные данные";
  if (/marker|overlay|icon/.test(p)) return "Маркеры и оверлеи";
  if (/ui\/control/.test(p)) return "Элементы управления";
  if (/object-manager|remote-object|spatial-grid|search|routing|suggest|traffic|cluster-layout/.test(p)) return "ObjectManager и поиск";
  if (/webgl/.test(p)) return "WebGL";
  if (/heat/.test(p)) return "Тепловые карты и изолинии";
  if (/locale/.test(p)) return "Локализация";
  return "Производительность и инфраструктура";
}

function entryFor(group, name) {
  const core = new Set(["createMap", "tileLayer", "point", "pointBounds", "latLng", "lngLat", "latLngs", "lngLats", "fromGeoJSONPositions", "bounds", "project", "unproject", "distance", "destination", "geodesicInterpolate", "metersToPixels", "clampLat", "wrapLng", "scale", "zoomForBounds"]);
  const standard = new Set(["featureGroup", "wmsTileLayer", "wmtsTileLayer", "createWMTSFromCapabilities", "marker", "markerShapeMetrics", "icon", "textLayer", "polyline", "polygon", "rectangle", "circle", "circleMarker", "geoJSON", "popup", "tooltip", "imageOverlay", "videoOverlay", "svgOverlay", "sanitizeSvgElement", "zoomControl", "scaleControl", "geolocationControl", "attributionControl", "layersControl", "customControl", "resolveLocale", "ensureLocalePacks", "registerLocalePacks"]);
  if (core.has(name)) return "orihon/core";
  if (standard.has(name)) return "orihon/standard";
  return "orihon/advanced";
}

function fallbackSummary(record) {
  if (/^(create|build|decode|prepare|query|register|ensure|sanitize|resolve|pack)/.test(record.name)) {
    return `Выполняет операцию \`${record.name}\` текущего публичного API Orihon.`;
  }
  return `Создаёт или вычисляет \`${record.name}\` с типизированными параметрами Orihon.`;
}

// The page header already states the summary above the fold, so repeating it as the first
// sentence of this section made every page open by saying the same thing twice.
function detailedPurpose(record, group, override, imported) {
  return override.note || imported.note || purposeHint(record, group, groupDescriptions[group]);
}

function purposeHint(record, group, groupContext) {
  if (/Layer|Marker|Overlay/.test(record.returnType)) return "Возвращённый объект можно настроить, добавить на карту через `addTo(map)`, временно скрыть или удалить без пересоздания карты.";
  if (/Control/.test(record.returnType)) return "Добавьте контрол на карту и храните возвращённый объект, если потребуется программно удалить или перенастроить элемент интерфейса.";
  if (/Provider/.test(record.returnType) || /Provider/.test(record.name)) return "Используйте возвращённый provider как источник для соответствующего слоя или UI-компонента; он отделяет получение данных от их отображения.";
  if (group === "Вычисления без отрисовки") return "Функция не создаёт слой и не изменяет карту. Результат можно передать визуальному слою, другой вычислительной функции, сохранить или обработать собственным кодом.";
  if (group === "Тепловые карты и изолинии") return "Все режимы используют одну модель поля, поэтому числовые значения поверхности и геометрия изолиний согласованы между собой.";
  if (group === "WebGL") return "Выбирайте этот низкоуровневый слой для больших наборов данных, когда важнее пакетная GPU-отрисовка, чем отдельный DOM-элемент для каждого объекта.";
  return `Функция относится к разделу «${group}». ${groupContext}`;
}

function generatedPlayground(record) {
  const args = record.parameters.map(sampleArgument).join(", ");
  const awaitPrefix = record.signature.startsWith("async ") || /^Promise</.test(record.returnType) ? "await " : "";
  return `// Редактируйте пример и нажмите «Выполнить» или Ctrl+Enter.\nconst result = ${awaitPrefix}${record.name}(${args});\n\n// Если функция вернула слой, покажем его на карте.\nif (result?.addTo) result.addTo(map);\nshowResult(result);`;
}

function sampleArgument(parameter) {
  const name = parameter.name.replace(/^\.\.\./, "");
  const type = parameter.type;
  if (!parameter.required) return "undefined";
  if (/map/i.test(name)) return "map";
  if (/bounds/i.test(name)) return "demoBounds";
  if (/latlng|coordinate|center|location|origin|destination|position|point/i.test(name)) return "center";
  if (/url|template/i.test(name)) return "OSM";
  if (/geojson|featurecollection/i.test(type + name)) return "geojson";
  if (/points?|data|items?|objects?/i.test(name)) return "points";
  if (/string/i.test(type)) return `"Пример"`;
  if (/number/i.test(type)) return "1";
  if (/boolean/i.test(type)) return "true";
  if (/function|=>/.test(type)) return "() => {}";
  if (/options?|config|style|appearance/i.test(name)) return "{}";
  return "undefined";
}

function autoExample(record, entry) {
  const required = record.parameters.filter((item) => item.required).map((item) => item.name);
  const args = required.length ? required.map((name) => `/* ${name} */`).join(", ") : "";
  const awaitPrefix = record.signature.startsWith("async ") || /^Promise</.test(record.returnType) ? "await " : "";
  return `import { ${record.name} } from "${entry}";

const result = ${awaitPrefix}${record.name}(${args});`;
}

const legacy = new Map();
for (const page of confluence.pages) {
  const match = /^Orihon API - (.+)$/.exec(page.title);
  if (!match || /\(legacy\)$/i.test(match[1])) continue;
  legacy.set(match[1], { ...parseConfluence(page.markdown), confluenceUrl: page.url });
}

const obsolete = new Set(["webglHeatLayer", "heatIsolineLayer", "buildHeatIsolines"]);
/**
 * Exported so their own entry can build itself, not for applications to call. Documenting them
 * would advertise internals as product API; `orihon/easy` is absent for a different reason — its
 * only function is `createMap`, which the root entry already documents, and the rest of that API
 * is methods on the returned map.
 */
const entryInternals = new Set(["createDrawModeIcon", "drawLocaleFromMapLabel", "sniffPackedMLT"]);
const optionalRecords = optionalEntries.flatMap(([entry, path]) =>
  exportedFunctionRecords(path).map((record) => ({ ...record, entryOverride: entry }))
);
const functions = [...exportedFunctionRecords(sourceEntry), ...optionalRecords]
  .filter((record, index, all) =>
    !obsolete.has(record.name) &&
    !entryInternals.has(record.name) &&
    all.findIndex((item) => item.name === record.name) === index)
  .map((record) => {
    const group = groupFor(record.sourcePath, record.name);
    const entry = record.entryOverride ?? entryFor(group, record.name);
    const imported = legacy.get(record.name) ?? {};
    const override = special[record.name] ?? {};
    return {
      ...record,
      signature: override.signature || record.signature,
      returnType: override.returnType || record.returnType,
      group,
      entry,
      summary: override.summary || clearSummaries[record.name] || imported.summary || record.sourceDescription || fallbackSummary(record),
      purpose: detailedPurpose(record, group, override, imported),
      // The example is also the code that runs, so a snippet written against the current API
      // outranks the imported Confluence text: several of those still used placeholders and
      // variables that never existed, which a reader could not run and could not copy either.
      example: runnableExample(
        override.example || explicitExamples[record.name] || playgroundExamples[record.name] || imported.example || autoExample(record, entry),
        entry,
        record.name
      ),
      playground: playgroundExamples[record.name] || generatedPlayground(record),
      note: override.note || imported.note || "",
      sections: override.sections || [],
      confluenceUrl: imported.confluenceUrl || null,
      source: relative(root, record.sourcePath).replaceAll("\\", "/")
    };
  })
  .sort((a, b) =>
    groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) ||
    rankOf(a.name) - rankOf(b.name) ||
    a.name.localeCompare(b.name));

await rm(functionsRoot, { recursive: true, force: true });
await mkdir(functionsRoot, { recursive: true });
await mkdir(join(guideRoot, "assets"), { recursive: true });

const navigation = renderNavigation(functions);
for (let index = 0; index < functions.length; index++) {
  const item = functions[index];
  const directory = join(functionsRoot, item.name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "index.html"), renderFunctionPage(item, functions[index - 1], functions[index + 1], navigation), "utf8");
}

await writeFile(join(guideRoot, "index.html"), renderHome(functions, navigation), "utf8");
await writeFile(join(guideRoot, "manifest.json"), JSON.stringify({
  version: pkg.version,
  source: "src/advanced-entry.ts",
  confluenceSource: confluence.source,
  functions: functions.map(({ name, group, entry, summary }) => ({
    name, group, entry, summary, url: `./functions/${name}/`
  }))
}, null, 2) + "\n", "utf8");

console.log(`Developer guide: ${functions.length} function pages generated for orihon@${pkg.version}`);

function renderNavigation(items) {
  return groupOrder.map((group) => {
    const links = items.filter((item) => item.group === group);
    if (!links.length) return "";
    return `<section class="nav-group" data-nav-group>
      <h2>${escapeHtml(group)}</h2>
      <div class="nav-links">${links.map((item) =>
        `<a data-api-link data-search="${escapeAttr((item.name + " " + item.summary).toLowerCase())}" href="/examples/developer-guide/functions/${encodeURIComponent(item.name)}/"><code>${escapeHtml(item.name)}</code></a>`
      ).join("")}</div>
    </section>`;
  }).join("");
}

function shell({ title, description, navigation, content, pageClass = "", canonicalPath = "" }) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escapeAttr(description)}" />
  <title>${escapeHtml(title)} · Orihon Maps Developer Guide</title>
  <link rel="icon" href="/assets/brand/svg/orihon-favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/examples/developer-guide/assets/guide.css" />
</head>
<body class="${escapeAttr(pageClass)}" data-canonical-path="${escapeAttr(canonicalPath)}">
  <header class="topbar">
    <a class="brand" href="/examples/developer-guide/" aria-label="Orihon Maps Developer Guide">
      <img src="/assets/brand/svg/orihon-logo-horizontal.svg" alt="Orihon Maps" />
      <span>Developer Guide</span>
    </a>
    <button class="nav-toggle" type="button" data-nav-toggle aria-label="Открыть навигацию">☰</button>
    <label class="search">
      <span class="sr-only">Поиск функции</span>
      <input data-api-search type="search" placeholder="Функция…  /" autocomplete="off" />
      <kbd>/</kbd>
    </label>
    <span class="version">v${escapeHtml(pkg.version)}</span>
  </header>
  <aside class="sidebar" data-sidebar>
    <div class="sidebar-intro"><a href="/examples/developer-guide/">Все функции</a><span>${functions.length} страниц</span></div>
    <nav aria-label="Функции Orihon Maps">${navigation}</nav>
    <p class="empty-search" data-empty-search hidden>Ничего не найдено.</p>
  </aside>
  <main class="content">${content}</main>
  <script type="module" src="/examples/developer-guide/assets/guide.js"></script>
</body>
</html>`;
}

function renderHome(items, navigation) {
  const groups = groupOrder.map((group) => {
    const groupItems = items.filter((item) => item.group === group);
    if (!groupItems.length) return "";
    const rows = groupItems.map((item) => `<tr>
        <td><a href="./functions/${encodeURIComponent(item.name)}/"><code>${escapeHtml(item.name)}()</code></a></td>
        <td><code>${escapeHtml(item.entry)}</code></td>
        <td>${escapeHtml(item.summary)}</td>
      </tr>`).join("");
    return `<section class="api-group" id="${slug(group)}">
      <div class="group-heading"><div><p class="eyebrow">Раздел</p><h2>${escapeHtml(group)}</h2></div><span>${groupItems.length}</span></div>
      <p class="group-description">${escapeHtml(groupDescriptions[group])}</p>
      <div class="table-wrap"><table class="api-table">
        <thead><tr><th>Команда</th><th>Импорт из</th><th>Что делает</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
  }).join("");

  const firstMap = [
    'import { createMap } from "orihon/easy";',
    'import "orihon/orihon.css";',
    "",
    'const map = createMap("map", {',
    "  center: { lat: 52.52, lng: 13.405 },",
    "  zoom: 12,",
    "  basemap: {",
    '    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",',
    '    attribution: "© OpenStreetMap contributors"',
    "  }",
    "});"
  ].join("\n");

  const content = `<section class="hero">
    <p class="eyebrow">orihon@${escapeHtml(pkg.version)} · ${items.length} функций из текущих TypeScript-входов</p>
    <h1>Руководство разработчика</h1>
    <p>Каждая публичная функция — своя страница: сигнатура, параметры и пример, который выполняется здесь же на карте. Ниже — весь каталог: команда, вход, из которого её импортируют, и что она делает. Список берётся из входов <code>src/</code>, поэтому удалённая функция исчезает, а новая появляется сама.</p>
    <div class="hero-badges"><span>${items.length} функций</span><span>${groupOrder.length} разделов</span><span>Core · Standard · Advanced</span></div>
  </section>
  <section class="doc-section" id="с-чего-начать">
    <h2>С чего начать</h2>
    <p>Из пустой папки одна команда создаёт проект, в котором карта уже рисуется — со стилями, высотой контейнера и attribution:</p>
    ${codeBlock("npm create orihon-app my-map\ncd my-map\nnpm install\nnpm run dev", "sh")}
    <p>В существующем приложении — установка и первая карта:</p>
    ${codeBlock("npm install orihon", "sh")}
    ${codeBlock(firstMap, "js")}
    <p>Контейнеру нужна собственная высота: у <code>&lt;div&gt;</code> её нет, и карта отрисуется в ничто. Orihon сообщает об этом в консоль — см. <a href="https://github.com/whahedev/orihon/blob/master/docs/TROUBLESHOOTING.md#zero-size-container">Troubleshooting</a>.</p>
    <p>Уровень пакета и сложность API — разные вещи. <code>orihon/core</code>, <code>orihon/standard</code> и <code>orihon</code> отвечают за состав и gzip-бюджет, а Easy, Layer API и Rendering API — за уровень управления; <code>orihon/easy</code> работает поверх Standard и остаётся map-centric (<code>map.addMarker({ position })</code>), а Layer API — layer-centric (<code>marker(position).addTo(map)</code>). Полный контракт Easy — в <a href="https://github.com/whahedev/orihon/blob/master/docs/EASY.md">docs/EASY.md</a>, весь публичный список команд — в <a href="https://github.com/whahedev/orihon/blob/master/docs/API.md">docs/API.md</a>.</p>
  </section>
  ${groups}`;
  return shell({
    title: "Все функции",
    description: "Локальное руководство разработчика по публичным функциям Orihon Maps",
    navigation,
    content,
    pageClass: "guide-home",
    canonicalPath: "/examples/developer-guide/"
  });
}

function renderFunctionPage(item, previous, next, navigation) {
  const parameters = item.parameters.length
    ? `<div class="table-wrap"><table><thead><tr><th>Параметр</th><th>Тип</th><th>Обязателен</th><th>По умолчанию</th><th>Описание</th></tr></thead><tbody>${item.parameters.map((parameter) =>
        `<tr><td><code>${escapeHtml(parameter.name)}</code></td><td><code>${escapeHtml(parameter.type)}</code></td><td>${parameter.required ? "да" : "нет"}</td><td>${parameter.default ? `<code>${escapeHtml(parameter.default)}</code>` : "—"}</td><td>${escapeHtml(parameter.description || describeParameter(item.name, parameter))}</td></tr>`
      ).join("")}</tbody></table></div>`
    : "<p>Функция не принимает параметров.</p>";
  const optionTables = item.parameters.filter((parameter) => parameter.properties.length).map((parameter) =>
    `<div class="option-detail"><h3>Состав <code>${escapeHtml(parameter.name)}</code></h3><p>Объект <code>${escapeHtml(parameter.type)}</code> поддерживает следующие поля:</p><div class="table-wrap"><table><thead><tr><th>Поле</th><th>Тип</th><th>Обязательное</th><th>Назначение</th></tr></thead><tbody>${parameter.properties.map((property) =>
      `<tr><td><code>${escapeHtml(property.name)}</code></td><td><code>${escapeHtml(property.type)}</code></td><td>${property.required ? "да" : "нет"}</td><td>${escapeHtml(property.description)}</td></tr>`
    ).join("")}</tbody></table></div></div>`
  ).join("");
  const imported = `import { ${item.name} } from "${item.entry}";`;
  const extra = item.sections.map((section) => `<section class="doc-section"><h2>${escapeHtml(section.title)}</h2>
    ${section.rows ? `<div class="table-wrap"><table><thead><tr><th>Опция / поле</th><th>Тип</th><th>Описание</th></tr></thead><tbody>${section.rows.map((row) =>
      `<tr><td><code>${markdownInline(row[0])}</code></td><td>${markdownInline(row[1])}</td><td>${markdownInline(row[2])}</td></tr>`
    ).join("")}</tbody></table></div>` : ""}
    ${section.bullets ? `<ul>${section.bullets.map((bullet) => `<li>${markdownInline(bullet)}</li>`).join("")}</ul>` : ""}
  </section>`).join("");
  const sourceUrl = `https://github.com/whahedev/orihon/blob/main/${item.source}#L${item.sourceLine}`;
  const content = `<article>
    <nav class="breadcrumbs"><a href="/examples/developer-guide/">Функции</a><span>/</span><a href="/examples/developer-guide/#${slug(item.group)}">${escapeHtml(item.group)}</a></nav>
    <header class="api-header">
      <div><p class="eyebrow">${escapeHtml(item.entry)}</p><h1><code>${escapeHtml(item.name)}()</code></h1><p class="lede">${escapeHtml(item.summary)}</p></div>
      <a class="source-link" href="${escapeAttr(sourceUrl)}" target="_blank" rel="noreferrer">Исходник · L${item.sourceLine}</a>
    </header>
    <section class="doc-section purpose"><h2>Для чего нужна</h2>${markdownBlocks(item.purpose)}</section>
    <section class="doc-section"><h2>Импорт</h2>${codeBlock(imported, "ts")}</section>
    <section class="doc-section"><h2>Сигнатура и результат</h2>${codeBlock(item.signature, "ts")}<p class="returns"><strong>Возвращает:</strong> <code>${escapeHtml(item.returnType)}</code> — ${escapeHtml(describeReturn(item.name, item.returnType))}</p></section>
    <section class="doc-section"><h2>Параметры</h2>${parameters}${optionTables}</section>
    <section class="doc-section playground-section" data-playground data-function="${escapeAttr(item.name)}">
      <div class="playground-heading"><div><h2>Пример</h2><p>Тот же код, что можно скопировать к себе, — и он же выполняется на карте справа. Здесь отбрасываются только строки <code>import</code>: всё остальное, включая создание карты, выполняется как есть, а вывод <code>console.log()</code> попадает в панель результата. Контейнер карты очищается перед каждым запуском, поэтому эксперименты не накапливают слои.</p></div><span>Локальная сборка v${escapeHtml(pkg.version)}</span></div>
      <div class="playground-shell">
        <div class="playground-editor">
          <div class="playground-toolbar"><span>JavaScript</span><div><button type="button" data-playground-reset>Сбросить</button><button class="run" type="button" data-playground-run>Выполнить</button></div></div>
          <textarea data-playground-code spellcheck="false" aria-label="Код примера ${escapeAttr(item.name)}">${escapeHtml(item.example)}</textarea>
          <p class="playground-status" data-playground-status>Ожидание карты…</p>
          <pre class="playground-result" data-playground-output aria-live="polite" hidden></pre>
        </div>
        <div class="playground-preview"><iframe data-playground-frame title="Карта для примера ${escapeAttr(item.name)}" sandbox="allow-scripts" src="/examples/developer-guide/playground.html"></iframe></div>
      </div>
    </section>
    ${item.note ? `<aside class="note"><strong>Важно</strong><div>${markdownBlocks(item.note)}</div></aside>` : ""}
    ${extra}
    <footer class="page-footer">
      ${previous ? `<a href="/examples/developer-guide/functions/${encodeURIComponent(previous.name)}/"><span>← Предыдущая</span><code>${escapeHtml(previous.name)}()</code></a>` : "<span></span>"}
      ${next ? `<a class="next" href="/examples/developer-guide/functions/${encodeURIComponent(next.name)}/"><span>Следующая →</span><code>${escapeHtml(next.name)}()</code></a>` : ""}
    </footer>
  </article>`;
  return shell({
    title: `${item.name}()`,
    description: item.summary,
    navigation,
    content,
    pageClass: "function-page",
    canonicalPath: `/examples/developer-guide/functions/${item.name}/`
  }).replace(/^[\t ]+$/gm, "");
}

function describeParameter(functionName, parameter) {
  const raw = parameter.name.replace(/^\.\.\./, "");
  const normalized = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
  const type = parameter.type;
  const exact = {
    "bounds.a": "Необязательная исходная область: одна координата, массив координат, пара противоположных углов, существующий LatLngBounds или объект { south, west, north, east }. Без значения создаётся пустая область для последующего extend().",
    "bounds.b": "Необязательный второй противоположный угол. Используется, когда первый аргумент — одна координата. Координаты именованные: \`{ lat, lng }\` или \`latLng(lat, lng)\`; голая пара чисел не принимается, потому что её не отличить от GeoJSON-позиции \`[lng, lat]\`.",
    "distance.a": "Начальная географическая координата измеряемого отрезка.",
    "distance.b": "Конечная географическая координата измеряемого отрезка.",
    "destination.origin": "Исходная географическая координата, от которой откладываются расстояние и азимут.",
    "destination.distanceMeters": "Расстояние от исходной точки в метрах; положительное значение движется по заданному азимуту.",
    "destination.bearingDegrees": "Азимут в градусах по часовой стрелке от севера: 0° — север, 90° — восток.",
    "lngLat.lng": "Долгота в градусах — первый аргумент, как в MapLibre и массивах координат GeoJSON.",
    "lngLat.lat": "Широта в градусах — второй аргумент.",
    "geodesicInterpolate.a": "Начальная координата геодезического отрезка.",
    "geodesicInterpolate.b": "Конечная координата геодезического отрезка.",
    "metersToPixels.meters": "Реальное расстояние в метрах, которое нужно перевести в пиксели.",
    "metersToPixels.latitude": "Широта в градусах; она нужна, потому что масштаб Web Mercator меняется от экватора к полюсам.",
    "zoomForBounds.viewSize": "Размер доступной области карты в CSS-пикселях: ширина и высота viewport.",
    "zoomForBounds.targetBounds": "Географическая область, которую требуется полностью поместить в viewport.",
    "zoomForBounds.padding": "Свободное место между областью и краями viewport в CSS-пикселях.",
    "zoomForBounds.maxZoom": "Верхняя граница возвращаемого zoom, даже если область помещается при большем увеличении.",
    "createMap.container": "HTML-элемент карты либо его строковый id. Контейнер должен иметь ненулевые ширину и высоту.",
    "circle.radius": "Объект с ровно одной единицей: { radiusMeters: число } для EPSG:3857 или { radiusMapUnits: число } для CRS.Simple. Радиус конечный, неотрицательный; несовместимая CRS вызывает ошибку.",
    "wmsTileLayer.url": "Базовый URL WMS endpoint без параметров GetMap; параметры запроса добавит слой.",
    "wmtsTileLayer.template": "URL-шаблон WMTS с placeholders матрицы, строки и столбца тайла.",
    "tileLayer.template": "URL или функция, формирующая адрес тайла. В строке обычно используются placeholders {z}, {x} и {y}.",
    "heatLayer.points": "Измерения поля: координата точки и её числовой вес/значение. Допускается обычный iterable.",
    "buildHeat.points": "Полный набор измерений, из которых будет рассчитана общая скалярная сетка.",
    "buildHeat.bounds": "Географический домен вычисления поля; значения сетки привязываются именно к этой области."
  };
  if (exact[`${functionName}.${raw}`]) return exact[`${functionName}.${raw}`];
  if (/^options?$/.test(raw)) return "Необязательные настройки поведения. Все поддерживаемые поля, их единицы и назначение перечислены в таблице ниже.";
  if (/LatLngBoundsLike|LatLngBounds/.test(type)) return "Географические границы: пара юго-западной и северо-восточной координат либо совместимый объект LatLngBounds.";
  if (/PointLike|\bPoint\b|Bounds/.test(type) && !/LatLng/.test(type)) return "Точка или область в пиксельной системе координат карты; это не широта и долгота.";
  if (/LatLngLike|\bLatLng\b/.test(type)) return "Именованная координата { lat, lng } или LatLng. GeoJSON-пары преобразуйте через fromGeoJSONPosition().";
  if (/TileTemplate/.test(type)) return "Шаблон адреса тайла или функция, возвращающая адрес по координатам z/x/y.";
  if (/HTMLElement|string/.test(type) && /container|host|element/.test(raw)) return "DOM-элемент либо его строковый id в документе.";
  if (/Iterable|Array|\[\]/.test(type) || /points?|items?|objects?|features?|data/.test(raw)) return "Исходная коллекция элементов указанного типа. Для Iterable элементы читаются в порядке обхода.";
  if (/^map$/.test(raw)) return "Экземпляр карты Orihon, с которым должна работать функция.";
  if (/^zoom$|Zoom$/.test(raw)) return "Уровень масштаба карты: большее значение означает более сильное приближение.";
  if (/url/i.test(raw)) return "URL сетевого или локального ресурса, используемого этой функцией.";
  if (/radius/i.test(raw)) return "Радиус влияния или отображения; точная единица указана назначением функции и полями options.";
  if (/padding|buffer|tolerance/i.test(raw)) return "Дополнительный запас вокруг геометрии или viewport в CSS-пикселях, если тип функции не задаёт другую единицу.";
  if (/opacity/i.test(raw)) return "Непрозрачность от 0 (полностью прозрачно) до 1 (полностью непрозрачно).";
  if (/color|fill|stroke/i.test(raw)) return "Цвет в любом CSS-формате, например #3388ff, rgb(...) или именованное значение.";
  if (/provider|fetcher|factory|renderer/i.test(raw)) return "Пользовательская функция или объект, реализующий указанный TypeScript-контракт и вызываемый библиотекой по мере необходимости.";
  if (/callback|format|filter|predicate/i.test(raw)) return "Пользовательская функция обратного вызова с сигнатурой, указанной в столбце «Тип».";
  if (/number/.test(type)) return `Числовое значение «${normalized}»; единица и допустимый диапазон следуют из назначения функции.`;
  if (/boolean/.test(type)) return `Включает или отключает поведение «${normalized}».`;
  if (/string/.test(type)) return `Строковое значение «${normalized}» в формате, указанном типом и назначением функции.`;
  return `Значение «${normalized}» типа ${type}.`;
}

function describeReturn(name, type) {
  const exact = {
    bounds: "объект LatLngBounds с южной, западной, северной и восточной границами; его можно передать в fitBounds или rectangle",
    pointBounds: "пиксельную область Bounds с min/max и вычисляемым размером",
    point: "объект Point с координатами x и y и методами векторной арифметики",
    latLng: "нормализованную географическую координату LatLng",
    lngLat: "географическую координату LatLng, созданную из порядка longitude, latitude",
    distance: "геодезическое расстояние в метрах",
    destination: "вычисленную географическую координату назначения",
    project: "мировую пиксельную точку Point на выбранном zoom",
    unproject: "географическую координату LatLng",
    scale: "размер мира Web Mercator в пикселях",
    metersToPixels: "эквивалентное расстояние в пикселях",
    zoomForBounds: "числовой уровень zoom, ограниченный переданным maxZoom"
  };
  if (exact[name]) return exact[name];
  if (/Promise/.test(type)) return "асинхронный результат; дождитесь его через await";
  if (/Layer|Marker|Overlay|Control|Manager/.test(type)) return "экземпляр API, который можно настроить и добавить на карту";
  if (/boolean/.test(type)) return "логический признак успешности или состояния";
  if (/void/.test(type)) return "функция выполняет действие и не возвращает отдельного значения";
  if (/\[\]|Array|Iterable/.test(type)) return "коллекция вычисленных или найденных элементов";
  return `значение типа ${type}, описанное в сигнатуре выше`;
}

function codeBlock(value, language) {
  return `<div class="code"><div class="code-bar"><span>${escapeHtml(language)}</span><button type="button" data-copy-code>Копировать</button></div><pre><code>${escapeHtml(cleanMarkdown(value))}</code></pre></div>`;
}

function markdownInline(value) {
  return escapeHtml(String(value)).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function markdownBlocks(value) {
  return String(value).split(/\n{2,}/).map((block) => `<p>${markdownInline(block)}</p>`).join("");
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-zа-я0-9]+/gi, "-").replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", " ");
}
