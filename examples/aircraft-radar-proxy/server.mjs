import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Node 22+ has global WebSocket; on Node 20 fall back to the `ws` package.
if (typeof globalThis.WebSocket !== "function") {
  const require = createRequire(import.meta.url);
  try {
    globalThis.WebSocket = require("ws");
  } catch {
    throw new Error(
      "WebSocket is unavailable. Use Node.js 22+ or run `npm install` in examples/aircraft-radar-proxy (needs `ws`)."
    );
  }
}

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POINT_RADIUS_NM = 250;
const TILE_VERTICAL_SPACING_NM = POINT_RADIUS_NM * 1.5;
const TILE_HORIZONTAL_SPACING_NM = POINT_RADIUS_NM * Math.sqrt(3);
const TILE_VERTICAL_SPACING_DEG = TILE_VERTICAL_SPACING_NM / 60;

const CACHE_FRESH_MS = 20_000;
const CACHE_MAX_AGE_MS = 120_000;
const MAX_AIRCRAFT_AGE_SEC = 120;
const MAX_REFRESH_TILES_PER_REQUEST = 10;
const MAX_CELLS_PER_VIEW = 64;

const PROVIDERS = [
  {
    name: "ADSB.lol",
    minIntervalMs: 350,
    buildUrl(lat, lon) {
      return `https://api.adsb.lol/v2/point/${lat.toFixed(5)}/${lon.toFixed(5)}/${POINT_RADIUS_NM}`;
    }
  },
  {
    name: "Airplanes.live",
    minIntervalMs: 1100,
    buildUrl(lat, lon) {
      return `https://api.airplanes.live/v2/point/${lat.toFixed(5)}/${lon.toFixed(5)}/${POINT_RADIUS_NM}`;
    }
  }
];

const providerState = new Map(
  PROVIDERS.map((provider) => [
    provider.name,
    {
      queue: Promise.resolve(),
      lastStartedAt: 0,
      disabledUntil: 0,
      lastError: null
    }
  ])
);

const tileCache = new Map();

// ============================================================================
// MARINE / AIS
// ============================================================================

const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
const AISSTREAM_API_KEY = String(process.env.AISSTREAM_API_KEY || "").trim();

const BARENTSWATCH_CLIENT_ID = String(
  process.env.BARENTSWATCH_CLIENT_ID || ""
).trim();

const BARENTSWATCH_CLIENT_SECRET = String(
  process.env.BARENTSWATCH_CLIENT_SECRET || ""
).trim();

const DIGITRAFFIC_LOCATIONS_URL =
  "https://meri.digitraffic.fi/api/ais/v1/locations";

const DIGITRAFFIC_VESSELS_URL =
  "https://meri.digitraffic.fi/api/ais/v1/vessels";

const DEFAULT_MARINE_BOUNDS = {
  west: -15,
  south: 34,
  east: 40,
  north: 72
};

const VESSEL_STALE_MS = 30 * 60 * 1000;
const DIGITRAFFIC_LOCATION_INTERVAL_MS = 20_000;
const DIGITRAFFIC_METADATA_INTERVAL_MS = 10 * 60 * 1000;
const AISSTREAM_RECONNECT_MS = 5_000;
const BARENTSWATCH_RECONNECT_MS = 8_000;

const vesselStore = new Map();
const digitrafficMetadata = new Map();
const realtimeClients = new Set();

let shuttingDown = false;

const marineStatus = {
  aisstream: {
    configured: Boolean(AISSTREAM_API_KEY),
    connected: false,
    lastMessageAt: null,
    lastError: null
  },
  digitraffic: {
    connected: false,
    lastMessageAt: null,
    lastError: null,
    vesselCount: 0
  },
  barentswatch: {
    configured: Boolean(
      BARENTSWATCH_CLIENT_ID &&
      BARENTSWATCH_CLIENT_SECRET
    ),
    connected: false,
    lastMessageAt: null,
    lastError: null
  }
};

