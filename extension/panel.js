import { analyze, markets, confidence, evaluateBet } from './engine.js';
import { stablePicks } from './picks.js';
import { buildAdvice } from './advice.js';
import { findFixture, bookOdds, bookLines, pickMapNumber, bookClosure } from './books.js';
import { toMatch, describeLog } from './hltv.js';
import { createDemoMatch } from './demo.js';
import { newJournal, record, backfill, logPicks, summarize, mergeDuplicates, mapKeyOf } from './journal.js';

const $ = (id) => document.getElementById(id);
const pct = (p) => `${Math.round(p * 100)}%`;
const dec = (x, n = 2) => x.toFixed(n).replace('.', ',');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hasChrome = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);

const PHASES = {
  freezetime: 'Temps d’achat', live: 'Round en cours', bomb_planted: 'Bombe posée',
  round_over: 'Fin de round', map_over: 'Map terminée', not_live: 'Pas encore en direct',
};
const BUYS = { eco: 'Eco', force: 'Force-buy', half: 'Demi-buy', full: 'Full buy' };

// ---------- Réglages ----------

const settings = { bank: null, edge: 4, odds1: null, odds2: null };
async function loadSettings() {
  try {
    const saved = hasChrome ? (await chrome.storage.local.get('settings')).settings : JSON.parse(localStorage.getItem('probet:settings'));
    Object.assign(settings, saved || {});
  } catch { /* défauts */ }
}
function saveSettings() {
  try {
    if (hasChrome) chrome.storage.local.set({ settings });
    else localStorage.setItem('probet:settings', JSON.stringify(settings));
  } catch { /* stockage indisponible */ }
}

// ---------- Journal (enregistré localement, exportable) ----------

// Chaque map est stockée sous sa propre clé (« j:… ») : seules les maps modifiées sont réécrites.
let journal = newJournal();
const journalDirty = new Set();
const JKEY = 'j:';
async function loadJournal() {
  try {
    const all = hasChrome ? await chrome.storage.local.get(null)
      : Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('probet:' + JKEY))
        .map((k) => [k.slice(7), JSON.parse(localStorage.getItem(k))]));
    for (const [k, v] of Object.entries(all)) if (k.startsWith(JKEY) && v) journal.maps[k.slice(JKEY.length)] = v;
    const { removed, changed } = mergeDuplicates(journal);
    if (removed.length || changed.length) {
      journal.removed = removed;
      for (const k of changed) journalDirty.add(k);
      saveJournal();
    }
  } catch { /* journal vierge */ }
}
function saveJournal() {
  const removed = journal.removed || [];
  journal.removed = [];
  const put = {};
  for (const k of journalDirty) if (journal.maps[k]) put[JKEY + k] = journal.maps[k];
  journalDirty.clear();
  try {
    if (hasChrome) {
      if (Object.keys(put).length) chrome.storage.local.set(put);
      if (removed.length) chrome.storage.local.remove(removed.map((k) => JKEY + k));
    } else {
      for (const [k, v] of Object.entries(put)) localStorage.setItem('probet:' + k, JSON.stringify(v));
      for (const k of removed) localStorage.removeItem('probet:' + JKEY + k);
    }
  } catch { /* stockage indisponible */ }
}
setInterval(saveJournal, 10000);
addEventListener('visibilitychange', saveJournal);
addEventListener('pagehide', saveJournal);

// ---------- Cotes en direct depuis l'onglet du bookmaker ----------
// L'utilisateur lie une fois chaque cote (🔗 puis clic sur la cote dans la page du
// bookmaker) ; le script odds.js la relit ensuite chaque seconde et l'envoie ici.

const LIVE_TTL = 12000; // au-delà, une cote non rafraîchie n'est plus utilisée
let oddsLinks = [];
let pickingTabs = [];
async function loadLinks() {
  try { oddsLinks = (hasChrome && (await chrome.storage.local.get('oddsLinks')).oddsLinks) || []; } catch { oddsLinks = []; }
  // Liaisons des matchs terminés (plus de 3 jours) : supprimées.
  const fresh = oddsLinks.filter((l) => !l.at || Date.now() - l.at < 3 * 86400e3);
  if (fresh.length !== oddsLinks.length) { oddsLinks = fresh; saveLinks(); }
}
async function saveLinks() {
  if (!hasChrome) return;
  await chrome.storage.local.set({ oddsLinks });
  // Le script de lecture se réinstalle tout seul sur les sites liés (rechargement, redémarrage).
  const origins = [...new Set(oddsLinks.map((l) => l.origin))];
  try {
    const reg = await chrome.scripting.getRegisteredContentScripts({ ids: ['probet-odds'] });
    if (!origins.length) { if (reg.length) await chrome.scripting.unregisterContentScripts({ ids: ['probet-odds'] }); return; }
    const def = { id: 'probet-odds', matches: origins.map((o) => `${o}/*`), js: ['odds.js'], runAt: 'document_idle', persistAcrossSessions: true };
    if (reg.length) await chrome.scripting.updateContentScripts([def]); else await chrome.scripting.registerContentScripts([def]);
  } catch { /* permission retirée : la liaison sera redemandée */ }
}
const linkOf = (matchId, marketId) => oddsLinks.find((l) => l.matchId === matchId && l.marketId === marketId);

function onLiveOdds(msg) {
  const mem = memFor(msg.matchId);
  mem.live ??= {};
  mem.live[msg.marketId] = { odds: msg.odds, host: msg.host, at: Date.now() };
  if (msg.odds > 1) mem.odds[msg.marketId] = msg.odds; else delete mem.odds[msg.marketId];
  const src = sources.get(selected);
  if (src && String(src.matchId) === String(msg.matchId)) scheduleRender();
}
// Cote liée mais plus rafraîchie (onglet fermé, marché disparu) : on ne s'en sert plus.
function expireLive(mem) {
  for (const [id, l] of Object.entries(mem.live || {})) {
    if (Date.now() - l.at > LIVE_TTL && mem.odds[id] === l.odds) { delete mem.odds[id]; l.odds = null; }
  }
}

