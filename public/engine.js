// ProBet CS2 — moteur de probabilités.
// Module ES pur (sans dépendance) : utilisé par le navigateur et par les tests Node.
//
// Modèle :
//  - Chaque round est une pièce biaisée : logit(pA) = biais de côté (CT/T de la map)
//    + force relative d (inconnue) + effets pistol/anti-eco + économie connue.
//  - d suit un a priori (cotes d'avant-match si fournies) mis à jour par les rounds
//    observés (posterior sur une grille, intégré dans toutes les prédictions).
//  - Le round en cours utilise un modèle "live" : joueurs en vie, bombe, chrono, buys.
//  - Une propagation exacte (MR12 + prolongations MR3) donne la distribution des
//    scores finaux → vainqueur, totaux, handicaps, prolongation, série.

export const MAPS = {
  mirage: 0.52, inferno: 0.52, nuke: 0.56, ancient: 0.52, anubis: 0.47,
  dust2: 0.49, train: 0.55, vertigo: 0.52, overpass: 0.54,
};
const DEFAULT_CT = 0.51;

const BUY_STRENGTH = { eco: 0, force: 1.1, half: 1.6, full: 2.5 };

export const sig = (x) => 1 / (1 + Math.exp(-x));
export const logit = (p) => Math.log(p / (1 - p));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const other = (s) => (s === 'CT' ? 'T' : 'CT');

export function normalizeMap(name) {
  if (!name) return null;
  const k = String(name).toLowerCase().replace(/^de_/, '').replace(/[^a-z0-9]/g, '');
  if (k === 'dust' || k === 'dustii') return 'dust2';
  return k in MAPS ? k : null;
}
export const ctRate = (map) => MAPS[normalizeMap(map)] ?? DEFAULT_CT;

// ---------- Règles du format (MR12, prolongations MR3) ----------

// Index de mi-temps d'un round (1-based) : 0,1 = réglementaire, 2.. = mi-temps de prolongation.
export function halfIndex(r) {
  if (r <= 12) return 0;
  if (r <= 24) return 1;
  return 2 + Math.floor((r - 25) / 3);
}
// Nombre de changements de côté depuis le round 1 (pas de changement au début des prolongations).
const flips = (r) => { const h = halfIndex(r); return h <= 1 ? h : h - 1; };

export function sideAt(round, refRound, refSide) {
  if (!refSide) return null;
  return (flips(round) - flips(refRound)) % 2 === 0 ? refSide : other(refSide);
}

// Rang du round dans sa mi-temps (1 = pistol en réglementaire).
function posInHalf(r) {
  if (r <= 12) return r;
  if (r <= 24) return r - 12;
  return ((r - 25) % 3) + 1;
}
const isRegulation = (r) => r <= 24;

// Gagnant de la map ('A' | 'B') ou null si la map continue.
export function mapWinner(a, b) {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (hi < 13) return null;
  if (hi === 13 && lo <= 11) return a > b ? 'A' : 'B';
  if (lo < 12) return null; // impossible en pratique
  const k = Math.floor((lo - 12) / 3);
  if (hi >= 16 + 3 * k && hi > lo) return a > b ? 'A' : 'B';
  return null;
}

// ---------- Probabilité d'un round (avant le début du round) ----------

// ctx : { map, d, aSide, hist: {pw, r2}, econ: {A, B} }
export function roundLogit(r, ctx) {
  const ct = ctRate(ctx.map);
  let x = 0;
  if (ctx.aSide === 'CT') x += logit(ct);
  else if (ctx.aSide === 'T') x -= logit(ct);
  x += ctx.d || 0;

  if (isRegulation(r)) {
    const pos = posInHalf(r);
    const h = ctx.hist || {};
    if (pos === 1) x *= 0.6; // pistol : plus aléatoire
    else if (pos === 2 && h.pw) x += h.pw === 'A' ? 1.35 : -1.35;
    else if (pos === 3 && h.pw && h.r2) {
      if (h.pw === h.r2) x += h.pw === 'A' ? 0.75 : -0.75; // anti-eco converti
      else x += h.r2 === 'A' ? 0.35 : -0.35; // force-buy gagnant garde les armes
    }
  }
  if (ctx.econ && ctx.econ.A != null && ctx.econ.B != null) {
    x += 0.55 * (BUY_STRENGTH[ctx.econ.A] - BUY_STRENGTH[ctx.econ.B]);
  }
  return x;
}

// Historique pistol pour le round suivant.
export function nextHist(r, hist, winner) {
  if (!isRegulation(r)) return {};
  const pos = posInHalf(r);
  if (pos === 1) return { pw: winner };
  if (pos === 2) return { pw: hist.pw, r2: winner };
  return {};
}

// ---------- Round en cours (live) ----------

