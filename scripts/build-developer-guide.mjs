import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const sourceEntry = join(root, "src", "index.ts");
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
  attributionControl: "Показывает на карте авторство и лицензии активных источников данных.",
  bounds: "Создаёт расширяемую географическую область по двум углам, массиву координат или существующему объекту границ.",
  buildHeat: "Вычисляет поле значений и изолинии без создания слоя карты — для предварительной обработки, анализа или собственного renderer.",
  circle: "Рисует географический круг с радиусом в метрах; его экранный размер меняется вместе с масштабом карты.",
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
  geodesicInterpolate: "Добавляет промежуточные точки вдоль дуги большого круга, чтобы длинная линия корректно следовала кривизне Земли.",
  geoJSON: "Создаёт отображаемый слой из GeoJSON Geometry, Feature или FeatureCollection.",
  geolocationControl: "Добавляет кнопку определения текущего положения пользователя и перемещения карты к найденной координате.",
  geometryWorkerPool: "Создаёт переиспользуемый пул Web Workers для подготовки больших массивов геометрии вне main thread.",
  heatLayer: "Показывает тепловую поверхность, изолинии или оба представления одного поля значений.",
  heatSupport: "Проверяет, доступны ли в текущем браузере ускоренные WASM- и WebGPU-backend теплового pipeline.",
  icon: "Описывает растровую иконку маркера: изображение, размер, anchor и дополнительные CSS-настройки.",
  imageOverlay: "Растягивает изображение по заданной географической области и синхронизирует его с картой.",
  latLng: "Нормализует поддерживаемый формат координаты в объект LatLng с широтой и долготой.",
  lngLat: "Создаёт LatLng из longitude-first координат MapLibre, GeoJSON и совместимых API.",
  layersControl: "Добавляет панель выбора одной базовой подложки и включения независимых overlay-слоёв.",
  marker: "Создаёт интерактивный DOM-маркер в географической точке с popup, tooltip и обработчиками событий.",
  markerShapeMetrics: "Возвращает размеры и точки привязки встроенной формы маркера для собственного layout или renderer.",
  metersToPixels: "Переводит реальное расстояние в экранные пиксели для заданной широты и масштаба Web Mercator.",
  objectManager: "Хранит, индексирует, фильтрует, кластеризует и отображает большие наборы разнородных объектов карты.",
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
  bounds: {
    signature: `function bounds(): LatLngBounds
function bounds(value: LatLngBoundsExpression): LatLngBounds
function bounds(a: LatLngExpression, b: LatLngExpression): LatLngBounds`,
    note: "Это географические границы. Для прямоугольника в экранных или мировых пикселях используйте `pointBounds()`.",
    example: `import { bounds, rectangle } from "orihon";

const deliveryArea = bounds([
  [55.55, 37.20],
  [55.95, 38.05],
  [55.72, 38.18]
]);

rectangle(deliveryArea).addTo(map);
map.fitBounds(deliveryArea, { padding: 30 });`
  },
  lngLat: {
    note: "Результат — обычный `LatLng`: функция меняет только порядок входных аргументов и не вводит второй тип координат.",
    example: `import { lngLat, marker } from "orihon";

// MapLibre и GeoJSON используют longitude, latitude.
const berlin = lngLat(13.405, 52.52);

marker(berlin).addTo(map);`
  },
  latLng: {
    signature: `function latLng(value: LatLngLike): LatLng
function latLng(latitude: number, longitude: number): LatLng`,
    note: "Числовые аргументы и массивы Orihon используют порядок `latitude, longitude`. Для данных с обратным порядком используйте `lngLat(longitude, latitude)`.",
    example: `import { latLng, marker } from "orihon";

const moscow = latLng(55.751244, 37.618423);

marker(moscow).addTo(map);`
  },
  heatLayer: {
    summary: "Создаёт единый интерактивный слой тепловой поверхности, изолиний или их комбинации.",
    example: `import { heatLayer } from "orihon";

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

heat.bindTooltip(({ feature }) =>
  feature.kind === "line"
    ? \`Изолиния: \${feature.fieldValue.toFixed(1)}\`
    : \`Зона: \${feature.lowerValue.toFixed(1)}–\${feature.upperValue?.toFixed(1) ?? "∞"}\`
);`,
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
    example: `import { buildHeat } from "orihon";

const result = await buildHeat(points, bounds, {
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
    example: `import { heatSupport } from "orihon";

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
    note: "Передайте `iconUrl` для растровой иконки. Передайте `content` (или не передавайте аргумент) для HTML/CSS-иконки; отдельная фабрика `divIcon()` больше не нужна."
  },
  searchProvider: {
    signature: `function searchProvider<T extends SearchResult>(source: T[], options?: SearchProviderOptions<T>): SearchProvider<T>
function searchProvider<T extends SearchResult>(source: SearchAdapter<T>, options?: { limit?: number }): SearchProvider<T>`,
    note: "Локальный массив получает встроенный поиск по тексту; адаптер позволяет подключить серверные search, geocode и reverse без второй фабрики."
  },
  objectManager: {
    signature: `function objectManager(options?: ObjectManagerOptions): ObjectManager
function objectManager(options: RemoteObjectManagerOptions): RemoteObjectManager
function objectManager(options: MarkerObjectManagerOptions): MarkerCollection`,
    returnType: "ObjectManager | RemoteObjectManager | MarkerCollection",
    note: "Одна фабрика покрывает обычные объекты, удалённый loader с отменой устаревших запросов и points-режим с DOM/SVG/WebGL/hybrid renderer. Для миллионов объектов используйте \`addAsync(..., { render:false })\`, затем \`prepareLayout()\`.",
    sections: [{
      title: "Единый язык стилей",
      rows: [
        ["Точка", "`fill`, `fillOpacity`, `size`", "`color` и `opacity` поддерживаются как совместимые aliases; fill-поля имеют приоритет."],
        ["Линия", "`line.stroke`, `strokeOpacity`, `strokeWidth`", "Старые line.color, opacity и width продолжают работать."],
        ["Полигон", "`polygon.fill`, `fillOpacity`, `stroke`, `strokeOpacity`, `strokeWidth`", "Совпадает с vocabulary обычных vector paths."]
      ]
    }],
    example: `import { objectManager } from "orihon";

const local = objectManager({ clusterize: true }).addTo(map);
await local.addAsync(objects, { render: false });
local.prepareLayout();

const remote = objectManager({
  loader: ({ bounds, zoom, signal }) => loadObjects(bounds, zoom, signal),
  debounceMs: 120
}).addTo(map);

const accessiblePoints = objectManager({
  points,
  renderer: "svg",
  htmlButtonLimit: 500
}).addTo(map);`
  },
  webglPointLayer: {
    note: "Для крупных iterable/async-iterable используйте \`setDataAsync()\`: слой готовит приватные packed buffers и атомарно заменяет активный GPU snapshot только после успешного импорта."
  },
  tileLayer: {
    summary: "Создаёт растровую подложку и выбирает DOM, WebGL или WebGPU без отдельной GPU-фабрики.",
    example: `import { tileLayer } from "orihon";

const basemap = tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  renderer: "auto",
  cacheSize: 256,
  maxRequests: 16,
  maxNewPerFrame: 12,
  maxDpr: 2,
  attribution: "© OpenStreetMap contributors"
}).addTo(map);

console.log(basemap.getStats?.());`,
    note: "В Advanced entry \`renderer:'auto'\` выбирает WebGPU, затем WebGL и DOM fallback. Явные GPU renderer сохраняют общий cache/request/prefetch/zoom-backstop pipeline.",
    sections: [{
      title: "Выбор backend",
      rows: [
        ["renderer", "\`auto\` · \`dom\` · \`webgpu\` · \`webgl\`", "Auto выбирает лучший доступный renderer; явное значение задаёт предпочтительный путь с безопасным fallback."],
        ["cacheSize", "\`number\`", "Максимальное число тайлов в общем WTinyLFU-кэше."],
        ["maxRequests", "\`number\`", "Ограничивает параллельные запросы изображений."],
        ["maxNewPerFrame", "\`number\`", "Ограничивает создание новых записей за кадр, защищая main thread."],
        ["getStats()", "\`GPUTileLayerStats\`", "Показывает фактический renderer, покрытие, очередь, кэш и приблизительную GPU-память."]
      ]
    }]
  },
  geoJSON: {
    note: "Координаты GeoJSON всегда имеют порядок [longitude, latitude]. Для больших источников используйте асинхронную загрузку и \`renderer:'auto' | 'webgl'\`."
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
    note: "\`mode:'uniform'\` использует instanced WebGL для общего стиля. \`mode:'feature'\` сохраняет индивидуальные width/color/dash/gradient, picking и Canvas fallback."
  },
  webglPolygonBatch: {
    summary: "Триангулирует и рисует пакет полигонов через WebGL."
  },
  textLayer: {
    summary: "Размещает текст в географической точке как лёгкий слой с управлением стилем и видимостью."
  }
};

