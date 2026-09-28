// Route = ordered list of waypoints plus the index of the active one.
// Pure functions: they return a new route and never modify the input.
//   route = { points: [{lat, lon, name?}], active: number }
//   active === points.length means the route is finished.
import { toLocal } from './nav.js';

export const emptyRoute = () => ({ points: [], active: 0 });

export const activePoint = (r) => r.points[r.active] ?? null;
export const isFinished = (r) => r.points.length > 0 && r.active >= r.points.length;

/** Append a point. If the route was finished, the new point becomes active. */
export function addPoint(r, p) {
  return { points: [...r.points, p], active: r.active };
}

/** Insert a point at `index`. Inserting right before the active point makes the new point active. */
export function insertPoint(r, index, p) {
  const points = [...r.points];
  points.splice(index, 0, p);
  return { points, active: index < r.active ? r.active + 1 : r.active };
}

/** Remove the point at `index`; if it was active, the following one becomes active. */
export function removePoint(r, index) {
  const points = r.points.filter((_, i) => i !== index);
  return { points, active: index < r.active ? r.active - 1 : Math.min(r.active, points.length) };
}

export function movePoint(r, index, p) {
  return { points: r.points.map((q, i) => (i === index ? { ...q, ...p } : q)), active: r.active };
}

export function setActive(r, index) {
  return { points: r.points, active: Math.max(0, Math.min(index, r.points.length)) };
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
  const points = r.points.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const active = Number.isInteger(r.active) ? Math.max(0, Math.min(r.active, points.length)) : 0;
  return { points, active };
}
