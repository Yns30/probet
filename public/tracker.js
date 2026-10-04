// Suivi de l'état du match à partir des lectures successives du stream.
// Filtre les erreurs de lecture : un score ne progresse que d'un round à la fois ;
// tout autre saut doit être confirmé par deux lectures identiques.
import { mapWinner, nextHist, normalizeMap } from './engine.js';

const BUYS = new Set(['eco', 'force', 'half', 'full']);
const other = (s) => (s === 'CT' ? 'T' : s === 'T' ? 'CT' : null);
const norm = (s) => (s ? String(s).toLowerCase().replace(/[^a-z0-9]/g, '') : '');
const same = (x, y) => x && y && (x === y || (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))));

export function createMatch() {
  return {
    names: { A: null, B: null }, lockNames: false, aIsLeft: true,
    scoreA: 0, scoreB: 0, aSide: null, map: null, mapNumber: 1,
    mapsA: 0, mapsB: 0, bestOf: 3, prematchMapProb: null,
    phase: 'unknown', aliveA: null, aliveB: null, bombPlanted: false, bombSite: null,
    timer: null, buyA: null, buyB: null, roundBuy: null,
    rounds: [], hist: {}, facts: [], visionConf: null,
    pending: null, mapOver: null, seen: false,
  };
}

function orient(m, read) {
  const L = read.left || {}, R = read.right || {};
  const nL = norm(L.name), nR = norm(R.name), nA = norm(m.names.A), nB = norm(m.names.B);
  if (nA && nB && (nL || nR)) {
    if (same(nL, nA) || same(nR, nB)) m.aIsLeft = true;
    else if (same(nL, nB) || same(nR, nA)) m.aIsLeft = false;
  }
  const a = m.aIsLeft ? L : R, b = m.aIsLeft ? R : L;
  if (!m.lockNames) {
    if (a.name && !m.names.A) m.names.A = a.name;
    if (b.name && !m.names.B) m.names.B = b.name;
  }
  return { a, b };
}

const name = (m, t) => m.names[t] || `Équipe ${t}`;

export function commitRound(m, winner, ev) {
  const r = m.scoreA + m.scoreB + 1;
  const econ = m.roundBuy && BUYS.has(m.roundBuy.A) && BUYS.has(m.roundBuy.B) ? { ...m.roundBuy } : null;
  m.rounds.push({ r, winner, aSide: m.aSide, hist: { ...m.hist }, econ });
  m.hist = nextHist(r, m.hist, winner);
  if (winner === 'A') m.scoreA++; else m.scoreB++;
  m.roundBuy = null;
  m.bombPlanted = false;
  ev.push(`Round ${r} pour ${name(m, winner)} (${m.scoreA}-${m.scoreB})`);
  const w = mapWinner(m.scoreA, m.scoreB);
  if (w) {
    m.mapOver = w;
    if (w === 'A') m.mapsA++; else m.mapsB++;
    ev.push(`Map ${m.mapNumber} remportée par ${name(m, w)} ${m.scoreA}-${m.scoreB}`);
  }
}

export function setScore(m, sa, sb, ev) {
  sa = Math.max(0, sa); sb = Math.max(0, sb);
  if (sa >= m.scoreA && sb >= m.scoreB && sa + sb - m.scoreA - m.scoreB === 1) {
    return commitRound(m, sa > m.scoreA ? 'A' : 'B', ev);
  }
  // Saut (arrivée en cours de match) ou correction : on garde les rounds connus
  // et on ajoute les rounds manquants sans côté connu.
  m.rounds = m.rounds.filter((o) => o.r <= sa + sb);
  let ka = m.rounds.filter((o) => o.winner === 'A').length;
  let kb = m.rounds.filter((o) => o.winner === 'B').length;
  if (ka > sa || kb > sb) { m.rounds = []; ka = kb = 0; }
  let r = m.rounds.length;
  while (ka < sa) { m.rounds.push({ r: ++r, winner: 'A', aSide: null }); ka++; }
  while (kb < sb) { m.rounds.push({ r: ++r, winner: 'B', aSide: null }); kb++; }
  m.rounds.sort((x, y) => x.r - y.r);
  m.scoreA = sa; m.scoreB = sb; m.hist = {};
  m.mapOver = mapWinner(sa, sb);
  ev.push(`Score recalé à ${sa}-${sb}`);
}

