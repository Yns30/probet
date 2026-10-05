import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdvice } from '../extension/advice.js';
import { recommend } from '../extension/engine.js';

const mk = (id, p, group, label = id) => ({ id, group, label, p, sd: 0 });
const market = (pMap, pRound = 0.5) => [
  mk('round5:A', pRound, 'Round 5', 'Vitality'), mk('round5:B', 1 - pRound, 'Round 5', 'Falcons'),
  mk('map:A', pMap, 'Map — vainqueur', 'Vitality'), mk('map:B', 1 - pMap, 'Map — vainqueur', 'Falcons'),
  mk('hcp-2.5:A', pMap - 0.15, 'Map — handicap'), mk('tot21.5:O', 0.5, 'Map — total rounds'),
  mk('ot:Y', 0.1, 'Map — prolongation', 'Oui'), mk('ot:N', 0.9, 'Map — prolongation', 'Non'),
];
const rowsFor = (st, list, odds = {}) => buildAdvice(st, { list, odds, picks: recommend(list, odds, 1, { max: 99 }) });

test('conseil : toujours les mêmes lignes, dans le même ordre', () => {
  for (const pMap of [0.55, 0.75, 0.95]) {
    const rows = rowsFor({}, market(pMap));
    assert.deepEqual(rows.map((r) => r.key), ['round', 'map', 'hcp', 'tot', 'ot']);
  }
});

test('vainqueur de la map : toujours affiché, avec un statut clair', () => {
  const st = {};
  assert.equal(rowsFor(st, market(0.55)).find((r) => r.key === 'map').status, 'wait'); // trop incertain
  const play = rowsFor(st, market(0.75)).find((r) => r.key === 'map');
  assert.equal(play.status, 'play');
  assert.equal(play.sel, 'Vitality');
  assert.ok(play.min > 1 / 0.75);
  assert.equal(rowsFor(st, market(0.95)).find((r) => r.key === 'map').status, 'sure'); // quasi acquis
});

test('cote saisie : À JOUER si suffisante, PAS DE PARI sinon', () => {
  assert.equal(rowsFor({}, market(0.75), { 'map:A': 1.6 }).find((r) => r.key === 'map').status, 'value');
  const low = rowsFor({}, market(0.75), { 'map:A': 1.2 }).find((r) => r.key === 'map');
  assert.equal(low.status, 'low');
  assert.equal(low.odds, 1.2);
  assert.equal(rowsFor({}, market(0.95), { 'map:A': 1.02 }).find((r) => r.key === 'map').status, 'low');
});

test('le favori affiché ne bascule pas pour un point de probabilité', () => {
  const st = {};
  assert.equal(rowsFor(st, market(0.52)).find((r) => r.key === 'map').sel, 'Vitality');
  assert.equal(rowsFor(st, market(0.48)).find((r) => r.key === 'map').sel, 'Vitality'); // reste
  assert.equal(rowsFor(st, market(0.40)).find((r) => r.key === 'map').sel, 'Falcons'); // bascule nette
});

test('handicap et total sans ligne intéressante : ligne présente, sans sélection au hasard', () => {
  const tot = rowsFor({}, market(0.55)).find((r) => r.key === 'tot');
  assert.equal(tot.status, 'none');
  assert.equal(tot.id, null);
});
