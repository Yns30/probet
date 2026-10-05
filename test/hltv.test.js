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
  assert.ok(m.pre.pSeries > 0.4 && m.pre.pSeries < 0.47);
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

// ---------- Précision du modèle et données d'avant-match ----------
import { liveRoundProb, playerUnit } from '../extension/engine.js';
import { pagePrior, seriesObs } from '../extension/hltv.js';

const full = (n, o = {}) => Array.from({ length: 5 }, (_, i) => ({ alive: i < n, hp: 100, primaryWeapon: 'ak47', helmet: true, kevlar: true, ...o }));
const live = (ca, cb, extra = {}) => liveRoundProb({ aSide: 'CT', aliveA: ca, aliveB: cb, playersA: full(ca), playersB: full(cb), ...extra }, { map: 'mirage', d: 0, x: 0 });

test('round live calé sur les taux pro (avantage numérique, bombe, PV, armes)', () => {
  const avgSides = (a, b) => (live(a, b) + (1 - live(b, a))) / 2; // moyenne CT/T
  const close = (p, target, tol = 0.05) => assert.ok(Math.abs(p - target) < tol, `${p.toFixed(3)} ≉ ${target}`);
  close(avgSides(5, 4), 0.71);
  close(avgSides(5, 3), 0.86);
  close(avgSides(4, 2), 0.87);
  close(avgSides(4, 1), 0.96, 0.03);
  close(avgSides(2, 1), 0.70);
  // Bombe posée : 1v1 favorable aux T
  assert.ok(live(1, 1, { bombPlanted: true }) < 0.4);
  // 4 survivants à 6 PV avec pistolets ≠ 4 survivants en pleine santé
  const weak = liveRoundProb({ aSide: 'CT', aliveA: 4, aliveB: 1,
    playersA: full(4, { hp: 6, primaryWeapon: '' }), playersB: full(1) }, { map: 'mirage', d: 0, x: 0 });
  assert.ok(weak < live(4, 1) - 0.1, `${weak}`);
  assert.ok(playerUnit({ hp: 100, primaryWeapon: 'awp', helmet: true }) > playerUnit({ hp: 100, primaryWeapon: 'mp9', helmet: true }));
});

test('avant-match : VRS, ratings et stats de map → force de départ', () => {
  const meta = {
    team1: { name: 'G2', vrs: 1807, rank: 8, rating: 1.04 }, team2: { name: '1win', vrs: 1370, rank: 42, rating: 1.06 },
    mapStats: { mirage: { w1: 0.62, n1: 8, w2: 0.67, n2: 12 } },
  };
  const p = pagePrior(meta, 'de_mirage', 3);
  assert.ok(p.pSeries > 0.65 && p.pSeries < 0.85, `${p.pSeries}`);
  assert.ok(p.pMap > 0.55 && p.pMap < p.pSeries);
  assert.equal(pagePrior({}, 'mirage', 3), null);
  // Les cotes priment
  const withOdds = pagePrior({ ...meta, odds: [[2.5, 1.5]] }, 'mirage', 3);
  assert.ok(withOdds.pSeries < 0.5);
});

test('maps déjà jouées : rounds par mi-temps avec le bon côté', () => {
  const obs = seriesObs([
    { name: 'Dust2', s1: 11, s2: 13, halves: [{ s1: 4, s2: 8, side1: 'CT' }, { s1: 7, s2: 5, side1: 'T' }] },
    { name: 'Ancient', s1: 13, s2: 1, halves: [{ s1: 11, s2: 1, side1: 'T' }, { s1: 2, s2: 0, side1: 'CT' }] },
    { name: 'Mirage', s1: null, s2: null, halves: [] },
  ], 'de_mirage');
  assert.deepEqual(obs.map((o) => [o.map, o.wins, o.n, o.aSide]),
    [['dust2', 4, 12, 'CT'], ['dust2', 7, 12, 'T'], ['ancient', 11, 12, 'T'], ['ancient', 2, 2, 'CT']]);
  // Une série 24-14 en rounds rend G2 favori sur la 3e map
  const sb = { ...SB, counterTerroristScore: 0, terroristScore: 0, currentRound: 1, frozen: true,
    ctMatchHistory: { firstHalf: [], secondHalf: [] }, terroristMatchHistory: { firstHalf: [], secondHalf: [] } };
  const metaS = { ...META, odds: [], maps: [
    { name: 'Dust2', s1: 11, s2: 13, halves: [{ s1: 4, s2: 8, side1: 'CT' }, { s1: 7, s2: 5, side1: 'T' }] },
    { name: 'Ancient', s1: 13, s2: 1, halves: [{ s1: 11, s2: 1, side1: 'T' }, { s1: 2, s2: 0, side1: 'CT' }] }] };
  const res = analyze(toMatch(sb, metaS, { econ: {} }));
  assert.ok(res.strength.mean > 0.1, `${res.strength.mean}`);
});

