# Orihon Air + Sea Radar v4

Одна карта Orihon с двумя динамическими слоями:

- самолёты: ADSB.lol + Airplanes.live fallback;
- суда: AISStream + Digitraffic + опциональный BarentsWatch.

Самолёты и суда двигаются плавно между реальными позиционными сообщениями: браузер прогнозирует положение по текущей скорости и курсу и мягко корректирует траекторию после нового пакета.

## 1. Требования

Node.js 22+.

Проверка:

```bash
node --version
```

## 2. Запуск

Зависимостей нет, `npm install` не нужен.

Из корня репозитория Orihon:

```bash
npm run demo:aircraft
```

Или в папке `examples/aircraft-radar-proxy`:

```bash
node server.mjs
```

Открыть:

```text
http://127.0.0.1:8787
```

Health endpoint:

```text
http://127.0.0.1:8787/api/health
```

## 3. Что работает без ключей

Без каких-либо ключей:

- самолёты через публичные ADS-B endpoints;
- суда Digitraffic в Балтийском регионе;
- SSE realtime-поток между браузером и `server.mjs`;
- плавная анимация;
- фильтры «Самолёты / Суда / Названия»;
- popup по клику;
- дедупликация судов по MMSI.

## 4. Глобальный AISStream

Для AISStream нужен API key.

Чтобы ключ не попал в HTML, `server.mjs` читает его только из переменной окружения:

```text
AISSTREAM_API_KEY
```

Удобный безопасный способ — сохранить реальный ключ одной строкой в локальном файле `aisstream.key`. Этот файл уже исключён через `.gitignore`.

Linux/macOS:

```bash
export AISSTREAM_API_KEY="$(cat aisstream.key)"
node server.mjs
```

Windows PowerShell:

```powershell
$env:AISSTREAM_API_KEY = (Get-Content .\aisstream.key -Raw).Trim()
node server.mjs
```

При подключённом AISStream backend автоматически подписывает upstream на bounding box текущей карты и обновляет subscription после pan/zoom.

## 5. BarentsWatch

BarentsWatch необязателен. Он добавляет норвежское AIS-покрытие.

`server.mjs` читает:

```text
BARENTSWATCH_CLIENT_ID
BARENTSWATCH_CLIENT_SECRET
```

Можно хранить реальные значения в локальных файлах `barents-client-id.secret` и `barents-client-secret.secret`.

Linux/macOS:

```bash
export BARENTSWATCH_CLIENT_ID="$(cat barents-client-id.secret)"
export BARENTSWATCH_CLIENT_SECRET="$(cat barents-client-secret.secret)"
node server.mjs
```

Windows PowerShell:

```powershell
$env:BARENTSWATCH_CLIENT_ID = (Get-Content .\barents-client-id.secret -Raw).Trim()
$env:BARENTSWATCH_CLIENT_SECRET = (Get-Content .\barents-client-secret.secret -Raw).Trim()
node server.mjs
```

## 6. Архитектура

```text
                  ADSB.lol
                     │
              Airplanes.live
                     │
                     ▼
               ┌───────────┐
AISStream ─────►│           │
Digitraffic ───►│ server.mjs│──── SSE ─────────► Browser + Orihon
BarentsWatch ──►│           │
               └───────────┘
```

ADS-B остаётся viewport/cached REST-потоком.

AISStream и BarentsWatch — realtime streams.

Digitraffic периодически обновляется через открытые REST endpoints и одновременно служит независимым дополнительным источником Балтики.

## 7. Дедупликация

Самолёты:

```text
ICAO hex
```

Суда:

```text
MMSI
```

Если один MMSI одновременно приходит из AISStream, Digitraffic и BarentsWatch, на карте остаётся один объект, а в карточке отображается список источников.

## 8. Плавность

Сетевой пакет — это anchor.

Между пакетами браузер делает dead reckoning:

```text
distance_nm = speed_knots × elapsed_seconds / 3600
```

После нового реального положения ошибка не телепортируется мгновенно, а сглаживается примерно за 1.5–1.8 секунды.

Для судов прогноз ограничен 180 секундами, для самолётов — 45 секундами.

## 9. Диагностика

Если кораблей нет, откройте:

```text
http://127.0.0.1:8787/api/health
```

Поля:

```text
marine.status.aisstream
marine.status.digitraffic
marine.status.barentswatch
marine.vessels
```

покажут, какие источники реально активны.

Если `AISStream` пишет `без ключа`, это нормально: Digitraffic продолжает работать.

## 10. Порт

По умолчанию:

```text
8787
```

Linux/macOS:

```bash
PORT=9000 node server.mjs
```

PowerShell:

```powershell
$env:PORT=9000
node server.mjs
```
