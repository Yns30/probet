// Calibrage : ProBet comparé à la probabilité live affichée par HLTV sur des situations réelles.
// Écart toléré : quelques points (deux modèles indépendants), pas d'ajustement point par point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toMatch } from '../extension/hltv.js';
import { analyze } from '../extension/engine.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));

test('Vitality-NaVi, Anubis 10-4, Vitality en full buy contre une eco (HLTV 94,2 % + 4,5 % OT)', () => {
  const { scoreboard, meta, hltv } = load('diag-vit-navi-r15.json');
  const res = analyze(toMatch(scoreboard, meta, { econ: {} }));
  const hltvMap = hltv.reg1 + hltv.ot / 2;
  assert.ok(Math.abs(res.pMap - hltvMap) < 0.035, `ProBet ${res.pMap.toFixed(3)} contre HLTV ${hltvMap.toFixed(3)}`);
  assert.ok(Math.abs(res.pRegA + res.pOT + res.pRegB - 1) < 1e-6);
  assert.ok(res.pRound > 0.8, 'full buy contre eco');
});

test('les rounds s’enchaînent par séries : une avance de 10-4 n’est pas définitive', () => {
  const { scoreboard, meta } = load('diag-vit-navi-r15.json');
  const res = analyze(toMatch(scoreboard, meta, { econ: {} }));
  assert.ok(res.pMap < 0.993, `${res.pMap}`);
  assert.ok(res.pOT > 0.01, `prolongation ${res.pOT}`);
});
