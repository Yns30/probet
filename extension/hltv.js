// Traduction des données de la page de match HLTV vers l'entrée du moteur.
// Module ES pur : utilisé par l'extension et par les tests Node.
//
// Sources :
//  - "scoreboard" : message JSON du scorebot HLTV (celui qui alimente le tableau live
//    de la page) : joueurs en vie, PV, argent, armes, historique des rounds, bombe…
//  - "log" : fil des événements (kills, bombe, fin de round).
//  - meta : éléments lus dans le DOM de la page (équipes, format, maps, cotes).
import { sideAt, nextHist, normalizeMap, mapWinner, mapProbFromSeries, priorD, sig, logit } from './engine.js';

// ---------- Extraction des messages du scorebot ----------

// Fin du tableau/objet JSON qui commence à `start` (gère chaînes et échappements).
function matchBracket(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const looksLikeScoreboard = (o) => o && typeof o === 'object'
  && ('counterTerroristScore' in o || 'ctTeamName' in o) && ('CT' in o || 'TERRORIST' in o);

function findScoreboard(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return null;
  if (looksLikeScoreboard(o)) return o;
  for (const v of Object.values(o)) {
    const f = findScoreboard(v, depth + 1);
    if (f) return f;
  }
  return null;
}

// Accepte n'importe quel format de trame socket.io (websocket ou polling) et
// retourne les événements reconnus : [{ event: 'scoreboard'|'log'|'fullLog', data }].
export function extractEvents(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  const re = /\[\s*"(scoreboard|log|fullLog)"\s*,/g;
  let m;
  while ((m = re.exec(text))) {
    const end = matchBracket(text, m.index);
    if (end < 0) break;
    try {
      const arr = JSON.parse(text.slice(m.index, end + 1));
      let data = arr[1];
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* texte brut */ } }
      out.push({ event: arr[0], data });
    } catch { /* trame partielle */ }
    re.lastIndex = end + 1;
  }
  if (!out.length && text.includes('counterTerroristScore')) {
    const i = text.indexOf('{');
    const end = i >= 0 ? matchBracket(text, i) : -1;
    if (end > 0) {
      try {
        const sb = findScoreboard(JSON.parse(text.slice(i, end + 1)));
        if (sb) out.push({ event: 'scoreboard', data: sb });
      } catch { /* ignoré */ }
    }
  }
  return out;
}

// ---------- Économie ----------

const PRICES = {
  ak47: 2700, m4a1: 3100, m4a1silencer: 2900, m4a4: 3100, awp: 4750, famas: 2050, galilar: 1800,
  galil: 1800, sg556: 3000, sg553: 3000, aug: 3300, ssg08: 1700, scar20: 5000, g3sg1: 5000,
  mp9: 1250, mac10: 1050, mp7: 1500, mp5sd: 1500, ump45: 1200, p90: 2350, bizon: 1400,
  nova: 1050, xm1014: 2000, mag7: 1300, sawedoff: 1100, negev: 1700, m249: 5200,
};
const normWeapon = (w) => String(w || '').toLowerCase().replace(/^weapon_/, '').replace(/[^a-z0-9]/g, '');
export const weaponPrice = (w) => PRICES[normWeapon(w)] ?? 0;

export function equipValue(p) {
  if (Number.isFinite(p.equipmentValue)) return p.equipmentValue; // valeur fournie par HLTV
  const gun = weaponPrice(p.primaryWeapon);
  // + grenades estimées quand le joueur a acheté une arme principale
  return gun + (gun ? 400 : 0) + (p.helmet ? 1000 : p.kevlar ? 650 : 0) + (p.hasDefuseKit || p.hasDefusekit ? 400 : 0);
}

// Type d'achat d'une équipe d'après l'équipement porté.
export function buyFromValue(avg) {
  if (avg < 1500) return 'eco';
  if (avg < 3000) return 'force';
  if (avg < 3800) return 'half';
  return 'full';
}

export function buyType(players) {
  if (!players?.length) return null;
  return buyFromValue(players.reduce((s, p) => s + equipValue(p), 0) / players.length);
}