// s : { aSide, aliveA, aliveB, bombPlanted, timer, buyA, buyB, phase }
export function liveRoundProb(s, base) {
  const ctSideA = s.aSide === 'CT';
  const aliveCT = ctSideA ? s.aliveA : s.aliveB;
  const aliveT = ctSideA ? s.aliveB : s.aliveA;
  const pFromCT = (p) => (ctSideA ? p : 1 - p);

  if (s.aSide == null || aliveCT == null || aliveT == null) return sig(base.x);
  if (aliveCT === 0) return pFromCT(0.005);
  if (aliveT === 0 && !s.bombPlanted) return pFromCT(0.995);

  const ct = ctRate(base.map);
  const dCT = (ctSideA ? 1 : -1) * (base.d || 0) * 0.6;
  let econ = 0;
  if (s.buyA && s.buyB && BUY_STRENGTH[s.buyA] != null && BUY_STRENGTH[s.buyB] != null) {
    const e = 0.45 * (BUY_STRENGTH[s.buyA] - BUY_STRENGTH[s.buyB]);
    econ = (ctSideA ? e : -e) * ((aliveCT + aliveT) / 10);
  }
  const diff = aliveCT - aliveT;
  const scale = Math.sqrt(5 / Math.max(aliveCT, aliveT, 1));
  let x;
  if (s.bombPlanted) {
    if (aliveT === 0) x = -0.3 + 0.35 * (aliveCT - 1); // défuse sous pression
    else x = -1.0 + 0.7 * diff * scale;
  } else {
    x = logit(ct) + 0.65 * diff * scale;
    if (s.timer != null && s.timer < 30) x += (30 - s.timer) * 0.07; // les T doivent poser
  }
  return pFromCT(clamp(sig(x + dCT + econ), 0.01, 0.99));
}

// ---------- Propagation exacte des scores ----------

const MAX_OT_BLOCKS = 6;

// Distribution des scores finaux depuis (a, b) avant le round a+b+1.
// Retourne Map "a-b" -> probabilité.
export function finalDistribution(a, b, opts) {
  const { map, d, refRound, refSide } = opts;
  let states = new Map([[`${a}|${b}|${opts.hist?.pw || ''}|${opts.hist?.r2 || ''}`, 1]]);
  const out = new Map();
  const limit = 24 + 6 * MAX_OT_BLOCKS;
  while (states.size) {
    const next = new Map();
    for (const [key, mass] of states) {
      const [sa, sb, pw, r2] = key.split('|');
      const ca = +sa, cb = +sb;
      const r = ca + cb + 1;
      if (r > limit) { // queue de distribution négligeable : on tranche à 50/50
        const k = `${ca + 1}-${cb}`, k2 = `${ca}-${cb + 1}`;
        out.set(k, (out.get(k) || 0) + mass / 2);
        out.set(k2, (out.get(k2) || 0) + mass / 2);
        continue;
      }
      const hist = { pw: pw || undefined, r2: r2 || undefined };
      const p = sig(roundLogit(r, { map, d, aSide: sideAt(r, refRound, refSide), hist }));
      for (const [w, pm] of [['A', p], ['B', 1 - p]]) {
        const na = ca + (w === 'A'), nb = cb + (w === 'B');
        const m = mass * pm;
        if (mapWinner(na, nb)) {
          const k = `${na}-${nb}`;
          out.set(k, (out.get(k) || 0) + m);
        } else {
          const h = nextHist(r, hist, w);
          const nk = `${na}|${nb}|${h.pw || ''}|${h.r2 || ''}`;
          next.set(nk, (next.get(nk) || 0) + m);
        }
      }
    }
    states = next;
  }
  return out;
}

// ---------- Force relative des équipes (posterior sur grille) ----------

const GRID = Array.from({ length: 49 }, (_, i) => -1.8 + i * 0.075);

// Probabilité de gagner une map depuis 0-0 pour une force d (côté de départ moyenné).
export function mapProbFromD(d, map) {
  let p = 0;
  for (const side of ['CT', 'T']) {
    const dist = finalDistribution(0, 0, { map, d, refRound: 1, refSide: side });
    for (const [k, m] of dist) { const [x, y] = k.split('-').map(Number); if (x > y) p += m / 2; }
  }
  return p;
}

