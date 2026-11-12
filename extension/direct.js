// Mode sans onglet (en préparation) : l'extension va chercher elle-même les données de HLTV
// (liste des matchs, flux du scorebot) et de Stake (cotes), sans ouvrir leurs pages.
// Pour l'instant : test de faisabilité depuis le panneau (accès autorisé ou bloqué par les sites).

const short = (t, n = 160) => String(t || '').replace(/\s+/g, ' ').slice(0, n);

// Matchs en direct sur la page des matchs HLTV : [{ id, url }].
export function parseLiveMatches(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = new Map();
  for (const a of doc.querySelectorAll('a[href*="/matches/"]')) {
    const m = /\/matches\/(\d+)\//.exec(a.getAttribute('href') || '');
    if (!m) continue;
    const live = a.closest('[class*="live"]') || /live/i.test(a.className);
    if (live && !out.has(m[1])) out.set(m[1], { id: m[1], url: new URL(a.getAttribute('href'), 'https://www.hltv.org').href });
  }
  return [...out.values()];
}

// Page des matchs HLTV, depuis l'extension.
export async function testHltvPage() {
  try {
    const r = await fetch('https://www.hltv.org/matches', { credentials: 'include' });
    const text = await r.text();
    const live = r.ok ? parseLiveMatches(text) : [];
    const blocked = !r.ok || /cf-chl|challenge-platform|Just a moment/i.test(text);
    return { ok: r.ok && !blocked, status: r.status, blocked, live: live.slice(0, 10), size: text.length, sample: blocked ? short(text) : undefined };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// Flux du scorebot HLTV (socket.io), comme la page du match : connexion, abonnement au match,
// puis comptage des messages reçus pendant `ms`.
export function testScorebot(matchId, ms = 12000) {
  return new Promise((resolve) => {
    const res = { matchId, opened: false, joined: false, scoreboard: 0, log: 0, other: 0, first: [] };
    let ws;
    try {
      ws = new WebSocket('wss://scorebot-lb.hltv.org/socket.io/?EIO=4&transport=websocket');
    } catch (e) {
      resolve({ ...res, error: String(e.message || e) });
      return;
    }
    const done = (extra = {}) => { try { ws.close(); } catch { /* ignore */ } resolve({ ...res, ...extra }); };
    const timer = setTimeout(() => done(), ms);
    ws.onopen = () => { res.opened = true; };
    ws.onerror = () => { clearTimeout(timer); done({ error: 'connexion refusée' }); };
    ws.onclose = (e) => { if (!res.closedAt) res.closed = { code: e.code, reason: e.reason }; };
    ws.onmessage = (e) => {
      const d = String(e.data);
      if (res.first.length < 4) res.first.push(short(d, 300));
      if (d.startsWith('0')) ws.send('40'); // ouverture socket.io
      else if (d === '2') ws.send('3'); // ping → pong
      else if (d.startsWith('40')) {
        res.joined = true;
        ws.send(`42${JSON.stringify(['readyForMatch', JSON.stringify({ token: '', listId: Number(matchId) })])}`);
      } else if (d.startsWith('42["scoreboard"')) res.scoreboard++;
      else if (d.startsWith('42["log"')) res.log++;
      else res.other++;
    };
  });
}

// API de Stake (même requête que la relecture actuelle), depuis l'extension.
export async function testStake(host = 'stake.com') {
  try {
    const r = await fetch(`https://${host}/_api/v1/graphql`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query ProbetTest($fixture: String!) { slugFixture(fixture: $fixture) { id name } }', variables: { fixture: 'probet-test' } }),
    });
    const text = await r.text();
    const blocked = /cf-chl|challenge-platform|Just a moment|<html/i.test(text);
    // Réponse attendue : une erreur GraphQL « match introuvable » (l'API répond) ou des données.
    return { ok: r.status < 500 && !blocked && /"(errors|data)"/.test(text), status: r.status, blocked, sample: short(text) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
