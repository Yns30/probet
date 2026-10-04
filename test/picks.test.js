import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, markets, recommend, TOTAL_LINES } from '../extension/engine.js';
import { stablePicks } from '../extension/picks.js';

const base = { map: 'mirage', scoreA: 0, scoreB: 0, aSide: 'CT', phase: 'freezetime', prematchMapProb: 0.5 };
const mk = (id, p, sd = 0, group = id.split(':')[0]) => ({ id, group, label: id, p, sd });

test('chaque marché porte un écart-type d’incertitude, plus faible avec plus de rounds', () => {
  const early = analyze({ ...base, scoreA: 2, scoreB: 0, rounds: [] });
  const list = markets(early, ['A', 'B'], { scoreA: 2, scoreB: 0 });
  const map = list.find((m) => m.id === 'map:A');
  assert.ok(map.sd > 0.01 && map.sd < 0.3, `sd=${map.sd}`);
  for (const m of list) assert.ok(m.sd >= 0 && Number.isFinite(m.sd));
});

test('lignes de total fixes, indépendantes du score', () => {
  const r1 = analyze({ ...base, scoreA: 3, scoreB: 1 });
  const r2 = analyze({ ...base, scoreA: 4, scoreB: 1 });
  const ids = (r, a, b) => markets(r, ['A', 'B'], { scoreA: a, scoreB: b }).filter((m) => m.id.startsWith('tot')).map((m) => Number(m.id.slice(3).split(':')[0]));
  for (const l of [...ids(r1, 3, 1), ...ids(r2, 4, 1)]) assert.ok(TOTAL_LINES.includes(l));
});

test('probabilité prudente : une incertitude forte empêche la tendance', () => {
  assert.equal(recommend([mk('map:A', 0.64, 0)], {}, 1).length, 1);
  assert.equal(recommend([mk('map:A', 0.64, 0.08)], {}, 1).length, 0);
});

test('hystérésis : un pari affiché ne disparaît pas pour un point de proba', () => {
  assert.equal(recommend([mk('map:A', 0.58)], {}, 1).length, 0); // n'entre pas
  assert.equal(recommend([mk('map:A', 0.58)], {}, 1, { prev: new Set(['map:A']) }).length, 1); // reste
  assert.equal(recommend([mk('map:A', 0.53)], {}, 1, { prev: new Set(['map:A']) }).length, 0); // sort
  // Dans un même marché, la sélection affichée garde sa place face à une voisine à peine meilleure.
  const list = [mk('hcp-2.5:A', 0.7, 0, 'hcp'), mk('hcp-3.5:A', 0.72, 0, 'hcp')];
  assert.equal(recommend(list, {}, 1)[0].id, 'hcp-3.5:A');
  assert.equal(recommend(list, {}, 1, { prev: new Set(['hcp-2.5:A']) })[0].id, 'hcp-2.5:A');
  // Value : sortie à la moitié de l'avantage minimum.
  const odds = { 'map:A': 1.6 }; // p 0,65 → +4 %
  assert.equal(recommend([mk('map:A', 0.65)], odds, 1, { minEdge: 0.05 }).length, 0);
  assert.equal(recommend([mk('map:A', 0.65)], odds, 1, { minEdge: 0.05, prev: new Set(['map:A']) })[0].kind, 'value');
});

test('tendances figées pendant le round, mises à jour entre les rounds', () => {
  const st = {};
  const ctx = { mapKey: 'mirage|1', round: 5 };
  let out = stablePicks(st, { ...ctx, phase: 'freezetime', list: [mk('map:A', 0.7)] });
  assert.equal(out[0].id, 'map:A');
  // Pendant le round : la proba bouge à chaque kill, la tendance reste celle du début du round.
  out = stablePicks(st, { ...ctx, phase: 'live', list: [mk('map:A', 0.9), mk('ot:Y', 0.7)] });
  assert.deepEqual(out.map((p) => p.id), ['map:A']);
  assert.ok(out[0].frozen && out[0].p === 0.7 && out[0].now === 0.9);
  // Retournement net (plus favori) : la tendance figée est retirée.
  out = stablePicks(st, { ...ctx, phase: 'live', list: [mk('map:A', 0.45)] });
  assert.equal(out.length, 0);
  // Fin du round : nouvelle sélection.
  out = stablePicks(st, { ...ctx, round: 6, phase: 'round_over', list: [mk('map:A', 0.5), mk('ot:Y', 0.7)] });
  assert.deepEqual(out.map((p) => p.id), ['ot:Y']);
});

test('les paris VALUE restent en direct pendant le round', () => {
  const st = {};
  const ctx = { mapKey: 'm', round: 3 };
  stablePicks(st, { ...ctx, phase: 'freezetime', list: [mk('map:A', 0.5)] });
  const out = stablePicks(st, { ...ctx, phase: 'live', odds: { 'map:A': 2.2 }, list: [mk('map:A', 0.55)] });
  assert.equal(out[0].kind, 'value');
});
