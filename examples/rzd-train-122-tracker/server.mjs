import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  searchTrainRuns,
  searchRouteRuns,
  suggestStations,
  resolveTrainRun,
  getRunById,
  buildRoute as buildTrainRoute,
  listActiveRuns,
  triggerActiveIndexRefresh,
  providerStatus as trainProviderStatus
} from "./train-catalog.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8788);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_PATH = path.join(
  __dirname,
  "rail-route-cache.json"
);

const CACHE_VERSION = 5;
const CORRIDOR_RADIUS_METERS = 28000;
const OVERPASS_TIMEOUT_SECONDS = 180;
const FETCH_TIMEOUT_MS = 210000;
const SNAP_RADIUS_KM = 12;
const SNAP_CANDIDATES = 12;
const SIMPLIFY_TOLERANCE_METERS = 14;
const OSM_ROUTE_RELATION_ID = 17137928;
const OSM_RELATION_URL =
  `https://api.openstreetmap.org/api/0.6/relation/${OSM_ROUTE_RELATION_ID}/full.json`;
const RELATION_DUMP_PATH = path.join(
  __dirname,
  `_rel${OSM_ROUTE_RELATION_ID}.json`
);


const RZD_ACTUAL_REFRESH_MS = 60_000;
const RZD_ACTUAL_TIMEOUT_MS = 18_000;
const RZD_TRAIN_NUMBERS = ["121В", "122В"];
const RZD_ACTUAL_FIXTURE = process.env.RZD_ACTUAL_FIXTURE || "";
const RZD_ACTUAL_URL_TEMPLATE = process.env.RZD_ACTUAL_URL || "";
const RZD_ACTUAL_DISABLED = process.env.RZD_ACTUAL_DISABLED === "1";

const RZD_ACTUAL_ROUTE = {
  src: "САНКТ-ПЕТЕРБУРГ-ГЛАВН.",
  srcCode: "2004000",
  dst: "НОВОРОССИЙСК",
  dstCode: "2064110"
};

const rzdActualCache = new Map();

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

const STOPS = [
  {
    "name": "Санкт-Петербург (Московский вокзал)",
    "lat": 59.9296,
    "lon": 30.3626,
    "arr": null,
    "dep": 0
  },
  {
    "name": "Большая Вишера",
    "lat": 58.9098909,
    "lon": 32.0903823,
    "arr": 120,
    "dep": 138
  },
  {
    "name": "Малая Вишера",
    "lat": 58.8462,
    "lon": 32.222,
    "arr": 149,
    "dep": 150
  },
  {
    "name": "Окуловка",
    "lat": 58.3718363,
    "lon": 33.3006415,
    "arr": 201,
    "dep": 224
  },
  {
    "name": "Бологое-Московское",
    "lat": 57.8799,
    "lon": 34.0539,
    "arr": 268,
    "dep": 280
  },
  {
    "name": "Вышний Волочёк",
    "lat": 57.5913,
    "lon": 34.5603,
    "arr": 312,
    "dep": 313
  },
  {
    "name": "Тверь",
    "lat": 56.8351256,
    "lon": 35.8925742,
    "arr": 402,
    "dep": 404
  },
  {
    "name": "Решетниково",
    "lat": 56.4508,
    "lon": 36.5667,
    "arr": 443,
    "dep": 456
  },
  {
    "name": "Поварово-1",
    "lat": 56.0747,
    "lon": 37.0517,
    "arr": 493,
    "dep": 513
  },
  {
    "name": "Лихоборы (техническая)",
    "lat": 55.8458,
    "lon": 37.565,
    "arr": 552,
    "dep": 664
  },
  {
    "name": "Москва (Восточный вокзал)",
    "lat": 55.8002,
    "lon": 37.7465,
    "arr": 680,
    "dep": 695
  },
  {
    "name": "Тарусская",
    "lat": 54.7350904,
    "lon": 37.4006319,
    "arr": 810,
    "dep": 812
  },
  {
    "name": "Тула (Московский вокзал)",
    "lat": 54.199,
    "lon": 37.5773,
    "arr": 864,
    "dep": 894
  },
  {
    "name": "Узловая-1",
    "lat": 53.9751378,
    "lon": 38.1740009,
    "arr": 977,
    "dep": 981
  },
  {
    "name": "Ефремов",
    "lat": 53.149,
    "lon": 38.1168,
    "arr": 1081,
    "dep": 1083
  },
  {
    "name": "Елец",
    "lat": 52.6057335,
    "lon": 38.5257324,
    "arr": 1170,
    "dep": 1201
  },
  {
    "name": "Липецк",
    "lat": 52.6237439,
    "lon": 39.5680112,
    "arr": 1284,
    "dep": 1303
  },
  {
    "name": "Отрожка",
    "lat": 51.694,
    "lon": 39.265,
    "arr": 1459,
    "dep": 1475
  },
  {
    "name": "Придача (Воронеж-Южный)",
    "lat": 51.6401693,
    "lon": 39.2588102,
    "arr": 1491,
    "dep": 1496
  },
  {
    "name": "Лиски",
    "lat": 50.9822,
    "lon": 39.4995,
    "arr": 1578,
    "dep": 1583
  },
  {
    "name": "Россошь",
    "lat": 50.1838143,
    "lon": 39.6025441,
    "arr": 1684,
    "dep": 1699
  },
  {
    "name": "Митрофановка",
    "lat": 49.97,
    "lon": 39.69,
    "arr": 1727,
    "dep": 1752
  },
  {
    "name": "Кутейниково",
    "lat": 49.4230617,
    "lon": 40.4162241,
    "arr": 1835,
    "dep": 1837
  },
  {
    "name": "Миллерово",
    "lat": 48.9226,
    "lon": 40.3986,
    "arr": 1886,
    "dep": 1888
  },
  {
    "name": "Каменская",
    "lat": 48.3292201,
    "lon": 40.2586171,
    "arr": 1940,
    "dep": 1942
  },
  {
    "name": "Лихая",
    "lat": 48.1524,
    "lon": 40.1886,
    "arr": 1965,
    "dep": 1982
  },
  {
    "name": "Зверево",
    "lat": 48.021,
    "lon": 40.122,
    "arr": 2007,
    "dep": 2009
  },
  {
    "name": "Шахтная",
    "lat": 47.7271732,
    "lon": 40.1981405,
    "arr": 2062,
    "dep": 2064
  },
  {
    "name": "Каменоломни",
    "lat": 47.6647878,
    "lon": 40.1941149,
    "arr": 2076,
    "dep": 2106
  },
  {
    "name": "Ростов-Главный",
    "lat": 47.2221,
    "lon": 39.6914,
    "arr": 2181,
    "dep": 2202
  },
  {
    "name": "Староминская-Тимашевская",
    "lat": 46.5048852,
    "lon": 39.0812671,
    "arr": 2287,
    "dep": 2289
  },
  {
    "name": "Каневская",
    "lat": 46.0868809,
    "lon": 38.9415534,
    "arr": 2328,
    "dep": 2330
  },
  {
    "name": "Брюховецкая",
    "lat": 45.7978036,
    "lon": 38.987661,
    "arr": 2359,
    "dep": 2361
  },
  {
    "name": "Тимашевская-1",
    "lat": 45.6296612,
    "lon": 38.9401494,
    "arr": 2387,
    "dep": 2397
  },
  {
    "name": "Протока",
    "lat": 45.2334961,
    "lon": 38.1452966,
    "arr": 2481,
    "dep": 2483
  },
  {
    "name": "Крымская",
    "lat": 44.9124533,
    "lon": 38.0039441,
    "arr": 2531,
    "dep": 2535
  },
  {
    "name": "Тоннельная",
    "lat": 44.8374415,
    "lon": 37.6545856,
    "arr": 2568,
    "dep": 2583
  },
  {
    "name": "Новороссийск",
    "lat": 44.735788,
    "lon": 37.772521,
    "arr": 2613,
    "dep": null
  }
];

let buildPromise = null;
let railStatus = {
  state: "idle",
  message: "Маршрут ещё не строился",
  startedAt: null,
  finishedAt: null
};

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function sendText(
  res,
  status,
  text,
  contentType = "text/plain; charset=utf-8"
) {
  const body = Buffer.from(text, "utf8");

  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const toRad = Math.PI / 180;

  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const dPhi = (lat2 - lat1) * toRad;
  const dLambda = (lon2 - lon1) * toRad;

  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) *
    Math.cos(phi2) *
    Math.sin(dLambda / 2) ** 2;

  return 2 * R * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(1 - a)
  );
}

function wayWeightFactor(tags = {}) {
  let factor = 1;

  if (tags.service) {
    factor *= 4.5;
  }

  if (tags.usage === "branch") {
    factor *= 1.18;
  }

  if (
    tags.usage === "industrial" ||
    tags.usage === "military" ||
    tags.usage === "tourism"
  ) {
    factor *= 3.0;
  }

  if (tags["railway:traffic_mode"] === "freight") {
    factor *= 1.8;
  }

  return factor;
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const a = this.items;
    a.push(item);

    let i = a.length - 1;

    while (i > 0) {
      const p = Math.floor((i - 1) / 2);

      if (a[p].priority <= item.priority) {
        break;
      }

      a[i] = a[p];
      i = p;
    }

    a[i] = item;
  }

  pop() {
    const a = this.items;

    if (a.length === 0) {
      return null;
    }

    const root = a[0];
    const last = a.pop();

    if (a.length === 0) {
      return root;
    }

    let i = 0;

    while (true) {
      let left = i * 2 + 1;
      let right = left + 1;

      if (left >= a.length) {
        break;
      }

      let smallest = left;

      if (
        right < a.length &&
        a[right].priority < a[left].priority
      ) {
        smallest = right;
      }

      if (
        a[smallest].priority >= last.priority
      ) {
        break;
      }

      a[i] = a[smallest];
      i = smallest;
    }

    a[i] = last;

    return root;
  }
}

function overpassQuery(points) {
  const line =
    points
      .map(
        (p) =>
          `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`
      )
      .join(",");

  return (
    `[out:json][timeout:${OVERPASS_TIMEOUT_SECONDS}];` +
    `way["railway"="rail"]` +
    `(around:${CORRIDOR_RADIUS_METERS},${line});` +
    `(._;>;);` +
    `out body;`
  );
}

async function fetchOverpass(query) {
  const failures = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        FETCH_TIMEOUT_MS
      );

    try {
      console.log(
        `[Overpass] POST ${endpoint}`
      );

      const response =
        await fetch(
          endpoint,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded;charset=UTF-8",
              "Accept":
                "application/json",
              "User-Agent":
                "Orihon-RZD-Rail-Router/1.0"
            },
            body:
              "data=" +
              encodeURIComponent(query),
            signal:
              controller.signal
          }
        );

      const text =
        await response.text();

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} · ` +
          text.replace(/\s+/g, " ").slice(0, 300)
        );
      }

      const payload =
        JSON.parse(text);

      if (
        !payload ||
        !Array.isArray(payload.elements)
      ) {
        throw new Error(
          "Некорректный JSON Overpass"
        );
      }

      return {
        endpoint,
        payload
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      failures.push(
        `${endpoint}: ${message}`
      );

      console.error(
        `[Overpass] ${message}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    failures.join(" | ")
  );
}

function makeChunks() {
  const chunks = [];
  const step = 5;
  const width = 7;

  for (
    let start = 0;
    start < STOPS.length - 1;
    start += step
  ) {
    const from =
      Math.max(0, start - 1);

    const to =
      Math.min(
        STOPS.length,
        start + width
      );

    chunks.push(
      STOPS.slice(from, to)
    );

    if (to === STOPS.length) {
      break;
    }
  }

  return chunks;
}

