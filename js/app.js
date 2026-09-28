// UI: map, GPS, route editing, display, demo mode.
// The math lives in nav.js, route editing in route.js.
import {
  angleDiff, bearing, destinationPoint, distance, etaSeconds,
  knotsToMs, motionFromFixes, msToKnots, mToNm, passedWaypoint, vmg,
} from './nav.js';
import {
  activePoint, addPoint, emptyRoute, insertPoint, isFinished, legStart, movePoint,
  nearestSegment, removePoint, sanitizeRoute, setActive, setStart,
} from './route.js';

const L = window.L; // Leaflet is loaded as a classic <script>
const $ = (id) => document.getElementById(id);

const ROUTE_KEY = 'vmg.route';
const SETTINGS_KEY = 'vmg.settings';
const NOTICE_KEY = 'vmg.noticeAccepted';
const NOTICE_VERSION = '1'; // raise to show the safety notice again after changing it
const DEFAULT_SETTINGS = {
  autoAdvance: true,  // switch to the next point automatically when rounded
  showDecimal: true,  // small grey second decimal of the VMG (trend only – GPS is ±0.1–0.2 kn)
};
// Smooth display: GPS delivers ~1 fix/s; in between the boat is moved on by dead reckoning
const FRAME_MS = 100;      // redraw ~10×/s – smooth enough and easy on the battery
const MAX_PREDICT_S = 2;   // stop extrapolating if no new fix arrives for this long
const EASE = 0.3;          // how fast displayed numbers follow new values (0..1 per frame)
const GOOD_ACCURACY_M = 50; // fixes less accurate than this (GPS warm-up) are shown but not used for navigation
const OLD_TARGET_KEY = 'vmg.target'; // v0.1 stored a single target
const SMOOTHING = 0.35;        // 0..1, higher = reacts faster but jitters more
const MIN_SOG_FOR_COG_MS = knotsToMs(0.3); // below this, GPS course is just noise
const ON_COURSE_DEG = 3;       // deviation below this counts as "on course"

const state = {
  pos: null,          // {lat, lon}
  acc: null,          // GPS accuracy in m
  vel: null,          // smoothed velocity vector {ve, vn} in m/s (east/north)
  fixes: [],          // recent GPS fixes for the fallback calculation
  route: loadRoute(), // {points, active, start} – see route.js
  settings: loadSettings(),
  passedNotified: null, // index of the point whose "passed" message was shown (manual mode)
  gpsGood: false,     // last fix accurate enough for navigation (see GOOD_ACCURACY_M)
  lastGood: null,     // last accurate fix – used to detect passing a point
  mapTouched: false,  // user has touched the map -> don't move the view automatically
  fixTime: null,      // performance.now() of the last fix, for dead reckoning
  timeFactor: 1,      // demo time-lapse factor (1 with real GPS)
  shown: { vmg: null, sog: null }, // eased values currently on screen
  follow: true,       // map follows the boat
  picking: false,     // "tap map to add points" mode
  demo: false,
  demoTimer: null,
  gpsWatch: null,
};

// ---------------------------------------------------------------- Map
const startView = activePoint(state.route) ?? state.route.points[0];
const map = L.map('map', { zoomControl: true, attributionControl: true })
  .setView(startView ? [startView.lat, startView.lon] : [47.6, 9.4], 11);

// The map ends above the display panel (its height changes, e.g. in demo mode)
const panel = document.querySelector('.panel');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--panel-h', `${panel.offsetHeight - 16}px`);
  map.invalidateSize();
}).observe(panel);

const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: 'Seamarks © <a href="https://www.openseamap.org/">OpenSeaMap</a>',
}).addTo(map);
map.attributionControl.setPrefix('<a href="about.html">About &amp; Legal</a> · <a href="https://leafletjs.com/">Leaflet</a>');
L.control.layers({ OpenStreetMap: osm }, { 'Seamarks (OpenSeaMap)': seamarks }, { position: 'bottomleft' }).addTo(map);

const boatIcon = L.divIcon({
  className: '',
  iconSize: [36, 36],
  iconAnchor: [18, 18],
  html: `<div class="boat-icon" id="boat-rot"><svg viewBox="0 0 36 36">
    <path d="M18 3 L27 31 L18 25 L9 31 Z" fill="#ffb020" stroke="#0b2239" stroke-width="2"/></svg></div>`,
});