// Achat probable au round suivant (argent disponible + armes gardées par les survivants).
export function predictBuy(players) {
  if (!players?.length) return null;
  const avg = players.reduce((s, p) => s + (p.money || 0) + (p.alive ? weaponPrice(p.primaryWeapon) : 0), 0) / players.length;
  if (avg >= 4200) return 'full';
  if (avg >= 2900) return 'half';
  if (avg >= 1900) return 'force';
  return 'eco';
}

// Achat probable au round suivant selon l'issue du round en cours :
// argent + équipement gardé par les survivants + prime (victoire 3 250 $, défaite selon la série).
const lossBonus = (streak) => Math.min(1400 + 500 * Math.max(0, streak - 1), 3400);
export function buyFromFunds(avg) {
  if (avg >= 4700) return 'full';
  if (avg >= 3300) return 'half';
  if (avg >= 2200) return 'force';
  return 'eco';
}
export function lossStreak(rounds, team) {
  let k = 0;
  for (let i = rounds.length - 1; i >= 0 && rounds[i].winner !== team; i--) k++;
  return k;
}
export function nextBuys(pA, pB, rounds, nextRound) {
  if (nextRound === 13 || (nextRound > 24 && (nextRound - 25) % 6 === 0)) return null; // remise à zéro
  const funds = (players, won, streak) => players.reduce((t, p) => t + (p.money || 0)
    + (p.alive ? (Number.isFinite(p.equipmentValue) ? p.equipmentValue : equipValue(p)) : 0)
    + (won ? 3250 : lossBonus(streak + 1)), 0) / Math.max(1, players.length);
  const sA = lossStreak(rounds, 'A'), sB = lossStreak(rounds, 'B');
  return {
    A: { A: buyFromFunds(funds(pA, true, sA)), B: buyFromFunds(funds(pB, false, sB)) },
    B: { A: buyFromFunds(funds(pA, false, sA)), B: buyFromFunds(funds(pB, true, sB)) },
  };
}

// ---------- Méta-données de la page ----------

const norm = (s) => (s ? String(s).toLowerCase().replace(/[^a-z0-9]/g, '') : '');
const same = (x, y) => {
  const a = norm(x), b = norm(y);
  return Boolean(a && b && (a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)))));
};

export function bestOfFrom(text) {
  const m = /best of (\d)/i.exec(text || '');
  return m ? Number(m[1]) : null;
}

// maps : [{ name, s1, s2 }] (s1 = score de l'équipe 1 de la page)
export function seriesState(maps, liveMap) {
  let mapsA = 0, mapsB = 0;
  for (const mp of maps || []) {
    if (!Number.isInteger(mp.s1) || !Number.isInteger(mp.s2)) continue;
    if (liveMap && normalizeMap(mp.name) === normalizeMap(liveMap) && !mapWinner(mp.s1, mp.s2)) continue;
    const w = mapWinner(mp.s1, mp.s2);
    if (w === 'A') mapsA++;
    else if (w === 'B') mapsB++;
  }
  return { mapsA, mapsB, mapNumber: mapsA + mapsB + 1 };
}

// Cotes de vainqueur du match (plusieurs bookmakers) → probabilité équipe 1, marge retirée.
export function oddsToProb(rows) {
  const ps = (rows || [])
    .filter(([a, b]) => a > 1 && b > 1)
    .map(([a, b]) => (1 / a) / (1 / a + 1 / b));
  if (!ps.length) return null;
  return ps.reduce((s, p) => s + p, 0) / ps.length;
}

// ---------- Force d'avant-match (données de la page) ----------

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// Taux de victoire sur une map, rétréci vers 50 % selon le nombre de maps jouées.
const shrunk = (w, n) => (w != null && n ? logit(clamp((w * n + 0.5 * 6) / (n + 6), 0.05, 0.95)) : null);

