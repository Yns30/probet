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
    // Statut sans numéro (« Pause »…) pendant une map : maps gagnées + 1.
    if (es.matchStatus != null && mapNumberOf(es.matchStatus) == null && es.scoreboard?.homeWonRounds != null && fx.score) {
      fx.mapNumber = fx.score.home + fx.score.away + 1;
    }
    const sb = es.scoreboard;
    if (sb && sb.homeWonRounds != null) fx.rounds = { home: sb.homeWonRounds, away: sb.awayWonRounds };
    else if ('scoreboard' in es) fx.rounds = null; // entre deux maps : plus de score en cours
    // Scores des maps (terminées ou en cours) : servent à savoir quelle map HLTV affiche.
    if (Array.isArray(es.periodScores)) {
      fx.periods = es.periodScores.map((p) => ({
        map: p.number ?? mapNumberOf(p.matchStatus), home: p.homeWonRounds ?? null, away: p.awayWonRounds ?? null,
      })).filter((p) => p.map);
    }
  }
  // Cote ou disponibilité d'une issue ; chg = heure du dernier vrai changement (une cote qui
  // n'a pas bougé depuis la fin du dernier round n'a pas encore été recalculée par Stake).
  function setOutcome(out, odds, active, now) {
    if (typeof odds === 'number' && odds !== out.odds) { out.odds = odds; out.chg = now; }
    if (typeof active === 'boolean' && active !== out.active) { out.active = active; out.chg = now; }
    out.seen = now;
  }
  function setStatus(market, status, now) {
    if (status && status !== market.status) { market.status = status; market.chg = now; }
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
    setStatus(market, mk.status, now);
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
        setOutcome(out, o.odds, o.active, now);
      }
      if (full || mk.outcomes.length) {
        for (const out of market.outcomes) if (!got.has(out.id)) setOutcome(out, null, false, now);
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
          setOutcome(out, o.odds, o.active, now); touched = true;
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
        outcomes: m.outcomes.map((o) => ({ ext: o.ext, name: o.name, odds: o.odds, active: o.active, seen: o.seen, chg: Math.max(o.chg ?? 0, m.chg ?? 0) || null })),
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

  // Diagnostic : rien de ce qui concerne le compte (e-mail, solde, identité, jetons) n'est gardé.
  const SENSITIVE = /email|balance|kyc|phone|address|intercom|password|token|seed|birthday|"dob"|firstName|lastName|session|cookie|authorization|apiKey/i;
  const diagSafe = (text) => typeof text === 'string' && !SENSITIVE.test(text);

  globalThis.__probetStakeCore = { diagSafe, parseSpecifiers, mapNumberOf, createModel, ingestFixture, applyPayload, snapshot, matchDomOutcome, mentionsFixture, fixtureQueries, norm };
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.__probetStake) return;
  window.__probetStake = true;

  const model = createModel();
  // Enregistrement de diagnostic (bouton « Diagnostic Stake » du panneau), 45 s.
  let diag = null;
  const clip = (t, n = 6000) => (t.length > n ? `${t.slice(0, n)}…[${t.length} car.]` : t);
  function rec(kind, text, n) {
    if (!diag || Date.now() > diag.until || typeof text !== 'string') return;
    diag.count[kind] = (diag.count[kind] || 0) + 1;
    if (!diagSafe(text)) { diag.skipped[kind] = (diag.skipped[kind] || 0) + 1; return; }
    if ((diag[kind] ??= []).length < 40) diag[kind].push({ t: Date.now() - diag.start, data: clip(text, n) });
  }
  function diagSummary() {
    const byMarket = {};
    for (const m of model.markets.values()) {
      const k = `tpl${m.tpl} map${m.spec.map ?? '-'} ${m.status || '?'}`;
      byMarket[k] = (byMarket[k] || 0) + 1;
    }
    const fx = model.fixture;
    return {
      version: 2, page: location.pathname, fixture: fx && { name: fx.name, slug: fx.slug, status: fx.status, matchStatus: fx.matchStatus, mapNumber: fx.mapNumber, rounds: fx.rounds },
      sources: Object.fromEntries(Object.entries(model.src).map(([k, v]) => [k, `il y a ${Math.round((Date.now() - v) / 1000)} s`])),
      pollMode, replayCaptured: Boolean(replay), queriesTried: queryIdx, markets: byMarket,
      dom: {
        buttons: document.querySelectorAll('button[data-testid="fixture-outcome"]').length,
        tabs: [...document.querySelectorAll('[data-testid^="tab-"]')].map((b) => b.dataset.testid),
        titles: [...document.querySelectorAll('.secondary-accordion .header')].map((h) => h.textContent.trim()).slice(0, 40),
      },
    };
  }
  window.addEventListener('message', (e) => {
    // Le panneau demande des cotes à jour : les messages arrivent même quand Chrome ralentit les
    // minuteurs de l'onglet caché, la relecture est donc faite ici.
    if (e.source === window && e.data?.source === 'probet-panel' && e.data.type === 'refresh') {
      lastPoll = 0; lastSent = ''; readEmbedded(); poll(); send();
      return;
    }
    if (e.source !== window || e.data?.source !== 'probet-panel' || e.data.type !== 'diag-start' || diag) return;
    const ms = e.data.ms || 45000;
    diag = { start: Date.now(), until: Date.now() + ms, count: {}, skipped: {}, before: diagSummary() };
    setTimeout(() => {
      const out = { ...diag, after: diagSummary() };
      diag = null;
      window.postMessage({ source: 'probet-stake', diag: out }, location.origin);
    }, ms + 200);
  });
  const pageSlug = () => location.pathname.split('/').filter(Boolean).pop() || '';
  const onData = (data, source, ours) => {
    try { if (applyPayload(model, data, pageSlug(), Date.now(), source, ours)) send(); } catch { /* format inattendu */ }
  };
  // Abonnements WebSocket du site qui portent sur ce match (variables.fixtureId).
  const ourSubs = new Set();
  const onText = (text, source) => {
    if (typeof text !== 'string' || text.length > 5e6 || !/odds|status|groups/.test(text)) return;
    // Paris d'autres joueurs (« highroller ») : cotes au moment du pari, pas les cotes actuelles.
    if (/"SportBet"|highrollerSportBets|"sportBet/.test(text)) return;
    let data;
    try { data = JSON.parse(text); } catch { return; }
    onData(data, source, mentionsFixture(model, text) || (data?.id != null && ourSubs.has(data.id)));
  };
  function watchSubscribe(raw) {
    try {
      const m = JSON.parse(raw);
      const v = m?.payload?.variables || {};
      if (m?.type === 'subscribe' && model.fixture?.keys?.includes(v.fixtureId)) ourSubs.add(m.id);
    } catch { /* ignore */ }
  }

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
        if (GQL.test(url) && typeof args[1]?.body === 'string') rec('gqlOut', args[1].body, 3000);
        if (GQL.test(url)) res.clone().text().then((t) => { if (/odds|market|fixture/i.test(t)) rec('gqlIn', t, 4000); }, () => {});
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
        const wsUrl = String(args[0] || '').split('?')[0];
        try {
          ws.addEventListener('message', (e) => {
            if (diag && typeof e.data === 'string' && /odds|market|fixture|outcome|status/i.test(e.data)) rec('wsIn', `${wsUrl} ${e.data}`, 4000);
            else if (diag) rec('wsOther', `${wsUrl} ${String(e.data).slice(0, 300)}`, 400);
            onText(e.data, 'ws');
          });
          const origSend = ws.send.bind(ws);
          ws.send = (d) => { rec('wsOut', `${wsUrl} ${String(d)}`, 3000); if (typeof d === 'string') watchSubscribe(d); return origSend(d); };
          rec('wsOpen', wsUrl);
          (window.__probetWs ??= []).push(wsUrl);
        } catch { /* ignore */ }
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
  // Page d'un match : « …/869001-team-spirit-m80 ».
  const isMatchSlug = (slug) => /^\d+-./.test(slug);
  async function poll() {
    const slug = pageSlug();
    // Match ouvert en naviguant dans le site (sans recharger) : le JSON intégré est celui de la
    // page d'avant et le site charge le nouveau match en plusieurs morceaux. On le demande
    // directement, tout de suite.
    const known = model.fixture?.slug === slug;
    if (polling || !isMatchSlug(slug) || Date.now() - lastPoll < (known ? 4500 : 1500)) return;
    polling = true; lastPoll = Date.now();
    // Requête du site rejouée seulement si elle porte sur ce match.
    let req = replay && replay.body.includes(slug) ? replay : null;
    try {
      if (!req) {
        const q = fixtureQueries(slug)[queryIdx];
        if (!q) return; // aucune requête ne fonctionne : flux et écran seulement
        req = { url: '/_api/v1/graphql', body: JSON.stringify(q), headers: { ...gqlHeaders, 'content-type': 'application/json' } };
      }
      const res = await origFetch(req.url, { method: 'POST', credentials: 'include', headers: req.headers, body: req.body });
      const text = await res.text();
      rec('poll', `${res.status} ${req === replay ? 'replay' : 'query' + queryIdx} ${text}`, 1500);
      let json = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }
      if (json?.data?.slugFixture) {
        applyPayload(model, json.data, slug, Date.now(), 'poll', true);
        pollMode = req === replay ? 'replay' : 'query';
        send();
      } else if (req !== replay) { queryIdx++; pollMode = 'off'; } else replay = null;
    } catch { if (req !== replay) queryIdx++; else replay = null; } finally { polling = false; }
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
      setOutcome(out, odds > 1 ? odds : null, !b.disabled && odds > 1, now); touched = true;
      // Cote affichée et cliquable : le marché est ouvert (Stake affiche « suspendu » sinon).
      const mk = model.markets.get(out.market);
      if (mk && out.active) setStatus(mk, 'active', now);
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