test('achat lu sur les survivants si le panneau arrive en cours de round', () => {
  const sb = { ...SB, TERRORIST: SB.TERRORIST.map((p, i) => ({ ...p, primaryWeapon: i < 2 ? 'ak47' : '' })) };
  const m = toMatch(sb, META, { econ: {} });
  assert.equal(m.buyB, 'full'); // et non "eco" à cause des morts sans arme
});

test('diagnostic réel (G2-1win, round 10) : champs du scorebot exploités', async () => {
  const { readFileSync } = await import('node:fs');
  const diag = JSON.parse(readFileSync(new URL('./fixtures/diag-g2-1win-r10.json', import.meta.url)));
  const m = toMatch(diag.scoreboard, diag.meta, { econ: {} });
  assert.deepEqual([m.scoreA, m.scoreB, m.aSide, m.phase, m.round], [5, 4, 'CT', 'live', 10]);
  assert.deepEqual([m.buyA, m.buyB], ['eco', 'full']); // 6 400 $ contre 28 150 $ au départ du round
  assert.equal(m.timer, 50);
  assert.deepEqual([m.aliveA, m.aliveB], [2, 2]);
  assert.equal(m.rounds.map((r) => r.winner).join(''), 'BBAAAAABB');
  assert.equal(m.seriesObs.length, 4);
  const res = analyze(m);
  // 2v2, deux pistolets sans armure contre M4 + AK casqués : 1win très favori sur ce round
  assert.ok(res.pRound < 0.25, `pRound=${res.pRound}`);
  assert.ok(res.pMap > 0.4 && res.pMap < 0.8, `pMap=${res.pMap}`);
});

test('économie : eco et force-buy contre full buy (taux pro), à 5v5 puis en cours de round', async () => {
  const { roundLogit, sig } = await import('../extension/engine.js');
  // À 5 contre 5, la probabilité est celle d'avant-round (économie, force, côté).
  const pre = (buy) => {
    const ctx = (aSide, A, B) => ({ map: 'mirage', d: 0, aSide, econ: { A, B } });
    return (sig(roundLogit(6, ctx('CT', buy, 'full'))) + sig(roundLogit(6, ctx('T', buy, 'full')))) / 2;
  };
  assert.ok(pre('eco') > 0.12 && pre('eco') < 0.25, `eco=${pre('eco')}`);
  assert.ok(pre('force') > 0.25 && pre('force') < 0.4, `force=${pre('force')}`);
  const team = (o) => Array.from({ length: 5 }, () => ({ alive: true, hp: 100, ...o }));
  const fullBuy = team({ primaryWeapon: 'ak47', helmet: true, kevlar: true });
  const ecoT = team({ primaryWeapon: 'glock', kevlar: false, helmet: false });
  const base = { map: 'mirage', d: 0, x: -1.2 };
  assert.equal(liveRoundProb({ aSide: 'T', aliveA: 5, aliveB: 5, playersA: ecoT, playersB: fullBuy }, base), sig(-1.2));
  // 4 contre 4 : l'écart d'équipement des survivants compte.
  const kill = (ps) => ps.map((p, i) => (i === 0 ? { ...p, alive: false, hp: 0 } : p));
  const p44 = liveRoundProb({ aSide: 'T', aliveA: 4, aliveB: 4, playersA: kill(ecoT), playersB: kill(fullBuy) }, base);
  assert.ok(p44 > 0.03 && p44 < 0.2, `4v4 eco=${p44}`);
});

test('achats reçus joueur par joueur en début de round : pas de faux « eco »', () => {
  const p = (o) => ({ alive: true, hp: 100, money: 0, ...o });
  const rifles = (n) => Array.from({ length: 5 }, (_, i) => p(i < n ? { primaryWeapon: 'ak47', helmet: true, kevlar: true, equipmentValue: 5100 } : { equipmentValue: 0 }));
  const sb = (nA, nB, init) => ({
    ...SB, CT: rifles(nA), TERRORIST: rifles(nB), bombPlanted: false, currentRoundState: 'started', frozen: false,
    ctInitialEquipmentValue: init, tInitialEquipmentValue: init, roundTimeRemainingMS: 114500,
  });
  const mem = { econ: {} };
  // Première trame : rien n'est encore arrivé → achat inconnu, pas « eco contre eco ».
  let m = toMatch(sb(0, 1, 0), META, mem);
  assert.equal(m.econReady, false);
  assert.notEqual(m.buyA, 'eco');
  m = toMatch(sb(3, 2, 9000), META, mem);
  assert.equal(m.econReady, false);
  m = toMatch(sb(5, 5, 25500), META, mem);
  assert.equal(m.econReady, true);
  assert.deepEqual([m.buyA, m.buyB], ['full', 'full']);
  assert.equal(mem.econ[6].A, 'full');
});

