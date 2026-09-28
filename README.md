# VMG Sailing

Web app (PWA) for sailors that shows the **VMG – Velocity Made Good** towards a chosen target:
how fast you are actually closing in on it.

```
VMG = SOG × cos(COG − bearing to target)
```

- **SOG** speed over ground (from GPS)
- **COG** course over ground (from GPS)
- **Bearing** direction from the boat to the target

## Features

- Map (OpenStreetMap) with seamark overlay (OpenSeaMap)
- Set target: search a place, type coordinates (`54.32, 10.14`), tap 🎯 then the map, or long-press the map; the target flag can be dragged
- Display: VMG, deviation of COG from bearing, SOG, COG, bearing, distance (nm), ETA, GPS accuracy
- Map lines: dark red dashed = straight line to target, dark green = where you'll be in 5 minutes
- Demo mode (▶︎) with sliders for course and speed – for testing on land
- Screen stays on (Wake Lock); app files and previously viewed map tiles work offline

## Project structure

| File | Purpose |
|---|---|
| `index.html` | Page layout |
| `css/style.css` | Styling |
| `js/nav.js` | Navigation math (distance, bearing, VMG, ETA) – no browser dependency |
| `js/app.js` | Map, GPS, search, display, demo |
| `sw.js` | Service worker (offline cache) |
| `manifest.webmanifest` | Makes the page installable as an app |
| `tests/nav.test.mjs` | Tests for `nav.js` |

No build step, no dependencies – Leaflet is loaded from a CDN.

## Run locally

Requires [Node.js](https://nodejs.org).

```bash
npm start
```

Then open http://localhost:8080. Tests:

```bash
npm test
```

## Use on the phone (GitHub Pages)

Browsers only allow GPS over HTTPS – GitHub Pages provides that for free.

1. On github.com create a new, empty public repository `VMG_APP` (no README).
2. Connect and upload:
   ```bash
   git remote add origin https://github.com/<username>/VMG_APP.git
   git push -u origin main
   ```
3. In the repository: **Settings → Pages → Source: Deploy from a branch → Branch `main`, folder `/ (root)` → Save**.
4. After ~1 minute the app is live at `https://<username>.github.io/VMG_APP/`.
5. On the Android phone open it in Chrome → allow location → menu ⋮ → **Add to Home screen**.

## Limitations of version 1

- No wind or current: VMG is towards the target (strictly VMC), not towards the wind. Without wind data the app cannot judge whether a course is optimal.
- Map offline only for areas viewed before.
- Place search needs internet (Nominatim).
- GPS pauses when the screen is off or the app is in the background.
