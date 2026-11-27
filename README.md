# Cruise Weather

A static site, hosted on GitHub Pages, that shows day-by-day weather and sea conditions along a cruise itinerary. There is no server, build step, API key or scheduled job. The browser fetches everything when the page loads.

- Cruise list: `https://riedling11.github.io/cruises/`
- A single cruise: `https://riedling11.github.io/cruises/?c=<slug>`

## Repository layout

| Path | Purpose |
|---|---|
| `index.html` | Page shell. Loads Leaflet (map) from unpkg, then `assets/app.js`. Marked `noindex, nofollow`. The `?v=N` on the CSS and JS links is a cache-buster: increase it whenever either file changes, or browsers keep the old copy for up to 10 minutes. |
| `assets/app.js` | All logic: routing, data fetches, the typical/forecast/recorded calculations, rendering. |
| `assets/style.css` | Mobile-first styles, with automatic dark mode. |
| `cruises/index.json` | The list of cruise slugs shown on the home page. |
| `cruises/<slug>.json` | One itinerary per cruise. This is the only file that changes per cruise. |
| `data/storms.json` | Active tropical cyclones, refreshed by the GitHub Action below. Don't edit by hand. |
| `scripts/normalize_storms.py` | Converts NHC's feed into `data/storms.json`. |
| `.github/workflows/storms.yml` | GitHub Action that runs every 3 hours to refresh `data/storms.json`. |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is. |

## Cruise file (`cruises/<slug>.json`)

