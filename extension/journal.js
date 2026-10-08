// Journal des matchs : enregistre localement, round par round, ce que ProBet (et HLTV)
// prévoyaient et ce qui s'est réellement passé, ainsi que les paris proposés.
// Sert à mesurer la justesse du modèle sur de vrais matchs et à le recalibrer.
// Fonctions pures sur un objet sérialisable { v, maps: { clé: entrée } }.
import { mapWinner, normalizeMap, sig, logit, MODEL_WEIGHT } from './engine.js';

export const JOURNAL_VERSION = 1;
const MAX_MAPS = 200;
const MAX_SNAPS = 24;

export const newJournal = () => ({ v: JOURNAL_VERSION, maps: {} });
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const kit = (p) => (p.hasDefuseKit || p.hasDefusekit ? 1 : 0);
// Survivant : [PV, arme, armure (0 rien, 1 kevlar, 2 casque), kit, forme]
const compact = (ps) => (ps || []).filter((p) => p.alive !== false)
  .map((p) => [p.hp ?? 100, p.primaryWeapon || '', p.helmet ? 2 : p.kevlar ? 1 : 0, kit(p), r3(p.form ?? 1)]);

const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
function slimMeta(meta = {}) {
  const { hltvProb, timer, prematchOverride, ...rest } = meta;
  return clone(rest);
}
// Scoreboard du début de round, sans l'historique (déjà dans les résultats des rounds).
function slimBoard(sb) {
  if (!sb) return null;
  const { ctMatchHistory, terroristMatchHistory, ...rest } = sb;
  return clone(rest);
}

// Une mise à jour du panneau → journal. ctx : { key, matchId, m (toMatch), res (analyze), hltv, scoreboard, meta, t }
// mk : probabilité « A gagne la map » selon les cotes Stake (sans marge), si connue.
export function record(j, { key, matchId, m, res, hltv, scoreboard, meta, mk = null, t = Date.now() }) {
  let e = j.maps[key];
  if (!e) {
    e = j.maps[key] = {
      matchId, map: m.map, mapNumber: m.mapNumber, bestOf: m.bestOf, teams: m.names, started: t,
      prior: r3(m.pre?.pMap), priorSeries: r3(m.pre?.pSeries), meta: slimMeta(meta),
      rounds: {}, picks: {}, final: null, series: null,
    };
    prune(j);
  }
  e.updated = t;
  for (const o of m.rounds || []) {
    if (o.synthetic) continue;
    const R = (e.rounds[o.r] ??= {});
    R.w ??= o.winner;
  }
  if (res.over) {
    e.final ??= { a: m.scoreA, b: m.scoreB, w: res.over };
    return e;
  }
  if (m.phase !== 'live' && m.phase !== 'bomb_planted') return e;

  const R = (e.rounds[res.round] ??= {});
  const hl = hltv?.oriented && Number.isFinite(hltv.p1) ? { p: r3(hltv.p1), ot: r3(hltv.ot) } : null;
  // Début de round : relevé à 5 contre 5, une fois les achats de toutes les équipes reçus
  // (HLTV les envoie joueur par joueur pendant 1 à 3 s ; ready = achats complets).
  const ready = m.econReady !== false;
  if ((!R.start || (R.start.ready === false && ready)) && m.aliveA === 5 && m.aliveB === 5 && !m.bombPlanted) {
    R.start = {
      t, ready, a: m.scoreA, b: m.scoreB, side: m.aSide, buyA: m.buyA, buyB: m.buyB, eA: m.equipA, eB: m.equipB,
      pr: r3(res.pRound), pm: r3(res.pMap), pot: r3(res.pOT), ps: r3(res.pSeries), sdD: r3(res.strength?.sd),
      hl, mk: r3(mk), sb: slimBoard(scoreboard),
    };
  }
  // Pendant le round : un relevé à chaque changement de situation (kill, bombe).
  const sig = `${m.aliveA}-${m.aliveB}-${m.bombPlanted ? 1 : 0}`;
  if (R.sig !== sig && (R.snaps?.length ?? 0) < MAX_SNAPS) {
    R.sig = sig;
    (R.snaps ??= []).push({
      t, aA: m.aliveA, aB: m.aliveB, bomb: m.bombPlanted ? 1 : 0, tm: m.bombTimer ?? m.timer ?? null,
      pr: r3(res.pRound), pm: r3(res.pMap), hl, pA: compact(m.playersA), pB: compact(m.playersB),
    });
  }
  return e;
}

