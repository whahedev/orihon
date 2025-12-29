import fs from "node:fs/promises";
import path from "node:path";

const API_BASE =
  process.env.YANDEX_RASP_API_BASE ||
  "https://api.rasp.yandex-net.ru/v3.0";

const API_KEY =
  process.env.YANDEX_RASP_API_KEY || "";

const CACHE_DIR =
  path.resolve(
    process.env.TRAIN_CACHE_DIR ||
    "./train-cache"
  );

const RUNS_PATH =
  path.join(
    CACHE_DIR,
    "runs.json"
  );

const STATIONS_PATH =
  path.join(
    CACHE_DIR,
    "yandex-stations.json"
  );

const ROUTES_DIR =
  path.join(
    CACHE_DIR,
    "routes"
  );

const OSM_DUMPS_DIR =
  path.join(
    CACHE_DIR,
    "osm-relations"
  );

const ACTIVE_INDEX_PATH =
  path.join(
    CACHE_DIR,
    "active-index.json"
  );

const ACTIVE_INDEX_TTL_MS =
  20 * 60 * 1000;

const ROUTE_SEARCH_TTL_MS =
  10 * 60 * 1000;

const ACTIVE_BOARD_LIMIT = 24;
const ACTIVE_THREAD_LIMIT = 180;

const routeSearchMemoryCache =
  new Map();

let activeIndexPromise = null;
let activeIndexState = {
  refreshing: false,
  startedAt: null,
  finishedAt: null,
  boardCount: 0,
  candidateCount: 0,
  activeCount: 0,
  error: null
};

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

const FETCH_TIMEOUT_MS = 180_000;
const CORRIDOR_RADIUS_METERS = 28_000;
const SNAP_RADIUS_KM = 15;
const SNAP_CANDIDATES = 12;
const SIMPLIFY_TOLERANCE_METERS = 14;

const CYR_TO_LAT = {
  "А":"A","Б":"B","В":"V","Г":"G","Д":"D","Е":"E","Ё":"E",
  "Ж":"ZH","З":"Z","И":"I","Й":"Y","К":"K","Л":"L","М":"M",
  "Н":"N","О":"O","П":"P","Р":"R","С":"S","Т":"T","У":"U",
  "Ф":"F","Х":"H","Ц":"C","Ч":"CH","Ш":"SH","Щ":"SCH","Ъ":"",
  "Ы":"Y","Ь":"","Э":"E","Ю":"YU","Я":"YA"
};

function normalizeTrainNumber(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function latinTrainNumber(value) {
  return [...normalizeTrainNumber(value)]
    .map((ch) => CYR_TO_LAT[ch] ?? ch)
    .join("");
}

function safeId(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_.-]+/g, "_")
    .slice(0, 180);
}

function yandexUidForTrain(number) {
  return `R_${latinTrainNumber(number)}_112`;
}


const LAT_TO_CYR_TRAIN = [
  ["SCH", "Щ"],
  ["ZH", "Ж"],
  ["CH", "Ч"],
  ["SH", "Ш"],
  ["YU", "Ю"],
  ["YA", "Я"],
  ["A", "А"],
  ["B", "Б"],
  ["V", "В"],
  ["G", "Г"],
  ["D", "Д"],
  ["E", "Е"],
  ["Z", "З"],
  ["I", "И"],
  ["Y", "Й"],
  ["K", "К"],
  ["L", "Л"],
  ["M", "М"],
  ["N", "Н"],
  ["O", "О"],
  ["P", "П"],
  ["R", "Р"],
  ["S", "С"],
  ["T", "Т"],
  ["U", "У"],
  ["F", "Ф"],
  ["H", "Х"],
  ["C", "Ц"]
];

function trainNumberFromUid(uid) {
  const match =
    String(uid || "").match(
      /^R_(\d{1,3})([A-Z]+)_\d+/i
    );

  if (!match) {
    return null;
  }

  let suffix =
    match[2].toUpperCase();

  let cyr = "";

  while (suffix.length) {
    let consumed = false;

    for (const [latin, letter] of LAT_TO_CYR_TRAIN) {
      if (suffix.startsWith(latin)) {
        cyr += letter;
        suffix = suffix.slice(latin.length);
        consumed = true;
        break;
      }
    }

    if (!consumed) {
      cyr += suffix[0];
      suffix = suffix.slice(1);
    }
  }

  return normalizeTrainNumber(
    `${match[1]}${cyr}`
  );
}

function addIsoDaysLocal(
  isoDate,
  days
) {
  const date =
    new Date(
      `${isoDate}T12:00:00Z`
    );

  date.setUTCDate(
    date.getUTCDate() + days
  );

  return date
    .toISOString()
    .slice(0, 10);
}

function isoDateAtOffset(
  ms,
  offsetMinutes = 180
) {
  return new Date(
    ms +
    offsetMinutes *
      60_000
  )
    .toISOString()
    .slice(0, 10);
}

function moscowIsoDate(
  ms = Date.now()
) {
  return isoDateAtOffset(
    ms,
    180
  );
}

function russianWhen(isoDate) {
  const months = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря"
  ];

  const [
    year,
    month,
    day
  ] =
    isoDate
      .split("-")
      .map(Number);

  return (
    `${day} ` +
    `${months[month - 1]} ` +
    `${year}`
  );
}

