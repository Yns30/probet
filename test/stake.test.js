import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sameTeam, homeSideOf, findFixture, bookOdds, bookLines, pickMapNumber, bookClosure } from '../extension/books.js';
import { analyze, markets } from '../extension/engine.js';

// stake.js est un script de page classique : on l'exécute hors navigateur pour tester ses fonctions pures.
const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../extension/stake.js', import.meta.url), 'utf8'), ctx);
const { parseSpecifiers, mapNumberOf, createModel, applyPayload, snapshot, matchDomOutcome, mentionsFixture } = ctx.__probetStakeCore;

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
  assert.equal(m.outcomes[0].seen, 5000); // dernière confirmation de cette cote
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
  assert.equal(b['hcp2.5:B'], 1.4); // Falcons -2.5 = côté B de la ligne NaVi +2.5
  assert.equal(a['hcp-2.5:B'], 2.7); // NaVi +2.5 = côté B de la ligne Falcons -2.5
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

// Deuxième page réelle : FURIA - 9z, map 2 en cours (11-3), marchés de la map suspendus,
// lignes de handicap et de total décalées par le score.
const map2 = JSON.parse(readFileSync(new URL('./fixtures/stake-fixture-map2.json', import.meta.url), 'utf8'));
const SLUG2 = '869002-furia-esports-9z-team';

test('map en cours : lignes réellement proposées par Stake, marchés suspendus sans cote', () => {
  const model = createModel();
  applyPayload(model, map2, SLUG2, 1000);
  const snap = snapshot(model, 1000);
  assert.equal(snap.mapNumber, 2);
  const o = bookOdds(snap, 'A', 2); // FURIA = A
  assert.equal(o['map:A'].odds, null, 'vainqueur map 2 suspendu');
  const odds = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.odds]));
  assert.equal(odds['hcp-9.5:A'], 2.15); // FURIA -9.5
  assert.equal(odds['hcp-9.5:B'], 1.62); // 9z +9.5
  assert.equal(odds['tot16.5:O'], 1.62);
  assert.equal(odds['tot16.5:U'], 2.15);
  assert.equal(odds['tot22.5:O'], undefined, 'ligne non proposée sur la map 2');
  const lines = bookLines(o);
  assert.deepEqual(lines.tot, [16.5, 17.5, 18.5, 19.5, 20.5, 21.5]);
  assert.deepEqual(lines.hcp, [-9.5, -8.5, -7.5, -6.5, -5.5, -4.5]);
});

test('le moteur calcule les lignes du bookmaker, des deux côtés du handicap', () => {
  const m = { scoreA: 11, scoreB: 3, mapNumber: 2 };
  const res = { pMap: 0.9, pOT: 0.02, over: null, pOver: (l) => (l < 20 ? 0.6 : 0.2), pCover: (h) => (h < -8 ? 0.4 : 0.7) };
  const list = markets(res, ['FURIA', '9z'], m, { tot: [16.5, 21.5], hcp: [-9.5, -4.5] });
  const ids = list.map((x) => x.id);
  assert.ok(ids.includes('tot16.5:O') && ids.includes('tot21.5:U'));
  assert.ok(!ids.includes('tot22.5:O'));
  assert.ok(ids.includes('hcp-9.5:A') && ids.includes('hcp-9.5:B'));
  const b = list.find((x) => x.id === 'hcp-9.5:B');
  assert.equal(b.label, '9z +9,5');
  assert.ok(Math.abs(b.p - 0.6) < 1e-9);
  // Sans bookmaker : lignes habituelles, inchangées.
  assert.ok(markets(res, ['A', 'B'], { scoreA: 0, scoreB: 0 }).some((x) => x.id === 'tot22.5:O'));
});