// ---------- Cotes automatiques (Stake) ----------
// stake.js lit la page Stake ouverte et envoie le match chaque seconde : le match HLTV
// correspondant est retrouvé par les noms d'équipes et ses cotes remplies sans aucun clic.
const AUTO_TTL = 90000; // cote plus confirmée depuis 90 s (marché masqué, flux coupé) : pas utilisée
// Onglet Stake en arrière-plan : Chrome peut ne le réveiller qu'une fois par minute.
const BOOK_TTL = 90000;
const books = new Map(); // tabId → { host, fixture, at }
function onBook(msg, tabId) {
  if (tabId == null || !msg.fixture) return;
  books.set(tabId, { host: msg.host, fixture: msg.fixture, at: Date.now() });
  scheduleRender();
}
// Diagnostic : la page Stake enregistre 45 s de ce qu'elle reçoit (sans données du compte),
// puis le panneau télécharge un fichier à transmettre pour corriger la lecture.
let diagState = '';
const DIAG_MS = 45000;
function showDiag(text) {
  diagState = text;
  $('diagMsg').textContent = text;
  $('diagBtn').disabled = text.startsWith('Diagnostic en cours');
}
async function startDiag() {
  if (!hasChrome || diagState.startsWith('Diagnostic en cours')) return;
  // Envoyé à tous les onglets : seul l'onglet Stake (script ProBet présent) répond.
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const ids = new Set([...books.keys(), ...tabs.map((t) => t.id)]);
  for (const tabId of ids) chrome.tabs.sendMessage(tabId, { type: 'probet:diag-start', ms: DIAG_MS }).catch(() => {});
  showDiag('Diagnostic en cours (45 s) : laissez le match tourner, ne fermez pas l’onglet Stake…');
  setTimeout(() => {
    if (diagState.startsWith('Diagnostic en cours')) showDiag('Aucune réponse d’une page Stake : ouvrez le match sur Stake, rechargez la page (F5) puis réessayez.');
  }, DIAG_MS + 8000);
}
function onDiag(msg) {
  const src = sources.get(selected);
  const mem = src && memFor(src.matchId || selected);
  const panelSide = src && {
    hltv: { names: [src.meta?.team1?.name, src.meta?.team2?.name], map: src.scoreboard?.mapName, mapNumber: mem?.lastMapNumber, round: src.scoreboard?.currentRound },
    book: mem?.book, oddsIds: Object.keys(mem?.live || {}).filter((k) => mem.live[k].auto), lines: mem?.bookLines,
  };
  const file = { probet: chrome.runtime.getManifest?.().version, at: new Date().toISOString(), host: msg.host, panel: panelSide, stake: msg.diag };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
  a.download = `probet-diagnostic-stake-${Date.now()}.json`;
  document.body.append(a); a.click(); a.remove();
  showDiag('Diagnostic téléchargé ✓ : envoyez le fichier (dossier Téléchargements) pour que la lecture soit corrigée.');
}
// Remplit mem.live / mem.odds avec les cotes du bookmaker pour la map en cours.
function applyBooks(mem, m, matchId) {
  const names = m.names, mapNumber = m.mapNumber;
  const now = Date.now();
  const live = [...books.values()].filter((b) => now - b.at < BOOK_TTL);
  const hit = findFixture(live.map((b) => b.fixture), names);
  const book = hit && live.find((b) => b.fixture === hit.fixture);
  mem.live ??= {};
  const pick = hit ? pickMapNumber(hit.fixture, hit.homeSide, m) : null;
  const got = hit ? bookOdds(hit.fixture, hit.homeSide, pick.map ?? -1) : {};
  for (const [id, l] of Object.entries(mem.live)) {
    if (l.auto && !got[id]) { delete mem.live[id]; if (mem.odds[id] === l.odds) delete mem.odds[id]; }
  }
  for (const [id, o] of Object.entries(got)) {
    if (linkOf(String(matchId), id)) continue; // cote liée à la main : prioritaire
    const odds = o.odds > 1 && now - o.at < AUTO_TTL ? o.odds : null;
    const prev = mem.live[id];
    mem.live[id] = { odds, host: book.host, at: now, auto: true };
    if (odds) mem.odds[id] = odds; else if (prev?.auto && mem.odds[id] === prev.odds) delete mem.odds[id];
  }
  // Lignes proposées par le bookmaker : ProBet calcule exactement celles-là.
  mem.bookLines = bookLines(got);
  const fx = hit?.fixture;
  const last = fx ? Math.max(0, ...Object.values(fx.src || {})) : 0;
  const shut = fx && pick.map != null ? bookClosure(fx, pick.map) : { closed: false, openMaps: [] };
  if (!shut.closed) mem.closedSince = null; else mem.closedSince ??= now;
  const shutNote = shut.closed
    ? `Stake a fermé les paris sur la map ${pick.map} et le match${now - mem.closedSince > 5000 ? ` depuis ${Math.round((now - mem.closedSince) / 1000)} s` : ''} : `
      + `conseils dès la réouverture${shut.openMaps.length ? ` (ouvert : map ${shut.openMaps.join(', ')})` : ''}`
    : null;
  mem.book = hit ? { host: book.host, name: fx.name, age: last ? now - last : null, poll: fx.pollMode, src: fx.src,
    map: pick.map, desync: pick.why === 'desync', mapNote: pick.why === 'finished' && pick.map !== fx.mapNumber
      ? `HLTV affiche encore la map ${pick.map} (terminée) : cotes de la map ${fx.mapNumber} dès qu'elle commence`
      : pick.why === 'desync' ? `score différent entre Stake (${fx.rounds.home}-${fx.rounds.away}) et HLTV : cotes de la map en attente`
      : shutNote ?? (pick.why === 'stake' && mapNumber ? `cotes de la map ${pick.map} (map en cours chez Stake)` : null) } : null;
}

let renderTimer = null;
function scheduleRender() { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 150); }

