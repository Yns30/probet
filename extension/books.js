// Cotes lues automatiquement chez un bookmaker (Stake) → marchés ProBet.
// Le match est retrouvé par les noms d'équipes, sans rien demander à l'utilisateur.
// Identifiants d'issues Oddin (standard, toutes langues) : 1 = domicile, 2 = extérieur,
// 4 = moins, 5 = plus, 6 = oui, 7 = non.

const STOP = new Set(['team', 'esports', 'esport', 'gaming', 'club', 'the', 'gg']);
export function teamKey(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).join('');
}
// Les deux noms désignent-ils la même équipe ? (« Team Falcons » / « Falcons », « NaVi » / « Natus Vincere »)
export function sameTeam(hltvName, team) {
  const h = teamKey(hltvName);
  if (!h) return false;
  for (const n of [team?.name, team?.abbr]) {
    const k = teamKey(n);
    if (!k) continue;
    if (k === h) return true;
    if (Math.min(k.length, h.length) >= 4 && (k.includes(h) || h.includes(k))) return true;
  }
  // Sigle : « navi » ↔ « Natus Vincere » (initiales ou début des mots).
  const words = String(hltvName || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
  const abbr = teamKey(team?.abbr);
  if (abbr && words.length > 1) {
    const initials = words.map((w) => w[0]).join('');
    const heads = words.map((w) => w.slice(0, 2)).join('');
    if (abbr === initials || abbr === heads) return true;
  }
  return false;
}
// Côté ProBet (A/B) de l'équipe à domicile chez le bookmaker, ou null si ce n'est pas ce match.
export function homeSideOf(fixture, [A, B]) {
  if (!fixture?.home || !fixture?.away) return null;
  if (sameTeam(A, fixture.home) && sameTeam(B, fixture.away)) return 'A';
  if (sameTeam(B, fixture.home) && sameTeam(A, fixture.away)) return 'B';
  return null;
}
export function findFixture(fixtures, names) {
  for (const f of fixtures) {
    const homeSide = homeSideOf(f, names);
    if (homeSide) return { fixture: f, homeSide };
  }
  return null;
}

const num = (x) => (x == null || x === '' ? NaN : Number(x));
// Cotes ProBet { marketId: { odds, at } } pour la map en cours (odds null : marché suspendu).
export function bookOdds(fixture, homeSide, mapNumber) {
  const out = {};
  const other = (s) => (s === 'A' ? 'B' : 'A');
  const sideOf = (ext) => (ext === '1' ? homeSide : ext === '2' ? other(homeSide) : null);
  for (const mk of fixture.markets || []) {
    const map = num(mk.spec?.map);
    if (mk.tpl !== '1' && map !== mapNumber) continue;
    const open = mk.status === 'active';
    const put = (id, o) => {
      if (!id || !o) return;
      const ok = open && o.active !== false && o.odds > 1;
      out[id] = { odds: ok ? o.odds : null, at: o.seen ?? fixture.at };
    };
    const by = (ext) => mk.outcomes.find((o) => o.ext === ext);
    switch (mk.tpl) {
      case '1': // vainqueur du match
        for (const o of mk.outcomes) if (sideOf(o.ext)) put(`series:${sideOf(o.ext)}`, o);
        break;
      case '6': // vainqueur de la map (version à deux issues seulement)
        if (mk.spec.way === 'three' || mk.outcomes.some((o) => o.ext === '3')) break;
        for (const o of mk.outcomes) if (sideOf(o.ext)) put(`map:${sideOf(o.ext)}`, o);
        break;
      case '10': { // vainqueur d'un round pistol
        const r = num(mk.spec.round);
        if (r > 0) for (const o of mk.outcomes) if (sideOf(o.ext)) put(`round${r}:${sideOf(o.ext)}`, o);
        break;
      }
      case '11': { // handicap de rounds sur la map : handicap = celui de l'équipe à domicile
        const h = num(mk.spec.handicap);
        if (Number.isNaN(h)) break;
        // ProBet exprime le handicap du côté A : A à domicile → issue 1 avec h, sinon issue 2 avec -h.
        if (homeSide === 'A') put(`hcp${h}:A`, by('1'));
        else put(`hcp${-h}:A`, by('2'));
        break;
      }
      case '24': { // total de rounds sur la map
        const t = num(mk.spec.threshold);
        if (Number.isNaN(t)) break;
        put(`tot${t}:U`, by('4') || mk.outcomes.find((o) => /^(under|moins)/i.test(o.name)));
        put(`tot${t}:O`, by('5') || mk.outcomes.find((o) => /^(over|plus)/i.test(o.name)));
        break;
      }
      case '28': // prolongation
        put('ot:Y', by('6') || mk.outcomes.find((o) => /^(yes|oui)/i.test(o.name)));
        put('ot:N', by('7') || mk.outcomes.find((o) => /^(no|non)\b/i.test(o.name)));
        break;
      default:
    }
  }
  return out;
}