test('nouvelle ligne poussée en direct pour ce match ; ligne retirée lors de la relecture', () => {
  const model = createModel();
  applyPayload(model, map2, SLUG2, 1000);
  const msg = { type: 'next', payload: { data: { markets: [{ id: 'nouveau-hcp', templateExtId: '11', extId: '11', name: 'Map 2 - Handicap du tour (inclus prolongations)',
    status: 'active', specifiers: 'handicap=-10.5|map=2', fixtureId: map2.data.slugFixture.id,
    outcomes: [{ id: 'n1', extId: '1', name: 'FURIA Esports (-10.5)', odds: 3.1, active: true }, { id: 'n2', extId: '2', name: '9z Team (10.5)', odds: 1.33, active: true }] }] } } };
  const text = JSON.stringify(msg);
  assert.ok(mentionsFixture(model, text));
  applyPayload(model, msg, SLUG2, 2000, 'ws', mentionsFixture(model, text));
  let o = bookOdds(snapshot(model, 2000), 'A', 2);
  assert.equal(o['hcp-10.5:A'].odds, 3.1);
  // Même message pour un autre match : ignoré.
  const other = createModel();
  applyPayload(other, map2, SLUG2, 1000);
  const foreign = JSON.parse(text.replaceAll(map2.data.slugFixture.id, 'autre'));
  applyPayload(other, foreign, SLUG2, 2000, 'ws', mentionsFixture(other, JSON.stringify(foreign)));
  assert.equal(bookOdds(snapshot(other, 2000), 'A', 2)['hcp-10.5:A'], undefined);
  // Relecture complète sans la ligne -9.5 : elle disparaît.
  const reread = JSON.parse(JSON.stringify(map2));
  for (const g of reread.data.slugFixture.groups) for (const t of g.templates) t.markets = t.markets.filter((x) => x.specifiers !== 'handicap=-9.5|map=2');
  applyPayload(model, reread, SLUG2, 3000, 'poll', true);
  o = bookOdds(snapshot(model, 3000), 'A', 2);
  assert.equal(o['hcp-9.5:A'], undefined);
  assert.equal(snapshot(model, 3000).src.poll, 3000);
});

test('boutons en tableau (Plus de / Moins de, colonnes par équipe) reconnus', () => {
  const model = createModel();
  applyPayload(model, map2, SLUG2, 1000);
  const over = matchDomOutcome(model, 'Map 2 - Nombre de tours', null, '16.5', 'Plus de');
  assert.equal(over.name, 'Over 16.5');
  const under = matchDomOutcome(model, 'Map 2 - Nombre de tours', null, '16.5', 'Moins de');
  assert.equal(under.name, 'Under 16.5');
  const nine = matchDomOutcome(model, 'Map 2 - Handicap du tour (inclus prolongations)', null, '9.5', '9z Team');
  assert.equal(nine.name, '9z Team (9.5)');
  const furia = matchDomOutcome(model, 'Map 2 - Handicap du tour (inclus prolongations)', null, '-9.5', 'FURIA Esports');
  assert.equal(furia.name, 'FURIA Esports (-9.5)');
  assert.equal(matchDomOutcome(model, 'Map 2 - Nombre de tours', null, '99.5', 'Plus de'), null);
  // Libellé complet (aria-label) : correspondance directe.
  assert.equal(matchDomOutcome(model, 'Map 3 Gagnant - Two options', '9z Team', null, null).odds, 2.6);
});

test('diagnostic : aucune donnée du compte n’est enregistrée', () => {
  const { diagSafe } = ctx.__probetStakeCore;
  assert.ok(diagSafe('{"type":"next","payload":{"data":{"sportMarket":{"id":"x","status":"active"}}}}'));
  assert.ok(!diagSafe('{"data":{"user":{"email":"a@b.c"}}}'));
  assert.ok(!diagSafe('{"type":"connection_init","payload":{"accessToken":"abc"}}'));
  assert.ok(!diagSafe('{"balances":[{"available":{"amount":1}}]}'));
  assert.ok(!diagSafe('{"kycBasic":{"firstName":"X"}}'));
});