// Résultats connus par la page (maps terminées de la série) → scores finaux manquants.
// maps : meta.maps [{ name, s1, s2 }], équipe 1 = A.
export function backfill(j, matchId, maps) {
  if (!maps?.length) return;
  const entries = Object.values(j.maps).filter((e) => e.matchId === matchId);
  let mA = 0, mB = 0;
  for (const mp of maps) {
    const w = Number.isInteger(mp.s1) && Number.isInteger(mp.s2) ? mapWinner(mp.s1, mp.s2) : null;
    if (!w) continue;
    if (w === 'A') mA++; else mB++;
    for (const e of entries) {
      if (!e.final && normalizeMap(e.map) === normalizeMap(mp.name)) e.final = { a: mp.s1, b: mp.s2, w };
    }
  }
  for (const e of entries) {
    const need = Math.ceil((e.bestOf || 1) / 2);
    if (!e.series && (mA >= need || mB >= need)) e.series = { a: mA, b: mB, w: mA >= need ? 'A' : 'B' };
  }
}

// Matchs dont une map (ou la série) n'a pas encore de résultat, suivis il y a assez longtemps
// pour être terminés : leurs résultats sont relus sur HLTV pour régler les paris.
export function pendingMatches(j, now = Date.now(), { after = 20 * 60000, before = 3 * 86400000 } = {}) {
  const ids = new Set();
  for (const e of Object.values(j.maps)) {
    const age = now - (e.updated ?? e.started ?? 0);
    if (!/^\d+$/.test(String(e.matchId)) || age < after || age > before) continue;
    const seriesPick = Object.values(e.picks || {}).some((p) => p.id.startsWith('series:'));
    if (!e.final || (seriesPick && !e.series)) ids.add(String(e.matchId));
  }
  return [...ids];
}

// Paris affichés : chaque pari est noté la première fois qu'il apparaît.
export function logPicks(j, key, picks, { round, a, b, phase, ready, t = Date.now() } = {}) {
  const e = j.maps[key];
  if (!e) return;
  for (const p of picks) {
    const id = `${p.kind}:${p.id}`;
    if (e.picks[id]) continue;
    e.picks[id] = {
      id: p.id, kind: p.kind, group: p.group, label: p.label, p: r3(p.p), pc: r3(p.pc), sd: r3(p.sd),
      pm: r3(p.pModel), pk: r3(p.pMkt), reason: p.reason,
      odds: p.odds ?? null, target: r3(p.target), stake: r3(p.stake), round, a, b, t, phase, ready,
    };
  }
}

// Cote « suivante » d'un pari VALUE : première cote Stake fraîche d'un round suivant. Si elle
// est plus basse que la cote prise, le marché est venu vers nous : on a battu le bookmaker.
export function trackNext(j, key, odds, round) {
  const e = j.maps[key];
  if (!e) return false;
  let changed = false;
  for (const p of Object.values(e.picks)) {
    if (p.kind !== 'value' || p.next != null || !(round > p.round) || !(odds[p.id] > 1)) continue;
    p.next = odds[p.id];
    changed = true;
  }
  return changed;
}

// Issue d'un marché : true (gagné), false (perdu), null (inconnue).
export function settle(id, e) {
  let mt;
  if ((mt = /^round(\d+):(A|B)$/.exec(id))) {
    const w = e.rounds?.[mt[1]]?.w;
    return w ? w === mt[2] : null;
  }
  if ((mt = /^series:(A|B)$/.exec(id))) return e.series ? e.series.w === mt[1] : null;
  const f = e.final;
  if (!f) return null;
  if ((mt = /^map:(A|B)$/.exec(id))) return f.w === mt[1];
  if ((mt = /^tot([\d.]+):(O|U)$/.exec(id))) return (f.a + f.b > Number(mt[1])) === (mt[2] === 'O');
  if ((mt = /^hcp(-?[\d.]+):(A|B)$/.exec(id))) return (f.a - f.b + Number(mt[1]) > 0) === (mt[2] === 'A');
  if ((mt = /^ot:(Y|N)$/.exec(id))) return (f.a + f.b > 24) === (mt[1] === 'Y');
  return null;
}

const brier = (xs) => (xs.length ? xs.reduce((s, [p, y]) => s + (p - y) ** 2, 0) / xs.length : null);
const BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];

// Calibrage : probabilité de la favorite → taux de réussite observé, par tranche.
function calibration(pairs) {
  const out = BUCKETS.slice(0, -1).map((lo, i) => ({ lo, hi: Math.min(1, BUCKETS[i + 1]), n: 0, p: 0, hit: 0 }));
  for (const [p, y] of pairs) {
    const fav = p >= 0.5 ? p : 1 - p, won = p >= 0.5 ? y : 1 - y;
    const b = out.find((x) => fav >= x.lo && fav < (x.hi === 1 ? 1.0001 : x.hi));
    b.n++; b.p += fav; b.hit += won;
  }
  return out.filter((b) => b.n).map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, predicted: b.p / b.n, observed: b.hit / b.n }));
}

