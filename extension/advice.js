// Conseil de paris : un tableau fixe, toujours les mêmes lignes dans le même ordre (map,
// handicap, total, prolongation, série). Chaque ligne a un statut clair au lieu d'apparaître et de disparaître :
//   value : cote saisie suffisante → À JOUER (avantage, mise conseillée)
//   play  : sélection solide → À JOUER si la cote du bookmaker atteint la cote minimale
//   sure  : quasi acquis → la cote sera sûrement trop basse ; à jouer seulement si ≥ minimum
//   low   : cote saisie trop basse → PAS DE PARI
//   wait  : trop incertain → PAS DE PARI
//   none  : aucune ligne intéressante sur ce marché → PAS DE PARI
import { PICK, evaluateBet } from './engine.js';

export const MAX_EXPOSURE = 0.05;
const STATUS = { value: 'value', lean: 'play', skip: 'skip' };

export const CATEGORIES = [
  // Handicap en tête : le marché le plus fiable du journal (81 % gagnés pour 82 % annoncé ;
  // paris VALUE les plus rentables).
  { key: 'hcp', label: () => 'Handicap (écart de rounds) · prioritaire', test: (id) => id.startsWith('hcp') },
  { key: 'map', label: () => 'Vainqueur de la map', test: (id) => id.startsWith('map:') },
  { key: 'tot', label: () => 'Total de rounds', test: (id) => id.startsWith('tot') },
  { key: 'ot', label: () => 'Prolongation', test: (id) => id.startsWith('ot:') },
  { key: 'series', label: () => 'Vainqueur du match', test: (id) => id.startsWith('series:') },
];

// state : objet persistant par match (sélection affichée par marché, pour l'hystérésis).
// Marchés à plusieurs lignes (handicap, total) : la ligne affichée est verrouillée pour le
// round. Après chaque round, Stake recalcule ses lignes une par une : prendre à chaque fois la
// meilleure faisait passer le conseil de −4,5 à −3,5 puis −2,5 en quelques secondes. On laisse
// SETTLE ms pour que les cotes se stabilisent, puis la ligne ne change plus avant le round
// suivant. D'un round à l'autre, la ligne précédente est gardée si elle reste presque aussi bonne.
export const LINE_LOCK = { settle: 4000, keep: 0.05 };
const MULTI = new Set(['hcp', 'tot']);

export function buildAdvice(state, { list, picks, odds = {}, minEdge = 0.04, round = null, now = Date.now() }) {
  state.fav ??= {};
  state.lock ??= {};
  const rows = [];
  const pcOf = (m) => Math.max(1e-3, m.p - PICK.kValue * (m.sd || 0));
  for (const cat of CATEGORIES) {
    const items = list.filter((m) => cat.test(m.id));
    if (!items.length) continue;
    const label = cat.label(items[0]);
    const inCat = picks.filter((p) => cat.test(p.id));
    if (MULTI.has(cat.key) && round != null) {
      const row = lockedLine(state, cat.key, { items, inCat, odds, round, now, pcOf, minEdge });
      rows.push(row ? { key: cat.key, label, ...row } : { key: cat.key, label, id: null, status: 'none' });
      continue;
    }
    const pick = inCat.find((p) => p.kind === 'value') ?? inCat[0];
    if (pick) {
      state.fav[cat.key] = pick.id;
      rows.push({ key: cat.key, label, id: pick.id, sel: pick.label, p: pick.p, status: STATUS[pick.kind], reason: pick.reason,
        min: pick.target, odds: pick.odds ?? odds[pick.id] ?? null, ev: pick.ev, stake: pick.stake, frozen: pick.frozen, now: pick.now,
        pm: pick.pModel, pk: pick.pMkt });
      continue;
    }
    // Pas de pari retenu : on montre quand même la sélection favorite et pourquoi on ne joue pas.
    if (cat.key === 'hcp' || cat.key === 'tot') {
      // Plusieurs lignes : on montre celle dont la cote du bookmaker est la plus proche d'un
      // pari rentable, avec la cote à attendre. Sans cote, on ne choisit pas au hasard.
      const priced = items.filter((m) => odds[m.id] > 1 && m.p >= 0.35);
      if (!priced.length) { rows.push({ key: cat.key, label, id: null, status: 'none' }); continue; }
      const pcOf = (m) => Math.max(1e-3, m.p - PICK.kValue * (m.sd || 0));
      const best = priced.reduce((a, b) => (pcOf(b) * odds[b.id] > pcOf(a) * odds[a.id] ? b : a));
      rows.push({ key: cat.key, label, id: best.id, sel: best.label, p: best.p, status: 'low',
        min: (1 / pcOf(best)) * (1 + minEdge), odds: odds[best.id], pm: best.pModel, pk: best.pMkt });
      continue;
    }
    // Favori stable : la sélection déjà affichée reste tant qu'elle n'est pas nettement passée sous 50 %.
    const prev = items.find((m) => m.id === state.fav[cat.key]);
    const best = items.reduce((a, b) => (b.p > a.p ? b : a));
    const fav = prev && prev.p >= 0.45 ? prev : best;
    state.fav[cat.key] = fav.id;
    // Même règle que pour valider une cote saisie (paris VALUE) : saisir au moins cette cote
    // fait passer la ligne en « À JOUER ».
    const pc = Math.max(1e-3, fav.p - PICK.kValue * (fav.sd || 0));
    const min = (1 / pc) * (1 + minEdge);
    const o = odds[fav.id] ?? null;
    let status;
    if (o && (evaluateBet(pc, o)?.ev ?? -1) < minEdge) status = 'low';
    else if (fav.p > PICK.leanMax) status = 'sure';
    else status = 'wait';
    rows.push({ key: cat.key, label, id: fav.id, sel: fav.label, p: fav.p, status, min, odds: o, pm: fav.pModel, pk: fav.pMkt });
  }
  // Les paris d'une même map vont souvent dans le même sens (map, handicap, série de la même
  // équipe) : ils gagnent ou perdent ensemble. Mise totale plafonnée.
  const total = rows.reduce((s, r) => s + (r.status === 'value' ? r.stake || 0 : 0), 0);
  if (total > MAX_EXPOSURE) for (const r of rows) if (r.status === 'value') r.stake *= MAX_EXPOSURE / total;
  return rows;
}