function decodeHtmlUrl(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

async function fetchPublicHtml(
  url,
  timeoutMs = 25_000
) {
  const response =
    await timedFetch(
      url,
      {
        headers: {
          Accept:
            "text/html,application/xhtml+xml",
          "Accept-Language":
            "ru-RU,ru;q=0.9,en;q=0.4",
          "Cache-Control":
            "no-cache",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36"
        }
      },
      timeoutMs
    );

  const html =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Public timetable HTTP ${response.status}`
    );
  }

  if (
    /captcha|smartcaptcha|я\s+не\s+робот|подтвердите,\s+что\s+вы\s+не\s+робот/i.test(
      htmlToText(html)
    )
  ) {
    throw new Error(
      "Публичная страница потребовала CAPTCHA"
    );
  }

  return {
    html,
    finalUrl:
      response.url
  };
}

function extractThreadLinks(
  html,
  baseUrl,
  fallbackDate = null
) {
  const source =
    String(html || "");

  const results =
    new Map();

  const regex =
    /<a\b[^>]*href=["']([^"']*\/thread\/(R_[A-Z0-9_]+)[^"']*)["'][^>]*>/gi;

  for (
    const match of
    source.matchAll(regex)
  ) {
    const rawHref =
      decodeHtmlUrl(
        match[1]
      );

    let url;

    try {
      url =
        new URL(
          rawHref,
          baseUrl
        );
    } catch {
      continue;
    }

    const uid =
      match[2];

    const number =
      trainNumberFromUid(
        uid
      );

    if (!number) {
      continue;
    }

    const departure =
      url.searchParams.get(
        "departure"
      ) ||
      url.searchParams.get(
        "date"
      ) ||
      fallbackDate;

    const key =
      `${uid}|${departure || ""}`;

    if (
      !results.has(key)
    ) {
      results.set(
        key,
        {
          uid,
          number,
          departureDate:
            departure,
          url:
            url.toString()
        }
      );
    }
  }

  return [...results.values()];
}

function stopMatchesQuery(
  stopName,
  query
) {
  const stop =
    normalizeName(
      stopName
    );

  const wanted =
    normalizeName(
      query
    );

  if (
    !stop ||
    !wanted
  ) {
    return false;
  }

  return (
    stop === wanted ||
    stop.includes(
      wanted
    ) ||
    wanted.includes(
      stop
    )
  );
}

function segmentForQueries(
  run,
  fromQuery,
  toQuery
) {
  let fromIndex = -1;

  for (
    let i = 0;
    i <
    run.stops.length;
    i++
  ) {
    if (
      stopMatchesQuery(
        run.stops[i].name,
        fromQuery
      )
    ) {
      fromIndex = i;
      break;
    }
  }

  if (fromIndex < 0) {
    return null;
  }

  let toIndex = -1;

  for (
    let i =
      fromIndex + 1;
    i <
    run.stops.length;
    i++
  ) {
    if (
      stopMatchesQuery(
        run.stops[i].name,
        toQuery
      )
    ) {
      toIndex = i;
      break;
    }
  }

  if (toIndex < 0) {
    return null;
  }

  const from =
    run.stops[
      fromIndex
    ];

  const to =
    run.stops[
      toIndex
    ];

  return {
    fromIndex,
    toIndex,
    fromStop:
      from.name,
    toStop:
      to.name,
    departureMs:
      from.departureMs ??
      from.arrivalMs,
    arrivalMs:
      to.arrivalMs ??
      to.departureMs,
    departureLocal:
      from.departureLocal ??
      null,
    arrivalLocal:
      to.arrivalLocal ??
      null,
    departureDateLocal:
      from.departureDateLocal ??
      (
        Number.isFinite(
          from.departureMs
        )
          ? isoDateAtOffset(
              from.departureMs,
              Number.isFinite(
                from.timezoneOffsetMinutes
              )
                ? from.timezoneOffsetMinutes
                : 180
            )
          : null
      ),
    arrivalDateLocal:
      to.arrivalDateLocal ??
      (
        Number.isFinite(
          to.arrivalMs
        )
          ? isoDateAtOffset(
              to.arrivalMs,
              Number.isFinite(
                to.timezoneOffsetMinutes
              )
                ? to.timezoneOffsetMinutes
                : 180
            )
          : null
      )
  };
}

function runSummaryForSegment(
  run,
  segment,
  now
) {
  const activeNow =
    Number.isFinite(
      run.departureMs
    ) &&
    Number.isFinite(
      run.arrivalMs
    ) &&
    now >=
      run.departureMs &&
    now <
      run.arrivalMs;

  const completed =
    Number.isFinite(
      run.arrivalMs
    ) &&
    now >=
      run.arrivalMs;

  return {
    runId:
      run.runId,
    number:
      run.number,
    uid:
      run.uid,
    title:
      run.title,
    from:
      run.from,
    to:
      run.to,
    serviceDate:
      run.serviceDate,
    departureMs:
      run.departureMs,
    arrivalMs:
      run.arrivalMs,
    totalMinutes:
      run.totalMinutes,
    carrier:
      run.carrier,
    source:
      run.source,
    activeNow,
    completed,
    segment
  };
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\*/g, " ")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function htmlToText(value) {
  return String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:td|th|tr|div|p|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&laquo;|&#171;/gi, "«")
    .replace(/&raquo;|&#187;/gi, "»")
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function ensureDirs() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(ROUTES_DIR, { recursive: true });
  await fs.mkdir(OSM_DUMPS_DIR, { recursive: true });
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(
      await fs.readFile(
        file,
        "utf8"
      )
    );
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(
    file,
    JSON.stringify(value),
    "utf8"
  );
}

async function timedFetch(
  url,
  options = {},
  timeoutMs = FETCH_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function yandexJson(endpoint, params) {
  if (!API_KEY) {
    const error =
      new Error(
        "Для универсального поиска нужен YANDEX_RASP_API_KEY"
      );
    error.code = "YANDEX_KEY_REQUIRED";
    throw error;
  }

  const url =
    new URL(
      `${API_BASE}/${endpoint.replace(/^\/+/, "")}`
    );

  for (
    const [key, value] of
    Object.entries(params || {})
  ) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(
        key,
        String(value)
      );
    }
  }

  url.searchParams.set(
    "format",
    "json"
  );

  url.searchParams.set(
    "lang",
    "ru_RU"
  );

  const response =
    await timedFetch(
      url,
      {
        headers: {
          Accept:
            "application/json",
          Authorization:
            API_KEY,
          "User-Agent":
            "Orihon-RZD-MultiTrain/2.0"
        }
      }
    );

  const text =
    await response.text();

  let payload = null;

  try {
    payload =
      JSON.parse(text);
  } catch {}

  if (!response.ok) {
    const error =
      new Error(
        payload?.error?.text ||
        payload?.error ||
        `Yandex Rasp HTTP ${response.status}: ${text.slice(0, 300)}`
      );
    error.status =
      response.status;
    throw error;
  }

  return payload;
}

async function stationIndex() {
  await ensureDirs();

  const cached =
    await readJson(
      STATIONS_PATH
    );

  if (
    cached &&
    cached.version === 1 &&
    cached.stations
  ) {
    return cached.stations;
  }

  const payload =
    await yandexJson(
      "stations_list/",
      {}
    );

  const stations = {};

  for (
    const country of
    payload?.countries || []
  ) {
    for (
      const region of
      country?.regions || []
    ) {
      for (
        const settlement of
        region?.settlements || []
      ) {
        for (
          const station of
          settlement?.stations || []
        ) {
          const code =
            station?.codes?.yandex_code;

          if (!code) continue;

          stations[code] = {
            code,
            title:
              station.title || "",
            lat:
              Number(
                station.latitude
              ),
            lon:
              Number(
                station.longitude
              ),
            esr:
              station?.codes?.esr_code ||
              null,
            settlement:
              settlement?.title ||
              "",
            region:
              region?.title ||
              ""
          };
        }
      }
    }
  }

  await writeJson(
    STATIONS_PATH,
    {
      version: 1,
      generatedAt:
        new Date().toISOString(),
      stations
    }
  );

  return stations;
}

function minutesBetween(a, b) {
  return Math.round(
    (b - a) / 60_000
  );
}

function parseAbsolute(value) {
  if (!value) return null;
  const ms =
    Date.parse(value);
  return Number.isFinite(ms)
    ? ms
    : null;
}

function clockFromIso(value) {
  const match =
    String(value || "").match(
      /T(\d{2}:\d{2})/
    );

  return match
    ? match[1]
    : null;
}

function dateFromIso(value) {
  const match =
    String(value || "").match(
      /^(\d{4}-\d{2}-\d{2})/
    );

  return match
    ? match[1]
    : null;
}

function makeRunId(
  number,
  date,
  uid
) {
  return safeId(
    `${normalizeTrainNumber(number)}__${date}__${uid}`
  );
}

async function normalizeThread(
  thread,
  requestedDate,
  source = "yandex-api"
) {
  const stationMap =
    API_KEY
      ? await stationIndex()
      : {};

  const rawStops =
    Array.isArray(thread?.stops)
      ? thread.stops
      : [];

  if (rawStops.length < 2) {
    throw new Error(
      "Источник не вернул полный список остановок"
    );
  }

  const departureMs =
    parseAbsolute(
      rawStops[0]?.departure ||
      rawStops[0]?.arrival
    );

  const arrivalMs =
    parseAbsolute(
      rawStops[
        rawStops.length - 1
      ]?.arrival ||
      rawStops[
        rawStops.length - 1
      ]?.departure
    );

  if (
    !Number.isFinite(
      departureMs
    ) ||
    !Number.isFinite(
      arrivalMs
    )
  ) {
    throw new Error(
      "В расписании нет абсолютного времени отправления/прибытия"
    );
  }

  const stops =
    rawStops.map(
      (item, index) => {
        const station =
          item.station || {};

        const code =
          station.code ||
          station?.codes?.yandex ||
          null;

        const compact =
          stationMap[code] ||
          null;

        const arrival =
          parseAbsolute(
            item.arrival
          );

        const departure =
          parseAbsolute(
            item.departure
          );

        return {
          name:
            station.title ||
            station.popular_title ||
            station.short_title ||
            `Станция ${index + 1}`,
          code,
          codes: {
            yandex:
              station?.codes?.yandex ||
              code ||
              null,
            express:
              station?.codes?.express ||
              null,
            esr:
              station?.codes?.esr ||
              compact?.esr ||
              null
          },
          lat:
            Number.isFinite(
              compact?.lat
            )
              ? compact.lat
              : null,
          lon:
            Number.isFinite(
              compact?.lon
            )
              ? compact.lon
              : null,
          arr:
            arrival === null
              ? null
              : minutesBetween(
                  departureMs,
                  arrival
                ),
          dep:
            departure === null
              ? null
              : minutesBetween(
                  departureMs,
                  departure
                ),
          arrivalMs:
            arrival,
          departureMs:
            departure,
          arrivalLocal:
            clockFromIso(
              item.arrival
            ),
          departureLocal:
            clockFromIso(
              item.departure
            ),
          arrivalDateLocal:
            dateFromIso(
              item.arrival
            ),
          departureDateLocal:
            dateFromIso(
              item.departure
            ),
          stopTimeSeconds:
            Number(
              item.stop_time ||
              0
            ),
          platform:
            item.platform ||
            "",
          major:
            index === 0 ||
            index ===
              rawStops.length - 1
        };
      }
    );

  const number =
    normalizeTrainNumber(
      thread.number
    );

  const uid =
    thread.uid ||
    yandexUidForTrain(
      number
    );

  const serviceDate =
    requestedDate ||
    thread.start_date ||
    dateFromIso(
      rawStops[0]?.departure
    );

  return {
    version: 1,
    runId:
      makeRunId(
        number,
        serviceDate,
        uid
      ),
    number,
    uid,
    title:
      thread.title ||
      `${stops[0].name} — ${stops[stops.length - 1].name}`,
    shortTitle:
      thread.short_title ||
      thread.title ||
      "",
    serviceDate,
    departureMs,
    arrivalMs,
    departureIso:
      rawStops[0]?.departure ||
      null,
    arrivalIso:
      rawStops[
        rawStops.length - 1
      ]?.arrival ||
      null,
    totalMinutes:
      minutesBetween(
        departureMs,
        arrivalMs
      ),
    from:
      stops[0].name,
    to:
      stops[
        stops.length - 1
      ].name,
    carrier:
      thread?.carrier?.title ||
      "РЖД/ФПК",
    transportType:
      thread.transport_type ||
      "train",
    source,
    sourceAttribution:
      "Яндекс Расписания",
    stops,
    routeStatus:
      "pending"
  };
}

async function resolveViaYandexApi(
  number,
  date
) {
  const uid =
    yandexUidForTrain(
      number
    );

  const payload =
    await yandexJson(
      "thread/",
      {
        uid,
        date,
        show_systems:
          "all"
      }
    );

  const actualNumber =
    normalizeTrainNumber(
      payload?.number
    );

  if (
    actualNumber &&
    actualNumber !==
      normalizeTrainNumber(
        number
      )
  ) {
    throw new Error(
      `Нитка ${uid} вернула поезд ${actualNumber}, а запрошен ${number}`
    );
  }

  return normalizeThread(
    payload,
    date,
    "yandex-api"
  );
}

const RU_MONTHS = new Map([
  ["января", 1],
  ["янв.", 1],
  ["янв", 1],
  ["февраля", 2],
  ["февр.", 2],
  ["февр", 2],
  ["марта", 3],
  ["март", 3],
  ["апреля", 4],
  ["апр.", 4],
  ["апр", 4],
  ["мая", 5],
  ["июня", 6],
  ["июнь", 6],
  ["июля", 7],
  ["июль", 7],
  ["августа", 8],
  ["авг.", 8],
  ["авг", 8],
  ["сентября", 9],
  ["сент.", 9],
  ["сент", 9],
  ["октября", 10],
  ["окт.", 10],
  ["окт", 10],
  ["ноября", 11],
  ["нояб.", 11],
  ["нояб", 11],
  ["декабря", 12],
  ["дек.", 12],
  ["дек", 12]
]);

const RU_TIME_OFFSETS = [
  {
    re: /калининградск\w*\s+время/i,
    minutes: 2 * 60
  },
  {
    re: /московск\w*\s+время/i,
    minutes: 3 * 60
  },
  {
    re: /самарск\w*\s+время/i,
    minutes: 4 * 60
  },
  {
    re: /екатеринбургск\w*\s+время/i,
    minutes: 5 * 60
  },
  {
    re: /омск\w*\s+время/i,
    minutes: 6 * 60
  },
  {
    re: /красноярск\w*\s+время/i,
    minutes: 7 * 60
  },
  {
    re: /иркутск\w*\s+время/i,
    minutes: 8 * 60
  },
  {
    re: /якутск\w*\s+время/i,
    minutes: 9 * 60
  },
  {
    re: /владивостокск\w*\s+время/i,
    minutes: 10 * 60
  },
  {
    re: /магаданск\w*\s+время/i,
    minutes: 11 * 60
  },
  {
    re: /сахалинск\w*\s+время/i,
    minutes: 11 * 60
  },
  {
    re: /камчатск\w*\s+время/i,
    minutes: 12 * 60
  }
];

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseRussianDateFromText(
  text,
  fallbackYear
) {
  const source =
    String(text || "")
      .toLowerCase()
      .replace(/\u00a0/g, " ");

  const match =
    source.match(
      /(?:^|\D)(\d{1,2})\s+([а-яё.]+)(?:\s+(\d{4}))?/i
    );

  if (!match) {
    return null;
  }

  const month =
    RU_MONTHS.get(
      match[2]
    );

  if (!month) {
    return null;
  }

  const year =
    Number(
      match[3] ||
      fallbackYear
    );

  return (
    `${year}-` +
    `${pad2(month)}-` +
    `${pad2(Number(match[1]))}`
  );
}

function timezoneOffsetMinutesFromText(
  text,
  fallback = null
) {
  const source =
    String(text || "");

  for (
    const item of
    RU_TIME_OFFSETS
  ) {
    if (
      item.re.test(
        source
      )
    ) {
      return item.minutes;
    }
  }

  return fallback;
}

function offsetString(
  minutes
) {
  const sign =
    minutes < 0
      ? "-"
      : "+";

  const absolute =
    Math.abs(minutes);

  return (
    `${sign}` +
    `${pad2(Math.floor(absolute / 60))}:` +
    `${pad2(absolute % 60)}`
  );
}

function localDateTimeMs(
  dateIso,
  clock,
  offsetMinutes
) {
  if (
    !dateIso ||
    !clock ||
    !Number.isFinite(
      offsetMinutes
    )
  ) {
    return null;
  }

  const ms =
    Date.parse(
      `${dateIso}T${clock}:00${offsetString(offsetMinutes)}`
    );

  return Number.isFinite(ms)
    ? ms
    : null;
}

function clockInCell(value) {
  const match =
    String(value || "")
      .match(
        /(?:^|\D)([0-2]?\d:[0-5]\d)(?=\D|$)/
      );

  if (!match) {
    return null;
  }

  const [
    hh,
    mm
  ] =
    match[1]
      .split(":")
      .map(Number);

  if (hh > 23) {
    return null;
  }

  return (
    `${pad2(hh)}:` +
    `${pad2(mm)}`
  );
}

function parsePublicRows(
  html,
  number,
  date
) {
  const source =
    String(html || "");

  const plain =
    htmlToText(source);

  if (
    /captcha|smartcaptcha|я\s+не\s+робот|подтвердите,\s+что\s+вы\s+не\s+робот/i.test(
      plain
    )
  ) {
    throw new Error(
      "Публичная страница расписания потребовала CAPTCHA"
    );
  }

  const requested =
    normalizeTrainNumber(
      number
    );

  const pageNumbers =
    [
      ...plain.matchAll(
        /(?:поезд[а-яё]*\s+)?(\d{1,3}[А-ЯA-Z]{1,3})(?:\/(\d{1,3}[А-ЯA-Z]{1,3}))?/g
      )
    ]
      .flatMap(
        (match) => [
          match[1],
          match[2]
        ]
      )
      .filter(Boolean)
      .map(
        normalizeTrainNumber
      );

  if (
    pageNumbers.length &&
    !pageNumbers.includes(
      requested
    )
  ) {
    throw new Error(
      `Публичная страница вернула другой поезд: ${Array.from(new Set(pageNumbers)).slice(0, 4).join(", ")}`
    );
  }

  const requestedYear =
    Number(
      date.slice(0, 4)
    );

  const requestedMonth =
    Number(
      date.slice(5, 7)
    );

  const parsed = [];

  const rows =
    [
      ...source.matchAll(
        /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
      )
    ];

  let currentDate =
    null;

  let currentOffsetMinutes =
    null;

  let timezoneWasExplicit =
    false;

  for (
    const rowMatch of
    rows
  ) {
    const row =
      rowMatch[1];

    const rowText =
      htmlToText(row);

    if (!rowText) {
      continue;
    }

    const headingDate =
      parseRussianDateFromText(
        rowText,
        requestedYear
      );

    const headingOffset =
      timezoneOffsetMinutesFromText(
        rowText,
        currentOffsetMinutes
      );

    if (
      headingDate &&
      !/\/station\//i.test(
        row
      )
    ) {
      /*
       * Around New Year a timetable page can contain December and January.
       * If no year is printed, keep the date close to requested service date.
       */
      let adjustedDate =
        headingDate;

      const headingMonth =
        Number(
          adjustedDate.slice(
            5,
            7
          )
        );

      if (
        requestedMonth === 12 &&
        headingMonth === 1
      ) {
        adjustedDate =
          `${requestedYear + 1}${adjustedDate.slice(4)}`;
      } else if (
        requestedMonth === 1 &&
        headingMonth === 12
      ) {
        adjustedDate =
          `${requestedYear - 1}${adjustedDate.slice(4)}`;
      }

      currentDate =
        adjustedDate;
    }

    if (
      headingOffset !==
      null
    ) {
      currentOffsetMinutes =
        headingOffset;

      timezoneWasExplicit =
        true;
    }

    const stationLink =
      row.match(
        /href=["'][^"']*\/station\/(?:s)?(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i
      );

    if (!stationLink) {
      continue;
    }

    const cells =
      [
        ...row.matchAll(
          /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
        )
      ].map(
        (match) =>
          htmlToText(
            match[1]
          )
      );

    const name =
      htmlToText(
        stationLink[2]
      )
        .replace(/\*$/, "")
        .trim();

    if (!name) {
      continue;
    }

    const clocks =
      cells
        .map(
          clockInCell
        )
        .filter(Boolean);

    let arrivalLocal =
      cells.length >= 2
        ? clockInCell(
            cells[1]
          )
        : null;

    let departureLocal =
      cells.length >= 4
        ? clockInCell(
            cells[3]
          )
        : null;

    /*
     * CSS/SSR variants do not always preserve five fixed TD columns.
     * The fallback below uses the number of clocks in the station row.
     */
    if (
      !arrivalLocal &&
      !departureLocal
    ) {
      if (
        parsed.length === 0 &&
        clocks.length
      ) {
        departureLocal =
          clocks[
            clocks.length - 1
          ];
      } else if (
        clocks.length >= 2
      ) {
        arrivalLocal =
          clocks[0];

        departureLocal =
          clocks[
            clocks.length - 1
          ];
      } else if (
        clocks.length === 1
      ) {
        arrivalLocal =
          clocks[0];
      }
    } else if (
      arrivalLocal &&
      !departureLocal &&
      clocks.length >= 2
    ) {
      departureLocal =
        clocks[
          clocks.length - 1
        ];
    }

    parsed.push({
      name,
      yandexNumericCode:
        stationLink[1],
      localDate:
        currentDate,
      offsetMinutes:
        currentOffsetMinutes,
      arrivalLocal,
      departureLocal
    });
  }

  /*
   * Fallback for HTML variants where station links are present but rows are
   * not literal <tr>. Split the source around station anchors and read clocks
   * from the nearby fragment.
   */
  if (
    parsed.length < 2
  ) {
    const stationLinks =
      [
        ...source.matchAll(
          /<a\b[^>]*href=["'][^"']*\/station\/(?:s)?(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi
        )
      ];

    for (
      let i = 0;
      i <
      stationLinks.length;
      i++
    ) {
      const match =
        stationLinks[i];

      const name =
        htmlToText(
          match[2]
        )
          .replace(/\*$/, "")
          .trim();

      if (!name) {
        continue;
      }

      const start =
        match.index || 0;

      const end =
        i + 1 <
          stationLinks.length
          ? stationLinks[
              i + 1
            ].index
          : Math.min(
              source.length,
              start + 1800
            );

      const fragment =
        source.slice(
          Math.max(
            0,
            start - 700
          ),
          end
        );

      const fragmentText =
        htmlToText(
          fragment
        );

      const localDate =
        parseRussianDateFromText(
          fragmentText,
          requestedYear
        ) ||
        (
          parsed[
            parsed.length - 1
          ]?.localDate
        ) ||
        date;

      const offsetMinutes =
        timezoneOffsetMinutesFromText(
          fragmentText,
          parsed[
            parsed.length - 1
          ]?.offsetMinutes ??
          null
        );

      const clocks =
        [
          ...fragmentText.matchAll(
            /(?:^|\D)([0-2]?\d:[0-5]\d)(?=\D|$)/g
          )
        ]
          .map(
            (item) =>
              clockInCell(
                item[1]
              )
          )
          .filter(Boolean);

      let arrivalLocal =
        null;

      let departureLocal =
        null;

      if (
        i === 0 &&
        clocks.length
      ) {
        departureLocal =
          clocks[
            clocks.length - 1
          ];
      } else if (
        clocks.length >= 2
      ) {
        arrivalLocal =
          clocks[
            Math.max(
              0,
              clocks.length - 2
            )
          ];

        departureLocal =
          clocks[
            clocks.length - 1
          ];
      } else if (
        clocks.length === 1
      ) {
        arrivalLocal =
          clocks[0];
      }

      parsed.push({
        name,
        yandexNumericCode:
          match[1],
        localDate,
        offsetMinutes,
        arrivalLocal,
        departureLocal
      });
    }
  }

  const deduped = [];

  for (
    const item of
    parsed
  ) {
    const previous =
      deduped[
        deduped.length - 1
      ];

    if (
      previous &&
      previous.name ===
        item.name &&
      previous.yandexNumericCode ===
        item.yandexNumericCode
    ) {
      continue;
    }

    deduped.push(
      item
    );
  }

  if (
    deduped.length < 2
  ) {
    throw new Error(
      "Не удалось разобрать публичную таблицу маршрута"
    );
  }

  /*
   * If the SSR page did not print per-day headings, infer day rollover from
   * clock order. Moscow (+03) is used only as a last-resort timezone; this is
   * reported in sourceWarning instead of silently claiming exact local time.
   */
  let inferredDate =
    date;

  let inferredOffset =
    3 * 60;

  let previousClockMinutes =
    null;

  let usedTimezoneFallback =
    false;

  let usedDateFallback =
    false;

  function resolveClock(
    item,
    clock
  ) {
    if (!clock) {
      return null;
    }

    const [
      hh,
      mm
    ] =
      clock.split(":")
        .map(Number);

    const minutes =
      hh * 60 + mm;

    let localDate =
      item.localDate ||
      inferredDate;

    if (
      !item.localDate &&
      previousClockMinutes !==
        null &&
      minutes <
        previousClockMinutes -
          8 * 60
    ) {
      const base =
        new Date(
          `${inferredDate}T00:00:00Z`
        );

      base.setUTCDate(
        base.getUTCDate() + 1
      );

      inferredDate =
        base
          .toISOString()
          .slice(0, 10);

      localDate =
        inferredDate;

      usedDateFallback =
        true;
    }

    if (
      item.localDate
    ) {
      inferredDate =
        item.localDate;
    }

    const offset =
      Number.isFinite(
        item.offsetMinutes
      )
        ? item.offsetMinutes
        : inferredOffset;

    if (
      Number.isFinite(
        item.offsetMinutes
      )
    ) {
      inferredOffset =
        item.offsetMinutes;
    } else {
      usedTimezoneFallback =
        true;
    }

    previousClockMinutes =
      minutes;

    return localDateTimeMs(
      localDate,
      clock,
      offset
    );
  }

  const stops =
    deduped.map(
      (item, index) => {
        const arrivalMs =
          resolveClock(
            item,
            item.arrivalLocal
          );

        const departureMs =
          resolveClock(
            item,
            item.departureLocal
          );

        return {
          name:
            item.name,
          code:
            item.yandexNumericCode
              ? `s${item.yandexNumericCode}`
              : null,
          codes: {
            yandex:
              item.yandexNumericCode
                ? `s${item.yandexNumericCode}`
                : null,
            express:
              null,
            esr:
              null
          },
          lat:
            null,
          lon:
            null,
          arr:
            null,
          dep:
            null,
          arrivalMs,
          departureMs,
          arrivalLocal:
            item.arrivalLocal,
          departureLocal:
            item.departureLocal,
          arrivalDateLocal:
            item.localDate ||
            null,
          departureDateLocal:
            item.localDate ||
            null,
          timezoneOffsetMinutes:
            Number.isFinite(
              item.offsetMinutes
            )
              ? item.offsetMinutes
              : null,
          stopTimeSeconds:
            Number.isFinite(
              arrivalMs
            ) &&
            Number.isFinite(
              departureMs
            )
              ? Math.max(
                  0,
                  Math.round(
                    (
                      departureMs -
                      arrivalMs
                    ) /
                    1000
                  )
                )
              : 0,
          platform: "",
          major:
            index === 0 ||
            index ===
              deduped.length - 1
        };
      }
    );

  const departureMs =
    stops[0].departureMs ||
    stops[0].arrivalMs;

  const arrivalMs =
    stops[
      stops.length - 1
    ].arrivalMs ||
    stops[
      stops.length - 1
    ].departureMs;

  if (
    !Number.isFinite(
      departureMs
    ) ||
    !Number.isFinite(
      arrivalMs
    ) ||
    arrivalMs <=
      departureMs
  ) {
    throw new Error(
      "Публичное расписание разобрано, но абсолютные времена рейса некорректны"
    );
  }

  /*
   * A request for a non-running date may cause a public site to show another
   * available variant. Reject it instead of tracking the wrong train run.
   */
  const firstLocalDate =
    deduped[0]
      .localDate;

  if (
    firstLocalDate &&
    firstLocalDate !==
      date
  ) {
    throw new Error(
      `Поезд не подтверждён на ${date}: страница вернула отправление ${firstLocalDate}`
    );
  }

  for (
    const stop of
    stops
  ) {
    stop.arr =
      stop.arrivalMs ===
      null
        ? null
        : minutesBetween(
            departureMs,
            stop.arrivalMs
          );

    stop.dep =
      stop.departureMs ===
      null
        ? null
        : minutesBetween(
            departureMs,
            stop.departureMs
          );
  }

  const warnings = [];

  if (
    !timezoneWasExplicit ||
    usedTimezoneFallback
  ) {
    warnings.push(
      "для части строк публичная страница не указала часовой пояс; применён fallback"
    );
  }

  if (
    usedDateFallback
  ) {
    warnings.push(
      "для части строк дата определена по переходу через полночь"
    );
  }

  return {
    version: 1,
    runId:
      makeRunId(
        number,
        date,
        yandexUidForTrain(
          number
        )
      ),
    number:
      requested,
    uid:
      yandexUidForTrain(
        number
      ),
    title:
      `${stops[0].name} — ${stops[stops.length - 1].name}`,
    shortTitle:
      `${stops[0].name} — ${stops[stops.length - 1].name}`,
    serviceDate:
      date,
    departureMs,
    arrivalMs,
    departureIso:
      new Date(
        departureMs
      ).toISOString(),
    arrivalIso:
      new Date(
        arrivalMs
      ).toISOString(),
    totalMinutes:
      minutesBetween(
        departureMs,
        arrivalMs
      ),
    from:
      stops[0].name,
    to:
      stops[
        stops.length - 1
      ].name,
    carrier:
      "РЖД/ФПК",
    transportType:
      "train",
    source:
      "yandex-public-html",
    sourceAttribution:
      "публичная страница Яндекс Расписаний",
    sourceWarning:
      warnings.length
        ? warnings.join("; ")
        : null,
    stops,
    routeStatus:
      "pending"
  };
}

async function resolveViaPublicPage(
  number,
  date
) {
  const uid =
    yandexUidForTrain(
      number
    );

  const urls = [];

  {
    const url =
      new URL(
        `https://rasp.yandex.ru/thread/${uid}`
      );

    url.searchParams.set(
      "departure",
      date
    );

    urls.push(url);
  }

  {
    const url =
      new URL(
        `https://rasp.yandex.ru/thread/${uid}`
      );

    url.searchParams.set(
      "date",
      date
    );

    urls.push(url);
  }

  const failures = [];

  for (
    const url of
    urls
  ) {
    try {
      const response =
        await timedFetch(
          url,
          {
            headers: {
              Accept:
                "text/html,application/xhtml+xml",
              "Accept-Language":
                "ru-RU,ru;q=0.9",
              "Cache-Control":
                "no-cache",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36"
            }
          },
          20_000
        );

      const html =
        await response.text();

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      return parsePublicRows(
        html,
        normalizeTrainNumber(
          number
        ),
        date
      );
    } catch (error) {
      failures.push(
        `${url.search}: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );
    }
  }

  throw new Error(
    `Публичное расписание недоступно: ${failures.join(" | ")}`
  );
}


async function resolveViaPublicThreadUrl(
  descriptor,
  fallbackDate
) {
  const number =
    normalizeTrainNumber(
      descriptor.number ||
      trainNumberFromUid(
        descriptor.uid
      )
    );

  if (!number) {
    throw new Error(
      "Не удалось определить номер поезда из thread URL"
    );
  }

  const originDate =
    descriptor.departureDate ||
    fallbackDate;

  const {
    html,
    finalUrl
  } =
    await fetchPublicHtml(
      descriptor.url
    );

  const run =
    parsePublicRows(
      html,
      number,
      originDate
    );

  run.uid =
    descriptor.uid ||
    run.uid;

  run.runId =
    makeRunId(
      run.number,
      run.serviceDate,
      run.uid
    );

  run.sourceUrl =
    finalUrl;

  await saveRun(
    run
  );

  return run;
}

function collectStationSuggestions(
  value,
  output = []
) {
  if (
    value === null ||
    value === undefined
  ) {
    return output;
  }

  if (
    Array.isArray(value)
  ) {
    const strings =
      value.filter(
        (item) =>
          typeof item ===
          "string"
      );

    const code =
      strings.find(
        (item) =>
          /^[sc]\d+$/i.test(
            item.trim()
          )
      );

    const names =
      strings.filter(
        (item) =>
          !/^[sc]\d+$/i.test(
            item.trim()
          ) &&
          item.trim().length >= 2
      );

    if (
      code &&
      names.length
    ) {
      const title =
        names.sort(
          (a, b) =>
            b.length -
            a.length
        )[0].trim();

      output.push({
        code:
          code.trim(),
        title
      });
    }

    for (
      const item of
      value
    ) {
      collectStationSuggestions(
        item,
        output
      );
    }

    return output;
  }

  if (
    typeof value ===
    "object"
  ) {
    const code =
      value.code ||
      value.id ||
      value.point_key ||
      value.pointKey ||
      value.yandex_code ||
      value.yandexCode;

    const title =
      value.title ||
      value.name ||
      value.full_title ||
      value.fullTitle ||
      value.label ||
      value.text;

    if (
      typeof code ===
        "string" &&
      /^[sc]\d+$/i.test(
        code.trim()
      ) &&
      typeof title ===
        "string" &&
      title.trim().length >= 2
    ) {
      output.push({
        code:
          code.trim(),
        title:
          title.trim()
      });
    }

    for (
      const child of
      Object.values(value)
    ) {
      collectStationSuggestions(
        child,
        output
      );
    }
  }

  return output;
}

async function suggestStations(
  query
) {
  const part =
    String(query || "")
      .trim();

  if (
    part.length < 2
  ) {
    return [];
  }

  const url =
    new URL(
      "https://suggests.rasp.yandex.net/all_suggests"
    );

  url.searchParams.set(
    "format",
    "old"
  );

  url.searchParams.set(
    "part",
    part
  );

  const response =
    await timedFetch(
      url,
      {
        headers: {
          Accept:
            "application/json,text/plain,*/*",
          "Accept-Language":
            "ru-RU,ru;q=0.9",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36"
        }
      },
      12_000
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Station suggest HTTP ${response.status}`
    );
  }

  let payload = null;

  try {
    payload =
      JSON.parse(text);
  } catch {
    return [];
  }

  const all =
    collectStationSuggestions(
      payload
    );

  const unique =
    new Map();

  for (
    const item of
    all
  ) {
    const key =
      `${item.code}|${normalizeName(item.title)}`;

    if (
      !unique.has(key)
    ) {
      unique.set(
        key,
        item
      );
    }
  }

  return [...unique.values()]
    .slice(0, 12);
}

