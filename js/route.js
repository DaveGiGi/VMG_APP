// Route = ordered list of waypoints, the index of the active one and the start position.
// Pure functions: they return a new route and never modify the input.
//   route = { points: [{lat, lon, name?}], active: number, start: {lat, lon, t} | null }
//   active === points.length means the route is finished.
//   start = where the boat was when the route began; it is the reference for the
//   first leg (e.g. the bisector at point 1), later legs start at the previous point.
import { toLocal } from './nav.js';

export const emptyRoute = () => ({ points: [], active: 0, start: null });

export const activePoint = (r) => r.points[r.active] ?? null;
export const isFinished = (r) => r.points.length > 0 && r.active >= r.points.length;

/** Where the leg to the active point begins: the previous point, or the start for point 1. */
export const legStart = (r) => (r.active > 0 ? r.points[r.active - 1] : r.start);

/** Append a point. If the route was finished, the new point becomes active. */
export function addPoint(r, p) {
  return { ...r, points: [...r.points, p] };
}

/** Insert a point at `index`. Inserting right before the active point makes the new point active. */
export function insertPoint(r, index, p) {
  const points = [...r.points];
  points.splice(index, 0, p);
  return { ...r, points, active: index < r.active ? r.active + 1 : r.active };
}

/** Remove the point at `index`; if it was active, the following one becomes active. */
export function removePoint(r, index) {
  const points = r.points.filter((_, i) => i !== index);
  return { ...r, points, active: index < r.active ? r.active - 1 : Math.min(r.active, points.length) };
}

export function movePoint(r, index, p) {
  return { ...r, points: r.points.map((q, i) => (i === index ? { ...q, ...p } : q)) };
}

export function setActive(r, index) {
  return { ...r, active: Math.max(0, Math.min(index, r.points.length)) };
}

/** Set the start position (with a timestamp, so you know when the route began). */
export function setStart(r, p, t = Date.now()) {
  return { ...r, start: p ? { lat: p.lat, lon: p.lon, t } : null };
}

/** Index of the route segment (points[i] -> points[i+1]) closest to p, or -1 if there is none. */
export function nearestSegment(points, p) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = toLocal(p, points[i]);
    const b = toLocal(p, points[i + 1]);
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 ? Math.max(0, Math.min(1, -(a.x * abx + a.y * aby) / len2)) : 0;
    const d = Math.hypot(a.x + t * abx, a.y + t * aby); // p is the origin
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Validate a route loaded from storage; returns an empty route if it is broken. */
export function sanitizeRoute(r) {
  if (!r || !Array.isArray(r.points)) return emptyRoute();
  const valid = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
  const points = r.points.filter(valid);
  const active = Number.isInteger(r.active) ? Math.max(0, Math.min(r.active, points.length)) : 0;
  return { points, active, start: valid(r.start) ? r.start : null };
}
