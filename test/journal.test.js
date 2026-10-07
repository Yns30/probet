import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, markets } from '../extension/engine.js';
import { toMatch } from '../extension/hltv.js';
import { stablePicks } from '../extension/picks.js';
import { createDemoMatch } from '../extension/demo.js';
import { newJournal, record, backfill, logPicks, settle, summarize, mergeDuplicates } from '../extension/journal.js';

// Suit une map simulée entière comme le ferait le panneau.
function playMap(seed) {
  const demo = createDemoMatch(seed);
  const j = newJournal(), mem = { econ: {} }, st = {};
  const key = `m${seed}|map`;
  for (let i = 0; i < 5000; i++) {
    const { scoreboard } = demo.next();
    const m = toMatch(scoreboard, demo.meta(), mem);
    const res = analyze(m);
    const list = markets(res, m.names, m);
    const picks = stablePicks(st, { list, phase: m.phase, round: m.round, mapKey: key });
    record(j, { key, matchId: seed, m, res, hltv: { oriented: true, p1: res.pMap, ot: 0 }, scoreboard, meta: demo.meta() });
    logPicks(j, key, picks, { round: res.round, a: m.scoreA, b: m.scoreB });
    if (res.over) return { j, e: j.maps[key], m };
  }
  throw new Error('map non terminée');
}

test('journal : chaque round a son relevé de départ, son vainqueur et le score final', () => {
  const { j, e, m } = playMap(7);
  assert.deepEqual(e.final, { a: m.scoreA, b: m.scoreB, w: m.scoreA > m.scoreB ? 'A' : 'B' });
  const played = m.scoreA + m.scoreB;
  const rs = Object.entries(e.rounds);
  assert.equal(rs.filter(([, R]) => R.w).length, played);
  const withStart = rs.filter(([, R]) => R.start);
  assert.ok(withStart.length >= played - 1, `${withStart.length}/${played}`);
  for (const [, R] of withStart) {
    assert.ok(R.start.pr > 0 && R.start.pr < 1);
    assert.ok(R.start.sb && !R.start.sb.ctMatchHistory, 'scoreboard allégé');
    assert.ok(R.snaps.length >= 1 && R.snaps.length <= 24);
  }
  assert.ok(Object.keys(e.picks).length > 0, 'paris notés');
  assert.ok(JSON.stringify(j).length < 400_000, `taille ${JSON.stringify(j).length}`);
});

test('journal : bilan cohérent (brier, calibrage, paris réglés)', () => {
  const j = newJournal();
  for (const seed of [3, 7, 11]) Object.assign(j.maps, playMap(seed).j.maps);
  const sm = summarize(j);
  assert.equal(sm.maps, 3);
  assert.equal(sm.finished, 3);
  assert.ok(sm.rounds.n > 50);
  assert.ok(sm.rounds.brier > 0 && sm.rounds.brier < 0.3, `${sm.rounds.brier}`);
  assert.ok(sm.map.vsHltv.n > 0);
  assert.equal(sm.rounds.calibration.reduce((s, b) => s + b.n, 0), sm.rounds.n);
  assert.ok(sm.picks.lean.n > 10, `${sm.picks.lean.n}`);
  assert.ok(sm.picks.lean.won <= sm.picks.lean.n);
});

test('règlement des marchés', () => {
  const e = { final: { a: 13, b: 10, w: 'A' }, rounds: { 4: { w: 'B' } }, series: null };
  assert.equal(settle('map:A', e), true);
  assert.equal(settle('map:B', e), false);
  assert.equal(settle('round4:B', e), true);
  assert.equal(settle('round5:A', e), null);
  assert.equal(settle('tot22.5:O', e), true);
  assert.equal(settle('tot23.5:U', e), true);
  assert.equal(settle('hcp-2.5:A', e), true);
  assert.equal(settle('hcp-3.5:A', e), false);
  assert.equal(settle('hcp2.5:A', e), true);
  assert.equal(settle('hcp-2.5:B', e), !settle('hcp-2.5:A', e));
  assert.equal(settle('hcp-3.5:B', e), true);
  assert.equal(settle('ot:N', e), true);
  assert.equal(settle('series:A', e), null);
});