function cleanAisText(value) {
  if (typeof value !== "string") return null;

  const cleaned = value
    .replace(/@+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validHeading(value) {
  const number = finiteOrNull(value);

  if (number === null || number < 0 || number >= 360) {
    return null;
  }

  return number;
}

function validCourse(value) {
  const number = finiteOrNull(value);

  if (number === null || number < 0 || number > 360) {
    return null;
  }

  return number === 360 ? 0 : number;
}

function validSpeed(value) {
  const number = finiteOrNull(value);

  if (number === null || number < 0 || number >= 102.3) {
    return null;
  }

  return number;
}

function normalizeMmsi(value) {
  const text = String(value ?? "").replace(/\D/g, "");

  if (text.length < 7 || text.length > 9) {
    return null;
  }

  return text.padStart(9, "0");
}

function vesselPublic(record) {
  return {
    id: record.id,
    mmsi: record.mmsi,
    lat: record.lat,
    lon: record.lon,
    speed: record.speed,
    course: record.course,
    heading: record.heading,
    rateOfTurn: record.rateOfTurn,
    navStatus: record.navStatus,
    name: record.name,
    callSign: record.callSign,
    imo: record.imo,
    shipType: record.shipType,
    destination: record.destination,
    draught: record.draught,
    length: record.length,
    width: record.width,
    eta: record.eta,
    positionUpdatedAt: record.positionUpdatedAt,
    metadataUpdatedAt: record.metadataUpdatedAt,
    updatedAt: Math.max(
      record.positionUpdatedAt || 0,
      record.metadataUpdatedAt || 0
    ),
    sources: Array.from(record.sources || [])
  };
}

function boundsContain(bounds, lat, lon) {
  if (!bounds) return true;

  return (
    lat >= bounds.south &&
    lat <= bounds.north &&
    lon >= bounds.west &&
    lon <= bounds.east
  );
}

function sanitizeViewport(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const west = parseNumber(input.west, -180, 180);
  const south = parseNumber(input.south, -85, 85);
  const east = parseNumber(input.east, -180, 180);
  const north = parseNumber(input.north, -85, 85);

  if ([west, south, east, north].some((value) => value === null)) {
    return null;
  }

  if (west >= east || south >= north) {
    return null;
  }

  return { west, south, east, north };
}

function mergedSubscriptionBoxes() {
  const boxes = [];

  for (const client of realtimeClients) {
    if (!client.viewport) continue;

    const b = client.viewport;

    boxes.push([
      [
        clamp(b.south - 0.5, -85, 85),
        clamp(b.west - 0.8, -180, 180)
      ],
      [
        clamp(b.north + 0.5, -85, 85),
        clamp(b.east + 0.8, -180, 180)
      ]
    ]);

    if (boxes.length >= 8) {
      break;
    }
  }

  if (boxes.length === 0) {
    boxes.push([
      [DEFAULT_MARINE_BOUNDS.south, DEFAULT_MARINE_BOUNDS.west],
      [DEFAULT_MARINE_BOUNDS.north, DEFAULT_MARINE_BOUNDS.east]
    ]);
  }

  return boxes;
}

function sendSse(client, payload) {
  if (
    !client ||
    client.closed ||
    !client.res ||
    client.res.destroyed
  ) {
    return false;
  }

  try {
    client.res.write(
      `data: ${JSON.stringify(payload)}\n\n`
    );

    return true;
  } catch {
    client.closed = true;
    return false;
  }
}

function broadcastMarineStatus() {
  const payload = {
    type: "marine_status",
    status: {
      ...marineStatus,
      vessels: vesselStore.size
    }
  };

  for (const client of realtimeClients) {
    sendSse(client, payload);
  }
}

function sendVesselSnapshot(client) {
  const now = Date.now();
  const records = [];

  for (const vessel of vesselStore.values()) {
    if (
      !Number.isFinite(vessel.lat) ||
      !Number.isFinite(vessel.lon)
    ) {
      continue;
    }

    if (
      now - (vessel.positionUpdatedAt || 0) >
      VESSEL_STALE_MS
    ) {
      continue;
    }

    if (
      client.viewport &&
      !boundsContain(
        client.viewport,
        vessel.lat,
        vessel.lon
      )
    ) {
      continue;
    }

    records.push(
      vesselPublic(vessel)
    );
  }

  sendSse(client, {
    type: "vessels_snapshot",
    records,
    generatedAt: now
  });
}

function broadcastVessel(record) {
  if (
    !record ||
    !Number.isFinite(record.lat) ||
    !Number.isFinite(record.lon)
  ) {
    return;
  }

  const payload = {
    type: "vessel_update",
    record: vesselPublic(record)
  };

  for (const client of realtimeClients) {
    if (
      client.viewport &&
      !boundsContain(
        client.viewport,
        record.lat,
        record.lon
      )
    ) {
      continue;
    }

    sendSse(client, payload);
  }
}


function upsertVessel(update, source) {
  const mmsi = normalizeMmsi(update.mmsi);

  if (!mmsi) {
    return null;
  }

  const now = Date.now();

  let record = vesselStore.get(mmsi);

  if (!record) {
    record = {
      id: mmsi,
      mmsi,
      lat: null,
      lon: null,
      speed: null,
      course: null,
      heading: null,
      rateOfTurn: null,
      navStatus: null,
      name: null,
      callSign: null,
      imo: null,
      shipType: null,
      destination: null,
      draught: null,
      length: null,
      width: null,
      eta: null,
      positionUpdatedAt: 0,
      metadataUpdatedAt: 0,
      sources: new Set()
    };

    vesselStore.set(mmsi, record);
  }

  record.sources.add(source);

  const incomingPositionTime =
    finiteOrNull(update.positionUpdatedAt) || 0;

  const hasPosition =
    Number.isFinite(Number(update.lat)) &&
    Number.isFinite(Number(update.lon));

  if (
    hasPosition &&
    (
      incomingPositionTime >= record.positionUpdatedAt ||
      !Number.isFinite(record.lat) ||
      !Number.isFinite(record.lon)
    )
  ) {
    record.lat = Number(update.lat);
    record.lon = Number(update.lon);
    record.positionUpdatedAt =
      incomingPositionTime || now;

    if (update.speed !== undefined) {
      record.speed = validSpeed(update.speed);
    }

    if (update.course !== undefined) {
      record.course = validCourse(update.course);
    }

    if (update.heading !== undefined) {
      record.heading = validHeading(update.heading);
    }

    if (update.rateOfTurn !== undefined) {
      record.rateOfTurn = finiteOrNull(update.rateOfTurn);
    }

    if (update.navStatus !== undefined) {
      record.navStatus = finiteOrNull(update.navStatus);
    }
  }

  const metadataFields = [
    "name",
    "callSign",
    "imo",
    "shipType",
    "destination",
    "draught",
    "length",
    "width",
    "eta"
  ];

  let metadataChanged = false;

  for (const field of metadataFields) {
    if (
      update[field] !== undefined &&
      update[field] !== null &&
      update[field] !== ""
    ) {
      let value = update[field];

      if (
        field === "name" ||
        field === "callSign" ||
        field === "destination"
      ) {
        value = cleanAisText(value);
      }

      if (
        value !== null &&
        record[field] !== value
      ) {
        record[field] = value;
        metadataChanged = true;
      }
    }
  }

  if (metadataChanged) {
    record.metadataUpdatedAt =
      finiteOrNull(update.metadataUpdatedAt) ||
      now;
  }

  broadcastVessel(record);
  return record;
}

function aisDimensions(dimension) {
  if (!dimension || typeof dimension !== "object") {
    return { length: null, width: null };
  }

  const a = finiteOrNull(dimension.A) || 0;
  const b = finiteOrNull(dimension.B) || 0;
  const c = finiteOrNull(dimension.C) || 0;
  const d = finiteOrNull(dimension.D) || 0;

  return {
    length: a + b || null,
    width: c + d || null
  };
}

function handleAisStreamMessage(raw) {
  let message;

  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }

  if (message && typeof message.error === "string") {
    marineStatus.aisstream.lastError = message.error;
    broadcastMarineStatus();
    return;
  }

  const type = message?.MessageType;
  const body = message?.Message?.[type];

  if (!type || !body || typeof body !== "object") {
    return;
  }

  const mmsi = normalizeMmsi(
    body.UserID ??
    message?.Metadata?.MMSI ??
    message?.Metadata?.Mmsi
  );

  if (!mmsi) {
    return;
  }

  const now = Date.now();

  if (
    type === "PositionReport" ||
    type === "StandardClassBPositionReport" ||
    type === "ExtendedClassBPositionReport"
  ) {
    const dimensions = aisDimensions(body.Dimension);

    upsertVessel(
      {
        mmsi,
        lat: body.Latitude,
        lon: body.Longitude,
        speed: body.Sog,
        course: body.Cog,
        heading: body.TrueHeading,
        rateOfTurn: body.RateOfTurn,
        navStatus: body.NavigationalStatus,
        name: body.Name,
        shipType: body.Type,
        length: dimensions.length,
        width: dimensions.width,
        positionUpdatedAt: now,
        metadataUpdatedAt: now
      },
      "AISStream"
    );
  } else if (type === "ShipStaticData") {
    const dimensions = aisDimensions(body.Dimension);

    upsertVessel(
      {
        mmsi,
        name: body.Name,
        callSign: body.CallSign,
        imo: finiteOrNull(body.ImoNumber),
        shipType: finiteOrNull(body.Type),
        destination: body.Destination,
        draught: finiteOrNull(body.MaximumStaticDraught),
        length: dimensions.length,
        width: dimensions.width,
        eta: body.Eta || null,
        metadataUpdatedAt: now
      },
      "AISStream"
    );
  }

  marineStatus.aisstream.lastMessageAt = now;
  marineStatus.aisstream.lastError = null;
}

let aisStreamSocket = null;
let aisReconnectTimer = null;
let aisSubscriptionTimer = null;
let lastAisSubscriptionAt = 0;

function sendAisSubscription() {
  if (
    !aisStreamSocket ||
    aisStreamSocket.readyState !== WebSocket.OPEN ||
    !AISSTREAM_API_KEY
  ) {
    return;
  }

  const elapsed = Date.now() - lastAisSubscriptionAt;

  if (elapsed < 1100) {
    clearTimeout(aisSubscriptionTimer);

    aisSubscriptionTimer = setTimeout(
      sendAisSubscription,
      1100 - elapsed
    );

    return;
  }

  lastAisSubscriptionAt = Date.now();

  const subscription = {
    APIKey: AISSTREAM_API_KEY,
    BoundingBoxes: mergedSubscriptionBoxes(),
    FilterMessageTypes: [
      "PositionReport",
      "StandardClassBPositionReport",
      "ExtendedClassBPositionReport",
      "ShipStaticData"
    ]
  };

  try {
    aisStreamSocket.send(JSON.stringify(subscription));
  } catch (error) {
    marineStatus.aisstream.lastError =
      error instanceof Error ? error.message : String(error);
  }
}

function scheduleAisSubscriptionUpdate() {
  clearTimeout(aisSubscriptionTimer);

  aisSubscriptionTimer = setTimeout(
    sendAisSubscription,
    350
  );
}

function connectAisStream() {
  if (
    shuttingDown ||
    !AISSTREAM_API_KEY
  ) {
    return;
  }

  clearTimeout(aisReconnectTimer);

  marineStatus.aisstream.connected = false;
  broadcastMarineStatus();

  const socket =
    new WebSocket(AISSTREAM_URL);

  aisStreamSocket = socket;

  socket.addEventListener("open", () => {
    if (socket !== aisStreamSocket) return;

    marineStatus.aisstream.connected = true;
    marineStatus.aisstream.lastError = null;
    broadcastMarineStatus();

    sendAisSubscription();
  });

  socket.addEventListener("message", (event) => {
    if (socket !== aisStreamSocket) return;

    handleAisStreamMessage(event.data);
  });

  socket.addEventListener("error", () => {
    if (socket !== aisStreamSocket) return;

    marineStatus.aisstream.lastError =
      "AISStream WebSocket error";

    broadcastMarineStatus();
  });

  socket.addEventListener("close", (event) => {
    if (socket !== aisStreamSocket) return;

    marineStatus.aisstream.connected = false;

    const reasonText =
      cleanAisText(event.reason);

    if (event.code !== 1000) {
      marineStatus.aisstream.lastError =
        `WebSocket closed ${event.code}` +
        (reasonText
          ? ` · ${reasonText}`
          : "");
    }

    broadcastMarineStatus();

    if (!shuttingDown) {
      aisReconnectTimer = setTimeout(
        connectAisStream,
        AISSTREAM_RECONNECT_MS
      );
    }
  });
}

async function fetchDigitrafficMetadata() {
  const response = await fetch(
    DIGITRAFFIC_VESSELS_URL,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "OrihonAirSeaRadar/4.0"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Digitraffic vessels HTTP ${response.status}`
    );
  }

  const records = await response.json();

  if (!Array.isArray(records)) {
    throw new Error(
      "Digitraffic vessels: неожиданный JSON"
    );
  }

  digitrafficMetadata.clear();

  for (const item of records) {
    const mmsi = normalizeMmsi(item?.mmsi);

    if (!mmsi) continue;

    const length =
      (finiteOrNull(item.referencePointA) || 0) +
      (finiteOrNull(item.referencePointB) || 0);

    const width =
      (finiteOrNull(item.referencePointC) || 0) +
      (finiteOrNull(item.referencePointD) || 0);

    const metadata = {
      name: cleanAisText(item.name),
      callSign: cleanAisText(item.callSign),
      imo: finiteOrNull(item.imo),
      shipType: finiteOrNull(item.shipType),
      destination: cleanAisText(item.destination),
      draught:
        finiteOrNull(item.draught) !== null
          ? finiteOrNull(item.draught) / 10
          : null,
      length: length || null,
      width: width || null,
      eta: item.eta ?? null,
      metadataUpdatedAt:
        finiteOrNull(item.timestamp) || Date.now()
    };

    digitrafficMetadata.set(mmsi, metadata);

    if (vesselStore.has(mmsi)) {
      upsertVessel(
        { mmsi, ...metadata },
        "Digitraffic"
      );
    }
  }
}

async function fetchDigitrafficLocations() {
  const response = await fetch(
    DIGITRAFFIC_LOCATIONS_URL,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "OrihonAirSeaRadar/4.0"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Digitraffic locations HTTP ${response.status}`
    );
  }

  const payload = await response.json();
  const features = payload?.features;

  if (!Array.isArray(features)) {
    throw new Error(
      "Digitraffic locations: неожиданный GeoJSON"
    );
  }

  let count = 0;

  for (const feature of features) {
    const coordinates = feature?.geometry?.coordinates;
    const properties = feature?.properties || {};
    const mmsi = normalizeMmsi(
      feature?.mmsi ?? properties.mmsi
    );

    if (
      !mmsi ||
      !Array.isArray(coordinates) ||
      coordinates.length < 2
    ) {
      continue;
    }

    const metadata =
      digitrafficMetadata.get(mmsi) || {};

    upsertVessel(
      {
        mmsi,
        lon: coordinates[0],
        lat: coordinates[1],
        speed: properties.sog,
        course: properties.cog,
        heading: properties.heading,
        rateOfTurn: properties.rot,
        navStatus: properties.navStat,
        positionUpdatedAt:
          finiteOrNull(properties.timestampExternal) ||
          Date.now(),
        ...metadata
      },
      "Digitraffic"
    );

    count += 1;
  }

  marineStatus.digitraffic.connected = true;
  marineStatus.digitraffic.lastMessageAt = Date.now();
  marineStatus.digitraffic.lastError = null;
  marineStatus.digitraffic.vesselCount = count;

  broadcastMarineStatus();
}