let boatMarker = null;
let accCircle = null;
// Dark, thick lines so they stay visible in sunlight
const donePath = L.polyline([], { color: '#6b7280', weight: 2, opacity: 0.8, dashArray: '4 6' }).addTo(map);
const routePath = L.polyline([], { color: '#7f1d1d', weight: 3, opacity: 0.85 }).addTo(map);
const targetLine = L.polyline([], { color: '#b91c1c', weight: 4, opacity: 0.9, dashArray: '10 8' }).addTo(map);
const headingLine = L.polyline([], { color: '#166534', weight: 5, opacity: 0.95 }).addTo(map);
// Invisible wide line on top of the route, so a leg is easy to tap for inserting a point
const hitPath = L.polyline([], { color: '#000', weight: 24, opacity: 0 }).addTo(map);
const markers = L.layerGroup().addTo(map);

// As soon as the user touches the map, stop following the boat so the map doesn't move under
// the finger (e.g. while placing points). ⌖ turns following back on.
map.getContainer().addEventListener('pointerdown', () => {
  state.mapTouched = true;
  setFollow(false);
});

function setFollow(on) {
  state.follow = on;
  $('btn-center').classList.toggle('active', on);
}

map.on('click', (e) => {
  if (state.picking) addWaypoint({ lat: e.latlng.lat, lon: e.latlng.lng });
});
// Long press (phone) or right click always adds a point
map.on('contextmenu', (e) => addWaypoint({ lat: e.latlng.lat, lon: e.latlng.lng }));

hitPath.on('click', (e) => {
  L.DomEvent.stopPropagation(e);
  const p = { lat: e.latlng.lat, lon: e.latlng.lng };
  const seg = nearestSegment(state.route.points, p);
  if (seg < 0) return;
  L.popup().setLatLng(e.latlng).setContent(popupButtons([
    [`Insert point between ${seg + 1} and ${seg + 2}`, () => setRoute(insertPoint(state.route, seg + 1, p))],
  ])).openOn(map);
});

// ---------------------------------------------------------------- Route
function loadRoute() {
  try {
    const r = sanitizeRoute(JSON.parse(localStorage.getItem(ROUTE_KEY)));
    if (r.points.length) return r;
    const old = JSON.parse(localStorage.getItem(OLD_TARGET_KEY));
    if (old && Number.isFinite(old.lat) && Number.isFinite(old.lon)) return sanitizeRoute({ points: [old], active: 0 });
  } catch { /* storage unavailable or broken – start empty */ }
  return emptyRoute();
}

function setRoute(r) {
  if (r.active !== state.route.active) state.passedNotified = null;
  state.route = r;
  try {
    localStorage.setItem(ROUTE_KEY, JSON.stringify(r));
    localStorage.removeItem(OLD_TARGET_KEY);
  } catch { /* storage unavailable – not critical */ }
  map.closePopup();
  drawRoute();
  if (state.pos) drawBoat();
  render();
}

function addWaypoint(p) {
  const first = state.route.points.length === 0;
  let r = addPoint(state.route, p);
  // Remember where we started (reference for the first leg); without GPS yet it is set at the first fix
  // (only from an accurate fix – during GPS warm-up it is set later, at the first accurate fix)
  if (!r.start && state.lastGood) r = setStart(r, state.lastGood);
  setRoute(r);
  if (first && state.pos) {
    map.fitBounds([[state.pos.lat, state.pos.lon], [p.lat, p.lon]], { padding: [60, 60], maxZoom: 15 });
    setFollow(false);
  }
}

/** Advance to the next point, automatically (mark passed) or by the ⏭ button. */
function advance(auto) {
  const r = state.route;
  if (!activePoint(r)) { toast(r.points.length ? 'Route already finished' : 'No route set'); return; }
  const next = r.active + 1; // 0-based index of the new active point
  setRoute(setActive(r, next));
  const done = next >= r.points.length;
  if (auto) {
    toast(done ? `🏁 Point ${next} reached – route finished` : `✓ Point ${next} reached → targeting point ${next + 1}`, true);
  } else {
    toast(done ? 'Skipped – route finished' : `⏭ Skipped → targeting point ${next + 1}`);
  }
}