async function routeSearchPage(
  from,
  to,
  date,
  fromId = "",
  toId = ""
) {
  const cacheKey =
    `${normalizeName(from)}|${normalizeName(to)}|${fromId}|${toId}|${date}`;

  const cached =
    routeSearchMemoryCache.get(
      cacheKey
    );

  if (
    cached &&
    Date.now() -
      cached.at <
      ROUTE_SEARCH_TTL_MS
  ) {
    return cached.value;
  }

  const url =
    new URL(
      "https://rasp.yandex.ru/search/train/"
    );

  url.searchParams.set(
    "fromName",
    from
  );

  url.searchParams.set(
    "toName",
    to
  );

  if (fromId) {
    url.searchParams.set(
      "fromId",
      fromId
    );
  }

  if (toId) {
    url.searchParams.set(
      "toId",
      toId
    );
  }

  url.searchParams.set(
    "when",
    russianWhen(
      date
    )
  );

  const {
    html,
    finalUrl
  } =
    await fetchPublicHtml(
      url
    );

  const descriptors =
    extractThreadLinks(
      html,
      finalUrl,
      date
    );

  const result = {
    date,
    url:
      finalUrl,
    descriptors
  };

  routeSearchMemoryCache.set(
    cacheKey,
    {
      at:
        Date.now(),
      value:
        result
    }
  );

  return result;
}

async function mapLimit(
  items,
  limit,
  worker
) {
  const output =
    new Array(
      items.length
    );

  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index =
        cursor++;

      if (
        index >=
        items.length
      ) {
        return;
      }

      output[index] =
        await worker(
          items[index],
          index
        );
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          )
      },
      () =>
        runWorker()
    )
  );

  return output;
}

async function resolveDescriptorRun(
  descriptor,
  fallbackDate
) {
  const serviceDate =
    descriptor.departureDate ||
    fallbackDate;

  const runId =
    makeRunId(
      descriptor.number,
      serviceDate,
      descriptor.uid
    );

  const cached =
    await findRun(
      runId
    );

  if (cached) {
    return {
      ...cached,
      cache: true
    };
  }

  try {
    return await resolveViaPublicThreadUrl(
      descriptor,
      serviceDate
    );
  } catch (firstError) {
    /*
     * A search result date is the departure date from the user's selected
     * station, not always the origin date of the train. Try a few preceding
     * origin dates for multi-day trains.
     */
    for (
      let daysBack = 1;
      daysBack <= 4;
      daysBack++
    ) {
      const candidateDate =
        addIsoDaysLocal(
          fallbackDate,
          -daysBack
        );

      try {
        const url =
          new URL(
            descriptor.url
          );

        url.searchParams.set(
          "departure",
          candidateDate
        );

        return await resolveViaPublicThreadUrl(
          {
            ...descriptor,
            departureDate:
              candidateDate,
            url:
              url.toString()
          },
          candidateDate
        );
      } catch {}
    }

    throw firstError;
  }
}