function linkMsg(text) {
  $('linkBar').hidden = !text;
  $('linkBar').querySelector('span').textContent = text || '';
}
async function startLinking(marketId, label) {
  const src = sources.get(selected);
  if (!hasChrome || !src?.matchId) return;
  // Autorisation de lire les autres sites (demandée une seule fois par Chrome).
  const origins = { origins: ['https://*/*'] };
  const ok = (await chrome.permissions.contains(origins).catch(() => false)) || (await chrome.permissions.request(origins).catch(() => false));
  if (!ok) { linkMsg('Autorisation refusée : ProBet ne peut pas lire la page du bookmaker.'); return; }
  const tabs = (await chrome.tabs.query({})).filter((t) => /^https:/.test(t.url || '') && !/hltv\.org/.test(t.url));
  if (!tabs.length) { linkMsg('Ouvrez d’abord la page du match chez votre bookmaker, puis recliquez sur 🔗.'); return; }
  pickingTabs = [];
  for (const t of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['odds.js'] });
      await chrome.tabs.sendMessage(t.id, { type: 'probet:pick', matchId: String(src.matchId), marketId, label });
      pickingTabs.push(t.id);
    } catch { /* page non accessible (Web Store, PDF…) */ }
  }
  linkMsg(pickingTabs.length ? `Allez dans l’onglet du bookmaker et cliquez sur la cote « ${label} ».` : 'Impossible de lire les onglets ouverts.');
}
function endPicking(text) {
  for (const id of pickingTabs) chrome.tabs.sendMessage(id, { type: 'probet:pick-stop' }).catch(() => {});
  pickingTabs = [];
  linkMsg(text);
  if (text) setTimeout(() => { if ($('linkBar').querySelector('span').textContent === text) linkMsg(''); }, 5000);
}
// Cote cliquée sur la mauvaise équipe (ex. G2 au lieu de 1win) : le nom lu chez le bookmaker
// est comparé aux noms HLTV et les deux cotes du marché sont remises dans le bon sens.
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function fixTeamSides(links, names) {
  const team = (sel) => {
    const t = normName(sel);
    const hit = names.map((n) => normName(n)).map((n) => Boolean(n) && (t.includes(n) || (t.length >= 3 && n.includes(t))));
    return hit[0] && !hit[1] ? 'A' : hit[1] && !hit[0] ? 'B' : null;
  };
  return links.map((l) => {
    const m = /^(round\d+|map|series):(A|B)$/.exec(l.marketId);
    const side = m && team(l.locator?.sel);
    return side && side !== m[2] ? { ...l, marketId: `${m[1]}:${side}` } : l;
  });
}
async function onPicked(msg, tabId) {
  const src = [...sources.values()].find((x) => String(x.matchId) === String(msg.links[0]?.matchId));
  const names = [src?.meta?.team1?.name, src?.meta?.team2?.name];
  msg.links = fixTeamSides(msg.links, names);
  for (const l of msg.links) {
    oddsLinks = oddsLinks.filter((x) => !(x.matchId === l.matchId && x.marketId === l.marketId));
    oddsLinks.push({ matchId: l.matchId, marketId: l.marketId, origin: msg.origin, path: msg.path, host: msg.host, locator: l.locator, at: Date.now() });
    onLiveOdds({ matchId: l.matchId, marketId: l.marketId, odds: l.odds, host: msg.host });
  }
  pickingTabs = pickingTabs.filter((id) => id !== tabId);
  await saveLinks();
  endPicking(`Cote liée ✓ (${msg.host}${msg.links.length > 1 ? ', les deux issues du marché' : ''}) : elle se met à jour toute seule.`);
}
async function unlink(marketId) {
  const src = sources.get(selected);
  if (!src) return;
  const mem = memFor(src.matchId || selected);
  const opp = { A: 'B', B: 'A', Y: 'N', N: 'Y', O: 'U', U: 'O' };
  const [base, side] = marketId.split(':');
  const ids = [marketId, `${base}:${opp[side]}`];
  oddsLinks = oddsLinks.filter((l) => !(l.matchId === String(src.matchId) && ids.includes(l.marketId)));
  for (const id of ids) { delete mem.odds[id]; delete mem.live?.[id]; }
  await saveLinks();
  render();
}
// Le tableau se redessine souvent pendant un round : on réagit dès l'appui (pointerdown),
// sinon le bouton peut être remplacé entre l'appui et le relâchement et le clic se perd.
let lastLinkPress = 0;
function onLinkClick(e) {
  const b = e.target.closest('button[data-link], button[data-unlink]');
  if (!b) return;
  if (e.type === 'click' && Date.now() - lastLinkPress < 800) return; // déjà traité à l'appui
  if (e.type === 'pointerdown') lastLinkPress = Date.now();
  if (b.dataset.unlink) unlink(b.dataset.unlink);
  else startLinking(b.dataset.link, b.dataset.label);
}
// Ne remplace le contenu que s'il a changé (garde les boutons et le focus en place).
function setHTML(el, html) { if (el.__html !== html) { el.innerHTML = html; el.__html = html; } }

// ---------- Sources (onglets HLTV ouverts, ou démo) ----------

const sources = new Map(); // id → état envoyé par la page
let selected = null;
const mems = new Map(); // matchId → { econ, history, odds }

function memFor(key) {
  if (!mems.has(key)) mems.set(key, { econ: {}, history: [], odds: {} });
  return mems.get(key);
}

