// Pure navigation math (no dependency on browser/map).
// All angles in degrees, distances in metres, speeds in m/s,
// unless stated otherwise.

export const EARTH_RADIUS_M = 6371008.8;
export const METERS_PER_NM = 1852;
export const MS_PER_KNOT = METERS_PER_NM / 3600; // 1 kn = 0.514444 m/s

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Normalise an angle to 0..360. */
export function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Smallest angle difference a-b in the range -180..180. */
export function angleDiff(a, b) {
  const d = normalizeDeg(a - b);
  return d > 180 ? d - 360 : d;
}

/** Great-circle distance between two points {lat, lon} in metres (haversine). */
export function distance(p1, p2) {
  const dLat = toRad(p2.lat - p1.lat);
  const dLon = toRad(p2.lon - p1.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial true bearing (0 = north) from p1 to p2 in degrees. */
export function bearing(p1, p2) {
  const φ1 = toRad(p1.lat);
  const φ2 = toRad(p2.lat);
  const Δλ = toRad(p2.lon - p1.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

/** Point reached when travelling `dist` metres from p on course `brg`. */
export function destinationPoint(p, brg, dist) {
  const δ = dist / EARTH_RADIUS_M;
  const θ = toRad(brg);
  const φ1 = toRad(p.lat);
  const λ1 = toRad(p.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

/**
 * VMG (Velocity Made Good) towards the target.
 * VMG = SOG * cos(COG - bearing to target)
 * Positive = closing in on the target, negative = moving away.
 */
export function vmg(sog, cog, bearingToTarget) {
  return sog * Math.cos(toRad(angleDiff(cog, bearingToTarget)));
}

/** Time to go in seconds at the given VMG, or null if not getting closer. */
export function etaSeconds(distanceM, vmgMs) {
  if (!(vmgMs > 0.05)) return null; // below ~0.1 kn an ETA is meaningless
  return distanceM / vmgMs;
}

export const msToKnots = (ms) => ms / MS_PER_KNOT;
export const knotsToMs = (kn) => kn * MS_PER_KNOT;
export const mToNm = (m) => m / METERS_PER_NM;

/**
 * Course and speed over ground from two GPS fixes {lat, lon, t(ms)}.
 * Fallback when the device does not provide speed/heading itself.
 */
export function motionFromFixes(a, b) {
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return null;
  const d = distance(a, b);
  return { sog: d / dt, cog: bearing(a, b) };
}

/** Flat x/y in metres (east/north) of p relative to origin o. Accurate enough within a few km. */
export function toLocal(o, p) {
  return {
    x: toRad(p.lon - o.lon) * Math.cos(toRad(o.lat)) * EARTH_RADIUS_M,
    y: toRad(p.lat - o.lat) * EARTH_RADIUS_M,
  };
}

// Waypoint passing: see passedWaypoint()
export const PASS_RADIUS_M = 300; // safety radius: crossings farther away than this are ignored
export const CUT_RADIUS_M = 30;   // on sharp turns the inner side of the bisector only counts this close

const unit = (v) => {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : null;
};
const cross = (u, v) => u.x * v.y - u.y * v.x;
const dot = (u, v) => u.x * v.x + u.y * v.y;

/**
 * Has the boat, moving from p0 to p1, passed (rounded) waypoint `wp`?
 *
 * A line through the waypoint is used as the "gate":
 * - normally the bisector of the turn between the incoming leg (from -> wp)
 *   and the outgoing leg (wp -> next),
 * - for the last waypoint (next = null) a finish line perpendicular to the incoming leg.
 * The waypoint counts as passed when the boat crosses that line from the
 * incoming side to the outgoing side, close enough to the waypoint:
 * - on the outer side of the turn (beyond the mark) within passRadius,
 * - on the inner side (between the two legs) within cutRadius only for sharp turns,
 *   so that tacking up a hairpin leg does not switch too early.
 */
export function passedWaypoint(p0, p1, from, wp, next, { passRadius = PASS_RADIUS_M, cutRadius = CUT_RADIUS_M } = {}) {
  const a = unit(toLocal(wp, from)); // direction back along the incoming leg
  if (!a) return distance(p1, wp) < cutRadius;
  const c = (next && unit(toLocal(wp, next))) || { x: -a.x, y: -a.y };

  let u = unit({ x: a.x + c.x, y: a.y + c.y }); // bisector, pointing into the turn
  let innerLimit = cutRadius;
  if (!u) {
    u = { x: -a.y, y: a.x };                   // straight on / finish: perpendicular line
    innerLimit = passRadius;
  } else if (dot(a, c) <= -0.5) {
    innerLimit = passRadius;                   // gentle turn (course change <= 60°)
  }

  const sideA = Math.sign(cross(u, a));
  if (sideA === 0) return distance(p1, wp) < cutRadius; // degenerate: next lies on the incoming leg

  const q0 = toLocal(wp, p0);
  const q1 = toLocal(wp, p1);
  const s0 = cross(u, q0) * sideA;
  const s1 = cross(u, q1) * sideA;
  if (!(s0 >= 0 && s1 < 0)) return false;      // must cross from the incoming to the outgoing side

  const t = s0 / (s0 - s1);
  const k = dot(u, { x: q0.x + t * (q1.x - q0.x), y: q0.y + t * (q1.y - q0.y) });
  return k >= 0 ? k <= innerLimit : -k <= passRadius;
}