async function searchRouteRuns(
  from,
  to,
  date,
  {
    lookbackDays = 4,
    now = Date.now(),
    perDateLimit = 16,
    fromId = "",
    toId = ""
  } = {}
) {
  const cleanFrom =
    String(from || "")
      .trim();

  const cleanTo =
    String(to || "")
      .trim();

  if (
    cleanFrom.length < 2 ||
    cleanTo.length < 2
  ) {
    throw new Error(
      "Введите станцию отправления и станцию назначения"
    );
  }

  if (
    normalizeName(
      cleanFrom
    ) ===
    normalizeName(
      cleanTo
    )
  ) {
    throw new Error(
      "Станции отправления и назначения должны различаться"
    );
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      date
    )
  ) {
    throw new Error(
      "Дата должна быть YYYY-MM-DD"
    );
  }

  const today =
    moscowIsoDate(
      now
    );

  const requested =
    date;

  const dates = [];

  for (
    let back = 0;
    back <=
      Math.max(
        0,
        Math.min(
          6,
          Number(
            lookbackDays
          ) || 0
        )
      );
    back++
  ) {
    dates.push(
      addIsoDaysLocal(
        requested,
        -back
      )
    );
  }

  const pages =
    await mapLimit(
      dates,
      3,
      async (day) => {
        try {
          return await routeSearchPage(
            cleanFrom,
            cleanTo,
            day,
            fromId,
            toId
          );
        } catch (error) {
          return {
            date: day,
            descriptors: [],
            error:
              error instanceof Error
                ? error.message
                : String(error)
          };
        }
      }
    );

  const groups = [];

  for (
    const page of
    pages
  ) {
    const descriptors =
      page.descriptors
        .slice(
          0,
          perDateLimit
        );

    const runs =
      await mapLimit(
        descriptors,
        5,
        async (
          descriptor
        ) => {
          try {
            const run =
              await resolveDescriptorRun(
                descriptor,
                page.date
              );

            const segment =
              segmentForQueries(
                run,
                cleanFrom,
                cleanTo
              );

            if (!segment) {
              return null;
            }

            /*
             * If the public thread contains explicit local station dates,
             * require the selected station departure to match the searched day.
             */
            if (
              segment.departureDateLocal &&
              segment.departureDateLocal !==
                page.date
            ) {
              return null;
            }

            return runSummaryForSegment(
              run,
              segment,
              now
            );
          } catch {
            return null;
          }
        }
      );

    let candidates =
      runs.filter(Boolean);

    /*
     * A completed train is no longer useful for tracking. Past dates are
     * therefore visible only while at least one train of that date is still
     * physically in its full route window.
     */
    candidates =
      candidates.filter(
        (item) =>
          !item.completed
      );

    if (
      page.date <
      today
    ) {
      candidates =
        candidates.filter(
          (item) =>
            item.activeNow
        );
    }

    candidates.sort(
      (a, b) =>
        (
          a.segment
            .departureMs ||
          a.departureMs ||
          0
        ) -
        (
          b.segment
            .departureMs ||
          b.departureMs ||
          0
        )
    );

    if (
      candidates.length
    ) {
      groups.push({
        date:
          page.date,
        isPast:
          page.date <
          today,
        isToday:
          page.date ===
          today,
        candidates
      });
    }
  }

  groups.sort(
    (a, b) =>
      b.date.localeCompare(
        a.date
      )
  );

  return {
    query: {
      from:
        cleanFrom,
      to:
        cleanTo,
      requestedDate:
        requested,
      fromId,
      toId,
      lookbackDays
    },
    now,
    today,
    groups,
    count:
      groups.reduce(
        (
          sum,
          group
        ) =>
          sum +
          group.candidates.length,
        0
      ),
    requiresApiKey:
      false
  };
}


function preset121v(date) {
  const routeFile =
    path.resolve(
      "./rail-route-cache.json"
    );

  return fs.readFile(
    routeFile,
    "utf8"
  )
  .then(JSON.parse)
  .then((route) => {
    const anchors =
      route.anchors || [];

    const rawStops = [
      ["Санкт-Петербург (Московский вокзал)",null,0],
      ["Большая Вишера",120,138],
      ["Малая Вишера",149,150],
      ["Окуловка",201,224],
      ["Бологое-Московское",268,280],
      ["Вышний Волочёк",312,313],
      ["Тверь",402,404],
      ["Решетниково",443,456],
      ["Поварово-1",493,513],
      ["Лихоборы (техническая)",552,664],
      ["Москва (Восточный вокзал)",680,695],
      ["Тарусская",810,812],
      ["Тула (Московский вокзал)",864,894],
      ["Узловая-1",977,981],
      ["Ефремов",1081,1083],
      ["Елец",1170,1201],
      ["Липецк",1284,1303],
      ["Отрожка",1459,1475],
      ["Придача (Воронеж-Южный)",1491,1496],
      ["Лиски",1578,1583],
      ["Россошь",1684,1699],
      ["Митрофановка",1727,1752],
      ["Кутейниково",1835,1837],
      ["Миллерово",1886,1888],
      ["Каменская",1940,1942],
      ["Лихая",1965,1982],
      ["Зверево",2007,2009],
      ["Шахтная",2062,2064],
      ["Каменоломни",2076,2106],
      ["Ростов-Главный",2181,2202],
      ["Староминская-Тимашевская",2287,2289],
      ["Каневская",2328,2330],
      ["Брюховецкая",2359,2361],
      ["Тимашевская-1",2387,2397],
      ["Протока",2481,2483],
      ["Крымская",2531,2535],
      ["Тоннельная",2568,2583],
      ["Новороссийск",2613,null]
    ];

    const departureMs =
      Date.parse(
        `${date}T15:57:00+03:00`
      );

    const stops =
      rawStops.map(
        ([name, arr, dep], i) => ({
          name,
          code: null,
          codes: {
            yandex: null,
            express:
              i === 0
                ? "2004000"
                : i === rawStops.length - 1
                  ? "2064110"
                  : null,
            esr: null
          },
          lat:
            anchors[i]?.lat ??
            null,
          lon:
            anchors[i]?.lon ??
            null,
          arr,
          dep,
          arrivalMs:
            arr === null
              ? null
              : departureMs +
                arr * 60_000,
          departureMs:
            dep === null
              ? null
              : departureMs +
                dep * 60_000,
          arrivalLocal:
            arr === null
              ? null
              : new Intl.DateTimeFormat(
                  "ru-RU",
                  {
                    timeZone:
                      "Europe/Moscow",
                    hour:
                      "2-digit",
                    minute:
                      "2-digit",
                    hour12:
                      false
                  }
                ).format(
                  new Date(
                    departureMs +
                    arr *
                      60_000
                  )
                ),
          departureLocal:
            dep === null
              ? null
              : new Intl.DateTimeFormat(
                  "ru-RU",
                  {
                    timeZone:
                      "Europe/Moscow",
                    hour:
                      "2-digit",
                    minute:
                      "2-digit",
                    hour12:
                      false
                  }
                ).format(
                  new Date(
                    departureMs +
                    dep *
                      60_000
                  )
                ),
          stopTimeSeconds:
            arr !== null &&
            dep !== null
              ? Math.max(
                  0,
                  dep - arr
                ) * 60
              : 0,
          platform: "",
          major:
            i === 0 ||
            i === rawStops.length - 1
        })
      );

    return {
      version: 1,
      runId:
        makeRunId(
          "121В",
          date,
          "R_121V_112"
        ),
      number:
        "121В",
      uid:
        "R_121V_112",
      title:
        "Санкт-Петербург — Новороссийск",
      shortTitle:
        "СПб — Новороссийск",
      serviceDate:
        date,
      departureMs,
      arrivalMs:
        departureMs +
        2613 *
          60_000,
      departureIso:
        new Date(
          departureMs
        ).toISOString(),
      arrivalIso:
        new Date(
          departureMs +
          2613 *
            60_000
        ).toISOString(),
      totalMinutes:
        2613,
      from:
        stops[0].name,
      to:
        stops[
          stops.length - 1
        ].name,
      carrier:
        "РЖД/ФПК",
      transportType:
        "train",
      source:
        "builtin-121v",
      sourceAttribution:
        "локальный кэш проекта",
      stops,
      routeStatus:
        "ready",
      route
    };
  });
}

async function loadRunsDb() {
  await ensureDirs();
  return (
    await readJson(
      RUNS_PATH,
      {
        version: 1,
        runs: {}
      }
    )
  );
}

async function saveRun(run) {
  const db =
    await loadRunsDb();

  db.runs[run.runId] = {
    ...run,
    route:
      undefined,
    cachedAt:
      new Date().toISOString()
  };

  await writeJson(
    RUNS_PATH,
    db
  );
}

async function findRun(runId) {
  const db =
    await loadRunsDb();

  return (
    db.runs?.[runId] ||
    null
  );
}

async function resolveTrainRun(
  number,
  date,
  {
    force = false
  } = {}
) {
  const normalized =
    normalizeTrainNumber(
      number
    );

  if (
    !normalized ||
    !/^\d{1,3}[А-ЯA-Z]{0,3}$/.test(
      normalized
    )
  ) {
    throw new Error(
      "Номер поезда должен выглядеть как 121В или 016А"
    );
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      date
    )
  ) {
    throw new Error(
      "Дата должна быть YYYY-MM-DD"
    );
  }

  const expectedId =
    makeRunId(
      normalized,
      date,
      yandexUidForTrain(
        normalized
      )
    );

  if (!force) {
    const cached =
      await findRun(
        expectedId
      );

    if (cached) {
      return {
        ...cached,
        cache: true
      };
    }
  }

  let run = null;
  const attempts = [];

  /*
   * No-key mode is the normal path. 121В keeps the local preset so the
   * bundled demo remains available even when external sites are offline.
   */
  if (
    normalized === "121В" &&
    !force
  ) {
    try {
      run =
        await preset121v(
          date
        );

      attempts.push({
        source:
          "builtin-121v",
        ok: true
      });
    } catch (error) {
      attempts.push({
        source:
          "builtin-121v",
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      });
    }
  }

  if (!run) {
    try {
      run =
        await resolveViaPublicPage(
          normalized,
          date
        );

      attempts.push({
        source:
          "yandex-public-html",
        ok: true
      });
    } catch (error) {
      attempts.push({
        source:
          "yandex-public-html",
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      });
    }
  }

  /*
   * The official API is optional. If an operator already has a key in the
   * environment it can rescue a public-page parsing failure, but no key is
   * required by start.cmd or the UI.
   */
  if (!run && API_KEY) {
    try {
      run =
        await resolveViaYandexApi(
          normalized,
          date
        );

      attempts.push({
        source:
          "yandex-api-optional-fallback",
        ok: true
      });
    } catch (error) {
      attempts.push({
        source:
          "yandex-api-optional-fallback",
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      });
    }
  }

  if (
    !run &&
    normalized === "121В"
  ) {
    try {
      run =
        await preset121v(
          date
        );

      attempts.push({
        source:
          "builtin-121v-final-fallback",
        ok: true
      });
    } catch (error) {
      attempts.push({
        source:
          "builtin-121v-final-fallback",
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      });
    }
  }

  if (!run) {
    const error =
      new Error(
        "Не удалось получить публичное расписание этого поезда на выбранную дату."
      );

    error.attempts =
      attempts;

    throw error;
  }

  run.attempts =
    attempts;

  if (
    run.route &&
    Array.isArray(
      run.route.segments
    )
  ) {
    await ensureDirs();

    await writeJson(
      await routePath(
        run.runId
      ),
      {
        ...run.route,
        runId:
          run.runId,
        train:
          run.number
      }
    );
  }

  await saveRun(run);

  return run;
}

async function overpass(query) {
  const failures = [];

  for (
    const endpoint of
    OVERPASS_ENDPOINTS
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () => controller.abort(),
        FETCH_TIMEOUT_MS
      );

    try {
      const response =
        await fetch(
          endpoint,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded;charset=UTF-8",
              Accept:
                "application/json",
              "User-Agent":
                "Orihon-RZD-MultiTrain/2.0"
            },
            body:
              "data=" +
              encodeURIComponent(
                query
              ),
            signal:
              controller.signal
          }
        );

      const text =
        await response.text();

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${text.slice(0, 200)}`
        );
      }

      return {
        endpoint,
        payload:
          JSON.parse(text)
      };
    } catch (error) {
      failures.push(
        `${endpoint}: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    failures.join(" | ")
  );
}

async function discoverRelation(
  number
) {
  const ref =
    normalizeTrainNumber(
      number
    );

  const exactQuery =
    `[out:json][timeout:60];` +
    `relation["type"="route"]["route"="train"]["ref"="${ref}"];` +
    `out ids tags;`;

  let result =
    await overpass(
      exactQuery
    );

  let rels =
    (
      result.payload?.elements ||
      []
    ).filter(
      (item) =>
        item.type ===
        "relation"
    );

  if (!rels.length) {
    const escaped =
      ref.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    result =
      await overpass(
        `[out:json][timeout:60];` +
        `relation["type"="route"]["route"="train"]["name"~"${escaped}",i];` +
        `out ids tags;`
      );

    rels =
      (
        result.payload?.elements ||
        []
      ).filter(
        (item) =>
          item.type ===
          "relation"
      );
  }

  if (!rels.length) {
    return null;
  }

  rels.sort(
    (a, b) => {
      const aExact =
        a?.tags?.ref === ref
          ? 1
          : 0;

      const bExact =
        b?.tags?.ref === ref
          ? 1
          : 0;

      return bExact - aExact;
    }
  );

  return {
    relation:
      rels[0],
    endpoint:
      result.endpoint
  };
}

async function relationFull(
  relationId
) {
  await ensureDirs();

  const file =
    path.join(
      OSM_DUMPS_DIR,
      `${relationId}.json`
    );

  const cached =
    await readJson(
      file
    );

  if (
    cached?.elements?.length >
    100
  ) {
    return {
      payload:
        cached,
      source:
        `file://${file}`
    };
  }

  const url =
    `https://api.openstreetmap.org/api/0.6/relation/${relationId}/full.json`;

  const response =
    await timedFetch(
      url,
      {
        headers: {
          Accept:
            "application/json",
          "User-Agent":
            "Orihon-RZD-MultiTrain/2.0"
        }
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `OSM relation HTTP ${response.status}`
    );
  }

  const payload =
    JSON.parse(text);

  await writeJson(
    file,
    payload
  );

  return {
    payload,
    source:
      "https://api.openstreetmap.org"
  };
}

function relationData(
  payload,
  relationId
) {
  const nodes =
    new Map();

  const ways =
    new Map();

  for (
    const element of
    payload.elements || []
  ) {
    if (
      element.type ===
        "node" &&
      Number.isFinite(
        element.lat
      ) &&
      Number.isFinite(
        element.lon
      )
    ) {
      nodes.set(
        element.id,
        {
          id:
            element.id,
          lat:
            element.lat,
          lon:
            element.lon,
          tags:
            element.tags ||
            {}
        }
      );
    }

    if (
      element.type ===
        "way" &&
      Array.isArray(
        element.nodes
      )
    ) {
      ways.set(
        element.id,
        element
      );
    }
  }

  const relation =
    (
      payload.elements ||
      []
    ).find(
      (item) =>
        item.type ===
          "relation" &&
        item.id ===
          relationId
    );

  if (!relation) {
    throw new Error(
      `OSM relation ${relationId} не найдена в full.json`
    );
  }

  const wayMembers =
    relation.members.filter(
      (member) =>
        member.type ===
        "way"
    );

  const stopNodes =
    relation.members
      .filter(
        (member) =>
          member.type ===
            "node" &&
          String(
            member.role ||
            ""
          ).startsWith(
            "stop"
          )
      )
      .map(
        (member) =>
          nodes.get(
            member.ref
          )
      )
      .filter(Boolean);

  function pointsFor(
    member
  ) {
    const way =
      ways.get(
        member.ref
      );

    return (
      way?.nodes || []
    )
      .map(
        (id) =>
          nodes.get(id)
      )
      .filter(Boolean);
  }

  if (!wayMembers.length) {
    throw new Error(
      "У relation нет railway ways"
    );
  }

  const first =
    pointsFor(
      wayMembers[0]
    );

  if (
    first.length < 2
  ) {
    throw new Error(
      "У первого way нет geometry"
    );
  }

  const chain =
    first.slice();

  for (
    let i = 1;
    i <
    wayMembers.length;
    i++
  ) {
    const pts =
      pointsFor(
        wayMembers[i]
      );

    if (
      pts.length < 2
    ) {
      continue;
    }

    const last =
      chain[
        chain.length - 1
      ];

    const d0 =
      haversineKm(
        last.lat,
        last.lon,
        pts[0].lat,
        pts[0].lon
      );

    const d1 =
      haversineKm(
        last.lat,
        last.lon,
        pts[
          pts.length - 1
        ].lat,
        pts[
          pts.length - 1
        ].lon
      );

    const ordered =
      d1 < d0
        ? pts
            .slice()
            .reverse()
        : pts;

    const join =
      haversineKm(
        last.lat,
        last.lon,
        ordered[0].lat,
        ordered[0].lon
      );

    const start =
      join < 0.0001
        ? 1
        : 0;

    for (
      let j = start;
      j <
      ordered.length;
      j++
    ) {
      chain.push(
        ordered[j]
      );
    }
  }

  return {
    relation,
    chain,
    stopNodes
  };
}