const explicitExamples = {
  wmtsTileLayer: `import { wmtsTileLayer } from "orihon";

wmtsTileLayer("https://example.test/wmts", {
  layer: "basemap",
  tileMatrixSet: "EPSG:3857",
  format: "image/png"
}).addTo(map);`,
  createWMTSFromCapabilities: `import { createWMTSFromCapabilities, wmtsTileLayer } from "orihon";

const xml = await fetch("/wmts?SERVICE=WMTS&REQUEST=GetCapabilities").then(r => r.text());
const config = createWMTSFromCapabilities(xml);
wmtsTileLayer(config.template, config.options).addTo(map);`,
  webglSymbolLayer: `import { webglSymbolLayer } from "orihon";

webglSymbolLayer({ atlas: imageBitmap })
  .setData(symbols)
  .addTo(map);`,
  textLayer: `import { textLayer } from "orihon";

textLayer([55.751, 37.618], "Москва", {
  color: "#0f172a",
  font: "600 14px system-ui"
}).addTo(map);`,
  preparePointBatchAsync: `import { preparePointBatchAsync, webglPointLayer } from "orihon";

const packed = await preparePointBatchAsync(points, {
  chunkSize: 20_000,
  yieldMode: "task"
});
webglPointLayer().setPackedData(packed).addTo(map);`
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
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name &&
          declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        return declaration;
      }
    }
  }
  return null;
}

