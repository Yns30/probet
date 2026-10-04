import { analyze, markets, recommend, confidence, evaluateBet } from './engine.js';
import { toMatch, describeLog, seriesState } from './hltv.js';
import { createDemoMatch } from './demo.js';

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
  if (id === selected) render();
}

if (hasChrome) {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === 'probet:state' && sender.tab) onState(sender.tab.id, msg.state);
  });
  chrome.tabs.onRemoved.addListener((id) => {
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
  const ref = !hp ? '' : hp.oriented === false
    ? `Proba live affichée par HLTV : ${pct(hp.p1)} / ${pct(hp.p2)} (équipes non identifiées)`
    : `Proba live affichée par HLTV : ${esc(m.names[0])} ${pct(hp.p1)} · ${esc(m.names[1])} ${pct(hp.p2)}`;
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
  for (const f of m.facts || []) out.push(`HLTV : ${f}`);
  return out.slice(0, 5);
}

function renderPicks(list, conf, mem) {
  const picks = recommend(list, mem.odds, conf, { minEdge: (settings.edge || 4) / 100, max: 4 });
  $('conf').innerHTML = `Fiabilité <b>${pct(conf)}</b>`;
  if (!picks.length) {
    $('picks').innerHTML = '<li class="none">Rien d’intéressant pour l’instant : ProBet surveille le match. Entrez les cotes de votre bookmaker dans « Tous les marchés » pour détecter les paris à valeur.</li>';
    return;
  }
  const bank = Number(settings.bank) || 0;
  $('picks').innerHTML = picks.map((p) => {
    const act = p.kind === 'value'
      ? `<span>Cote <b>${dec(p.odds)}</b> (juste ${dec(p.fair)})</span><span>Avantage <b>+${dec(p.ev * 100, 1)}%</b></span>
         <span>Mise <b>${dec(p.stake * 100, 1)}%</b> de la bankroll${bank ? ` (${Math.round(p.stake * bank)} €)` : ''}</span>`
      : `<span>À jouer si la cote est ≥ <b>${dec(p.target)}</b></span><span>Cote juste ${dec(p.fair)}</span>`;
    return `<li class="pick ${p.kind}">
      <div class="g">${esc(p.group)}<span class="badge ${p.kind}">${p.kind === 'value' ? 'VALUE' : 'TENDANCE'}</span></div>
      <div class="p">${pct(p.p)}</div>
      <div class="sel">${esc(p.label)}</div>
      <div class="act">${act}</div>
    </li>`;
  }).join('');
}

function renderMarkets(list, mem) {
  if (document.activeElement?.dataset?.mid) return; // saisie en cours
  $('marketRows').innerHTML = list.map((mk) => {
    const o = mem.odds[mk.id];
    const ev = evaluateBet(mk.p, o);
    return `<tr><td>${esc(mk.label)}<small>${esc(mk.group)}</small></td><td>${pct(mk.p)}</td><td>${dec(1 / mk.p)}</td>
      <td><input data-mid="${esc(mk.id)}" inputmode="decimal" value="${o ? dec(o) : ''}" placeholder="—"></td>
      <td class="${ev ? (ev.ev > 0 ? 'pos' : 'neg') : ''}">${ev ? `${ev.ev > 0 ? '+' : ''}${dec(ev.ev * 100, 1)}%` : ''}</td></tr>`;
  }).join('');
}
$('marketRows').addEventListener('change', (e) => {
  const id = e.target.dataset.mid;
  const src = sources.get(selected);
  if (!id || !src) return;
  const mem = memFor(src.matchId || selected);
  const v = parseFloat(String(e.target.value).replace(',', '.'));
  if (v > 1) mem.odds[id] = v; else delete mem.odds[id];
  e.target.blur();
  render();
});

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

  const mem = memFor(src.matchId || selected);
  const meta = { ...src.meta, prematchOverride: prematchOverride(), timer: src.timer };
  // Nouvelle map : on repart d'un historique vierge.
  const key = `${src.scoreboard.mapName}|${seriesState(meta.maps, src.scoreboard.mapName).mapNumber}`;
  if (mem.mapKey !== key) { mem.mapKey = key; mem.history = []; mem.econ = {}; }
  const m = toMatch(src.scoreboard, meta, mem);
  const res = analyze(m);

  const pMap = res.over ? (res.over === 'A' ? 1 : 0) : res.pMap;
  const lbl = `R${res.round} ${m.scoreA}-${m.scoreB}`;
  const prev = mem.history[mem.history.length - 1];
  if (!prev || Math.abs(prev.p - pMap) > 0.002 || prev.label !== lbl) mem.history.push({ p: pMap, label: lbl });
  if (mem.history.length > 500) mem.history.shift();

  renderBoard(m);
  renderProbs(m, res, src);
  sparkData = { history: mem.history, name: m.names[0] };
  renderSpark(mem.history, m.names[0]);
  $('facts').innerHTML = facts(m, res, src).map((f) => `<li>${esc(f)}</li>`).join('');
  renderFeed(src);
  renderPre(m, src);
  const list = markets(res, m.names, m);
  const conf = confidence(res, 0.95, m.rounds.length);
  renderPicks(list, conf, mem);
  renderMarkets(list, mem);
}

// ---------- Réglages / diagnostic ----------

$('btnSettings').addEventListener('click', () => {
  $('setBank').value = settings.bank ?? '';
  $('setOdds1').value = settings.odds1 ? dec(settings.odds1) : '';
  $('setOdds2').value = settings.odds2 ? dec(settings.odds2) : '';
  $('setEdge').value = settings.edge ?? 4;
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

// ---------- Démarrage ----------

await loadSettings();
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
