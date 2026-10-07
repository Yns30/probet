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
    if (mk.status === 'removed') continue; // ligne retirée par Stake
    const open = mk.status === 'active';
    const put = (id, o) => {
      if (!id || !o) return;
      const ok = open && o.active !== false && o.odds > 1;
      out[id] = { odds: ok ? o.odds : null, at: o.seen ?? fixture.at };
    };
    // Marché suspendu sans issues (Stake les retire) : lignes connues, sans cote.
    const EXTS = { 24: ['4', '5'], 28: ['6', '7'] };
    const outcomes = mk.outcomes.length ? mk.outcomes
      : (EXTS[mk.tpl] || ['1', '2']).map((ext) => ({ ext, name: '', odds: null, active: false, seen: fixture.at }));
    const by = (ext) => outcomes.find((o) => o.ext === ext);
    switch (mk.tpl) {
      case '1': // vainqueur du match
        for (const o of outcomes) if (sideOf(o.ext)) put(`series:${sideOf(o.ext)}`, o);
        break;
      case '6': // vainqueur de la map (version à deux issues seulement)
        if (mk.spec.way === 'three' || mk.outcomes.some((o) => o.ext === '3')) break;
        for (const o of outcomes) if (sideOf(o.ext)) put(`map:${sideOf(o.ext)}`, o);
        break;
      case '10': { // vainqueur d'un round pistol
        const r = num(mk.spec.round);
        if (r > 0) for (const o of outcomes) if (sideOf(o.ext)) put(`round${r}:${sideOf(o.ext)}`, o);
        break;
      }
      case '11': { // handicap de rounds sur la map : « handicap » = celui de l'équipe à domicile
        const h = num(mk.spec.handicap);
        if (Number.isNaN(h)) break;
        // ProBet exprime la ligne du côté A : hcp{h}:A = A couvre h, hcp{h}:B = B couvre -h.
        const line = homeSide === 'A' ? h : -h;
        put(`hcp${line}:A`, by(homeSide === 'A' ? '1' : '2'));
        put(`hcp${line}:B`, by(homeSide === 'A' ? '2' : '1'));
        break;
      }
      case '24': { // total de rounds sur la map
        const t = num(mk.spec.threshold);
        if (Number.isNaN(t)) break;
        put(`tot${t}:U`, by('4') || outcomes.find((o) => /^(under|moins)/i.test(o.name)));
        put(`tot${t}:O`, by('5') || outcomes.find((o) => /^(over|plus)/i.test(o.name)));
        break;
      }
      case '28': // prolongation
        put('ot:Y', by('6') || outcomes.find((o) => /^(yes|oui)/i.test(o.name)));
        put('ot:N', by('7') || outcomes.find((o) => /^(no|non)\b/i.test(o.name)));
        break;
      default:
    }
  }
  return out;
}

// Lignes de total et de handicap (côté A) proposées par le bookmaker : ProBet calcule exactement
// celles-là, pour ne conseiller que des paris qui existent, avec leur vraie cote.
export function bookLines(odds) {
  const tot = new Set(), hcp = new Set();
  for (const id of Object.keys(odds || {})) {
    let m;
    if ((m = /^tot([\d.]+):[OU]$/.exec(id))) tot.add(Number(m[1]));
    else if ((m = /^hcp(-?[\d.]+):[AB]$/.exec(id))) hcp.add(Number(m[1]));
  }
  const sort = (x) => [...x].sort((a, b) => a - b);
  return { tot: sort(tot), hcp: sort(hcp) };
}

// Map dont il faut prendre les cotes. HLTV peut encore afficher la map qui vient de finir (ou
// mal compter les maps jouées) : si son score correspond à une map terminée chez Stake, c'est
// celle-là ; sinon, la map en cours chez Stake fait foi.
export function pickMapNumber(fixture, homeSide, hltv) {
  const { scoreA, scoreB, mapNumber } = hltv || {};
  for (const p of fixture?.periods || []) {
    if (p.home == null || p.away == null) continue;
    const [a, b] = homeSide === 'A' ? [p.home, p.away] : [p.away, p.home];
    if (a === scoreA && b === scoreB && Math.max(a, b) >= 13) return { map: p.map, why: 'finished' };
  }
  // Score de la map en cours chez Stake très différent de celui d'HLTV : pas la même map (ou
  // un des deux en retard) : on n'utilise pas les cotes de la map.
  const r = fixture?.rounds;
  if (r && r.home != null && scoreA != null) {
    const [a, b] = homeSide === 'A' ? [r.home, r.away] : [r.away, r.home];
    if (Math.abs(a - scoreA) + Math.abs(b - scoreB) > 3) return { map: null, why: 'desync' };
  }
  if (fixture?.mapNumber) return { map: fixture.mapNumber, why: fixture.mapNumber === mapNumber ? 'same' : 'stake' };
  return { map: mapNumber ?? null, why: 'hltv' };
}

// Stake a-t-il fermé les paris en direct sur la map en cours et le match ? (pause technique,
// round décisif, flux coupé…) Indique aussi les maps suivantes encore ouvertes.
export function bookClosure(fixture, mapNumber) {
  const mks = (fixture?.markets || []).filter((mk) => mk.status !== 'removed');
  const open = (mk) => mk.status === 'active' && mk.outcomes.some((o) => o.active !== false && o.odds > 1);
  const current = mks.filter((mk) => mk.tpl === '1' || Number(mk.spec?.map) === mapNumber);
  const later = new Set(mks.filter((mk) => Number(mk.spec?.map) > mapNumber && open(mk)).map((mk) => Number(mk.spec.map)));
  return { closed: current.length > 0 && !current.some(open), openMaps: [...later].sort((a, b) => a - b) };
}