async function digitrafficMetadataLoop() {
  if (shuttingDown) return;

  try {
    await fetchDigitrafficMetadata();
  } catch (error) {
    marineStatus.digitraffic.lastError =
      error instanceof Error ? error.message : String(error);

    broadcastMarineStatus();
  } finally {
    if (!shuttingDown) {
      setTimeout(
        digitrafficMetadataLoop,
        DIGITRAFFIC_METADATA_INTERVAL_MS
      );
    }
  }
}

async function digitrafficLocationsLoop() {
  if (shuttingDown) return;

  try {
    await fetchDigitrafficLocations();
  } catch (error) {
    marineStatus.digitraffic.connected = false;
    marineStatus.digitraffic.lastError =
      error instanceof Error ? error.message : String(error);

    broadcastMarineStatus();
  } finally {
    if (!shuttingDown) {
      setTimeout(
        digitrafficLocationsLoop,
        DIGITRAFFIC_LOCATION_INTERVAL_MS
      );
    }
  }
}

let barentsAbortController = null;

async function getBarentsWatchToken() {
  const body = new URLSearchParams({
    client_id: BARENTSWATCH_CLIENT_ID,
    client_secret: BARENTSWATCH_CLIENT_SECRET,
    scope: "ais",
    grant_type: "client_credentials"
  });

  const response = await fetch(
    "https://id.barentswatch.no/connect/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `BarentsWatch token HTTP ${response.status}` +
      (text ? ` · ${compactText(text)}` : "")
    );
  }

  const payload = await response.json();

  if (
    !payload ||
    typeof payload.access_token !== "string"
  ) {
    throw new Error(
      "BarentsWatch token: access_token отсутствует"
    );
  }

  return payload.access_token;
}

