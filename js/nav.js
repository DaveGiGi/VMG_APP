// Reine Navigations-Berechnungen (keine Abhängigkeit von Browser/Karte).
// Alle Winkel in Grad, Distanzen in Metern, Geschwindigkeiten in m/s,
// sofern nicht anders angegeben.

export const EARTH_RADIUS_M = 6371008.8;
export const METERS_PER_NM = 1852;
export const MS_PER_KNOT = METERS_PER_NM / 3600; // 1 kn = 0.514444 m/s

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Winkel auf 0..360 normalisieren. */
export function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Kleinste Winkeldifferenz a-b im Bereich -180..180. */
export function angleDiff(a, b) {
  const d = normalizeDeg(a - b);
  return d > 180 ? d - 360 : d;
}

/** Großkreis-Distanz zwischen zwei Punkten {lat, lon} in Metern (Haversine). */
export function distance(p1, p2) {
  const dLat = toRad(p2.lat - p1.lat);
  const dLon = toRad(p2.lon - p1.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Anfangs-Peilung (rechtweisend, 0 = Nord) von p1 nach p2 in Grad. */
export function bearing(p1, p2) {
  const φ1 = toRad(p1.lat);
  const φ2 = toRad(p2.lat);
  const Δλ = toRad(p2.lon - p1.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

/** Zielpunkt, wenn man von p aus `dist` Meter auf Kurs `brg` fährt. */
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
 * VMG (Velocity Made Good) Richtung Ziel.
 * VMG = SOG * cos(COG - Peilung zum Ziel)
 * Positiv = man nähert sich dem Ziel, negativ = man entfernt sich.
 */
export function vmg(sog, cog, bearingToTarget) {
  return sog * Math.cos(toRad(angleDiff(cog, bearingToTarget)));
}

/** Restzeit in Sekunden bei gegebener VMG, oder null wenn man nicht näher kommt. */
export function etaSeconds(distanceM, vmgMs) {
  if (!(vmgMs > 0.05)) return null; // unter ~0.1 kn ist eine ETA sinnlos
  return distanceM / vmgMs;
}

export const msToKnots = (ms) => ms / MS_PER_KNOT;
export const knotsToMs = (kn) => kn * MS_PER_KNOT;
export const mToNm = (m) => m / METERS_PER_NM;

/**
 * Kurs und Fahrt über Grund aus zwei GPS-Punkten {lat, lon, t(ms)}.
 * Fallback, falls das Gerät selbst keine speed/heading liefert.
 */
export function motionFromFixes(a, b) {
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return null;
  const d = distance(a, b);
  return { sog: d / dt, cog: bearing(a, b) };
}
