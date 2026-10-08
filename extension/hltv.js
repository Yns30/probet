// Traduction des données de la page de match HLTV vers l'entrée du moteur.
// Module ES pur : utilisé par l'extension et par les tests Node.
//
// Sources :
//  - "scoreboard" : message JSON du scorebot HLTV (celui qui alimente le tableau live
//    de la page) : joueurs en vie, PV, argent, armes, historique des rounds, bombe…
//  - "log" : fil des événements (kills, bombe, fin de round).
//  - meta : éléments lus dans le DOM de la page (équipes, format, maps, cotes).
import { sideAt, nextHist, normalizeMap, mapWinner, mapProbFromSeries, priorD, sig, logit, CAL } from './engine.js';

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

// Début de round : joueurs dont l'équipement est déjà arrivé (un joueur a toujours au moins
// un pistolet ; 0 signifie « pas encore reçu »).
const hasGear = (p) => p.equipmentValue > 0 || Boolean(p.primaryWeapon);
const loaded = (ps) => ps.filter(hasGear).length;
const teamValue = (ps) => ps.reduce((s, p) => s + (hasGear(p) ? equipValue(p) : 0), 0);
const aliveOf5 = (ps) => ps.length >= 5 && ps.every((p) => p.alive !== false);

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

// ---------- Niveau des joueurs ----------

// Rating du joueur sur la map en cours (approximation du rating HLTV 2.0) à partir des
// stats avancées du scorebot : kills, morts, assists, KAST, ADR.
export function matchRating(p, rounds) {
  if (!rounds || rounds < 1 || p.score == null || p.deaths == null) return null;
  const kpr = (p.score || 0) / rounds, dpr = (p.deaths || 0) / rounds, apr = (p.assists || 0) / rounds;
  const kast = Math.min(1, (p.advancedStats?.kast ?? rounds * 0.7) / rounds);
  const adr = p.damagePrRound ?? 70;
  const impact = 2.13 * kpr + 0.42 * apr - 0.41;
  return 0.73 * kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587;
}

// Facteur de niveau (≈ 0,85 à 1,15) : rating 3 mois de la page, ajusté par la forme du jour.
export function formFactor(p, rounds, ratings = {}) {
  const base = ratings[p.dbId] ?? 1;
  const today = matchRating(p, rounds);
  const r = today == null ? base : (base * 12 + today * rounds) / (12 + rounds);
  return Math.max(0.85, Math.min(1.15, 1 + 0.3 * (r - 1)));
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
// Numéro de la map en cours : sa place dans la liste des maps du match (connue dès le veto).
// Les scores des maps finies ne sont pas mis à jour par HLTV sans recharger la page : les
// compter donnait « map 1 » pendant les maps 2 et 3. unknown : maps déjà jouées dont le
// vainqueur n'est pas (encore) affiché.
export function seriesState(maps, liveMap) {
  let mapsA = 0, mapsB = 0;
  // Même nom plusieurs fois (démo) : la première non terminée, sinon la dernière.
  const same = (maps || []).map((mp, i) => [mp, i]).filter(([mp]) => liveMap && normalizeMap(mp.name) === normalizeMap(liveMap));
  const open = same.find(([mp]) => !(Number.isInteger(mp.s1) && Number.isInteger(mp.s2) && mapWinner(mp.s1, mp.s2)));
  const idx = (open ?? same[same.length - 1])?.[1] ?? -1;
  for (const [i, mp] of (maps || []).entries()) {
    if (idx >= 0 && i > idx) break;
    if (!Number.isInteger(mp.s1) || !Number.isInteger(mp.s2)) continue;
    // Map affichée par le scorebot : comptée seulement une fois terminée.
    if ((i === idx || idx < 0) && liveMap && normalizeMap(mp.name) === normalizeMap(liveMap) && !mapWinner(mp.s1, mp.s2)) continue;
    const w = mapWinner(mp.s1, mp.s2);
    if (w === 'A') mapsA++;
    else if (w === 'B') mapsB++;
  }
  const mapNumber = idx >= 0 ? idx + 1 : mapsA + mapsB + 1;
  const done = idx >= 0 && mapWinner(maps[idx].s1, maps[idx].s2) ? 1 : 0;
  return { mapsA, mapsB, mapNumber, unknown: Math.max(0, mapNumber - 1 + done - mapsA - mapsB) };
}

// Flux du scorebot qui ne correspond pas au match de la page (cas réel FaZe - Sangal : Inferno,
// équipes « CT » / « Terrorist », alors que les maps du match sont Dust2, Nuke, Cache).
// Renvoie la raison, ou null si tout est cohérent.
const GENERIC = /^(ct|t|terrorists?|counter[- ]?terrorists?)$/i;
export function feedProblem(sb, meta = {}) {
  if (!sb) return null;
  if (GENERIC.test(String(sb.ctTeamName || '').trim()) && GENERIC.test(String(sb.terroristTeamName || '').trim())) return 'teams';
  // Nom simplifié (toutes les maps, y compris celles hors du pool connu du modèle, comme Cache).
  const key = (n) => { const k = String(n || '').toLowerCase().replace(/^de_/, '').replace(/[^a-z0-9]/g, ''); return k === 'dust' ? 'dust2' : k; };
  const names = (meta.maps || []).map((mp) => key(mp.name)).filter((k) => k && k !== 'tba');
  if (sb.mapName && names.length > 0 && names.length >= (meta.bestOf || 1) && !names.includes(key(sb.mapName))) return 'map';
  return null;
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
const shrunk = (w, n) => (w != null && n ? logit(clamp((w * n + 0.5 * 6) / (n + 6), 0.05, 0.95)) : 0); // inconnu → 50 %

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
  // Face-à-face et forme : signaux plus bruités (effectifs qui changent), poids faibles.
  const h = meta.h2h;
  if (h && h.w1 + h.w2 >= 3) {
    parts.push({ x: logit((h.w1 + 5) / (h.w1 + h.w2 + 10)), w: 0.25 });
    sources.push(`Face-à-face : ${h.w1}-${h.w2}`);
  }
  const f1 = t1.form, f2 = t2.form;
  if (f1 && f2 && f1.won + f1.lost >= 3 && f2.won + f2.lost >= 3) {
    const rate = (f) => (f.won + 3) / (f.won + f.lost + 6);
    parts.push({ x: logit(rate(f1)) - logit(rate(f2)), w: 0.2 });
    sources.push(`Forme 3 mois : ${f1.won}V-${f1.lost}D contre ${f2.won}V-${f2.lost}D`);
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
    if (a !== 0 || b !== 0) {
      // Poids recalé sur les journaux (31 maps) : 0,5 → 0,75.
      xMap += 0.75 * (a - b);
      sources.push(`${normalizeMap(mapName)} sur 3 mois : ${ms.w1 != null ? Math.round(ms.w1 * 100) + ' %' : '—'} (${ms.n1 || 0} maps) contre ${ms.w2 != null ? Math.round(ms.w2 * 100) + ' %' : '—'} (${ms.n2 || 0} maps)`);
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
        out.push({ wins: h.s1, n, aSide: h.side1, map: normalizeMap(mp.name) });
      }
    }
  }
  return out;
}