function toRecord(name, declaration, source, sourcePath) {
  const line = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
  const functionNode = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
  const parameters = functionNode.parameters.map((parameter) => {
    const rawName = parameter.name.getText(source);
    const parameterType = checker.getTypeAtLocation(parameter);
    return {
      name: rawName,
      type: typeText(parameterType, parameter),
      required: !parameter.questionToken && !parameter.initializer && !parameter.dotDotDotToken,
      default: parameter.initializer?.getText(source) ?? "",
      description: documentationFor(parameter.name),
      properties: expandParameterProperties(parameter, parameterType)
    };
  });
  const typeParameters = functionNode.typeParameters?.length
    ? `<${functionNode.typeParameters.map((item) => item.getText(source)).join(", ")}>`
    : "";
  const asyncPrefix = functionNode.modifiers?.some((item) => item.kind === ts.SyntaxKind.AsyncKeyword) ? "async " : "";
  const paramsText = functionNode.parameters.map((item) => item.getText(source)).join(", ");
  const signatureObject = checker.getSignatureFromDeclaration(functionNode);
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
    options: "Объект настроек функции; его поля перечислены в таблице ниже.",
    mode: "Режим результата или визуализации. Для heat: heatmap, isolines либо оба слоя из одного поля.",
    backend: "Вычислительный backend: auto выбирает доступное ускорение, wasm фиксирует WASM, webgpu — WebGPU.",
    evaluation: "Стратегия поля: static считает весь набор один раз, zoom уточняет поле после изменения масштаба.",
    worker: "Выполняет тяжёлую подготовку вне main thread, если Worker доступен.",
    labels: "Показывает подписи значений на изолиниях.",
    step: "Абсолютный интервал между соседними изолиниями либо auto для адаптивного шага.",
    bands: "Заливает диапазоны значений между соседними изолиниями.",
    cover: "Продолжает нижнюю зону до границы вычислительного домена, включая нулевые значения.",
    gradient: "Соответствие нормализованных значений цветам тепловой поверхности.",
    opacity: "Общая непрозрачность слоя в диапазоне от 0 до 1.",
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
    center: "Начальный центр карты в географических координатах [широта, долгота].",
    zoomSnap: "Шаг округления zoom; 1 разрешает только целые уровни, 0 отключает округление.",
    wheelZoomStep: "Изменение zoom за один нормализованный шаг колеса или trackpad.",
    maxBounds: "Географическая область, за пределы которой пользователю нельзя переместить центр карты; null снимает ограничение.",
    maxBoundsViscosity: "Сопротивление выходу за maxBounds от 0 до 1; 1 полностью удерживает карту внутри области.",
    inertia: "Включает продолжение движения карты после отпускания указателя.",
    inertiaDeceleration: "Замедление инерционного перемещения в CSS-пикселях за секунду в квадрате.",
    inertiaMaxSpeed: "Максимальная скорость инерционного перемещения в CSS-пикселях в секунду.",
    zoomAnimationDuration: "Продолжительность программной анимации zoom в миллисекундах.",
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
    cameraRedrawInterval: "Минимальный интервал между точными GPU-перерисовками во время движения карты, в миллисекундах.",
    cameraSettleDelay: "Задержка финальной точной перерисовки после остановки камеры, в миллисекундах.",
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

function groupFor(path, name) {
  const p = path.replaceAll("\\", "/");
  const computationFunctions = new Set([
    "bounds", "clampLat", "destination", "distance", "geodesicInterpolate",
    "latLng", "lngLat", "metersToPixels", "point", "pointBounds", "project", "scale",
    "unproject", "wrapLng", "zoomForBounds", "buildHeat", "createWMTSFromCapabilities",
    "decodeMVT", "markerShapeMetrics",
    "preparePointBatch", "preparePointBatchAsync"
  ]);
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
  const core = new Set(["createMap", "tileLayer", "point", "pointBounds", "latLng", "lngLat", "bounds", "project", "unproject", "distance", "destination", "geodesicInterpolate", "metersToPixels", "clampLat", "wrapLng", "scale", "zoomForBounds"]);
  const standard = new Set(["featureGroup", "wmsTileLayer", "wmtsTileLayer", "createWMTSFromCapabilities", "marker", "markerShapeMetrics", "icon", "textLayer", "polyline", "polygon", "rectangle", "circle", "circleMarker", "geoJSON", "popup", "tooltip", "imageOverlay", "videoOverlay", "svgOverlay", "sanitizeSvgElement", "zoomControl", "scaleControl", "geolocationControl", "attributionControl", "layersControl", "customControl", "resolveLocale", "ensureLocalePacks", "registerLocalePacks"]);
  if (core.has(name)) return "orihon/core";
  if (standard.has(name)) return "orihon/standard";
  return "orihon";
}

function fallbackSummary(record) {
  if (/^(create|build|decode|prepare|query|register|ensure|sanitize|resolve|pack)/.test(record.name)) {
    return `Выполняет операцию \`${record.name}\` текущего публичного API Orihon.`;
  }
  return `Создаёт или вычисляет \`${record.name}\` с типизированными параметрами Orihon.`;
}

function detailedPurpose(record, group, override, imported) {
  const summary = override.summary || clearSummaries[record.name] || imported.summary || record.sourceDescription || fallbackSummary(record);
  const groupContext = groupDescriptions[group];
  const usage = override.note || imported.note || purposeHint(record, group, groupContext);
  return `${summary}\n\n${usage}`;
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
const functions = exportedFunctionRecords(sourceEntry)
  .filter((record, index, all) => !obsolete.has(record.name) && all.findIndex((item) => item.name === record.name) === index)
  .map((record) => {
    const group = groupFor(record.sourcePath, record.name);
    const entry = entryFor(group, record.name);
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
      example: override.example || explicitExamples[record.name] || imported.example || autoExample(record, entry),
      playground: playgroundExamples[record.name] || generatedPlayground(record),
      note: override.note || imported.note || "",
      sections: override.sections || [],
      confluenceUrl: imported.confluenceUrl || null,
      source: relative(root, record.sourcePath).replaceAll("\\", "/")
    };
  })
  .sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || a.name.localeCompare(b.name));

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
  generatedAt: new Date().toISOString(),
  source: "src/index.ts",
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
  <title>${escapeHtml(title)} · Orihon Developer Guide</title>
  <link rel="icon" href="/assets/brand/svg/orihon-favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/examples/developer-guide/assets/guide.css" />