function reverseIfNeeded(
  chain,
  run
) {
  const start =
    run.stops.find(
      (stop) =>
        Number.isFinite(
          stop.lat
        ) &&
        Number.isFinite(
          stop.lon
        )
    );

  const finish =
    [...run.stops]
      .reverse()
      .find(
        (stop) =>
          Number.isFinite(
            stop.lat
          ) &&
          Number.isFinite(
            stop.lon
          )
      );

  if (!start || !finish) {
    return chain;
  }

  const forward =
    haversineKm(
      start.lat,
      start.lon,
      chain[0].lat,
      chain[0].lon
    ) +
    haversineKm(
      finish.lat,
      finish.lon,
      chain[
        chain.length - 1
      ].lat,
      chain[
        chain.length - 1
      ].lon
    );

  const reverse =
    haversineKm(
      start.lat,
      start.lon,
      chain[
        chain.length - 1
      ].lat,
      chain[
        chain.length - 1
      ].lon
    ) +
    haversineKm(
      finish.lat,
      finish.lon,
      chain[0].lat,
      chain[0].lon
    );

  return reverse < forward
    ? chain.slice().reverse()
    : chain;
}

function fillCoordsFromRelationStops(
  run,
  stopNodes
) {
  const named =
    stopNodes
      .map(
        (node, index) => ({
          ...node,
          index,
          key:
            normalizeName(
              node.tags?.name ||
              node.tags?.["name:ru"] ||
              ""
            )
        })
      )
      .filter(
        (node) =>
          node.key
      );

  let cursor = 0;

  for (
    const stop of
    run.stops
  ) {
    if (
      Number.isFinite(
        stop.lat
      ) &&
      Number.isFinite(
        stop.lon
      )
    ) {
      continue;
    }

    const key =
      normalizeName(
        stop.name
      );

    let best = null;

    for (
      let i = cursor;
      i <
      named.length;
      i++
    ) {
      const node =
        named[i];

      const score =
        node.key === key
          ? 100
          : (
              node.key.includes(
                key
              ) ||
              key.includes(
                node.key
              )
            )
            ? 60 +
              Math.min(
                key.length,
                node.key.length
              )
            : 0;

      if (
        score > 0 &&
        (
          !best ||
          score >
            best.score
        )
      ) {
        best = {
          ...node,
          score,
          namedIndex:
            i
        };
      }
    }

    if (best) {
      stop.lat =
        best.lat;
      stop.lon =
        best.lon;

      cursor =
        best.namedIndex;
    }
  }
}

function nearestChainIndex(
  chain,
  lat,
  lon,
  minIndex = 0,
  maxIndex =
    chain.length - 1
) {
  let bestIndex =
    minIndex;

  let bestDistance =
    Infinity;

  for (
    let i =
      minIndex;
    i <=
      maxIndex;
    i++
  ) {
    const point =
      chain[i];

    const distance =
      haversineKm(
        lat,
        lon,
        point.lat,
        point.lon
      );

    if (
      distance <
      bestDistance
    ) {
      bestDistance =
        distance;
      bestIndex =
        i;
    }
  }

  return {
    index:
      bestIndex,
    distanceKm:
      bestDistance
  };
}

function anchorsOnChain(
  chain,
  run
) {
  const anchors =
    new Array(
      run.stops.length
    ).fill(null);

  let cursor = 0;

  for (
    let i = 0;
    i <
    run.stops.length;
    i++
  ) {
    const stop =
      run.stops[i];

    if (
      !Number.isFinite(
        stop.lat
      ) ||
      !Number.isFinite(
        stop.lon
      )
    ) {
      continue;
    }

    const maxIndex =
      chain.length - 1 -
      (
        run.stops.length -
        1 -
        i
      );

    const nearest =
      nearestChainIndex(
        chain,
        stop.lat,
        stop.lon,
        cursor,
        Math.max(
          cursor,
          maxIndex
        )
      );

    anchors[i] = {
      stationIndex:
        i,
      name:
        stop.name,
      idx:
        nearest.index,
      nodeId:
        chain[
          nearest.index
        ].id ||
        null,
      lat:
        chain[
          nearest.index
        ].lat,
      lon:
        chain[
          nearest.index
        ].lon,
      snapKm:
        Number(
          nearest.distanceKm.toFixed(
            3
          )
        )
    };

    cursor =
      Math.min(
        chain.length - 1,
        nearest.index + 1
      );
  }

  const known =
    anchors
      .map(
        (anchor, index) =>
          anchor
            ? index
            : null
      )
      .filter(
        (index) =>
          index !== null
      );

  if (!known.length) {
    throw new Error(
      "Не удалось привязать ни одной станции к OSM route"
    );
  }

  if (!anchors[0]) {
    anchors[0] = {
      stationIndex: 0,
      name:
        run.stops[0].name,
      idx: 0,
      nodeId:
        chain[0].id ||
        null,
      lat:
        chain[0].lat,
      lon:
        chain[0].lon,
      snapKm: null
    };
  }

  const last =
    anchors.length - 1;

  if (!anchors[last]) {
    anchors[last] = {
      stationIndex:
        last,
      name:
        run.stops[last].name,
      idx:
        chain.length - 1,
      nodeId:
        chain[
          chain.length - 1
        ].id ||
        null,
      lat:
        chain[
          chain.length - 1
        ].lat,
      lon:
        chain[
          chain.length - 1
        ].lon,
      snapKm: null
    };
  }

  for (
    let i = 0;
    i <
    anchors.length;
    i++
  ) {
    if (anchors[i]) {
      continue;
    }

    let left =
      i - 1;

    while (
      left >= 0 &&
      !anchors[left]
    ) {
      left--;
    }

    let right =
      i + 1;

    while (
      right <
        anchors.length &&
      !anchors[right]
    ) {
      right++;
    }

    const a =
      anchors[left];

    const b =
      anchors[right];

    const stop =
      run.stops[i];

    const leftMinute =
      run.stops[left].dep ??
      run.stops[left].arr ??
      0;

    const rightMinute =
      run.stops[right].arr ??
      run.stops[right].dep ??
      run.totalMinutes;

    const minute =
      stop.arr ??
      stop.dep ??
      (
        leftMinute +
        rightMinute
      ) / 2;

    const t =
      Math.max(
        0,
        Math.min(
          1,
          (
            minute -
            leftMinute
          ) /
          Math.max(
            1,
            rightMinute -
            leftMinute
          )
        )
      );

    const idx =
      Math.round(
        a.idx +
        (
          b.idx -
          a.idx
        ) *
          t
      );

    const point =
      chain[
        Math.max(
          a.idx + 1,
          Math.min(
            b.idx - 1,
            idx
          )
        )
      ] ||
      chain[idx] ||
      chain[a.idx];

    anchors[i] = {
      stationIndex:
        i,
      name:
        stop.name,
      idx:
        Math.max(
          a.idx + 1,
          Math.min(
            b.idx - 1,
            idx
          )
        ),
      nodeId:
        point.id ||
        null,
      lat:
        point.lat,
      lon:
        point.lon,
      snapKm:
        null,
      estimated:
        true
    };
  }

  for (
    let i = 1;
    i <
    anchors.length;
    i++
  ) {
    if (
      anchors[i].idx <=
      anchors[i - 1].idx
    ) {
      anchors[i].idx =
        Math.min(
          chain.length - 1,
          anchors[i - 1].idx +
            1
        );

      const point =
        chain[
          anchors[i].idx
        ];

      anchors[i].lat =
        point.lat;
      anchors[i].lon =
        point.lon;
    }
  }

  return anchors;
}

function pointLineDistanceMeters(
  point,
  a,
  b
) {
  const lat0 =
    point.lat *
    Math.PI /
    180;

  const kx =
    111320 *
    Math.cos(lat0);

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

  const dx =
    bx - ax;

  const dy =
    by - ay;

  const len2 =
    dx * dx +
    dy * dy;

  if (
    len2 <=
    1e-12
  ) {
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
          (px - ax) *
          dx +
          (py - ay) *
          dy
        ) /
        len2
      )
    );

  const x =
    ax +
    dx * t;

  const y =
    ay +
    dy * t;

  return Math.hypot(
    px - x,
    py - y
  );
}

function simplifyRdp(
  points,
  toleranceMeters
) {
  if (
    points.length <= 2
  ) {
    return points.slice();
  }

  const keep =
    new Uint8Array(
      points.length
    );

  keep[0] = 1;
  keep[
    points.length - 1
  ] = 1;

  const stack = [
    [
      0,
      points.length - 1
    ]
  ];

  while (
    stack.length
  ) {
    const [
      start,
      end
    ] =
      stack.pop();

    let bestIndex =
      -1;

    let bestDistance =
      0;

    for (
      let i =
        start + 1;
      i < end;
      i++
    ) {
      const distance =
        pointLineDistanceMeters(
          points[i],
          points[start],
          points[end]
        );

      if (
        distance >
        bestDistance
      ) {
        bestDistance =
          distance;
        bestIndex =
          i;
      }
    }

    if (
      bestIndex >= 0 &&
      bestDistance >
        toleranceMeters
    ) {
      keep[
        bestIndex
      ] = 1;

      stack.push(
        [
          start,
          bestIndex
        ],
        [
          bestIndex,
          end
        ]
      );
    }
  }

  const result = [];

  for (
    let i = 0;
    i <
    points.length;
    i++
  ) {
    if (keep[i]) {
      result.push(
        points[i]
      );
    }
  }

  return result;
}

function geometryDistanceKm(
  points
) {
  let km = 0;

  for (
    let i = 1;
    i <
    points.length;
    i++
  ) {
    km +=
      haversineKm(
        points[i - 1].lat,
        points[i - 1].lon,
        points[i].lat,
        points[i].lon
      );
  }

  return km;
}

function routeFromChain(
  run,
  chain,
  anchors,
  source
) {
  const segments = [];
  let totalDistanceKm =
    0;

  for (
    let i = 0;
    i <
    run.stops.length -
      1;
    i++
  ) {
    const start =
      anchors[i].idx;

    const end =
      anchors[i + 1].idx;

    const raw =
      chain.slice(
        start,
        end + 1
      );

    const simplified =
      simplifyRdp(
        raw,
        SIMPLIFY_TOLERANCE_METERS
      );

    const distanceKm =
      geometryDistanceKm(
        raw
      );

    totalDistanceKm +=
      distanceKm;

    segments.push({
      fromIndex: i,
      toIndex:
        i + 1,
      from:
        run.stops[i].name,
      to:
        run.stops[
          i + 1
        ].name,
      distanceKm:
        Number(
          distanceKm.toFixed(
            3
          )
        ),
      rawNodeCount:
        raw.length,
      simplifiedPointCount:
        simplified.length,
      coordinates:
        simplified.map(
          (p) => [
            p.lon,
            p.lat
          ]
        )
    });
  }

  const coordinates =
    [];

  for (
    const segment of
    segments
  ) {
    for (
      const point of
      segment.coordinates
    ) {
      const last =
        coordinates[
          coordinates.length -
            1
        ];

      if (
        last &&
        Math.abs(
          last[0] -
          point[0]
        ) <
          1e-10 &&
        Math.abs(
          last[1] -
          point[1]
        ) <
          1e-10
      ) {
        continue;
      }

      coordinates.push(
        point
      );
    }
  }

  return {
    version: 1,
    runId:
      run.runId,
    train:
      run.number,
    generatedAt:
      new Date().toISOString(),
    cache: false,
    source,
    anchors:
      anchors.map(
        ({
          idx,
          ...rest
        }) => rest
      ),
    segments,
    route: {
      type:
        "Feature",
      properties: {
        train:
          run.number,
        from:
          run.from,
        to:
          run.to
      },
      geometry: {
        type:
          "LineString",
        coordinates
      }
    },
    stats: {
      stopCount:
        run.stops.length,
      segmentCount:
        segments.length,
      totalDistanceKm:
        Number(
          totalDistanceKm.toFixed(
            2
          )
        ),
      routePoints:
        coordinates.length
    }
  };
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const a =
      this.items;
    a.push(item);

    let i =
      a.length - 1;

    while (i > 0) {
      const p =
        Math.floor(
          (i - 1) / 2
        );

      if (
        a[p].priority <=
        item.priority
      ) {
        break;
      }

      a[i] =
        a[p];

      i = p;
    }

    a[i] =
      item;
  }

  pop() {
    const a =
      this.items;

    if (!a.length) {
      return null;
    }

    const root =
      a[0];

    const last =
      a.pop();

    if (!a.length) {
      return root;
    }

    let i = 0;

    while (true) {
      const left =
        i * 2 + 1;

      const right =
        left + 1;

      if (
        left >=
        a.length
      ) {
        break;
      }

      let smallest =
        left;

      if (
        right <
          a.length &&
        a[right]
          .priority <
          a[left]
            .priority
      ) {
        smallest =
          right;
      }

      if (
        a[smallest]
          .priority >=
        last.priority
      ) {
        break;
      }

      a[i] =
        a[smallest];

      i =
        smallest;
    }

    a[i] =
      last;

    return root;
  }
}

function wayWeightFactor(
  tags = {}
) {
  let factor = 1;

  if (tags.service) {
    factor *= 4.5;
  }

  if (
    tags.usage ===
    "branch"
  ) {
    factor *= 1.18;
  }

  if (
    [
      "industrial",
      "military",
      "tourism"
    ].includes(
      tags.usage
    )
  ) {
    factor *= 3;
  }

  if (
    tags[
      "railway:traffic_mode"
    ] ===
    "freight"
  ) {
    factor *= 1.8;
  }

  return factor;
}

function overpassCorridorQuery(
  points
) {
  const line =
    points
      .map(
        (p) =>
          `${Number(p.lat).toFixed(6)},${Number(p.lon).toFixed(6)}`
      )
      .join(",");

  return (
    `[out:json][timeout:180];` +
    `way["railway"="rail"]` +
    `(around:${CORRIDOR_RADIUS_METERS},${line});` +
    `(._;>;);out body;`
  );
}