// ---------- Scoreboard → entrée du moteur ----------

// L'équipe actuellement CT est-elle l'équipe 1 de la page (= "A") ?
// Côté de l'équipe 1 d'après ses joueurs (identifiants des compositions de la page).
export function ctIsTeam1ByPlayers(sb, meta) {
  const l = meta?.lineups;
  if (!l?.team1?.length || !l?.team2?.length) return null;
  const in1 = new Set(l.team1.map(Number)), in2 = new Set(l.team2.map(Number));
  let vote = 0;
  for (const p of sb.CT || []) vote += in1.has(Number(p.dbId)) ? 1 : in2.has(Number(p.dbId)) ? -1 : 0;
  for (const p of sb.TERRORIST || []) vote += in2.has(Number(p.dbId)) ? 1 : in1.has(Number(p.dbId)) ? -1 : 0;
  return vote >= 3 ? true : vote <= -3 ? false : null;
}

export function ctIsTeam1(sb, meta) {
  const byPlayers = ctIsTeam1ByPlayers(sb, meta);
  if (byPlayers != null) return byPlayers;
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
  let scoreA = (ctA ? sb.counterTerroristScore : sb.terroristScore) ?? 0;
  let scoreB = (ctA ? sb.terroristScore : sb.counterTerroristScore) ?? 0;
  // Au changement de côté, HLTV peut envoyer une trame où les équipes ont changé de côté mais
  // pas encore les scores (ou l'inverse). Le score d'une équipe ne baisse jamais et un seul
  // round se joue à la fois : si la trame contredit le dernier score connu et que le score
  // inversé est cohérent, on le remet dans le bon sens.
  const prevScore = mem.lastScore;
  if (prevScore && scoreA !== scoreB) {
    const fits = (a, b) => a >= prevScore.a && b >= prevScore.b && a + b - prevScore.a - prevScore.b <= 1;
    if (!fits(scoreA, scoreB) && fits(scoreB, scoreA)) [scoreA, scoreB] = [scoreB, scoreA];
  }
  const played = scoreA + scoreB;
  const withForm = (list) => (list || []).map((p) => ({ ...p, form: formFactor(p, played, meta.playerRatings), rating: matchRating(p, played) }));
  const pA = withForm(ctA ? sb.CT : sb.TERRORIST);
  const pB = withForm(ctA ? sb.TERRORIST : sb.CT);
  const current = Number.isInteger(sb.currentRound) && sb.currentRound > 0 ? sb.currentRound : played + 1;

  // Historique : vainqueur et côté de chaque round.
  const winners = winnersByRound(sb, ctA ? 'A' : 'B', ctA ? 'B' : 'A');
  // Historique HLTV parfois incomplet : on complète avec les changements de score observés
  // en direct (score 5-2 → 6-2 : A a gagné le round 8).
  const prev = mem.lastScore;
  if (mem.econ) mem.lastScore = { a: scoreA, b: scoreB };
  if (mem.winners) {
    if (prev && played === prev.a + prev.b + 1) mem.winners[played] = scoreA > prev.a ? 'A' : 'B';
    for (const [r, w] of Object.entries(mem.winners)) if (!winners.has(+r) && +r <= played) winners.set(+r, w);
  }
  let rounds = [];
  let complete = true;
  for (let r = 1; r <= played; r++) {
    const w = winners.get(r);
    if (!w) { complete = false; break; }
    const ec = mem.econ?.[r];
    rounds.push({ r, winner: w, aSide: sideAt(r, current, aSide), econ: ec?.A ? { A: ec.A, B: ec.B } : null });
  }
  let hist = {};
  if (complete && rounds.filter((o) => o.winner === 'A').length === scoreA) {
    let prev;
    for (const o of rounds) { o.hist = { ...hist }; o.last = prev; hist = nextHist(o.r, hist, o.winner); prev = o.winner; }
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

  // Achat du round. Au début du round, HLTV envoie l'équipement joueur par joueur pendant
  // 1 à 3 secondes : on cumule le maximum vu par équipe tant que personne n'est mort, et
  // l'achat n'est considéré comme connu qu'une fois au moins 4 joueurs par équipe chargés
  // (ou, si le panneau arrive en cours de round, quand la valeur officielle est là).
  let buyA = null, buyB = null, econReady = false;
  const initA = ctA ? sb.ctInitialEquipmentValue : sb.tInitialEquipmentValue;
  const initB = ctA ? sb.tInitialEquipmentValue : sb.ctInitialEquipmentValue;
  if (phase === 'freezetime') {
    buyA = buyType(pA); buyB = buyType(pB);
  } else if (phase === 'live' || phase === 'bomb_planted') {
    const e = mem.econ ? (mem.econ[current] ??= { eA: 0, eB: 0, kA: 0, kB: 0 }) : { eA: 0, eB: 0, kA: 0, kB: 0 };
    const opening = aliveOf5(pA) && aliveOf5(pB) && !sb.bombPlanted;
    if (opening) {
      e.eA = Math.max(e.eA, teamValue(pA)); e.eB = Math.max(e.eB, teamValue(pB));
      e.kA = Math.max(e.kA, loaded(pA)); e.kB = Math.max(e.kB, loaded(pB));
    }
    if (Number.isFinite(initA) && initA > 0) e.eA = Math.max(e.eA, initA);
    if (Number.isFinite(initB) && initB > 0) e.eB = Math.max(e.eB, initB);
    // Après le premier kill (plusieurs secondes de jeu), la valeur officielle est complète.
    if (!e.A && ((e.kA >= 4 && e.kB >= 4) || (!opening && initA > 0 && initB > 0))) {
      e.A = buyFromValue(e.eA / Math.max(1, pA.length || 5));
      e.B = buyFromValue(e.eB / Math.max(1, pB.length || 5));
      e.final = true;
    }
    if (!e.A && !opening) {
      // Arrivé en cours de round sans valeur officielle : armes des survivants (estimation).
      e.A = buyType(pA.filter((p) => p.alive)); e.B = buyType(pB.filter((p) => p.alive));
      e.final = false;
    }
    if (e.A && e.B) { buyA = e.A; buyB = e.B; econReady = e.final; }
  } else if (nextRound) {
    buyA = predictBuy(pA); buyB = predictBuy(pB);
  }

  const { mapsA, mapsB, mapNumber, unknown: mapsUnknown } = seriesState(meta.maps, sb.mapName);
  const bestOf = meta.bestOf || 1;
  const pre = pagePrior(meta, sb.mapName, bestOf);
  const prior = pre ? { ...priorD(pre.pMap, sb.mapName), sd: pre.fromOdds ? CAL.priorSdOdds : CAL.priorSdPage } : null;

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
    // Bombe posée : le chrono du scorebot devient le compte à rebours de la bombe (40 s).
    bombTimer: phase === 'bomb_planted' && Number.isFinite(sb.roundTimeRemainingMS) ? sb.roundTimeRemainingMS / 1000 : null,
    equipA: mem.econ?.[current]?.eA || (Number.isFinite(initA) ? initA : null),
    equipB: mem.econ?.[current]?.eB || (Number.isFinite(initB) ? initB : null),
    econReady,
    facts: [...(sb.matchFacts || []), ...(sb.ctTeamFacts || []), ...(sb.tTeamFacts || [])]
      .map((f) => (typeof f === 'string' ? f : f?.text || f?.description || null)).filter(Boolean),
    buyA, buyB, nextBuy: nextRound,
    rounds, hist, bestOf, mapsA, mapsB, mapNumber, mapsUnknown,
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