</head>
<body class="${escapeAttr(pageClass)}" data-canonical-path="${escapeAttr(canonicalPath)}">
  <header class="topbar">
    <a class="brand" href="/examples/developer-guide/" aria-label="Orihon Developer Guide">
      <img src="/assets/brand/svg/orihon-logo-horizontal.svg" alt="Orihon" />
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
    <nav aria-label="Функции Orihon">${navigation}</nav>
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
    return `<section class="api-group" id="${slug(group)}">
      <div class="group-heading"><div><p class="eyebrow">Раздел</p><h2>${escapeHtml(group)}</h2></div><span>${groupItems.length}</span></div>
      <p class="group-description">${escapeHtml(groupDescriptions[group])}</p>
      <div class="api-grid">${groupItems.map((item) => `<a class="api-card" href="./functions/${encodeURIComponent(item.name)}/">
        <code>${escapeHtml(item.name)}()</code>
        <p>${escapeHtml(item.summary)}</p>
        <span>${escapeHtml(item.entry)} →</span>
      </a>`).join("")}</div>
    </section>`;
  }).join("");
  const content = `<section class="hero">
    <p class="eyebrow">orihon@${escapeHtml(pkg.version)} · актуальный src/index.ts</p>
    <h1>Руководство разработчика</h1>
    <p><strong>ORIHON — Offers Responsive Interactions, Handles Overlays Natively.</strong></p>
    <p>Одна публичная функция — одна отдельная страница. Сигнатуры и список функций берутся из текущего TypeScript API; описания перенесены из Confluence и обновлены для действующей архитектуры.</p>
    <div class="hero-badges"><span>${items.length} функций</span><span>${groupOrder.length} разделов</span><span>Core · Standard · Advanced</span></div>
  </section>
  <aside class="callout">
    <strong>Package tier ≠ сложность API.</strong>
    Core, Standard и Advanced отвечают за состав и gzip budget. Easy, Layer API и Rendering API отвечают за уровень управления.
    <code>orihon/easy</code> работает поверх Standard: единый декларативный <code>map.add({ type, ... })</code> подходит для React/Vue/Svelte, а автодополнение <code>map.add…</code> показывает специализированные методы для маркеров, линий, полигонов, GeoJSON и тайлов. Возвращаемые значения остаются обычными объектами Orihon. Для готового слоя доступны оба равнозначных стиля: <code>map.add(layer)</code> и <code>layer.addTo(map)</code>.
  </aside>
  <aside class="callout">
    <strong>Heat API обновлён.</strong>
    Старые <code>webglHeatLayer</code>, <code>heatIsolineLayer</code> и <code>buildHeatIsolines</code> исключены. Используйте
    <a href="./functions/heatLayer/"><code>heatLayer()</code></a>,
    <a href="./functions/buildHeat/"><code>buildHeat()</code></a> и
    <a href="./functions/heatSupport/"><code>heatSupport()</code></a>.
  </aside>
  ${groups}`;
  return shell({
    title: "Все функции",
    description: "Локальное руководство разработчика по публичным функциям Orihon",
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
    <section class="doc-section"><h2>Пример</h2>${codeBlock(item.example, "ts")}</section>
    <section class="doc-section playground-section" data-playground data-function="${escapeAttr(item.name)}">
      <div class="playground-heading"><div><h2>Интерактивный пример</h2><p>Измените код слева и запустите его. Карта справа создаётся заново перед каждым запуском, поэтому эксперименты не накапливают слои.</p></div><span>Локальная сборка v${escapeHtml(pkg.version)}</span></div>
      <div class="playground-shell">
        <div class="playground-editor">
          <div class="playground-toolbar"><span>JavaScript</span><div><button type="button" data-playground-reset>Сбросить</button><button class="run" type="button" data-playground-run>Выполнить</button></div></div>
          <textarea data-playground-code spellcheck="false" aria-label="Код примера ${escapeAttr(item.name)}">${escapeHtml(item.playground)}</textarea>
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
  });
}

function describeParameter(functionName, parameter) {
  const raw = parameter.name.replace(/^\.\.\./, "");
  const normalized = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
  const type = parameter.type;
  const exact = {
    "bounds.a": "Необязательная исходная область: одна координата, массив координат, пара противоположных углов, существующий LatLngBounds или объект { south, west, north, east }. Без значения создаётся пустая область для последующего extend().",
    "bounds.b": "Необязательный второй противоположный угол. Используется, когда первый аргумент — одна координата; порядок массива — [широта, долгота].",
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
  if (/LatLngLike|\bLatLng\b/.test(type)) return "Географическая координата. Массив Orihon имеет порядок [широта, долгота]; также принимается совместимый объект LatLng.";
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