async function corridorElements(
  stops
) {
  const valid =
    stops.filter(
      (stop) =>
        Number.isFinite(
          stop.lat
        ) &&
        Number.isFinite(
          stop.lon
        )
    );

  if (
    valid.length < 2
  ) {
    throw new Error(
      "Недостаточно координат станций для railway-routing fallback"
    );
  }

  const unique =
    new Map();

  const endpoints =
    new Set();

  const step = 5;
  const width = 7;

  for (
    let start = 0;
    start <
    valid.length - 1;
    start += step
  ) {
    const chunk =
      valid.slice(
        Math.max(
          0,
          start - 1
        ),
        Math.min(
          valid.length,
          start + width
        )
      );

    const result =
      await overpass(
        overpassCorridorQuery(
          chunk
        )
      );

    endpoints.add(
      result.endpoint
    );

    for (
      const element of
      result.payload?.elements ||
      []
    ) {
      unique.set(
        `${element.type}/${element.id}`,
        element
      );
    }

    if (
      start + width >=
      valid.length
    ) {
      break;
    }
  }

  return {
    elements:
      [...unique.values()],
    endpoints:
      [...endpoints]
  };
}

function overpassString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function stationNameVariants(name) {
  const original =
    String(name || "")
      .replace(/\*+$/g, "")
      .trim();

  const withoutParen =
    original
      .replace(/\([^)]*\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const variants =
    new Set([
      original,
      withoutParen
    ]);

  const substitutions = [
    [
      /московский\s+вокзал/ig,
      ""
    ],
    [
      /ленинградский\s+вокзал/ig,
      ""
    ],
    [
      /казанский\s+вокзал/ig,
      ""
    ],
    [
      /восточный\s+вокзал/ig,
      ""
    ],
    [
      /главный\s+вокзал/ig,
      ""
    ],
    [
      /\s*-\s*/g,
      "-"
    ]
  ];

  for (
    const value of
    [...variants]
  ) {
    let current =
      value;

    for (
      const [
        pattern,
        replacement
      ] of
      substitutions
    ) {
      current =
        current
          .replace(
            pattern,
            replacement
          )
          .replace(
            /\s+/g,
            " "
          )
          .trim();

      if (current) {
        variants.add(
          current
        );
      }
    }
  }

  return [...variants]
    .filter(
      (value) =>
        value.length >= 2
    )
    .slice(0, 4);
}

async function osmStationCandidates(
  run
) {
  const results =
    run.stops.map(
      () => []
    );

  const chunkSize = 10;

  for (
    let start = 0;
    start <
    run.stops.length;
    start +=
      chunkSize
  ) {
    const end =
      Math.min(
        run.stops.length,
        start +
          chunkSize
      );

    const parts = [
      "[out:json][timeout:90];("
    ];

    for (
      let i = start;
      i < end;
      i++
    ) {
      for (
        const variant of
        stationNameVariants(
          run.stops[i].name
        )
      ) {
        const name =
          overpassString(
            variant
          );

        parts.push(
          `nwr["railway"~"^(station|halt|stop)$"]["name"="${name}"];`
        );

        parts.push(
          `nwr["public_transport"="station"]["name"="${name}"];`
        );
      }
    }

    parts.push(
      ");out center tags;"
    );

    const response =
      await overpass(
        parts.join("")
      );

    const elements =
      response.payload?.elements ||
      [];

    for (
      let i = start;
      i < end;
      i++
    ) {
      const wanted =
        stationNameVariants(
          run.stops[i].name
        )
          .map(
            normalizeName
          );

      for (
        const element of
        elements
      ) {
        const title =
          element?.tags?.name ||
          element?.tags?.["name:ru"] ||
          "";

        const key =
          normalizeName(
            title
          );

        if (
          !key ||
          !wanted.some(
            (candidate) =>
              key ===
                candidate ||
              key.includes(
                candidate
              ) ||
              candidate.includes(
                key
              )
          )
        ) {
          continue;
        }

        const lat =
          Number(
            element.lat ??
            element.center?.lat
          );

        const lon =
          Number(
            element.lon ??
            element.center?.lon
          );

        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon)
        ) {
          continue;
        }

        results[i].push({
          lat,
          lon,
          osmType:
            element.type,
          osmId:
            element.id,
          name:
            title,
          exact:
            wanted.includes(
              key
            )
        });
      }

      const unique =
        new Map();

      for (
        const candidate of
        results[i]
      ) {
        unique.set(
          `${candidate.lat.toFixed(5)},${candidate.lon.toFixed(5)}`,
          candidate
        );
      }

      results[i] =
        [...unique.values()]
          .slice(0, 12);
    }
  }

  return results;
}

function chooseStationSequence(
  run,
  candidates
) {
  const selected =
    new Array(
      run.stops.length
    ).fill(null);

  const knownIndices =
    candidates
      .map(
        (items, index) =>
          items.length
            ? index
            : null
      )
      .filter(
        (index) =>
          index !== null
      );

  if (
    knownIndices.length < 2
  ) {
    return selected;
  }

  const dp =
    candidates.map(
      () => new Map()
    );

  const first =
    knownIndices[0];

  for (
    let j = 0;
    j <
    candidates[first].length;
    j++
  ) {
    dp[first].set(
      j,
      {
        cost:
          candidates[first][j]
            .exact
            ? 0
            : 25,
        prev: null
      }
    );
  }

  for (
    let k = 1;
    k <
    knownIndices.length;
    k++
  ) {
    const i =
      knownIndices[k];

    const previousIndex =
      knownIndices[
        k - 1
      ];

    const fromStop =
      run.stops[
        previousIndex
      ];

    const toStop =
      run.stops[i];

    const fromMinute =
      fromStop.dep ??
      fromStop.arr ??
      0;

    const toMinute =
      toStop.arr ??
      toStop.dep ??
      fromMinute + 60;

    const hours =
      Math.max(
        0.15,
        (
          toMinute -
          fromMinute
        ) /
          60
      );

    for (
      let j = 0;
      j <
      candidates[i].length;
      j++
    ) {
      const current =
        candidates[i][j];

      let best =
        null;

      for (
        const [
          previousCandidateIndex,
          previousState
        ] of
        dp[
          previousIndex
        ]
      ) {
        const previous =
          candidates[
            previousIndex
          ][
            previousCandidateIndex
          ];

        const km =
          haversineKm(
            previous.lat,
            previous.lon,
            current.lat,
            current.lon
          );

        const speed =
          km /
          hours;

        let penalty = 0;

        if (
          speed > 220
        ) {
          penalty +=
            (
              speed - 220
            ) *
            20;
        }

        if (
          speed < 2 &&
          km > 0.5
        ) {
          penalty += 300;
        }

        const score =
          previousState.cost +
          km +
          penalty +
          (
            current.exact
              ? 0
              : 25
          );

        if (
          !best ||
          score <
            best.cost
        ) {
          best = {
            cost:
              score,
            prev:
              previousCandidateIndex
          };
        }
      }

      if (best) {
        dp[i].set(
          j,
          best
        );
      }
    }
  }

  const last =
    knownIndices[
      knownIndices.length - 1
    ];

  let currentCandidate =
    null;

  let bestCost =
    Infinity;

  for (
    const [
      index,
      state
    ] of
    dp[last]
  ) {
    if (
      state.cost <
      bestCost
    ) {
      bestCost =
        state.cost;

      currentCandidate =
        index;
    }
  }

  for (
    let k =
      knownIndices.length - 1;
    k >= 0 &&
    currentCandidate !==
      null;
    k--
  ) {
    const i =
      knownIndices[k];

    selected[i] =
      candidates[i][
        currentCandidate
      ];

    const state =
      dp[i].get(
        currentCandidate
      );

    currentCandidate =
      state?.prev ??
      null;
  }

  return selected;
}

function fillMissingCoordsByTime(
  run
) {
  const known =
    run.stops
      .map(
        (stop, index) =>
          Number.isFinite(
            stop.lat
          ) &&
          Number.isFinite(
            stop.lon
          )
            ? index
            : null
      )
      .filter(
        (index) =>
          index !== null
      );

  if (
    known.length < 2
  ) {
    return;
  }

  for (
    let i = 0;
    i <
    run.stops.length;
    i++
  ) {
    const stop =
      run.stops[i];

    if (
      Number.isFinite(
        stop.lat
      ) &&
      Number.isFinite(
        stop.lon
      )
    ) {
      continue;
    }

    let left =
      i - 1;

    while (
      left >= 0 &&
      (
        !Number.isFinite(
          run.stops[left].lat
        ) ||
        !Number.isFinite(
          run.stops[left].lon
        )
      )
    ) {
      left--;
    }

    let right =
      i + 1;

    while (
      right <
        run.stops.length &&
      (
        !Number.isFinite(
          run.stops[right].lat
        ) ||
        !Number.isFinite(
          run.stops[right].lon
        )
      )
    ) {
      right++;
    }

    if (
      left < 0 ||
      right >=
        run.stops.length
    ) {
      continue;
    }

    const a =
      run.stops[left];

    const b =
      run.stops[right];

    const aMinute =
      a.dep ??
      a.arr ??
      0;

    const bMinute =
      b.arr ??
      b.dep ??
      aMinute + 1;

    const minute =
      stop.arr ??
      stop.dep ??
      (
        aMinute +
        bMinute
      ) /
        2;

    const t =
      Math.max(
        0,
        Math.min(
          1,
          (
            minute -
            aMinute
          ) /
          Math.max(
            1,
            bMinute -
            aMinute
          )
        )
      );

    stop.lat =
      a.lat +
      (
        b.lat -
        a.lat
      ) *
        t;

    stop.lon =
      a.lon +
      (
        b.lon -
        a.lon
      ) *
        t;

    stop.coordinateEstimated =
      true;
  }
}

async function fillCoordsFromOsmStations(
  run
) {
  const missing =
    run.stops.some(
      (stop) =>
        !Number.isFinite(
          stop.lat
        ) ||
        !Number.isFinite(
          stop.lon
        )
    );

  if (!missing) {
    return {
      matched:
        run.stops.length,
      estimated: 0
    };
  }

  const candidates =
    await osmStationCandidates(
      run
    );

  const selected =
    chooseStationSequence(
      run,
      candidates
    );

  let matched = 0;

  for (
    let i = 0;
    i <
    selected.length;
    i++
  ) {
    const candidate =
      selected[i];

    if (!candidate) {
      continue;
    }

    run.stops[i].lat =
      candidate.lat;

    run.stops[i].lon =
      candidate.lon;

    run.stops[i]
      .coordinateSource =
      "OpenStreetMap station";

    matched++;
  }

  fillMissingCoordsByTime(
    run
  );

  const estimated =
    run.stops.filter(
      (stop) =>
        stop.coordinateEstimated
    ).length;

  return {
    matched,
    estimated
  };
}

function graphFromElements(
  elements
) {
  const nodes =
    new Map();

  const ways = [];

  for (
    const item of
    elements
  ) {
    if (
      item.type ===
        "node" &&
      Number.isFinite(
        item.lat
      ) &&
      Number.isFinite(
        item.lon
      )
    ) {
      nodes.set(
        item.id,
        {
          id:
            item.id,
          lat:
            item.lat,
          lon:
            item.lon
        }
      );
    }

    if (
      item.type ===
        "way" &&
      Array.isArray(
        item.nodes
      ) &&
      item.tags?.railway ===
        "rail"
    ) {
      ways.push(
        item
      );
    }
  }

  const graph =
    new Map();

  const mainness =
    new Map();

  function add(
    from,
    edge
  ) {
    if (
      !graph.has(from)
    ) {
      graph.set(
        from,
        []
      );
    }

    graph.get(from)
      .push(edge);
  }

  for (
    const way of
    ways
  ) {
    const factor =
      wayWeightFactor(
        way.tags
      );

    for (
      let i = 1;
      i <
      way.nodes.length;
      i++
    ) {
      const aId =
        way.nodes[
          i - 1
        ];

      const bId =
        way.nodes[i];

      const a =
        nodes.get(
          aId
        );

      const b =
        nodes.get(
          bId
        );

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

      const cost =
        km * factor;

      add(
        aId,
        {
          to:
            bId,
          km,
          cost
        }
      );

      add(
        bId,
        {
          to:
            aId,
          km,
          cost
        }
      );

      mainness.set(
        aId,
        Math.min(
          mainness.get(
            aId
          ) ??
            Infinity,
          factor
        )
      );

      mainness.set(
        bId,
        Math.min(
          mainness.get(
            bId
          ) ??
            Infinity,
          factor
        )
      );
    }
  }

  return {
    nodes,
    graph,
    mainness
  };
}

function nearestCandidates(
  stop,
  nodes,
  graph,
  mainness
) {
  const candidates =
    [];

  for (
    const [
      id,
      node
    ] of
    nodes
  ) {
    if (
      !graph.has(id)
    ) {
      continue;
    }

    const snapKm =
      haversineKm(
        stop.lat,
        stop.lon,
        node.lat,
        node.lon
      );

    if (
      snapKm >
      SNAP_RADIUS_KM
    ) {
      continue;
    }

    const factor =
      mainness.get(id) ??
      2;

    candidates.push({
      id,
      snapKm,
      score:
        snapKm *
        (
          1 +
          Math.max(
            0,
            factor - 1
          ) *
            0.25
        )
    });
  }

  candidates.sort(
    (a, b) =>
      a.score - b.score
  );

  return candidates.slice(
    0,
    SNAP_CANDIDATES
  );
}

function reconstruct(
  previous,
  target
) {
  const ids = [];
  let current =
    target;

  while (
    current !==
    undefined &&
    current !== null
  ) {
    ids.push(
      current
    );

    current =
      previous.get(
        current
      );
  }

  return ids.reverse();
}