function handleBarentsRecord(item) {
  if (!item || typeof item !== "object") return;

  const timestamp = Date.parse(item.msgtime);

  upsertVessel(
    {
      mmsi: item.mmsi,
      lat: item.latitude,
      lon: item.longitude,
      speed: item.speedOverGround,
      course: item.courseOverGround,
      heading: item.trueHeading,
      rateOfTurn: item.rateOfTurn,
      navStatus: item.navigationalStatus,
      name: item.name,
      callSign: item.callSign,
      imo: finiteOrNull(item.imoNumber),
      shipType: finiteOrNull(item.shipType),
      destination: item.destination,
      draught:
        finiteOrNull(item.draught) !== null
          ? finiteOrNull(item.draught) / 10
          : null,
      length: finiteOrNull(item.shipLength),
      width: finiteOrNull(item.shipWidth),
      eta: item.eta ?? null,
      positionUpdatedAt:
        Number.isFinite(timestamp)
          ? timestamp
          : Date.now(),
      metadataUpdatedAt:
        Number.isFinite(timestamp)
          ? timestamp
          : Date.now()
    },
    "BarentsWatch"
  );

  marineStatus.barentswatch.lastMessageAt = Date.now();
  marineStatus.barentswatch.lastError = null;
}

async function consumeNdjson(response, signal) {
  if (!response.body) {
    throw new Error(
      "BarentsWatch stream: response body отсутствует"
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (!signal.aborted) {
    const { done, value } = await reader.read();

    if (done) break;

    buffer += decoder.decode(
      value,
      { stream: true }
    );

    let newlineIndex;

    while (
      (newlineIndex = buffer.indexOf("\n")) >= 0
    ) {
      const line =
        buffer.slice(0, newlineIndex).trim();

      buffer =
        buffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        handleBarentsRecord(
          JSON.parse(line)
        );
      } catch {
        // Ignore malformed partial records.
      }
    }
  }
}

async function connectBarentsWatch() {
  if (
    shuttingDown ||
    !marineStatus.barentswatch.configured
  ) {
    return;
  }

  try {
    const token =
      await getBarentsWatchToken();

    barentsAbortController =
      new AbortController();

    const response = await fetch(
      "https://live.ais.barentswatch.no/v1/combined?modelType=Full",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        },
        signal:
          barentsAbortController.signal
      }
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `BarentsWatch stream HTTP ${response.status}` +
        (text ? ` · ${compactText(text)}` : "")
      );
    }

    marineStatus.barentswatch.connected = true;
    marineStatus.barentswatch.lastError = null;
    broadcastMarineStatus();

    await consumeNdjson(
      response,
      barentsAbortController.signal
    );

    if (!shuttingDown) {
      throw new Error(
        "BarentsWatch stream завершился"
      );
    }
  } catch (error) {
    if (shuttingDown) return;

    marineStatus.barentswatch.connected = false;
    marineStatus.barentswatch.lastError =
      error instanceof Error ? error.message : String(error);

    broadcastMarineStatus();

    setTimeout(
      connectBarentsWatch,
      BARENTSWATCH_RECONNECT_MS
    );
  }
}