```json
{
  "title": "Sisters at Sea",
  "line": "Virgin Voyages",
  "ship": "Resilient Lady",
  "imo": "9805348",
  "start": "2027-02-14",
  "end": "2027-02-21",
  "photo": "",
  "days": [
    { "date": "2027-02-14", "type": "port", "name": "Miami, Florida", "lat": 25.778, "lon": -80.177, "depart": "5:00 PM", "note": "Embark" },
    { "date": "2027-02-16", "type": "sea",  "name": "Florida Straits", "lat": 24.0, "lon": -83.5 }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `title`, `line`, `ship` | yes | Display text. |
| `start`, `end` | yes | `YYYY-MM-DD`. Drive the status pill and the date ranges for history lookups. |
| `imo` | no | Ship's IMO number. Builds the "Track" button link to `marinetraffic.com/en/ais/details/ships/imo:<imo>` and the embedded live map. If absent, `trackerUrl` is used for the button instead, if present, and the live map is not shown. |
| `photo` | no | Image URL or repo path (e.g. `assets/ship.jpg`) for the header background. Blank means a plain gradient. |
| `days[]` | yes | One entry per calendar day, in order. |
| `days[].type` | yes | `port` or `sea`. |
| `days[].name` | yes | Port name, or a sea area for sea days (shown as "At sea · <name> (approx.)"). |
| `days[].lat`, `lon` | yes | Decimal degrees. Ports: the cruise terminal. Sea days: estimated noon position on the route. |
| `days[].arrive`, `depart` | no | Free-text times shown under the port name. |
| `days[].note` | no | Short tag, e.g. `Embark`, `Disembark`, `Tender`. |

Days that share the same `lat`/`lon` (e.g. a round trip from Miami) are fetched once.

## Adding a cruise

1. Create `cruises/<slug>.json` using the format above. Pick a slug that doesn't spell out the dates.
2. Add the slug to the `cruises` array in `cruises/index.json`.
3. Commit to `main`. Pages redeploys within a minute or two.

Re-check the itinerary with the cruise line about two weeks before sailing. Lines change routes.

## How each day's weather is chosen

For each itinerary day, `app.js` compares the date with the viewer's local date and picks one of three sources. The badge on the day card shows which one is in use.

| Badge | When | Source |
|---|---|---|
| **Forecast** | Date is today up to 15 days ahead | Open-Meteo Forecast API (`api.open-meteo.com/v1/forecast`) + Marine API (`marine-api.open-meteo.com/v1/marine`) |
| **Recorded** | Date is 1–60 days in the past | Same Forecast + Marine APIs (they serve recent past days) |
| **Recorded** | Date is more than 60 days in the past | Archive API (`archive-api.open-meteo.com/v1/archive`) + Marine API |
| **Typical** | Date is more than 15 days ahead | Ten-year climatology, computed in the browser (below) |

Values are filled in field by field. If a forecast day has temperature but no wave data (marine forecasts don't reach as far ahead as weather forecasts), the seas value comes from the typical figure and is labeled "Seas (typical)".

Constants at the top of `app.js`:

| Constant | Default | Effect |
|---|---|---|
| `FORECAST_AHEAD` | `15` | Days ahead that use the live forecast. |
| `RECENT_BACK` | `60` | Days back served by the forecast API before switching to the archive API. |
| `TYPICAL_YEARS` | `10` | Years of history used for typical values. |
| `TYPICAL_WINDOW` | `3` | ± days around each date that count toward typical. |
| `CACHE_VERSION` | `v5` |
| `CACHE_DAYS` | `7` | Days a viewer's cached typical values are reused. |
| `SST_FIRST_YEAR` | `2023` | First year with water-temperature history. |
| `UV_FIRST_YEAR` | `2022` | First year with UV history. |
| `PORT_RAIN_IN` | `0.02` | Inches of rain during port hours that count as a wet port day (typical only). | Bump to invalidate every viewer's cached typical values. |

## Typical (climatology) calculation

Function `loadTypical()`:

- **Years:** the 10 full years before the cruise year, or before the current year if that is earlier.
- **Requests:** one Archive API request and one Marine API request per year. Every unique location goes into a single request (comma-separated `latitude`/`longitude`), and the date range is cruise `start − 3` to `end + 3`, moved into that year. Marine history is requested with `models=era5_ocean`, retried without the model parameter if that fails.
- **Archive request parameters:** `daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,apparent_temperature_max,relative_humidity_2m_mean,wind_direction_10m_dominant,sunrise,sunset`, `temperature_unit=fahrenheit`, `wind_speed_unit=kn`, `precipitation_unit=inch`, `timezone=auto`.
- **Marine request parameters:** `daily=wave_height_max`, `timezone=auto`.
- **Per day:** collects every value from the same calendar date ±3 days across all 10 years (up to 70 samples) at that day's location, then:
  - high, low, wind, wave height, feels-like, humidity, water temperature: median of the samples
  - wind direction: vector mean of the daily dominant directions, shown as an 8-point compass
  - sunrise/sunset: the most recent year's value for the same calendar date
  - UV: from `historical-forecast-api.open-meteo.com/v1/forecast` (`daily=uv_index_max`), one request per history year from 2022 onward (`UV_FIRST_YEAR`), median of the samples. The archive API has no UV.
  - rain while in port (port days with both `arrive` and `depart`): one extra Archive API request per year for just those port locations, `hourly=precipitation` in inches. For each sample day, precipitation is summed over the port hours (same hour window as the forecast version). The figure is the percentage of sample days where that sum is at least 0.02 in (`PORT_RAIN_IN`). Shown as "A shower while in port on N% of past days" on the card, "a shower on N% of past days" in the WhatsApp day post and "showers in port N% of days" in the voyage post. This counts brief showers, so it can be well above the "Rainy days" figure, which counts days with at least 0.1 in.
  - "Rainy days" %: share of samples with `precipitation_sum ≥ 0.1 in`
  - sky icon: from the rainy-days % (under 25 → 🌤️, 25–49 → ⛅, 50+ → 🌦️)
- **Cache:** the result is stored in `localStorage` under `typ:<CACHE_VERSION>:<slug>:<itinerary fingerprint>`, with a timestamp, and reused for `CACHE_DAYS` (7) days. It is only stored when temperatures, wave heights and UV all came back, so a partial load (for example after a rate-limit refusal) is retried on the next visit. Bump `CACHE_VERSION` whenever the typical calculation gains or changes a field, otherwise viewers keep the old cached values. Editing any day's date or coordinates changes the fingerprint and forces a recalculation. The Refresh button clears this cache for the current cruise.

## Live / recorded calculation

Functions `loadLive()` (forecast API) and `loadArchiveActual()` (archive API). Each sends one weather request and one marine request covering all unique locations, with the date range set to the earliest and latest qualifying itinerary dates.

- **Weather `daily` fields:** `weather_code, temperature_2m_max, temperature_2m_min, apparent_temperature_max, relative_humidity_2m_mean, precipitation_probability_max, precipitation_sum, wind_speed_10m_max, wind_gusts_10m_max, wind_direction_10m_dominant, sunrise, sunset`. The archive API omits `precipitation_probability_max`.
- **Hourly fields:** `precipitation_probability` (forecast only), used for the port-hours rain chance below.
- **Marine fields:** `daily=wave_height_max`, `hourly=sea_surface_temperature` (°F). Water temperature is the mean of that day's hourly values. For typical days, water-temperature history only exists from 2023 onward (`SST_FIRST_YEAR`) and not in the ERA5-Ocean model, so the typical calculation makes a separate marine request (default model, `hourly=sea_surface_temperature`) for each history year from 2023 onward and takes the median of the daily means. Typical water temperature is therefore based on about three years, not ten.
- **UV:** `uv_index_max`, rounded. Typical days use the median from the Historical Forecast API (below). Shown with its category: under 3 low, 3–5 moderate, 6–7 high, 8–10 very high, 11+ extreme.
- **Port-hours rain** (function `portRain()`, forecast port days that have both `arrive` and `depart`): the highest hourly `precipitation_probability` from the arrival hour (rounded down) up to, but not including, the departure hour (rounded up). Shown on the card as "☔ N% chance of rain while in port (arrive – depart)" and in the WhatsApp day post as "🏝️ While in port …".
- **Extra detail:** feels-like (`apparent_temperature_max`), mean humidity, dominant wind direction converted to an 8-point compass (N, NE, … NW), and sunrise/sunset in the location's local time. These appear as a line under the stats on the day card and in the WhatsApp day post. Typical days use the typical values.
- **Units:** °F, knots, inches. Wave height arrives in meters and is converted to feet (× 3.28084, one decimal).
- **Rain display:** Forecast days show `precipitation_probability_max` as "Rain chance". Recorded days show `precipitation_sum` in inches.
- **Sky label** (function `sky()`): Open-Meteo's daily `weather_code` is the worst hour of the day, so a single passing shower labels the day "Drizzle". The label is therefore built from both `weather_code` and `cloud_cover_mean`:
  - Clear/cloudy codes (0–3): label from mean cloud cover. Under 25% = ☀️ Sunny, 25–49% = 🌤️ Mostly sunny, 50–74% = ⛅ Partly cloudy, 75%+ = ☁️ Mostly cloudy.
  - Drizzle/rain/shower codes (51–67, 80–82) or thunderstorm codes (95+): if rain is unlikely (forecast rain chance under 50%, or recorded rain under 0.1 in), the cloud-cover label plus ", passing showers possible" or ", isolated storms possible". Otherwise the WMO label (function `wx()`), e.g. 🌧️ Rain, ⛈️ Thunderstorms.
  - Fog and snow codes: the WMO label.

## Display rules

- **Sea state** (function `seaState()`, daily max combined wave height): under 4 ft = Slight (green), 4–8 ft = Moderate (amber), 8 ft or more = Rough (red).
- **Wind:** compass direction plus daily max sustained wind in knots, with mph = kn × 1.15078 in brackets. Gusts are shown on forecast and recorded days when they exceed the sustained wind by more than 2 kn.
- **Status pill** (function `status()`): "Sails in N days" before departure, "Day X of Y" during the cruise (that day's card is outlined and marked Today), "Voyage complete" afterwards.
- **Map:** Leaflet with OpenStreetMap tiles. A dashed line runs through every day's position in order. Ports are white dots, sea days small navy dots, and today's position is red.
- **Home page:** loads `cruises/index.json`, then every listed cruise file. Cruises are split into Upcoming (end date today or later, soonest first) and Past voyages (most recent first).

## Live position (AIS)

- **Track button:** opens the ship on MarineTraffic (by IMO) in a new tab. Shown whenever the cruise has an `imo`.
- **Embedded live map:** shown from the day before sailing to the day after it ends, when the cruise has an `imo`. It is VesselFinder's free embeddable map, framed directly from `https://www.vesselfinder.com/aismap?width=100%25&height=320&names=true&imo=<imo>&track=true&fleet=false&clicktoact=false&store_pos=false&ra=<page url>` (the URL their documented `aismap.js` embed script builds). `track=true` draws the last 24 hours of track. The iframe is cross-origin with `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"`; `allow-same-origin` here refers to VesselFinder's own origin, which their map needs, and gives it no access to this page.
- Both use land-based AIS, so positions far offshore can be hours old. The estimated position below fills that gap.