test('map à suivre : HLTV encore sur la map finie, ou mal compté (cas réel K27 - Metizport)', () => {
  const model = createModel();
  applyPayload(model, map2, SLUG2, 1000);
  // Message réel du flux Stake (forme du diagnostic) : map 1 finie 11-13, map 2 en cours.
  applyPayload(model, { id: 'sub', type: 'next', payload: { data: { sportFixture: { id: map2.data.slugFixture.id, status: 'live',
    eventStatus: { matchStatus: '2e map', homeScore: 0, awayScore: 1, scoreboard: null, periodScores: [
      { type: 'map', number: 1, homeWonRounds: 11, awayWonRounds: 13, matchStatus: '1re map' },
      { type: 'map', number: 2, homeWonRounds: null, awayWonRounds: null, matchStatus: '2e map' }] } } } } }, SLUG2, 2000, 'ws');
  const fx = snapshot(model, 2000);
  assert.equal(fx.mapNumber, 2);
  assert.deepEqual(fx.periods.map((p) => p.map), [1, 2]);
  // HLTV affiche encore la fin de la map 1 (11-13, « map 1 ») : la map 1.
  assert.deepEqual({ ...pickMapNumber(fx, 'A', { scoreA: 11, scoreB: 13, mapNumber: 1 }) }, { map: 1, why: 'finished' });
  // Même chose avec les équipes inversées côté HLTV.
  assert.equal(pickMapNumber(fx, 'B', { scoreA: 13, scoreB: 11, mapNumber: 1 }).map, 1);
  // HLTV en direct sur la map 2 mais compte « map 1 » : la map en cours chez Stake fait foi.
  assert.deepEqual({ ...pickMapNumber(fx, 'A', { scoreA: 5, scoreB: 3, mapNumber: 1 }) }, { map: 2, why: 'stake' });
  assert.equal(pickMapNumber(fx, 'A', { scoreA: 5, scoreB: 3, mapNumber: 2 }).why, 'same');
  assert.equal(pickMapNumber({}, 'A', { scoreA: 0, scoreB: 0, mapNumber: 3 }).map, 3);
  // Score en direct Stake 11-3 contre 0-2 sur HLTV : désynchronisé, pas de cotes de map.
  assert.equal(pickMapNumber({ ...fx, rounds: { home: 11, away: 3 } }, 'A', { scoreA: 0, scoreB: 2, mapNumber: 2 }).why, 'desync');
  assert.equal(pickMapNumber({ ...fx, rounds: { home: 11, away: 3 } }, 'A', { scoreA: 10, scoreB: 3, mapNumber: 2 }).why, 'same');
});

test('Stake ferme la map en cours et le match (cas réel Spirit - M80 à 12-6) : signalé', () => {
  const o = (ext, odds) => ({ ext, name: '', odds, active: true, seen: 1 });
  const fx = { at: 1, markets: [
    { tpl: '1', spec: {}, status: 'suspended', outcomes: [] },
    { tpl: '6', spec: { map: '1', way: 'two' }, status: 'suspended', outcomes: [] },
    { tpl: '11', spec: { map: '1', handicap: '3.5' }, status: 'removed', outcomes: [o('1', 1.5), o('2', 2.5)] },
    { tpl: '6', spec: { map: '2', way: 'two' }, status: 'active', outcomes: [o('1', 1.6), o('2', 2.2)] },
    { tpl: '24', spec: { map: '3', threshold: '21.5' }, status: 'active', outcomes: [o('4', 1.8), o('5', 1.9)] },
  ] };
  assert.deepEqual({ ...bookClosure(fx, 1), openMaps: [...bookClosure(fx, 1).openMaps] }, { closed: true, openMaps: [2, 3] });
  fx.markets[1] = { ...fx.markets[1], status: 'active', outcomes: [o('1', 1.3), o('2', 3.4)] };
  assert.equal(bookClosure(fx, 1).closed, false);
  assert.equal(bookClosure({ markets: [] }, 1).closed, false);
});

