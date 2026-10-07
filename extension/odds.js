// Cotes en direct depuis l'onglet du bookmaker ouvert par l'utilisateur.
// Aucune requête : le script lit la page affichée, comme pour HLTV.
//  1. Liaison : l'utilisateur clique sur 🔗 dans ProBet puis sur la cote dans la page du
//     bookmaker. Le clic est intercepté (aucun pari n'est ajouté au coupon) et ProBet retient
//     comment retrouver cette cote (chemin dans la page + textes autour).
//  2. Suivi : chaque seconde, la cote liée est relue et envoyée au panneau. Si le site
//     redessine la page, la cote est retrouvée par son chemin, sinon par ses textes.
// Fonctions pures exposées sur globalThis.__probetOddsCore (tests).
(() => {
  // ---------- Fonctions pures ----------

  // Cote décimale dans un texte (« 1,85 », « 1.85 », « @2.10 ») : toujours 2 décimales chez les
  // bookmakers, contrairement aux lignes de total ou de handicap (« 22.5 », « -2.5 »), ignorées.
  // Plusieurs cotes → null.
  const ODDS_RE = /(?<![\d.,])\d{1,3}[.,]\d{2}(?![\d.,])/g;
  function parseOdds(text) {
    const found = String(text || '').match(ODDS_RE) || [];
    const vals = found.map((s) => Number(s.replace(',', '.'))).filter((x) => x > 1 && x < 1000);
    return vals.length === 1 ? vals[0] : null;
  }

  // Autre issue d'un marché à deux issues (lien automatique de la cote d'en face).
  function oppositeId(id) {
    let m;
    if ((m = /^(round\d+|map|series):(A|B)$/.exec(id))) return `${m[1]}:${m[2] === 'A' ? 'B' : 'A'}`;
    if ((m = /^ot:(Y|N)$/.exec(id))) return `ot:${m[1] === 'Y' ? 'N' : 'Y'}`;
    if ((m = /^(tot[\d.]+):(O|U)$/.exec(id))) return `${m[1]}:${m[2] === 'O' ? 'U' : 'O'}`;
    if ((m = /^(hcp-?[\d.]+):(A|B)$/.exec(id))) return `${m[1]}:${m[2] === 'A' ? 'B' : 'A'}`;
    return null;
  }

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // Texte d'un bouton sans la cote elle-même (garde « plus de 22.5 », retire « 1,90 »).
  function stripOdds(text, odds) {
    return norm(String(text || '').replace(ODDS_RE, (t) => (Number(t.replace(',', '.')) === odds ? ' ' : t)));
  }
  // Part des mots de b présents dans a (b vide : pas de contrainte).
  function overlap(a, b) {
    const wa = new Set(norm(a).split(' ').filter((w) => w.length > 2));
    const wb = norm(b).split(' ').filter((w) => w.length > 2);
    return wb.length ? wb.filter((w) => wa.has(w)).length / wb.length : 1;
  }

  globalThis.__probetOddsCore = { parseOdds, oppositeId, stripOdds, overlap };
  if (typeof chrome === 'undefined' || !chrome.runtime?.id || typeof document === 'undefined') return;
  if (window.__probetOdds) return; // déjà injecté
  window.__probetOdds = true;

  // ---------- Localisation d'une cote dans la page ----------

  const textOf = (el) => (el?.innerText ?? el?.textContent ?? '');
  // Plus petit élément autour de la cible qui contient exactement une cote.
  function oddsElement(target) {
    let el = target;
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      if (parseOdds(textOf(el)) != null) return el;
    }
    return null;
  }
  // Conteneur du marché : premier ancêtre qui contient au moins 2 cotes.
  function marketOf(el) {
    let a = el.parentElement;
    for (let i = 0; a && i < 8; i++, a = a.parentElement) {
      const n = (textOf(a).match(ODDS_RE) || []).length;
      if (n >= 2) return a;
    }
    return null;
  }
  function pathOf(el) {
    const steps = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
      steps.unshift(`${e.tagName.toLowerCase()}:nth-of-type(${i})`);
    }
    return `body > ${steps.join(' > ')}`;
  }
  // Libellé de la sélection : texte du bouton autour de la cote, sans la cote.
  function selOf(el) {
    const odds = parseOdds(textOf(el));
    let e = el;
    for (let i = 0; e && i < 4; i++, e = e.parentElement) {
      const t = stripOdds(textOf(e), odds);
      if (t && (!marketOf(el) || e !== marketOf(el))) return t.slice(0, 80);
    }
    return '';
  }
  // Ce qu'il faut retenir pour retrouver la cote plus tard.
  function locatorOf(el) {
    const market = marketOf(el);
    return {
      path: pathOf(el),
      sel: selOf(el), // « vitality », « plus de 22.5 »
      market: norm(textOf(market).replace(ODDS_RE, ' ')).slice(0, 200), // titre et issues du marché, sans les cotes
    };
  }
  // Toutes les cotes visibles avec leur bouton.
  function allOdds() {
    const out = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/\d[.,]\d\d/.test(n.nodeValue)) continue;
      const el = oddsElement(n.parentElement);
      if (el && !seen.has(el)) { seen.add(el); out.push(el); }
    }
    return out;
  }
  function relocate(loc) {
    try {
      const el = document.querySelector(loc.path);
      if (el && parseOdds(textOf(el)) != null && overlap(selOf(el), loc.sel) >= 0.8) return el;
    } catch { /* chemin invalide */ }
    // La page a été redessinée : même libellé de sélection, dans un marché qui ressemble.
    let best = null, score = 0;
    for (const el of allOdds()) {
      const s = overlap(selOf(el), loc.sel);
      if (s < 0.8) continue;
      const m = overlap(textOf(marketOf(el)), loc.market);
      const total = s + 2 * m;
      if (m >= 0.5 && total > score) { best = el; score = total; }
    }
    return best;
  }

  // ---------- Mode liaison ----------

  let picking = null;
  let box = null, banner = null;
  function overlayOn(el) {
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #3fb950;border-radius:6px;box-shadow:0 0 0 9999px rgba(0,0,0,.15);transition:all .05s';
      document.documentElement.append(box);
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width}px`, height: `${r.height}px`, display: 'block' });
  }
  function stopPicking() {
    picking = null;
    box?.remove(); banner?.remove(); box = banner = null;
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) window.removeEventListener(t, block, true);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('keydown', onKey, true);
  }
  function onMove(e) {
    const el = oddsElement(e.target);
    if (el) overlayOn(el); else if (box) box.style.display = 'none';
  }
  function onKey(e) {
    if (e.key === 'Escape') { stopPicking(); chrome.runtime.sendMessage({ type: 'probet:pick-cancel' }).catch(() => {}); }
  }
  // Pendant la liaison, les clics ne vont jamais au site (pas de pari ajouté au coupon).
  function block(e) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type !== 'click' || !picking) return;
    const el = oddsElement(e.target);
    if (!el) return;
    const req = picking;
    const links = [{ ...req, locator: locatorOf(el), odds: parseOdds(textOf(el)) }];
    // Marché à deux issues : l'autre cote du même marché est liée automatiquement.
    const opp = oppositeId(req.marketId);
    const market = marketOf(el);
    if (opp && market) {
      const others = allOdds().filter((o) => o !== el && market.contains(o));
      if (others.length === 1) links.push({ ...req, marketId: opp, label: null, locator: locatorOf(others[0]), odds: parseOdds(textOf(others[0])) });
    }
    stopPicking();
    chrome.runtime.sendMessage({ type: 'probet:picked', origin: location.origin, path: location.pathname, host: location.hostname.replace(/^www\./, ''), links }).catch(() => {});
  }
  function startPicking(req) {
    stopPicking();
    picking = req;
    banner = document.createElement('div');
    banner.textContent = `ProBet : cliquez sur la cote « ${req.label} » (Échap pour annuler)`;
    banner.style.cssText = 'position:fixed;z-index:2147483647;top:10px;left:50%;transform:translateX(-50%);background:#16181d;color:#fff;font:600 14px system-ui,sans-serif;padding:10px 16px;border-radius:10px;border:2px solid #3fb950;box-shadow:0 6px 24px rgba(0,0,0,.4)';
    document.documentElement.append(banner);
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) window.addEventListener(t, block, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('keydown', onKey, true);
  }

  // ---------- Suivi des cotes liées ----------

  let links = [];
  const cache = new Map(); // linkKey → élément
  const last = new Map(); // linkKey → { odds, sentAt }
  const keyOf = (l) => `${l.matchId}|${l.marketId}`;
  async function loadLinks() {
    try {
      const { oddsLinks } = await chrome.storage.local.get('oddsLinks');
      links = (oddsLinks || []).filter((l) => l.origin === location.origin);
    } catch { links = []; }
  }
  function tick() {
    const now = Date.now();
    for (const l of links) {
      const k = keyOf(l);
      let el = cache.get(k);
      if (!el || !el.isConnected || parseOdds(textOf(el)) == null) {
        el = relocate(l.locator);
        if (el) cache.set(k, el); else cache.delete(k);
      }
      const odds = el ? parseOdds(textOf(el)) : null;
      const prev = last.get(k);
      if (!prev || prev.odds !== odds || now - prev.sentAt > 4000) {
        last.set(k, { odds, sentAt: now });
        chrome.runtime.sendMessage({ type: 'probet:odds', matchId: l.matchId, marketId: l.marketId, odds,
          host: location.hostname.replace(/^www\./, ''), at: now }).catch(() => {});
      }
    }
  }
  chrome.storage.onChanged.addListener((ch) => { if (ch.oddsLinks) { cache.clear(); last.clear(); loadLinks(); } });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'probet:pick') startPicking(msg);
    else if (msg?.type === 'probet:pick-stop') stopPicking();
  });
  loadLinks().then(() => setInterval(tick, 1000));
})();
