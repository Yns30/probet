// Cotes Stake 100 % automatiques : rien à lier, rien à cliquer.
// Tourne dans la page Stake (monde MAIN, dès le chargement) et lit les mêmes données que le site,
// quel que soit l'onglet affiché (Principal, Map 2, Map 3…) :
//  1. au chargement : le JSON du match intégré à la page (réponse GraphQL « slugFixture » :
//     équipes, map en cours, TOUS les marchés de tous les onglets avec leurs cotes) ;
//  2. en direct : les mises à jour reçues par le site (fetch et WebSocket), reconnues par les
//     identifiants des marchés et des issues, quel que soit le format du message ;
//  3. relecture : la même requête que le site est rejouée régulièrement, pour que les marchés
//     des onglets non affichés restent à jour (nouvelles lignes, marchés suspendus ou retirés) ;
//  4. en complément : les boutons de cote affichés à l'écran.
// Chaque changement est envoyé aussitôt à stake-relay.js (sans attendre un minuteur : Chrome
// ralentit les minuteurs des onglets en arrière-plan).
// Fonctions pures exposées sur globalThis.__probetStakeCore (tests).
(() => {
  // Marchés utiles à ProBet (identifiants de modèle Oddin, identiques dans toutes les langues).
  const TEMPLATES = new Set(['1', '6', '10', '11', '24', '28']);
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

  function parseSpecifiers(s) {
    const out = {};
    for (const part of String(s || '').split('|')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
    }
    return out;
  }
  // « 1re map », « 2e map », « Map 3 », « 3rd map » → 1, 2, 3.
  function mapNumberOf(status) {
    const m = /(\d+)/.exec(String(status || ''));
    return m && /map|carte/i.test(status) ? Number(m[1]) : null;
  }

  // Modèle du match suivi : marchés et issues indexés par identifiant.
  function createModel() {
    return { fixture: null, markets: new Map(), outcomes: new Map(), dom: new Map(), src: {} };
  }
  function ingestFixture(model, f, now) {
    const comps = f.data?.competitors || [];
    const teams = f.data?.teams || [];
    const side = (q, i) => {
      const t = teams.find((x) => x.qualifier === q);
      const c = comps.find((x) => t && x.extId === t.extId) || comps[i] || {};
      return { name: t?.name || c.name || '', abbr: c.abbreviation || '' };
    };
    const prev = model.fixture?.id === f.id ? model.fixture : null;
    if (!prev) { model.markets.clear(); model.outcomes.clear(); model.dom.clear(); }
    model.fixture = {
      ...prev, id: f.id, slug: f.slug ?? prev?.slug, name: f.name ?? prev?.name, status: f.status ?? prev?.status,
      keys: [f.id, f.stakeFixtureId, f.extId, f.slug].filter(Boolean),
      home: f.data ? side('home', 0) : prev?.home, away: f.data ? side('away', 1) : prev?.away,
    };
    if (f.eventStatus) ingestStatus(model, f.eventStatus);
    // Un même marché peut figurer dans plusieurs groupes (Principal, Cartes…) : dédoublonné par id.
    const seenIds = new Set(), seenTpl = new Set();
    for (const g of f.groups || []) {
      for (const t of g.templates || []) {
        for (const mk of t.markets || []) {
          if (seenIds.has(mk.id)) continue;
          seenIds.add(mk.id);
          seenTpl.add(String(mk.templateExtId ?? t.extId ?? ''));
          ingestMarket(model, mk, now, true);
        }
      }
    }
    // Lignes retirées par Stake (ex. handicap -4,5 qui n'est plus proposé) : plus utilisables.
    for (const m of model.markets.values()) {
      if (seenTpl.has(m.tpl) && !seenIds.has(m.id)) { m.status = 'removed'; m.seen = now; }
    }
  }
  function ingestStatus(model, es) {
    const fx = model.fixture;
    if (!fx || !es) return;
    if (es.matchStatus != null) { fx.matchStatus = es.matchStatus; fx.mapNumber = mapNumberOf(es.matchStatus) ?? fx.mapNumber; }
    if (es.homeScore != null) fx.score = { home: es.homeScore, away: es.awayScore };
    const sb = es.scoreboard;
    if (sb && sb.homeWonRounds != null) fx.rounds = { home: sb.homeWonRounds, away: sb.awayWonRounds };
  }
  // full : la liste d'issues reçue est complète (une issue absente n'est plus jouable).
  function ingestMarket(model, mk, now, full = false) {
    const tpl = String(mk.templateExtId ?? model.markets.get(mk.id)?.tpl ?? '');
    if (!mk.id || !TEMPLATES.has(tpl)) return false;
    let market = model.markets.get(mk.id);
    if (!market) {
      market = { id: mk.id, tpl, spec: parseSpecifiers(mk.specifiers), name: String(mk.name || '').trim(), outcomes: [] };
      model.markets.set(mk.id, market);
    }
    if (mk.status) market.status = mk.status;
    market.seen = now;
    if (Array.isArray(mk.outcomes)) {
      const got = new Set();
      for (const o of mk.outcomes) {
        got.add(o.id);
        let out = model.outcomes.get(o.id);
        if (!out) {
          out = { id: o.id, ext: String(o.extId ?? ''), name: String(o.name || '').trim(), odds: null, active: true, seen: now, market: mk.id };
          model.outcomes.set(o.id, out);
          market.outcomes.push(out);
          model.dom.set(`${norm(market.name)}|${norm(out.name)}`, out);
        }
        if (typeof o.odds === 'number') out.odds = o.odds;
        if (typeof o.active === 'boolean') out.active = o.active;
        out.seen = now;
      }
      if (full || mk.outcomes.length) {
        for (const out of market.outcomes) if (!got.has(out.id)) { out.active = false; out.seen = now; }
      }
    }
    return true;
  }
  const looksLikeMarket = (o) => typeof o.specifiers === 'string' && Array.isArray(o.outcomes) && (o.templateExtId != null || o.extId != null);
  // Parcourt n'importe quelle réponse ou message du site et applique ce qui concerne le match suivi.
  // slug : celui de la page affichée (pour ignorer les autres matchs listés sur le côté).
  // ours : le message mentionne ce match (identifiant ou slug) : un marché encore inconnu
  // (nouvelle ligne de handicap ou de total) peut y être ajouté sans risque de mélange.
  function applyPayload(model, data, slug, now, source = 'net', ours = false) {
    let touched = false;
    const stack = [[data, 0]];
    while (stack.length) {
      const [o, depth] = stack.pop();
      if (!o || typeof o !== 'object' || depth > 40) continue;
      if (Array.isArray(o)) { for (const x of o) stack.push([x, depth + 1]); continue; }
      if (Array.isArray(o.groups) && o.slug && (!slug || o.slug === slug)) {
        ingestFixture(model, o, now); touched = true; continue;
      }
      if (o.id != null && model.fixture) {
        const out = model.outcomes.get(o.id);
        if (out) {
          if (typeof o.odds === 'number') out.odds = o.odds;
          if (typeof o.active === 'boolean') out.active = o.active;
          out.seen = now; touched = true;
        }
        if (model.markets.has(o.id) || (ours && looksLikeMarket(o))) {
          const mk = model.markets.get(o.id);
          if (ingestMarket(model, { ...o, templateExtId: o.templateExtId ?? mk?.tpl, name: o.name ?? mk?.name }, now)) touched = true;
        }
        if (o.id === model.fixture.id) {
          if (typeof o.status === 'string') model.fixture.status = o.status;
          if (o.eventStatus) ingestStatus(model, o.eventStatus);
          touched = true;
        }
      }
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === 'object') stack.push([v, depth + 1]);
      }
    }
    if (touched) model.src[source] = now;
    return touched;
  }
  const mentionsFixture = (model, text) => Boolean(model.fixture?.keys?.some((k) => text.includes(k)));

  // Bouton affiché sans libellé complet (tableaux « Plus de / Moins de », colonnes par équipe) :
  // retrouvé par le titre du marché, l'en-tête de colonne et la ligne (« 16.5 », « -9.5 »).
  function matchDomOutcome(model, title, label, name, heading) {
    const direct = label && model.dom.get(`${norm(title)}|${norm(label)}`);
    if (direct) return direct;
    const fx = model.fixture;
    const line = /-?\d+(?:[.,]\d+)?/.exec(String(name || ''))?.[0]?.replace(',', '.');
    if (!fx || !heading || !line) return null;
    const h = norm(heading);
    const ext = h === norm(fx.home?.name) ? '1' : h === norm(fx.away?.name) ? '2'
      : /plus|over|más|mais|über/.test(h) ? '5' : /moins|under|menos|unter/.test(h) ? '4' : null;
    if (!ext) return null;
    const esc = line.replace(/[.\-]/g, '\\$&');
    const re = new RegExp(`(^|[^\\d.\\-])${esc}(?![\\d.])`);
    const t = norm(title);
    for (const m of model.markets.values()) {
      if (norm(m.name) !== t) continue;
      const o = m.outcomes.find((x) => x.ext === ext && re.test(x.name));
      if (o) return o;
    }
    return null;
  }

  // Résumé envoyé au panneau : uniquement les marchés utiles. « seen » : dernière confirmation de
  // la cote (affichée, reçue du site ou relue).
  function snapshot(model, now) {
    const fx = model.fixture;
    if (!fx) return null;
    const { keys, ...info } = fx;
    return {
      ...info, at: now, src: { ...model.src },
      markets: [...model.markets.values()].map((m) => ({
        tpl: m.tpl, spec: m.spec, name: m.name, status: m.status || 'active',
        outcomes: m.outcomes.map((o) => ({ ext: o.ext, name: o.name, odds: o.odds, active: o.active, seen: o.seen })),
      })),
    };
  }

  // Requête de relecture du match (champs identiques à ceux de la réponse du site).
  const FIXTURE_FIELDS = `id slug name status
    eventStatus { ... on EsportFixtureEventStatus { matchStatus homeScore awayScore scoreboard { homeWonRounds awayWonRounds } } }
    data { ... on SportFixtureDataMatch { competitors { name abbreviation extId } teams { name qualifier extId } } }
    groups { name templates { extId markets { id name status specifiers extId templateExtId outcomes { id name odds active extId } } } }`;
  const fixtureQueries = (slug) => [
    { query: `query ProbetFixture($fixture: String!) { slugFixture(fixture: $fixture) { ${FIXTURE_FIELDS} } }`, variables: { fixture: slug } },
    { query: `query ProbetFixture($slug: String!) { slugFixture(slug: $slug) { ${FIXTURE_FIELDS} } }`, variables: { slug } },
  ];

  globalThis.__probetStakeCore = { parseSpecifiers, mapNumberOf, createModel, ingestFixture, applyPayload, snapshot, matchDomOutcome, mentionsFixture, fixtureQueries, norm };
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.__probetStake) return;
  window.__probetStake = true;

  const model = createModel();
  const pageSlug = () => location.pathname.split('/').filter(Boolean).pop() || '';
  const onData = (data, source, ours) => {
    try { if (applyPayload(model, data, pageSlug(), Date.now(), source, ours)) send(); } catch { /* format inattendu */ }
  };
  const onText = (text, source) => {
    if (typeof text !== 'string' || text.length > 5e6 || !/odds|status|groups/.test(text)) return;
    let data;
    try { data = JSON.parse(text); } catch { return; }
    onData(data, source, mentionsFixture(model, text));
  };

  // 1. Réseau : réponses de l'API du site. On retient aussi la requête GraphQL du site (en-têtes,
  // et la requête du match si le site la fait) pour pouvoir la rejouer.
  const GQL = /\/_api\/v1\/graphql/;
  let gqlHeaders = null; // en-têtes des requêtes GraphQL du site (langue, jeton…)
  let replay = null; // requête « slugFixture » du site, rejouée telle quelle
  const origFetch = window.fetch;
  const pickHeaders = (h) => {
    const out = {};
    try { new Headers(h || {}).forEach((v, k) => { if (!/^(content-length|cookie)$/i.test(k)) out[k] = v; }); } catch { /* ignore */ }
    return out;
  };
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = String(req?.url || req || '');
      if (/\/_api\//.test(url) && /json/.test(res.headers.get('content-type') || '')) {
        if (GQL.test(url) && !(req instanceof Request) && typeof args[1]?.body === 'string') {
          gqlHeaders = pickHeaders(args[1].headers);
          if (/slugFixture/.test(args[1].body)) replay = { url, body: args[1].body, headers: gqlHeaders };
        }
        res.clone().text().then((t) => onText(t, 'fetch'), () => {});
      }
    } catch { /* ignore */ }
    return res;
  };
  // Flux temps réel (WebSocket) : chaque message est examiné.
  const OrigWS = window.WebSocket;
  if (OrigWS) {
    window.WebSocket = new Proxy(OrigWS, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget);
        try { ws.addEventListener('message', (e) => onText(e.data, 'ws')); } catch { /* ignore */ }
        return ws;
      },
    });
  }

  // 2. Données intégrées à la page au chargement (SvelteKit).
  function readEmbedded() {
    for (const s of document.querySelectorAll('script[data-sveltekit-fetched]')) {
      if (s.__probet) continue;
      s.__probet = true;
      if (!/"groups"|groups\\"/.test(s.textContent)) continue;
      try {
        const o = JSON.parse(s.textContent);
        onData(typeof o.body === 'string' ? JSON.parse(o.body) : o.body ?? o, 'page', true);
      } catch { /* ignore */ }
    }
  }

  // 3. Relecture complète du match toutes les 5 s (ralentie par Chrome si l'onglet est caché).
  let queryIdx = 0, pollMode = 'off', polling = false, lastPoll = 0;
  async function poll() {
    const slug = pageSlug();
    if (polling || !model.fixture || model.fixture.slug !== slug || Date.now() - lastPoll < 4500) return;
    polling = true; lastPoll = Date.now();
    try {
      let req = replay;
      if (!req) {
        const q = fixtureQueries(slug)[queryIdx];
        if (!q) return; // aucune requête ne fonctionne : flux et écran seulement
        req = { url: '/_api/v1/graphql', body: JSON.stringify(q), headers: { ...gqlHeaders, 'content-type': 'application/json' } };
      }
      const res = await origFetch(req.url, { method: 'POST', credentials: 'include', headers: req.headers, body: req.body });
      const json = await res.json();
      if (json?.data?.slugFixture) {
        applyPayload(model, json.data, slug, Date.now(), 'poll', true);
        pollMode = replay ? 'replay' : 'query';
        send();
      } else if (!replay) { queryIdx++; pollMode = 'off'; }
    } catch { if (!replay) queryIdx++; } finally { polling = false; }
  }

  // 4. Boutons de cote affichés : la valeur à l'écran fait foi.
  function readDom() {
    const now = Date.now();
    let touched = false;
    for (const b of document.querySelectorAll('button[data-testid="fixture-outcome"]')) {
      const title = b.closest('.secondary-accordion')?.querySelector('.header')?.textContent;
      if (!title) continue;
      const col = b.closest('.column');
      const table = col?.parentElement;
      let heading = null;
      if (table) {
        const heads = [...table.children].filter((c) => c.classList.contains('heading'));
        const cols = [...table.children].filter((c) => c.classList.contains('column') && !c.classList.contains('heading'));
        if (heads.length) heading = heads[cols.indexOf(col) % heads.length]?.textContent;
      }
      const name = b.querySelector('[data-testid="outcome-button-name"]')?.textContent;
      const out = matchDomOutcome(model, title, b.getAttribute('aria-label'), name, heading);
      if (!out) continue;
      const txt = b.querySelector('[data-testid="fixture-odds"]')?.textContent || '';
      const m = /(\d+)[.,](\d+)/.exec(txt);
      const odds = m ? Number(`${m[1]}.${m[2]}`) : null;
      if (odds > 1) out.odds = odds;
      out.active = !b.disabled && odds > 1;
      out.seen = now; touched = true;
      // Cote affichée et cliquable : le marché est ouvert (Stake affiche « suspendu » sinon).
      const mk = model.markets.get(out.market);
      if (mk && out.active) mk.status = 'active';
    }
    if (touched) model.src.dom = now;
  }

  let lastSent = '', lastAt = 0;
  function send() {
    const now = Date.now();
    const snap = snapshot(model, now);
    if (!snap || snap.slug !== pageSlug()) return;
    snap.pollMode = pollMode;
    const key = JSON.stringify([snap.matchStatus, snap.rounds, snap.markets.map((m) => [m.status, m.outcomes.map((o) => [o.odds, o.active])])]);
    if (key === lastSent && now - lastAt < 3000) return;
    lastSent = key; lastAt = now;
    window.postMessage({ source: 'probet-stake', fixture: snap }, location.origin);
  }
  let lastDom = 0;
  function tick() {
    readEmbedded();
    readDom(); lastDom = Date.now();
    poll();
    send();
  }
  const start = () => {
    readEmbedded();
    setInterval(tick, 1000);
    // Cotes qui changent à l'écran : relues tout de suite, sans attendre le minuteur.
    new MutationObserver(() => {
      if (Date.now() - lastDom < 400) return;
      lastDom = Date.now();
      readDom(); send();
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