// Probabilité que l'équipe 1 gagne la série / la map en cours, avant les rounds joués.
// Sources, par ordre de fiabilité : cotes des bookmakers, points VRS (sinon classement HLTV),
// ratings des joueurs sur 3 mois, puis ajustement selon les stats de la map jouée.
export function pagePrior(meta = {}, mapName, bestOf = 1) {
  const t1 = meta.team1 || {}, t2 = meta.team2 || {};
  const parts = [], sources = [];
  if (t1.vrs && t2.vrs) {
    const x = (t1.vrs - t2.vrs) / 800 * Math.LN10;
    parts.push({ x, w: 1 });
    sources.push(`Points VRS : ${t1.vrs} contre ${t2.vrs}`);
  } else if (t1.rank && t2.rank) {
    parts.push({ x: 0.6 * Math.log(t2.rank / t1.rank), w: 1 });
    sources.push(`Classement HLTV : #${t1.rank} contre #${t2.rank}`);
  }
  if (t1.rating && t2.rating) {
    parts.push({ x: clamp((t1.rating - t2.rating) * 3, -0.6, 0.6), w: 0.35 });
    sources.push(`Rating moyen 3 mois : ${t1.rating.toFixed(2)} contre ${t2.rating.toFixed(2)}`);
  }
  const pOdds = meta.prematchOverride ?? oddsToProb(meta.odds);
  let xSeries = null;
  if (parts.length) xSeries = parts.reduce((t, p) => t + p.x * p.w, 0) / parts.reduce((t, p) => t + p.w, 0);
  if (pOdds != null) {
    const xo = logit(clamp(pOdds, 0.02, 0.98));
    xSeries = xSeries == null ? xo : 0.75 * xo + 0.25 * xSeries;
    sources.unshift(meta.prematchOverride != null ? 'Vos cotes d’avant-match' : `Cotes des bookmakers (${meta.odds.length})`);
  }
  if (xSeries == null) return null;
  const pSeries = sig(xSeries);
  let xMap = logit(clamp(bestOf > 1 ? mapProbFromSeries(pSeries, bestOf) : pSeries, 0.02, 0.98));
  const ms = meta.mapStats?.[normalizeMap(mapName)];
  if (ms) {
    const a = shrunk(ms.w1, ms.n1), b = shrunk(ms.w2, ms.n2);
    if (a != null && b != null) {
      xMap += 0.5 * (a - b);
      sources.push(`${normalizeMap(mapName)} sur 3 mois : ${Math.round(ms.w1 * 100)} % (${ms.n1} maps) contre ${Math.round(ms.w2 * 100)} % (${ms.n2} maps)`);
    }
  }
  return { pSeries, pMap: sig(xMap), sources, fromOdds: pOdds != null };
}

// Rounds des maps déjà terminées de la série, mi-temps par mi-temps (côté connu).
export function seriesObs(maps, liveMap) {
  const out = [];
  for (const mp of maps || []) {
    if (!mapWinner(mp.s1 ?? 0, mp.s2 ?? 0)) continue;
    if (liveMap && normalizeMap(mp.name) === normalizeMap(liveMap) && !mp.halves?.length) continue;
    for (const h of mp.halves || []) {
      const n = h.s1 + h.s2;
      if (n > 0 && (h.side1 === 'CT' || h.side1 === 'T')) {
        out.push({ wins: h.s1, n, aSide: h.side1, map: normalizeMap(mp.name), weight: 0.6 });
      }
    }
  }
  return out;
}

// ---------- Scoreboard → entrée du moteur ----------

// L'équipe actuellement CT est-elle l'équipe 1 de la page (= "A") ?
export function ctIsTeam1(sb, meta) {
  const t1 = meta?.team1 || {}, t2 = meta?.team2 || {};
  if (t1.id && sb.ctTeamId === t1.id) return true;
  if (t1.id && sb.tTeamId === t1.id) return false;
  if (t2.id && sb.ctTeamId === t2.id) return false;
  if (t2.id && sb.tTeamId === t2.id) return true;
  if (same(sb.ctTeamName, t1.name) || same(sb.terroristTeamName, t2.name)) return true;
  if (same(sb.terroristTeamName, t1.name) || same(sb.ctTeamName, t2.name)) return false;
  return true;
}

