// Traduction des données de la page de match HLTV vers l'entrée du moteur.
// Module ES pur : utilisé par l'extension et par les tests Node.
//
// Sources :
//  - "scoreboard" : message JSON du scorebot HLTV (celui qui alimente le tableau live
//    de la page) : joueurs en vie, PV, argent, armes, historique des rounds, bombe…
//  - "log" : fil des événements (kills, bombe, fin de round).
//  - meta : éléments lus dans le DOM de la page (équipes, format, maps, cotes).
import { sideAt, nextHist, normalizeMap, mapWinner, mapProbFromSeries } from './engine.js';

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
  return weaponPrice(p.primaryWeapon) + (p.helmet ? 1000 : p.kevlar ? 650 : 0) + (p.hasDefuseKit ? 400 : 0);
}

// Type d'achat d'une équipe d'après l'équipement porté.
export function buyType(players) {
  if (!players?.length) return null;
  const avg = players.reduce((s, p) => s + equipValue(p), 0) / players.length;
  if (avg < 900) return 'eco';
  if (avg < 2600) return 'force';
  if (avg < 3500) return 'half';
  return 'full';
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
  else if (played >= current) phase = 'round_over';
  else if (sb.frozen) phase = 'freezetime';
  else if (sb.bombPlanted) phase = 'bomb_planted';
  else phase = 'live';

  const aliveA = pA.filter((p) => p.alive).length;
  const aliveB = pB.filter((p) => p.alive).length;
  const live = phase === 'live' || phase === 'bomb_planted' || phase === 'freezetime';
  const nextRound = phase === 'round_over';

  // Achat du round : figé à la fin du temps d'achat (les morts perdent leur arme ensuite).
  let buyA = null, buyB = null;
  if (live) {
    const lock = mem.econ?.[current];
    if (phase === 'freezetime' || !lock) {
      buyA = buyType(pA); buyB = buyType(pB);
      if (mem.econ && buyA && buyB) mem.econ[current] = { A: buyA, B: buyB };
    } else {
      buyA = lock.A; buyB = lock.B;
    }
  } else if (nextRound) {
    buyA = predictBuy(pA); buyB = predictBuy(pB);
  }

  const { mapsA, mapsB, mapNumber } = seriesState(meta.maps, sb.mapName);
  const bestOf = meta.bestOf || 1;
  const pSeries = meta.prematchOverride ?? oddsToProb(meta.odds);

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
    timer: null, buyA, buyB, nextBuy: nextRound,
    rounds, hist, bestOf, mapsA, mapsB, mapNumber,
    prematchSeries: pSeries,
    prematchMapProb: pSeries != null ? mapProbFromSeries(pSeries, bestOf) : null,
    players: { A: pA, B: pB },
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
