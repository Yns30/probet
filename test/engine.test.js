import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapWinner, sideAt, analyze, liveRoundProb, mapProbFromD, seriesProb,
  mapProbFromSeries, priorD, markets, recommend, evaluateBet,
} from '../public/engine.js';
import { createMatch, ingest } from '../public/tracker.js';
import { createDemo } from '../public/demo.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const base = { map: 'mirage', scoreA: 0, scoreB: 0, aSide: 'CT', phase: 'freezetime', rounds: [], bestOf: 1 };

test('fin de map : MR12 et prolongations MR3', () => {
  assert.equal(mapWinner(13, 11), 'A');
  assert.equal(mapWinner(5, 13), 'B');
  assert.equal(mapWinner(13, 12), null);
  assert.equal(mapWinner(16, 14), 'A');
  assert.equal(mapWinner(15, 15), null);
  assert.equal(mapWinner(16, 15), null);
  assert.equal(mapWinner(17, 19), 'B');
});

test('changements de côté', () => {
  assert.equal(sideAt(12, 1, 'CT'), 'CT');
  assert.equal(sideAt(13, 1, 'CT'), 'T');
  assert.equal(sideAt(25, 1, 'CT'), 'T'); // pas de changement au début des prolongations
  assert.equal(sideAt(28, 1, 'CT'), 'CT');
  assert.equal(sideAt(1, 13, 'T'), 'CT');
});

test('équipes égales : 50 % et ~10 % de prolongation', () => {
  near(mapProbFromD(0, 'mirage'), 0.5, 1e-9);
  const r = analyze(base);
  near(r.pMap, 0.5, 0.02);
  assert.ok(r.pOT > 0.06 && r.pOT < 0.15, `pOT=${r.pOT}`);
  assert.ok(r.expTotal > 20 && r.expTotal < 23, `total=${r.expTotal}`);
  const tot = Object.values(r.totals).reduce((s, x) => s + x, 0);
  near(tot, 1, 1e-6);
});

test('la probabilité de map suit le score', () => {
  const a = analyze({ ...base, scoreA: 9, scoreB: 3, aSide: 'T', phase: 'round_over' }).pMap;
  const b = analyze({ ...base, scoreA: 3, scoreB: 9, aSide: 'T', phase: 'round_over' }).pMap;
  assert.ok(a > 0.85 && b < 0.15, `${a} ${b}`);
  assert.equal(analyze({ ...base, scoreA: 13, scoreB: 7 }).over, 'A');
});

test('round live : joueurs en vie et bombe', () => {
  const b0 = { map: 'mirage', d: 0, x: 0 };
  const even = liveRoundProb({ aSide: 'CT', aliveA: 5, aliveB: 5 }, b0);
  const up = liveRoundProb({ aSide: 'CT', aliveA: 5, aliveB: 3 }, b0);
  const planted = liveRoundProb({ aSide: 'CT', aliveA: 2, aliveB: 2, bombPlanted: true }, b0);
  assert.ok(up > even + 0.2);
  assert.ok(planted < 0.4);
  assert.ok(liveRoundProb({ aSide: 'T', aliveA: 0, aliveB: 2 }, b0) < 0.01);
  assert.ok(liveRoundProb({ aSide: 'T', aliveA: 2, aliveB: 0 }, b0) > 0.99);
});

test('série : formules BO3 et inversion', () => {
  near(seriesProb(0.6, 0, 0, 3), 0.6 * 0.6 * (3 - 2 * 0.6));
  near(seriesProb(0.5, 1, 0, 3), 0.75);
  near(seriesProb(0.6, 0, 0, 3, 0.6), seriesProb(0.6, 0, 0, 3));
  near(mapProbFromSeries(seriesProb(0.62, 0, 0, 3), 3), 0.62, 1e-4);
});

test('a priori : la cote pré-match est respectée', () => {
  const pr = priorD(0.7, 'mirage');
  near(mapProbFromD(pr.mean, 'mirage'), 0.7, 1e-3);
  const r = analyze({ ...base, prematchMapProb: 0.7 });
  near(r.pMap, 0.7, 0.04);
});

test('marchés cohérents et détection de value', () => {
  const r = analyze({ ...base, scoreA: 6, scoreB: 4, phase: 'live', aliveA: 4, aliveB: 2 });
  const list = markets(r, ['A', 'B'], { scoreA: 6, scoreB: 4 });
  const mapA = list.find((m) => m.id === 'map:A'), mapB = list.find((m) => m.id === 'map:B');
  near(mapA.p + mapB.p, 1);
  for (const m of list) assert.ok(m.p >= 0 && m.p <= 1);
  const fair = 1 / mapA.p;
  const picks = recommend(list, { 'map:A': fair * 1.2 }, 1);
  assert.equal(picks[0].id, 'map:A');
  assert.equal(picks[0].kind, 'value');
  assert.equal(evaluateBet(0.5, 1.9).stake, 0);
  assert.ok(evaluateBet(0.6, 2.0).stake > 0);
});

const read = (l, r, extra = {}) => ({
  hud_visible: true, map: 'de_nuke', phase: 'live', round_timer: 80, bomb_planted: false, bomb_site: null,
  maps_left: 0, maps_right: 0, best_of: 3, key_facts: [], confidence: 0.9,
  left: { name: 'NAVI', score: l, side: 'CT', alive: 5, money: null, buy: 'full' },
  right: { name: 'FaZe', score: r, side: 'T', alive: 5, money: null, buy: 'full' },
  ...extra,
});

