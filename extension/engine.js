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

// Paramètres de calibrage (voir test/calibration.test.js).
//  - roundWeight : poids d'un round observé dont on ne connaît pas l'économie. Les rounds
//    s'enchaînent par séries (économie), ils valent moins qu'une observation indépendante.
//  - priorSd* : incertitude de départ sur l'écart de niveau (logit par round).
//  - seriesWeight : poids des rounds des maps précédentes de la série.
//  - carry : avantage du vainqueur du round précédent (argent, armes gardées) hors pistols
//    et remises à zéro ; il crée les séries de rounds observées en pro.
export const CAL = { carry: 0.35, roundWeight: 0.6, priorSdOdds: 0.18, priorSdPage: 0.22, priorSdNone: 0.28, seriesWeight: 0.35 };

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
  } else if (ctx.last && posInHalf(r) >= (isRegulation(r) ? 4 : 2)) {
    x += ctx.last === 'A' ? CAL.carry : -CAL.carry; // économie du vainqueur précédent
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

// Qualité d'équipement d'un joueur (1 = fusil + casque) et poids selon ses PV.
const norm = (w) => String(w || '').toLowerCase().replace(/^weapon_/, '').replace(/[^a-z0-9]/g, '');
const WEAPONS = {
  awp: 1.1, ak47: 1, m4a1: 1, m4a1silencer: 1, m4a4: 1, aug: 1, sg556: 1, sg553: 1, scar20: 1, g3sg1: 1,
  famas: 0.9, galilar: 0.9, galil: 0.9, ssg08: 0.8, m249: 0.8, negev: 0.8,
  mp9: 0.75, mac10: 0.75, mp7: 0.75, mp5sd: 0.75, ump45: 0.75, p90: 0.78, bizon: 0.72,
  nova: 0.7, xm1014: 0.72, mag7: 0.7, sawedoff: 0.68, deagle: 0.55, revolver: 0.52,
  tec9: 0.5, fiveseven: 0.5, cz75a: 0.5, p250: 0.46,
};
export const weaponFactor = (w) => WEAPONS[norm(w)] ?? 0.42; // sinon : pistolet de départ
export const quality = (p) => weaponFactor(p.primaryWeapon) * (p.helmet ? 1 : p.kevlar ? 0.9 : 0.75);
export const hpUnit = (p) => (0.35 + 0.65 * clamp(p.hp ?? 100, 1, 100) / 100) * (p.form ?? 1); // form : niveau du joueur
export const playerUnit = (p) => hpUnit(p) * quality(p);
const aliveOf = (players) => (players || []).filter((p) => p.alive !== false);
const avg = (xs) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : 0);

// Avantage numérique → logit. Calé sur les taux pro : 5v4 ≈ 71 %, 5v3 ≈ 86 %,
// 4v2 ≈ 87 %, 4v1 ≈ 96 %, 2v1 ≈ 70 % (chaque joueur supplémentaire pèse davantage).
const curve = (D) => 0.85 * D + 0.05 * D * Math.abs(D);

// s : { aSide, aliveA, aliveB, playersA, playersB, hpA, hpB, bombPlanted, bombTimer, timer, buyA, buyB }
export function liveRoundProb(s, base) {
  const ctSideA = s.aSide === 'CT';
  const aliveCT = ctSideA ? s.aliveA : s.aliveB;
  const aliveT = ctSideA ? s.aliveB : s.aliveA;
  const pFromCT = (p) => (ctSideA ? p : 1 - p);

  if (s.aSide == null || aliveCT == null || aliveT == null) return sig(base.x);
  if (aliveCT === 0) return pFromCT(0.003);
  if (aliveT === 0 && !s.bombPlanted) return pFromCT(0.997);

  const ct = ctRate(base.map);
  const dCT = (ctSideA ? 1 : -1) * (base.d || 0) * 0.5;
  const plCT = ctSideA ? s.playersA : s.playersB, plT = ctSideA ? s.playersB : s.playersA;
  let uCT, uT, econ = 0;
  if (plCT?.length && plT?.length) {
    // Nombre de joueurs pondéré par les PV + écart de qualité d'équipement des survivants.
    // Calage : full eco contre full buy ≈ 12 %, force-buy ≈ 28 %.
    const aCT = aliveOf(plCT), aT = aliveOf(plT);
    uCT = aCT.reduce((t, p) => t + hpUnit(p), 0); uT = aT.reduce((t, p) => t + hpUnit(p), 0);
    econ = 2.9 * (avg(aCT.map(quality)) - avg(aT.map(quality)));
  } else {
    const hpCT = ctSideA ? s.hpA : s.hpB, hpT = ctSideA ? s.hpB : s.hpA;
    const eff = (n, hp) => (hp != null ? 0.35 * n + 0.65 * Math.min(hp, 100 * n) / 100 : n);
    uCT = eff(aliveCT, hpCT); uT = eff(aliveT, hpT);
    if (s.buyA && s.buyB && BUY_STRENGTH[s.buyA] != null && BUY_STRENGTH[s.buyB] != null) {
      const e = 0.45 * (BUY_STRENGTH[s.buyA] - BUY_STRENGTH[s.buyB]);
      econ = (ctSideA ? e : -e) * ((aliveCT + aliveT) / 10);
    }
  }
  const D = uCT - uT;
  const kit = (plCT || []).some((p) => p.alive !== false && (p.hasDefuseKit || p.hasDefusekit));
  let x;
  if (s.bombPlanted) {
    // Temps restant avant l'explosion contre temps de désamorçage (10 s, 5 s avec kit).
    const slack = s.bombTimer != null ? s.bombTimer - (kit ? 5 : 10) : null;
    if (slack != null && slack <= 0) return pFromCT(0.01);
    if (aliveT === 0) x = (kit ? 1.5 : 0.9) + 0.35 * (aliveCT - 1) - (slack != null && slack < 5 ? (5 - slack) * 0.35 : 0);
    else {
      x = -0.75 + 0.9 * curve(D) + (kit ? 0.3 : 0);
      if (slack != null && slack < 15) x -= (15 - slack) * 0.12; // il faut gagner les duels ET désamorcer
    }
  } else {
    x = 0.5 * logit(ct) + curve(D);
    if (s.timer != null && s.timer < 30) x += (30 - s.timer) * 0.06; // les T doivent poser
  }
  return pFromCT(clamp(sig(x + dCT + econ), 0.003, 0.997));
}