function label(src) {
  const t1 = src.meta?.team1?.name, t2 = src.meta?.team2?.name;
  return t1 && t2 ? `${t1} vs ${t2}` : src.url ? src.url.replace(/^https:\/\/www\.hltv\.org\/matches\/\d+\//, '') : 'Match';
}

function refreshSelect() {
  const sel = $('matchSelect');
  const ids = [...sources.keys()];
  if (selected == null || !sources.has(selected)) {
    // Priorité à un onglet qui reçoit des données live.
    selected = ids.find((id) => sources.get(id).scoreboard) ?? ids[0] ?? null;
  }
  sel.innerHTML = ids.map((id) => `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(label(sources.get(id)))}</option>`).join('');
}
$('matchSelect').addEventListener('change', (e) => {
  selected = [...sources.keys()].find((id) => String(id) === e.target.value) ?? null;
  render();
});

function onState(id, state) {
  sources.set(id, state);
  refreshSelect();
  // Tous les matchs ouverts sont analysés et enregistrés, même ceux qui ne sont pas affichés.
  if (id === selected) render();
  else if (state?.scoreboard) process(id, state);
}

if (hasChrome) {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === 'probet:state' && sender.tab) onState(sender.tab.id, msg.state);
    else if (msg?.type === 'probet:odds') onLiveOdds(msg);
    else if (msg?.type === 'probet:picked') onPicked(msg, sender.tab?.id);
    else if (msg?.type === 'probet:pick-cancel') endPicking('Liaison annulée.');
    else if (msg?.type === 'probet:book') onBook(msg, sender.tab?.id);
    else if (msg?.type === 'probet:diag') onDiag(msg);
  });
  chrome.tabs.onRemoved.addListener((id) => {
    if (books.delete(id)) scheduleRender();
    if (sources.delete(id)) { refreshSelect(); render(); }
  });
}

async function discover() {
  if (!hasChrome) return;
  const tabs = await chrome.tabs.query({ url: 'https://www.hltv.org/matches/*' });
  for (const t of tabs) {
    try {
      const state = await chrome.tabs.sendMessage(t.id, { type: 'probet:get' });
      if (state) onState(t.id, state);
    } catch { /* onglet ouvert avant l'installation : à recharger */ }
  }
  if (!sources.size) render();
}

// ---------- Démo ----------

let demoTimer = null;
function startDemo() {
  const sim = createDemoMatch(Date.now() % 100000);
  const st = { url: 'demo', matchId: 'demo', meta: sim.meta(), scoreboard: null, log: [], frames: 0, lastFrameAt: null };
  clearInterval(demoTimer);
  demoTimer = setInterval(() => {
    const { scoreboard, log } = sim.next();
    for (const entry of [...log].reverse()) {
      const text = describeLog(entry);
      if (text) st.log.push({ t: Date.now(), text, type: Object.keys(entry)[0] });
    }
    st.log = st.log.slice(-60);
    Object.assign(st, { meta: sim.meta(), scoreboard, frames: st.frames + 1, lastFrameAt: Date.now() });
    selected = 'demo';
    onState('demo', { ...st, meta: { ...st.meta, team1: { ...st.meta.team1, name: `${st.meta.team1.name} (démo)` } } });
  }, 900);
}
$('btnDemo').addEventListener('click', startDemo);

// ---------- Rendu ----------

function status(kind, text) {
  $('status').className = `status ${kind}`;
  $('status').querySelector('span').textContent = text;
}

function prematchOverride() {
  const a = settings.odds1, b = settings.odds2;
  return a > 1 && b > 1 ? (1 / a) / (1 / a + 1 / b) : null;
}

function renderBoard(m) {
  const [A, B] = m.names;
  $('nameA').textContent = A; $('nameB').textContent = B;
  $('scoreA').textContent = m.scoreA; $('scoreB').textContent = m.scoreB;
  $('sideA').textContent = m.aSide;
  $('sideB').textContent = m.aSide === 'CT' ? 'T' : 'CT';
  const dots = (players) => (players || []).slice(0, 5).map((p) => `<i><b style="width:${p.alive ? Math.max(8, p.hp ?? 100) : 0}%"></b></i>`).join('');
  $('aliveA').innerHTML = dots(m.players.A);
  $('aliveB').innerHTML = dots(m.players.B);
  const eco = (buy, money, n, equip) => {
    const per = n ? Math.round(money / n / 100) * 100 : 0;
    const eq = equip != null && !m.nextBuy ? `équipement ${Math.round(equip / 100) / 10} k$` : null;
    return [buy ? (m.nextBuy ? `Prochain : ${BUYS[buy]}` : BUYS[buy]) : null, eq, n ? `${per.toLocaleString('fr-FR')} $ en banque/joueur` : null].filter(Boolean).join(' · ');
  };
  $('ecoA').textContent = eco(m.buyA, m.moneyA, m.players.A.length, m.equipA);
  $('ecoB').textContent = eco(m.buyB, m.moneyB, m.players.B.length, m.equipB);
  const bits = [];
  bits.push(m.bestOf > 1 ? `Map ${m.mapNumber} · BO${m.bestOf} ${m.mapsA}-${m.mapsB}` : 'BO1');
  if (m.map) bits.push(m.map[0].toUpperCase() + m.map.slice(1));
  if (m.phase !== 'map_over') bits.push(`Round ${m.scoreA + m.scoreB + 1}`);
  bits.push(m.bombPlanted && m.phase === 'bomb_planted' ? '<span class="bomb">Bombe posée</span>' : PHASES[m.phase] || '');
  if (m.timer != null) bits.push(`${Math.floor(m.timer / 60)}:${String(m.timer % 60).padStart(2, '0')}`);
  if (m.bombTimer != null) bits.push(`<span class="bomb">💣 ${Math.ceil(m.bombTimer)} s</span>`);
  $('roundInfo').innerHTML = bits.filter(Boolean).join('<br>');
}

const validHltv = (h) => (h && h.p1 >= 0 && h.p1 <= 1 && h.p2 <= 1 ? h : null);

function bar(title, p, [A, B], ref) {
  const a = Math.round(p * 100);
  return `<div class="bar">
    <div class="lbl"><span>${esc(A)} <b>${a}%</b></span><span>${esc(title)}</span><span><b>${100 - a}%</b> ${esc(B)}</span></div>
    <div class="track"><i style="width:${a}%"></i><i style="width:${100 - a}%"></i></div>
    ${ref ? `<div class="ref">${ref}</div>` : ''}
  </div>`;
}