/** Go back to the previous point (⏮ button). */
function goBack() {
  const r = state.route;
  if (!r.points.length) { toast('No route set'); return; }
  if (r.active === 0) { toast('Already at point 1'); return; }
  const prev = Math.min(r.active, r.points.length) - 1; // from "finished" back to the last point
  setRoute(setActive(r, prev));
  toast(`⏮ Back → targeting point ${prev + 1}`);
}

/** Check whether the boat just rounded the active point (bisector gate, see nav.js). */
function checkPassing(prev, pos) {
  let r = state.route;
  const wp = activePoint(r);
  if (!wp) return;
  if (!r.start) setRoute(r = setStart(r, prev)); // route was set before GPS was available
  if (!passedWaypoint(prev, pos, legStart(r), wp, r.points[r.active + 1] ?? null)) return;
  if (state.settings.autoAdvance) {
    advance(true);
  } else if (state.passedNotified !== r.active) {
    // Manual mode: only tell the sailor, once per point
    state.passedNotified = r.active;
    const last = r.active === r.points.length - 1;
    toast(`✓ Point ${r.active + 1} passed${last ? '' : ' – tap ⏭ for the next point'}`, true);
  }
}

// ---------------------------------------------------------------- Options
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* not critical */ }
}

$('btn-settings').addEventListener('click', () => {
  $('opt-auto').checked = state.settings.autoAdvance;
  $('opt-decimal').checked = state.settings.showDecimal;
  $('settings').hidden = false;
});
for (const [id, key] of [['opt-auto', 'autoAdvance'], ['opt-decimal', 'showDecimal']]) {
  $(id).addEventListener('change', () => {
    state.settings[key] = $(id).checked;
    saveSettings();
    render();
  });
}
$('settings-close').addEventListener('click', () => { $('settings').hidden = true; });
// Tap on the dark background closes the sheet as well
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });

function wpIcon(i) {
  const cls = i < state.route.active ? 'wp wp-done' : i === state.route.active ? 'wp wp-active' : 'wp';
  return L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: `<div class="${cls}">${i + 1}</div>` });
}

function drawRoute() {
  const { points, active, start } = state.route;
  const ll = points.map(ptToLL);
  // Grey: from the start position through the points already done
  donePath.setLatLngs([...(start ? [ptToLL(start)] : []), ...ll.slice(0, Math.min(active, points.length - 1) + 1)]);
  routePath.setLatLngs(ll.slice(active));
  hitPath.setLatLngs(ll);

  markers.clearLayers();
  if (start && points.length) {
    const time = start.t ? new Date(start.t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    const s = L.marker(ptToLL(start), {
      icon: L.divIcon({ className: '', iconSize: [24, 24], iconAnchor: [12, 12], html: '<div class="wp wp-start">S</div>' }),
    });
    s.bindPopup(() => popupButtons(
      state.lastGood ? [['Set start to boat position', () => { setRoute(setStart(state.route, state.lastGood)); toast('Start set to boat position'); }]] : [],
      `Start${time ? ` (${time})` : ''}`,
    ));
    markers.addLayer(s);
  }
  points.forEach((p, i) => {
    const m = L.marker(ptToLL(p), { icon: wpIcon(i), draggable: true, zIndexOffset: i === active ? 500 : 0 });
    m.on('dragend', () => {
      const q = m.getLatLng();
      setRoute(movePoint(state.route, i, { lat: q.lat, lon: q.lng }));
    });
    m.bindPopup(() => popupButtons([
      [`Target point ${i + 1}`, () => { setRoute(setActive(state.route, i)); toast(`Targeting point ${i + 1}`); }],
      [`Delete point ${i + 1}`, () => setRoute(removePoint(state.route, i))],
    ], p.name));
    markers.addLayer(m);
  });
}

/** Small popup with one button per [label, action]. */
function popupButtons(buttons, title) {
  const div = document.createElement('div');
  div.className = 'wp-popup';
  if (title) {
    const t = document.createElement('div');
    t.className = 'wp-popup-title';
    t.textContent = title;
    div.appendChild(t);
  }
  for (const [label, action] of buttons) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', action);
    div.appendChild(b);
  }
  return div;
}