test('scores finaux et série complétés depuis la page', () => {
  const j = newJournal();
  j.maps['1|a'] = { matchId: 1, map: 'mirage', bestOf: 3, rounds: {}, picks: {}, final: null, series: null };
  j.maps['1|b'] = { matchId: 1, map: 'inferno', bestOf: 3, rounds: {}, picks: {}, final: null, series: null };
  backfill(j, 1, [{ name: 'Mirage', s1: 13, s2: 8 }, { name: 'Inferno', s1: 13, s2: 11 }, { name: 'Nuke', s1: null, s2: null }]);
  assert.deepEqual(j.maps['1|a'].final, { a: 13, b: 8, w: 'A' });
  assert.equal(j.maps['1|b'].final.w, 'A');
  assert.deepEqual(j.maps['1|a'].series, { a: 2, b: 0, w: 'A' });
});

test('paris VALUE : gain en unités à la cote saisie', () => {
  const j = newJournal();
  j.maps.k = { matchId: 1, rounds: {}, picks: {}, final: { a: 13, b: 5, w: 'A' } };
  logPicks(j, 'k', [{ id: 'map:A', kind: 'value', p: 0.6, odds: 2.0 }, { id: 'ot:Y', kind: 'value', p: 0.2, odds: 6 }]);
  const sm = summarize(j);
  assert.equal(sm.picks.value.n, 2);
  assert.equal(sm.picks.value.won, 1);
  assert.equal(sm.picks.value.units, 0); // +1 − 1
});

test('doublons des anciennes versions : une map enregistrée sous plusieurs clés est fusionnée', () => {
  const j = newJournal();
  j.maps['9|de_nuke|1'] = { matchId: 9, map: 'nuke', rounds: { 1: { w: 'A' } }, picks: { 'lean:map:A': { id: 'map:A' } }, final: null, started: 5 };
  j.maps['9|de_nuke|2'] = { matchId: 9, map: 'nuke', rounds: { 1: { w: 'A', start: { pr: 0.5 } }, 2: { w: 'B', start: { pr: 0.4 } } }, picks: {}, final: null, started: 7 };
  j.maps['9|de_nuke|3'] = { matchId: 9, map: 'nuke', rounds: { 2: { w: 'B' } }, picks: {}, final: { a: 13, b: 5, w: 'A' }, started: 9 };
  j.maps['9|de_inferno'] = { matchId: 9, map: 'inferno', rounds: {}, picks: {}, final: null };
  const { removed, changed } = mergeDuplicates(j);
  assert.deepEqual(Object.keys(j.maps).sort(), ['9|inferno', '9|nuke']);
  assert.equal(removed.length, 4);
  assert.deepEqual(changed.sort(), ['9|inferno', '9|nuke']);
  const e = j.maps['9|nuke'];
  assert.equal(e.rounds[1].start.pr, 0.5);
  assert.equal(e.rounds[2].w, 'B');
  assert.deepEqual(e.final, { a: 13, b: 5, w: 'A' });
  assert.ok(e.picks['lean:map:A']);
  assert.equal(e.started, 5);
  assert.deepEqual(mergeDuplicates(j), { removed: [], changed: [] }); // idempotent
});

test('début de round enregistré seulement une fois les achats reçus', () => {
  const j = newJournal();
  const m = (ready, buy) => ({ map: 'nuke', names: ['A', 'B'], phase: 'live', scoreA: 2, scoreB: 1, aSide: 'CT', aliveA: 5, aliveB: 5, econReady: ready, buyA: buy, buyB: 'full', rounds: [] });
  const res = (pr) => ({ round: 4, pRound: pr, pMap: 0.6 });
  record(j, { key: 'k', matchId: 1, m: m(false, 'eco'), res: res(0.2) });
  assert.equal(j.maps.k.rounds[4].start.ready, false);
  record(j, { key: 'k', matchId: 1, m: m(true, 'full'), res: res(0.5) });
  assert.equal(j.maps.k.rounds[4].start.pr, 0.5);
  record(j, { key: 'k', matchId: 1, m: m(true, 'full'), res: res(0.55) });
  assert.equal(j.maps.k.rounds[4].start.pr, 0.5); // figé une fois complet
});