function cleanupVessels() {
  const now = Date.now();

  for (const [mmsi, vessel] of vesselStore) {
    if (
      !vessel.positionUpdatedAt ||
      now - vessel.positionUpdatedAt >
      VESSEL_STALE_MS
    ) {
      vesselStore.delete(mmsi);
    }
  }

  broadcastMarineStatus();
}

setInterval(
  cleanupVessels,
  60_000
).unref?.();



function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseNumber(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < min || number > max) {
    return null;
  }

  return number;
}

function json(res, statusCode, data, headers = {}) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers
  });

  res.end(body);
}

function compactText(value, maxLength = 350) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function fetchJson(url, providerName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; OrihonAircraftRadar/2.0)"
      },
      redirect: "follow",
      signal: controller.signal
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `${providerName} HTTP ${response.status}` +
          (text ? ` · ${compactText(text)}` : "")
      );
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${providerName} вернул не JSON · ${compactText(text)}`);
    }

    if (!data || !Array.isArray(data.ac)) {
      throw new Error(`${providerName} вернул JSON без массива ac`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestProvider(provider, lat, lon) {
  const state = providerState.get(provider.name);

  if (Date.now() < state.disabledUntil) {
    throw new Error(
      `${provider.name} временно пропущен после ошибки: ${state.lastError || "upstream error"}`
    );
  }

  const run = async () => {
    const elapsed = Date.now() - state.lastStartedAt;

    if (elapsed < provider.minIntervalMs) {
      await sleep(provider.minIntervalMs - elapsed);
    }

    state.lastStartedAt = Date.now();
    const url = provider.buildUrl(lat, lon);
    const startedAt = Date.now();

    console.log(`[${new Date().toISOString()}] ${provider.name} → ${url}`);

    try {
      const data = await fetchJson(url, provider.name);
      state.disabledUntil = 0;
      state.lastError = null;

      console.log(
        `[${new Date().toISOString()}] ${provider.name} ✓ ${data.ac.length} aircraft · ${Date.now() - startedAt} ms`
      );

      return data;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      state.disabledUntil = Date.now() + 15_000;
      throw error;
    }
  };

  const result = state.queue.then(run, run);

  state.queue = result.then(
    () => undefined,
    () => undefined
  );

  return result;
}

async function fetchTile(cell) {
  const errors = [];

  for (const provider of PROVIDERS) {
    try {
      const data = await requestProvider(provider, cell.lat, cell.lon);

      const entry = {
        key: cell.key,
        lat: cell.lat,
        lon: cell.lon,
        fetchedAt: Date.now(),
        provider: provider.name,
        aircraft: data.ac
      };

      tileCache.set(cell.key, entry);
      return entry;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${provider.name}: ${message}`);
      console.error(`[${new Date().toISOString()}] ${provider.name} ✗ ${message}`);
    }
  }

  throw new Error(errors.join(" | ") || "Все ADS-B провайдеры недоступны");
}

