import test from 'node:test';
import assert from 'node:assert/strict';
import { blendMarket, marketProb, recommend } from '../extension/engine.js';
import { buildAdvice } from '../extension/advice.js';
import { summarize } from '../extension/journal.js';

const mk = (id, p, sd = 0) => ({ id, group: 'Map 1 — vainqueur', label: id, p, sd });

test('cotes Stake sans marge : probabilité du marché', () => {
  assert.ok(Math.abs(marketProb('map:A', { 'map:A': 1.8, 'map:B': 2.0 }) - 0.5263) < 1e-3);
  assert.equal(marketProb('map:A', { 'map:A': 1.8 }), null);
  assert.ok(Math.abs(marketProb('tot21.5:O', { 'tot21.5:O': 1.9, 'tot21.5:U': 1.9 }) - 0.5) < 1e-9);
});

test('modèle trop optimiste face à Stake : plus de faux pari VALUE', () => {
  const odds = { 'map:A': 2.6, 'map:B': 1.5 }; // Stake : A ≈ 37 %
  const raw = [mk('map:A', 0.5), mk('map:B', 0.5)];
  // Modèle seul : A à 50 % contre une cote de 2,6 → +30 % d'avantage annoncé.
  assert.equal(recommend(raw, odds, 1)[0]?.kind, 'value');
  // Combiné au marché : ≈ 43 %, encore +12 % : on joue, mais l'avantage est plus réaliste.
  const list = blendMarket(raw, odds, 0.5);
  assert.ok(list[0].p > 0.4 && list[0].p < 0.45, `${list[0].p}`);
  assert.equal(list[0].pModel, 0.5);
  // Écart faible entre modèle et Stake : la marge du bookmaker l'emporte, pas de pari.
  const close = blendMarket([mk('map:A', 0.4), mk('map:B', 0.6)], odds, 0.5);
  assert.equal(recommend(close, odds, 1).filter((p) => p.kind === 'value').length, 0);
  // Sans cote des deux côtés : avis du modèle inchangé.
  assert.equal(blendMarket([mk('ot:Y', 0.3)], {}, 0.5)[0].p, 0.3);
});

test('mise totale plafonnée quand plusieurs paris VALUE vont ensemble', () => {
  const list = [mk('map:A', 0.7), mk('map:B', 0.3), { ...mk('hcp-1.5:A', 0.65), group: 'h' }, { ...mk('hcp-1.5:B', 0.35), group: 'h' },
    { ...mk('series:A', 0.75), group: 's' }, { ...mk('series:B', 0.25), group: 's' }];
  const odds = { 'map:A': 2.2, 'hcp-1.5:A': 2.4, 'series:A': 2.3 };
  const picks = recommend(list, odds, 1, { max: 99 });
  const rows = buildAdvice({}, { list, picks, odds });
  const total = rows.filter((r) => r.status === 'value').reduce((s, r) => s + r.stake, 0);
  assert.ok(rows.filter((r) => r.status === 'value').length >= 3);
  assert.ok(total <= 0.05 + 1e-9, `${total}`);
});

test('journal : ProBet contre Stake et poids du modèle appris', () => {
  const j = { v: 1, maps: {} };
  // 12 maps où Stake voyait juste et ProBet se trompait : le poids du modèle baisse.
  for (let i = 0; i < 12; i++) {
    const w = i % 4 === 0 ? 'B' : 'A';
    j.maps[`m${i}`] = { matchId: `${i}`, teams: ['A', 'B'], picks: {}, final: { a: 13, b: 7, w },
      rounds: { 3: { w: 'A', start: { pm: 0.35, mk: 0.75, pr: 0.5 } } } };
  }
  const vs = summarize(j).vsStake;
  assert.equal(vs.maps, 12);
  assert.ok(vs.stake < vs.probet);
  assert.ok(vs.best < 0.2 && vs.w < 0.35 && vs.w > vs.best, JSON.stringify(vs));
});