function renderProbs(m, res, src) {
  let html = '';
  if (res.pRound != null) html += bar(`Round ${res.round}`, res.pRound, m.names);
  const hp = validHltv(src.meta?.hltvProb);
  const fmt = (a, ot, b) => `${esc(m.names[0])} ${pct(a)} · prolong. ${pct(ot)} · ${esc(m.names[1])} ${pct(b)}`;
  let ref = '';
  if (hp && hp.reg1 != null && !res.over) {
    ref = `HLTV : ${hp.oriented ? fmt(hp.reg1, hp.ot, hp.reg2) : `${pct(hp.reg1)} / ${pct(hp.reg2)} (équipes non identifiées)`}<br>ProBet : ${fmt(res.pRegA, res.pOT, res.pRegB)}`;
  } else if (hp) {
    ref = hp.oriented === false ? `Proba live affichée par HLTV : ${pct(hp.p1)} / ${pct(hp.p2)}`
      : `Proba live affichée par HLTV : ${esc(m.names[0])} ${pct(hp.p1)} · ${esc(m.names[1])} ${pct(hp.p2)}`;
  }
  html += bar(`Map ${m.mapNumber}`, res.over ? (res.over === 'A' ? 1 : 0) : res.pMap, m.names, ref);
  if (res.pSeries != null) html += bar(`Série BO${m.bestOf}`, res.pSeries, m.names);
  $('bars').innerHTML = html;
  const [best] = res.likelyScores;
  $('extra').innerHTML = res.over ? '' : `
    <div><small>Score le + probable</small><b>${best ? best[0] : '—'}</b></div>
    <div><small>Total attendu</small><b>${dec(res.expTotal, 1)}</b></div>
    <div><small>Prolongation</small><b>${pct(res.pOT)}</b></div>`;
}

