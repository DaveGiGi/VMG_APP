// Oberfläche: Karte, GPS, Zielwahl, Anzeige, Demo-Modus.
// Die eigentliche Mathematik steckt in nav.js.
import {
  angleDiff, bearing, destinationPoint, distance, etaSeconds,
  knotsToMs, motionFromFixes, msToKnots, mToNm, vmg,
} from './nav.js';

const L = window.L; // Leaflet wird als normales <script> geladen
const $ = (id) => document.getElementById(id);

const TARGET_KEY = 'vmg.target';
const ARRIVAL_RADIUS_M = 50;
const SMOOTHING = 0.35;        // 0..1, höher = reagiert schneller, zappelt mehr
const MIN_SOG_FOR_COG_MS = knotsToMs(0.3); // darunter ist der GPS-Kurs Rauschen

const state = {
  pos: null,          // {lat, lon}
  acc: null,          // GPS-Genauigkeit in m
  vel: null,          // geglätteter Geschwindigkeitsvektor {ve, vn} in m/s (Ost/Nord)
  fixes: [],          // letzte GPS-Punkte für die Fallback-Berechnung
  target: loadTarget(),
  follow: true,       // Karte folgt dem Boot
  picking: false,     // "Ziel antippen"-Modus
  demo: false,
  demoTimer: null,
  gpsWatch: null,
};

// ---------------------------------------------------------------- Karte
const map = L.map('map', { zoomControl: true, attributionControl: true })
  .setView(state.target ? [state.target.lat, state.target.lon] : [47.6, 9.4], 11);

// Karte endet oberhalb des Anzeige-Panels (dessen Höhe ändert sich z.B. im Demo-Modus)
const panel = document.querySelector('.panel');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--panel-h', `${panel.offsetHeight - 16}px`);
  map.invalidateSize();
}).observe(panel);

const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap-Mitwirkende',
}).addTo(map);
const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: 'Seezeichen © OpenSeaMap',
}).addTo(map);
L.control.layers({ OpenStreetMap: osm }, { 'Seezeichen (OpenSeaMap)': seamarks }, { position: 'bottomleft' }).addTo(map);

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
const courseLine = L.polyline([], { color: '#ffb020', weight: 3, dashArray: '8 8' }).addTo(map);
const headingLine = L.polyline([], { color: '#3ddc84', weight: 2 }).addTo(map);

map.on('dragstart', () => { state.follow = false; });

map.on('click', (e) => {
  if (!state.picking) return;
  setTarget({ lat: e.latlng.lat, lon: e.latlng.lng, name: 'Markierter Punkt' });
  setPicking(false);
});
// Langes Drücken (Handy) bzw. Rechtsklick setzt immer das Ziel
map.on('contextmenu', (e) => {
  setTarget({ lat: e.latlng.lat, lon: e.latlng.lng, name: 'Markierter Punkt' });
});

// ---------------------------------------------------------------- Ziel
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
  } catch { /* Speicher nicht verfügbar – egal */ }
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
    .bindTooltip(state.target.name || 'Ziel')
    .addTo(map);
  targetMarker.on('dragend', () => {
    const ll = targetMarker.getLatLng();
    setTarget({ lat: ll.lat, lon: ll.lng, name: 'Markierter Punkt' });
  });
}

function setPicking(on) {
  state.picking = on;
  $('btn-pick').classList.toggle('active', on);
  $('hint').hidden = !on;
}

// ---------------------------------------------------------------- Suche
$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-input').value.trim();
  const list = $('search-results');
  if (!q) { list.hidden = true; return; }

  // Direkt eingegebene Koordinaten, z.B. "54.32, 10.14"
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    setTarget({ lat: +m[1], lon: +m[2], name: q });
    if (!state.pos) map.setView([+m[1], +m[2]], 13);
    list.hidden = true;
    return;
  }

  list.innerHTML = '<li>Suche …</li>';
  list.hidden = false;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=de&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const hits = await res.json();
    list.innerHTML = '';
    if (!hits.length) { list.innerHTML = '<li>Nichts gefunden</li>'; return; }
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
    li.textContent = `Suche fehlgeschlagen (${err.message}). Offline?`;
    list.appendChild(li);
  }
});

