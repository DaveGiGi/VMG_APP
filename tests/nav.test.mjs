// Tests für die Navigations-Berechnungen. Ausführen mit:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  angleDiff, bearing, destinationPoint, distance, etaSeconds,
  knotsToMs, motionFromFixes, msToKnots, mToNm, normalizeDeg, vmg,
} from '../js/nav.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≉ ${b}`);

test('normalizeDeg / angleDiff', () => {
  assert.equal(normalizeDeg(-10), 350);
  assert.equal(normalizeDeg(370), 10);
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(350, 10), -20);
  assert.equal(angleDiff(180, 0), 180);
});

test('1 Bogenminute Breite ≈ 1 Seemeile', () => {
  const d = distance({ lat: 47, lon: 9 }, { lat: 47 + 1 / 60, lon: 9 });
  close(mToNm(d), 1, 0.01);
});

test('Peilung in die vier Himmelsrichtungen', () => {
  const p = { lat: 47.5, lon: 9.5 };
  close(bearing(p, { lat: 47.6, lon: 9.5 }), 0, 0.01, 'Nord');
  close(bearing(p, { lat: 47.4, lon: 9.5 }), 180, 0.01, 'Süd');
  close(bearing(p, { lat: 47.5, lon: 9.6 }), 90, 0.1, 'Ost');
  close(bearing(p, { lat: 47.5, lon: 9.4 }), 270, 0.1, 'West');
});

test('destinationPoint ist Umkehrung von distance/bearing', () => {
  const p = { lat: 54.3, lon: 10.15 };
  const q = destinationPoint(p, 63, 5000);
  close(distance(p, q), 5000, 0.5);
  close(bearing(p, q), 63, 0.01);
});

test('VMG', () => {
  close(vmg(5, 0, 0), 5, 1e-9, 'direkt aufs Ziel');
  close(vmg(5, 90, 0), 0, 1e-9, 'quer zum Ziel');
  close(vmg(5, 180, 0), -5, 1e-9, 'weg vom Ziel');
  close(vmg(6, 45, 0), 6 * Math.SQRT1_2, 1e-9, '45° Kreuzkurs');
  close(vmg(6, 350, 10), 6 * Math.cos(Math.PI / 9), 1e-9, 'über 0° hinweg');
});

test('ETA', () => {
  close(etaSeconds(1852, knotsToMs(1)), 3600, 1e-6);
  assert.equal(etaSeconds(1000, 0), null);
  assert.equal(etaSeconds(1000, -2), null);
});

test('Einheiten', () => {
  close(msToKnots(knotsToMs(7.3)), 7.3, 1e-12);
});

test('motionFromFixes', () => {
  const a = { lat: 47, lon: 9, t: 0 };
  const b = { ...destinationPoint(a, 120, 100), t: 20000 };
  const m = motionFromFixes(a, b);
  close(m.sog, 5, 0.01);
  close(m.cog, 120, 0.01);
  assert.equal(motionFromFixes(a, { ...a }), null);
});