function invert(f, target, lo = -3, hi = 3) {
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function seriesProb(pMap, mA, mB, bestOf, pNext = pMap) {
  const need = Math.ceil(bestOf / 2);
  const memo = new Map();
  const rec = (x, y, first) => {
    if (x >= need) return 1;
    if (y >= need) return 0;
    const k = `${x}-${y}-${first}`;
    if (memo.has(k)) return memo.get(k);
    const p = first ? pMap : pNext;
    const v = p * rec(x + 1, y, false) + (1 - p) * rec(x, y + 1, false);
    memo.set(k, v);
    return v;
  };
  return rec(mA, mB, true);
}

// Convertit une cote pré-match (proba de série) en proba de map.
export function mapProbFromSeries(pSeries, bestOf) {
  if (bestOf <= 1) return pSeries;
  return invert((p) => seriesProb(p, 0, 0, bestOf), pSeries, 0.001, 0.999);
}

const priorCache = new Map();
export function priorD(prematchMapProb, map) {
  if (prematchMapProb == null) return { mean: 0, sd: 0.45 };
  const p = clamp(prematchMapProb, 0.03, 0.97);
  const key = `${p.toFixed(3)}|${normalizeMap(map)}`;
  if (!priorCache.has(key)) priorCache.set(key, invert((d) => mapProbFromD(d, map), p, -3, 3));
  return { mean: priorCache.get(key), sd: 0.3 };
}

// rounds : [{ r, winner: 'A'|'B', aSide: 'CT'|'T'|null, hist, econ }]
export function posterior(rounds, prior, map) {
  const w = GRID.map((d) => {
    let ll = -0.5 * ((d - prior.mean) / prior.sd) ** 2;
    for (const o of rounds) {
      const p = sig(roundLogit(o.r, { map, d, aSide: o.aSide, hist: o.hist, econ: o.econ }));
      ll += Math.log(o.winner === 'A' ? p : 1 - p);
    }
    return ll;
  });
  const mx = Math.max(...w);
  const ex = w.map((x) => Math.exp(x - mx));
  const z = ex.reduce((s, x) => s + x, 0);
  const weights = ex.map((x) => x / z);
  const mean = GRID.reduce((s, d, i) => s + d * weights[i], 0);
  const sd = Math.sqrt(GRID.reduce((s, d, i) => s + weights[i] * (d - mean) ** 2, 0));
  // Grille réduite pour l'intégration (poids significatifs uniquement).
  const support = GRID.map((d, i) => ({ d, w: weights[i] })).filter((x) => x.w > 2e-3);
  const zs = support.reduce((s, x) => s + x.w, 0);
  support.forEach((x) => { x.w /= zs; });
  return { mean, sd, support };
}

// ---------- Analyse complète ----------

// match : état normalisé (voir app.js → toEngineInput)
export function analyze(match) {
  const { map, scoreA: a, scoreB: b, aSide, phase } = match;
  const r = a + b + 1;
  const prior = priorD(match.prematchMapProb, map);
  const post = posterior(match.rounds || [], prior, map);
  const hist = match.hist || {};
  const econ = match.buyA && match.buyB ? { A: match.buyA, B: match.buyB } : null;
  const over = mapWinner(a, b);

  const final = new Map();
  let pRound = null;
  if (over) {
    final.set(`${a}-${b}`, 1);
  } else {
    let pr = 0;
    for (const { d, w } of post.support) {
      const base = { map, d, x: roundLogit(r, { map, d, aSide, hist, econ }) };
      const live = phase === 'live' || phase === 'bomb_planted';
      const p = live ? liveRoundProb({ ...match, aSide }, base) : sig(base.x);
      pr += w * p;
      const opts = { map, d, refRound: r, refSide: aSide };
      for (const [win, pw] of [['A', p], ['B', 1 - p]]) {
        const na = a + (win === 'A'), nb = b + (win === 'B');
        if (mapWinner(na, nb)) {
          const k = `${na}-${nb}`;
          final.set(k, (final.get(k) || 0) + w * pw);
          continue;
        }
        const dist = finalDistribution(na, nb, { ...opts, hist: nextHist(r, hist, win) });
        for (const [k, m] of dist) final.set(k, (final.get(k) || 0) + w * pw * m);
      }
    }
    pRound = pr;
  }

  // Agrégats
  let pMap = 0, pOT = 0;
  const totals = new Map(), margins = new Map();
  for (const [k, m] of final) {
    const [x, y] = k.split('-').map(Number);
    if (x > y) pMap += m;
    if (x + y > 24) pOT += m;
    totals.set(x + y, (totals.get(x + y) || 0) + m);
    margins.set(x - y, (margins.get(x - y) || 0) + m);
  }
  const pOver = (line) => [...totals].reduce((s, [t, m]) => s + (t > line ? m : 0), 0);
  const pCover = (h) => [...margins].reduce((s, [mg, m]) => s + (mg + h > 0 ? m : 0), 0);

  // Série : maps suivantes jouées à force moyenne postérieure, rétrécie vers l'a priori
  // (autre map, autre contexte).
  const bestOf = match.bestOf || 1;
  let pSeries = null;
  if (bestOf > 1) {
    const dNext = 0.6 * post.mean + 0.4 * prior.mean;
    const pNext = mapProbFromD(dNext, null);
    const mA = match.mapsA || 0, mB = match.mapsB || 0;
    pSeries = over
      ? seriesProb(pNext, mA + (over === 'A'), mB + (over === 'B'), bestOf, pNext)
      : seriesProb(pMap, mA, mB, bestOf, pNext);
  }

  const expTotal = [...totals].reduce((s, [t, m]) => s + t * m, 0);
  return {
    round: r, over, pRound, pMap, pOT, pSeries, expTotal,
    strength: { mean: post.mean, sd: post.sd, prior: prior.mean },
    totals: Object.fromEntries(totals), pOver, pCover,
    likelyScores: [...final].sort((x, y) => y[1] - x[1]).slice(0, 5),
  };
}

// ---------- Marchés & recommandations ----------

const num = (x) => String(x).replace('.', ',');
const fmtLine = (x) => (x > 0 ? `+${num(x)}` : num(x));

export function markets(res, names, match) {
  const [A, B] = names;
  const out = [];
  const add = (id, group, label, p) => out.push({ id, group, label, p });
  if (res.pRound != null) {
    add(`round${res.round}:A`, `Round ${res.round}`, A, res.pRound);
    add(`round${res.round}:B`, `Round ${res.round}`, B, 1 - res.pRound);
  }
  const mapLabel = `Map${match.mapNumber ? ' ' + match.mapNumber : ''}`;
  if (!res.over) {
    add('map:A', `${mapLabel} — vainqueur`, A, res.pMap);
    add('map:B', `${mapLabel} — vainqueur`, B, 1 - res.pMap);
    // Lignes de total proches de l'espérance
    const center = Math.round(res.expTotal) - 0.5;
    for (const line of [center - 1, center, center + 1]) {
      if (line < match.scoreA + match.scoreB) continue;
      const po = res.pOver(line);
      add(`tot${line}:O`, `${mapLabel} — total rounds`, `Plus de ${num(line)}`, po);
      add(`tot${line}:U`, `${mapLabel} — total rounds`, `Moins de ${num(line)}`, 1 - po);
    }
    for (const h of [-4.5, -3.5, -2.5, 2.5, 3.5, 4.5]) {
      add(`hcp${h}:A`, `${mapLabel} — handicap`, `${A} ${fmtLine(h)}`, res.pCover(h));
    }
    add('ot:Y', `${mapLabel} — prolongation`, 'Oui', res.pOT);
    add('ot:N', `${mapLabel} — prolongation`, 'Non', 1 - res.pOT);
  }
  if (res.pSeries != null) {
    add('series:A', 'Série — vainqueur', A, res.pSeries);
    add('series:B', 'Série — vainqueur', B, 1 - res.pSeries);
  }
  return out;
}

// Une cote décimale + proba modèle → valeur attendue et mise Kelly fractionnée.
export function evaluateBet(p, odds, kellyFraction = 0.25) {
  if (!odds || odds <= 1) return null;
  const ev = p * odds - 1;
  const kelly = ev > 0 ? (ev / (odds - 1)) * kellyFraction : 0;
  return { ev, stake: Math.min(kelly, 0.05) };
}

// Confiance du modèle (0..1) : lecture vidéo + incertitude sur la force + rounds observés.
export function confidence(res, visionConf, nRounds) {
  const v = visionConf ?? 0.7;
  const s = clamp(1 - (res.strength.sd - 0.15) / 0.4, 0.2, 1);
  const n = clamp(0.5 + nRounds / 16, 0.5, 1);
  return clamp(v * 0.5 + s * 0.3 + n * 0.2, 0, 1);
}

// Sélection des paris à afficher.
//  - "value" : cote saisie au-dessus de la cote juste (+ marge) → pari à valeur positive.
//  - "lean"  : sans cote saisie, sélection nettement favorite (une par marché) avec la
//              cote minimale à exiger chez le bookmaker.
export function recommend(list, oddsById, conf, opts = {}) {
  const minEdge = opts.minEdge ?? 0.04;
  const values = [];
  const leans = new Map();
  for (const m of list) {
    const odds = oddsById[m.id];
    const fair = 1 / m.p;
    const target = fair * (1 + minEdge);
    const ev = evaluateBet(m.p, odds);
    if (ev && ev.ev >= minEdge) {
      values.push({ ...m, odds, fair, target, ev: ev.ev, stake: ev.stake * conf, kind: 'value' });
    } else if (!odds && m.p >= 0.6 && m.p <= 0.88) {
      const cur = leans.get(m.group);
      if (!cur || m.p > cur.p) leans.set(m.group, { ...m, fair, target, kind: 'lean' });
    }
  }
  values.sort((x, y) => y.ev - x.ev);
  return [...values, ...leans.values()].slice(0, opts.max ?? 5);
}