function renderSpark(history, name) {
  const svg = $('spark');
  $('sparkLabel').textContent = name;
  if (history.length < 2) { svg.innerHTML = '<line class="mid" x1="0" x2="300" y1="35" y2="35"/>'; return; }
  const x = (i) => (i / (history.length - 1)) * 300;
  const y = (p) => 4 + (1 - p) * 62;
  const d = history.map((pt, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pt.p).toFixed(1)}`).join('');
  const last = history[history.length - 1];
  svg.innerHTML = `<line class="mid" x1="0" x2="300" y1="35" y2="35"/><path class="line" d="${d}"/>
    <circle class="dot" cx="${x(history.length - 1)}" cy="${y(last.p)}" r="4"/>`;
}
let sparkData = { history: [], name: '' };
$('spark').addEventListener('pointermove', (e) => {
  const h = sparkData.history;
  if (h.length < 2) return;
  const r = e.currentTarget.getBoundingClientRect();
  const i = Math.max(0, Math.min(h.length - 1, Math.round(((e.clientX - r.left) / r.width) * (h.length - 1))));
  const tip = $('sparkTip');
  tip.hidden = false;
  tip.style.left = `${e.clientX - r.left}px`;
  tip.textContent = `${h[i].label} · ${sparkData.name} ${pct(h[i].p)}`;
});
$('spark').addEventListener('pointerleave', () => { $('sparkTip').hidden = true; });

function facts(m, res, src) {
  const out = [];
  const [A, B] = m.names;
  const live = m.phase === 'live' || m.phase === 'bomb_planted';
  const a = m.aliveA, b = m.aliveB;
  if (live && a != null && b != null) {
    if (m.bombPlanted) out.push(`Bombe posée : ${m.aSide === 'T' ? A : B} défend la bombe en ${m.aSide === 'T' ? a : b}v${m.aSide === 'T' ? b : a}`);
    const who = (list) => { const p = list.find((x) => x.alive); return p ? `${p.nick}${p.score != null ? ` (${p.score}-${p.deaths} sur la map${p.rating ? `, rating ${p.rating.toFixed(2)}` : ''})` : ''}` : ''; };
    if (a === 1 && b >= 1) out.push(`Clutch ${A} 1v${b} : ${who(m.players.A)}, ${m.hpA} PV`);
    else if (b === 1 && a >= 1) out.push(`Clutch ${B} 1v${a} : ${who(m.players.B)}, ${m.hpB} PV`);
    else if (Math.abs(a - b) >= 2) out.push(`${a > b ? A : B} en supériorité numérique ${Math.max(a, b)}v${Math.min(a, b)}`);
  }
  if ((m.phase === 'freezetime' || live) && m.buyA && m.buyB && m.buyA !== m.buyB) {
    const rank = { eco: 0, force: 1, half: 2, full: 3 };
    const aRich = rank[m.buyA] > rank[m.buyB];
    const [rich, poor] = aRich ? [A, B] : [B, A];
    const [bRich, bPoor] = aRich ? [m.buyA, m.buyB] : [m.buyB, m.buyA];
    out.push(`Économie : ${rich} mieux équipé que ${poor} (${BUYS[bRich]} contre ${BUYS[bPoor]})`);
  }
  if (m.phase === 'round_over' && m.buyA && m.buyB) {
    if (m.buyA === 'eco' && m.buyB !== 'eco') out.push(`${A} devrait être en eco au prochain round`);
    else if (m.buyB === 'eco' && m.buyA !== 'eco') out.push(`${B} devrait être en eco au prochain round`);
  }
  const r = m.scoreA + m.scoreB + 1;
  const pos = r <= 12 ? r : r - 12;
  if (r <= 24 && (pos === 2 || pos === 3) && m.hist.pw) out.push(`${m.hist.pw === 'A' ? A : B} a gagné le pistol : gros avantage économique`);
  const known = m.rounds.filter((o) => !o.synthetic);
  let k = 0;
  for (let i = known.length - 1; i >= 0 && known[i].winner === known[known.length - 1].winner; i--) k++;
  if (k >= 3) out.push(`${known[known.length - 1].winner === 'A' ? A : B} enchaîne ${k} rounds`);
  const all = [...m.players.A.map((p) => ({ ...p, t: A })), ...m.players.B.map((p) => ({ ...p, t: B }))].filter((p) => p.rating != null);
  if (m.scoreA + m.scoreB >= 5 && all.length) {
    const best = all.sort((x, y) => y.rating - x.rating)[0];
    out.push(`Meilleur joueur de la map : ${best.nick} (${best.t}) ${best.score}-${best.deaths}, ${Math.round(best.damagePrRound || 0)} ADR, rating ${best.rating.toFixed(2)}`);
  }
  const hl = validHltv(src.meta?.hltvProb);
  if (hl && hl.oriented && hl.reg1 != null && !res.over && Math.abs(hl.p1 - res.pMap) >= 0.1) {
    out.push(`Écart avec HLTV sur la map : ${A} ${pct(res.pMap)} (ProBet) contre ${pct(hl.p1)} (HLTV) — prudence`);
  }
  for (const f of m.facts || []) out.push(`HLTV : ${f}`);
  return out.slice(0, 5);
}

// Case cote : cote du bookmaker en direct si liée, sinon saisie manuelle + bouton 🔗.
function oddsCell(id, label, mem) {
  const live = mem.live?.[id];
  const src = sources.get(selected);
  const linked = src && linkOf(String(src.matchId), id);
  if (linked || live) {
    const fresh = live && live.odds > 1 && Date.now() - live.at < LIVE_TTL;
    return `<span class="live-odds${fresh ? '' : ' off'}" title="Cote lue en direct sur ${esc(live?.host || linked?.host || '')}">
      ${fresh ? `<b>${dec(live.odds)}</b> <small>${esc(live.host)}</small>` : `<small>${live?.auto ? 'suspendu' : 'cote indisponible'}</small>`}
      ${live?.auto && !linked ? '' : `<button type="button" class="unlink" data-unlink="${esc(id)}" aria-label="Délier">✕</button>`}</span>`;
  }
  const o = mem.odds[id];
  return `<input data-mid="${esc(id)}" inputmode="decimal" value="${o ? dec(o) : ''}" placeholder="—" aria-label="Cote">
    <button type="button" class="link" data-link="${esc(id)}" data-label="${esc(label)}" title="Lier à la cote de mon bookmaker">🔗</button>`;
}

const TAGS = { play: 'À JOUER', value: 'À JOUER', sure: 'SI BONNE COTE', low: 'PAS DE PARI', wait: 'PAS DE PARI', none: 'PAS DE PARI',
  suspended: 'ATTENDRE', nobook: 'PAS SUR STAKE', suspect: 'À VÉRIFIER' };

// Stake connecté : un pari n'est conseillé que s'il est réellement ouvert chez Stake.
function bookStatus(rows, mem, matchId) {
  if (!mem.book) return rows;
  return rows.map((r) => {
    if (!r.id || !['play', 'value', 'sure', 'low'].includes(r.status) || linkOf(String(matchId), r.id)) return r;
    const l = mem.live?.[r.id];
    if (!l?.auto && mem.book.desync && !r.id.startsWith('series')) return { ...r, status: 'suspended' };
    if (!l?.auto) return { ...r, status: 'nobook' };
    if (!(l.odds > 1)) return { ...r, status: 'suspended' };
    // Cote très loin du modèle : presque toujours un décalage (score, map) plutôt qu'une aubaine.
    if (r.p != null && Math.abs(1 / l.odds - r.p) > 0.3) return { ...r, status: 'suspect' };
    return r;
  });
}
// État de chaque source Stake : ✓ si elle a donné des cotes il y a moins de 30 s.
function sourcesLine(src) {
  const NAMES = { page: 'page', ws: 'flux direct', fetch: 'site', poll: 'relecture', dom: 'écran' };
  return Object.entries(NAMES).map(([k, n]) => {
    const age = src?.[k] != null ? Date.now() - src[k] : null;
    return `<span class="${age != null && age < 30000 ? 'ok' : 'off'}">${n} ${age == null ? '✗' : age < 30000 ? '✓' : `${Math.round(age / 1000)} s`}</span>`;
  }).join(' · ');
}

function adviceText(r) {
  const bank = Number(settings.bank) || 0;
  switch (r.status) {
    case 'value':
      return `Cote <b>${dec(r.odds)}</b> ≥ ${dec(r.min)} : avantage <b>+${dec(r.ev * 100, 1)} %</b> · mise <b>${dec(r.stake * 100, 1)} %</b> de la bankroll${bank ? ` (${Math.round(r.stake * bank)} €)` : ''}`;
    case 'play':
      return `Jouez si la cote est d'au moins <b>${dec(r.min)}</b>`;
    case 'sure':
      return `Très probable, mais la cote sera sûrement trop basse : seulement si elle atteint <b>${dec(r.min)}</b>`;
    case 'low':
      return `Votre cote ${dec(r.odds)} est trop basse : il faut au moins <b>${dec(r.min)}</b>`;
    case 'wait':
      return `Trop incertain : ne pariez pas sur ce marché pour l'instant`;
    case 'suspended':
      return `Marché suspendu chez Stake (round en cours) : jouez à sa réouverture si la cote atteint <b>${dec(r.min)}</b>`;
    case 'suspect':
      return `Cote Stake ${dec(r.odds ?? 0)} très éloignée du modèle (${pct(r.p)}) : vérifiez que Stake et HLTV montrent le même score avant de jouer`;
    case 'nobook':
      return 'Ce pari n’est pas proposé par Stake en ce moment';
    default:
      return 'Aucune ligne assez sûre pour l\'instant';
  }
}

