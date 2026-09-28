// UI: map, GPS, target selection, display, demo mode.
// The actual math lives in nav.js.
import {
  angleDiff, bearing, destinationPoint, distance, etaSeconds,
  knotsToMs, motionFromFixes, msToKnots, mToNm, vmg,
} from './nav.js';

const L = window.L; // Leaflet is loaded as a classic <script>
const $ = (id) => document.getElementById(id);

const TARGET_KEY = 'vmg.target';
const ARRIVAL_RADIUS_M = 50;
const SMOOTHING = 0.35;        // 0..1, higher = reacts faster but jitters more
const MIN_SOG_FOR_COG_MS = knotsToMs(0.3); // below this, GPS course is just noise
const ON_COURSE_DEG = 3;       // deviation below this counts as "on course"

const state = {
  pos: null,          // {lat, lon}
  acc: null,          // GPS accuracy in m
  vel: null,          // smoothed velocity vector {ve, vn} in m/s (east/north)
  fixes: [],          // recent GPS fixes for the fallback calculation
  target: loadTarget(),
  follow: true,       // map follows the boat
  picking: false,     // "tap map to set target" mode
  demo: false,
  demoTimer: null,
  gpsWatch: null,
};

// ---------------------------------------------------------------- Map
const map = L.map('map', { zoomControl: true, attributionControl: true })
  .setView(state.target ? [state.target.lat, state.target.lon] : [47.6, 9.4], 11);

// The map ends above the display panel (its height changes, e.g. in demo mode)
const panel = document.querySelector('.panel');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--panel-h', `${panel.offsetHeight - 16}px`);
  map.invalidateSize();
}).observe(panel);

const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors',
}).addTo(map);
const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: 'Seamarks © OpenSeaMap',
}).addTo(map);
L.control.layers({ OpenStreetMap: osm }, { 'Seamarks (OpenSeaMap)': seamarks }, { position: 'bottomleft' }).addTo(map);

const boatIcon = L.divIcon({
  className: '',
  iconSize: [36, 36],
  iconAnchor: [18, 18],
  html: `<div class="boat-icon" id="boat-rot"><svg viewBox="0 0 36 36">
    <path d="M18 3 L27 31 L18 25 L9 31 Z" fill="#ffb020" stroke="#0b2239" stroke-width="2"/></svg></div>`,
});
const targetIcon = L.divIcon({
  className: '',
  iconSize: [32, 32],
  iconAnchor: [6, 30],
  html: '<div style="font-size:30px;line-height:1">🏁</div>',
});

let boatMarker = null;
let targetMarker = null;
// Dark, thick lines so they stay visible in sunlight
const targetLine = L.polyline([], { color: '#b91c1c', weight: 4, opacity: 0.9, dashArray: '10 8' }).addTo(map);
const headingLine = L.polyline([], { color: '#166534', weight: 5, opacity: 0.95 }).addTo(map);

map.on('dragstart', () => { state.follow = false; });

map.on('click', (e) => {
  if (!state.picking) return;
  setTarget({ lat: e.latlng.lat, lon: e.latlng.lng, name: 'Marked point' });
  setPicking(false);
});
// Long press (phone) or right click always sets the target
map.on('contextmenu', (e) => {
  setTarget({ lat: e.latlng.lat, lon: e.latlng.lng, name: 'Marked point' });
});

// ---------------------------------------------------------------- Target
function loadTarget() {
  try {
    const t = JSON.parse(localStorage.getItem(TARGET_KEY));
    return t && Number.isFinite(t.lat) && Number.isFinite(t.lon) ? t : null;
  } catch { return null; }
}

function setTarget(t) {
  state.target = t;
  try {
    if (t) localStorage.setItem(TARGET_KEY, JSON.stringify(t));
    else localStorage.removeItem(TARGET_KEY);
  } catch { /* storage unavailable – not critical */ }
  drawTarget();
  if (t && state.pos) {
    map.fitBounds([[state.pos.lat, state.pos.lon], [t.lat, t.lon]], { padding: [60, 60], maxZoom: 15 });
    state.follow = false;
  }
  if (state.pos) drawBoat();
  render();
}

function drawTarget() {
  if (targetMarker) { targetMarker.remove(); targetMarker = null; }
  if (!state.target) return;
  targetMarker = L.marker([state.target.lat, state.target.lon], { icon: targetIcon, draggable: true })
    .bindTooltip(state.target.name || 'Target')
    .addTo(map);
  targetMarker.on('dragend', () => {
    const ll = targetMarker.getLatLng();
    setTarget({ lat: ll.lat, lon: ll.lng, name: 'Marked point' });
  });
}

function setPicking(on) {
  state.picking = on;
  $('btn-pick').classList.toggle('active', on);
  $('hint').hidden = !on;
}