// ---------- Propagation exacte des scores ----------

const MAX_OT_BLOCKS = 6;

// Distribution des scores finaux depuis (a, b) avant le round a+b+1.
// Retourne Map "a-b" -> probabilité.
export function finalDistribution(a, b, opts) {
  const { map, d, refRound, refSide } = opts;
  let states = new Map([[`${a}|${b}|${opts.hist?.pw || ''}|${opts.hist?.r2 || ''}|${opts.last || ''}`, 1]]);
  const out = new Map();
  const limit = 24 + 6 * MAX_OT_BLOCKS;
  const first = a + b + 1;
  while (states.size) {
    const next = new Map();
    for (const [key, mass] of states) {
      const [sa, sb, pw, r2, lw] = key.split('|');
      const ca = +sa, cb = +sb;
      const r = ca + cb + 1;
      if (r > limit) { // queue de distribution négligeable : on tranche à 50/50
        const k = `${ca + 1}-${cb}`, k2 = `${ca}-${cb + 1}`;
        out.set(k, (out.get(k) || 0) + mass / 2);
        out.set(k2, (out.get(k2) || 0) + mass / 2);
        continue;
      }
      const hist = { pw: pw || undefined, r2: r2 || undefined };
      const econ = r === first ? opts.econ : undefined; // achat connu du premier round simulé
      const p = sig(roundLogit(r, { map, d, aSide: sideAt(r, refRound, refSide), hist, econ, last: lw || undefined }));
      for (const [w, pm] of [['A', p], ['B', 1 - p]]) {
        const na = ca + (w === 'A'), nb = cb + (w === 'B');
        const m = mass * pm;
        if (mapWinner(na, nb)) {
          const k = `${na}-${nb}`;
          out.set(k, (out.get(k) || 0) + m);
        } else {
          const h = nextHist(r, hist, w);
          const nk = `${na}|${nb}|${h.pw || ''}|${h.r2 || ''}|${w}`;
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
  if (prematchMapProb == null) return { mean: 0, sd: CAL.priorSdNone };
  const p = clamp(prematchMapProb, 0.03, 0.97);
  const key = `${p.toFixed(3)}|${normalizeMap(map)}`;
  if (!priorCache.has(key)) priorCache.set(key, invert((d) => mapProbFromD(d, map), p, -3, 3));
  return { mean: priorCache.get(key), sd: CAL.priorSdOdds };
}

// rounds : [{ r, winner: 'A'|'B', aSide: 'CT'|'T'|null, hist, econ }]
export function posterior(rounds, prior, map) {
  const w = GRID.map((d) => {
    let ll = -0.5 * ((d - prior.mean) / prior.sd) ** 2;
    for (const o of rounds) {
      if (o.wins != null) {
        // Observation agrégée (moitié de map déjà jouée) : o.wins rounds gagnés par A sur o.n.
        const p = sig(roundLogit(99, { map: o.map ?? map, d, aSide: o.aSide }));
        ll += (o.weight ?? CAL.seriesWeight) * (o.wins * Math.log(p) + (o.n - o.wins) * Math.log(1 - p));
        continue;
      }
      const p = sig(roundLogit(o.r, { map, d, aSide: o.aSide, hist: o.hist, econ: o.econ, last: o.last }));
      ll += (o.econ ? 1 : CAL.roundWeight) * Math.log(o.winner === 'A' ? p : 1 - p);
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

// Distribution des scores finaux → probabilités des marchés de la map.
function aggregate(final) {
  let pMap = 0, pOT = 0, pRegA = 0, pRegB = 0;
  const totals = new Map(), margins = new Map();
  for (const [k, m] of final) {
    const [x, y] = k.split('-').map(Number);
    if (x > y) pMap += m;
    if (x + y > 24) pOT += m;
    else if (x > y) pRegA += m;
    else pRegB += m;
    totals.set(x + y, (totals.get(x + y) || 0) + m);
    margins.set(x - y, (margins.get(x - y) || 0) + m);
  }
  const pOver = (line) => [...totals].reduce((s, [t, m]) => s + (t > line ? m : 0), 0);
  const pCover = (h) => [...margins].reduce((s, [mg, m]) => s + (mg + h > 0 ? m : 0), 0);
  return { pMap, pOT, pRegA, pRegB, totals, pOver, pCover };
}

// match : état normalisé (voir app.js → toEngineInput)
export function analyze(match) {
  const { map, scoreA: a, scoreB: b, aSide, phase } = match;
  const r = a + b + 1;
  const prior = match.prior ?? priorD(match.prematchMapProb, map);
  const post = posterior([...(match.rounds || []), ...(match.seriesObs || [])], prior, map);
  const hist = match.hist || {};
  const econ = match.buyA && match.buyB ? { A: match.buyA, B: match.buyB } : null;
  const over = mapWinner(a, b);
  const prev = (match.rounds || [])[(match.rounds || []).length - 1];
  const last = prev && !prev.synthetic ? prev.winner : undefined;

  const final = new Map();
  const perD = []; // résultats par valeur de force plausible (incertitude du modèle)
  let pRound = null;
  if (over) {
    final.set(`${a}-${b}`, 1);
  } else {
    let pr = 0;
    for (const { d, w } of post.support) {
      const base = { map, d, x: roundLogit(r, { map, d, aSide, hist, econ, last }) };
      const live = phase === 'live' || phase === 'bomb_planted';
      const p = live ? liveRoundProb({ ...match, aSide }, base) : sig(base.x);
      pr += w * p;
      const fd = new Map();
      const opts = { map, d, refRound: r, refSide: aSide };
      for (const [win, pw] of [['A', p], ['B', 1 - p]]) {
        const na = a + (win === 'A'), nb = b + (win === 'B');
        if (mapWinner(na, nb)) {
          const k = `${na}-${nb}`;
          fd.set(k, (fd.get(k) || 0) + pw);
          continue;
        }
        const dist = finalDistribution(na, nb, { ...opts, hist: nextHist(r, hist, win), econ: match.nextEcon?.[win], last: win });
        for (const [k, m] of dist) fd.set(k, (fd.get(k) || 0) + pw * m);
      }
      for (const [k, m] of fd) final.set(k, (final.get(k) || 0) + w * m);
      perD.push({ d, w, pRound: p, ...aggregate(fd) });
    }
    pRound = pr;
  }

  const { pMap, pOT, pRegA, pRegB, totals, pOver, pCover } = aggregate(final);

  // Série : maps suivantes jouées à force moyenne postérieure, rétrécie vers l'a priori
  // (autre map, autre contexte).
  const bestOf = match.bestOf || 1;
  const mA = match.mapsA || 0, mB = match.mapsB || 0;
  const series = (pm, d) => {
    if (bestOf <= 1) return null;
    const pNext = mapProbFromD(0.6 * d + 0.4 * prior.mean, null);
    return over
      ? seriesProb(pNext, mA + (over === 'A'), mB + (over === 'B'), bestOf, pNext)
      : seriesProb(pm, mA, mB, bestOf, pNext);
  };
  const pSeries = series(pMap, post.mean);
  for (const s of perD) s.pSeries = series(s.pMap, s.d);

  // Écart-type d'une probabilité de marché sur l'incertitude de la force des équipes :
  // un pari solide doit le rester dans le bas de la fourchette.
  const spread = (fn) => {
    if (!perD.length) return 0;
    const xs = perD.map((s) => [s.w, fn(s)]);
    const mean = xs.reduce((t, [w, x]) => t + w * x, 0);
    return Math.sqrt(xs.reduce((t, [w, x]) => t + w * (x - mean) ** 2, 0));
  };

  const expTotal = [...totals].reduce((s, [t, m]) => s + t * m, 0);
  return {
    round: r, over, pRound, pMap, pOT, pRegA, pRegB, pSeries, expTotal,
    strength: { mean: post.mean, sd: post.sd, prior: prior.mean },
    totals: Object.fromEntries(totals), pOver, pCover, spread,
    likelyScores: [...final].sort((x, y) => y[1] - x[1]).slice(0, 5),
  };
}

// ---------- Marchés & recommandations ----------

const num = (x) => String(x).replace('.', ',');
const fmtLine = (x) => (x > 0 ? `+${num(x)}` : num(x));

// Lignes de total proposées par les bookmakers (fixes : elles ne bougent pas avec le score).
export const TOTAL_LINES = [19.5, 20.5, 21.5, 22.5, 23.5];

// Chaque marché : probabilité p et écart-type sd (incertitude du modèle sur la force).
export function markets(res, names, match) {
  const [A, B] = names;
  const out = [];
  const add = (id, group, label, f) => {
    const p = f(res);
    out.push({ id, group, label, p, sd: res.spread ? res.spread(f) : 0 });
  };
  if (res.pRound != null) {
    add(`round${res.round}:A`, `Round ${res.round}`, A, (s) => s.pRound);
    add(`round${res.round}:B`, `Round ${res.round}`, B, (s) => 1 - s.pRound);
  }
  const mapLabel = `Map${match.mapNumber ? ' ' + match.mapNumber : ''}`;
  if (!res.over) {
    add('map:A', `${mapLabel} — vainqueur`, A, (s) => s.pMap);
    add('map:B', `${mapLabel} — vainqueur`, B, (s) => 1 - s.pMap);
    for (const line of TOTAL_LINES) {
      if (line < match.scoreA + match.scoreB) continue; // déjà dépassée
      const po = res.pOver(line);
      if (po < 0.03 || po > 0.97) continue; // pratiquement jouée
      add(`tot${line}:O`, `${mapLabel} — total rounds`, `Plus de ${num(line)}`, (s) => s.pOver(line));
      add(`tot${line}:U`, `${mapLabel} — total rounds`, `Moins de ${num(line)}`, (s) => 1 - s.pOver(line));
    }
    for (const h of [-4.5, -3.5, -2.5, 2.5, 3.5, 4.5]) {
      add(`hcp${h}:A`, `${mapLabel} — handicap`, `${A} ${fmtLine(h)}`, (s) => s.pCover(h));
    }
    add('ot:Y', `${mapLabel} — prolongation`, 'Oui', (s) => s.pOT);
    add('ot:N', `${mapLabel} — prolongation`, 'Non', (s) => 1 - s.pOT);
  }
  if (res.pSeries != null) {
    add('series:A', 'Série — vainqueur', A, (s) => s.pSeries);
    add('series:B', 'Série — vainqueur', B, (s) => 1 - s.pSeries);
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
// Stabilité :
//  - probabilité prudente p − k·sd : le pari doit rester bon si les équipes sont un peu
//    plus proches que ne l'estime le modèle (k plein pour les tendances, moitié pour les
//    paris VALUE où la cote du bookmaker apporte déjà sa marge) ;
//  - hystérésis : un pari déjà affiché (opts.prev) reste tant qu'il ne passe pas sous un
//    seuil de sortie plus bas que le seuil d'entrée, et garde sa place dans son marché.
export const PICK = { k: 1, kValue: 0.5, leanIn: 0.6, leanOut: 0.55, leanMax: 0.88, leanMaxOut: 0.92, valueOut: 0.5 };

export function recommend(list, oddsById, conf, opts = {}) {
  const minEdge = opts.minEdge ?? 0.04;
  const prev = opts.prev ?? new Set();
  const k = opts.k ?? PICK.k;
  const kv = opts.kValue ?? PICK.kValue;
  const values = [];
  const leans = new Map();
  for (const m of list) {
    const odds = oddsById[m.id];
    const held = prev.has(m.id);
    const pc = Math.max(1e-3, m.p - k * (m.sd || 0));
    const pv = Math.max(1e-3, m.p - kv * (m.sd || 0));
    const fair = 1 / m.p;
    const target = (1 / pc) * (1 + minEdge);
    const ev = evaluateBet(pv, odds);
    if (ev && ev.ev >= (held ? minEdge * PICK.valueOut : minEdge)) {
      values.push({ ...m, pc: pv, odds, fair, target: (1 / pv) * (1 + minEdge), ev: ev.ev, stake: ev.stake * conf, kind: 'value' });
    } else if (!odds && pc >= (held ? PICK.leanOut : PICK.leanIn) && m.p <= (held ? PICK.leanMaxOut : PICK.leanMax)) {
      const cur = leans.get(m.group);
      const better = !cur || (held && !cur.held) || (held === cur.held && pc > cur.pc);
      if (better) leans.set(m.group, { ...m, pc, fair, target, held, kind: 'lean' });
    }
  }
  values.sort((x, y) => y.ev - x.ev);
  return [...values, ...leans.values()].slice(0, opts.max ?? 5);
}