// ProBet contre les cotes Stake sur le vainqueur de la map, et poids du modèle qui donne la
// meilleure prévision combinée (sert au calcul des paris VALUE).
function vsStake(xs) {
  if (!xs.length) return null;
  const c = (p) => Math.min(1 - 1e-4, Math.max(1e-4, p));
  const mix = (w) => brier(xs.map(([p, k, y]) => [sig(w * logit(c(p)) + (1 - w) * logit(c(k))), y]));
  let best = 0;
  for (let w = 0; w <= 1.0001; w += 0.05) if (mix(w) < mix(best) - 1e-12) best = Math.round(w * 100) / 100;
  // Les relevés d'une même map ne sont pas indépendants : le poids appris n'est suivi que
  // progressivement (10 maps « virtuelles » à 0,5).
  const maps = new Set(xs.map((x) => x[3])).size;
  const w = Math.round(((maps * best + 10 * MODEL_WEIGHT) / (maps + 10)) * 100) / 100;
  return { n: xs.length, maps, probet: brier(xs.map(([p, , y]) => [p, y])),
    stake: brier(xs.map(([, k, y]) => [k, y])), best, w, mixed: mix(best) };
}

export function summarize(j) {
  const entries = Object.values(j.maps);
  const rounds = [], maps = [], mapsVsHltv = [], mapsVsStake = [], priors = [];
  const picks = { lean: [], value: [], skip: [] };
  for (const e of entries) {
    for (const R of Object.values(e.rounds)) {
      if (R.w && Number.isFinite(R.start?.pr) && R.start.ready !== false) rounds.push([R.start.pr, R.w === 'A' ? 1 : 0]);
    }
    if (e.final) {
      const y = e.final.w === 'A' ? 1 : 0;
      if (Number.isFinite(e.prior)) priors.push([e.prior, y]);
      for (const R of Object.values(e.rounds)) {
        const s = R.start;
        if (!Number.isFinite(s?.pm) || s.ready === false) continue;
        maps.push([s.pm, y]);
        if (Number.isFinite(s.hl?.p)) mapsVsHltv.push([s.pm, s.hl.p, y]);
        if (Number.isFinite(s.mk)) mapsVsStake.push([s.pm, s.mk, y, e]);
      }
    }
    // Un seul pari par marché et par round : les anciennes versions notaient chaque ligne
    // (map, tous les handicaps, tous les totaux) d'un même avis.
    const once = new Set();
    for (const p of Object.values(e.picks).sort((x, y) => (x.t ?? 0) - (y.t ?? 0))) {
      const cat = /^(map|hcp|tot|ot|series|round)/.exec(p.id)?.[1];
      const k = `${p.kind}|${cat}|${p.round}`;
      if (once.has(k)) continue;
      once.add(k);
      const won = settle(p.id, e);
      // Paris sur un round : plus proposés (absents de Stake), anciens relevés ignorés.
      if (won != null && !p.id.startsWith('round')) picks[p.kind]?.push({ ...p, won });
    }
  }
  const pickStats = (xs) => {
    const priced = xs.filter((x) => x.odds > 1);
    const nexts = priced.filter((x) => x.next > 1);
    const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
    return {
      n: xs.length,
      won: xs.filter((x) => x.won).length,
      expected: xs.length ? sum(xs, (x) => x.p ?? 0) / xs.length : null,
      // Gain à mise fixe d'une unité, à la cote prise.
      units: priced.length ? sum(priced, (x) => (x.won ? x.odds - 1 : -1)) : null,
      avgOdds: priced.length ? sum(priced, (x) => x.odds) / priced.length : null,
      // Réussite nécessaire pour ne pas perdre d'argent à ces cotes.
      breakEven: priced.length ? sum(priced, (x) => 1 / x.odds) / priced.length : null,
      // Gain à la mise conseillée (en % de la bankroll).
      staked: priced.some((x) => x.stake > 0) ? sum(priced, (x) => (x.stake > 0 ? (x.won ? x.odds - 1 : -1) * x.stake : 0)) : null,
      // Tendances : gain si chacune avait été jouée exactement à la cote minimale affichée.
      atMin: !priced.length && xs.some((x) => x.target > 1) ? sum(xs, (x) => (x.target > 1 ? (x.won ? x.target - 1 : -1) : 0)) : null,
      avgMin: !priced.length && xs.some((x) => x.target > 1) ? sum(xs, (x) => x.target || 0) / xs.filter((x) => x.target > 1).length : null,
      // Cote battue : part des paris dont la cote Stake a ensuite baissé, et écart moyen.
      beat: nexts.length ? { n: nexts.length, share: nexts.filter((x) => x.next < x.odds).length / nexts.length, clv: sum(nexts, (x) => x.odds / x.next - 1) / nexts.length } : null,
    };
  };
  const MARKETS = ['hcp', 'map', 'tot', 'ot', 'series'];
  const byMarket = (xs) => Object.fromEntries(MARKETS.map((m) => [m, pickStats(xs.filter((x) => x.id.startsWith(m)))]).filter(([, v]) => v.n));
  return {
    maps: entries.length,
    finished: entries.filter((e) => e.final).length,
    rounds: { n: rounds.length, brier: brier(rounds), calibration: calibration(rounds) },
    map: {
      n: maps.length, brier: brier(maps), calibration: calibration(maps),
      vsHltv: mapsVsHltv.length ? {
        n: mapsVsHltv.length,
        probet: brier(mapsVsHltv.map(([p, , y]) => [p, y])),
        hltv: brier(mapsVsHltv.map(([, h, y]) => [h, y])),
      } : null,
    },
    vsStake: vsStake(mapsVsStake),
    prior: { n: priors.length, brier: brier(priors) },
    picks: { lean: pickStats(picks.lean), value: pickStats(picks.value), skip: pickStats(picks.skip), valueByMarket: byMarket(picks.value) },
  };
}