async function downloadRailCorridor() {
  const elements = new Map();
  const endpointsUsed = new Set();

  const chunks =
    makeChunks();

  for (
    let i = 0;
    i < chunks.length;
    i++
  ) {
    railStatus.message =
      `Overpass: участок ${i + 1}/${chunks.length}`;

    const result =
      await fetchOverpass(
        overpassQuery(
          chunks[i]
        )
      );

    endpointsUsed.add(
      result.endpoint
    );

    for (
      const element of
      result.payload.elements
    ) {
      elements.set(
        `${element.type}/${element.id}`,
        element
      );
    }

    console.log(
      `[Overpass] chunk ${i + 1}/${chunks.length} · ` +
      `${result.payload.elements.length} elements · ` +
      `${elements.size} unique`
    );
  }

  return {
    elements:
      Array.from(elements.values()),
    endpointsUsed:
      Array.from(endpointsUsed)
  };
}

function buildGraph(elements) {
  const nodes = new Map();
  const ways = [];

  for (const element of elements) {
    if (
      element.type === "node" &&
      Number.isFinite(element.lat) &&
      Number.isFinite(element.lon)
    ) {
      nodes.set(
        element.id,
        {
          id: element.id,
          lat: element.lat,
          lon: element.lon
        }
      );
    }

    if (
      element.type === "way" &&
      Array.isArray(element.nodes) &&
      element.tags?.railway === "rail"
    ) {
      ways.push(element);
    }
  }

  const graph = new Map();
  const nodeMainness = new Map();

  function addEdge(from, edge) {
    if (!graph.has(from)) {
      graph.set(from, []);
    }

    graph.get(from).push(edge);
  }

  for (const way of ways) {
    const factor =
      wayWeightFactor(
        way.tags
      );

    for (
      let i = 1;
      i < way.nodes.length;
      i++
    ) {
      const aId =
        way.nodes[i - 1];

      const bId =
        way.nodes[i];

      const a =
        nodes.get(aId);

      const b =
        nodes.get(bId);

      if (!a || !b) {
        continue;
      }

      const km =
        haversineKm(
          a.lat,
          a.lon,
          b.lat,
          b.lon
        );

      if (
        !Number.isFinite(km) ||
        km <= 0
      ) {
        continue;
      }

      const cost =
        km * factor;

      addEdge(
        aId,
        {
          to: bId,
          km,
          cost,
          wayId: way.id,
          factor
        }
      );

      addEdge(
        bId,
        {
          to: aId,
          km,
          cost,
          wayId: way.id,
          factor
        }
      );

      const currentA =
        nodeMainness.get(aId) ?? Infinity;

      const currentB =
        nodeMainness.get(bId) ?? Infinity;

      nodeMainness.set(
        aId,
        Math.min(currentA, factor)
      );

      nodeMainness.set(
        bId,
        Math.min(currentB, factor)
      );
    }
  }

  return {
    nodes,
    graph,
    ways,
    nodeMainness
  };
}

function nearestCandidates(
  stop,
  nodes,
  graph,
  nodeMainness,
  limit = SNAP_CANDIDATES,
  maxRadiusKm = SNAP_RADIUS_KM
) {
  const candidates = [];

  for (
    const [id, node] of nodes
  ) {
    if (!graph.has(id)) {
      continue;
    }

    const snapKm =
      haversineKm(
        stop.lat,
        stop.lon,
        node.lat,
        node.lon
      );

    if (snapKm > maxRadiusKm) {
      continue;
    }

    const mainness =
      nodeMainness.get(id) ?? 2;

    const score =
      snapKm *
      (1 + Math.max(0, mainness - 1) * 0.25);

    candidates.push({
      id,
      snapKm,
      score
    });
  }

  candidates.sort(
    (a, b) =>
      a.score - b.score
  );

  return candidates.slice(
    0,
    limit
  );
}

function reconstructPath(
  previous,
  targetId
) {
  const path = [];
  let current = targetId;

  while (
    current !== undefined &&
    current !== null
  ) {
    path.push(current);
    current =
      previous.get(current);
  }

  path.reverse();
  return path;
}

function routeSegment(
  fromStop,
  toStop,
  startCandidates,
  targetCandidates,
  nodes,
  graph
) {
  if (
    startCandidates.length === 0 ||
    targetCandidates.length === 0
  ) {
    throw new Error(
      `Не удалось привязать станцию к railway=rail: ` +
      `${fromStop.name} → ${toStop.name}`
    );
  }

  const targetMap =
    new Map(
      targetCandidates.map(
        (candidate) => [
          candidate.id,
          candidate
        ]
      )
    );

  const distances =
    new Map();

  const previous =
    new Map();

  const heap =
    new MinHeap();

  for (
    const candidate of
    startCandidates
  ) {
    const startCost =
      candidate.snapKm * 2.0;

    const node =
      nodes.get(candidate.id);

    const heuristic =
      haversineKm(
        node.lat,
        node.lon,
        toStop.lat,
        toStop.lon
      );

    if (
      startCost <
      (distances.get(candidate.id) ?? Infinity)
    ) {
      distances.set(
        candidate.id,
        startCost
      );

      heap.push({
        id: candidate.id,
        g: startCost,
        priority:
          startCost + heuristic
      });
    }
  }

  let bestTarget = null;
  let bestTotal = Infinity;
  let visited = 0;

  while (heap.size > 0) {
    const current =
      heap.pop();

    const known =
      distances.get(current.id);

    if (
      known === undefined ||
      Math.abs(known - current.g) > 1e-9
    ) {
      continue;
    }

    if (
      current.priority >= bestTotal
    ) {
      break;
    }

    visited += 1;

    if (visited > 900000) {
      throw new Error(
        `Слишком большой поиск графа: ` +
        `${fromStop.name} → ${toStop.name}`
      );
    }

    const target =
      targetMap.get(current.id);

    if (target) {
      const total =
        current.g +
        target.snapKm * 2.0;

      if (total < bestTotal) {
        bestTotal = total;
        bestTarget = current.id;
      }

      continue;
    }

    const edges =
      graph.get(current.id) || [];

    for (const edge of edges) {
      const tentative =
        current.g + edge.cost;

      if (
        tentative >=
        (distances.get(edge.to) ?? Infinity)
      ) {
        continue;
      }

      distances.set(
        edge.to,
        tentative
      );

      previous.set(
        edge.to,
        current.id
      );

      const node =
        nodes.get(edge.to);

      const heuristic =
        haversineKm(
          node.lat,
          node.lon,
          toStop.lat,
          toStop.lon
        );

      heap.push({
        id: edge.to,
        g: tentative,
        priority:
          tentative + heuristic
      });
    }
  }

  if (bestTarget === null) {
    throw new Error(
      `В OSM-графе не найден связный путь: ` +
      `${fromStop.name} → ${toStop.name}`
    );
  }

  const ids =
    reconstructPath(
      previous,
      bestTarget
    );

  if (ids.length < 2) {
    throw new Error(
      `Слишком короткий OSM-путь: ` +
      `${fromStop.name} → ${toStop.name}`
    );
  }

  return {
    ids,
    endNodeId: bestTarget,
    visited
  };
}

function pointLineDistanceMeters(
  point,
  a,
  b
) {
  const lat0 =
    point.lat * Math.PI / 180;

  const kx =
    111320 * Math.cos(lat0);

  const ky =
    110540;

  const px =
    point.lon * kx;

  const py =
    point.lat * ky;

  const ax =
    a.lon * kx;

  const ay =
    a.lat * ky;

  const bx =
    b.lon * kx;

  const by =
    b.lat * ky;

  const dx = bx - ax;
  const dy = by - ay;

  const len2 =
    dx * dx + dy * dy;

  if (len2 <= 1e-12) {
    return Math.hypot(
      px - ax,
      py - ay
    );
  }

  const t =
    Math.max(
      0,
      Math.min(
        1,
        (
          (px - ax) * dx +
          (py - ay) * dy
        ) / len2
      )
    );

  const x =
    ax + dx * t;

  const y =
    ay + dy * t;

  return Math.hypot(
    px - x,
    py - y
  );
}