function renderAdvice(picks, list, conf, mem) {
  $('conf').innerHTML = `Fiabilité <b>${pct(conf)}</b>`;
  if (document.activeElement?.tagName === 'INPUT' && $('advice').contains(document.activeElement)) return; // saisie d'une cote en cours
  mem.advice ??= {};
  const src = sources.get(selected);
  const rows = bookStatus(buildAdvice(mem.advice, { list, picks, odds: mem.odds, minEdge: (settings.edge || 4) / 100 }), mem, src?.matchId);
  if (rows.some((r) => r.frozen)) $('conf').innerHTML += ' · <span class="frozen">conseils figés pendant le round</span>';
  setHTML($('bookState'), (mem.book
    ? `<span class="ok">● Cotes ${esc(mem.book.host)}</span> · ${esc(mem.book.name)}${
      mem.book.age != null ? ` · mise à jour il y a ${Math.round(mem.book.age / 1000)} s` : ''}${
      mem.book.mapNote ? ` · <span class="warn">${esc(mem.book.mapNote)}</span>` : ''}
      <div class="srcs">${sourcesLine(mem.book.src)}</div>`
    : books.size ? 'Page Stake ouverte, mais pas sur ce match : ouvrez ce match sur Stake.'
      : 'Ouvrez ce match sur Stake dans un autre onglet : les cotes s’affichent toutes seules.')
    );
  setHTML($('advice'), rows.map((r) => {
    const go = r.status === 'play' || r.status === 'value';
    const frozen = r.frozen && Math.abs((r.now ?? r.p) - r.p) >= 0.03
      ? `<div class="adv-note">Maintenant ${pct(r.now)} : le conseil est figé jusqu'à la fin du round</div>` : '';
    return `<li class="adv s-${r.status}${go ? ' go' : ''}">
      <div class="adv-top"><span class="adv-mk">${esc(r.label)}</span><span class="adv-tag">${TAGS[r.status]}</span></div>
      ${r.id ? `<div class="adv-line"><span class="adv-sel">${esc(r.sel)}</span><span class="adv-p">${pct(r.p)}</span></div>` : ''}
      <div class="adv-how">${adviceText(r)}</div>${frozen}
      ${r.id ? `<div class="adv-odds">${oddsCell(r.id, `${r.sel} — ${r.label}`, mem)}</div>` : ''}
    </li>`;
  }).join(''));
}

function renderMarkets(list, mem) {
  if (document.activeElement?.dataset?.mid) return; // saisie en cours
  setHTML($('marketRows'), list.map((mk) => {
    const o = mem.odds[mk.id];
    const ev = evaluateBet(mk.p, o);
    return `<tr><td>${esc(mk.label)}<small>${esc(mk.group)}</small></td><td>${pct(mk.p)}</td><td>${dec(1 / mk.p)}</td>
      <td class="oc">${oddsCell(mk.id, `${mk.label} — ${mk.group}`, mem)}</td>
      <td class="${ev ? (ev.ev > 0 ? 'pos' : 'neg') : ''}">${ev ? `${ev.ev > 0 ? '+' : ''}${dec(ev.ev * 100, 1)}%` : ''}</td></tr>`;
  }).join(''));
}
function onOddsInput(e) {
  const id = e.target.dataset.mid;
  const src = sources.get(selected);
  if (!id || !src) return;
  const mem = memFor(src.matchId || selected);
  const v = parseFloat(String(e.target.value).replace(',', '.'));
  if (v > 1) mem.odds[id] = v; else delete mem.odds[id];
  e.target.blur();
  render();
}
$('marketRows').addEventListener('change', onOddsInput);
$('advice').addEventListener('change', onOddsInput);
for (const el of [$('marketRows'), $('advice')]) for (const t of ['pointerdown', 'click']) el.addEventListener(t, onLinkClick);
$('linkCancel').addEventListener('click', () => endPicking(''));
$('diagBtn').addEventListener('click', startDiag);
$('version').textContent = `ProBet v${hasChrome ? chrome.runtime.getManifest().version : 'démo'}`;

function renderPre(m, src) {
  const [A, B] = m.names;
  const meta = src.meta || {};
  const items = [];
  if (m.pre) {
    $('preSummary').textContent = `${A} ${pct(m.pre.pMap)} sur cette map`;
    items.push(`Estimation de départ : <b>${esc(A)} ${pct(m.pre.pMap)}</b> sur la map, ${pct(m.pre.pSeries)} sur la série`);
    for (const s of m.pre.sources) items.push(esc(s));
  } else {
    $('preSummary').textContent = 'aucune donnée';
    items.push('Pas de cote ni de classement lu sur la page : la force est estimée uniquement sur les rounds joués.');
  }
  const done = (meta.maps || []).filter((mp) => Number.isInteger(mp.s1) && Number.isInteger(mp.s2) && (mp.s1 >= 13 || mp.s2 >= 13));
  if (done.length) items.push(`Maps déjà jouées prises en compte : ${done.map((mp) => `${esc(mp.name)} ${mp.s1}-${mp.s2}`).join(', ')}`);
  $('pre').innerHTML = items.map((t) => `<li>${t}</li>`).join('');
}

function renderFeed(src) {
  $('feed').innerHTML = [...(src.log || [])].reverse().slice(0, 14)
    .map((l) => `<li class="${l.type === 'RoundEnd' ? 'round' : ''}">${esc(l.text)}</li>`).join('');
}

// Analyse d'un match (affiché ou non) : probabilités, paris, historique, journal.
function process(id, src) {
  const mem = memFor(src.matchId || id);
  const meta = { ...src.meta, prematchOverride: prematchOverride(), timer: src.timer };
  // Nouvelle map : on repart d'un historique vierge. (Clé = nom de la map : le numéro de map
  // dans la série change quand HLTV met à jour les résultats.)
  const key = String(src.scoreboard.mapName || '');
  if (mem.mapKey !== key) { mem.mapKey = key; mem.history = []; mem.econ = {}; mem.picks = {}; mem.winners = {}; mem.lastScore = null; }
  expireLive(mem);
  const m = toMatch(src.scoreboard, meta, mem);
  applyBooks(mem, m, src.matchId);
  mem.lastMapNumber = m.mapNumber;
  const res = analyze(m);

  const pMap = res.over ? (res.over === 'A' ? 1 : 0) : res.pMap;
  const lbl = `R${res.round} ${m.scoreA}-${m.scoreB}`;
  const prev = mem.history[mem.history.length - 1];
  if (!prev || Math.abs(prev.p - pMap) > 0.002 || prev.label !== lbl) mem.history.push({ p: pMap, label: lbl });
  if (mem.history.length > 500) mem.history.shift();

  const list = markets(res, m.names, m, mem.bookLines);
  const conf = confidence(res, 0.95, m.rounds.length);
  mem.picks ??= {};
  const picks = stablePicks(mem.picks, {
    list, odds: mem.odds, conf, minEdge: (settings.edge || 4) / 100, max: 99,
    phase: m.phase, round: m.round, mapKey: mem.mapKey,
    action: m.phase === 'bomb_planted' || (m.phase === 'live' && (m.aliveA < 5 || m.aliveB < 5)),
  });
  if (src.matchId && src.matchId !== 'demo') {
    const jkey = mapKeyOf(src.matchId, m.map || key);
    record(journal, { key: jkey, matchId: src.matchId, m, res, hltv: validHltv(src.meta?.hltvProb), scoreboard: src.scoreboard, meta: src.meta });
    backfill(journal, src.matchId, src.meta?.maps);
    logPicks(journal, jkey, picks, { round: res.round, a: m.scoreA, b: m.scoreB, phase: m.phase, ready: m.econReady });
    for (const [k, e] of Object.entries(journal.maps)) if (e.matchId === src.matchId) journalDirty.add(k);
  }
  return { mem, m, res, list, conf, picks };
}