test('heure du dernier vrai changement de cote (cote pas encore recalculée après un round)', () => {
  const model = load(1000);
  const mk = [...model.markets.values()].find((m) => m.outcomes.length && m.status === 'active');
  const o = mk.outcomes[0];
  const first = o.chg;
  applyPayload(model, { id: o.id, odds: o.odds, active: true }, SLUG, 5000);
  assert.equal(o.chg, first, 'même cote relue : pas un changement');
  assert.equal(o.seen, 5000);
  applyPayload(model, { id: o.id, odds: o.odds + 0.1, active: true }, SLUG, 7000);
  assert.equal(o.chg, 7000);
  const snap = snapshot(model, 8000).markets.find((m) => m.outcomes.some((x) => x.chg === 7000));
  assert.ok(snap);
});

test('équipes nommées différemment chez HLTV et Stake : reconnues si une seule page correspond', () => {
  const fx = (home, away, abbr = ['', '']) => ({ home: { name: home, abbr: abbr[0] }, away: { name: away, abbr: abbr[1] }, markets: [] });
  const navi = fx('Natus Vincere Junior', 'Lazer Cats');
  assert.equal(findFixture([navi], ['Lazer Cats', 'NAVI Junior'])?.homeSide, 'B');
  // Deux pages avec la même équipe et un adversaire seulement « proche » : on ne devine pas.
  assert.equal(findFixture([fx('Lazer Kittens', 'NAVI Academy'), fx('Lazer Cats', 'Natus Vincere Junior')], ['Lazer Cats', 'NAVI Junior'])?.homeSide, 'A');
  const other = fx('Junior Stars', 'Lazer Cats');
  assert.equal(findFixture([navi, other], ['Lazer Cats', 'NAVI Junior']), null);
  // Rien en commun : pas reconnu.
  assert.equal(findFixture([fx('Team Spirit', 'M80')], ['Spirit', 'FURIA']), null);
});

test('sigle HLTV inconnu chez Stake (cas réel « LP » / LargadosyPelados)', () => {
  const fx = (home, away, abbr, status = 'live') => ({ status, home: { name: home, abbr: abbr[0] }, away: { name: away, abbr: abbr[1] }, markets: [] });
  const ldp = fx('Metanoia Wolves', 'LargadosyPelados', ['Metanoia W', 'LDP']);
  const other = fx('Galorys', 'Grêmio Esports', ['GAL', 'GRE']);
  assert.equal(findFixture([other, ldp], ['METANOIA Wolves', 'LP'])?.fixture, ldp);
  assert.equal(findFixture([other, ldp], ['LP', 'METANOIA Wolves'])?.homeSide, 'B');
  // Seule l'équipe à domicile est reconnue, adversaire sans rapport : accepté si c'est la seule
  // page en direct avec cette équipe…
  const z = fx('Metanoia Wolves', 'Zeta Division', ['MW', 'ZETA']);
  assert.equal(findFixture([other, z], ['METANOIA Wolves', 'XYZ'])?.fixture, z);
  // … mais pas si le match n'est pas en direct, ni si deux pages conviennent.
  assert.equal(findFixture([fx('Metanoia Wolves', 'Zeta Division', ['MW', 'ZETA'], 'prematch')], ['METANOIA Wolves', 'XYZ']), null);
  assert.equal(findFixture([z, ldp], ['METANOIA Wolves', 'XYZ']), null);
});

test('deux PC : heures du collecteur recalées sur l’horloge de l’affichage', async () => {
  const { shiftTimes } = await import('../extension/remote.js');
  const T = 1_790_000_000_000;
  const st = shiftTimes({ type: 'state', id: 1, state: { lastFrameAt: T, log: [{ t: T, text: 'x' }], frames: 3 } }, 5000);
  assert.equal(st.state.lastFrameAt, T + 5000);
  assert.equal(st.state.log[0].t, T + 5000);
  assert.equal(st.state.frames, 3);
  const bk = shiftTimes({ type: 'book', id: 2, fixture: { at: T, src: { poll: T }, markets: [{ outcomes: [{ odds: 1.9, seen: T, chg: null }] }] } }, -2000);
  assert.equal(bk.fixture.src.poll, T - 2000);
  assert.equal(bk.fixture.markets[0].outcomes[0].seen, T - 2000);
  assert.equal(bk.fixture.markets[0].outcomes[0].chg, null);
});
