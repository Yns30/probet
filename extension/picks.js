// Paris affichés, stabilisés dans le temps.
//  - VALUE (cotes saisies) : recalculés en direct, avec hystérésis.
//  - TENDANCE (sans cote) : choisis entre les rounds (pause, achat) puis figés pendant le
//    round, pour ne pas changer à chaque kill. Une tendance figée disparaît seulement si
//    son marché n'existe plus ou si la sélection n'est plus favorite (< 50 %).
import { recommend } from './engine.js';

const LIVE = new Set(['live', 'bomb_planted']);

// state : objet persistant par match (mem.picks), modifié sur place.
export function stablePicks(state, { list, odds = {}, conf = 1, minEdge = 0.04, max = 4, phase, round, mapKey }) {
  const prev = new Set(state.shown || []);
  const cur = recommend(list, odds, conf, { minEdge, max: 99, prev });
  const values = cur.filter((p) => p.kind === 'value');
  const live = LIVE.has(phase);
  const snap = state.snap;
  let leans;
  if (!live || !snap || snap.mapKey !== mapKey || snap.round !== round) {
    leans = cur.filter((p) => p.kind === 'lean');
    state.snap = { mapKey, round, leans };
  } else {
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