function longitudeSpacingDeg(lat) {
  const cosLat = Math.max(0.18, Math.cos((lat * Math.PI) / 180));
  return TILE_HORIZONTAL_SPACING_NM / (60 * cosLat);
}

function buildCoverageCells(bounds) {
  const south = clamp(bounds.south - 1.5, -80, 80);
  const north = clamp(bounds.north + 1.5, -80, 80);
  const west = clamp(bounds.west - 2.5, -180, 180);
  const east = clamp(bounds.east + 2.5, -180, 180);

  const cells = [];
  const firstRow = Math.floor((south + 90) / TILE_VERTICAL_SPACING_DEG) - 1;
  const lastRow = Math.ceil((north + 90) / TILE_VERTICAL_SPACING_DEG) + 1;

  for (let row = firstRow; row <= lastRow; row += 1) {
    const lat = -90 + (row + 0.5) * TILE_VERTICAL_SPACING_DEG;

    if (lat < south - 5 || lat > north + 5 || lat <= -85 || lat >= 85) {
      continue;
    }

    const lonStep = longitudeSpacingDeg(lat);
    const rowOffset = row % 2 === 0 ? 0 : lonStep / 2;
    const firstCol = Math.floor((west + 180 - rowOffset) / lonStep) - 1;
    const lastCol = Math.ceil((east + 180 - rowOffset) / lonStep) + 1;

    for (let col = firstCol; col <= lastCol; col += 1) {
      let lon = -180 + rowOffset + (col + 0.5) * lonStep;

      while (lon < -180) lon += 360;
      while (lon > 180) lon -= 360;

      if (lon < west - lonStep || lon > east + lonStep) {
        continue;
      }

      const key = `r${row}:c${col}`;
      cells.push({ key, row, col, lat, lon });
    }
  }

  const centerLat = (south + north) / 2;
  const centerLon = (west + east) / 2;

  cells.sort((a, b) => {
    const da = (a.lat - centerLat) ** 2 + ((a.lon - centerLon) * Math.cos((centerLat * Math.PI) / 180)) ** 2;
    const db = (b.lat - centerLat) ** 2 + ((b.lon - centerLon) * Math.cos((centerLat * Math.PI) / 180)) ** 2;
    return da - db;
  });

  return cells.slice(0, MAX_CELLS_PER_VIEW);
}