export function newMap(m, ev) {
  if (!m.mapOver && m.scoreA + m.scoreB >= 13) {
    const w = m.scoreA > m.scoreB ? 'A' : 'B';
    if (w === 'A') m.mapsA++; else m.mapsB++;
  }
  m.mapNumber++;
  Object.assign(m, {
    scoreA: 0, scoreB: 0, rounds: [], hist: {}, mapOver: null, map: null,
    roundBuy: null, buyA: null, buyB: null, bombPlanted: false,
  });
  ev.push(`Début de la map ${m.mapNumber}`);
}

function handleScore(m, sa, sb, ev) {
  if (sa === m.scoreA && sb === m.scoreB) { m.pending = null; return; }
  const da = sa - m.scoreA, db = sb - m.scoreB;
  if (!m.mapOver && m.seen && ((da === 1 && db === 0) || (da === 0 && db === 1))) {
    m.pending = null;
    return commitRound(m, da ? 'A' : 'B', ev);
  }
  const key = `${sa}-${sb}`;
  if (m.pending !== key) { m.pending = key; return; }
  m.pending = null;
  if (sa === 0 && sb === 0) newMap(m, ev);
  else setScore(m, sa, sb, ev);
}

// read : sortie JSON de la vision (voir src/vision.js). Retourne la liste d'événements.
export function ingest(m, read) {
  const ev = [];
  if (!read || !read.hud_visible || read.phase === 'not_ingame' || read.phase === 'replay') {
    m.phase = read?.phase || 'not_ingame';
    return ev;
  }
  const { a, b } = orient(m, read);
  m.visionConf = typeof read.confidence === 'number' ? read.confidence : null;
  m.facts = Array.isArray(read.key_facts) ? read.key_facts.slice(0, 3) : [];

  const mapName = normalizeMap(read.map) || (read.map ? String(read.map).toLowerCase() : null);
  if (mapName && mapName !== m.map) m.map = mapName;
  if ([1, 3, 5].includes(read.best_of)) m.bestOf = read.best_of;

  // Score d'abord, avec le côté du round qui vient de se jouer.
  if (Number.isInteger(a.score) && Number.isInteger(b.score)) {
    handleScore(m, a.score, b.score, ev);
    m.seen = true;
  }

  const ma = m.aIsLeft ? read.maps_left : read.maps_right;
  const mb = m.aIsLeft ? read.maps_right : read.maps_left;
  const need = Math.ceil(m.bestOf / 2);
  // Pendant une map, le compteur de maps du HUD = maps déjà terminées.
  if (!m.mapOver && Number.isInteger(ma) && Number.isInteger(mb) && ma < need && mb < need) {
    m.mapsA = ma; m.mapsB = mb;
  }

  const side = a.side || other(b.side);
  if (side) m.aSide = side;

  m.phase = read.phase;
  if (read.phase === 'freezetime') {
    m.aliveA = 5; m.aliveB = 5;
  } else {
    if (Number.isInteger(a.alive)) m.aliveA = Math.max(0, Math.min(5, a.alive));
    if (Number.isInteger(b.alive)) m.aliveB = Math.max(0, Math.min(5, b.alive));
  }
  m.bombPlanted = Boolean(read.bomb_planted) || read.phase === 'bomb_planted';
  m.bombSite = read.bomb_site || null;
  m.timer = Number.isInteger(read.round_timer) ? read.round_timer : null;
  if (read.phase === 'freezetime' || read.phase === 'live' || read.phase === 'bomb_planted') {
    if (BUYS.has(a.buy)) m.buyA = a.buy;
    if (BUYS.has(b.buy)) m.buyB = b.buy;
    if (m.buyA && m.buyB) m.roundBuy = { A: m.buyA, B: m.buyB };
  } else if (read.phase === 'round_over') {
    m.buyA = null; m.buyB = null;
  }
  return ev;
}

// Entrée du moteur.
export function toEngineInput(m) {
  return {
    map: m.map, scoreA: m.scoreA, scoreB: m.scoreB, aSide: m.aSide,
    phase: m.phase, aliveA: m.aliveA, aliveB: m.aliveB, bombPlanted: m.bombPlanted,
    timer: m.timer, buyA: m.buyA, buyB: m.buyB, rounds: m.rounds, hist: m.hist,
    bestOf: m.bestOf, mapsA: m.mapsA, mapsB: m.mapsB, mapNumber: m.mapNumber,
    prematchMapProb: m.prematchMapProb,
  };
}