function simplifyRdp(
  points,
  toleranceMeters
) {
  if (points.length <= 2) {
    return points.slice();
  }

  const keep =
    new Uint8Array(
      points.length
    );

  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [
    [0, points.length - 1]
  ];

  while (stack.length) {
    const [start, end] =
      stack.pop();

    let bestIndex = -1;
    let bestDistance = 0;

    for (
      let i = start + 1;
      i < end;
      i++
    ) {
      const distance =
        pointLineDistanceMeters(
          points[i],
          points[start],
          points[end]
        );

      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    if (
      bestIndex >= 0 &&
      bestDistance >
      toleranceMeters
    ) {
      keep[bestIndex] = 1;

      stack.push(
        [start, bestIndex],
        [bestIndex, end]
      );
    }
  }

  const result = [];

  for (
    let i = 0;
    i < points.length;
    i++
  ) {
    if (keep[i]) {
      result.push(points[i]);
    }
  }

  return result;
}

function geometryDistanceKm(points) {
  let km = 0;

  for (
    let i = 1;
    i < points.length;
    i++
  ) {
    km += haversineKm(
      points[i - 1].lat,
      points[i - 1].lon,
      points[i].lat,
      points[i].lon
    );
  }

  return km;
}

async function fetchOsmRouteRelation() {
  try {
    const text = await fs.readFile(RELATION_DUMP_PATH, "utf8");
    const payload = JSON.parse(text);

    if (Array.isArray(payload?.elements) && payload.elements.length > 100) {
      console.log(
        `[Relation] using local dump ${path.basename(RELATION_DUMP_PATH)}`
      );
      return {
        payload,
        endpoint: "file://" + RELATION_DUMP_PATH
      };
    }
  } catch {
    // download below
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    FETCH_TIMEOUT_MS
  );

  try {
    console.log(`[Relation] GET ${OSM_RELATION_URL}`);

    const response = await fetch(OSM_RELATION_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Orihon-RZD-Rail-Router/1.1"
      },
      signal: controller.signal
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} · ${text.replace(/\s+/g, " ").slice(0, 300)}`
      );
    }

    const payload = JSON.parse(text);

    if (!Array.isArray(payload?.elements)) {
      throw new Error("Некорректный JSON OSM relation");
    }

    await fs.writeFile(RELATION_DUMP_PATH, text, "utf8");

    return {
      payload,
      endpoint: "https://api.openstreetmap.org"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function chainRelationWays(data) {
  const nodes = new Map();
  const ways = new Map();

  for (const element of data.elements) {
    if (
      element.type === "node" &&
      Number.isFinite(element.lat) &&
      Number.isFinite(element.lon)
    ) {
      nodes.set(element.id, {
        id: element.id,
        lat: element.lat,
        lon: element.lon
      });
    }

    if (element.type === "way" && Array.isArray(element.nodes)) {
      ways.set(element.id, element);
    }
  }

  const rel = data.elements.find(
    (element) =>
      element.type === "relation" &&
      element.id === OSM_ROUTE_RELATION_ID
  );

  if (!rel) {
    throw new Error(
      `OSM relation ${OSM_ROUTE_RELATION_ID} не найдена`
    );
  }

  const wayMembers = rel.members.filter(
    (member) => member.type === "way"
  );

  function wayPoints(way) {
    return way.nodes
      .map((id) => nodes.get(id))
      .filter(Boolean);
  }

  const first = wayPoints(ways.get(wayMembers[0].ref));

  if (first.length < 2) {
    throw new Error("У первого way relation нет геометрии");
  }

  const chain = first.slice();
  let flips = 0;
  let gaps = 0;

  for (let i = 1; i < wayMembers.length; i++) {
    const way = ways.get(wayMembers[i].ref);

    if (!way) {
      continue;
    }

    const pts = wayPoints(way);

    if (pts.length < 2) {
      continue;
    }

    const last = chain[chain.length - 1];
    const dStart = haversineKm(
      last.lat,
      last.lon,
      pts[0].lat,
      pts[0].lon
    );
    const dEnd = haversineKm(
      last.lat,
      last.lon,
      pts[pts.length - 1].lat,
      pts[pts.length - 1].lon
    );

    let ordered = pts;

    if (dEnd < dStart) {
      ordered = pts.slice().reverse();
      flips += 1;
    }

    const join = haversineKm(
      last.lat,
      last.lon,
      ordered[0].lat,
      ordered[0].lon
    );

    if (join > 0.05) {
      gaps += 1;
    }

    const start = join < 1e-4 ? 1 : 0;

    for (let j = start; j < ordered.length; j++) {
      chain.push(ordered[j]);
    }
  }

  return {
    chain,
    flips,
    gaps,
    tags: rel.tags || {},
    wayCount: wayMembers.length
  };
}

function nearestOnChain(
  chain,
  lat,
  lon,
  minIdx,
  maxIdx = chain.length - 1
) {
  let best = {
    idx: minIdx,
    dist: Infinity
  };

  for (let i = minIdx; i <= maxIdx; i++) {
    const dist = haversineKm(
      lat,
      lon,
      chain[i].lat,
      chain[i].lon
    );

    if (dist < best.dist) {
      best = {
        idx: i,
        dist
      };
    }
  }

  return best;
}

function snapStopsToRelation(chain, stops) {
  const candidates = stops.map((stop) => {
    const best = nearestOnChain(
      chain,
      stop.lat,
      stop.lon,
      0
    );

    const near = [];

    for (let i = 0; i < chain.length; i++) {
      const dist = haversineKm(
        stop.lat,
        stop.lon,
        chain[i].lat,
        chain[i].lon
      );

      if (dist <= Math.max(8, best.dist + 2)) {
        near.push({
          idx: i,
          dist
        });
      }
    }

    if (!near.length) {
      near.push(best);
    }

    near.sort((a, b) => a.idx - b.idx);
    return near;
  });

  const n = stops.length;
  const dp = Array.from(
    { length: n },
    () => new Map()
  );

  for (const cand of candidates[0]) {
    dp[0].set(cand.idx, {
      cost: cand.dist,
      prev: -1
    });
  }

  for (let i = 1; i < n; i++) {
    for (const cand of candidates[i]) {
      let bestPrev = null;

      for (const [prevIdx, prevState] of dp[i - 1]) {
        if (prevIdx > cand.idx) {
          continue;
        }

        const cost = prevState.cost + cand.dist;

        if (!bestPrev || cost < bestPrev.cost) {
          bestPrev = {
            cost,
            prev: prevIdx
          };
        }
      }

      if (!bestPrev) {
        let fallback = null;

        for (const [prevIdx, prevState] of dp[i - 1]) {
          const cost =
            prevState.cost +
            cand.dist +
            (prevIdx - cand.idx) * 50;

          if (!fallback || cost < fallback.cost) {
            fallback = {
              cost,
              prev: prevIdx,
              forcedIdx: prevIdx
            };
          }
        }

        bestPrev = fallback;
      }

      if (!bestPrev) {
        continue;
      }

      const useIdx = bestPrev.forcedIdx ?? cand.idx;
      const existing = dp[i].get(useIdx);

      if (!existing || bestPrev.cost < existing.cost) {
        dp[i].set(useIdx, bestPrev);
      }
    }
  }

  let endIdx = null;
  let endState = null;

  for (const [idx, state] of dp[n - 1]) {
    if (!endState || state.cost < endState.cost) {
      endIdx = idx;
      endState = state;
    }
  }

  if (endIdx == null) {
    throw new Error(
      "Не удалось привязать станции к geometry relation"
    );
  }

  const chosenIdx = new Array(n);
  chosenIdx[n - 1] = endIdx;

  for (let i = n - 1; i > 0; i--) {
    chosenIdx[i - 1] = dp[i].get(chosenIdx[i]).prev;
  }

  for (let i = 1; i < n; i++) {
    if (chosenIdx[i] <= chosenIdx[i - 1]) {
      chosenIdx[i] = Math.min(
        chain.length - 1 - (n - 1 - i),
        chosenIdx[i - 1] + 1
      );
    }
  }

  for (let i = n - 2; i >= 0; i--) {
    if (chosenIdx[i] >= chosenIdx[i + 1]) {
      chosenIdx[i] = Math.max(
        i,
        chosenIdx[i + 1] - 1
      );
    }
  }

  return chosenIdx.map((idx, i) => {
    const point = chain[idx];

    return {
      stationIndex: i,
      name: stops[i].name,
      nodeId: point.id,
      lat: point.lat,
      lon: point.lon,
      snapKm: Number(
        haversineKm(
          stops[i].lat,
          stops[i].lon,
          point.lat,
          point.lon
        ).toFixed(3)
      ),
      idx
    };
  });
}

function assembleRouteResult({
  anchors,
  chain,
  source,
  tags,
  wayCount
}) {
  const segments = [];
  let totalDistanceKm = 0;
  let totalRawNodes = 0;

  for (let i = 0; i < STOPS.length - 1; i++) {
    const fromIdx = anchors[i].idx;
    const toIdx = anchors[i + 1].idx;

    if (toIdx <= fromIdx) {
      throw new Error(
        `Non-monotonic snap: ${STOPS[i].name} → ${STOPS[i + 1].name}`
      );
    }

    const rawPoints = chain.slice(fromIdx, toIdx + 1);
    const simplified = simplifyRdp(
      rawPoints,
      SIMPLIFY_TOLERANCE_METERS
    );
    const segmentKm = geometryDistanceKm(rawPoints);

    totalDistanceKm += segmentKm;
    totalRawNodes += rawPoints.length;

    segments.push({
      fromIndex: i,
      toIndex: i + 1,
      from: STOPS[i].name,
      to: STOPS[i + 1].name,
      distanceKm: Number(segmentKm.toFixed(3)),
      rawNodeCount: rawPoints.length,
      simplifiedPointCount: simplified.length,
      coordinates: simplified.map(
        (point) => [point.lon, point.lat]
      )
    });
  }

  const routeCoordinates = [];

  for (const segment of segments) {
    for (const coordinate of segment.coordinates) {
      const last =
        routeCoordinates[routeCoordinates.length - 1];

      if (
        last &&
        Math.abs(last[0] - coordinate[0]) < 1e-10 &&
        Math.abs(last[1] - coordinate[1]) < 1e-10
      ) {
        continue;
      }

      routeCoordinates.push(coordinate);
    }
  }

  const publicAnchors = anchors.map(
    ({ stationIndex, name, nodeId, lat, lon, snapKm }) => ({
      stationIndex,
      name,
      nodeId,
      lat,
      lon,
      snapKm
    })
  );

  return {
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    cache: false,
    source: {
      data:
        `OpenStreetMap route relation ${OSM_ROUTE_RELATION_ID}`,
      query: OSM_RELATION_URL,
      attribution:
        "© OpenStreetMap contributors, ODbL",
      relationId: OSM_ROUTE_RELATION_ID,
      relationName: tags.name || null,
      endpointsUsed: [source]
    },
    params: {
      simplifyToleranceMeters:
        SIMPLIFY_TOLERANCE_METERS
    },
    anchors: publicAnchors,
    segments,
    route: {
      type: "Feature",
      properties: {
        train: "121В/122В",
        from: STOPS[0].name,
        to: STOPS[STOPS.length - 1].name
      },
      geometry: {
        type: "LineString",
        coordinates: routeCoordinates
      }
    },
    stats: {
      stopCount: STOPS.length,
      segmentCount: segments.length,
      totalDistanceKm: Number(
        totalDistanceKm.toFixed(2)
      ),
      routePoints: routeCoordinates.length,
      rawRouteNodes: totalRawNodes,
      relationWays: wayCount,
      maxSnapKm: Number(
        Math.max(
          ...publicAnchors.map((a) => a.snapKm)
        ).toFixed(3)
      )
    }
  };
}

async function buildRailRouteFromRelation() {
  railStatus = {
    state: "building",
    message:
      `Загружаю OSM relation ${OSM_ROUTE_RELATION_ID} (поезд 121В)`,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };

  const { payload, endpoint } =
    await fetchOsmRouteRelation();

  railStatus.message =
    "Собираю geometry маршрута 121В по relation";

  const {
    chain,
    flips,
    gaps,
    tags,
    wayCount
  } = chainRelationWays(payload);

  console.log(
    `[Relation] chain ${chain.length} pts · ` +
    `${geometryDistanceKm(chain).toFixed(1)} km · ` +
    `flips=${flips} gaps>50m=${gaps}`
  );

  const anchors = snapStopsToRelation(chain, STOPS);
  const result = assembleRouteResult({
    anchors,
    chain,
    source: endpoint,
    tags,
    wayCount
  });

  await fs.writeFile(
    CACHE_PATH,
    JSON.stringify(result),
    "utf8"
  );

  railStatus = {
    state: "ready",
    message:
      `OSM-маршрут готов: ${result.stats.totalDistanceKm} км по relation`,
    startedAt: railStatus.startedAt,
    finishedAt: new Date().toISOString()
  };

  return result;
}

async function buildRailRoute() {
  try {
    return await buildRailRouteFromRelation();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      `[Relation] fallback to Overpass corridor: ${message}`
    );

    railStatus.message =
      "Relation недоступна, строю corridor railway=rail…";

    return buildRailRouteFromCorridor();
  }
}

async function buildRailRouteFromCorridor() {
  railStatus = {
    state: "building",
    message: "Загружаю OSM railway=rail",
    startedAt:
      railStatus.startedAt ||
      new Date().toISOString(),
    finishedAt: null
  };

  const corridor =
    await downloadRailCorridor();

  railStatus.message =
    "Строю железнодорожный граф";

  const {
    nodes,
    graph,
    ways,
    nodeMainness
  } =
    buildGraph(
      corridor.elements
    );

  if (
    graph.size < 100
  ) {
    throw new Error(
      `Overpass вернул слишком мало связных railway=rail nodes: ${graph.size}`
    );
  }

  console.log(
    `[Graph] ${nodes.size} nodes · ` +
    `${ways.length} rail ways · ` +
    `${graph.size} connected nodes`
  );

  const allCandidates =
    STOPS.map(
      (stop) =>
        nearestCandidates(
          stop,
          nodes,
          graph,
          nodeMainness
        )
    );

  for (
    let i = 0;
    i < allCandidates.length;
    i++
  ) {
    if (
      allCandidates[i].length === 0
    ) {
      throw new Error(
        `Не найден railway=rail рядом со станцией ${STOPS[i].name}`
      );
    }
  }

  const segments = [];
  const anchors = new Array(
    STOPS.length
  );

  let startCandidates =
    allCandidates[0];

  let totalDistanceKm = 0;
  let totalRawNodes = 0;
  let totalVisited = 0;

  for (
    let i = 0;
    i < STOPS.length - 1;
    i++
  ) {
    railStatus.message =
      `Маршрутизация ${i + 1}/${STOPS.length - 1}: ` +
      `${STOPS[i].name} → ${STOPS[i + 1].name}`;

    const routed =
      routeSegment(
        STOPS[i],
        STOPS[i + 1],
        startCandidates,
        allCandidates[i + 1],
        nodes,
        graph
      );

    const rawPoints =
      routed.ids.map(
        (id) => nodes.get(id)
      );

    const simplified =
      simplifyRdp(
        rawPoints,
        SIMPLIFY_TOLERANCE_METERS
      );

    const segmentKm =
      geometryDistanceKm(
        rawPoints
      );

    totalDistanceKm +=
      segmentKm;

    totalRawNodes +=
      rawPoints.length;

    totalVisited +=
      routed.visited;

    const startNode =
      rawPoints[0];

    const endNode =
      rawPoints[
        rawPoints.length - 1
      ];

    if (i === 0) {
      anchors[0] = {
        stationIndex: 0,
        name: STOPS[0].name,
        nodeId: startNode.id,
        lat: startNode.lat,
        lon: startNode.lon,
        snapKm:
          haversineKm(
            STOPS[0].lat,
            STOPS[0].lon,
            startNode.lat,
            startNode.lon
          )
      };
    }

    anchors[i + 1] = {
      stationIndex: i + 1,
      name: STOPS[i + 1].name,
      nodeId: endNode.id,
      lat: endNode.lat,
      lon: endNode.lon,
      snapKm:
        haversineKm(
          STOPS[i + 1].lat,
          STOPS[i + 1].lon,
          endNode.lat,
          endNode.lon
        )
    };

    segments.push({
      fromIndex: i,
      toIndex: i + 1,
      from: STOPS[i].name,
      to: STOPS[i + 1].name,
      distanceKm:
        Number(
          segmentKm.toFixed(3)
        ),
      rawNodeCount:
        rawPoints.length,
      simplifiedPointCount:
        simplified.length,
      coordinates:
        simplified.map(
          (point) => [
            point.lon,
            point.lat
          ]
        )
    });

    console.log(
      `[Route] ${i + 1}/${STOPS.length - 1} ` +
      `${STOPS[i].name} → ${STOPS[i + 1].name} · ` +
      `${segmentKm.toFixed(1)} km · ` +
      `${rawPoints.length} → ${simplified.length} points`
    );

    /*
     * The next route starts exactly on the graph node selected by
     * the previous segment. This keeps all segments topologically
     * continuous through the station.
     */
    startCandidates = [
      {
        id: routed.endNodeId,
        snapKm: 0,
        score: 0
      }
    ];
  }

  const routeCoordinates = [];

  for (const segment of segments) {
    for (
      const coordinate of
      segment.coordinates
    ) {
      const last =
        routeCoordinates[
          routeCoordinates.length - 1
        ];

      if (
        last &&
        Math.abs(last[0] - coordinate[0]) < 1e-10 &&
        Math.abs(last[1] - coordinate[1]) < 1e-10
      ) {
        continue;
      }

      routeCoordinates.push(
        coordinate
      );
    }
  }

  const result = {
    version: CACHE_VERSION,
    generatedAt:
      new Date().toISOString(),
    cache: false,
    source: {
      data:
        "OpenStreetMap railway=rail",
      query:
        "Overpass API around route corridor",
      attribution:
        "© OpenStreetMap contributors, ODbL",
      endpointsUsed:
        corridor.endpointsUsed
    },
    params: {
      corridorRadiusMeters:
        CORRIDOR_RADIUS_METERS,
      snapRadiusKm:
        SNAP_RADIUS_KM,
      simplifyToleranceMeters:
        SIMPLIFY_TOLERANCE_METERS
    },
    anchors,
    segments,
    route: {
      type: "Feature",
      properties: {
        train:
          "121В/122В",
        from:
          STOPS[0].name,
        to:
          STOPS[
            STOPS.length - 1
          ].name
      },
      geometry: {
        type: "LineString",
        coordinates:
          routeCoordinates
      }
    },
    stats: {
      stopCount:
        STOPS.length,
      segmentCount:
        segments.length,
      totalDistanceKm:
        Number(
          totalDistanceKm.toFixed(2)
        ),
      routePoints:
        routeCoordinates.length,
      rawRouteNodes:
        totalRawNodes,
      overpassElements:
        corridor.elements.length,
      graphNodes:
        graph.size,
      graphWays:
        ways.length,
      aStarVisited:
        totalVisited
    }
  };

  await fs.writeFile(
    CACHE_PATH,
    JSON.stringify(result),
    "utf8"
  );

  railStatus = {
    state: "ready",
    message:
      `OSM-маршрут готов: ${result.stats.totalDistanceKm} км`,
    startedAt:
      railStatus.startedAt,
    finishedAt:
      new Date().toISOString()
  };

  return result;
}

async function readCache() {
  try {
    const text =
      await fs.readFile(
        CACHE_PATH,
        "utf8"
      );

    const data =
      JSON.parse(text);

    if (
      data?.version !== CACHE_VERSION ||
      !Array.isArray(data.segments) ||
      data.segments.length !==
        STOPS.length - 1
    ) {
      return null;
    }

    return {
      ...data,
      cache: true
    };
  } catch {
    return null;
  }
}

async function getRailRoute(
  force = false
) {
  if (!force) {
    const cached =
      await readCache();

    if (cached) {
      railStatus = {
        state: "ready",
        message:
          `OSM-маршрут из кэша: ${cached.stats?.totalDistanceKm ?? "?"} км`,
        startedAt: null,
        finishedAt:
          new Date().toISOString()
      };

      return cached;
    }
  }

  if (!buildPromise) {
    buildPromise =
      buildRailRoute()
        .catch((error) => {
          railStatus = {
            state: "error",
            message:
              error instanceof Error
                ? error.message
                : String(error),
            startedAt:
              railStatus.startedAt,
            finishedAt:
              new Date().toISOString()
          };

          throw error;
        })
        .finally(() => {
          buildPromise = null;
        });
  }

  return buildPromise;
}


function normalizeStationName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/санкт[-\s]?петербург(?:-главн(?:ый|ая)?\.?)?/g, "санкт петербург")
    .replace(/московск(?:ий|ого)\s+вокзал/g, "")
    .replace(/восточн(?:ый|ого)\s+вокзал/g, "восточный")
    .replace(/воронеж[-\s]?южн(?:ый|ая)?/g, "придача")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RZD_STOP_ALIASES = new Map([
  [0, ["санкт петербург", "санкт петербург главн", "с петербург главн", "санкт петербург московский"]],
  [9, ["лихоборы", "лихоборы техническая"]],
  [10, ["москва восточный", "москва восточная", "восточный вокзал"]],
  [18, ["придача", "воронеж южный", "воронеж южн"]],
  [30, ["староминская тимашевская", "староминская тимашевск"]],
  [33, ["тимашевская 1", "тимашевская"]]
]);

function stationAliases(index) {
  const aliases = [STOPS[index]?.name, ...(RZD_STOP_ALIASES.get(index) || [])]
    .filter(Boolean)
    .map(normalizeStationName)
    .filter(Boolean);
  return Array.from(new Set(aliases));
}

function stationIndexForName(value) {
  const needle = normalizeStationName(value);
  if (!needle) return -1;

  let bestIndex = -1;
  let bestScore = 0;

  for (let i = 0; i < STOPS.length; i++) {
    for (const alias of stationAliases(i)) {
      if (needle === alias) return i;

      let score = 0;
      if (needle.includes(alias) || alias.includes(needle)) {
        score = Math.min(needle.length, alias.length) / Math.max(needle.length, alias.length);
      } else {
        const a = new Set(alias.split(" ").filter((x) => x.length > 2));
        const b = new Set(needle.split(" ").filter((x) => x.length > 2));
        const common = [...a].filter((x) => b.has(x)).length;
        score = common / Math.max(1, Math.max(a.size, b.size));
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
  }

  return bestScore >= 0.56 ? bestIndex : -1;
}

function moscowScheduledMs(serviceDate, stopIndex, event = "arrival") {
  const stop = STOPS[stopIndex];
  if (!stop) return NaN;

  const offset = event === "departure"
    ? (stop.dep ?? stop.arr)
    : (stop.arr ?? stop.dep);

  if (!Number.isFinite(offset)) return NaN;
  return Date.parse(`${serviceDate}T15:57:00+03:00`) + offset * 60_000;
}

function moscowClock(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(ms));
}

function closestMoscowClockMs(clock, scheduledMs) {
  if (!clock || !Number.isFinite(scheduledMs)) return NaN;
  const match = String(clock).match(/(?:^|\D)([0-2]?\d):([0-5]\d)(?:\D|$)/);
  if (!match) return NaN;

  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23) return NaN;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(scheduledMs));

  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const base = Date.parse(`${map.year}-${map.month}-${map.day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+03:00`);

  const candidates = [base - 86_400_000, base, base + 86_400_000];
  candidates.sort((a, b) => Math.abs(a - scheduledMs) - Math.abs(b - scheduledMs));
  return candidates[0];
}

function parseDelayValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);

  const text = String(value).toLowerCase().replace(/−/g, "-").replace(/\u00a0/g, " ");
  if (/по\s*график|без\s*опоздан/.test(text)) return 0;

  let m = text.match(/([+-]?\d{1,4})\s*(?:мин|minute)/i);
  if (m) return Number(m[1]);

  m = text.match(/(?:опозд|позже|задерж)[^\d-+]{0,20}([+-]?\d{1,4})/i);
  if (m) return Math.abs(Number(m[1]));

  m = text.match(/(?:раньше|опереж)[^\d-+]{0,20}([+-]?\d{1,4})/i);
  if (m) return -Math.abs(Number(m[1]));

  return null;
}

function keyMatches(key, words) {
  const normalized = String(key || "").toLowerCase().replace(/[^a-zа-я0-9]/gi, "");
  return words.some((word) => normalized.includes(word));
}

function firstObjectValue(obj, predicate) {
  for (const [key, value] of Object.entries(obj || {})) {
    if (predicate(key, value)) return value;
  }
  return undefined;
}

function observationFromObject(obj, serviceDate) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const stationValue = firstObjectValue(obj, (key, value) =>
    typeof value === "string" && keyMatches(key, ["station", "stop", "stname", "name", "title", "point"])
  );

  const stationIndex = stationIndexForName(stationValue);
  if (stationIndex < 0) return null;

  const actualArrival = firstObjectValue(obj, (key) =>
    keyMatches(key, ["factarr", "actualarr", "arrivalfact", "arrfact", "factarrival", "factprib", "actualprib"])
  );
  const actualDeparture = firstObjectValue(obj, (key) =>
    keyMatches(key, ["factdep", "actualdep", "departurefact", "depfact", "factdeparture", "factotpr", "actualotpr"])
  );
  const genericActual = firstObjectValue(obj, (key) =>
    keyMatches(key, ["facttime", "actualtime", "fact", "actual"])
  );
  const directDelay = firstObjectValue(obj, (key) =>
    keyMatches(key, ["delay", "deviation", "lateness", "opozd", "otklon"])
  );

  let event = actualArrival !== undefined ? "arrival" : actualDeparture !== undefined ? "departure" : "arrival";
  let actualValue = actualArrival ?? actualDeparture ?? genericActual;
  const scheduledMs = moscowScheduledMs(serviceDate, stationIndex, event);
  let delayMinutes = parseDelayValue(directDelay);
  let actualMs = NaN;

  if (actualValue !== undefined && actualValue !== null) {
    if (typeof actualValue === "number") {
      const numeric = actualValue > 1e12 ? actualValue : actualValue > 1e9 ? actualValue * 1000 : NaN;
      if (Number.isFinite(numeric)) actualMs = numeric;
    } else {
      const parsed = Date.parse(String(actualValue));
      if (Number.isFinite(parsed) && /\d{4}[-/.]\d{1,2}/.test(String(actualValue))) {
        actualMs = parsed;
      } else {
        actualMs = closestMoscowClockMs(String(actualValue), scheduledMs);
      }
    }
  }

  if (delayMinutes === null && Number.isFinite(actualMs) && Number.isFinite(scheduledMs)) {
    delayMinutes = Math.round((actualMs - scheduledMs) / 60_000);
  }

  if (delayMinutes === null) return null;
  if (!Number.isFinite(actualMs) && Number.isFinite(scheduledMs)) {
    actualMs = scheduledMs + delayMinutes * 60_000;
  }

  return {
    stationIndex,
    stationName: STOPS[stationIndex].name,
    event,
    actualMs: Number.isFinite(actualMs) ? actualMs : null,
    actualTimeMsk: Number.isFinite(actualMs) ? moscowClock(actualMs) : null,
    scheduledMs: Number.isFinite(scheduledMs) ? scheduledMs : null,
    scheduledTimeMsk: Number.isFinite(scheduledMs) ? moscowClock(scheduledMs) : null,
    delayMinutes: Math.round(delayMinutes)
  };
}

function walkJsonForObservations(value, serviceDate, out, seen = new Set(), depth = 0) {
  if (value === null || value === undefined || depth > 14) return;
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (!Array.isArray(value)) {
    const observation = observationFromObject(value, serviceDate);
    if (observation) out.push(observation);
  }

  const values = Array.isArray(value) ? value : Object.values(value);
  for (const child of values) {
    if (child && typeof child === "object") {
      walkJsonForObservations(child, serviceDate, out, seen, depth + 1);
    }
  }
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>|<\/div>|<\/li>|<\/p>|<\/td>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&ndash;|&minus;|&#8722;/gi, "-")
    .replace(/&laquo;|&raquo;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function observationsFromText(text, serviceDate) {
  const normalizedText = String(text || "").replace(/\u00a0/g, " ");
  const lower = normalizeStationName(normalizedText);
  const observations = [];

  for (let i = 0; i < STOPS.length; i++) {
    const aliases = stationAliases(i).sort((a, b) => b.length - a.length);
    let rawPos = -1;

    for (const alias of aliases) {
      const needleTokens = alias.split(" ").filter(Boolean);
      if (!needleTokens.length) continue;
      const firstToken = needleTokens[0];
      const pos = normalizedText.toLowerCase().indexOf(firstToken.toLowerCase());
      if (pos >= 0) {
        rawPos = pos;
        break;
      }
    }

    if (rawPos < 0) continue;
    const chunk = normalizedText.slice(Math.max(0, rawPos - 180), rawPos + 650);
    const delay = parseDelayValue(chunk);
    if (delay === null) continue;

    const scheduledMs = moscowScheduledMs(serviceDate, i, "arrival");
    const timeMatches = [...chunk.matchAll(/(?:факт\w*|приб\w*|прослед\w*)[^0-9]{0,40}([0-2]?\d:[0-5]\d)/gi)];
    const clock = timeMatches.length ? timeMatches[timeMatches.length - 1][1] : null;
    let actualMs = clock ? closestMoscowClockMs(clock, scheduledMs) : NaN;
    if (!Number.isFinite(actualMs) && Number.isFinite(scheduledMs)) {
      actualMs = scheduledMs + delay * 60_000;
    }

    observations.push({
      stationIndex: i,
      stationName: STOPS[i].name,
      event: "arrival",
      actualMs: Number.isFinite(actualMs) ? actualMs : null,
      actualTimeMsk: Number.isFinite(actualMs) ? moscowClock(actualMs) : null,
      scheduledMs: Number.isFinite(scheduledMs) ? scheduledMs : null,
      scheduledTimeMsk: Number.isFinite(scheduledMs) ? moscowClock(scheduledMs) : null,
      delayMinutes: Math.round(delay)
    });
  }

  return observations;
}

function dedupeObservations(observations) {
  const best = new Map();

  for (const item of observations) {
    if (!item || !Number.isInteger(item.stationIndex) || !Number.isFinite(item.delayMinutes)) continue;
    const key = `${item.stationIndex}:${item.event || "arrival"}`;
    const prev = best.get(key);
    if (!prev || (item.actualMs || 0) >= (prev.actualMs || 0)) best.set(key, item);
  }

  return [...best.values()].sort((a, b) => a.stationIndex - b.stationIndex || (a.actualMs || 0) - (b.actualMs || 0));
}


function stationIndexMentionedInText(value) {
  const text = normalizeStationName(value);
  if (!text) return -1;

  let bestIndex = -1;
  let bestLength = 0;

  for (let i = 0; i < STOPS.length; i++) {
    for (const alias of stationAliases(i)) {
      if (
        alias.length >= 4 &&
        text.includes(alias) &&
        alias.length > bestLength
      ) {
        bestIndex = i;
        bestLength = alias.length;
      }
    }
  }

  return bestIndex;
}

function clockTokens(text) {
  return [...String(text || "").matchAll(/(?:^|\D)([0-2]?\d:[0-5]\d)(?=\D|$)/g)]
    .map((match) => ({
      clock: match[1].padStart(5, "0"),
      index: match.index ?? 0
    }))
    .filter((item) => Number(item.clock.slice(0, 2)) <= 23);
}

function observationForClock(serviceDate, stationIndex, event, clock) {
  const scheduledMs = moscowScheduledMs(serviceDate, stationIndex, event);
  const actualMs = closestMoscowClockMs(clock, scheduledMs);

  if (!Number.isFinite(scheduledMs) || !Number.isFinite(actualMs)) {
    return null;
  }

  const delayMinutes = Math.round(
    (actualMs - scheduledMs) / 60_000
  );

  if (Math.abs(delayMinutes) > 24 * 60) {
    return null;
  }

  return {
    stationIndex,
    stationName: STOPS[stationIndex].name,
    event,
    actualMs,
    actualTimeMsk: moscowClock(actualMs),
    scheduledMs,
    scheduledTimeMsk: moscowClock(scheduledMs),
    delayMinutes
  };
}

function observationsFromExplicitStatusText(text, serviceDate) {
  const source = String(text || "").replace(/\u00a0/g, " ");
  const observations = [];

  for (let i = 0; i < STOPS.length; i++) {
    const aliases = stationAliases(i).sort((a, b) => b.length - a.length);
    const normalized = normalizeStationName(source);

    let normalizedPos = -1;
    let chosenAlias = "";

    for (const alias of aliases) {
      const pos = normalized.indexOf(alias);
      if (pos >= 0) {
        normalizedPos = pos;
        chosenAlias = alias;
        break;
      }
    }

    if (normalizedPos < 0) continue;

    // Search the raw text by one of the significant station tokens.  The
    // normalized string cannot be used as a direct character offset because
    // punctuation and whitespace are removed by normalizeStationName().
    const significant =
      chosenAlias
        .split(" ")
        .filter((token) => token.length >= 4)
        .sort((a, b) => b.length - a.length)[0] || "";

    const rawPos = significant
      ? source.toLowerCase().indexOf(significant.toLowerCase())
      : -1;

    if (rawPos < 0) continue;

    const chunk = source.slice(
      Math.max(0, rawPos - 220),
      rawPos + 900
    );

    const explicitStatus =
      /проследовал|проследовала|проследован|фактич|факт\.?|прибыл|прибыла|отправился|отправилась|опозд|задерж|раньше|опереж|по\s+графику/i.test(chunk);

    if (!explicitStatus) continue;

    const delay = parseDelayValue(chunk);

    if (delay !== null) {
      const scheduledMs =
        moscowScheduledMs(serviceDate, i, "arrival");

      let actualMs = NaN;

      const factTimeMatch = chunk.match(
        /(?:фактич\w*|факт\.?|проследовал\w*|прибыл\w*|отправил\w*)[^0-9]{0,80}([0-2]?\d:[0-5]\d)/i
      );

      if (factTimeMatch) {
        actualMs = closestMoscowClockMs(
          factTimeMatch[1],
          scheduledMs
        );
      }

      if (!Number.isFinite(actualMs) && Number.isFinite(scheduledMs)) {
        actualMs = scheduledMs + delay * 60_000;
      }

      observations.push({
        stationIndex: i,
        stationName: STOPS[i].name,
        event: "arrival",
        actualMs: Number.isFinite(actualMs) ? actualMs : null,
        actualTimeMsk: Number.isFinite(actualMs) ? moscowClock(actualMs) : null,
        scheduledMs: Number.isFinite(scheduledMs) ? scheduledMs : null,
        scheduledTimeMsk: Number.isFinite(scheduledMs) ? moscowClock(scheduledMs) : null,
        delayMinutes: Math.round(delay)
      });

      continue;
    }

    /*
     * New/legacy RZD pages sometimes say "Поезд проследовал станцию ..."
     * and show an actual clock without a textual "+N мин".  In that case the
     * deviation is derived from the schedule we already have.
     */
    const statusTime =
      chunk.match(
        /(?:проследовал\w*|фактич\w*|факт\.?|прибыл\w*|отправил\w*)[^0-9]{0,100}([0-2]?\d:[0-5]\d)/i
      );

    if (statusTime) {
      const event =
        /отправил/i.test(statusTime[0])
          ? "departure"
          : "arrival";

      const observation =
        observationForClock(
          serviceDate,
          i,
          event,
          statusTime[1]
        );

      if (observation) {
        observations.push(observation);
      }
    }
  }

  return observations;
}

function observationsFromHtmlRows(html, serviceDate) {
  const observations = [];
  const source = String(html || "");

  /*
   * The actual movement service has historically rendered a normal HTML
   * table.  Parsing per row is substantially safer than searching the whole
   * document because schedule and factual clocks otherwise get mixed.
   */
  const rows = [
    ...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)
  ];

  for (const match of rows) {
    const rowText = htmlToText(match[1]);
    if (!rowText) continue;

    const stationIndex =
      stationIndexMentionedInText(rowText);

    if (stationIndex < 0) continue;

    const explicitActual =
      /фактич|факт\.?|проследовал|прибыл|отправился|опозд|задерж|раньше|опереж|по\s+графику/i.test(rowText);

    const directDelay =
      parseDelayValue(rowText);

    if (directDelay !== null && explicitActual) {
      const event =
        /отправ/i.test(rowText) &&
        !/приб/i.test(rowText)
          ? "departure"
          : "arrival";

      const scheduledMs =
        moscowScheduledMs(
          serviceDate,
          stationIndex,
          event
        );

      const clocks =
        clockTokens(rowText);

      let actualMs = NaN;

      /*
       * Prefer the last clock in a factual/status row.  Historical RZD rows
       * put scheduled values first and actual values later.
       */
      if (clocks.length) {
        actualMs =
          closestMoscowClockMs(
            clocks[clocks.length - 1].clock,
            scheduledMs
          );
      }

      if (!Number.isFinite(actualMs) && Number.isFinite(scheduledMs)) {
        actualMs =
          scheduledMs +
          directDelay * 60_000;
      }

      observations.push({
        stationIndex,
        stationName:
          STOPS[stationIndex].name,
        event,
        actualMs:
          Number.isFinite(actualMs)
            ? actualMs
            : null,
        actualTimeMsk:
          Number.isFinite(actualMs)
            ? moscowClock(actualMs)
            : null,
        scheduledMs:
          Number.isFinite(scheduledMs)
            ? scheduledMs
            : null,
        scheduledTimeMsk:
          Number.isFinite(scheduledMs)
            ? moscowClock(scheduledMs)
            : null,
        delayMinutes:
          Math.round(directDelay)
      });

      continue;
    }

    const clocks =
      clockTokens(rowText);

    if (clocks.length < 2) {
      continue;
    }

    const stop =
      STOPS[stationIndex];

    const events = [];

    if (stop.arr !== null) {
      events.push({
        event: "arrival",
        scheduledMs:
          moscowScheduledMs(
            serviceDate,
            stationIndex,
            "arrival"
          )
      });
    }

    if (
      stop.dep !== null &&
      stop.dep !== stop.arr
    ) {
      events.push({
        event: "departure",
        scheduledMs:
          moscowScheduledMs(
            serviceDate,
            stationIndex,
            "departure"
          )
      });
    }

    /*
     * Remove one occurrence of each scheduled clock. Any clocks left after
     * that are candidates for factual times. This handles rows like:
     *   06:21  06:51  06:38  07:08
     * without depending on CSS classes from the RZD site.
     */
    const remaining =
      clocks.map((item) => ({ ...item, used: false }));

    for (const expected of events) {
      const expectedClock =
        moscowClock(expected.scheduledMs);

      const same =
        remaining.find(
          (item) =>
            !item.used &&
            item.clock === expectedClock
        );

      if (same) {
        same.used = true;
      }
    }

    const factualCandidates =
      remaining.filter((item) => !item.used);

    if (!factualCandidates.length) {
      /*
       * Do not infer "on time" merely from a schedule row. Only explicit
       * factual/status wording allows a zero deviation observation.
       */
      if (explicitActual && /по\s+графику/i.test(rowText)) {
        const event =
          stop.arr !== null
            ? "arrival"
            : "departure";

        const scheduledMs =
          moscowScheduledMs(
            serviceDate,
            stationIndex,
            event
          );

        observations.push({
          stationIndex,
          stationName:
            STOPS[stationIndex].name,
          event,
          actualMs:
            Number.isFinite(scheduledMs)
              ? scheduledMs
              : null,
          actualTimeMsk:
            Number.isFinite(scheduledMs)
              ? moscowClock(scheduledMs)
              : null,
          scheduledMs:
            Number.isFinite(scheduledMs)
              ? scheduledMs
              : null,
          scheduledTimeMsk:
            Number.isFinite(scheduledMs)
              ? moscowClock(scheduledMs)
              : null,
          delayMinutes: 0
        });
      }

      continue;
    }

    /*
     * A clock left over from the scheduled columns is only accepted when the
     * row has factual/status wording OR there are at least three clocks,
     * which is the characteristic schedule+fact table shape.
     */
    if (
      !explicitActual &&
      clocks.length < 3
    ) {
      continue;
    }

    for (const candidate of factualCandidates) {
      let best = null;

      for (const expected of events) {
        const actualMs =
          closestMoscowClockMs(
            candidate.clock,
            expected.scheduledMs
          );

        if (!Number.isFinite(actualMs)) {
          continue;
        }

        const absDiff =
          Math.abs(
            actualMs -
            expected.scheduledMs
          );

        if (
          !best ||
          absDiff < best.absDiff
        ) {
          best = {
            event: expected.event,
            scheduledMs:
              expected.scheduledMs,
            actualMs,
            absDiff
          };
        }
      }

      if (
        !best ||
        best.absDiff > 12 * 60 * 60_000
      ) {
        continue;
      }

      const delayMinutes =
        Math.round(
          (
            best.actualMs -
            best.scheduledMs
          ) / 60_000
        );

      observations.push({
        stationIndex,
        stationName:
          STOPS[stationIndex].name,
        event: best.event,
        actualMs: best.actualMs,
        actualTimeMsk:
          moscowClock(best.actualMs),
        scheduledMs:
          best.scheduledMs,
        scheduledTimeMsk:
          moscowClock(best.scheduledMs),
        delayMinutes
      });
    }
  }

  return observations;
}

function parseRzdPayload(body, contentType, serviceDate) {
  const observations = [];
  const text = String(body || "");

  if (/json/i.test(contentType || "") || /^[\s\r\n]*[{[]/.test(text)) {
    try {
      const data = JSON.parse(text);
      walkJsonForObservations(data, serviceDate, observations);
    } catch {}
  }

  for (const match of text.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(match[1]);
      walkJsonForObservations(data, serviceDate, observations);
    } catch {}
  }

  observations.push(
    ...observationsFromHtmlRows(text, serviceDate)
  );

  const plainText =
    htmlToText(text);

  observations.push(
    ...observationsFromExplicitStatusText(
      plainText,
      serviceDate
    )
  );

  observations.push(
    ...observationsFromText(
      plainText,
      serviceDate
    )
  );

  return dedupeObservations(observations);
}

function dotDate(isoDate) {
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : isoDate;
}

function renderRzdUrl(template, serviceDate, train) {
  return template
    .replaceAll("{date}", encodeURIComponent(serviceDate))
    .replaceAll("{dateDot}", encodeURIComponent(dotDate(serviceDate)))
    .replaceAll("{train}", encodeURIComponent(train));
}

function addIsoDays(isoDate, days) {
  const match =
    String(isoDate).match(
      /^(\d{4})-(\d{2})-(\d{2})$/
    );

  if (!match) {
    return isoDate;
  }

  const date =
    new Date(
      Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3])
      )
    );

  date.setUTCDate(
    date.getUTCDate() + days
  );

  return date.toISOString().slice(0, 10);
}

function rzdRouteParams(serviceDate, train) {
  const arrivalDate =
    addIsoDays(serviceDate, 2);

  return {
    dateDep: dotDate(serviceDate),
    dateArr: dotDate(arrivalDate),
    train,
    src:
      RZD_ACTUAL_ROUTE.src,
    dst:
      RZD_ACTUAL_ROUTE.dst,
    srcCode:
      RZD_ACTUAL_ROUTE.srcCode,
    dstCode:
      RZD_ACTUAL_ROUTE.dstCode
  };
}

function rzdMovementSearchUrls(serviceDate, train) {
  const p =
    rzdRouteParams(
      serviceDate,
      train
    );

  const params =
    new URLSearchParams({
      STRUCTURE_ID: "5199",
      layer_id: "5379",
      refererLayerId: "5199",
      date_arr: p.dateArr,
      date_dep: p.dateDep,
      src: p.src,
      dst: p.dst,
      train: p.train,
      train_out: p.train,
      src_code: p.srcCode,
      dst_code: p.dstCode
    });

  const paramsNoLayer =
    new URLSearchParams({
      STRUCTURE_ID: "5199",
      date_arr: p.dateArr,
      date_dep: p.dateDep,
      src: p.src,
      dst: p.dst,
      train: p.train,
      src_code: p.srcCode,
      dst_code: p.dstCode
    });

  return [
    {
      label:
        "RZD actual movement route search 5379",
      url:
        `https://pass.rzd.ru/tablo/public/ru?${params.toString()}`
    },
    {
      label:
        "RZD actual movement route search base",
      url:
        `https://pass.rzd.ru/tablo/public/ru?${paramsNoLayer.toString()}`
    }
  ];
}

