# Cruise Weather

A static site, hosted on GitHub Pages, that shows day-by-day weather and sea conditions along a cruise itinerary. There is no server, build step, API key or scheduled job. The browser fetches everything when the page loads.

- Cruise list: `https://riedling11.github.io/cruises/`
- A single cruise: `https://riedling11.github.io/cruises/?c=<slug>`

## Repository layout

| Path | Purpose |
|---|---|
| `index.html` | Page shell. Loads Leaflet (map) from unpkg, then `assets/app.js`. Marked `noindex, nofollow`. |
| `assets/app.js` | All logic: routing, data fetches, the typical/forecast/recorded calculations, rendering. |
| `assets/style.css` | Mobile-first styles, with automatic dark mode. |
| `cruises/index.json` | The list of cruise slugs shown on the home page. |
| `cruises/<slug>.json` | One itinerary per cruise. This is the only file that changes per cruise. |
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
| `imo` | no | Ship's IMO number. Builds the "Track" link to `vesselfinder.com/vessels/details/<imo>`. If absent, `trackerUrl` is used instead, if present. |
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
| `CACHE_VERSION` | `v1` | Bump to invalidate every viewer's cached typical values. |

## Typical (climatology) calculation

Function `loadTypical()`:

- **Years:** the 10 full years before the cruise year, or before the current year if that is earlier.
- **Requests:** one Archive API request and one Marine API request per year. Every unique location goes into a single request (comma-separated `latitude`/`longitude`), and the date range is cruise `start − 3` to `end + 3`, moved into that year. Marine history is requested with `models=era5_ocean`, retried without the model parameter if that fails.
- **Archive request parameters:** `daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max`, `temperature_unit=fahrenheit`, `wind_speed_unit=kn`, `precipitation_unit=inch`, `timezone=auto`.
- **Marine request parameters:** `daily=wave_height_max`, `timezone=auto`.
- **Per day:** collects every value from the same calendar date ±3 days across all 10 years (up to 70 samples) at that day's location, then:
  - high, low, wind, wave height: median of the samples
  - "Rainy days" %: share of samples with `precipitation_sum ≥ 0.04 in`
  - sky icon: from the rainy-days % (under 25 → 🌤️, 25–49 → ⛅, 50+ → 🌦️)
- **Cache:** the result is stored in `localStorage` under `typ:v1:<slug>:<itinerary fingerprint>`. Editing any day's date or coordinates changes the fingerprint and forces a recalculation. The Refresh button clears this cache for the current cruise.

## Live / recorded calculation

Functions `loadLive()` (forecast API) and `loadArchiveActual()` (archive API). Each sends one weather request and one marine request covering all unique locations, with the date range set to the earliest and latest qualifying itinerary dates.

- **Weather `daily` fields:** `weather_code, temperature_2m_max, temperature_2m_min, precipitation_probability_max, precipitation_sum, wind_speed_10m_max, wind_gusts_10m_max`. The archive API omits `precipitation_probability_max`.
- **Units:** °F, knots, inches. Wave height arrives in meters and is converted to feet (× 3.28084, one decimal).
- **Rain display:** Forecast days show `precipitation_probability_max` as "Rain chance". Recorded days show `precipitation_sum` in inches.
- **Sky icon:** from the WMO `weather_code` (function `wx()`).

## Display rules

- **Sea state** (function `seaState()`, daily max combined wave height): under 4 ft = Slight (green), 4–8 ft = Moderate (amber), 8 ft or more = Rough (red).
- **Wind:** daily max sustained wind in knots, with mph = kn × 1.15078 in brackets. Gusts are shown on forecast and recorded days.
- **Status pill** (function `status()`): "Sails in N days" before departure, "Day X of Y" during the cruise (that day's card is outlined and marked Today), "Voyage complete" afterwards.
- **Map:** Leaflet with OpenStreetMap tiles. A dashed line runs through every day's position in order. Ports are white dots, sea days small navy dots, and today's position is red.
- **Home page:** loads `cruises/index.json`, then every listed cruise file. Cruises are split into Upcoming (end date today or later, soonest first) and Past voyages (most recent first).

## Failure behavior

- A weather request that fails resolves to empty, and the cards show `—` for the missing fields. If no weather loads at all, the "Updated" line says the weather service is unavailable. The itinerary and map still render.
- If Leaflet fails to load, the map box is removed.
- A bad or missing `?c=` slug shows "Cruise not found" with a link back to the list.

## External dependencies

| Service | Used for | Key / limits |
|---|---|---|
| Open-Meteo (forecast, archive, marine) | All weather data | No key. Free for non-commercial use, attribution required (in the footer). |
| unpkg.com (Leaflet 1.9.4) | Map library | None |
| OpenStreetMap tiles | Map tiles | Attribution required (shown on the map) |
| VesselFinder | Link only, never fetched | — |