// ---------------------------------------------------------------- Position & Bewegung
/** Neue Position + optional vom Gerät gelieferte Fahrt/Kurs verarbeiten. */
function updateMotion(pos, sogMs, cogDeg, acc, t) {
  state.pos = pos;
  state.acc = acc;

  // Fallback: Fahrt/Kurs aus den letzten Punkten (>= 3 s zurück) berechnen
  state.fixes.push({ ...pos, t });
  while (state.fixes.length > 2 && t - state.fixes[1].t >= 3000) state.fixes.shift();
  const deviceHasMotion = Number.isFinite(sogMs) && (sogMs < MIN_SOG_FOR_COG_MS || Number.isFinite(cogDeg));
  if (!deviceHasMotion) {
    const m = state.fixes.length > 1 ? motionFromFixes(state.fixes[0], state.fixes.at(-1)) : null;
    if (m) { sogMs = m.sog; cogDeg = m.cog; }
  }
  if (!Number.isFinite(sogMs)) sogMs = 0;
  if (!Number.isFinite(cogDeg)) cogDeg = 0;

  // Glätten als Vektor (sonst gäbe es Probleme beim Sprung 359° -> 0°)
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

  // Grüne Linie: wo das Boot in 5 Minuten wäre
  headingLine.setLatLngs(cog == null ? [] : [ll, ptToLL(destinationPoint(state.pos, cog, sog * 300))]);
  courseLine.setLatLngs(state.target ? [ll, ptToLL(state.target)] : []);

  if (state.follow) map.panTo(ll, { animate: false });
}

// ---------------------------------------------------------------- GPS
function startGps() {
  if (!('geolocation' in navigator)) {
    $('v-status').textContent = 'Dieses Gerät/Browser kann kein GPS.';
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
        1: 'GPS-Zugriff verweigert. Bitte in den Browser-Einstellungen erlauben (oder ▶︎ Demo testen).',
        2: 'Position nicht verfügbar.',
        3: 'GPS-Zeitüberschreitung – suche weiter …',
      }[err.code] || err.message;
      $('v-status').textContent = msg;
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
  if (!on) { $('v-status').textContent = 'Demo beendet – warte auf GPS …'; return; }

  let pos = state.pos ?? { lat: map.getCenter().lat, lon: map.getCenter().lng };
  if (!state.target) {
    // Ziel 3 sm nördlich setzen, damit man sofort etwas sieht
    const t = destinationPoint(pos, 0, 3 * 1852);
    setTarget({ ...t, name: 'Demo-Ziel' });
  } else if (distance(pos, state.target) < 0.5 * 1852) {
    // Boot stünde (fast) auf dem Ziel -> 3 sm südwestlich davon starten
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

// ---------------------------------------------------------------- Anzeige
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
  if (h >= 48) return `${Math.round(h / 24)} Tage`;
  return `${h} h ${String(min % 60).padStart(2, '0')}`;
}

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
    if (state.pos) $('v-status').textContent = 'Ziel wählen: suchen, 🎯 antippen oder lange auf die Karte drücken';
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
    $('v-eta').textContent = at.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    $('v-eta-rest').textContent = fmtDuration(eta);
  } else {
    $('v-eta').textContent = '–';
    $('v-eta-rest').textContent = '';
  }

  if (msToKnots(v) > 0.1) vmgBox.classList.add('good');
  else if (msToKnots(v) < -0.1) vmgBox.classList.add('bad');

  let status;
  if (dist < ARRIVAL_RADIUS_M) status = '🏁 Ziel erreicht!';
  else if (cog == null) status = 'Boot steht (unter 0,3 kn) – kein Kurs';
  else {
    const off = angleDiff(cog, brg);
    const side = off > 0 ? 'rechts (Stb)' : 'links (Bb)';
    status = Math.abs(off) < 3
      ? 'Kurs direkt aufs Ziel'
      : `${Math.round(Math.abs(off))}° ${side} vom direkten Kurs · ${Math.round(Math.cos(off * Math.PI / 180) * 100)} % Effizienz`;
  }
  $('v-status').textContent = status;
}

// ---------------------------------------------------------------- Buttons
$('btn-pick').addEventListener('click', () => setPicking(!state.picking));
$('btn-center').addEventListener('click', () => {
  state.follow = true;
  if (state.pos) map.setView(ptToLL(state.pos), Math.max(map.getZoom(), 13));
});
$('btn-demo').addEventListener('click', () => setDemo(!state.demo));
$('btn-clear').addEventListener('click', () => {
  if (state.target && confirm('Ziel löschen?')) setTarget(null);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#search')) $('search-results').hidden = true;
});

// ---------------------------------------------------------------- Bildschirm anlassen
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* nicht unterstützt oder abgelehnt */ }
}
document.addEventListener('visibilitychange', () => { if (!wakeLock || wakeLock.released) keepAwake(); });

// ---------------------------------------------------------------- Offline-Fähigkeit (PWA)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker:', e));
}

// ---------------------------------------------------------------- Start
drawTarget();
startGps();
keepAwake();
render();