function setPicking(on) {
  state.picking = on;
  $('btn-pick').classList.toggle('active', on);
  $('hint').hidden = !on;
}

// ---------------------------------------------------------------- Messages
let toastTimer = null;
function toast(msg, vibrate = false) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  if (vibrate) {
    try { navigator.vibrate?.([200, 100, 200]); } catch { /* not supported */ }
  }
}

// ---------------------------------------------------------------- Search
$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-input').value.trim();
  const list = $('search-results');
  if (!q) { list.hidden = true; return; }

  const addFound = (p) => {
    addWaypoint(p);
    list.hidden = true;
    $('search-input').blur();
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 13));
    setFollow(false);
  };

  // Coordinates typed directly, e.g. "54.32, 10.14"
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) { addFound({ lat: +m[1], lon: +m[2], name: q }); return; }

  list.innerHTML = '<li>Searching …</li>';
  list.hidden = false;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const hits = await res.json();
    list.innerHTML = '';
    if (!hits.length) { list.innerHTML = '<li>Nothing found</li>'; return; }
    for (const h of hits) {
      const li = document.createElement('li');
      li.textContent = h.display_name;
      li.addEventListener('click', () => addFound({ lat: +h.lat, lon: +h.lon, name: h.display_name.split(',')[0] }));
      list.appendChild(li);
    }
    // Required attribution for the search service
    const credit = document.createElement('li');
    credit.className = 'search-credit';
    credit.innerHTML = 'Search by <a href="https://nominatim.org/">Nominatim</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    list.appendChild(credit);
  } catch (err) {
    list.innerHTML = '';
    const li = document.createElement('li');
    li.textContent = `Search failed (${err.message}). Offline?`;
    list.appendChild(li);
  }
});

// ---------------------------------------------------------------- Position & motion
/** Process a new position plus speed/course if the device provides them. */
function updateMotion(pos, sogMs, cogDeg, acc, t) {
  state.pos = pos;
  state.acc = acc;

  // While GPS is warming up (network location, ±100 m and more) positions jump around:
  // show them, but don't use them for course/speed, the start position or passing points.
  state.gpsGood = !(acc > GOOD_ACCURACY_M);
  if (!state.gpsGood) {
    state.vel = null;
    state.fixes = [];
    state.fixTime = null;
    state.lastGood = null;
    drawBoat();
    render();
    return;
  }
  const prev = state.lastGood;
  state.lastGood = pos;
  state.fixTime = performance.now();

  // Fallback: derive speed/course from recent fixes (>= 3 s apart)
  state.fixes.push({ ...pos, t });
  while (state.fixes.length > 2 && t - state.fixes[1].t >= 3000) state.fixes.shift();
  const deviceHasMotion = Number.isFinite(sogMs) && (sogMs < MIN_SOG_FOR_COG_MS || Number.isFinite(cogDeg));
  if (!deviceHasMotion) {
    const m = state.fixes.length > 1 ? motionFromFixes(state.fixes[0], state.fixes.at(-1)) : null;
    if (m) { sogMs = m.sog; cogDeg = m.cog; }
  }
  if (!Number.isFinite(sogMs)) sogMs = 0;
  if (!Number.isFinite(cogDeg)) cogDeg = 0;

  // Smooth as a vector (avoids trouble at the 359° -> 0° wrap)
  const r = (cogDeg * Math.PI) / 180;
  const ve = sogMs * Math.sin(r);
  const vn = sogMs * Math.cos(r);
  state.vel = state.vel
    ? { ve: state.vel.ve + SMOOTHING * (ve - state.vel.ve), vn: state.vel.vn + SMOOTHING * (vn - state.vel.vn) }
    : { ve, vn };

  if (prev) checkPassing(prev, pos);
  drawBoat();
  render();
}

function currentSogCog() {
  if (!state.vel) return { sog: 0, cog: null };
  const sog = Math.hypot(state.vel.ve, state.vel.vn);
  const cog = sog >= MIN_SOG_FOR_COG_MS
    ? ((Math.atan2(state.vel.ve, state.vel.vn) * 180) / Math.PI + 360) % 360
    : null;
  return { sog, cog };
}

const ptToLL = (p) => [p.lat, p.lon];

