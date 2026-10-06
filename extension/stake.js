// Cotes Stake 100 % automatiques : rien à lier, rien à cliquer.
// Tourne dans la page Stake (monde MAIN, dès le chargement) et lit les mêmes données que le site :
//  1. au chargement : le JSON du match intégré à la page (réponse GraphQL « slugFixture » :
//     équipes, map en cours, tous les marchés avec leurs cotes) ;
//  2. en direct : les mises à jour reçues par le site (fetch et WebSocket), reconnues par les
//     identifiants des marchés et des issues, quel que soit le format du message ;
//  3. en complément : les boutons de cote affichés (titre du marché + libellé de l'issue).
// Un résumé du match est envoyé chaque seconde à stake-relay.js qui le passe au panneau.
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
    return { fixture: null, markets: new Map(), outcomes: new Map(), dom: new Map(), netAt: 0 };
  }
  function ingestFixture(model, f, now) {
    const comps = f.data?.competitors || [];
    const teams = f.data?.teams || [];
    const side = (q, i) => {
      const t = teams.find((x) => x.qualifier === q);
      const c = comps.find((x) => t && x.extId === t.extId) || comps[i] || {};
      return { name: t?.name || c.name || '', abbr: c.abbreviation || '' };
    };
    if (model.fixture?.id !== f.id) { model.markets.clear(); model.outcomes.clear(); model.dom.clear(); }
    model.fixture = {
      id: f.id, slug: f.slug, name: f.name, status: f.status,
      home: side('home', 0), away: side('away', 1),
    };
    if (f.eventStatus) ingestStatus(model, f.eventStatus);
    for (const g of f.groups || []) {
      for (const t of g.templates || []) {
        for (const mk of t.markets || []) ingestMarket(model, mk, now);
      }
    }
  }
  function ingestStatus(model, es) {
    const fx = model.fixture;
    if (!fx || !es) return;
    if (es.matchStatus != null) { fx.matchStatus = es.matchStatus; fx.mapNumber = mapNumberOf(es.matchStatus); }
    if (es.homeScore != null) fx.score = { home: es.homeScore, away: es.awayScore };
    const sb = es.scoreboard;
    if (sb && sb.homeWonRounds != null) fx.rounds = { home: sb.homeWonRounds, away: sb.awayWonRounds };
  }
  function ingestMarket(model, mk, now) {
    const tpl = String(mk.templateExtId ?? mk.extId ?? '');
    if (!mk.id || !TEMPLATES.has(tpl)) return;
    const prev = model.markets.get(mk.id);
    const market = prev || { id: mk.id, tpl, spec: parseSpecifiers(mk.specifiers), name: String(mk.name || '').trim(), outcomes: [] };
    if (mk.status) market.status = mk.status;
    for (const o of mk.outcomes || []) {
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
    if (!prev) model.markets.set(mk.id, market);
  }
  // Parcourt n'importe quelle réponse ou message du site et applique ce qui concerne le match suivi.
  // slug : celui de la page affichée (pour ignorer les autres matchs listés sur le côté).
  function applyPayload(model, data, slug, now) {
    let touched = false;
    const stack = [[data, 0]];
    while (stack.length) {
      const [o, depth] = stack.pop();
      if (!o || typeof o !== 'object' || depth > 40) continue;
      if (Array.isArray(o)) { for (const x of o) stack.push([x, depth + 1]); continue; }
      if (Array.isArray(o.groups) && o.slug && (!slug || o.slug === slug)) {
        ingestFixture(model, o, now); touched = true; continue;
      }
      if (o.id != null) {
        const out = model.outcomes.get(o.id);
        if (out) {
          if (typeof o.odds === 'number') out.odds = o.odds;
          if (typeof o.active === 'boolean') out.active = o.active;
          out.seen = now; touched = true;
        }
        const mk = model.markets.get(o.id);
        if (mk) {
          if (typeof o.status === 'string') mk.status = o.status;
          if (Array.isArray(o.outcomes)) ingestMarket(model, { ...o, templateExtId: mk.tpl, name: mk.name }, now);
          touched = true;
        }
        if (model.fixture && o.id === model.fixture.id) {
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
    if (touched) model.netAt = now;
    return touched;
  }
  // Résumé envoyé au panneau : uniquement les marchés utiles. « seen » : dernière confirmation de
  // la cote (affichée à l'écran, ou flux du site actif — il pousse alors chaque changement).
  function snapshot(model, now) {
    const fx = model.fixture;
    if (!fx) return null;
    return {
      ...fx, at: now,
      markets: [...model.markets.values()].map((m) => ({
        tpl: m.tpl, spec: m.spec, name: m.name, status: m.status || 'active',
        outcomes: m.outcomes.map((o) => ({ ext: o.ext, name: o.name, odds: o.odds, active: o.active, seen: Math.max(o.seen, model.netAt) })),
      })),
    };
  }

  globalThis.__probetStakeCore = { parseSpecifiers, mapNumberOf, createModel, ingestFixture, applyPayload, snapshot, norm };
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.__probetStake) return;
  window.__probetStake = true;

  const model = createModel();
  const pageSlug = () => location.pathname.split('/').filter(Boolean).pop() || '';
  const onData = (data) => { try { applyPayload(model, data, pageSlug(), Date.now()); } catch { /* format inattendu */ } };
  const onText = (text) => {
    if (typeof text !== 'string' || text.length > 5e6 || !/odds|status|groups/.test(text)) return;
    try { onData(JSON.parse(text)); } catch { /* pas du JSON */ }
  };

  // 1. Réseau : réponses de l'API du site (navigation d'un match à l'autre, rafraîchissements).
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = String(args[0]?.url || args[0] || '');
      if (/\/_api\//.test(url) && /json/.test(res.headers.get('content-type') || '')) res.clone().text().then(onText, () => {});
    } catch { /* ignore */ }
    return res;
  };
  // Flux temps réel (WebSocket) : chaque message est examiné.
  const OrigWS = window.WebSocket;
  if (OrigWS) {
    window.WebSocket = new Proxy(OrigWS, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget);
        try { ws.addEventListener('message', (e) => onText(e.data)); } catch { /* ignore */ }
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
        onData(typeof o.body === 'string' ? JSON.parse(o.body) : o.body ?? o);
      } catch { /* ignore */ }
    }
  }

  // 3. Boutons de cote affichés : la valeur à l'écran fait foi.
  function readDom() {
    const now = Date.now();
    for (const b of document.querySelectorAll('button[data-testid="fixture-outcome"]')) {
      const label = b.getAttribute('aria-label');
      const acc = b.closest('.secondary-accordion');
      const title = acc?.querySelector('.header')?.textContent;
      if (!label || !title) continue;
      const out = model.dom.get(`${norm(title)}|${norm(label)}`);
      if (!out) continue;
      const txt = b.querySelector('[data-testid="fixture-odds"]')?.textContent || '';
      const m = /(\d+)[.,](\d+)/.exec(txt);
      const odds = m ? Number(`${m[1]}.${m[2]}`) : null;
      if (odds > 1) out.odds = odds;
      out.active = !b.disabled && odds > 1;
      out.seen = now;
      // Cote affichée et cliquable : le marché est ouvert (Stake affiche « suspendu » sinon).
      const mk = model.markets.get(out.market);
      if (mk && out.active) mk.status = 'active';
    }
  }

  let lastSent = '', lastAt = 0;
  function tick() {
    readEmbedded();
    readDom();
    const now = Date.now();
    const snap = snapshot(model, now);
    if (!snap || snap.slug !== pageSlug()) return;
    const key = JSON.stringify({ ...snap, at: 0, markets: snap.markets.map((m) => [m.status, m.outcomes.map((o) => [o.odds, o.active])]) });
    if (key === lastSent && now - lastAt < 3000) return;
    lastSent = key; lastAt = now;
    window.postMessage({ source: 'probet-stake', fixture: snap }, location.origin);
  }
  const start = () => { readEmbedded(); setInterval(tick, 1000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
