import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sameTeam, homeSideOf, findFixture, bookOdds } from '../extension/books.js';

// stake.js est un script de page classique : on l'exécute hors navigateur pour tester ses fonctions pures.
const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../extension/stake.js', import.meta.url), 'utf8'), ctx);
const { parseSpecifiers, mapNumberOf, createModel, applyPayload, snapshot } = ctx.__probetStakeCore;

// Réponse GraphQL « slugFixture » d'une vraie page Stake (Team Falcons - Natus Vincere, map 1 à 9-6).
const payload = JSON.parse(readFileSync(new URL('./fixtures/stake-fixture.json', import.meta.url), 'utf8'));
const SLUG = '867503-team-falcons-natus-vincere';
const load = (now = 1000) => {
  const model = createModel();
  applyPayload(model, payload, SLUG, now);
  return model;
};

test('spécificateurs et numéro de map Stake', () => {
  assert.deepEqual({ ...parseSpecifiers('handicap=-2.5|map=1') }, { handicap: '-2.5', map: '1' });
  assert.equal(mapNumberOf('1re map'), 1);
  assert.equal(mapNumberOf('2e map'), 2);
  assert.equal(mapNumberOf('Map 3'), 3);
  assert.equal(mapNumberOf('Pause'), null);
});

test('lecture du match Stake intégré à la page', () => {
  const snap = snapshot(load(), 2000);
  assert.equal(snap.slug, SLUG);
  assert.equal(snap.home.name, 'Team Falcons');
  assert.equal(snap.away.abbr, 'NaVi');
  assert.equal(snap.mapNumber, 1);
  assert.deepEqual({ ...snap.rounds }, { home: 9, away: 6 });
  const tpls = new Set(snap.markets.map((m) => m.tpl));
  assert.ok(!tpls.has('25'), 'marchés inutiles ignorés');
  for (const t of ['1', '6', '11', '24', '28']) assert.ok(tpls.has(t), `modèle ${t}`);
  // Un autre match (liste latérale) n'est pas pris pour le match affiché.
  const other = createModel();
  applyPayload(other, payload, 'autre-match', 0);
  assert.equal(snapshot(other, 0), null);
});

test('mises à jour en direct reconnues par identifiant, quel que soit le format du message', () => {
  const model = load(1000);
  const f = payload.data.slugFixture;
  const mk = f.groups.flatMap((g) => g.templates).flatMap((t) => t.markets)
    .find((m) => m.templateExtId === '6' && m.specifiers === 'map=1|variant=way:two|way=two');
  const [falcons] = mk.outcomes;
  // Message WebSocket imbriqué de forme inconnue : seule compte la paire id / cote.
  applyPayload(model, { type: 'next', payload: { data: { update: { outcome: { id: falcons.id, odds: 1.11 } } } } }, SLUG, 5000);
  applyPayload(model, { data: { market: { id: mk.id, status: 'suspended' } } }, SLUG, 6000);
  const snap = snapshot(model, 6000);
  const m = snap.markets.find((x) => x.tpl === '6' && x.spec.map === '1' && x.spec.way === 'two');
  assert.equal(m.status, 'suspended');
  assert.equal(m.outcomes[0].odds, 1.11);
  assert.equal(m.outcomes[0].seen, 6000);
});

test('équipes HLTV ↔ Stake', () => {
  const falcons = { name: 'Team Falcons', abbr: 'FALCONS' };
  const navi = { name: 'Natus Vincere', abbr: 'NaVi' };
  assert.ok(sameTeam('Falcons', falcons));
  assert.ok(sameTeam('Natus Vincere', navi));
  assert.ok(sameTeam('NAVI', navi));
  assert.ok(!sameTeam('Natus Vincere', falcons));
  assert.ok(sameTeam('G2', { name: 'G2 Esports', abbr: 'G2' }));
  assert.ok(sameTeam('Team Vitality', { name: 'Vitality', abbr: 'VIT' }));
  assert.ok(!sameTeam('G2', { name: 'Vitality', abbr: 'VIT' }));
  const fx = { home: falcons, away: navi };
  assert.equal(homeSideOf(fx, ['Falcons', 'Natus Vincere']), 'A');
  assert.equal(homeSideOf(fx, ['Natus Vincere', 'Falcons']), 'B');
  assert.equal(homeSideOf(fx, ['Vitality', 'Natus Vincere']), null);
  assert.equal(findFixture([{ home: navi, away: { name: 'MOUZ' } }, fx], ['Natus Vincere', 'Falcons'])?.homeSide, 'B');
});

test('marchés Stake → identifiants ProBet pour la map en cours', () => {
  const snap = snapshot(load(), 2000);
  const odds = (side, map) => Object.fromEntries(Object.entries(bookOdds(snap, side, map)).map(([k, v]) => [k, v.odds]));

  const a = odds('A', 1); // Falcons = A (domicile)
  assert.equal(a['series:A'], 1.28);
  assert.equal(a['series:B'], 3.3);
  assert.equal(a['map:A'], 1.2); // version « Two options », pas celle avec match nul
  assert.equal(a['map:B'], 4);
  assert.equal(a['hcp-2.5:A'], 1.4); // Falcons -2.5
  assert.equal(a['hcp2.5:A'], 1.06); // Falcons +2.5
  assert.equal(a['tot22.5:O'], 2);
  assert.equal(a['tot22.5:U'], 1.72);
  assert.equal(a['ot:Y'], 5);
  assert.equal(a['ot:N'], 1.13);
  assert.equal(a['round1:A'], undefined, 'pistol de la map 2 ignoré sur la map 1');

  const b = odds('B', 1); // HLTV liste NaVi en premier : NaVi = A
  assert.equal(b['series:A'], 3.3);
  assert.equal(b['map:A'], 4);
  assert.equal(b['hcp2.5:A'], 2.7); // NaVi +2.5
  assert.equal(b['hcp-2.5:A'], 7); // NaVi -2.5
  assert.equal(b['tot22.5:O'], 2);

  const m2 = odds('A', 2);
  assert.equal(m2['map:A'], 1.5);
  assert.equal(m2['round1:A'], 1.78);
  assert.equal(m2['round13:B'], 2.05);
  assert.equal(m2['series:A'], 1.28);
});

test('marché suspendu ou issue fermée : pas de cote', () => {
  const snap = snapshot(load(), 2000);
  const mk = snap.markets.find((x) => x.tpl === '28' && x.spec.map === '1');
  mk.status = 'suspended';
  const o = bookOdds(snap, 'A', 1);
  assert.equal(o['ot:Y'].odds, null);
  assert.ok('ot:Y' in o);
  const w = snap.markets.find((x) => x.tpl === '1');
  w.outcomes[0].active = false;
  assert.equal(bookOdds(snap, 'A', 1)['series:A'].odds, null);
  assert.equal(bookOdds(snap, 'A', 1)['series:B'].odds, 3.3);
});
