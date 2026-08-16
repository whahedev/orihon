import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
      "РЖД 121В/122В · OSM rail router"
    );
    console.log(
      `Откройте: http://${HOST}:${PORT}`
    );
    console.log(
      `Rail API: http://${HOST}:${PORT}/api/rail-route`
    );
    console.log("");
    console.log(
      "При первом запросе сервер загрузит railway=rail из Overpass,"
    );
    console.log(
      "построит граф маршрута и сохранит rail-route-cache.json."
    );
    console.log("");
  }
);

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
