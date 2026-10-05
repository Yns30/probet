import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapWinner, sideAt, analyze, liveRoundProb, mapProbFromD, seriesProb,
  mapProbFromSeries, priorD, markets, recommend, evaluateBet,
} from '../extension/engine.js';

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

test('entre les rounds (achats pas encore connus), la probabilité du round est tempérée', () => {
  const st = { ...base, scoreA: 5, scoreB: 3, buyA: 'full', buyB: 'eco', aliveA: 5, aliveB: 5 };
  const known = analyze({ ...st, phase: 'live', econReady: true }).pRound;
  const before = analyze({ ...st, phase: 'freezetime' }).pRound;
  const waiting = analyze({ ...st, phase: 'live', econReady: false }).pRound;
  assert.ok(known > 0.75, `achats connus ${known}`);
  assert.ok(before > 0.5 && before < known - 0.08, `entre les rounds ${before}`);
  near(waiting, before, 0.02);
});
