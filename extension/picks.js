// Paris affichés, stabilisés dans le temps.
//  - VALUE (cotes saisies) : recalculés en direct, avec hystérésis.
//  - TENDANCE (sans cote) : choisis entre les rounds et jusqu'au premier kill (le temps que
//    HLTV transmette les achats), puis figés jusqu'à la fin du round, pour ne pas changer
//    à chaque kill. Une tendance figée disparaît seulement si
//    son marché n'existe plus ou si la sélection n'est plus favorite (< 50 %).
import { recommend } from './engine.js';

const LIVE = new Set(['live', 'bomb_planted']);

// state : objet persistant par match (mem.picks), modifié sur place.
export function stablePicks(state, { list, odds = {}, conf = 1, minEdge = 0.04, max = 4, phase, round, mapKey, action }) {
  const prev = new Set(state.shown || []);
  const cur = recommend(list, odds, conf, { minEdge, max: 99, prev });
  let values = cur.filter((p) => p.kind === 'value');
  // action : le round a vraiment commencé (kill ou bombe). Inconnu → phase de jeu.
  const live = action ?? LIVE.has(phase);
  const snap = state.snap;
  let leans;
  if (!live || !snap || snap.mapKey !== mapKey || snap.round !== round) {
    leans = cur.filter((p) => p.kind === 'lean');
    state.snap = { mapKey, round, leans, values };
  } else {
    // Pendant le round, Stake ferme ses marchés ou garde la cote d'avant le round : un
    // « avantage » né d'un kill n'est pas jouable. Seuls restent les paris VALUE choisis
    // avant le début du round, tant que leur cote n'a pas changé.
    const now = new Map(values.map((v) => [v.id, v]));
    values = (snap.values || []).filter((v) => now.has(v.id) && odds[v.id] === v.odds).map((v) => ({ ...now.get(v.id), frozen: true }));
    const byId = new Map(list.map((m) => [m.id, m]));
    const valueIds = new Set(values.map((v) => v.id));
    leans = snap.leans
      .filter((l) => byId.has(l.id) && !odds[l.id] && !valueIds.has(l.id) && byId.get(l.id).p >= 0.5)
      .map((l) => ({ ...l, frozen: true, now: byId.get(l.id).p }));
  }
  const out = [...values, ...leans].slice(0, max);
  state.shown = out.map((p) => p.id);
  return out;
}
