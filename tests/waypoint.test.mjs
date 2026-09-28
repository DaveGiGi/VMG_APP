// Tests for waypoint passing (bisector gate) and route editing. Run with:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { destinationPoint, passedWaypoint, toLocal } from '../js/nav.js';
import {
  addPoint, emptyRoute, insertPoint, isFinished, legStart, movePoint, nearestSegment, removePoint,
  sanitizeRoute, setActive, setStart,
} from '../js/route.js';

const WP = { lat: 47.6, lon: 9.4 };
/** Point at x metres east / y metres north of the waypoint. */
const at = (x, y) => destinationPoint(WP, (Math.atan2(x, y) * 180) / Math.PI, Math.hypot(x, y));

test('toLocal is roughly metres east/north', () => {
  const p = toLocal(WP, at(100, -50));
  assert.ok(Math.abs(p.x - 100) < 0.5 && Math.abs(p.y + 50) < 0.5, JSON.stringify(p));
});

// 90° turn: come from the south, continue east
const FROM = at(0, -1000);
const EAST = at(1000, 0);

test('90° turn: rounding the mark on the outside switches', () => {
  // sailing north 20 m west of the mark, crossing the bisector beyond the mark
  assert.equal(passedWaypoint(at(-20, 10), at(-20, 30), FROM, WP, EAST), true);
});

test('90° turn: still approaching does not switch', () => {
  assert.equal(passedWaypoint(at(-20, -60), at(-20, -40), FROM, WP, EAST), false);
});

test('90° turn: missing the mark on the inside still switches', () => {
  // sailing north 40 m / 100 m east of the mark (inner side of the turn)
  assert.equal(passedWaypoint(at(40, -45), at(40, -35), FROM, WP, EAST), true);
  assert.equal(passedWaypoint(at(100, -105), at(100, -95), FROM, WP, EAST), true);
  // cutting the corner straight towards the next point, starting 100 m before the mark
  assert.equal(passedWaypoint(at(80, -92), at(100, -90), FROM, WP, EAST), true);
});

test('90° turn: cutting the corner very early does not switch', () => {
  assert.equal(passedWaypoint(at(200, -205), at(200, -195), FROM, WP, EAST), false);
});

test('90° turn: crossing far outside the safety radius does not switch', () => {
  assert.equal(passedWaypoint(at(-400, 390), at(-400, 410), FROM, WP, EAST), false);
});

test('crossing in the wrong direction does not switch', () => {
  assert.equal(passedWaypoint(at(-20, 30), at(-20, 10), FROM, WP, EAST), false);
});

// Hairpin: up from the south, back down 40 m further east
const HAIRPIN_NEXT = at(40, -1000);

test('hairpin: tacking between the legs below the mark does not switch', () => {
  assert.equal(passedWaypoint(at(-30, -200), at(30, -200), FROM, WP, HAIRPIN_NEXT), false);
  assert.equal(passedWaypoint(at(-30, -50), at(30, -50), FROM, WP, HAIRPIN_NEXT), false);
});

test('hairpin: going round the top of the mark switches', () => {
  assert.equal(passedWaypoint(at(-10, 10), at(10, 10), FROM, WP, HAIRPIN_NEXT), true);
});

test('last waypoint: finish line perpendicular to the leg', () => {
  assert.equal(passedWaypoint(at(100, -5), at(100, 5), FROM, WP, null), true);
  assert.equal(passedWaypoint(at(500, -5), at(500, 5), FROM, WP, null), false);
});

test('straight-through waypoint uses a perpendicular line', () => {
  const north = at(0, 1000);
  assert.equal(passedWaypoint(at(150, -5), at(150, 5), FROM, WP, north), true);
});

// ------------------------------------------------------------------ route editing
const P = (n) => ({ lat: 47 + n / 100, lon: 9 });

test('route: add / finished / add after finish', () => {
  let r = addPoint(addPoint(emptyRoute(), P(1)), P(2));
  assert.equal(r.active, 0);
  r = setActive(r, 2);
  assert.equal(isFinished(r), true);
  r = addPoint(r, P(3));
  assert.equal(r.active, 2); // the new point is now active
  assert.equal(isFinished(r), false);
});

test('route: insert before active shifts, insert at active becomes active', () => {
  const r = { points: [P(1), P(2), P(3)], active: 1 };
  assert.equal(insertPoint(r, 0, P(9)).active, 2);
  const r2 = insertPoint(r, 1, P(9));
  assert.equal(r2.active, 1);
  assert.deepEqual(r2.points[1], P(9));
  assert.equal(insertPoint(r, 3, P(9)).active, 1);
});

test('route: remove', () => {
  const r = { points: [P(1), P(2), P(3)], active: 1 };
  assert.equal(removePoint(r, 0).active, 0);
  assert.deepEqual(removePoint(r, 1).points, [P(1), P(3)]);
  assert.equal(removePoint(r, 1).active, 1); // next point becomes active
  assert.equal(removePoint({ points: [P(1)], active: 0 }, 0).active, 0);
});

test('nearestSegment', () => {
  const pts = [{ lat: 47, lon: 9 }, { lat: 47.1, lon: 9 }, { lat: 47.1, lon: 9.1 }];
  assert.equal(nearestSegment(pts, { lat: 47.05, lon: 9.001 }), 0);
  assert.equal(nearestSegment(pts, { lat: 47.099, lon: 9.05 }), 1);
  assert.equal(nearestSegment([pts[0]], pts[0]), -1);
});

test('sanitizeRoute', () => {
  assert.deepEqual(sanitizeRoute(null), emptyRoute());
  assert.deepEqual(sanitizeRoute({ points: [P(1), { lat: 'x' }], active: 7 }), { points: [P(1)], active: 1, start: null });
  const start = { lat: 47, lon: 9, t: 123 };
  assert.deepEqual(sanitizeRoute({ points: [P(1)], active: 0, start }).start, start);
  assert.equal(sanitizeRoute({ points: [P(1)], active: 0, start: { lat: null } }).start, null);
});

test('start position survives every route edit and is the first leg start', () => {
  let r = setStart(addPoint(emptyRoute(), P(1)), { lat: 46.9, lon: 9 }, 42);
  assert.deepEqual(r.start, { lat: 46.9, lon: 9, t: 42 });
  assert.deepEqual(legStart(r), r.start);
  r = insertPoint(addPoint(r, P(3)), 1, P(2));
  r = movePoint(removePoint(addPoint(r, P(4)), 3), 0, { lat: 47.02 });
  r = setActive(r, 1);
  assert.deepEqual(r.start, { lat: 46.9, lon: 9, t: 42 });
  assert.deepEqual(legStart(r), r.points[0]); // later legs start at the previous point
});