function effectiveSeenSeconds(ac, cacheEntry, now) {
  const upstreamSeen = Number.isFinite(Number(ac.seen_pos))
    ? Number(ac.seen_pos)
    : Number.isFinite(Number(ac.seen))
      ? Number(ac.seen)
      : 0;

  return Math.max(0, upstreamSeen + (now - cacheEntry.fetchedAt) / 1000);
}

function mergeCachedAircraft(cells) {
  const now = Date.now();
  const merged = new Map();
  const providers = new Map();
  let oldestTileAgeMs = 0;
  let availableCells = 0;

  for (const cell of cells) {
    const entry = tileCache.get(cell.key);

    if (!entry) continue;

    const tileAgeMs = now - entry.fetchedAt;

    if (tileAgeMs > CACHE_MAX_AGE_MS) {
      continue;
    }

    availableCells += 1;
    oldestTileAgeMs = Math.max(oldestTileAgeMs, tileAgeMs);
    providers.set(entry.provider, (providers.get(entry.provider) || 0) + 1);

    for (const ac of entry.aircraft) {
      if (!ac || typeof ac.hex !== "string") continue;
      if (!Number.isFinite(Number(ac.lat)) || !Number.isFinite(Number(ac.lon))) continue;

      const seen = effectiveSeenSeconds(ac, entry, now);
      if (seen > MAX_AIRCRAFT_AGE_SEC) continue;

      const id = ac.hex.toLowerCase();
      const existing = merged.get(id);

      if (!existing || seen < existing.seen_pos) {
        merged.set(id, {
          ...ac,
          seen_pos: seen,
          _provider: entry.provider
        });
      }
    }
  }

  return {
    aircraft: Array.from(merged.values()),
    availableCells,
    oldestTileAgeMs,
    providers: Object.fromEntries(providers)
  };
}