function decodeHtmlUrl(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\x26/gi, "&");
}

function rzdDetailUrl(
  serviceDate,
  train,
  ocrvTrainId,
  structureId = "5199"
) {
  const p =
    rzdRouteParams(
      serviceDate,
      train
    );

  const params =
    new URLSearchParams({
      STRUCTURE_ID:
        String(structureId || "5199"),
      layer_id: "5381",
      refererLayerId: "5379",
      date_arr: p.dateArr,
      date_dep: p.dateDep,
      src: p.src,
      dst: p.dst,
      train: p.train,
      train_out: p.train,
      change_station_id: "",
      ocrv_train_id1:
        String(ocrvTrainId),
      ocrv_train_id2:
        String(ocrvTrainId),
      src_code: p.srcCode,
      dst_code: p.dstCode
    });

  return (
    "https://pass.rzd.ru/tablo/public/ru?" +
    params.toString()
  );
}

function extractRzdDetailUrls(
  body,
  serviceDate,
  train
) {
  const source =
    decodeHtmlUrl(body);

  const urls =
    new Set();

  const ids =
    new Set();

  /*
   * Historical results contain an href to layer_id=5381.
   * Preserve it verbatim if possible because the site may add new required
   * parameters over time.
   */
  for (
    const match of
    source.matchAll(
      /(?:href|url)\s*=\s*["']([^"']*(?:layer_id=5381|ocrv_train_id1)[^"']*)["']/gi
    )
  ) {
    try {
      const absolute =
        new URL(
          decodeHtmlUrl(match[1]),
          "https://pass.rzd.ru"
        );

      if (
        absolute.hostname.endsWith(
          "rzd.ru"
        )
      ) {
        urls.add(
          absolute.toString()
        );
      }
    } catch {}
  }

  /*
   * Some RZD pages build the link in JavaScript/JSON instead of an href.
   * Extract the train-run identifier and construct the documented historical
   * detail shape ourselves.
   */
  const idPatterns = [
    /ocrv_train_id1(?:=|%3[dD]|["'\s:]+)(\d{5,})/gi,
    /["']ocrv_train_id1["']\s*:\s*["']?(\d{5,})/gi,
    /ocrvTrainId(?:1)?["'\s:=]+(\d{5,})/gi
  ];

  for (const pattern of idPatterns) {
    for (
      const match of
      source.matchAll(pattern)
    ) {
      ids.add(match[1]);
    }
  }

  for (const id of ids) {
    urls.add(
      rzdDetailUrl(
        serviceDate,
        train,
        id,
        "5199"
      )
    );

    /*
     * Older links used STRUCTURE_ID=704. It costs little to retain this
     * compatibility fallback if the 5199 wrapper no longer renders details.
     */
    urls.add(
      rzdDetailUrl(
        serviceDate,
        train,
        id,
        "704"
      )
    );
  }

  return {
    urls:
      [...urls].slice(0, 8),
    ids:
      [...ids].slice(0, 8)
  };
}

function rzdCandidateUrls(serviceDate, train) {
  const urls = [];

  if (RZD_ACTUAL_URL_TEMPLATE) {
    urls.push({
      label: "env:RZD_ACTUAL_URL",
      url:
        renderRzdUrl(
          RZD_ACTUAL_URL_TEMPLATE,
          serviceDate,
          train
        )
    });
  }

  const date =
    encodeURIComponent(
      dotDate(serviceDate)
    );

  const number =
    encodeURIComponent(train);

  urls.push(
    {
      label:
        "RZD modern actual movement",
      url:
        `https://www.rzd.ru/ru/9278?date=${encodeURIComponent(serviceDate)}&train=${number}`
    },
    {
      label:
        "RZD alternative actual movement",
      url:
        `https://www.rzd.ru/ru/11497?date=${encodeURIComponent(serviceDate)}&train=${number}`
    },
    {
      label:
        "RZD legacy actual movement 5418",
      url:
        `https://pass.rzd.ru/tablo/public/ru?STRUCTURE_ID=5418&layer_id=5366&refererLayerId=5404&date=${date}&train=${number}`
    }
  );

  return urls;
}

function cookieHeaderFromResponse(headers) {
  const raw =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie().join(", ")
      : (headers.get("set-cookie") || "");

  if (!raw) {
    return "";
  }

  const cookies = [];

  for (
    const match of
    raw.matchAll(
      /(?:^|,\s*)([A-Za-z0-9_.-]+=[^;,\r\n]*)/g
    )
  ) {
    cookies.push(match[1].trim());
  }

  return Array.from(
    new Set(cookies)
  ).join("; ");
}

function mergeCookieHeaders(...headers) {
  const map = new Map();

  for (const header of headers) {
    for (
      const part of
      String(header || "").split(";")
    ) {
      const item = part.trim();

      if (!item || !item.includes("=")) {
        continue;
      }

      const index =
        item.indexOf("=");

      const name =
        item.slice(0, index).trim();

      const value =
        item.slice(index + 1).trim();

      if (name) {
        map.set(name, value);
      }
    }
  }

  return [...map.entries()]
    .map(
      ([name, value]) =>
        `${name}=${value}`
    )
    .join("; ");
}

async function fetchRzdSource(url, cookie = "") {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      RZD_ACTUAL_TIMEOUT_MS
    );

  try {
    const headers = {
      "Accept":
        "text/html,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language":
        "ru-RU,ru;q=0.9,en;q=0.5",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
      "Referer":
        "https://www.rzd.ru/ru/9278"
    };

    if (cookie) {
      headers.Cookie = cookie;
    }

    const response =
      await fetch(
        url,
        {
          redirect: "follow",
          signal:
            controller.signal,
          headers
        }
      );

    const body =
      await response.text();

    return {
      ok: response.ok,
      status:
        response.status,
      contentType:
        response.headers.get(
          "content-type"
        ) || "",
      finalUrl:
        response.url,
      cookie:
        cookieHeaderFromResponse(
          response.headers
        ),
      body
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getRzdActualMovement(
  serviceDate,
  requestedTrain = "121В",
  force = false,
  debug = false
) {
  if (RZD_ACTUAL_DISABLED) {
    return {
      available: false,
      status: "disabled",
      serviceDate,
      train: requestedTrain,
      fetchedAt:
        new Date().toISOString(),
      message:
        "RZD_ACTUAL_DISABLED=1"
    };
  }

  const cacheKey =
    `${serviceDate}:${requestedTrain}`;

  const cached =
    rzdActualCache.get(
      cacheKey
    );

  if (
    !force &&
    cached &&
    Date.now() -
      cached.cachedAt <
      RZD_ACTUAL_REFRESH_MS
  ) {
    return {
      ...cached.payload,
      cache: true,
      ageSeconds:
        Math.round(
          (
            Date.now() -
            cached.cachedAt
          ) / 1000
        )
    };
  }

  const attempts = [];
  let bestObservations = [];
  let bestSource = null;

  function consider(
    observations,
    source
  ) {
    if (
      Array.isArray(observations) &&
      observations.length >
        bestObservations.length
    ) {
      bestObservations =
        observations;

      bestSource =
        source;
    }
  }

  if (RZD_ACTUAL_FIXTURE) {
    const body =
      await fs.readFile(
        path.resolve(
          RZD_ACTUAL_FIXTURE
        ),
        "utf8"
      );

    const observations =
      parseRzdPayload(
        body,
        "application/json",
        serviceDate
      );

    consider(
      observations,
      {
        label: "fixture",
        url:
          path.resolve(
            RZD_ACTUAL_FIXTURE
          ),
        train:
          requestedTrain
      }
    );

    attempts.push({
      phase: "fixture",
      source: "fixture",
      status: 200,
      observations:
        observations.length
    });
  } else {
    const trainNumbers =
      Array.from(
        new Set([
          requestedTrain,
          ...RZD_TRAIN_NUMBERS
        ])
      );

    /*
     * STEP 1.
     * Search the actual-movement service by the complete route, not merely
     * by train number. Historical RZD links show that the detail view needs
     * src/dst codes and ocrv_train_id.
     */
    const searchJobs = [];

    for (
      const train of
      trainNumbers
    ) {
      for (
        const source of
        rzdMovementSearchUrls(
          serviceDate,
          train
        )
      ) {
        searchJobs.push({
          train,
          source
        });
      }
    }

    const searchResults =
      await Promise.all(
        searchJobs.map(
          async ({
            train,
            source
          }) => {
            try {
              const fetched =
                await fetchRzdSource(
                  source.url
                );

              const observations =
                fetched.ok
                  ? parseRzdPayload(
                      fetched.body,
                      fetched.contentType,
                      serviceDate
                    )
                  : [];

              const details =
                fetched.ok
                  ? extractRzdDetailUrls(
                      fetched.body,
                      serviceDate,
                      train
                    )
                  : {
                      urls: [],
                      ids: []
                    };

              return {
                train,
                source,
                fetched,
                observations,
                details,
                error: null
              };
            } catch (error) {
              return {
                train,
                source,
                fetched: null,
                observations: [],
                details: {
                  urls: [],
                  ids: []
                },
                error:
                  error instanceof Error
                    ? error.message
                    : String(error)
              };
            }
          }
        )
      );

    const detailJobs = [];

    for (
      const result of
      searchResults
    ) {
      attempts.push({
        phase: "search",
        source:
          result.source.label,
        train:
          result.train,
        status:
          result.fetched?.status ||
          0,
        contentType:
          result.fetched?.contentType ||
          "",
        bodyBytes:
          result.fetched?.body
            ? Buffer.byteLength(
                result.fetched.body
              )
            : 0,
        observations:
          result.observations.length,
        detailIds:
          result.details.ids,
        detailLinks:
          result.details.urls.length,
        finalHost:
          (() => {
            try {
              return new URL(
                result.fetched?.finalUrl ||
                result.source.url
              ).host;
            } catch {
              return "";
            }
          })(),
        ...(result.error
          ? {
              error:
                result.error
            }
          : {}),
        ...(debug &&
        result.fetched?.body
          ? {
              preview:
                htmlToText(
                  result.fetched.body
                ).slice(
                  0,
                  900
                )
            }
          : {})
      });

      consider(
        result.observations,
        {
          label:
            result.source.label,
          url:
            result.fetched?.finalUrl ||
            result.source.url,
          train:
            result.train
        }
      );

      const cookie =
        result.fetched?.cookie ||
        "";

      for (
        const detailUrl of
        result.details.urls
      ) {
        detailJobs.push({
          train:
            result.train,
          searchSource:
            result.source.label,
          detailUrl,
          cookie
        });
      }
    }

    /*
     * STEP 2.
     * Fetch the concrete run identified by ocrv_train_id. This is where the
     * historical service exposes the station-by-station actual movement.
     */
    const detailResults =
      await Promise.all(
        detailJobs.slice(0, 16).map(
          async (job) => {
            try {
              const fetched =
                await fetchRzdSource(
                  job.detailUrl,
                  job.cookie
                );

              const observations =
                fetched.ok
                  ? parseRzdPayload(
                      fetched.body,
                      fetched.contentType,
                      serviceDate
                    )
                  : [];

              return {
                ...job,
                fetched,
                observations,
                error: null
              };
            } catch (error) {
              return {
                ...job,
                fetched: null,
                observations: [],
                error:
                  error instanceof Error
                    ? error.message
                    : String(error)
              };
            }
          }
        )
      );

    for (
      const result of
      detailResults
    ) {
      attempts.push({
        phase: "detail",
        source:
          "RZD actual movement detail 5381",
        searchSource:
          result.searchSource,
        train:
          result.train,
        status:
          result.fetched?.status ||
          0,
        contentType:
          result.fetched?.contentType ||
          "",
        bodyBytes:
          result.fetched?.body
            ? Buffer.byteLength(
                result.fetched.body
              )
            : 0,
        observations:
          result.observations.length,
        finalHost:
          (() => {
            try {
              return new URL(
                result.fetched?.finalUrl ||
                result.detailUrl
              ).host;
            } catch {
              return "";
            }
          })(),
        ...(result.error
          ? {
              error:
                result.error
            }
          : {}),
        ...(debug &&
        result.fetched?.body
          ? {
              preview:
                htmlToText(
                  result.fetched.body
                ).slice(
                  0,
                  1200
                )
            }
          : {})
      });

      consider(
        result.observations,
        {
          label:
            "RZD actual movement detail 5381",
          url:
            result.fetched?.finalUrl ||
            result.detailUrl,
          train:
            result.train
        }
      );
    }

    /*
     * STEP 3 fallback.
     * Keep the modern page and station-board wrapper as supplemental probes.
     * They may expose useful text even when the legacy detail flow changes.
     */
    if (
      bestObservations.length === 0
    ) {
      const fallbackJobs = [];

      for (
        const train of
        trainNumbers
      ) {
        for (
          const source of
          rzdCandidateUrls(
            serviceDate,
            train
          )
        ) {
          fallbackJobs.push({
            train,
            source
          });
        }
      }

      const fallbackResults =
        await Promise.all(
          fallbackJobs.map(
            async ({
              train,
              source
            }) => {
              try {
                const fetched =
                  await fetchRzdSource(
                    source.url
                  );

                const observations =
                  fetched.ok
                    ? parseRzdPayload(
                        fetched.body,
                        fetched.contentType,
                        serviceDate
                      )
                    : [];

                return {
                  train,
                  source,
                  fetched,
                  observations,
                  error: null
                };
              } catch (error) {
                return {
                  train,
                  source,
                  fetched: null,
                  observations: [],
                  error:
                    error instanceof Error
                      ? error.message
                      : String(error)
                };
              }
            }
          )
        );

      for (
        const result of
        fallbackResults
      ) {
        attempts.push({
          phase: "fallback",
          source:
            result.source.label,
          train:
            result.train,
          status:
            result.fetched?.status ||
            0,
          contentType:
            result.fetched?.contentType ||
            "",
          bodyBytes:
            result.fetched?.body
              ? Buffer.byteLength(
                  result.fetched.body
                )
              : 0,
          observations:
            result.observations.length,
          ...(result.error
            ? {
                error:
                  result.error
              }
            : {}),
          ...(debug &&
          result.fetched?.body
            ? {
                preview:
                  htmlToText(
                    result.fetched.body
                  ).slice(
                    0,
                    900
                  )
              }
            : {})
        });

        consider(
          result.observations,
          {
            label:
              result.source.label,
            url:
              result.fetched?.finalUrl ||
              result.source.url,
            train:
              result.train
          }
        );
      }
    }
  }

  const now =
    Date.now();

  const plausible =
    bestObservations.filter(
      (item) =>
        item.stationIndex > 0 &&
        item.stationIndex <
          STOPS.length &&
        Number.isFinite(
          item.delayMinutes
        ) &&
        Math.abs(
          item.delayMinutes
        ) <=
          24 * 60 &&
        (
          !item.actualMs ||
          item.actualMs <=
            now +
              30 * 60_000
        )
    );

  const latest =
    plausible.length
      ? plausible.reduce(
          (best, item) =>
            !best ||
            item.stationIndex >
              best.stationIndex ||
            (
              item.stationIndex ===
                best.stationIndex &&
              (
                item.actualMs ||
                0
              ) >
                (
                  best.actualMs ||
                  0
                )
            )
              ? item
              : best,
          null
        )
      : null;

  const searchFoundRun =
    attempts.some(
      (attempt) =>
        attempt.phase ===
          "search" &&
        (
          (
            Array.isArray(
              attempt.detailIds
            ) &&
            attempt.detailIds
              .length > 0
          ) ||
          attempt.detailLinks > 0
        )
    );

  const detailFetched =
    attempts.some(
      (attempt) =>
        attempt.phase ===
        "detail"
    );

  let message;

  if (latest) {
    message =
      `Последняя фактическая отметка: ${latest.stationName}`;
  } else if (
    searchFoundRun &&
    detailFetched
  ) {
    message =
      "РЖД нашёл конкретный рейс, но детальная страница не дала распознаваемых фактических отметок";
  } else if (
    searchFoundRun
  ) {
    message =
      "РЖД нашёл конкретный рейс, но детальную страницу фактического движения получить не удалось";
  } else {
    message =
      "РЖД не вернул идентификатор конкретного рейса для маршрута Санкт-Петербург → Новороссийск; использован резервный поиск";
  }

  const payload = {
    available:
      Boolean(latest),
    status:
      latest
        ? "live"
        : "no_data",
    train:
      bestSource?.train ||
      requestedTrain,
    serviceDate,
    fetchedAt:
      new Date().toISOString(),
    cache: false,
    ageSeconds: 0,
    source:
      bestSource
        ? {
            name:
              bestSource.label,
            host:
              (() => {
                try {
                  return new URL(
                    bestSource.url
                  ).host;
                } catch {
                  return "fixture";
                }
              })()
          }
        : null,
    latest,
    delayMinutes:
      latest?.delayMinutes ??
      null,
    observations:
      plausible,
    attempts,
    resolver: {
      route: {
        src:
          RZD_ACTUAL_ROUTE.src,
        srcCode:
          RZD_ACTUAL_ROUTE.srcCode,
        dst:
          RZD_ACTUAL_ROUTE.dst,
        dstCode:
          RZD_ACTUAL_ROUTE.dstCode
      },
      searchFoundRun,
      detailFetched
    },
    message
  };

  rzdActualCache.set(
    cacheKey,
    {
      cachedAt:
        Date.now(),
      payload
    }
  );

  return payload;
}

const server =
  http.createServer(
    async (req, res) => {
      try {
        const url =
          new URL(
            req.url || "/",
            `http://${req.headers.host || HOST}`
          );

        if (
          url.pathname ===
          "/favicon.ico"
        ) {
          res.writeHead(204);
          res.end();
          return;
        }

        if (
          url.pathname ===
          "/api/trains/status"
        ) {
          json(
            res,
            200,
            trainProviderStatus()
          );
          return;
        }

        if (
          url.pathname ===
          "/api/trains/suggest"
        ) {
          const q =
            url.searchParams.get(
              "q"
            ) || "";

          try {
            const suggestions =
              await suggestStations(
                q
              );

            json(
              res,
              200,
              {
                query:
                  q,
                count:
                  suggestions.length,
                suggestions
              }
            );
          } catch (error) {
            json(
              res,
              200,
              {
                query:
                  q,
                count: 0,
                suggestions: [],
                warning:
                  error instanceof Error
                    ? error.message
                    : String(error)
              }
            );
          }

          return;
        }

        if (
          url.pathname ===
          "/api/trains/search-route"
        ) {
          const from =
            url.searchParams.get(
              "from"
            ) || "";

          const to =
            url.searchParams.get(
              "to"
            ) || "";

          const fromId =
            url.searchParams.get(
              "fromId"
            ) || "";

          const toId =
            url.searchParams.get(
              "toId"
            ) || "";

          const date =
            url.searchParams.get(
              "date"
            ) || "";

          const lookback =
            Math.max(
              0,
              Math.min(
                6,
                Number(
                  url.searchParams.get(
                    "lookback"
                  ) || 4
                )
              )
            );

          if (
            !from.trim() ||
            !to.trim() ||
            !/^\d{4}-\d{2}-\d{2}$/.test(
              date
            )
          ) {
            json(
              res,
              400,
              {
                error:
                  "Нужны from, to и date=YYYY-MM-DD"
              }
            );
            return;
          }

          try {
            const result =
              await searchRouteRuns(
                from,
                to,
                date,
                {
                  lookbackDays:
                    lookback,
                  now:
                    Date.now(),
                  fromId,
                  toId
                }
              );

            json(
              res,
              200,
              result
            );
          } catch (error) {
            json(
              res,
              502,
              {
                error:
                  "Не удалось найти поезда по направлению",
                details:
                  error instanceof Error
                    ? error.message
                    : String(error),
                provider:
                  trainProviderStatus()
              }
            );
          }

          return;
        }

        if (
          url.pathname ===
          "/api/trains/search"
        ) {
          const number =
            url.searchParams.get(
              "number"
            ) || "";

          const date =
            url.searchParams.get(
              "date"
            ) || "";

          const force =
            url.searchParams.get(
              "force"
            ) === "1";

          if (
            !number ||
            !/^\d{4}-\d{2}-\d{2}$/.test(
              date
            )
          ) {
            json(
              res,
              400,
              {
                error:
                  "Нужны параметры number и date=YYYY-MM-DD"
              }
            );
            return;
          }

          try {
            const result =
              await searchTrainRuns(
                number,
                date,
                {
                  force
                }
              );

            json(
              res,
              200,
              result
            );
          } catch (error) {
            json(
              res,
              502,
              {
                error:
                  "Не удалось найти рейс",
                details:
                  error instanceof Error
                    ? error.message
                    : String(error),
                attempts:
                  error?.attempts ||
                  null,
                provider:
                  trainProviderStatus()
              }
            );
          }

          return;
        }

        if (
          url.pathname ===
          "/api/trains/run"
        ) {
          const runId =
            url.searchParams.get(
              "runId"
            ) || "";

          const number =
            url.searchParams.get(
              "number"
            ) || "";

          const date =
            url.searchParams.get(
              "date"
            ) || "";

          const force =
            url.searchParams.get(
              "force"
            ) === "1";

          try {
            let run = null;

            if (runId) {
              run =
                await getRunById(
                  runId
                );

              if (!run) {
                json(
                  res,
                  404,
                  {
                    error:
                      "Рейс не найден в локальном каталоге"
                  }
                );
                return;
              }
            } else {
              if (
                !number ||
                !/^\d{4}-\d{2}-\d{2}$/.test(
                  date
                )
              ) {
                json(
                  res,
                  400,
                  {
                    error:
                      "Нужен runId либо number + date=YYYY-MM-DD"
                  }
                );
                return;
              }

              run =
                await resolveTrainRun(
                  number,
                  date,
                  {
                    force
                  }
                );
            }

            json(
              res,
              200,
              run
            );
          } catch (error) {
            json(
              res,
              502,
              {
                error:
                  "Не удалось загрузить рейс",
                details:
                  error instanceof Error
                    ? error.message
                    : String(error)
              }
            );
          }

          return;
        }

        if (
          url.pathname ===
          "/api/trains/route"
        ) {
          const runId =
            url.searchParams.get(
              "runId"
            ) || "";

          const force =
            url.searchParams.get(
              "force"
            ) === "1";

          if (!runId) {
            json(
              res,
              400,
              {
                error:
                  "Параметр runId обязателен"
              }
            );
            return;
          }

          try {
            const run =
              await getRunById(
                runId
              );

            if (!run) {
              json(
                res,
                404,
                {
                  error:
                    "Рейс не найден в локальном каталоге"
                }
              );
              return;
            }

            const route =
              await buildTrainRoute(
                run,
                {
                  force
                }
              );

            json(
              res,
              200,
              route
            );
          } catch (error) {
            json(
              res,
              502,
              {
                error:
                  "Не удалось построить железнодорожный маршрут выбранного рейса",
                details:
                  error instanceof Error
                    ? error.message
                    : String(error)
              }
            );
          }

          return;
        }

        if (
          url.pathname ===
          "/api/trains/active"
        ) {
          const nowParam =
            Number(
              url.searchParams.get(
                "now"
              )
            );

          const now =
            Number.isFinite(
              nowParam
            ) &&
            nowParam > 0
              ? nowParam
              : Date.now();

          const refresh =
            url.searchParams.get(
              "refresh"
            ) === "1";

          try {
            const active =
              await listActiveRuns(
                now,
                {
                  refresh
                }
              );

            json(
              res,
              200,
              {
                generatedAt:
                  new Date().toISOString(),
                now,
                ...active,
                note:
                  "Позиции массового слоя расчётные. Для выбранного состава используется его отдельный железнодорожный маршрут."
              }
            );
          } catch (error) {
            json(
              res,
              500,
              {
                error:
                  "Не удалось сформировать список активных поездов",
                details:
                  error instanceof Error
                    ? error.message
                    : String(error)
              }
            );
          }

          return;
        }

        if (
          url.pathname ===
          "/api/rzd-actual"
        ) {
          const serviceDate = url.searchParams.get("date") || "";
          const train = url.searchParams.get("train") || "121В";
          const force = url.searchParams.get("force") === "1";
          const debug = url.searchParams.get("debug") === "1";

          if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
            json(res, 400, {
              error: "Параметр date обязателен в формате YYYY-MM-DD"
            });
            return;
          }

          try {
            const actual = await getRzdActualMovement(serviceDate, train, force, debug);
            json(res, 200, actual);
          } catch (error) {
            json(res, 502, {
              available: false,
              status: "error",
              serviceDate,
              train,
              fetchedAt: new Date().toISOString(),
              error: "Не удалось получить фактическое движение РЖД",
              details: error instanceof Error ? error.message : String(error)
            });
          }
          return;
        }

        if (
          url.pathname ===
          "/api/rail-status"
        ) {
          json(
            res,
            200,
            railStatus
          );
          return;
        }

        if (
          url.pathname ===
          "/api/rail-route"
        ) {
          try {
            const force =
              url.searchParams.get("force") === "1";

            if (force) {
              try {
                await fs.unlink(
                  CACHE_PATH
                );
              } catch {}
            }

            const result =
              await getRailRoute(
                force
              );

            json(
              res,
              200,
              result
            );
          } catch (error) {
            json(
              res,
              502,
              {
                error:
                  "Не удалось построить OSM-железнодорожный маршрут",
                details:
                  error instanceof Error
                    ? error.message
                    : String(error),
                status:
                  railStatus
              }
            );
          }

          return;
        }

        if (
          url.pathname.startsWith("/dist/")
        ) {
          const rel = url.pathname.slice("/dist/".length);
          if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
            sendText(res, 400, "Bad path");
            return;
          }
          const distRoot = path.resolve(__dirname, "../..", "dist");
          const filePath = path.resolve(distRoot, rel);
          if (!filePath.startsWith(distRoot + path.sep) && filePath !== distRoot) {
            sendText(res, 400, "Bad path");
            return;
          }
          try {
            const body = await fs.readFile(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mime =
              ext === ".css" ? "text/css; charset=utf-8"
              : ext === ".js" ? "text/javascript; charset=utf-8"
              : "application/octet-stream";
            res.writeHead(200, {
              "Content-Type": mime,
              "Content-Length": body.length,
              "Cache-Control": "no-store"
            });
            res.end(body);
          } catch {
            sendText(res, 404, `Missing ${url.pathname} — run npm run build`);
          }
          return;
        }

        if (
          url.pathname !== "/" &&
          url.pathname !==
            "/index.html"
        ) {
          sendText(
            res,
            404,
            "Not found"
          );
          return;
        }

        const body =
          await fs.readFile(
            path.join(
              __dirname,
              "index.html"
            )
          );

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html; charset=utf-8",
            "Content-Length":
              body.length,
            "Cache-Control":
              "no-store"
          }
        );

        res.end(body);
      } catch (error) {
        console.error(error);

        sendText(
          res,
          500,
          error instanceof Error
            ? error.stack ||
              error.message
            : String(error)
        );
      }
    }
  );

server.listen(
  PORT,
  HOST,
  () => {
    console.log("");
    console.log(
      "РЖД Multi-Train Tracker · Orihon + OSM rail router"
    );
    console.log(
      `Откройте: http://${HOST}:${PORT}`
    );
    console.log(
      `Rail API: http://${HOST}:${PORT}/api/rail-route`
    );
    console.log(
      `RZD actual API: http://${HOST}:${PORT}/api/rzd-actual?date=YYYY-MM-DD&train=121В`
    );
    console.log(
      `Route search: http://${HOST}:${PORT}/api/trains/search-route?from=Москва&to=Сочи&date=YYYY-MM-DD`
    );
    console.log(
      `Active catalog: http://${HOST}:${PORT}/api/trains/active`
    );
    console.log("");
    console.log(
      "Поиск поездов работает без API-ключа через публичное расписание."
    );
    console.log(
      "Маршруты строятся по OSM route=train или railway=rail и кэшируются локально."
    );
    console.log("");
  }
);

triggerActiveIndexRefresh();

process.on(
  "SIGINT",
  () => {
    console.log(
      "\nОстановка сервера…"
    );

    server.close(
      () => process.exit(0)
    );
  }
);