function aStarSegment(
  fromStop,
  toStop,
  startCandidates,
  targetCandidates,
  nodes,
  graph
) {
  const targetMap =
    new Map(
      targetCandidates.map(
        (item) => [
          item.id,
          item
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
    const node =
      nodes.get(
        candidate.id
      );

    const g =
      candidate.snapKm *
      2;

    distances.set(
      candidate.id,
      g
    );

    heap.push({
      id:
        candidate.id,
      g,
      priority:
        g +
        haversineKm(
          node.lat,
          node.lon,
          toStop.lat,
          toStop.lon
        )
    });
  }

  let targetId =
    null;

  let best =
    Infinity;

  let visited = 0;

  while (
    heap.size
  ) {
    const current =
      heap.pop();

    if (
      current.g !==
      distances.get(
        current.id
      )
    ) {
      continue;
    }

    if (
      current.priority >=
      best
    ) {
      break;
    }

    visited++;

    if (
      visited >
      900_000
    ) {
      throw new Error(
        `Слишком большой A*: ${fromStop.name} → ${toStop.name}`
      );
    }

    const target =
      targetMap.get(
        current.id
      );

    if (target) {
      const total =
        current.g +
        target.snapKm *
          2;

      if (
        total <
        best
      ) {
        best =
          total;
        targetId =
          current.id;
      }

      continue;
    }

    for (
      const edge of
      graph.get(
        current.id
      ) || []
    ) {
      const g =
        current.g +
        edge.cost;

      if (
        g >=
        (
          distances.get(
            edge.to
          ) ??
          Infinity
        )
      ) {
        continue;
      }

      distances.set(
        edge.to,
        g
      );

      previous.set(
        edge.to,
        current.id
      );

      const node =
        nodes.get(
          edge.to
        );

      heap.push({
        id:
          edge.to,
        g,
        priority:
          g +
          haversineKm(
            node.lat,
            node.lon,
            toStop.lat,
            toStop.lon
          )
      });
    }
  }

  if (
    targetId ===
    null
  ) {
    throw new Error(
      `Не найден railway path: ${fromStop.name} → ${toStop.name}`
    );
  }

  return {
    ids:
      reconstruct(
        previous,
        targetId
      ),
    endId:
      targetId
  };
}

async function routeFromRailGraph(
  run
) {
  const corridor =
    await corridorElements(
      run.stops
    );

  const {
    nodes,
    graph,
    mainness
  } =
    graphFromElements(
      corridor.elements
    );

  const candidates =
    run.stops.map(
      (stop) =>
        nearestCandidates(
          stop,
          nodes,
          graph,
          mainness
        )
    );

  if (
    candidates.some(
      (items) =>
        !items.length
    )
  ) {
    throw new Error(
      "Не все станции удалось привязать к railway=rail"
    );
  }

  const segments = [];
  const anchors = [];
  let startCandidates =
    candidates[0];
  let totalDistanceKm =
    0;

  for (
    let i = 0;
    i <
    run.stops.length -
      1;
    i++
  ) {
    const routed =
      aStarSegment(
        run.stops[i],
        run.stops[
          i + 1
        ],
        startCandidates,
        candidates[
          i + 1
        ],
        nodes,
        graph
      );

    const raw =
      routed.ids.map(
        (id) =>
          nodes.get(id)
      );

    const simplified =
      simplifyRdp(
        raw,
        SIMPLIFY_TOLERANCE_METERS
      );

    const km =
      geometryDistanceKm(
        raw
      );

    totalDistanceKm +=
      km;

    if (i === 0) {
      const first =
        raw[0];

      anchors.push({
        stationIndex: 0,
        name:
          run.stops[0].name,
        nodeId:
          first.id,
        lat:
          first.lat,
        lon:
          first.lon,
        snapKm:
          Number(
            haversineKm(
              run.stops[0].lat,
              run.stops[0].lon,
              first.lat,
              first.lon
            ).toFixed(
              3
            )
          )
      });
    }

    const last =
      raw[
        raw.length - 1
      ];

    anchors.push({
      stationIndex:
        i + 1,
      name:
        run.stops[
          i + 1
        ].name,
      nodeId:
        last.id,
      lat:
        last.lat,
      lon:
        last.lon,
      snapKm:
        Number(
          haversineKm(
            run.stops[
              i + 1
            ].lat,
            run.stops[
              i + 1
            ].lon,
            last.lat,
            last.lon
          ).toFixed(
            3
          )
        )
    });

    segments.push({
      fromIndex: i,
      toIndex:
        i + 1,
      from:
        run.stops[i].name,
      to:
        run.stops[
          i + 1
        ].name,
      distanceKm:
        Number(
          km.toFixed(3)
        ),
      rawNodeCount:
        raw.length,
      simplifiedPointCount:
        simplified.length,
      coordinates:
        simplified.map(
          (p) => [
            p.lon,
            p.lat
          ]
        )
    });

    startCandidates = [
      {
        id:
          routed.endId,
        snapKm: 0,
        score: 0
      }
    ];
  }

  const coordinates =
    [];

  for (
    const segment of
    segments
  ) {
    for (
      const point of
      segment.coordinates
    ) {
      const last =
        coordinates[
          coordinates.length - 1
        ];

      if (
        last &&
        Math.abs(
          last[0] -
          point[0]
        ) <
          1e-10 &&
        Math.abs(
          last[1] -
          point[1]
        ) <
          1e-10
      ) {
        continue;
      }

      coordinates.push(
        point
      );
    }
  }

  return {
    version: 1,
    runId:
      run.runId,
    train:
      run.number,
    generatedAt:
      new Date().toISOString(),
    cache: false,
    source: {
      type:
        "osm-railway-graph",
      attribution:
        "© OpenStreetMap contributors, ODbL",
      endpoints:
        corridor.endpoints
    },
    anchors,
    segments,
    route: {
      type:
        "Feature",
      properties: {
        train:
          run.number,
        from:
          run.from,
        to:
          run.to
      },
      geometry: {
        type:
          "LineString",
        coordinates
      }
    },
    stats: {
      stopCount:
        run.stops.length,
      segmentCount:
        segments.length,
      totalDistanceKm:
        Number(
          totalDistanceKm.toFixed(
            2
          )
        ),
      routePoints:
        coordinates.length
    }
  };
}

async function routePath(
  runId
) {
  return path.join(
    ROUTES_DIR,
    `${safeId(runId)}.json`
  );
}

async function buildRoute(
  run,
  {
    force = false
  } = {}
) {
  await ensureDirs();

  const file =
    await routePath(
      run.runId
    );

  if (!force) {
    const cached =
      await readJson(
        file
      );

    if (
      cached?.segments?.length ===
      run.stops.length - 1
    ) {
      return {
        ...cached,
        cache: true
      };
    }
  }

  if (
    run.route &&
    run.route.segments?.length ===
      run.stops.length - 1
  ) {
    await writeJson(
      file,
      run.route
    );

    return {
      ...run.route,
      cache: true
    };
  }

  let relationError =
    null;

  try {
    const discovered =
      await discoverRelation(
        run.number
      );

    if (discovered) {
      const relationId =
        discovered.relation.id;

      const {
        payload,
        source
      } =
        await relationFull(
          relationId
        );

      const data =
        relationData(
          payload,
          relationId
        );

      fillCoordsFromRelationStops(
        run,
        data.stopNodes
      );

      let chain =
        reverseIfNeeded(
          data.chain,
          run
        );

      const anchors =
        anchorsOnChain(
          chain,
          run
        );

      const result =
        routeFromChain(
          run,
          chain,
          anchors,
          {
            type:
              "osm-route-relation",
            relationId,
            relationName:
              data.relation?.tags?.name ||
              null,
            attribution:
              "© OpenStreetMap contributors, ODbL",
            endpoint:
              source
          }
        );

      await writeJson(
        file,
        result
      );

      run.routeStatus =
        "ready";

      await saveRun(
        run
      );

      return result;
    }
  } catch (error) {
    relationError =
      error;
  }

  /*
   * Public timetable pages do not expose station coordinates in a stable
   * documented field. Resolve them from OSM by station name before falling
   * back to the railway graph.
   */
  try {
    await fillCoordsFromOsmStations(
      run
    );

    await saveRun(
      run
    );
  } catch (error) {
    console.warn(
      `[Stations] OSM coordinate resolver: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }

  const hasCoords =
    run.stops.every(
      (stop) =>
        Number.isFinite(
          stop.lat
        ) &&
        Number.isFinite(
          stop.lon
        )
    );

  if (hasCoords) {
    try {
      const result =
        await routeFromRailGraph(
          run
        );

      await writeJson(
        file,
        result
      );

      run.routeStatus =
        "ready";

      await saveRun(
        run
      );

      return result;
    } catch (error) {
      const message =
        relationError
          ? `relation: ${relationError.message}; railway graph: ${error.message}`
          : error.message;

      throw new Error(
        message
      );
    }
  }

  throw new Error(
    relationError
      ? `OSM relation недоступна: ${relationError.message}. Для railway-routing fallback нужны координаты станций из Yandex API.`
      : "Не найдена OSM route relation и не удалось определить координаты всех станций из OpenStreetMap."
  );
}

function pointAlongCoordinates(
  coordinates,
  t
) {
  if (
    !Array.isArray(
      coordinates
    ) ||
    coordinates.length <
      2
  ) {
    return null;
  }

  const cumulative = [0];
  let total = 0;

  for (
    let i = 1;
    i <
    coordinates.length;
    i++
  ) {
    const a =
      coordinates[
        i - 1
      ];

    const b =
      coordinates[i];

    total +=
      haversineKm(
        a[1],
        a[0],
        b[1],
        b[0]
      );

    cumulative.push(
      total
    );
  }

  const target =
    Math.max(
      0,
      Math.min(
        1,
        t
      )
    ) *
    total;

  let i = 0;

  while (
    i <
      cumulative.length -
        2 &&
    cumulative[
      i + 1
    ] <
      target
  ) {
    i++;
  }

  const a =
    coordinates[i];

  const b =
    coordinates[
      i + 1
    ];

  const span =
    Math.max(
      1e-9,
      cumulative[
        i + 1
      ] -
      cumulative[i]
    );

  const local =
    (
      target -
      cumulative[i]
    ) /
    span;

  return {
    lat:
      a[1] +
      (
        b[1] -
        a[1]
      ) *
        local,
    lon:
      a[0] +
      (
        b[0] -
        a[0]
      ) *
        local
  };
}

async function activePosition(
  run,
  now
) {
  if (
    now <
      run.departureMs ||
    now >
      run.arrivalMs
  ) {
    return null;
  }

  const route =
    await readJson(
      await routePath(
        run.runId
      )
    );

  for (
    let i = 0;
    i <
    run.stops.length;
    i++
  ) {
    const stop =
      run.stops[i];

    const arr =
      stop.arrivalMs;

    const dep =
      stop.departureMs;

    if (
      Number.isFinite(
        arr
      ) &&
      Number.isFinite(
        dep
      ) &&
      now >= arr &&
      now <= dep
    ) {
      const anchor =
        route?.anchors?.[i];

      return {
        lat:
          anchor?.lat ??
          stop.lat,
        lon:
          anchor?.lon ??
          stop.lon,
        phase:
          "stopped",
        station:
          stop.name,
        progress:
          (
            now -
            run.departureMs
          ) /
          (
            run.arrivalMs -
            run.departureMs
          )
      };
    }
  }

  for (
    let i = 0;
    i <
    run.stops.length - 1;
    i++
  ) {
    const a =
      run.stops[i];

    const b =
      run.stops[
        i + 1
      ];

    const from =
      a.departureMs ??
      a.arrivalMs;

    const to =
      b.arrivalMs ??
      b.departureMs;

    if (
      !Number.isFinite(
        from
      ) ||
      !Number.isFinite(
        to
      ) ||
      now < from ||
      now > to
    ) {
      continue;
    }

    const t =
      Math.max(
        0,
        Math.min(
          1,
          (
            now - from
          ) /
          Math.max(
            1,
            to - from
          )
        )
      );

    const segment =
      route?.segments?.[i];

    const p =
      segment
        ? pointAlongCoordinates(
            segment.coordinates,
            t
          )
        : (
            Number.isFinite(
              a.lat
            ) &&
            Number.isFinite(
              a.lon
            ) &&
            Number.isFinite(
              b.lat
            ) &&
            Number.isFinite(
              b.lon
            )
          )
          ? {
              lat:
                a.lat +
                (
                  b.lat -
                  a.lat
                ) *
                  t,
              lon:
                a.lon +
                (
                  b.lon -
                  a.lon
                ) *
                  t
            }
          : null;

    if (!p) {
      return null;
    }

    return {
      ...p,
      phase:
        "moving",
      from:
        a.name,
      to:
        b.name,
      progress:
        (
          now -
          run.departureMs
        ) /
        (
          run.arrivalMs -
          run.departureMs
        )
    };
  }

  return null;
}


async function discoverTrainBoardUrls() {
  const {
    html,
    finalUrl
  } =
    await fetchPublicHtml(
      "https://rasp.yandex.ru/train"
    );

  const urls =
    new Set([
      "https://rasp.yandex.ru/train/moscow"
    ]);

  for (
    const match of
    String(html)
      .matchAll(
        /href=["']([^"']*\/train\/[a-z0-9-]+\/?[^"']*)["']/gi
      )
  ) {
    try {
      const url =
        new URL(
          decodeHtmlUrl(
            match[1]
          ),
          finalUrl
        );

      url.search = "";
      url.hash = "";

      if (
        url.pathname ===
          "/train/" ||
        url.pathname ===
          "/train"
      ) {
        continue;
      }

      urls.add(
        url.toString()
      );
    } catch {}
  }

  return [...urls]
    .slice(
      0,
      ACTIVE_BOARD_LIMIT
    );
}

async function boardThreads(
  boardUrl,
  date
) {
  const url =
    new URL(
      boardUrl
    );

  url.searchParams.set(
    "date",
    date
  );

  const {
    html,
    finalUrl
  } =
    await fetchPublicHtml(
      url,
      20_000
    );

  return extractThreadLinks(
    html,
    finalUrl,
    date
  );
}

function currentSegmentDescriptor(
  run,
  now
) {
  if (
    now <
      run.departureMs ||
    now >=
      run.arrivalMs
  ) {
    return null;
  }

  for (
    let i = 0;
    i <
    run.stops.length;
    i++
  ) {
    const stop =
      run.stops[i];

    const arrival =
      stop.arrivalMs;

    const departure =
      stop.departureMs;

    if (
      Number.isFinite(
        arrival
      ) &&
      Number.isFinite(
        departure
      ) &&
      now >=
        arrival &&
      now <=
        departure
    ) {
      return {
        phase:
          "stopped",
        stationIndex:
          i,
        station:
          stop.name,
        stationName:
          stop.name,
        fromIndex:
          i,
        toIndex:
          i,
        t: 0
      };
    }
  }

  for (
    let i = 0;
    i <
    run.stops.length - 1;
    i++
  ) {
    const a =
      run.stops[i];

    const b =
      run.stops[
        i + 1
      ];

    const fromMs =
      a.departureMs ??
      a.arrivalMs;

    const toMs =
      b.arrivalMs ??
      b.departureMs;

    if (
      !Number.isFinite(
        fromMs
      ) ||
      !Number.isFinite(
        toMs
      ) ||
      now <
        fromMs ||
      now >
        toMs
    ) {
      continue;
    }

    return {
      phase:
        "moving",
      fromIndex:
        i,
      toIndex:
        i + 1,
      from:
        a.name,
      to:
        b.name,
      t:
        Math.max(
          0,
          Math.min(
            1,
            (
              now -
              fromMs
            ) /
            Math.max(
              1,
              toMs -
              fromMs
            )
          )
        )
    };
  }

  return null;
}

async function osmCandidatesForNames(
  names
) {
  const uniqueNames =
    [...new Set(
      names
        .map(
          (value) =>
            String(value || "")
              .trim()
        )
        .filter(Boolean)
    )];

  const map =
    new Map();

  const chunkSize = 18;

  for (
    let start = 0;
    start <
    uniqueNames.length;
    start +=
      chunkSize
  ) {
    const chunk =
      uniqueNames.slice(
        start,
        start +
          chunkSize
      );

    const parts = [
      "[out:json][timeout:90];("
    ];

    for (
      const name of
      chunk
    ) {
      for (
        const variant of
        stationNameVariants(
          name
        )
      ) {
        const escaped =
          overpassString(
            variant
          );

        parts.push(
          `nwr["railway"~"^(station|halt|stop)$"]["name"="${escaped}"];`
        );

        parts.push(
          `nwr["public_transport"="station"]["name"="${escaped}"];`
        );
      }
    }

    parts.push(
      ");out center tags;"
    );

    let elements = [];

    try {
      const response =
        await overpass(
          parts.join("")
        );

      elements =
        response.payload
          ?.elements ||
        [];
    } catch {
      continue;
    }

    for (
      const requestedName of
      chunk
    ) {
      const wanted =
        stationNameVariants(
          requestedName
        )
          .map(
            normalizeName
          );

      const candidates = [];

      for (
        const element of
        elements
      ) {
        const title =
          element?.tags?.name ||
          element?.tags?.["name:ru"] ||
          "";

        const key =
          normalizeName(
            title
          );

        if (
          !key ||
          !wanted.some(
            (candidate) =>
              key ===
                candidate ||
              key.includes(
                candidate
              ) ||
              candidate.includes(
                key
              )
          )
        ) {
          continue;
        }

        const lat =
          Number(
            element.lat ??
            element.center?.lat
          );

        const lon =
          Number(
            element.lon ??
            element.center?.lon
          );

        if (
          Number.isFinite(
            lat
          ) &&
          Number.isFinite(
            lon
          )
        ) {
          candidates.push({
            lat,
            lon,
            name:
              title,
            exact:
              wanted.includes(
                key
              )
          });
        }
      }

      map.set(
        normalizeName(
          requestedName
        ),
        candidates.slice(
          0,
          10
        )
      );
    }
  }

  return map;
}

function choosePairCoordinates(
  aCandidates,
  bCandidates,
  travelMinutes
) {
  if (
    !aCandidates?.length ||
    !bCandidates?.length
  ) {
    return null;
  }

  const hours =
    Math.max(
      0.08,
      travelMinutes /
        60
    );

  let best = null;

  for (
    const a of
    aCandidates
  ) {
    for (
      const b of
      bCandidates
    ) {
      const km =
        haversineKm(
          a.lat,
          a.lon,
          b.lat,
          b.lon
        );

      const speed =
        km /
        hours;

      let penalty =
        km;

      if (
        speed > 220
      ) {
        penalty +=
          (
            speed -
            220
          ) *
          20;
      }

      if (
        a.exact
      ) {
        penalty -= 3;
      }

      if (
        b.exact
      ) {
        penalty -= 3;
      }

      if (
        !best ||
        penalty <
          best.penalty
      ) {
        best = {
          a,
          b,
          penalty
        };
      }
    }
  }

  return best;
}

async function approximatePositionsForRuns(
  runs,
  now
) {
  const descriptors =
    runs
      .map(
        (run) => ({
          run,
          segment:
            currentSegmentDescriptor(
              run,
              now
            )
        })
      )
      .filter(
        (item) =>
          item.segment
      );

  const names = [];

  for (
    const {
      run,
      segment
    } of
    descriptors
  ) {
    names.push(
      run.stops[
        segment.fromIndex
      ].name
    );

    names.push(
      run.stops[
        segment.toIndex
      ].name
    );
  }

  const candidateMap =
    await osmCandidatesForNames(
      names
    );

  const positions =
    new Map();

  for (
    const {
      run,
      segment
    } of
    descriptors
  ) {
    /*
     * Prefer a route cache if this train has already been selected before.
     */
    const exact =
      await activePosition(
        run,
        now
      );

    if (exact) {
      positions.set(
        run.runId,
        {
          ...exact,
          precision:
            "rail-route"
        }
      );
      continue;
    }

    const a =
      run.stops[
        segment.fromIndex
      ];

    const b =
      run.stops[
        segment.toIndex
      ];

    if (
      segment.phase ===
      "stopped"
    ) {
      const candidates =
        candidateMap.get(
          normalizeName(
            a.name
          )
        ) ||
        [];

      if (
        candidates.length
      ) {
        positions.set(
          run.runId,
          {
            lat:
              candidates[0].lat,
            lon:
              candidates[0].lon,
            phase:
              "stopped",
            station:
              a.name,
            progress:
              (
                now -
                run.departureMs
              ) /
              (
                run.arrivalMs -
                run.departureMs
              ),
            precision:
              "station"
          }
        );
      }

      continue;
    }

    const aCandidates =
      candidateMap.get(
        normalizeName(
          a.name
        )
      ) ||
      [];

    const bCandidates =
      candidateMap.get(
        normalizeName(
          b.name
        )
      ) ||
      [];

    const travelMinutes =
      Math.max(
        1,
        (
          (
            b.arrivalMs ??
            b.departureMs
          ) -
          (
            a.departureMs ??
            a.arrivalMs
          )
        ) /
          60_000
      );

    const pair =
      choosePairCoordinates(
        aCandidates,
        bCandidates,
        travelMinutes
      );

    if (!pair) {
      continue;
    }

    positions.set(
      run.runId,
      {
        lat:
          pair.a.lat +
          (
            pair.b.lat -
            pair.a.lat
          ) *
            segment.t,
        lon:
          pair.a.lon +
          (
            pair.b.lon -
            pair.a.lon
          ) *
            segment.t,
        phase:
          "moving",
        from:
          a.name,
        to:
          b.name,
        progress:
          (
            now -
            run.departureMs
          ) /
          (
            run.arrivalMs -
            run.departureMs
          ),
        precision:
          "station-interpolation"
      }
    );
  }

  return positions;
}

async function loadActiveIndexCache() {
  const cached =
    await readJson(
      ACTIVE_INDEX_PATH
    );

  if (
    !cached ||
    !Array.isArray(
      cached.trains
    )
  ) {
    return null;
  }

  return cached;
}

async function refreshActiveIndex(
  {
    force = false,
    now = Date.now()
  } = {}
) {
  await ensureDirs();

  if (!force) {
    const cached =
      await loadActiveIndexCache();

    if (
      cached &&
      Number.isFinite(
        cached.generatedAtMs
      ) &&
      now -
        cached.generatedAtMs <
        ACTIVE_INDEX_TTL_MS
    ) {
      return cached;
    }
  }

  if (
    activeIndexPromise
  ) {
    return activeIndexPromise;
  }

  activeIndexPromise =
    (async () => {
      activeIndexState = {
        refreshing: true,
        startedAt:
          new Date().toISOString(),
        finishedAt: null,
        boardCount: 0,
        candidateCount: 0,
        activeCount: 0,
        error: null
      };

      try {
        const boards =
          await discoverTrainBoardUrls();

        activeIndexState
          .boardCount =
          boards.length;

        const today =
          moscowIsoDate(
            now
          );

        const boardDays = [
          today,
          addIsoDaysLocal(
            today,
            -1
          ),
          addIsoDaysLocal(
            today,
            -2
          )
        ];

        const jobs = [];

        for (
          const board of
          boards
        ) {
          for (
            const day of
            boardDays
          ) {
            jobs.push({
              board,
              day
            });
          }
        }

        const discovered =
          await mapLimit(
            jobs,
            5,
            async (job) => {
              try {
                return await boardThreads(
                  job.board,
                  job.day
                );
              } catch {
                return [];
              }
            }
          );

        const descriptors =
          new Map();

        for (
          const list of
          discovered
        ) {
          for (
            const descriptor of
            list
          ) {
            const key =
              `${descriptor.uid}|${descriptor.departureDate || ""}`;

            if (
              !descriptors.has(
                key
              )
            ) {
              descriptors.set(
                key,
                descriptor
              );
            }

            if (
              descriptors.size >=
              ACTIVE_THREAD_LIMIT
            ) {
              break;
            }
          }

          if (
            descriptors.size >=
            ACTIVE_THREAD_LIMIT
          ) {
            break;
          }
        }

        activeIndexState
          .candidateCount =
          descriptors.size;

        const resolved =
          await mapLimit(
            [...descriptors.values()],
            6,
            async (
              descriptor
            ) => {
              try {
                const fallback =
                  descriptor
                    .departureDate ||
                  today;

                const run =
                  await resolveDescriptorRun(
                    descriptor,
                    fallback
                  );

                if (
                  now >=
                    run.departureMs &&
                  now <
                    run.arrivalMs
                ) {
                  return run;
                }
              } catch {}

              return null;
            }
          );

        const activeRuns =
          resolved
            .filter(Boolean);

        const uniqueRuns =
          new Map();

        for (
          const run of
          activeRuns
        ) {
          uniqueRuns.set(
            run.runId,
            run
          );
        }

        const runs =
          [...uniqueRuns.values()];

        const positions =
          await approximatePositionsForRuns(
            runs,
            now
          );

        const trains = [];

        for (
          const run of
          runs
        ) {
          const position =
            positions.get(
              run.runId
            );

          if (!position) {
            continue;
          }

          trains.push({
            runId:
              run.runId,
            number:
              run.number,
            title:
              run.title,
            from:
              run.from,
            to:
              run.to,
            serviceDate:
              run.serviceDate,
            departureMs:
              run.departureMs,
            arrivalMs:
              run.arrivalMs,
            carrier:
              run.carrier,
            position,
            source:
              "public-board-index"
          });
        }

        trains.sort(
          (a, b) =>
            a.number.localeCompare(
              b.number,
              "ru"
            )
        );

        const payload = {
          version: 2,
          generatedAt:
            new Date().toISOString(),
          generatedAtMs:
            Date.now(),
          scope:
            "public-major-board-index",
          coverage: {
            boardCount:
              boards.length,
            lookbackDays: 2,
            candidateThreads:
              descriptors.size,
            note:
              "Индекс строится из публичных табло крупных железнодорожных узлов; источник не предоставляет единый bulk API всех поездов."
          },
          count:
            trains.length,
          trains
        };

        await writeJson(
          ACTIVE_INDEX_PATH,
          payload
        );

        activeIndexState = {
          refreshing: false,
          startedAt:
            activeIndexState
              .startedAt,
          finishedAt:
            new Date().toISOString(),
          boardCount:
            boards.length,
          candidateCount:
            descriptors.size,
          activeCount:
            trains.length,
          error: null
        };

        return payload;
      } catch (error) {
        activeIndexState = {
          ...activeIndexState,
          refreshing: false,
          finishedAt:
            new Date().toISOString(),
          error:
            error instanceof Error
              ? error.message
              : String(error)
        };

        const cached =
          await loadActiveIndexCache();

        if (cached) {
          return cached;
        }

        throw error;
      } finally {
        activeIndexPromise =
          null;
      }
    })();

  return activeIndexPromise;
}

function triggerActiveIndexRefresh(
  options = {}
) {
  if (
    activeIndexPromise
  ) {
    return;
  }

  void refreshActiveIndex(
    options
  ).catch(
    (error) => {
      console.error(
        "[ActiveIndex]",
        error
      );
    }
  );
}

async function listActiveRuns(
  now = Date.now(),
  {
    refresh = false
  } = {}
) {
  const cachedIndex =
    await loadActiveIndexCache();

  const stale =
    !cachedIndex ||
    !Number.isFinite(
      cachedIndex.generatedAtMs
    ) ||
    now -
      cachedIndex.generatedAtMs >
      ACTIVE_INDEX_TTL_MS;

  if (
    refresh ||
    stale
  ) {
    triggerActiveIndexRefresh({
      force:
        Boolean(refresh),
      now
    });
  }

  const merged =
    new Map();

  if (
    cachedIndex?.trains
  ) {
    for (
      const train of
      cachedIndex.trains
    ) {
      if (
        now >=
          train.departureMs &&
        now <
          train.arrivalMs
      ) {
        merged.set(
          train.runId,
          train
        );
      }
    }
  }

  /*
   * Always merge the local catalog. A train selected by the user should
   * appear immediately even before the broad public-board index refreshes.
   */
  const db =
    await loadRunsDb();

  for (
    const run of
    Object.values(
      db.runs || {}
    )
  ) {
    if (
      !Number.isFinite(
        run.departureMs
      ) ||
      !Number.isFinite(
        run.arrivalMs
      ) ||
      now <
        run.departureMs ||
      now >=
        run.arrivalMs
    ) {
      continue;
    }

    const position =
      await activePosition(
        run,
        now
      );

    if (!position) {
      continue;
    }

    merged.set(
      run.runId,
      {
        runId:
          run.runId,
        number:
          run.number,
        title:
          run.title,
        from:
          run.from,
        to:
          run.to,
        serviceDate:
          run.serviceDate,
        departureMs:
          run.departureMs,
        arrivalMs:
          run.arrivalMs,
        carrier:
          run.carrier,
        position: {
          ...position,
          precision:
            "rail-route"
        },
        source:
          "local-catalog"
      }
    );
  }

  const trains =
    [...merged.values()];

  trains.sort(
    (a, b) =>
      a.number.localeCompare(
        b.number,
        "ru"
      )
  );

  return {
    trains,
    count:
      trains.length,
    scope:
      cachedIndex?.scope ||
      "local-catalog-bootstrap",
    coverage:
      cachedIndex?.coverage ||
      null,
    indexGeneratedAt:
      cachedIndex?.generatedAt ||
      null,
    refreshing:
      activeIndexState
        .refreshing,
    indexState:
      activeIndexState
  };
}

async function getRunById(
  runId
) {
  return findRun(
    runId
  );
}

async function searchTrainRuns(
  number,
  date,
  options = {}
) {
  const run =
    await resolveTrainRun(
      number,
      date,
      options
    );

  return {
    query: {
      number:
        normalizeTrainNumber(
          number
        ),
      date
    },
    provider:
      run.source,
    requiresApiKey:
      false,
    candidates: [
      {
        runId:
          run.runId,
        number:
          run.number,
        title:
          run.title,
        from:
          run.from,
        to:
          run.to,
        serviceDate:
          run.serviceDate,
        departureMs:
          run.departureMs,
        arrivalMs:
          run.arrivalMs,
        departureIso:
          run.departureIso,
        arrivalIso:
          run.arrivalIso,
        totalMinutes:
          run.totalMinutes,
        carrier:
          run.carrier,
        source:
          run.source,
        warning:
          run.sourceWarning ||
          null
      }
    ]
  };
}

function providerStatus() {
  return {
    mode:
      "no-key-primary",
    publicTimetable:
      true,
    publicTimetableSource:
      "rasp.yandex.ru public thread pages",
    optionalYandexApiConfigured:
      Boolean(API_KEY),
    osmRelationRouting:
      true,
    osmRailwayGraphFallback:
      true,
    osmStationCoordinateResolver:
      true,
    activeCatalog:
      true,
    routeSearchByStations:
      true,
    activePublicBoardIndex:
      true
  };
}

export {
  normalizeTrainNumber,
  searchTrainRuns,
  searchRouteRuns,
  suggestStations,
  resolveTrainRun,
  getRunById,
  buildRoute,
  listActiveRuns,
  refreshActiveIndex,
  triggerActiveIndexRefresh,
  providerStatus,
  parsePublicRows
};
