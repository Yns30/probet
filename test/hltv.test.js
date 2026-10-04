import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEvents, toMatch, buyType, predictBuy, seriesState, oddsToProb, ctIsTeam1, describeLog, bestOfFrom,
} from '../extension/hltv.js';
import { analyze, markets } from '../extension/engine.js';
import { createDemoMatch } from '../extension/demo.js';

const player = (nick, o = {}) => ({
  nick, name: nick, alive: true, hp: 100, money: 1500, primaryWeapon: 'ak47', kevlar: true, helmet: true,
  hasDefuseKit: false, score: 0, deaths: 0, assists: 0, damagePrRound: 0, ...o,
});
const won = (r, type = 'CTs_Win') => ({ type, roundOrdinal: r, survivingPlayers: 2 });
const lost = (r) => ({ type: 'lost', roundOrdinal: r, survivingPlayers: 0 });

// FURIA (équipe 1 de la page) en CT, MOUZ en T, 3-2, round 6 en cours.
const SB = {
  CT: ['FalleN', 'yuurih', 'KSCERATO', 'molodoy', 'YEKINDAR'].map((n, i) => player(n, { primaryWeapon: 'm4a1_silencer', alive: i < 3, hp: i < 3 ? 60 : 0 })),
  TERRORIST: ['torzsi', 'Spinx', 'xertioN', 'Jimpphat', 'Brollan'].map((n, i) => player(n, { alive: i < 2, hp: i < 2 ? 90 : 0 })),
  ctMatchHistory: { firstHalf: [won(1), lost(2), won(3), won(4), lost(5)], secondHalf: [] },
  terroristMatchHistory: { firstHalf: [lost(1), won(2, 'Terrorists_Win'), lost(3), lost(4), won(5, 'Target_Bombed')], secondHalf: [] },
  bombPlanted: false, mapName: 'de_mirage', terroristTeamName: 'MOUZ', ctTeamName: 'FURIA',
  currentRound: 6, counterTerroristScore: 3, terroristScore: 2, ctTeamId: 8297, tTeamId: 4494,
  frozen: false, live: true,
};
const META = {
  team1: { name: 'FURIA', id: 8297 }, team2: { name: 'MOUZ', id: 4494 }, bestOf: 3,
  maps: [{ name: 'Mirage', s1: 3, s2: 2 }, { name: 'Inferno', s1: null, s2: null }],
  odds: [[2.1, 1.72], [2.05, 1.75]],
};

test('extraction : trames socket.io websocket, polling et JSON brut', () => {
  const ws = `42["scoreboard",${JSON.stringify(SB)}]`;
  const [e] = extractEvents(ws);
  assert.equal(e.event, 'scoreboard');
  assert.equal(e.data.ctTeamName, 'FURIA');

  const logStr = JSON.stringify({ log: [{ Kill: { killerNick: 'KSCERATO', victimNick: 'torzsi', weapon: 'ak47', headShot: true } }] });
  const polling = `${ws.length}:${ws}${logStr.length}:42["log",${JSON.stringify(logStr)}]`;
  const evs = extractEvents(polling);
  assert.deepEqual(evs.map((x) => x.event), ['scoreboard', 'log']);
  assert.equal(evs[1].data.log[0].Kill.victimNick, 'torzsi');

  const v4 = `42["scoreboard",${JSON.stringify(SB)}]\x1e42["log",${JSON.stringify(logStr)}]`;
  assert.equal(extractEvents(v4).length, 2);
  assert.equal(extractEvents(JSON.stringify({ data: SB }))[0].event, 'scoreboard');
  assert.deepEqual(extractEvents('42["scoreboard",{"a":"]'), []); // trame tronquée
  assert.deepEqual(extractEvents('2'), []);
});

test('scoreboard → état du match', () => {
  const mem = { econ: {} };
  const m = toMatch(SB, META, mem);
  assert.deepEqual([m.scoreA, m.scoreB, m.aSide, m.phase, m.round], [3, 2, 'CT', 'live', 6]);
  assert.deepEqual([m.aliveA, m.aliveB, m.hpA, m.hpB], [3, 2, 180, 180]);
  assert.equal(m.map, 'mirage');
  assert.deepEqual(m.rounds.map((r) => r.winner).join(''), 'ABAAB');
  assert.ok(m.rounds.every((r) => r.aSide === 'CT'));
  assert.deepEqual(m.hist, {}); // round 6 : plus d'effet pistol
  assert.deepEqual([m.mapsA, m.mapsB, m.mapNumber, m.bestOf], [0, 0, 1, 3]);
  assert.ok(m.prematchSeries > 0.4 && m.prematchSeries < 0.47);
  assert.equal(mem.econ[6].A, 'full');

  const res = analyze(m);
  assert.ok(res.pRound > 0.5, 'CT 3v2 favori');
  assert.ok(res.pMap > 0.4 && res.pMap < 0.75);
  assert.ok(markets(res, m.names, m).length > 10);
});