## Estimated ship position

Shown from the day before sailing to the day after it ends. It's estimated from the itinerary, not tracked; the live map and Track button show the real (AIS) position.

- **Time zones:** one Open-Meteo forecast request (`forecast_days=1`, `timezone=auto`) for every location supplies each location's `utc_offset_seconds`. Itinerary times are treated as local time at that location.
- **Waypoints** (function `waypoints()`): ports contribute an arrival and/or departure point at their listed times. A port with no times gets noon. Sea days contribute their position at local noon.
- **Position** (function `shipNow()`), recalculated every 5 minutes:
  - between a port's arrival and departure: in port, "all aboard before <depart>"
  - between any other two waypoints: straight-line interpolation by elapsed time, "At sea, heading to <next port> · arrives <day> <time>"
  - up to 18 hours before the first departure: in port at the embarkation port
  - up to 12 hours after the last arrival: "Arrived in <port>"
  - otherwise: hidden
- **Display:** a 🚢 marker on the map and a line under it.

## Tropical storm alerts

NHC's `CurrentStorms.json` can't be read from a browser (NHC doesn't allow cross-origin requests), so a GitHub Action keeps a copy in the repo.

- **Action** (`.github/workflows/storms.yml`): runs every 3 hours at :23, and can be run manually from the Actions tab (Run workflow). It downloads `https://www.nhc.noaa.gov/CurrentStorms.json`, runs `scripts/normalize_storms.py`, and commits `data/storms.json` only if it changed. The normalized file contains only advisory data (no fetch timestamp), so quiet periods produce no commits. Each commit redeploys Pages.
- **Normalized fields per storm:** `id, name, classification, intensityKt, pressureMb, lat, lon, movementDir, movementSpeedKt, advisoryUrl, lastUpdate`.
- **Page check** (function `loadStorms()`): runs when today is no more than 21 days before the cruise starts and not after it ends. For each storm, the great-circle distance in nautical miles to every itinerary point is calculated, and the closest one is kept. Storms within 600 nm of the route show an orange banner under the header with the type (HU = Hurricane, TS = Tropical Storm, TD = Tropical Depression, and so on), name, wind, distance, nearest itinerary point and a link to the NHC advisory.
- **WhatsApp:** each nearby storm adds a "⚠️ …" line to day posts and to the full-voyage post.
- **Tuning:** `STORM_RADIUS_NM` (600) and `STORM_LOOKAHEAD_DAYS` (21) at the top of the storms section of `app.js`.

## WhatsApp posts

Every day card is built from one view model (function `dayModel()`). The card (`dayCard()`) and both WhatsApp texts read from that same model, so a post always matches what the page shows. The copy buttons stay disabled until weather has loaded.

| Button | Text built by | Contents |
|---|---|---|
| **Copy today's post** (top of Voyage weather) | `waDay()` | During the cruise, today's itinerary day. Before the cruise, day 1. After it, the last day. |
| **Copy** (on each day card) | `waDay()` | That day. |
| **Copy full voyage** | `waVoyage()` | One entry per day: date and place; sky, high/low, wind, seas; then, when available, port-hours rain chance, UV and water temperature. Entries using all-typical values are marked _(typical)_; forecast days whose seas fall back to typical are marked _(typical seas)_, each with a matching footnote. Today is marked ⬅️ today. |

Day post format (WhatsApp renders `*text*` as bold and `_text_` as italics). Lines with no data are left out:

```
🚢 *<ship> – Day N (Mon Nov 30)*
📍 <port> · <arrive – depart> · <note>      or   📍 Sea day 🌊 <sea area> (approx.)
🌡️ High 84°F (29°C) / Low 79°F (26°C)
⛅ Sky: <label> · ☔ <n>% chance of rain          (rain chance on forecast days only)
🏝️ While in port (9:00 AM – 6:00 PM): 45% chance of rain   (typical: "a shower on N% of past days")
😎 Feels like: 88°F (31°C) · 💧 74% humidity
🕶️ UV 7 (high) · 🏊 Water 84°F (29°C)
🌅 Sunrise 6:31am · 🌇 Sunset 5:40pm
💨 Wind: E 19 kt (22 mph / 35 km/h), gusts 25 kt
🌊 Seas: 6.1 ft (1.9 m) · Moderate
⚠️ <storm line, if any>                        (NHC)
🔜 Tomorrow: Arriving in <NEXT PORT> <icon> <label>, <high>°F (<°C>), seas <ft> ft
📅 Full trip forecast: <page link>
```

Conversions: °C = (°F − 32) × 5/9; km/h = kn × 1.852; m = ft ÷ 3.28084. The "Tomorrow" line is left out on the last day. When the day is still showing typical values, or only its seas are typical, the post ends with a note saying which.

Copying uses `navigator.clipboard.writeText`. If the browser blocks that, it falls back to a hidden textarea and `document.execCommand('copy')`. A toast confirms the copy or reports the failure.

## Link preview

`index.html` carries Open Graph tags (`og:title`, `og:description`, `og:image`, `og:url`), so a shared link shows a preview card in WhatsApp. The image is `assets/og.png` (1200 × 630). Link previewers don't run JavaScript, so every cruise link shows the same generic card. The cruise details come from the post text.

## Failure behavior

- A weather request that fails resolves to empty, and the cards show `—` for the missing fields. If no weather loads at all, the "Updated" line says the weather service is unavailable. The itinerary and map still render.
- If Leaflet fails to load, the map box is removed.
- A bad or missing `?c=` slug shows "Cruise not found" with a link back to the list.

## External dependencies

| Service | Used for | Key / limits |
|---|---|---|
| Open-Meteo (forecast, archive, marine) | All weather data | No key. Free for non-commercial use, attribution required (in the footer). |
| NOAA National Hurricane Center | Active storms (via the GitHub Action) | No key. Public data. |
| unpkg.com (Leaflet 1.9.4) | Map library | None |
| OpenStreetMap tiles | Map tiles | Attribution required (shown on the map) |
| MarineTraffic | Track button (link only) | — |
| VesselFinder | Embedded live map during the cruise (`aismap.js` in an iframe) | Free embed, no key |
