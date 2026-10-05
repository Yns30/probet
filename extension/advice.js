// Conseil de paris : un tableau fixe, toujours les mêmes lignes dans le même ordre (round,
// map, handicap, total, prolongation, série). Chaque ligne a un statut clair au lieu
// d'apparaître et de disparaître :
//   value : cote saisie suffisante → À JOUER (avantage, mise conseillée)
//   play  : sélection solide → À JOUER si la cote du bookmaker atteint la cote minimale
//   sure  : quasi acquis → la cote sera sûrement trop basse ; à jouer seulement si ≥ minimum
//   low   : cote saisie trop basse → PAS DE PARI
//   wait  : trop incertain → PAS DE PARI
//   none  : aucune ligne intéressante sur ce marché → PAS DE PARI
import { PICK, evaluateBet } from './engine.js';

export const CATEGORIES = [
  { key: 'round', label: (m) => m.group, test: (id) => id.startsWith('round') },
  { key: 'map', label: () => 'Vainqueur de la map', test: (id) => id.startsWith('map:') },
  { key: 'hcp', label: () => 'Handicap (écart de rounds)', test: (id) => id.startsWith('hcp') },
  { key: 'tot', label: () => 'Total de rounds', test: (id) => id.startsWith('tot') },
  { key: 'ot', label: () => 'Prolongation', test: (id) => id.startsWith('ot:') },
  { key: 'series', label: () => 'Vainqueur du match', test: (id) => id.startsWith('series:') },
];

// state : objet persistant par match (sélection affichée par marché, pour l'hystérésis).
export function buildAdvice(state, { list, picks, odds = {}, minEdge = 0.04 }) {
  state.fav ??= {};
  const rows = [];
  for (const cat of CATEGORIES) {
    const items = list.filter((m) => cat.test(m.id));
    if (!items.length) continue;
    const label = cat.label(items[0]);
    const inCat = picks.filter((p) => cat.test(p.id));
    const pick = inCat.find((p) => p.kind === 'value') ?? inCat[0];
    if (pick) {
      state.fav[cat.key] = pick.id;
      rows.push({ key: cat.key, label, id: pick.id, sel: pick.label, p: pick.p, status: pick.kind === 'value' ? 'value' : 'play',
        min: pick.target, odds: pick.odds ?? odds[pick.id] ?? null, ev: pick.ev, stake: pick.stake, frozen: pick.frozen, now: pick.now });
      continue;
    }
    // Pas de pari retenu : on montre quand même la sélection favorite et pourquoi on ne joue pas.
    if (cat.key === 'hcp' || cat.key === 'tot') {
      // Plusieurs lignes possibles : sans ligne intéressante, on ne choisit pas au hasard.
      rows.push({ key: cat.key, label, id: null, status: 'none' });
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
    rows.push({ key: cat.key, label, id: fav.id, sel: fav.label, p: fav.p, status, min, odds: o });
  }
  return rows;
}