test('tracker : rounds +1 acceptés, sauts confirmés deux fois', () => {
  const m = createMatch();
  ingest(m, read(0, 0));
  ingest(m, read(1, 0));
  assert.equal(m.scoreA, 1);
  assert.equal(m.rounds[0].aSide, 'CT');
  ingest(m, read(7, 0)); // lecture aberrante isolée
  assert.equal(m.scoreA, 1);
  ingest(m, read(1, 1));
  assert.equal(m.scoreB, 1);
  ingest(m, read(5, 3));
  ingest(m, read(5, 3)); // confirmé
  assert.deepEqual([m.scoreA, m.scoreB, m.rounds.length], [5, 3, 8]);
  assert.equal(m.map, 'nuke');
});

test('tracker : équipes inversées sur le HUD', () => {
  const m = createMatch();
  ingest(m, read(0, 0));
  const swapped = read(0, 1);
  [swapped.left, swapped.right] = [{ ...swapped.right, score: 1 }, { ...swapped.left, score: 0 }];
  ingest(m, swapped);
  assert.equal(m.names.A, 'NAVI');
  assert.equal(m.aIsLeft, false);
  assert.equal(m.scoreB, 1);
});

test('démo : une série complète se déroule sans incohérence', () => {
  const m = createMatch();
  const sim = createDemo(42);
  let maxMap = 1;
  for (let i = 0; i < 2500 && m.mapsA < 2 && m.mapsB < 2; i++) {
    ingest(m, sim.next());
    maxMap = Math.max(maxMap, m.mapNumber);
    const r = analyze({ ...m, rounds: m.rounds });
    assert.ok(r.pMap >= 0 && r.pMap <= 1);
  }
  assert.ok(m.mapsA === 2 || m.mapsB === 2, `maps ${m.mapsA}-${m.mapsB}`);
  assert.ok(maxMap >= 2);
});

// ---------- Lecture locale (pixels / OCR) ----------
import { sideFromColor, countAlive, baselineOf, binarize, parseScore, parseTimer, isRed } from '../public/pixels.js';

function solid(w, h, rgb) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { data, width: w, height: h };
}
function cards(alive, rgb, n = 5) {
  const img = solid(100, 50 * n, [40, 40, 40]);
  for (let k = 0; k < alive; k++) {
    for (let y = k * 50 + 2; y < k * 50 + 48; y++) {
      for (let x = 0; x < 100; x++) img.data.set([...rgb, 255], (y * 100 + x) * 4);
    }
  }
  return img;
}

test('pixels : côté par la couleur, bombe, joueurs en vie', () => {
  assert.equal(sideFromColor(solid(20, 10, [42, 111, 214])), 'CT');
  assert.equal(sideFromColor(solid(20, 10, [224, 138, 26])), 'T');
  assert.equal(sideFromColor(solid(20, 10, [30, 30, 30])), null);
  assert.equal(isRed(solid(20, 10, [208, 32, 32])), true);
  const base = baselineOf(cards(5, [42, 111, 214]));
  assert.equal(countAlive(cards(5, [42, 111, 214]), base), 5);
  assert.equal(countAlive(cards(3, [42, 111, 214]), base), 3);
  assert.equal(countAlive(cards(0, [42, 111, 214]), base), 0);
  assert.equal(countAlive(cards(2, [224, 138, 26])), 2); // sans référence
});

test('pixels : binarisation texte noir sur fond blanc', () => {
  const img = solid(10, 10, [20, 20, 200]);
  img.data.set([255, 255, 255, 255], 0); // un pixel de "texte" clair
  binarize(img);
  assert.equal(img.data[0], 0);
  assert.equal(img.data[4 * 50], 255);
});

test('OCR : interprétation des scores et du chrono', () => {
  assert.equal(parseScore('12\n'), 12);
  assert.equal(parseScore('O'), 0);
  assert.equal(parseScore(''), null);
  assert.equal(parseScore('99'), null);
  assert.equal(parseTimer('1:45'), 105);
  assert.equal(parseTimer('145'), 105);
  assert.equal(parseTimer('0:09'), 9);
  assert.equal(parseTimer('9.8'), 9);
  assert.equal(parseTimer('3:99'), null);
});

test('tracker : lecture bruitée lissée et attente du round suivant', () => {
  const m = createMatch();
  const r = (l, rr, al, ar, timer = 80) => ({ ...read(l, rr), noisy: true, round_timer: timer,
    left: { ...read(l, rr).left, alive: al }, right: { ...read(l, rr).right, alive: ar } });
  ingest(m, r(0, 0, 5, 5)); ingest(m, r(0, 0, 5, 5));
  ingest(m, r(0, 0, 3, 5)); // une seule lecture : ignorée
  assert.equal(m.aliveA, 5);
  ingest(m, r(0, 0, 3, 5));
  assert.equal(m.aliveA, 3);
  ingest(m, r(1, 0, 3, 0));
  assert.equal(m.scoreA, 1);
  assert.equal(m.phase, 'round_over');
  ingest(m, r(1, 0, 3, 0)); ingest(m, r(1, 0, 3, 0));
  assert.equal(m.phase, 'round_over'); // cartes du round précédent encore affichées
  ingest(m, r(1, 0, 5, 5, 115)); ingest(m, r(1, 0, 5, 5, 115));
  assert.equal(m.phase, 'live');
  assert.equal(m.aliveB, 5);
});