/**
 * Position shown on screen: the last GPS fix moved on along course and speed for the
 * time since that fix (dead reckoning), so the boat glides instead of jumping once a second.
 * The route logic (passing points) always uses the real fixes.
 */
function displayPos() {
  const { sog, cog } = currentSogCog();
  if (!state.pos || cog == null || state.fixTime == null) return state.pos;
  const dt = Math.min((performance.now() - state.fixTime) / 1000, MAX_PREDICT_S);
  return destinationPoint(state.pos, cog, sog * state.timeFactor * dt);
}

/** Let a displayed number glide towards its new value. */
function ease(key, target) {
  const s = state.shown[key];
  state.shown[key] = s == null || !Number.isFinite(target) ? target : s + EASE * (target - s);
  return state.shown[key];
}

function drawBoat() {
  const p = displayPos();
  const ll = ptToLL(p);
  const wp = activePoint(state.route);
  if (!boatMarker) {
    boatMarker = L.marker(ll, { icon: boatIcon, zIndexOffset: 1000, interactive: false }).addTo(map);
    // Jump to the boat on the first fix – but not if the user is already working on the map
    if (!state.mapTouched) {
      if (wp) map.fitBounds([ll, ptToLL(wp)], { padding: [60, 60], maxZoom: 15 });
      else map.setView(ll, 14);
    }
  } else {
    boatMarker.setLatLng(ll);
  }
  // Blue circle: how accurate the GPS position is
  if (Number.isFinite(state.acc)) {
    if (!accCircle) accCircle = L.circle(ll, { radius: state.acc, color: '#2563eb', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    accCircle.setLatLng(ll).setRadius(state.acc);
  }
  const { sog, cog } = currentSogCog();
  const rot = document.getElementById('boat-rot');
  if (rot) rot.style.transform = `rotate(${cog ?? 0}deg)`;

  // Green line: where the boat will be in 5 minutes
  headingLine.setLatLngs(cog == null ? [] : [ll, ptToLL(destinationPoint(p, cog, sog * 300))]);
  targetLine.setLatLngs(wp ? [ll, ptToLL(wp)] : []);

  if (state.follow && !state.picking) map.panTo(ll, { animate: false });
}

// ---------------------------------------------------------------- GPS
function startGps() {
  if (!('geolocation' in navigator)) {
    showStatus('This device/browser has no GPS.');
    return;
  }
  state.gpsWatch = navigator.geolocation.watchPosition(
    (p) => {
      if (state.demo) return;
      const c = p.coords;
      updateMotion({ lat: c.latitude, lon: c.longitude }, c.speed, c.heading, c.accuracy, p.timestamp);
    },
    (err) => {
      if (state.demo) return;
      const msg = {
        1: 'Location access denied. Allow it in the browser settings (or try ▶︎ demo).',
        2: 'Position unavailable.',
        3: 'GPS timeout – still searching …',
      }[err.code] || err.message;
      showStatus(msg);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
}

// ---------------------------------------------------------------- Demo
function setDemo(on) {
  state.demo = on;
  $('btn-demo').classList.toggle('active', on);
  $('btn-demo').textContent = on ? '■' : '▶︎';
  $('demo-controls').hidden = !on;
  clearInterval(state.demoTimer);
  // Start fresh so the jump between real and simulated position is not seen as movement
  let pos = state.pos ?? { lat: map.getCenter().lat, lon: map.getCenter().lng };
  state.pos = null;
  state.lastGood = null;
  state.vel = null;
  state.fixes = [];
  state.timeFactor = 1;
  state.fixTime = null;
  state.shown = { vmg: null, sog: null };
  if (!on) {
    // Remove the simulated boat until the next real GPS fix arrives
    state.acc = null;
    boatMarker?.remove();
    boatMarker = null;
    accCircle?.remove();
    accCircle = null;
    headingLine.setLatLngs([]);
    targetLine.setLatLngs([]);
    render();
    showStatus('Demo stopped – waiting for GPS …');
    return;
  }

  const wp = activePoint(state.route);
  if (!state.route.points.length) {
    // Put a target 3 nm north so there is something to see right away
    addWaypoint({ ...destinationPoint(pos, 0, 3 * 1852), name: 'Demo target' });
  } else if (wp && distance(pos, wp) < 0.5 * 1852) {
    // Boat would start (almost) on the target -> start 3 nm south-west of it
    pos = destinationPoint(wp, 225, 3 * 1852);
  }
  // The simulated trip starts here, so this is the start of the route
  if (state.route.points.length && state.route.active === 0) setRoute(setStart(state.route, pos));
  setFollow(true);
  let last = Date.now();
  const tick = () => {
    const now = Date.now();
    const course = +$('i-course').value;
    const speed = knotsToMs(+$('i-speed').value);
    const timeFactor = +$('i-sim').value; // fast-forward to test routes on land
    state.timeFactor = timeFactor;
    pos = destinationPoint(pos, course, speed * timeFactor * ((now - last) / 1000));
    last = now;
    updateMotion(pos, speed, course, 5, now);
  };
  tick();
  state.demoTimer = setInterval(tick, 1000);
}

for (const [inp, out, show] of [['i-course', 'o-course', (v) => v], ['i-speed', 'o-speed', (v) => (+v).toFixed(1)]]) {
  $(inp).addEventListener('input', () => { $(out).textContent = show($(inp).value); });
}

// ---------------------------------------------------------------- Display
function fmt(n, digits = 1) {
  return Number.isFinite(n) ? n.toFixed(digits) : '–';
}
function fmtDeg(n) {
  return Number.isFinite(n) ? String(Math.round(n) % 360).padStart(3, '0') : '–';
}
function fmtNm(m) {
  const nm = mToNm(m);
  return fmt(nm, nm < 10 ? 2 : 1);
}
function fmtDuration(s) {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return `${h} h ${String(min % 60).padStart(2, '0')}`;
}

/** Right-hand side of the VMG box: either the course deviation or a message. */
function showDeviation(value, text) {
  $('v-dev').textContent = value;
  $('v-status').textContent = text;
}
const showStatus = (text) => showDeviation('', text);

/** Distance from the boat via the active point and all following points to the end. */
function remainingRouteDistance(fromPos) {
  const { points, active } = state.route;
  let d = distance(fromPos, points[active]);
  for (let i = active; i < points.length - 1; i++) d += distance(points[i], points[i + 1]);
  return d;
}

/** VMG as big number with an optional small grey second decimal (e.g. "5.4" + "3"). */
function showVmg(kn) {
  if (!Number.isFinite(kn)) {
    $('v-vmg').textContent = '–';
    $('v-vmg2').textContent = '';
    return;
  }
  if (state.settings.showDecimal) {
    const s = kn.toFixed(2);
    $('v-vmg').textContent = s.slice(0, -1);
    $('v-vmg2').textContent = s.slice(-1);
  } else {
    $('v-vmg').textContent = kn.toFixed(1);
    $('v-vmg2').textContent = '';
  }
}

function render() {
  const { sog, cog } = currentSogCog();
  const { points, active } = state.route;
  const wp = activePoint(state.route);
  const pos = displayPos();
  const vmgBox = document.querySelector('.vmg');
  vmgBox.classList.remove('good', 'bad');

  $('v-sog').textContent = pos && state.gpsGood ? fmt(ease('sog', msToKnots(sog))) : '–';
  $('v-cog').textContent = fmtDeg(cog);
  $('v-acc').textContent = Number.isFinite(state.acc) ? Math.round(state.acc) : '–';

  // "Targeting point X/Y" below the VMG number
  let info = '';
  let total = '';
  if (wp) {
    info = `Targeting point ${active + 1}/${points.length}`;
    if (pos && active < points.length - 1) total = `${fmtNm(remainingRouteDistance(pos))} nm to finish`;
  } else if (isFinished(state.route)) {
    info = 'Route finished';
  }
  $('v-target').textContent = info;
  const manual = wp && !state.settings.autoAdvance ? 'manual switching' : '';
  $('v-total').textContent = [manual, total].filter(Boolean).join(' · ');

  if (state.pos && !state.gpsGood) {
    // GPS warm-up: rough position only – distance/bearing are still useful, VMG/ETA are not
    state.shown.vmg = null;
    showVmg(null);
    $('v-brg').textContent = wp ? fmtDeg(bearing(pos, wp)) : '–';
    $('v-dtw').textContent = wp ? fmtNm(distance(pos, wp)) : '–';
    $('v-eta').textContent = '–';
    $('v-eta-rest').textContent = '';
    showStatus(`Waiting for accurate GPS … ±${Math.round(state.acc)} m`);
    return;
  }

  if (!pos || !wp) {
    for (const id of ['v-brg', 'v-dtw', 'v-eta']) $(id).textContent = '–';
    $('v-eta-rest').textContent = '';
    state.shown.vmg = null;
    showVmg(null);
    if (pos) {
      showStatus(isFinished(state.route)
        ? '🏁 Route finished – add points to continue'
        : 'Add a point: search, tap 🎯 or long-press the map');
    }
    return;
  }

  const brg = bearing(pos, wp);
  const dist = distance(pos, wp);
  const v = cog == null ? 0 : vmg(sog, cog, brg);
  const eta = etaSeconds(dist, v);
  const vKn = ease('vmg', msToKnots(v));

  showVmg(vKn);
  $('v-brg').textContent = fmtDeg(brg);
  $('v-dtw').textContent = fmtNm(dist);
  if (eta != null) {
    const at = new Date(Date.now() + eta * 1000);
    $('v-eta').textContent = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    $('v-eta-rest').textContent = fmtDuration(eta);
  } else {
    $('v-eta').textContent = '–';
    $('v-eta-rest').textContent = '';
  }

  if (vKn > 0.1) vmgBox.classList.add('good');
  else if (vKn < -0.1) vmgBox.classList.add('bad');

  if (cog == null) showStatus('Boat stopped (below 0.3 kn) – no course');
  else {
    // Angle between course over ground and bearing to the active point
    const off = angleDiff(cog, brg);
    if (Math.abs(off) < ON_COURSE_DEG) showDeviation('0°', 'on course to target');
    else showDeviation(`${Math.round(Math.abs(off))}°`, `${off > 0 ? 'right' : 'left'} of bearing`);
  }
}

// ---------------------------------------------------------------- Buttons
$('btn-pick').addEventListener('click', () => setPicking(!state.picking));
$('btn-center').addEventListener('click', () => {
  setFollow(true);
  if (state.pos) map.setView(ptToLL(state.pos), Math.max(map.getZoom(), 13));
});
$('btn-demo').addEventListener('click', () => setDemo(!state.demo));
$('btn-prev').addEventListener('click', goBack);
$('btn-next').addEventListener('click', () => advance(false));
$('btn-clear').addEventListener('click', () => {
  const n = state.route.points.length;
  if (!n) { toast('No points to delete'); return; }
  // Deleting cannot be undone -> confirm twice
  if (!confirm(`Delete all ${n} route point${n > 1 ? 's' : ''}?`)) return;
  if (!confirm('Really delete the whole route? This cannot be undone.')) return;
  setRoute(emptyRoute());
  toast('Route deleted');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#search')) $('search-results').hidden = true;
});

// ---------------------------------------------------------------- Keep screen on
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* not supported or refused */ }
}
document.addEventListener('visibilitychange', () => { if (!wakeLock || wakeLock.released) keepAwake(); });

// ---------------------------------------------------------------- Offline support (PWA)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker:', e));
}

// ---------------------------------------------------------------- Smooth redraw loop
let lastFrame = 0;
function frame(t) {
  requestAnimationFrame(frame); // pauses automatically while the app is in the background
  if (t - lastFrame < FRAME_MS || !state.pos) return;
  lastFrame = t;
  drawBoat();
  render();
}

// ---------------------------------------------------------------- Safety notice (first start)
function showNoticeIfNeeded() {
  let accepted = null;
  try { accepted = localStorage.getItem(NOTICE_KEY); } catch { /* storage unavailable */ }
  if (accepted === NOTICE_VERSION) return;
  $('notice').hidden = false;
  $('notice-ok').addEventListener('click', () => {
    try { localStorage.setItem(NOTICE_KEY, NOTICE_VERSION); } catch { /* shown again next time */ }
    $('notice').hidden = true;
  }, { once: true });
}

// ---------------------------------------------------------------- Start
showNoticeIfNeeded();
requestAnimationFrame(frame);
setFollow(true);
drawRoute();
startGps();
keepAwake();
render();