test('équipes identifiées par id, puis par nom', () => {
  assert.equal(ctIsTeam1(SB, META), true);
  assert.equal(ctIsTeam1({ ...SB, ctTeamId: 4494, tTeamId: 8297 }, META), false);
  const noIds = { team1: { name: 'MOUZ' }, team2: { name: 'FURIA' } };
  assert.equal(ctIsTeam1(SB, noIds), false);
  const m = toMatch(SB, noIds);
  assert.deepEqual([m.scoreA, m.scoreB, m.aSide, m.aliveA], [2, 3, 'T', 2]);
});

test('phases : temps d’achat, bombe, fin de round, map terminée', () => {
  assert.equal(toMatch({ ...SB, frozen: true }, META).phase, 'freezetime');
  assert.equal(toMatch({ ...SB, bombPlanted: true }, META).phase, 'bomb_planted');
  const over = toMatch({ ...SB, counterTerroristScore: 4, ctMatchHistory: { firstHalf: [...SB.ctMatchHistory.firstHalf, won(6)], secondHalf: [] } }, META);
  assert.equal(over.phase, 'round_over');
  assert.equal(over.aliveA, null);
  assert.equal(over.nextBuy, true);
  assert.equal(toMatch({ ...SB, counterTerroristScore: 13, terroristScore: 5 }, META).phase, 'map_over');
});

test('historique incomplet : décompte conservé sans côtés', () => {
  const m = toMatch({ ...SB, ctMatchHistory: { firstHalf: [], secondHalf: [] } }, META);
  assert.equal(m.rounds.length, 5);
  assert.ok(m.rounds.every((r) => r.synthetic && r.aSide === null));
});

test('économie', () => {
  assert.equal(buyType([player('a', { primaryWeapon: '', kevlar: false, helmet: false })]), 'eco');
  assert.equal(buyType([player('a', { primaryWeapon: 'galilar', helmet: false })]), 'force');
  assert.equal(buyType([player('a', { primaryWeapon: 'awp' })]), 'full');
  assert.equal(predictBuy([player('a', { money: 800, alive: false })]), 'eco');
  assert.equal(predictBuy([player('a', { money: 1800, alive: true, primaryWeapon: 'ak47' })]), 'full');
});

test('série, cotes, format, fil', () => {
  assert.deepEqual(seriesState([{ name: 'Nuke', s1: 13, s2: 9 }, { name: 'Mirage', s1: 4, s2: 7 }], 'de_mirage'), { mapsA: 1, mapsB: 0, mapNumber: 2 });
  assert.deepEqual(seriesState([{ name: 'Nuke', s1: 10, s2: 13 }]), { mapsA: 0, mapsB: 1, mapNumber: 2 });
  assert.equal(oddsToProb([]), null);
  assert.ok(Math.abs(oddsToProb([[1.9, 1.9]]) - 0.5) < 1e-9);
  assert.equal(bestOfFrom('Best of 3 (LAN)\n* Playoffs'), 3);
  assert.equal(describeLog({ Kill: { killerNick: 'a', victimNick: 'b', weapon: 'weapon_awp', headShot: true } }), 'a ➜ b (awp, HS)');
  assert.match(describeLog({ RoundEnd: { winner: 'TERRORIST', winType: 'Target_Bombed' } }), /victoire T/);
});

test('démo : une série complète au format scorebot', () => {
  const sim = createDemoMatch(42);
  const mem = { econ: {} };
  let last;
  for (let i = 0; i < 4000; i++) {
    const { scoreboard } = sim.next();
    const meta = sim.meta();
    const s = seriesState(meta.maps, scoreboard.mapName);
    if (s.mapsA === 2 || s.mapsB === 2) { last = s; break; }
    const m = toMatch(scoreboard, meta, mem);
    assert.ok(!m.rounds.some((r) => r.synthetic), `historique complet (round ${m.round})`);
    const res = analyze(m);
    assert.ok(res.pMap >= 0 && res.pMap <= 1);
  }
  assert.ok(last, 'la série se termine');
});
