
    (() => {
      "use strict";

      const MOSCOW_OFFSET = "+03:00";
      const TOTAL_MINUTES = 2613;
      const ANIMATION_FPS = 30;
      const FRAME_MS = 1000 / ANIMATION_FPS;

      const stops = [
        { name: "Санкт-Петербург (Московский вокзал)", lat: 59.9296, lon: 30.3626, arr: null, dep: 0, major: true },
        { name: "Большая Вишера", lat: 58.9147, lon: 32.1167, arr: 120, dep: 138 },
        { name: "Малая Вишера", lat: 58.8462, lon: 32.2220, arr: 149, dep: 150 },
        { name: "Окуловка", lat: 58.3917, lon: 33.2907, arr: 201, dep: 224 },
        { name: "Бологое-Московское", lat: 57.8799, lon: 34.0539, arr: 268, dep: 280 },
        { name: "Вышний Волочёк", lat: 57.5913, lon: 34.5603, arr: 312, dep: 313 },
        { name: "Тверь", lat: 56.8587, lon: 35.9176, arr: 402, dep: 404, major: true },
        { name: "Решетниково", lat: 56.4508, lon: 36.5667, arr: 443, dep: 456 },
        { name: "Поварово-1", lat: 56.0747, lon: 37.0517, arr: 493, dep: 513 },
        { name: "Лихоборы (техническая)", lat: 55.8458, lon: 37.5650, arr: 552, dep: 664 },
        { name: "Москва (Восточный вокзал)", lat: 55.8002, lon: 37.7465, arr: 680, dep: 695, major: true },
        { name: "Тарусская", lat: 54.7250, lon: 37.1760, arr: 810, dep: 812 },
        { name: "Тула (Московский вокзал)", lat: 54.1990, lon: 37.5773, arr: 864, dep: 894, major: true },
        { name: "Узловая-1", lat: 53.9798, lon: 38.1607, arr: 977, dep: 981 },
        { name: "Ефремов", lat: 53.1490, lon: 38.1168, arr: 1081, dep: 1083 },
        { name: "Елец", lat: 52.6237, lon: 38.5017, arr: 1170, dep: 1201 },
        { name: "Липецк", lat: 52.6102, lon: 39.5946, arr: 1284, dep: 1303, major: true },
        { name: "Отрожка", lat: 51.6940, lon: 39.2650, arr: 1459, dep: 1475 },
        { name: "Придача (Воронеж-Южный)", lat: 51.6253, lon: 39.3022, arr: 1491, dep: 1496, major: true },
        { name: "Лиски", lat: 50.9822, lon: 39.4995, arr: 1578, dep: 1583 },
        { name: "Россошь", lat: 50.1986, lon: 39.5760, arr: 1684, dep: 1699, major: true },
        { name: "Митрофановка", lat: 49.9700, lon: 39.6900, arr: 1727, dep: 1752 },
        { name: "Кутейниково", lat: 49.1350, lon: 39.7870, arr: 1835, dep: 1837 },
        { name: "Миллерово", lat: 48.9226, lon: 40.3986, arr: 1886, dep: 1888 },
        { name: "Каменская", lat: 48.3204, lon: 40.2687, arr: 1940, dep: 1942 },
        { name: "Лихая", lat: 48.1524, lon: 40.1886, arr: 1965, dep: 1982 },
        { name: "Зверево", lat: 48.0210, lon: 40.1220, arr: 2007, dep: 2009 },
        { name: "Шахтная", lat: 47.7088, lon: 40.2156, arr: 2062, dep: 2064 },
        { name: "Каменоломни", lat: 47.6685, lon: 40.2074, arr: 2076, dep: 2106 },
        { name: "Ростов-Главный", lat: 47.2221, lon: 39.6914, arr: 2181, dep: 2202, major: true },
        { name: "Староминская-Тимашевская", lat: 46.5311, lon: 39.0497, arr: 2287, dep: 2289 },
        { name: "Каневская", lat: 46.0848, lon: 38.9596, arr: 2328, dep: 2330 },
        { name: "Брюховецкая", lat: 45.8061, lon: 38.9992, arr: 2359, dep: 2361 },
        { name: "Тимашевская-1", lat: 45.6155, lon: 38.9440, arr: 2387, dep: 2397 },
        { name: "Протока", lat: 45.2558, lon: 38.1198, arr: 2481, dep: 2483 },
        { name: "Крымская", lat: 44.9292, lon: 37.9912, arr: 2531, dep: 2535 },
        { name: "Тоннельная", lat: 44.8584, lon: 37.6684, arr: 2568, dep: 2583 },
        { name: "Новороссийск", lat: 44.7244, lon: 37.7687, arr: 2613, dep: null, major: true }
      ];

      const routeCoords = stops.map((s) => [s.lat, s.lon]);

      const progressText = document.getElementById("progressText");
      const remainingText = document.getElementById("remainingText");
      const delayText = document.getElementById("delayText");
      const modeText = document.getElementById("modeText");
      const progressBar = document.getElementById("progressBar");
      const positionLine = document.getElementById("positionLine");
      const nextLine = document.getElementById("nextLine");

      const systemTimeBox = document.getElementById("systemTimeBox");
      const serviceDateBox = document.getElementById("serviceDateBox");
      const fitButton = document.getElementById("fitButton");
      const liveButton = document.getElementById("liveButton");
      const x60Button = document.getElementById("x60Button");
      const x600Button = document.getElementById("x600Button");
      const trainButton = document.getElementById("trainButton");

      const actualStation = document.getElementById("actualStation");
      const actualTime = document.getElementById("actualTime");
      const applyActualButton = document.getElementById("applyActualButton");
      const manualDelay = document.getElementById("manualDelay");
      const applyDelayButton = document.getElementById("applyDelayButton");
      const timelineList = document.getElementById("timelineList");
      const stopCountLabel = document.getElementById("stopCountLabel");

      let map;
      let trainMarker;
      let routeLine;
      let progressLine;
      let stationMarkers = [];

      let delayMinutes = 0;
      let clockMode = "live";
      let clockMultiplier = 1;
      let demoBaseRealMs = Date.now();
      let demoBaseTrainMs = null;
      let lastFrameAt = 0;
      let latestState = null;
      let lastTimelineIndex = -999;

      function pad2(value) {
        return String(value).padStart(2, "0");
      }

      function moscowDateParts(ms) {
        const parts = new Intl.DateTimeFormat(
          "en-CA",
          {
            timeZone: "Europe/Moscow",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
          }
        ).formatToParts(new Date(ms));

        const result = {};

        for (const part of parts) {
          if (part.type !== "literal") {
            result[part.type] = part.value;
          }
        }

        return result;
      }

      function moscowDayDepartureMs(referenceMs) {
        const parts = moscowDateParts(referenceMs);

        return Date.parse(
          `${parts.year}-${parts.month}-${parts.day}T15:57:00${MOSCOW_OFFSET}`
        );
      }

      function parseDepartureMs(referenceMs = currentClockMs()) {
        const todayDeparture =
          moscowDayDepartureMs(referenceMs);

        /*
         * Для LIVE выбираем последний уже отправившийся рейс.
         * Если московское время ещё раньше 15:57, активным считаем
         * вчерашний рейс — он всё ещё находится в пути, поскольку
         * продолжительность маршрута около 43 ч 33 мин.
         *
         * В демо parseDepartureMs() получает виртуальное время,
         * поэтому тот же алгоритм продолжает работать автоматически.
         */
        if (referenceMs >= todayDeparture) {
          return todayDeparture;
        }

        return todayDeparture - 24 * 60 * 60 * 1000;
      }

      function offsetMs(minutes) {
        return (minutes + delayMinutes) * 60_000;
      }

      function formatMsk(ms, withDate = false) {
        const formatter = new Intl.DateTimeFormat("ru-RU", {
          timeZone: "Europe/Moscow",
          day: withDate ? "2-digit" : undefined,
          month: withDate ? "short" : undefined,
          hour: "2-digit",
          minute: "2-digit"
        });

        return formatter.format(new Date(ms));
      }

      function formatDuration(ms) {
        if (!Number.isFinite(ms)) return "—";

        const sign = ms < 0 ? "-" : "";
        let totalMin = Math.round(Math.abs(ms) / 60_000);

        const days = Math.floor(totalMin / 1440);
        totalMin %= 1440;
        const hours = Math.floor(totalMin / 60);
        const minutes = totalMin % 60;

        const parts = [];

        if (days) parts.push(`${days} д`);
        if (hours || days) parts.push(`${hours} ч`);
        parts.push(`${minutes} мин`);

        return sign + parts.join(" ");
      }

      function lerp(a, b, t) {
        return a + (b - a) * t;
      }

      function smoothstep(t) {
        const x = Math.max(0, Math.min(1, t));
        return x * x * (3 - 2 * x);
      }

      function bearingDeg(lat1, lon1, lat2, lon2) {
        const toRad = Math.PI / 180;
        const toDeg = 180 / Math.PI;

        const phi1 = lat1 * toRad;
        const phi2 = lat2 * toRad;
        const dLon = (lon2 - lon1) * toRad;

        const y = Math.sin(dLon) * Math.cos(phi2);
        const x =
          Math.cos(phi1) * Math.sin(phi2) -
          Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);

        return (Math.atan2(y, x) * toDeg + 360) % 360;
      }

      function currentClockMs() {
        if (clockMode === "live") {
          return Date.now();
        }

        return (
          demoBaseTrainMs +
          (Date.now() - demoBaseRealMs) * clockMultiplier
        );
      }

      function setClockMode(mode, multiplier) {
        const current = currentClockMs();

        clockMode = mode;
        clockMultiplier = multiplier;

        demoBaseRealMs = Date.now();
        demoBaseTrainMs =
          mode === "live"
            ? null
            : current;

        liveButton.classList.toggle("active", mode === "live");
        x60Button.classList.toggle("active", mode === "demo" && multiplier === 60);
        x600Button.classList.toggle("active", mode === "demo" && multiplier === 600);

        modeText.textContent =
          mode === "live"
            ? "LIVE"
            : `×${multiplier}`;
      }

      function startDemo(multiplier) {
        const now = Date.now();
        const departureMs = parseDepartureMs(now);

        // Демо начинается с текущего положения системного LIVE-рейса.
        // Если расчёт почему-либо вне маршрута, начинаем через 15 минут
        // после отправления.

        const endMs = departureMs + offsetMs(TOTAL_MINUTES);

        demoBaseTrainMs =
          now < departureMs || now > endMs
            ? departureMs + offsetMs(15)
            : now;

        demoBaseRealMs = Date.now();
        clockMode = "demo";
        clockMultiplier = multiplier;

        liveButton.classList.remove("active");
        x60Button.classList.toggle("active", multiplier === 60);
        x600Button.classList.toggle("active", multiplier === 600);
        modeText.textContent = `×${multiplier}`;
      }

      function computeState(nowMs) {
        const departureMs = parseDepartureMs(nowMs);
        const arrivalMs = departureMs + offsetMs(TOTAL_MINUTES);

        if (nowMs < departureMs + delayMinutes * 60_000) {
          return {
            phase: "waiting",
            lat: stops[0].lat,
            lon: stops[0].lon,
            heading: bearingDeg(
              stops[0].lat,
              stops[0].lon,
              stops[1].lat,
              stops[1].lon
            ),
            progress: 0,
            currentIndex: 0,
            nextIndex: 1,
            segmentT: 0,
            departureMs,
            arrivalMs
          };
        }

        if (nowMs >= arrivalMs) {
          const last = stops.length - 1;

          return {
            phase: "arrived",
            lat: stops[last].lat,
            lon: stops[last].lon,
            heading: 180,
            progress: 1,
            currentIndex: last,
            nextIndex: null,
            segmentT: 1,
            departureMs,
            arrivalMs
          };
        }

        for (let i = 0; i < stops.length; i++) {
          const stop = stops[i];

          if (
            stop.arr !== null &&
            stop.dep !== null
          ) {
            const arrMs = departureMs + offsetMs(stop.arr);
            const depMs = departureMs + offsetMs(stop.dep);

            if (nowMs >= arrMs && nowMs <= depMs) {
              const nextIndex = i < stops.length - 1 ? i + 1 : null;

              return {
                phase: "stopped",
                lat: stop.lat,
                lon: stop.lon,
                heading:
                  nextIndex !== null
                    ? bearingDeg(
                        stop.lat,
                        stop.lon,
                        stops[nextIndex].lat,
                        stops[nextIndex].lon
                      )
                    : 180,
                progress:
                  (stop.arr + delayMinutes) /
                  (TOTAL_MINUTES + delayMinutes),
                currentIndex: i,
                nextIndex,
                segmentT: 0,
                departureMs,
                arrivalMs,
                stationIndex: i
              };
            }
          }
        }

        for (let i = 0; i < stops.length - 1; i++) {
          const from = stops[i];
          const to = stops[i + 1];

          const fromDep =
            from.dep !== null
              ? from.dep
              : from.arr;

          const toArr =
            to.arr !== null
              ? to.arr
              : to.dep;

          const startMs =
            departureMs + offsetMs(fromDep);
          const endMs =
            departureMs + offsetMs(toArr);

          if (nowMs >= startMs && nowMs < endMs) {
            const rawT =
              (nowMs - startMs) /
              Math.max(1, endMs - startMs);

            const t = smoothstep(rawT);

            return {
              phase: "moving",
              lat: lerp(from.lat, to.lat, t),
              lon: lerp(from.lon, to.lon, t),
              heading: bearingDeg(
                from.lat,
                from.lon,
                to.lat,
                to.lon
              ),
              progress:
                Math.max(
                  0,
                  Math.min(
                    1,
                    (
                      (nowMs - (departureMs + delayMinutes * 60_000)) /
                      Math.max(
                        1,
                        arrivalMs - (departureMs + delayMinutes * 60_000)
                      )
                    )
                  )
                ),
              currentIndex: i,
              nextIndex: i + 1,
              segmentT: t,
              departureMs,
              arrivalMs
            };
          }
        }

        return {
          phase: "unknown",
          lat: stops[0].lat,
          lon: stops[0].lon,
          heading: 0,
          progress: 0,
          currentIndex: 0,
          nextIndex: 1,
          segmentT: 0,
          departureMs,
          arrivalMs
        };
      }

      function positionText(state, nowMs) {
        if (state.phase === "waiting") {
          return (
            `<strong>Ожидает отправления в Санкт-Петербурге</strong>` +
            ` · ${formatMsk(state.departureMs, true)} МСК`
          );
        }

        if (state.phase === "arrived") {
          return `<strong>Поезд прибыл в Новороссийск</strong>`;
        }

        if (state.phase === "stopped") {
          const stop = stops[state.stationIndex];

          return (
            `<strong>${stop.name}</strong>` +
            ` · стоянка`
          );
        }

        const from = stops[state.currentIndex];
        const to = stops[state.nextIndex];

        return (
          `<strong>${from.name}</strong>` +
          ` → ${to.name}`
        );
      }

      function updateTopPanel(state, nowMs) {
        const pct = Math.max(0, Math.min(100, state.progress * 100));

        systemTimeBox.textContent =
          `${formatMsk(Date.now(), true)} МСК`;

        serviceDateBox.textContent =
          `${formatMsk(state.departureMs, true)} → ${formatMsk(state.arrivalMs, true)}`;

        progressText.textContent = `${pct.toFixed(1)}%`;
        progressBar.style.width = `${pct}%`;

        const remaining =
          state.arrivalMs - nowMs;

        remainingText.textContent =
          state.phase === "arrived"
            ? "0 мин"
            : formatDuration(remaining);

        delayText.textContent =
          delayMinutes === 0
            ? "0 мин"
            : `${delayMinutes > 0 ? "+" : ""}${delayMinutes} мин`;

        positionLine.innerHTML =
          positionText(state, nowMs);

        if (state.nextIndex !== null) {
          const next = stops[state.nextIndex];

          const nextArrivalMs =
            state.departureMs +
            offsetMs(
              next.arr !== null
                ? next.arr
                : next.dep
            );

          const toNext =
            Math.max(0, nextArrivalMs - nowMs);

          nextLine.textContent =
            `Следующая: ${next.name} · ` +
            `${formatMsk(nextArrivalMs)} МСК · ` +
            `через ${formatDuration(toNext)}`;
        } else {
          nextLine.textContent =
            `Расчётное прибытие: ${formatMsk(state.arrivalMs, true)} МСК`;
        }
      }

      function makeTrainNode() {
        const node = document.createElement("div");
        node.className = "train-icon";
        node.textContent = "🚆";
        return node;
      }

      function makeStationNode(major) {
        const node = document.createElement("div");
        node.className =
          `station-icon${major ? " major" : ""}`;
        return node;
      }

      function stationPopup(stop, index) {
        const root = document.createElement("div");
        root.className = "tooltip-content";

        const title = document.createElement("strong");
        title.textContent = stop.name;

        const body = document.createElement("div");
        const depMs = parseDepartureMs(currentClockMs());

        if (index === 0) {
          const departure =
            depMs + offsetMs(stop.dep);

          body.innerHTML =
            `Начальная станция<br>` +
            `Отправление: <b>${formatMsk(departure, true)} МСК</b>`;
        } else if (index === stops.length - 1) {
          const arrival =
            depMs + offsetMs(stop.arr);

          body.innerHTML =
            `Конечная станция<br>` +
            `Прибытие: <b>${formatMsk(arrival, true)} МСК</b>`;
        } else {
          const arrival =
            depMs + offsetMs(stop.arr);

          const departure =
            depMs + offsetMs(stop.dep);

          const dwell =
            dwellMinutes(stop);

          body.innerHTML =
            `Прибытие: <b>${formatMsk(arrival, true)} МСК</b><br>` +
            `Отправление: <b>${formatMsk(departure, true)} МСК</b><br>` +
            `Стоянка: <b>${dwell} мин</b>`;
        }

        root.append(title, body);
        return root;
      }

      function createMap() {
        if (!window.Orihon) {
          alert("Orihon не загрузился с CDN.");
          return;
        }

        map = Orihon.createMap("map", {
          center: [52.2, 38.5],
          zoom: 5,
          locale: "ru",
          ariaLabel:
            "Маршрут поезда Санкт-Петербург — Новороссийск"
        });

        Orihon.tileLayer(
          "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          {
            attribution:
              "© OpenStreetMap contributors",
            maxZoom: 19
          }
        ).addTo(map);

        routeLine = Orihon.polyline(
          routeCoords,
          {
            weight: 4,
            opacity: 0.62,
            color: "#64748b",
            lineCap: "round",
            lineJoin: "round"
          }
        ).addTo(map);

        progressLine = Orihon.polyline(
          [routeCoords[0]],
          {
            weight: 5,
            opacity: 0.95,
            color: "#e11d48",
            lineCap: "round",
            lineJoin: "round"
          }
        ).addTo(map);

        stationMarkers = stops.map(
          (stop, index) => {
            const marker = Orihon.marker(
              [stop.lat, stop.lon],
              {
                icon: Orihon.divIcon({
                  content: makeStationNode(
                    Boolean(stop.major)
                  ),
                  iconSize:
                    stop.major
                      ? [14, 14]
                      : [10, 10],
                  iconAnchor:
                    stop.major
                      ? [7, 7]
                      : [5, 5],
                  className: ""
                }),
                title: stop.name,
                zIndexOffset: stop.major ? 50 : 10
              }
            );

            marker.bindPopup(
              () => stationPopup(stop, index)
            );

            marker.addTo(map);

            return marker;
          }
        );

        trainMarker = Orihon.marker(
          [stops[0].lat, stops[0].lon],
          {
            icon: Orihon.divIcon({
              content: makeTrainNode(),
              iconSize: [34, 34],
              iconAnchor: [17, 17],
              className: ""
            }),
            title: "Поезд 121В/122В",
            zIndexOffset: 1000
          }
        ).addTo(map);

        if (typeof Orihon.zoomControl === "function") {
          Orihon.zoomControl({
            position: "bottom-right"
          }).addTo(map);
        }

        if (typeof Orihon.scaleControl === "function") {
          Orihon.scaleControl({
            position: "bottom-left",
            units: "metric"
          }).addTo(map);
        }

        map.fitBounds([
          [44.0, 29.4],
          [60.4, 41.0]
        ]);
      }

      function updateTrainMarker(state) {
        trainMarker.setLatLng(
          [state.lat, state.lon]
        );

        if (
          trainMarker.options &&
          typeof trainMarker.render === "function"
        ) {
          trainMarker.options.rotation =
            state.heading;
          trainMarker.options.rotationOrigin =
            "center center";
          trainMarker.render();
        }
      }

      function updateProgressLine(state) {
        const points = [];

        const endIndex =
          Math.max(
            0,
            Math.min(
              stops.length - 1,
              state.currentIndex
            )
          );

        for (let i = 0; i <= endIndex; i++) {
          points.push(
            [stops[i].lat, stops[i].lon]
          );
        }

        if (
          state.phase === "moving" &&
          state.nextIndex !== null
        ) {
          points.push(
            [state.lat, state.lon]
          );
        }

        if (state.phase === "arrived") {
          points.length = 0;
          points.push(...routeCoords);
        }

        if (
          typeof progressLine.setLatLngs ===
          "function"
        ) {
          progressLine.setLatLngs(points);
        }
      }

      function populateActualStationSelect() {
        actualStation.replaceChildren();

        stops.forEach((stop, index) => {
          if (index === 0) return;

          const option =
            document.createElement("option");

          option.value = String(index);
          option.textContent = stop.name;

          actualStation.appendChild(option);
        });

        actualStation.value = "10";
      }

      function dwellMinutes(stop) {
        if (
          !stop ||
          stop.arr === null ||
          stop.dep === null
        ) {
          return null;
        }

        return Math.max(
          0,
          Number(stop.dep) - Number(stop.arr)
        );
      }

      function renderTimeline() {
        timelineList.replaceChildren();

        const intermediateStops =
          stops.filter(
            (stop, index) =>
              index > 0 &&
              index < stops.length - 1
          );

        const totalDwell =
          intermediateStops.reduce(
            (sum, stop) =>
              sum + (dwellMinutes(stop) || 0),
            0
          );

        stopCountLabel.textContent =
          `${intermediateStops.length} остановок · ${totalDwell} мин стоянок`;

        stops.forEach((stop, index) => {
          const item =
            document.createElement("div");
          item.className = "stop";
          item.dataset.index = String(index);

          const dot =
            document.createElement("div");
          dot.className = "stop-dot";

          const main =
            document.createElement("div");

          const name =
            document.createElement("div");
          name.className = "stop-name";
          name.textContent = stop.name;

          const meta =
            document.createElement("div");
          meta.className = "stop-meta";

          const schedule =
            document.createElement("div");
          schedule.className = "stop-schedule";

          if (index === 0) {
            meta.textContent =
              "начальная станция";

            const departure =
              document.createElement("span");
            departure.textContent =
              `отпр. ${minutesToClock(stop.dep)}`;

            schedule.append(departure);
          } else if (index === stops.length - 1) {
            meta.textContent =
              "конечная станция";

            const arrival =
              document.createElement("span");
            arrival.textContent =
              `приб. ${minutesToClock(stop.arr)}`;

            schedule.append(arrival);
          } else {
            meta.textContent =
              stop.major
                ? "основная остановка"
                : "остановка";

            const arrival =
              document.createElement("span");
            arrival.textContent =
              `приб. ${minutesToClock(stop.arr)}`;

            const departure =
              document.createElement("span");
            departure.textContent =
              `отпр. ${minutesToClock(stop.dep)}`;

            const dwell =
              document.createElement("span");
            dwell.className = "stop-dwell";
            dwell.textContent =
              `стоянка ${dwellMinutes(stop)} мин`;

            schedule.append(
              arrival,
              departure,
              dwell
            );
          }

          main.append(
            name,
            meta,
            schedule
          );

          const time =
            document.createElement("div");
          time.className = "stop-time";

          if (
            index > 0 &&
            index < stops.length - 1
          ) {
            time.textContent =
              `${dwellMinutes(stop)} мин`;
          } else if (index === 0) {
            time.textContent = "СТАРТ";
          } else {
            time.textContent = "ФИНИШ";
          }

          item.append(dot, main, time);

          item.addEventListener(
            "click",
            () => {
              map.flyTo(
                [stop.lat, stop.lon],
                9
              );

              if (
                stationMarkers[index] &&
                typeof stationMarkers[index].openPopup === "function"
              ) {
                stationMarkers[index].openPopup();
              }
            }
          );

          timelineList.appendChild(item);
        });
      }

      function minutesToClock(minutes) {
        const start =
          15 * 60 + 57;

        const total =
          start + minutes;

        const day =
          Math.floor(total / 1440);

        const inDay =
          ((total % 1440) + 1440) % 1440;

        const h =
          Math.floor(inDay / 60);

        const m =
          inDay % 60;

        return (
          `${day > 0 ? `+${day}д ` : ""}` +
          `${pad2(h)}:${pad2(m)}`
        );
      }

      function updateTimeline(state) {
        const activeIndex =
          state.phase === "moving"
            ? state.nextIndex
            : state.currentIndex;

        if (
          activeIndex === lastTimelineIndex
        ) {
          return;
        }

        lastTimelineIndex = activeIndex;

        const children =
          timelineList.children;

        for (
          let i = 0;
          i < children.length;
          i++
        ) {
          const item = children[i];

          item.classList.toggle(
            "passed",
            i < state.currentIndex ||
            state.phase === "arrived"
          );

          item.classList.toggle(
            "active",
            i === activeIndex &&
            state.phase !== "arrived"
          );
        }

        const active =
          children[activeIndex];

        if (active) {
          active.scrollIntoView({
            block: "nearest",
            behavior: "smooth"
          });
        }
      }

      function applyActualControlPoint() {
        const index =
          Number(actualStation.value);

        const value =
          actualTime.value;

        if (
          !Number.isInteger(index) ||
          !stops[index] ||
          !value
        ) {
          return;
        }

        const stop = stops[index];

        const scheduleOffset =
          stop.arr !== null
            ? stop.arr
            : stop.dep;

        const scheduledMs =
          parseDepartureMs(currentClockMs()) +
          scheduleOffset * 60_000;

        // datetime-local трактуем как московское локальное время.
        const actualMs =
          Date.parse(
            `${value}:00${MOSCOW_OFFSET}`
          );

        if (!Number.isFinite(actualMs)) {
          return;
        }

        delayMinutes =
          Math.round(
            (actualMs - scheduledMs) /
            60_000
          );

        manualDelay.value =
          String(delayMinutes);

        // В демо лучше остаться на текущем виртуальном времени,
        // но с новым расчётом задержки.
        lastTimelineIndex = -999;
      }

      function fillActualTimeForStation() {
        const index =
          Number(actualStation.value);

        if (!stops[index]) return;

        const stop =
          stops[index];

        const offset =
          stop.arr !== null
            ? stop.arr
            : stop.dep;

        const scheduled =
          parseDepartureMs(currentClockMs()) +
          offsetMs(offset);

        // Формируем YYYY-MM-DDTHH:MM в Europe/Moscow.
        const parts =
          new Intl.DateTimeFormat(
            "sv-SE",
            {
              timeZone: "Europe/Moscow",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false
            }
          ).formatToParts(
            new Date(scheduled)
          );

        const values = {};

        for (const part of parts) {
          values[part.type] =
            part.value;
        }

        actualTime.value =
          `${values.year}-${values.month}-${values.day}` +
          `T${values.hour}:${values.minute}`;
      }

      function focusTrain() {
        if (!latestState || !map) return;

        map.flyTo(
          [
            latestState.lat,
            latestState.lon
          ],
          Math.max(7, map.getZoom())
        );
      }

      function bindControls() {
        fitButton.addEventListener(
          "click",
          () => {
            map.fitBounds([
              [44.0, 29.4],
              [60.4, 41.0]
            ]);
          }
        );

        trainButton.addEventListener(
          "click",
          focusTrain
        );

        liveButton.addEventListener(
          "click",
          () => setClockMode("live", 1)
        );

        x60Button.addEventListener(
          "click",
          () => startDemo(60)
        );

        x600Button.addEventListener(
          "click",
          () => startDemo(600)
        );

        applyActualButton.addEventListener(
          "click",
          applyActualControlPoint
        );

        applyDelayButton.addEventListener(
          "click",
          () => {
            const value =
              Number(manualDelay.value);

            delayMinutes =
              Number.isFinite(value)
                ? Math.round(value)
                : 0;

            lastTimelineIndex = -999;
          }
        );

        actualStation.addEventListener(
          "change",
          fillActualTimeForStation
        );

      }

      function frame(timestamp) {
        requestAnimationFrame(frame);

        if (
          timestamp - lastFrameAt <
          FRAME_MS
        ) {
          return;
        }

        lastFrameAt = timestamp;

        const nowMs =
          currentClockMs();

        const state =
          computeState(nowMs);

        latestState = state;

        updateTrainMarker(state);
        updateTopPanel(state, nowMs);
        updateTimeline(state);

        // Маршрут обновляем реже визуальной иконки,
        // чтобы не делать лишнюю работу.
        if (
          Math.floor(timestamp / 1000) !==
          Math.floor((timestamp - FRAME_MS) / 1000)
        ) {
          updateProgressLine(state);
        }
      }

      function init() {
        const fileWarning =
          document.getElementById("fileWarning");

        if (
          fileWarning &&
          location.protocol === "file:"
        ) {
          fileWarning.hidden = false;
        }

        populateActualStationSelect();
        renderTimeline();
        createMap();
        bindControls();
        fillActualTimeForStation();

        requestAnimationFrame(frame);
      }

      window.addEventListener(
        "load",
        init
      );
    })();
  