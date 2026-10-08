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
    assert.deepEqual(rows.map((r) => r.key), ['hcp', 'map', 'tot', 'ot']);
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

test('handicap sans pari rentable : meilleure ligne Stake et cote à attendre', () => {
  const mk = (id, p) => ({ id, group: 'Map 1 — handicap', label: id, p, sd: 0 });
  const list = [mk('hcp-2.5:A', 0.55), mk('hcp-2.5:B', 0.45), mk('hcp3.5:A', 0.8), mk('hcp3.5:B', 0.2)];
  const odds = { 'hcp-2.5:A': 1.7, 'hcp-2.5:B': 2.0, 'hcp3.5:A': 1.15, 'hcp3.5:B': 5 };
  const row = buildAdvice({}, { list, picks: [], odds }).find((r) => r.key === 'hcp');
  assert.equal(row.status, 'low');
  assert.equal(row.id, 'hcp-2.5:A'); // 0,55 × 1,70 = 0,935 : la plus proche d'un pari rentable
  assert.ok(row.min > 1.8 && row.min < 1.95);
  // Sans cote : pas de ligne choisie au hasard.
  assert.equal(buildAdvice({}, { list, picks: [], odds: {} }).find((r) => r.key === 'hcp').status, 'none');
});

test('handicap : ligne verrouillée pour le round (cas réel −4,5 → −3,5 → −2,5)', () => {
  const mk = (id, p) => ({ id, group: 'Map 1 — handicap', label: id, p, sd: 0 });
  const list = [mk('hcp-4.5:A', 0.3), mk('hcp-4.5:B', 0.7), mk('hcp-3.5:A', 0.38), mk('hcp-3.5:B', 0.62), mk('hcp-2.5:A', 0.47), mk('hcp-2.5:B', 0.53)];
  const st = {};
  const at = (odds, now, round = 14) => buildAdvice(st, { list, odds, picks: recommend(list, odds, 1, { max: 99, filters: false }), round, now })
    .find((r) => r.key === 'hcp');
  // Juste après le round : seule la ligne −4,5 a déjà sa nouvelle cote.
  let r = at({ 'hcp-4.5:A': 10 }, 0);
  assert.equal(r.id, 'hcp-4.5:A');
  // Les autres lignes arrivent pendant les premières secondes : meilleure ligne retenue.
  r = at({ 'hcp-4.5:A': 3.6, 'hcp-3.5:A': 5.8 }, 1500);
  assert.equal(r.id, 'hcp-3.5:A');
  // Ensuite la ligne ne bouge plus, même si une autre devient meilleure.
  r = at({ 'hcp-4.5:A': 3.6, 'hcp-3.5:A': 5.8 }, 6000);
  r = at({ 'hcp-4.5:A': 3.6, 'hcp-3.5:A': 2.5, 'hcp-2.5:A': 3.8 }, 12000);
  assert.equal(r.id, 'hcp-3.5:A');
  assert.equal(r.status, 'low'); // plus rentable : on le dit, sur la même ligne
  // Round suivant : nouveau choix.
  r = at({ 'hcp-4.5:A': 3.6, 'hcp-3.5:A': 2.5, 'hcp-2.5:A': 3.8 }, 30000, 15);
  assert.equal(r.id, 'hcp-2.5:A');
});