// Ligne choisie pour un marché à plusieurs lignes, verrouillée pour le round (voir LINE_LOCK).
function lockedLine(state, key, { items, inCat, odds, round, now, pcOf, minEdge }) {
  const has = (id) => id && items.some((m) => m.id === id);
  const values = inCat.filter((p) => p.kind === 'value'); // triés par avantage décroissant
  const ev = (id) => values.find((v) => v.id === id)?.ev;
  const lock = state.lock[key];
  const settled = lock && lock.round === round && now - lock.at >= LINE_LOCK.settle;
  let id = null;
  if (settled && has(lock.id)) id = lock.id;
  else {
    const prev = has(lock?.id) ? lock.id : null;
    const best = values[0];
    if (prev && ev(prev) != null && (!best || ev(prev) >= best.ev - LINE_LOCK.keep)) id = prev;
    else if (best) id = best.id;
    else if (prev && odds[prev] > 1) id = prev;
    else if (inCat.some((x) => x.kind === 'skip')) id = inCat.find((x) => x.kind === 'skip').id;
    else {
      const lean = inCat.find((p) => p.kind === 'lean');
      const priced = items.filter((m) => odds[m.id] > 1 && m.p >= 0.35);
      if (lean) id = lean.id;
      else if (priced.length) id = priced.reduce((a, b) => (pcOf(b) * odds[b.id] > pcOf(a) * odds[a.id] ? b : a)).id;
    }
    if (id) state.lock[key] = { id, round, at: lock?.round === round && lock.id === id ? lock.at : now };
  }
  if (!id) return null;
  const v = values.find((x) => x.id === id);
  const sk = !v && inCat.find((x) => x.id === id && x.kind === 'skip');
  if (sk) return { id, sel: sk.label, p: sk.p, status: 'skip', reason: sk.reason, min: sk.target, odds: sk.odds, ev: sk.ev, pm: sk.pModel, pk: sk.pMkt, locked: true };
  if (v) {
    return { id, sel: v.label, p: v.p, status: 'value', min: v.target, odds: v.odds ?? odds[id] ?? null, ev: v.ev,
      stake: v.stake, frozen: v.frozen, now: v.now, pm: v.pModel, pk: v.pMkt, locked: true };
  }
  const m = items.find((x) => x.id === id);
  const lean = inCat.find((p) => p.id === id && p.kind === 'lean');
  const min = lean?.target ?? (1 / pcOf(m)) * (1 + minEdge);
  const status = odds[id] > 1 ? 'low' : lean ? 'play' : 'wait';
  return { id, sel: m.label, p: m.p, status, min, odds: odds[id] ?? null, pm: m.pModel, pk: m.pMkt, frozen: lean?.frozen, locked: true };
}