// ---------------------------------------------------------------- Search
$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-input').value.trim();
  const list = $('search-results');
  if (!q) { list.hidden = true; return; }

  // Coordinates typed directly, e.g. "54.32, 10.14"
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    setTarget({ lat: +m[1], lon: +m[2], name: q });
    if (!state.pos) map.setView([+m[1], +m[2]], 13);
    list.hidden = true;
    return;
  }

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
      li.addEventListener('click', () => {
        setTarget({ lat: +h.lat, lon: +h.lon, name: h.display_name.split(',')[0] });
        list.hidden = true;
        $('search-input').blur();
        if (!state.pos) map.setView([+h.lat, +h.lon], 13);
      });
      list.appendChild(li);
    }
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

function drawBoat() {
  const ll = ptToLL(state.pos);
  if (!boatMarker) {
    boatMarker = L.marker(ll, { icon: boatIcon, zIndexOffset: 1000 }).addTo(map);
    if (state.target) {
      map.fitBounds([ll, ptToLL(state.target)], { padding: [60, 60], maxZoom: 15 });
    } else {
      map.setView(ll, 14);
    }
  } else {
    boatMarker.setLatLng(ll);
  }
  const { sog, cog } = currentSogCog();
  const rot = document.getElementById('boat-rot');
  if (rot) rot.style.transform = `rotate(${cog ?? 0}deg)`;

  // Green line: where the boat will be in 5 minutes
  headingLine.setLatLngs(cog == null ? [] : [ll, ptToLL(destinationPoint(state.pos, cog, sog * 300))]);
  targetLine.setLatLngs(state.target ? [ll, ptToLL(state.target)] : []);

  if (state.follow) map.panTo(ll, { animate: false });
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
  state.vel = null;
  state.fixes = [];
  if (!on) { showStatus('Demo stopped – waiting for GPS …'); return; }

  let pos = state.pos ?? { lat: map.getCenter().lat, lon: map.getCenter().lng };
  if (!state.target) {
    // Put a target 3 nm north so there is something to see right away
    const t = destinationPoint(pos, 0, 3 * 1852);
    setTarget({ ...t, name: 'Demo target' });
  } else if (distance(pos, state.target) < 0.5 * 1852) {
    // Boat would start (almost) on the target -> start 3 nm south-west of it
    pos = destinationPoint(state.target, 225, 3 * 1852);
  }
  state.follow = true;
  let last = Date.now();
  const tick = () => {
    const now = Date.now();
    const course = +$('i-course').value;
    const speed = knotsToMs(+$('i-speed').value);
    pos = destinationPoint(pos, course, speed * ((now - last) / 1000));
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

function render() {
  const { sog, cog } = currentSogCog();
  const vmgBox = document.querySelector('.vmg');
  vmgBox.classList.remove('good', 'bad');

  $('v-sog').textContent = state.pos ? fmt(msToKnots(sog)) : '–';
  $('v-cog').textContent = fmtDeg(cog);
  $('v-acc').textContent = Number.isFinite(state.acc) ? Math.round(state.acc) : '–';

  if (!state.pos || !state.target) {
    for (const id of ['v-vmg', 'v-brg', 'v-dtw', 'v-eta']) $(id).textContent = '–';
    $('v-eta-rest').textContent = '';
    if (state.pos) showStatus('Set a target: search, tap 🎯 or long-press the map');
    return;
  }

  const brg = bearing(state.pos, state.target);
  const dist = distance(state.pos, state.target);
  const v = cog == null ? 0 : vmg(sog, cog, brg);
  const eta = etaSeconds(dist, v);

  $('v-vmg').textContent = fmt(msToKnots(v));
  $('v-brg').textContent = fmtDeg(brg);
  $('v-dtw').textContent = fmt(mToNm(dist), mToNm(dist) < 10 ? 2 : 1);
  if (eta != null) {
    const at = new Date(Date.now() + eta * 1000);
    $('v-eta').textContent = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    $('v-eta-rest').textContent = fmtDuration(eta);
  } else {
    $('v-eta').textContent = '–';
    $('v-eta-rest').textContent = '';
  }

  if (msToKnots(v) > 0.1) vmgBox.classList.add('good');
  else if (msToKnots(v) < -0.1) vmgBox.classList.add('bad');

  if (dist < ARRIVAL_RADIUS_M) showStatus('🏁 Target reached!');
  else if (cog == null) showStatus('Boat stopped (below 0.3 kn) – no course');
  else {
    // Angle between course over ground and bearing to target
    const off = angleDiff(cog, brg);
    if (Math.abs(off) < ON_COURSE_DEG) showDeviation('0°', 'on course to target');
    else showDeviation(`${Math.round(Math.abs(off))}°`, `${off > 0 ? 'right' : 'left'} of bearing`);
  }
}

// ---------------------------------------------------------------- Buttons
$('btn-pick').addEventListener('click', () => setPicking(!state.picking));
$('btn-center').addEventListener('click', () => {
  state.follow = true;
  if (state.pos) map.setView(ptToLL(state.pos), Math.max(map.getZoom(), 13));
});
$('btn-demo').addEventListener('click', () => setDemo(!state.demo));
$('btn-clear').addEventListener('click', () => {
  if (state.target && confirm('Clear target?')) setTarget(null);
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

// ---------------------------------------------------------------- Start
drawTarget();
startGps();
keepAwake();
render();