test('économie du round suivant selon l’issue du round', async () => {
  const { nextBuys, lossStreak } = await import('../extension/hltv.js');
  const broke = Array.from({ length: 5 }, () => ({ alive: false, money: 300 }));
  const rich = Array.from({ length: 5 }, () => ({ alive: true, money: 4000, primaryWeapon: 'ak47', helmet: true }));
  const rounds = [{ winner: 'B' }, { winner: 'B' }];
  assert.equal(lossStreak(rounds, 'A'), 2);
  const nb = nextBuys(broke, rich, rounds, 6);
  assert.equal(nb.B.A, 'force'); // A perd encore : 300 $ + 2 400 $ de bonus → force-buy possible
  assert.equal(nb.A.A, 'half'); // A gagne : 300 $ + 3 250 $
  assert.equal(nextBuys(broke, rich, [{ winner: 'A' }], 6).B.A, 'eco'); // 1re défaite : 300 $ + 1 400 $
  assert.equal(nb.B.B, 'full');
  assert.equal(nextBuys(broke, rich, rounds, 13), null); // mi-temps : argent remis à zéro
});

test('diagnostic réel (round 12, bombe posée) : chrono de bombe et niveau des joueurs', async () => {
  const { readFileSync } = await import('node:fs');
  const { matchRating } = await import('../extension/hltv.js');
  const diag = JSON.parse(readFileSync(new URL('./fixtures/diag-g2-1win-r12-bomb.json', import.meta.url)));
  const m = toMatch(diag.scoreboard, diag.meta, { econ: {} });
  assert.equal(m.phase, 'bomb_planted');
  assert.ok(Math.abs(m.bombTimer - 32.8) < 0.1);
  assert.deepEqual([m.buyA, m.buyB, m.aliveA, m.aliveB], ['full', 'full', 1, 1]);
  const hunter = m.players.A.find((p) => p.nick === 'huNter-');
  assert.ok(matchRating(hunter, 11) > 1.4, 'huNter- en forme (11-8, 123 ADR)');
  const res = analyze(m);
  assert.ok(res.pRound > 0.15 && res.pRound < 0.45, `1v1 post-plant sans kit : ${res.pRound}`);
  // Plus assez de temps pour désamorcer sans kit : le round est perdu pour les CT
  const late = analyze(toMatch({ ...diag.scoreboard, roundTimeRemainingMS: 8000 }, diag.meta, { econ: {} }));
  assert.ok(late.pRound < 0.02, `${late.pRound}`);
});

test('diagnostic réel (Vitality-NaVi, Anubis 4-0) : cohérent avec HLTV (87 %)', () => {
  const pl = (nick, dbId, k, d, a, w, kast, adr, eq, kit = false) => ({ nick, name: nick, dbId, score: k, deaths: d, assists: a, alive: true, hp: 100, primaryWeapon: w, kevlar: true, helmet: true, hasDefusekit: kit, advancedStats: { kast }, damagePrRound: adr, equipmentValue: eq, money: 1000 });
  const sb = {
    TERRORIST: [pl('w0nderful', 20127, 3, 4, 1, 'awp', 4, 79.4, 6850), pl('b1t', 18987, 2, 4, 1, 'ak47', 4, 59.8, 5100), pl('iM', 14759, 2, 4, 0, 'ak47', 3, 26.8, 5100), pl('Aleksib', 9816, 1, 4, 0, 'ak47', 3, 20, 5100), pl('makazze', 22673, 0, 4, 0, 'ak47', 3, 17, 4800)],
    CT: [pl('mezii', 18462, 7, 1, 0, 'm4a1_silencer', 5, 129.6, 5800, true), pl('apEX', 7322, 4, 1, 2, 'ak47', 5, 93.6, 5600, true), pl('ZywOo', 11893, 4, 1, 1, 'awp', 5, 82.4, 7650, true), pl('flameZ', 16693, 4, 3, 0, 'm4a1', 5, 54, 5500, true), pl('ropz', 11816, 1, 2, 2, 'ak47', 5, 38.8, 5500)],
    ctMatchHistory: { firstHalf: [1, 2, 3, 4].map((r) => ({ type: r === 4 ? 'Bomb_Defused' : 'CTs_Win', roundOrdinal: r })), secondHalf: [] },
    terroristMatchHistory: { firstHalf: [1, 2, 3, 4].map((r) => ({ type: 'lost', roundOrdinal: r })), secondHalf: [] },
    bombPlanted: false, mapName: 'de_anubis', terroristTeamName: 'Natus Vincere', ctTeamName: 'Vitality', currentRound: 5, currentRoundState: 'started',
    counterTerroristScore: 4, terroristScore: 0, ctTeamId: 9565, tTeamId: 4608, frozen: false, live: true,
    ctInitialEquipmentValue: 30050, tInitialEquipmentValue: 26950, roundTimeRemainingMS: 110971,
  };
  const meta = {
    team1: { name: 'Vitality', id: 9565, rank: 2, vrs: 1922, rating: 1.107, form: { won: 12, lost: 6 } },
    team2: { name: 'Natus Vincere', id: 4608, rank: 10, vrs: 1506, rating: 1.028, form: { won: 4, lost: 5 } },
    bestOf: 3, maps: [{ name: 'Anubis', s1: null, s2: null, halves: [] }], mapStats: { anubis: { w1: 0.43, n1: 7, w2: null, n2: 1 } },
    odds: [], h2h: { w1: 22, w2: 3 },
  };
  const m = toMatch(sb, meta, { econ: {} });
  assert.ok(m.pre.sources.some((s) => s.includes('Face-à-face')));
  assert.ok(m.pre.sources.some((s) => s.includes('anubis')), 'stats de map utilisées même si une équipe a < 3 maps');
  const res = analyze(m);
  assert.ok(Math.abs(res.pMap - 0.874) < 0.06, `map ${res.pMap} vs HLTV 0.874`);
});