function winnersByRound(sb, ctTeam, tTeam) {
  const w = new Map();
  const add = (hist, team) => {
    for (const half of ['firstHalf', 'secondHalf']) {
      for (const r of hist?.[half] || []) {
        if (r && r.type && r.type !== 'lost' && Number.isInteger(r.roundOrdinal)) w.set(r.roundOrdinal, team);
      }
    }
  };
  add(sb.ctMatchHistory, ctTeam);
  add(sb.terroristMatchHistory, tTeam);
  return w;
}

const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

// sb : scoreboard ; meta : DOM ; mem : mémoire persistante du panneau (achats par round)
export function toMatch(sb, meta = {}, mem = {}) {
  const ctA = ctIsTeam1(sb, meta);
  const aSide = ctA ? 'CT' : 'T';
  const pA = (ctA ? sb.CT : sb.TERRORIST) || [];
  const pB = (ctA ? sb.TERRORIST : sb.CT) || [];
  const scoreA = (ctA ? sb.counterTerroristScore : sb.terroristScore) ?? 0;
  const scoreB = (ctA ? sb.terroristScore : sb.counterTerroristScore) ?? 0;
  const played = scoreA + scoreB;
  const current = Number.isInteger(sb.currentRound) && sb.currentRound > 0 ? sb.currentRound : played + 1;

  // Historique : vainqueur et côté de chaque round.
  const winners = winnersByRound(sb, ctA ? 'A' : 'B', ctA ? 'B' : 'A');
  let rounds = [];
  let complete = true;
  for (let r = 1; r <= played; r++) {
    const w = winners.get(r);
    if (!w) { complete = false; break; }
    rounds.push({ r, winner: w, aSide: sideAt(r, current, aSide), econ: mem.econ?.[r] || null });
  }
  let hist = {};
  if (complete && rounds.filter((o) => o.winner === 'A').length === scoreA) {
    for (const o of rounds) { o.hist = { ...hist }; hist = nextHist(o.r, hist, o.winner); }
  } else {
    // Historique incomplet : on garde le décompte, sans les côtés.
    rounds = [];
    for (let i = 0; i < scoreA; i++) rounds.push({ r: rounds.length + 1, winner: 'A', aSide: null, synthetic: true });
    for (let i = 0; i < scoreB; i++) rounds.push({ r: rounds.length + 1, winner: 'B', aSide: null, synthetic: true });
    hist = {};
  }

  let phase;
  if (sb.live === false) phase = 'not_live';
  else if (mapWinner(scoreA, scoreB)) phase = 'map_over';
  else if (played >= current || /over|end/i.test(sb.currentRoundState || '')) phase = 'round_over';
  else if (sb.frozen || /freeze/i.test(sb.currentRoundState || '')) phase = 'freezetime';
  else if (sb.bombPlanted) phase = 'bomb_planted';
  else phase = 'live';

  const aliveA = pA.filter((p) => p.alive).length;
  const aliveB = pB.filter((p) => p.alive).length;
  const live = phase === 'live' || phase === 'bomb_planted' || phase === 'freezetime';
  const nextRound = phase === 'round_over';

  // Achat du round : figé au temps d'achat. Si le panneau arrive en cours de round, on ne
  // regarde que les survivants (les morts ont perdu leur arme).
  let buyA = null, buyB = null;
  const initA = ctA ? sb.ctInitialEquipmentValue : sb.tInitialEquipmentValue;
  const initB = ctA ? sb.tInitialEquipmentValue : sb.ctInitialEquipmentValue;
  if (live && Number.isFinite(initA) && Number.isFinite(initB) && initA + initB > 0 && phase !== 'freezetime') {
    // Valeur d'équipement officielle au début du round (scorebot HLTV).
    buyA = buyFromValue(initA / Math.max(1, pA.length || 5));
    buyB = buyFromValue(initB / Math.max(1, pB.length || 5));
    if (mem.econ) mem.econ[current] = { A: buyA, B: buyB, final: true };
  } else if (live) {
    const lock = mem.econ?.[current];
    if (phase === 'freezetime' || !lock || !lock.final) {
      const frozen = phase === 'freezetime';
      const aA = frozen ? pA : pA.filter((p) => p.alive), aB = frozen ? pB : pB.filter((p) => p.alive);
      buyA = buyType(aA) ?? lock?.A ?? null;
      buyB = buyType(aB) ?? lock?.B ?? null;
      if (mem.econ && buyA && buyB && (!lock || frozen)) mem.econ[current] = { A: buyA, B: buyB, final: frozen };
      else if (lock && !frozen) { buyA = lock.A; buyB = lock.B; }
    } else {
      buyA = lock.A; buyB = lock.B;
    }
  } else if (nextRound) {
    buyA = predictBuy(pA); buyB = predictBuy(pB);
  }

  const { mapsA, mapsB, mapNumber } = seriesState(meta.maps, sb.mapName);
  const bestOf = meta.bestOf || 1;
  const pre = pagePrior(meta, sb.mapName, bestOf);
  const prior = pre ? { ...priorD(pre.pMap, sb.mapName), sd: pre.fromOdds ? 0.3 : 0.38 } : null;

  return {
    map: normalizeMap(sb.mapName) || (sb.mapName ? String(sb.mapName).replace(/^de_/, '') : null),
    names: [meta.team1?.name || (ctA ? sb.ctTeamName : sb.terroristTeamName) || 'Équipe A',
      meta.team2?.name || (ctA ? sb.terroristTeamName : sb.ctTeamName) || 'Équipe B'],
    scoreA, scoreB, aSide, phase, round: current,
    aliveA: live ? aliveA : null, aliveB: live ? aliveB : null,
    hpA: live ? sum(pA.filter((p) => p.alive), (p) => p.hp || 0) : null,
    hpB: live ? sum(pB.filter((p) => p.alive), (p) => p.hp || 0) : null,
    moneyA: sum(pA, (p) => p.money || 0), moneyB: sum(pB, (p) => p.money || 0),
    bombPlanted: Boolean(sb.bombPlanted),
    timer: phase !== 'live' ? null
      : Number.isFinite(sb.roundTimeRemainingMS) ? Math.round(sb.roundTimeRemainingMS / 1000)
        : Number.isInteger(meta.timer) ? meta.timer : null,
    equipA: Number.isFinite(initA) ? initA : null, equipB: Number.isFinite(initB) ? initB : null,
    facts: [...(sb.matchFacts || []), ...(sb.ctTeamFacts || []), ...(sb.tTeamFacts || [])]
      .map((f) => (typeof f === 'string' ? f : f?.text || f?.description || null)).filter(Boolean),
    buyA, buyB, nextBuy: nextRound,
    rounds, hist, bestOf, mapsA, mapsB, mapNumber,
    pre, prior, seriesObs: seriesObs(meta.maps, sb.mapName),
    nextEcon: live && !rounds.some((o) => o.synthetic) ? nextBuys(pA, pB, rounds, current + 1) : null,
    players: { A: pA, B: pB }, playersA: live ? pA : null, playersB: live ? pB : null,
  };
}

// ---------- Fil des événements ----------

const SIDE = { CT: 'CT', TERRORIST: 'T' };

export function describeLog(entry) {
  const [type, d] = Object.entries(entry || {})[0] || [];
  if (!type || !d) return null;
  switch (type) {
    case 'Kill':
      return `${d.killerNick} ➜ ${d.victimNick} (${normWeapon(d.weapon) || '?'}${d.headShot ? ', HS' : ''})`;
    case 'BombPlanted':
      return `Bombe posée par ${d.playerNick} (${d.tPlayers}v${d.ctPlayers})`;
    case 'BombDefused':
      return `Bombe désamorcée par ${d.playerNick}`;
    case 'RoundEnd':
      return `Fin du round — victoire ${SIDE[d.winner] || d.winner} (${String(d.winType || '').replace(/_/g, ' ')})`;
    case 'RoundStart':
      return 'Début du round';
    case 'MatchStarted':
      return `Début de la map ${d.map || ''}`.trim();
    case 'Suicide':
      return `${d.playerNick} s'est suicidé`;
    default:
      return null;
  }
}