// Clé d'une map : match + map (une map n'est jouée qu'une fois dans une série).
export const mapKeyOf = (matchId, map) => `${matchId}|${normalizeMap(map) || map}`;

// Journaux des versions ≤ 2.5.1 : une même map pouvait être enregistrée sous plusieurs clés
// (numéro de map dans la série recalculé en cours de route). Fusionne ces doublons.
// Retourne { removed, changed } : clés supprimées et clés réécrites.
export function mergeDuplicates(j) {
  const groups = new Map();
  for (const [k, e] of Object.entries(j.maps)) {
    const id = mapKeyOf(e.matchId, e.map);
    (groups.get(id) ?? groups.set(id, []).get(id)).push([k, e]);
  }
  const removed = [], changed = [];
  for (const [id, list] of groups) {
    if (list.length === 1 && list[0][0] === id) continue;
    const starts = (e) => Object.values(e.rounds || {}).filter((R) => R.start).length;
    list.sort((x, y) => starts(y[1]) - starts(x[1]));
    const base = JSON.parse(JSON.stringify(list[0][1]));
    for (const [, e] of list.slice(1)) {
      for (const [r, R] of Object.entries(e.rounds || {})) {
        const B = (base.rounds[r] ??= {});
        B.w ??= R.w;
        if (R.start && (!B.start || (B.start.ready === false && R.start.ready !== false))) { B.start = R.start; B.snaps = R.snaps; }
        if (!B.snaps && R.snaps) B.snaps = R.snaps;
      }
      for (const [pid, p] of Object.entries(e.picks || {})) base.picks[pid] ??= p;
      base.final ??= e.final;
      base.series ??= e.series;
      base.started = Math.min(base.started ?? Infinity, e.started ?? Infinity);
      base.updated = Math.max(base.updated ?? 0, e.updated ?? 0);
    }
    for (const [k] of list) { delete j.maps[k]; if (k !== id) removed.push(k); }
    j.maps[id] = base;
    changed.push(id);
  }
  return { removed, changed };
}

// Maps enregistrées depuis un scorebot HLTV qui envoyait un autre match (map absente de la
// liste des maps du match) : retirées du journal. Retourne les clés supprimées.
export function dropForeign(j) {
  const key = (n) => { const k = String(n || '').toLowerCase().replace(/^de_/, '').replace(/[^a-z0-9]/g, ''); return k === 'dust' ? 'dust2' : k; };
  const removed = [];
  for (const [k, e] of Object.entries(j.maps)) {
    const names = (e.meta?.maps || []).map((mp) => key(mp.name)).filter((x) => x && x !== 'tba');
    if (e.map && names.length && names.length >= (e.bestOf || 1) && !names.includes(key(e.map))) { delete j.maps[k]; removed.push(k); }
  }
  return removed;
}

// Garde les maps les plus récentes.
function prune(j) {
  const keys = Object.keys(j.maps);
  if (keys.length <= MAX_MAPS) return;
  keys.sort((x, y) => (j.maps[x].updated ?? j.maps[x].started) - (j.maps[y].updated ?? j.maps[y].started));
  for (const k of keys.slice(0, keys.length - MAX_MAPS)) {
    delete j.maps[k];
    (j.removed ??= []).push(k);
  }
}