async function refreshCoverageCells(cells) {
  const now = Date.now();

  const stale = cells
    .filter((cell) => {
      const entry = tileCache.get(cell.key);
      return !entry || now - entry.fetchedAt > CACHE_FRESH_MS;
    })
    .sort((a, b) => {
      const entryA = tileCache.get(a.key);
      const entryB = tileCache.get(b.key);

      if (!entryA && entryB) return -1;
      if (entryA && !entryB) return 1;
      if (!entryA && !entryB) return 0;

      return entryA.fetchedAt - entryB.fetchedAt;
    })
    .slice(0, MAX_REFRESH_TILES_PER_REQUEST);

  const refreshed = [];
  const failures = [];

  for (const cell of stale) {
    try {
      const entry = await fetchTile(cell);
      refreshed.push(entry.key);
    } catch (error) {
      failures.push({
        key: cell.key,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { refreshed, failures };
}

function validateBounds(url) {
  const west = parseNumber(url.searchParams.get("west"), -180, 180);
  const south = parseNumber(url.searchParams.get("south"), -85, 85);
  const east = parseNumber(url.searchParams.get("east"), -180, 180);
  const north = parseNumber(url.searchParams.get("north"), -85, 85);

  if ([west, south, east, north].some((value) => value === null)) {
    return null;
  }

  if (south >= north || west >= east) {
    return null;
  }

  return { west, south, east, north };
}

async function handleAircraftApi(res, url) {
  const bounds = validateBounds(url);

  if (!bounds) {
    json(res, 400, {
      error: "Нужны west/south/east/north с west < east и south < north"
    });
    return;
  }

  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;

  if (lonSpan > 120 || latSpan > 70) {
    json(res, 400, {
      error: "Слишком большая область. Увеличьте масштаб карты. Максимум 120° × 70°."
    });
    return;
  }

  const cells = buildCoverageCells(bounds);
  const before = mergeCachedAircraft(cells);
  const refresh = await refreshCoverageCells(cells);
  const after = mergeCachedAircraft(cells);

  if (after.availableCells === 0 && refresh.failures.length > 0) {
    json(res, 502, {
      error: "Не удалось загрузить ни одной ADS-B области",
      details: refresh.failures.map((item) => item.error).join(" | ")
    });
    return;
  }

  json(res, 200, {
    ac: after.aircraft,
    coverage: {
      totalCells: cells.length,
      availableCells: after.availableCells,
      refreshedCells: refresh.refreshed.length,
      failedCells: refresh.failures.length,
      oldestTileAgeSec: Math.round(after.oldestTileAgeMs / 1000),
      providers: after.providers,
      previousAircraftCount: before.aircraft.length
    }
  });
}

async function handleStatic(res, url) {
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
    res.end();
    return;
  }

  if (url.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      providers: PROVIDERS.map((provider) => provider.name),
      cachedCells: tileCache.size,
      marine: {
        status: marineStatus,
        vessels: vesselStore.size
      },
      time: new Date().toISOString()
    });
    return;
  }

  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    json(res, 404, { error: "Not found" });
    return;
  }

  const body = await fs.readFile(path.join(__dirname, "index.html"));

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);

    if (url.pathname === "/api/aircraft") {
      await handleAircraftApi(res, url);
      return;
    }

    if (url.pathname === "/api/vessels-stream") {
      handleVesselStream(req, res, url);
      return;
    }

    await handleStatic(res, url);
  } catch (error) {
    console.error("[server]", error);
    json(res, 500, {
      error: "Internal server error",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

function handleVesselStream(req, res, url) {
  const viewport = sanitizeViewport({
    west: url.searchParams.get("west"),
    south: url.searchParams.get("south"),
    east: url.searchParams.get("east"),
    north: url.searchParams.get("north")
  });

  if (!viewport) {
    json(res, 400, {
      error:
        "Нужны корректные west/south/east/north"
    });

    return;
  }

  res.writeHead(200, {
    "Content-Type":
      "text/event-stream; charset=utf-8",
    "Cache-Control":
      "no-cache, no-transform",
    "Connection":
      "keep-alive",
    "X-Accel-Buffering":
      "no"
  });

  res.write(
    ": connected\n\n"
  );

  const client = {
    res,
    viewport,
    closed: false
  };

  realtimeClients.add(client);

  sendSse(client, {
    type: "hello",
    marine: {
      status: marineStatus,
      vessels: vesselStore.size
    }
  });

  sendVesselSnapshot(client);
  scheduleAisSubscriptionUpdate();

  const heartbeat = setInterval(() => {
    if (
      client.closed ||
      res.destroyed
    ) {
      return;
    }

    try {
      res.write(
        `: ping ${Date.now()}\n\n`
      );
    } catch {
      client.closed = true;
    }
  }, 20_000);

  req.on("close", () => {
    client.closed = true;
    clearInterval(heartbeat);
    realtimeClients.delete(client);
    scheduleAisSubscriptionUpdate();
  });
}

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("Orihon Air + Sea Radar v4 запущен.");
  console.log(`Откройте: http://${HOST}:${PORT}`);
  console.log(`Health:   http://${HOST}:${PORT}/api/health`);
  console.log("");
  console.log(`ADS-B point radius: ${POINT_RADIUS_NM} NM`);
  console.log(`ADS-B refresh cells/request: ${MAX_REFRESH_TILES_PER_REQUEST}`);
  console.log("");
  console.log(
    `AISStream: ${
      AISSTREAM_API_KEY
        ? "configured"
        : "без ключа — отключён"
    }`
  );
  console.log("Digitraffic: включён без ключа");
  console.log(
    `BarentsWatch: ${
      marineStatus.barentswatch.configured
        ? "configured"
        : "без credentials — отключён"
    }`
  );
  console.log("");

  digitrafficMetadataLoop();
  digitrafficLocationsLoop();
  connectAisStream();
  connectBarentsWatch();
});

process.on("SIGINT", () => {
  console.log("\nОстановка сервера…");
  shuttingDown = true;

  clearTimeout(aisReconnectTimer);
  clearTimeout(aisSubscriptionTimer);

  if (aisStreamSocket) {
    try {
      aisStreamSocket.close(1000);
    } catch {}
  }

  if (barentsAbortController) {
    try {
      barentsAbortController.abort();
    } catch {}
  }

  for (const client of realtimeClients) {
    client.closed = true;

    try {
      client.res.end();
    } catch {}
  }

  realtimeClients.clear();

  server.close(() => {
    process.exit(0);
  });
});
