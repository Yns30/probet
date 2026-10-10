// Deux PC : le collecteur (pages HLTV et Stake ouvertes) envoie au relais ce que lisent ses pages ;
// l'affichage le reçoit en direct et le traite comme ses propres onglets.
// Le relais est un petit programme (relay/probet-relay.mjs) lancé sur le collecteur.

const clean = (url) => String(url || '').trim().replace(/\/+$/, '');

// Envoi groupé : seul le dernier état de chaque page part, au plus toutes les `every` ms.
// L'envoi suit l'arrivée des données (pas de minuteur seul : Chrome les ralentit quand la
// fenêtre est cachée), avec un minuteur en secours pour le dernier état.
export function createSender({ url, code, every = 400, onStatus = () => {} }) {
  const base = clean(url);
  const queue = new Map();
  let last = 0, timer = null, busy = false, ok = null;
  const status = (s) => { if (s !== ok) { ok = s; onStatus(s); } };
  async function flush() {
    timer = null;
    if (busy || !queue.size) return;
    busy = true; last = Date.now();
    const items = [...queue.values()].map((it) => ({ ...it, sentAt: Date.now() }));
    queue.clear();
    try {
      const r = await fetch(`${base}/push`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-probet-code': code }, body: JSON.stringify({ items }) });
      status(r.ok ? 'ok' : r.status === 403 ? 'code' : 'error');
    } catch { status('offline'); }
    busy = false;
    if (queue.size) schedule();
  }
  function schedule() {
    if (Date.now() - last >= every) flush();
    else if (!timer) timer = setTimeout(flush, every - (Date.now() - last));
  }
  return {
    push(item) { queue.set(`${item.type === 'gone' ? 'gone' : item.type}:${item.id}`, item); schedule(); },
    async sendJournal(j) {
      try {
        const r = await fetch(`${base}/journal`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-probet-code': code }, body: JSON.stringify(j) });
        status(r.ok ? 'ok' : r.status === 403 ? 'code' : 'error');
        return r.ok;
      } catch { status('offline'); return false; }
    },
  };
}

// Réception en direct (flux d'événements, reconnexion automatique).
export function connectViewer({ url, code, onItem, onStatus = () => {} }) {
  const base = clean(url);
  const es = new EventSource(`${base}/events?code=${encodeURIComponent(code)}`);
  es.onopen = () => onStatus('ok');
  es.onerror = () => onStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'offline');
  es.onmessage = (e) => {
    let item;
    try { item = JSON.parse(e.data); } catch { return; }
    onItem(item);
  };
  return {
    close: () => es.close(),
    async journal() {
      const r = await fetch(`${base}/journal?code=${encodeURIComponent(code)}`);
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
  };
}

export async function testRelay(url, code) {
  try {
    const r = await fetch(`${clean(url)}/status?code=${encodeURIComponent(code)}`);
    if (r.status === 403) return { ok: false, why: 'code' };
    if (!r.ok) return { ok: false, why: `erreur ${r.status}` };
    return { ok: true, ...(await r.json()) };
  } catch {
    return { ok: false, why: 'injoignable' };
  }
}

// Les heures sont celles de l'horloge du collecteur : recalées sur celle de ce PC (décalage
// mesuré à l'envoi), pour que l'âge des cotes et des données reste juste.
export function shiftTimes(item, offset) {
  if (!offset || !item) return item;
  const sh = (t) => (Number.isFinite(t) && t > 1e12 ? t + offset : t);
  if (item.type === 'state' && item.state) {
    const s = { ...item.state };
    for (const k of ['lastFrameAt', 'updatedAt', 'metaAt']) s[k] = sh(s[k]);
    if (Array.isArray(s.log)) s.log = s.log.map((l) => ({ ...l, t: sh(l.t) }));
    return { ...item, state: s };
  }
  if (item.type === 'book' && item.fixture) {
    const f = { ...item.fixture, at: sh(item.fixture.at) };
    if (f.src) f.src = Object.fromEntries(Object.entries(f.src).map(([k, v]) => [k, sh(v)]));
    if (Array.isArray(f.markets)) {
      f.markets = f.markets.map((m) => ({ ...m, outcomes: (m.outcomes || []).map((o) => ({ ...o, seen: sh(o.seen), chg: sh(o.chg) })) }));
    }
    return { ...item, fixture: f };
  }
  return item;
}