function render() {
  const src = sources.get(selected);
  if (!src) {
    $('main').hidden = true; $('empty').hidden = false;
    status('idle', 'Aucune page de match HLTV ouverte');
    return;
  }
  if (!src.scoreboard) {
    $('main').hidden = true; $('empty').hidden = false;
    status('paused', src.meta?.hasScorebot === false
      ? `${label(src)} : pas de scoreboard live sur la page (match pas commencé ?)`
      : `${label(src)} : en attente des données live… (rechargez la page HLTV si rien n'arrive)`);
    return;
  }
  $('main').hidden = false; $('empty').hidden = true;
  const age = src.lastFrameAt ? Math.round((Date.now() - src.lastFrameAt) / 1000) : null;
  if (age != null && age > 90) status('paused', `Pas de nouvelle donnée depuis ${age} s (pause, mi-temps ?)`);
  else status('live', `En direct · ${label(src)}`);

  const { mem, m, res, list, conf, picks } = process(selected, src);
  renderBoard(m);
  renderProbs(m, res, src);
  sparkData = { history: mem.history, name: m.names[0] };
  renderSpark(mem.history, m.names[0]);
  $('facts').innerHTML = facts(m, res, src).map((f) => `<li>${esc(f)}</li>`).join('');
  renderFeed(src);
  renderPre(m, src);
  renderAdvice(picks, list, conf, mem);
  renderMarkets(list, mem);
}

// ---------- Réglages / diagnostic ----------

$('btnSettings').addEventListener('click', () => {
  $('setBank').value = settings.bank ?? '';
  $('setOdds1').value = settings.odds1 ? dec(settings.odds1) : '';
  $('setOdds2').value = settings.odds2 ? dec(settings.odds2) : '';
  $('setEdge').value = settings.edge ?? 4;
  renderJournal();
  $('settings').showModal();
});
$('settings').addEventListener('close', () => {
  const num = (id) => { const v = parseFloat(String($(id).value).replace(',', '.')); return Number.isFinite(v) ? v : null; };
  settings.bank = num('setBank');
  settings.odds1 = num('setOdds1');
  settings.odds2 = num('setOdds2');
  settings.edge = Math.max(1, Math.min(20, num('setEdge') ?? 4));
  saveSettings();
  render();
});
$('btnDiag').addEventListener('click', async () => {
  const src = sources.get(selected);
  const diag = {
    version: hasChrome ? chrome.runtime.getManifest().version : 'dev',
    url: src?.url, frames: src?.frames, lastFrameAt: src?.lastFrameAt, meta: src?.meta,
    scoreboard: src?.scoreboard, log: src?.log?.slice(-15),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
    $('btnDiag').textContent = 'Copié ✓';
  } catch {
    $('btnDiag').textContent = 'Copie impossible';
  }
  setTimeout(() => { $('btnDiag').textContent = 'Copier le diagnostic'; }, 2000);
});

function renderJournal() {
  const sm = summarize(journal);
  const lines = [`<b>${sm.maps}</b> map${sm.maps > 1 ? 's' : ''} enregistrée${sm.maps > 1 ? 's' : ''} (${sm.finished} terminée${sm.finished > 1 ? 's' : ''}), <b>${sm.rounds.n}</b> rounds.`];
  if (sm.rounds.n >= 20) lines.push(`Rounds : écart quadratique ${dec(sm.rounds.brier, 3)} (0,25 = pile ou face, plus bas = meilleur).`);
  if (sm.map.vsHltv?.n >= 10) lines.push(`Map : ProBet ${dec(sm.map.vsHltv.probet, 3)} contre HLTV ${dec(sm.map.vsHltv.hltv, 3)} (plus bas = meilleur).`);
  const pk = (x, name) => x.n ? `${name} : ${x.won}/${x.n} gagnés (${pct(x.won / x.n)}, annoncé ${pct(x.expected)})${x.units != null ? `, ${x.units >= 0 ? '+' : ''}${dec(x.units, 1)} unités` : ''}.` : null;
  for (const l of [pk(sm.picks.lean, 'Tendances'), pk(sm.picks.value, 'Paris VALUE')]) if (l) lines.push(l);
  if (sm.maps && sm.finished < 10) lines.push('Les chiffres deviennent parlants après une dizaine de maps terminées.');
  $('journalSummary').innerHTML = lines.map((l) => `<span>${l}</span>`).join('');
}
$('btnExport').addEventListener('click', () => {
  saveJournal();
  const data = {
    app: 'probet', version: hasChrome ? chrome.runtime.getManifest().version : 'dev',
    exported: new Date().toISOString(), summary: summarize(journal), journal,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `probet-journal-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
$('btnClearJournal').addEventListener('click', () => {
  if (!confirm('Effacer tout le journal ? Exportez-le d’abord si vous voulez le garder.')) return;
  journal = { ...newJournal(), removed: Object.keys(journal.maps) };
  saveJournal();
  renderJournal();
});

// ---------- Démarrage ----------

await loadSettings();
await loadLinks();
await loadJournal();
await discover();
setInterval(() => {
  // Rafraîchit les méta-données (maps, cotes) et l'indicateur d'activité.
  if (hasChrome && typeof selected === 'number') {
    chrome.tabs.sendMessage(selected, { type: 'probet:get' }).then((s) => s && onState(selected, s)).catch(() => {});
  } else {
    render();
  }
}, 5000);
if (new URLSearchParams(location.search).has('demo')) startDemo();
