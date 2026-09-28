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
- **Route with several points**: add points by searching a place, typing coordinates (`54.32, 10.14`), tapping 🎯 then the map, or long-pressing the map
  - drag a point to move it, tap a leg to insert a point, tap a point to target or delete it
  - ⏭ skips to the next point (e.g. when you stayed too far from a point), ⏮ goes back to the previous one
- **Automatic switching** to the next point when the mark is rounded (see below), with a message and vibration
- Display: VMG to the active point, "Targeting point X/Y", distance to finish, deviation of COG from bearing, SOG, COG, bearing, distance (nm), ETA, GPS accuracy
- Map lines: dark red dashed = boat to active point, dark red = remaining route, grey = done, dark green = where you'll be in 5 minutes
- Demo mode (▶︎) with sliders for course and speed plus time-lapse (×10/×60) – for testing on land

## When is a point reached?

The app switches to the next point when the boat crosses the **bisector** of the turn at that point
(the line halfway between the incoming and outgoing leg), from the incoming to the outgoing side:

- on the **outer side** of the turn (beyond the mark) within a **safety radius of 300 m**,
- on the **inner side** (between the two legs) within a limit that shrinks with the sharpness of the turn:
  300 m × sin²(angle between the legs / 2), at least 30 m – i.e. straight on 300 m, 90° turn 150 m,
  135° turn 44 m, hairpin 30 m. So missing a 90° mark on the inside still switches, while tacking up a
  hairpin leg does not switch too early,
- the last point uses a finish line perpendicular to the last leg.

The incoming leg of point 1 starts at the **start position**: where the boat was when the first point was set
(or at the first GPS fix / demo start). It is saved with the route, shown as a blue **S** on the map (tap it to see
the start time or to reset it to the current boat position). Later legs start at the previous point.

There is deliberately no pure "arrival circle": it would switch too early in hairpin turns, while you still
have a few metres to sail round the mark. If you never get close enough, use ⏭ (and ⏮ to go back).
The values are `PASS_RADIUS_M` and `CUT_RADIUS_M` in `js/nav.js`.
- Screen stays on (Wake Lock); app files and previously viewed map tiles work offline

## Project structure

| File | Purpose |
|---|---|
| `index.html` | Page layout |
| `css/style.css` | Styling |
| `js/nav.js` | Navigation math (distance, bearing, VMG, ETA, waypoint passing) – no browser dependency |
| `js/route.js` | Route editing (add, insert, move, delete, active point) – pure functions |
| `js/app.js` | Map, GPS, search, route UI, display, demo |
| `sw.js` | Service worker (offline cache) |
| `manifest.webmanifest` | Makes the page installable as an app |
| `tests/nav.test.mjs` | Tests for the basic navigation math |
| `tests/waypoint.test.mjs` | Tests for waypoint passing and route editing |

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