test('historique HLTV incomplet : complété par les changements de score observés', () => {
  const mem = { econ: {}, winners: {} };
  const noHist = { ...SB, ctMatchHistory: { firstHalf: [], secondHalf: [] }, terroristMatchHistory: { firstHalf: [], secondHalf: [] } };
  // On suit le match depuis 0-0 : chaque changement de score donne le vainqueur du round.
  const seq = [[0, 0], [1, 0], [1, 1], [2, 1], [3, 1], [3, 2]];
  let m;
  for (const [ct, t] of seq) m = toMatch({ ...noHist, counterTerroristScore: ct, terroristScore: t, currentRound: ct + t + 1 }, META, mem);
  assert.equal(m.rounds.map((r) => r.winner).join(''), 'ABAAB');
  assert.ok(m.rounds.every((r) => !r.synthetic && r.aSide === 'CT'));
});

test('changement de côté : trame où les équipes ont changé de côté mais pas les scores', () => {
  const vit = [1, 2, 3, 4, 5].map((id) => ({ dbId: id, name: `v${id}`, alive: true, hp: 100 }));
  const fal = [6, 7, 8, 9, 10].map((id) => ({ dbId: id, name: `f${id}`, alive: true, hp: 100 }));
  const meta = { team1: { name: 'Vitality', id: 9565 }, team2: { name: 'Falcons', id: 11283 }, lineups: { team1: [1, 2, 3, 4, 5], team2: [6, 7, 8, 9, 10] } };
  const hist = { firstHalf: [], secondHalf: [] };
  const frame = (o) => ({ mapName: 'de_dust2', live: true, currentRoundState: 'started', ctMatchHistory: hist, terroristMatchHistory: hist, ...o });
  const mem = { econ: {}, winners: {} };
  // Fin de la 1re mi-temps : Vitality (T) mène 9-3.
  let m = toMatch(frame({ CT: fal, TERRORIST: vit, ctTeamId: 11283, tTeamId: 9565, counterTerroristScore: 3, terroristScore: 9, currentRound: 12 }), meta, mem);
  assert.deepEqual([m.names[0], m.scoreA, m.scoreB, m.aSide], ['Vitality', 9, 3, 'T']);
  // Trame de transition : Vitality passe CT, mais les scores sont encore ceux de la 1re mi-temps.
  m = toMatch(frame({ CT: vit, TERRORIST: fal, ctTeamId: 9565, tTeamId: 11283, counterTerroristScore: 3, terroristScore: 9, currentRound: 13, currentRoundState: 'over' }), meta, mem);
  assert.deepEqual([m.scoreA, m.scoreB, m.aSide], [9, 3, 'CT']);
  // Trame inverse : identifiants d'équipe pas encore mis à jour, joueurs déjà passés de côté.
  m = toMatch(frame({ CT: vit, TERRORIST: fal, ctTeamId: 11283, tTeamId: 9565, counterTerroristScore: 9, terroristScore: 3, currentRound: 13 }), meta, { econ: {} });
  assert.deepEqual([m.scoreA, m.scoreB, m.aSide], [9, 3, 'CT']);
  // Le score d'après est normal.
  m = toMatch(frame({ CT: vit, TERRORIST: fal, ctTeamId: 9565, tTeamId: 11283, counterTerroristScore: 10, terroristScore: 3, currentRound: 14 }), meta, mem);
  assert.deepEqual([m.scoreA, m.scoreB], [10, 3]);
});
