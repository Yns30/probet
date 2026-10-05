// Match simulé au format du scorebot HLTV : sert au mode démo et aux tests.
import { mapWinner, sideAt } from './engine.js';

const RIFLES = { CT: ['m4a1_silencer', 'm4a1', 'awp', 'famas'], T: ['ak47', 'ak47', 'awp', 'galilar'] };

export function createDemoMatch(seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const teams = [
    { name: 'Vitality', id: 9565, nicks: ['apEX', 'ZywOo', 'flameZ', 'mezii', 'ropz'], money: 800 },
    { name: 'Spirit', id: 7020, nicks: ['chopper', 'donk', 'sh1ro', 'zont1x', 'zweih'], money: 800 },
  ];
  const st = { score: [0, 0], round: 1, phase: 'freeze', tick: 0, alive: [5, 5], hp: [[], []], bomb: false, history: [[], []], maps: [], log: [] };
  const strength = 0.56;

  const sideOf = (team) => (team === 0 ? sideAt(st.round, 1, 'CT') : sideAt(st.round, 1, 'CT') === 'CT' ? 'T' : 'CT');

  const buy = (team) => {
    const pistol = st.round === 1 || st.round === 13;
    const m = teams[team].money;
    const kind = pistol ? 'pistol' : m >= 4000 ? 'full' : m >= 2500 ? 'force' : 'eco';
    const cost = { pistol: 650, full: 3800, force: 2300, eco: 300 }[kind];
    teams[team].money = Math.max(0, m - cost);
    teams[team].kind = kind;
  };

  const startRound = () => {
    if (st.round === 13) { teams[0].money = 800; teams[1].money = 800; }
    st.phase = 'freeze'; st.tick = 0; st.alive = [5, 5]; st.bomb = false;
    st.hp = [[100, 100, 100, 100, 100], [100, 100, 100, 100, 100]];
    buy(0); buy(1);
    st.log.unshift({ RoundStart: {} });
  };

  const endRound = (winner, winType) => {
    st.score[winner]++;
    const side = sideOf(winner);
    st.history[winner].push({ type: winType, roundOrdinal: st.round, survivingPlayers: st.alive[winner] });
    st.history[1 - winner].push({ type: 'lost', roundOrdinal: st.round, survivingPlayers: st.alive[1 - winner] });
    st.log.unshift({ RoundEnd: { winner: side === 'CT' ? 'CT' : 'TERRORIST', winType, counterTerroristScore: 0, terroristScore: 0 } });
    teams[winner].money = Math.min(16000, teams[winner].money + 3250);
    teams[1 - winner].money = Math.min(16000, teams[1 - winner].money + 1900 + 500 * Math.min(3, st.lossStreak?.[1 - winner] || 0));
    st.phase = 'over'; st.tick = 0;
  };

  function step() {
    st.tick++;
    if (st.phase === 'freeze') {
      if (st.tick >= 2) { st.phase = 'live'; st.tick = 0; }
    } else if (st.phase === 'live') {
      const tIdx = sideOf(0) === 'T' ? 0 : 1, ctIdx = 1 - tIdx;
      if (rnd() < 0.7) {
        const eq = (k) => ({ pistol: 0, eco: -0.25, force: -0.08, full: 0.1 }[teams[k].kind]);
        const pLeft = strength + eq(0) - eq(1) + 0.04 * (st.alive[0] - st.alive[1]);
        const victim = rnd() < pLeft ? 1 : 0;
        const idx = st.hp[victim].findIndex((h) => h > 0);
        if (idx >= 0) {
          st.hp[victim][idx] = 0; st.alive[victim]--;
          const killer = teams[1 - victim].nicks[Math.floor(rnd() * 5)];
          st.log.unshift({ Kill: { killerNick: killer, victimNick: teams[victim].nicks[idx], weapon: rnd() < 0.5 ? 'ak47' : 'm4a1_silencer', headShot: rnd() < 0.45 } });
        }
        const dmg = 1 - victim;
        const j = st.hp[dmg].findIndex((h) => h > 0);
        if (j >= 0) st.hp[dmg][j] = Math.max(1, st.hp[dmg][j] - Math.floor(rnd() * 60));
      }
      if (!st.bomb && st.alive[tIdx] > 0 && rnd() < 0.2) {
        st.bomb = true;
        st.log.unshift({ BombPlanted: { playerNick: teams[tIdx].nicks[0], tPlayers: st.alive[tIdx], ctPlayers: st.alive[ctIdx] } });
      }
      if (st.alive[ctIdx] === 0) endRound(tIdx, st.bomb ? 'Target_Bombed' : 'Terrorists_Win');
      else if (st.alive[tIdx] === 0) {
        if (st.bomb && rnd() < 0.4) endRound(tIdx, 'Target_Bombed');
        else endRound(ctIdx, st.bomb ? 'Bomb_Defused' : 'CTs_Win');
      } else if (st.tick > 9) endRound(st.bomb ? tIdx : ctIdx, st.bomb ? 'Target_Bombed' : 'CTs_Win');
    } else if (st.phase === 'over' && st.tick >= 2) {
      const [a, b] = st.score;
      if (mapWinner(a, b)) {
        st.maps.push({ name: 'Mirage', s1: a, s2: b });
        st.score = [0, 0]; st.history = [[], []]; st.round = 1;
        teams[0].money = 800; teams[1].money = 800;
      } else {
        st.round++;
      }
      startRound();
    }
  }

  const players = (team) => teams[team].nicks.map((nick, i) => ({
    nick, name: nick, alive: st.hp[team][i] > 0, hp: st.hp[team][i], money: Math.round(teams[team].money / 50) * 10,
    // Comme sur HLTV : pistolet de départ en eco, plus d'arme une fois mort.
    primaryWeapon: st.hp[team][i] <= 0 ? ''
      : { full: RIFLES[sideOf(team)][i % 4], force: 'galilar' }[teams[team].kind] || (sideOf(team) === 'CT' ? 'usp_silencer' : 'glock'),
    kevlar: teams[team].kind !== 'eco', helmet: teams[team].kind === 'full', hasDefuseKit: false,
    score: 0, deaths: 0, assists: 0, damagePrRound: 0,
  }));

  function scoreboard() {
    const ct = sideOf(0) === 'CT' ? 0 : 1, t = 1 - ct;
    const half = (team) => ({
      firstHalf: st.history[team].filter((r) => r.roundOrdinal <= 12),
      secondHalf: st.history[team].filter((r) => r.roundOrdinal > 12),
    });
    return {
      CT: players(ct), TERRORIST: players(t),
      ctMatchHistory: half(ct), terroristMatchHistory: half(t),
      bombPlanted: st.bomb, mapName: 'de_mirage',
      ctTeamName: teams[ct].name, terroristTeamName: teams[t].name,
      ctTeamId: teams[ct].id, tTeamId: teams[t].id,
      currentRound: st.round, counterTerroristScore: st.score[ct], terroristScore: st.score[t],
      frozen: st.phase === 'freeze', live: true,
    };
  }

  startRound();
  st.hp = [[100, 100, 100, 100, 100], [100, 100, 100, 100, 100]];

  return {
    meta: () => ({
      team1: { name: teams[0].name, id: teams[0].id },
      team2: { name: teams[1].name, id: teams[1].id },
      format: 'Best of 3 (LAN)', bestOf: 3,
      maps: [...st.maps, { name: 'Mirage', s1: st.score[0], s2: st.score[1] }],
      odds: [[1.62, 2.25], [1.65, 2.2]],
      hltvProb: null, hasScorebot: true,
    }),
    next() {
      step();
      const log = st.log.splice(0);
      return { scoreboard: scoreboard(), log };
    },
  };
}
