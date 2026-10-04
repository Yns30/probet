import { analyze, markets, recommend, confidence, mapProbFromSeries, evaluateBet } from './engine.js';
import { createMatch, ingest, toEngineInput, setScore, commitRound } from './tracker.js';
import { createDemo } from './demo.js';

const $ = (id) => document.getElementById(id);
const pct = (p) => `${Math.round(p * 100)}%`;
const odds = (o) => o.toFixed(2).replace('.', ',');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const PHASES = {
  freezetime: 'Temps d’achat', live: 'Round en cours', bomb_planted: 'Bombe posée',
  round_over: 'Fin de round', timeout: 'Pause tactique', halftime: 'Mi-temps',
  map_over: 'Fin de map', replay: 'Replay', not_ingame: 'Hors jeu', unknown: 'En attente',
};

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`probet:${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`probet:${k}`, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

let match = createMatch();
let userOdds = {};
let history = [];
let lastResult = null;
const settings = store.get('settings', { interval: 6, bank: null });

// ---------- Rendu ----------

function names() {
  return [match.names.A || 'Équipe A', match.names.B || 'Équipe B'];
}

function renderBoard() {
  const [A, B] = names();
  $('nameA').textContent = A;
  $('nameB').textContent = B;
  $('scoreA').textContent = match.scoreA;
  $('scoreB').textContent = match.scoreB;
  const sB = match.aSide === 'CT' ? 'T' : match.aSide === 'T' ? 'CT' : '';
  $('sideA').textContent = match.aSide || '';
  $('sideB').textContent = sB;
  const dots = (n) => Array.from({ length: 5 }, (_, i) => `<i class="${n != null && i < n ? 'on' : ''}"></i>`).join('');
  $('aliveA').innerHTML = dots(match.aliveA);
  $('aliveB').innerHTML = dots(match.aliveB);

  const bits = [];
  const series = match.bestOf > 1 ? `Map ${match.mapNumber} · BO${match.bestOf} ${match.mapsA}-${match.mapsB}` : 'BO1';
  bits.push(series);
  if (match.map) bits.push(match.map[0].toUpperCase() + match.map.slice(1));
  if (!match.mapOver) bits.push(`Round ${match.scoreA + match.scoreB + 1}`);
  bits.push(match.bombPlanted ? `<span class="bomb">Bombe posée${match.bombSite ? ' ' + match.bombSite : ''}</span>` : PHASES[match.phase] || '');
  if (match.timer != null && !match.bombPlanted && match.phase === 'live') {
    bits.push(`${Math.floor(match.timer / 60)}:${String(match.timer % 60).padStart(2, '0')}`);
  }
  $('roundInfo').innerHTML = bits.filter(Boolean).join(' · ');
}

function bar(label, p, [A, B]) {
  const a = Math.round(p * 100);
  return `<div class="bar">
    <div class="lbl"><span>${esc(A)} <b>${a}%</b></span><span>${esc(label)}</span><span><b>${100 - a}%</b> ${esc(B)}</span></div>
    <div class="track"><i style="width:${a}%"></i><i style="width:${100 - a}%"></i></div>
  </div>`;
}

function renderProbs(res) {
  const n = names();
  let html = '';
  if (res.pRound != null) html += bar(`Round ${res.round}`, res.pRound, n);
  html += bar(match.mapOver ? 'Map terminée' : `Map ${match.mapNumber}`, res.over ? (res.over === 'A' ? 1 : 0) : res.pMap, n);
  if (res.pSeries != null) html += bar(`Série BO${match.bestOf}`, res.pSeries, n);
  $('bars').innerHTML = html;

  const [best] = res.likelyScores;
  $('extra').innerHTML = res.over ? '' : `
    <div><small>Score final le + probable</small><b>${best ? best[0] : '—'}</b></div>
    <div><small>Total rounds attendu</small><b>${res.expTotal.toFixed(1).replace('.', ',')}</b></div>
    <div><small>Prolongation</small><b>${pct(res.pOT)}</b></div>`;
}

function renderSpark() {
  const svg = $('spark');
  $('sparkLabel').textContent = names()[0];
  const pts = history;
  if (pts.length < 2) { svg.innerHTML = '<line class="mid" x1="0" x2="300" y1="40" y2="40"/>'; return; }
  const x = (i) => (i / (pts.length - 1)) * 300;
  const y = (p) => 4 + (1 - p) * 72;
  const d = pts.map((pt, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pt.p).toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  svg.innerHTML = `<line class="mid" x1="0" x2="300" y1="40" y2="40"/>
    <path class="line" d="${d}"/>
    <circle class="dot" cx="${x(pts.length - 1)}" cy="${y(last.p)}" r="4"/>`;
}

$('spark').addEventListener('pointermove', (e) => {
  if (history.length < 2) return;
  const r = e.currentTarget.getBoundingClientRect();
  const i = Math.round(((e.clientX - r.left) / r.width) * (history.length - 1));
  const pt = history[Math.max(0, Math.min(history.length - 1, i))];
  const tip = $('sparkTip');
  tip.hidden = false;
  tip.style.left = `${e.clientX - r.left}px`;
  tip.textContent = `${pt.label} · ${names()[0]} ${pct(pt.p)}`;
});
$('spark').addEventListener('pointerleave', () => { $('sparkTip').hidden = true; });

function renderPicks(list, conf) {
  const picks = recommend(list, userOdds, conf);
  $('conf').innerHTML = `Fiabilité <b>${pct(conf)}</b>`;
  if (!picks.length) {
    $('picks').innerHTML = `<li class="empty">Rien d’intéressant pour l’instant. L’assistant surveille le match et affichera un pari dès qu’une opportunité apparaît.<br>Astuce : saisissez les cotes de votre bookmaker dans « Tous les marchés » pour détecter les paris à valeur.</li>`;
    return;
  }
  const bank = Number(settings.bank) || 0;
  $('picks').innerHTML = picks.map((p) => {
    const act = p.kind === 'value'
      ? `<span>Cote <b>${odds(p.odds)}</b></span><span>Cote juste ${odds(p.fair)}</span><span>Avantage <b>+${(p.ev * 100).toFixed(1).replace('.', ',')}%</b></span>
         <span>Mise conseillée <b>${(p.stake * 100).toFixed(1).replace('.', ',')}%</b>${bank ? ` (${Math.round(p.stake * bank)} €)` : ''} de la bankroll</span>`
      : `<span>Jouez seulement si la cote est ≥ <b>${odds(p.target)}</b></span><span>Cote juste ${odds(p.fair)}</span>`;
    return `<li class="pick ${p.kind}">
      <div class="g">${esc(p.group)}<span class="badge ${p.kind}">${p.kind === 'value' ? 'VALUE' : 'TENDANCE'}</span></div>
      <div class="p">${pct(p.p)}<small>proba</small></div>
      <div class="sel">${esc(p.label)}</div>
      <div class="act">${act}</div>
    </li>`;
  }).join('');
}

function renderMarkets(list) {
  const focused = document.activeElement?.dataset?.mid;
  if (focused) return; // ne pas écraser une saisie en cours
  $('marketRows').innerHTML = list.map((m) => {
    const o = userOdds[m.id];
    const ev = evaluateBet(m.p, o);
    const cls = ev ? (ev.ev > 0 ? 'pos' : 'neg') : '';
    return `<tr><td>${esc(m.group)}</td><td>${esc(m.label)}</td><td>${pct(m.p)}</td><td>${odds(1 / m.p)}</td>
      <td><input data-mid="${esc(m.id)}" inputmode="decimal" value="${o ? odds(o) : ''}" placeholder="—"></td>
      <td class="${cls}">${ev ? `${ev.ev > 0 ? '+' : ''}${(ev.ev * 100).toFixed(1).replace('.', ',')}%` : ''}</td></tr>`;
  }).join('');
}

$('marketRows').addEventListener('change', (e) => {
  const id = e.target.dataset.mid;
  if (!id) return;
  const v = parseFloat(String(e.target.value).replace(',', '.'));
  if (v > 1) userOdds[id] = v; else delete userOdds[id];
  e.target.blur();
  update();
});

function renderFacts() {
  $('facts').innerHTML = match.facts.map((f) => `<li>${esc(f)}</li>`).join('');
}

function logEvents(list) {
  const t = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  for (const e of list) $('events').insertAdjacentHTML('afterbegin', `<li><time>${t}</time>${esc(e)}</li>`);
  while ($('events').children.length > 60) $('events').lastChild.remove();
}

function update() {
  renderBoard();
  renderFacts();
  const res = analyze(toEngineInput(match));
  lastResult = res;
  const pMap = res.over ? (res.over === 'A' ? 1 : 0) : res.pMap;
  const label = `R${res.round} ${match.scoreA}-${match.scoreB}`;
  const prev = history[history.length - 1];
  if (!prev || Math.abs(prev.p - pMap) > 0.002 || prev.label !== label) history.push({ p: pMap, label });
  if (history.length > 400) history.shift();
  renderProbs(res);
  renderSpark();
  const list = markets(res, names(), toEngineInput(match));
  const conf = confidence(res, match.visionConf, match.rounds.length);
  renderPicks(list, conf);
  renderMarkets(list);
}

// ---------- Statut ----------

function status(kind, text) {
  const el = $('status');
  el.className = `status ${kind}`;
  el.querySelector('span').textContent = text;
}

// ---------- Capture du stream ----------

const video = $('video');
let capture = null; // { stream, timer, busy }
let demo = null;

function grab() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const full = document.createElement('canvas');
  const scale = Math.min(1, 1280 / w);
  full.width = Math.round(w * scale); full.height = Math.round(h * scale);
  full.getContext('2d').drawImage(video, 0, 0, full.width, full.height);
  // Zoom sur le bandeau du haut (scores, timer, maps) pour une lecture fiable.
  const hud = document.createElement('canvas');
  const cropH = Math.round(h * 0.16);
  const hs = Math.min(1, 1600 / w);
  hud.width = Math.round(w * hs); hud.height = Math.round(cropH * hs);
  hud.getContext('2d').drawImage(video, 0, 0, w, cropH, 0, 0, hud.width, hud.height);
  return { frame: full.toDataURL('image/jpeg', 0.82), hud: hud.toDataURL('image/jpeg', 0.9) };
}

function readContext() {
  const [A, B] = names();
  const [L, R] = match.aIsLeft ? [A, B] : [B, A];
  const [sl, sr] = match.aIsLeft ? [match.scoreA, match.scoreB] : [match.scoreB, match.scoreA];
  return { left: L, right: R, score: `${sl}-${sr}`, map: match.map };
}

async function tick() {
  if (!capture) return;
  const started = performance.now();
  const imgs = grab();
  if (imgs) {
    try {
      const r = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...imgs, context: readContext() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const ev = ingest(match, data.state);
      logEvents(ev);
      update();
      status('live', `En direct · lecture ${(data.ms / 1000).toFixed(1).replace('.', ',')} s`);
    } catch (err) {
      status('error', err.message);
    }
  }
  if (!capture) return;
  const wait = Math.max(500, settings.interval * 1000 - (performance.now() - started));
  capture.timer = setTimeout(tick, wait);
}

async function startCapture() {
  stopDemo();
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    video.srcObject = stream;
    await video.play();
    capture = { stream, timer: null };
    stream.getVideoTracks()[0].addEventListener('ended', stopCapture);
    $('btnCapture').textContent = 'Arrêter';
    status('live', 'Connexion au stream…');
    tick();
  } catch (err) {
    status('error', err.name === 'NotAllowedError' ? 'Partage refusé' : err.message);
  }
}

function stopCapture() {
  if (!capture) return;
  clearTimeout(capture.timer);
  capture.stream.getTracks().forEach((t) => t.stop());
  capture = null;
  video.srcObject = null;
  $('btnCapture').textContent = 'Connecter le stream';
  status('paused', 'En pause');
}

$('btnCapture').addEventListener('click', () => (capture ? stopCapture() : startCapture()));

// ---------- Démo ----------

function startDemo() {
  stopCapture();
  resetMatch();
  const sim = createDemo(Date.now() % 100000);
  demo = setInterval(() => {
    logEvents(ingest(match, sim.next()));
    update();
  }, 900);
  $('btnDemo').textContent = 'Arrêter la démo';
  status('live', 'Démo — match simulé');
}
function stopDemo() {
  if (!demo) return;
  clearInterval(demo);
  demo = null;
  $('btnDemo').textContent = 'Démo';
  status('paused', 'En pause');
}
$('btnDemo').addEventListener('click', () => (demo ? stopDemo() : startDemo()));

// ---------- Réglages ----------

function resetMatch() {
  const keep = { bestOf: match.bestOf, names: match.lockNames ? { ...match.names } : { A: null, B: null }, lockNames: match.lockNames, prematchMapProb: match.prematchMapProb };
  match = Object.assign(createMatch(), keep);
  userOdds = {};
  history = [];
  $('events').innerHTML = '';
  update();
}

function applyPrematch() {
  const oa = parseFloat(String($('setOddsA').value).replace(',', '.'));
  const ob = parseFloat(String($('setOddsB').value).replace(',', '.'));
  if (oa > 1 && ob > 1) {
    const pa = (1 / oa) / (1 / oa + 1 / ob); // marge du bookmaker retirée
    match.prematchMapProb = mapProbFromSeries(pa, match.bestOf);
  } else {
    match.prematchMapProb = null;
  }
}

$('btnSettings').addEventListener('click', () => {
  $('setNameA').value = match.lockNames ? match.names.A || '' : '';
  $('setNameB').value = match.lockNames ? match.names.B || '' : '';
  $('setBo').value = String(match.bestOf);
  $('setMap').value = match.map || '';
  $('setInterval').value = settings.interval;
  $('setBank').value = settings.bank ?? '';
  $('settings').showModal();
});

$('settings').addEventListener('close', () => {
  const na = $('setNameA').value.trim(), nb = $('setNameB').value.trim();
  if (na || nb) {
    match.lockNames = true;
    if (na) match.names.A = na;
    if (nb) match.names.B = nb;
  }
  match.bestOf = Number($('setBo').value);
  const mp = $('setMap').value.trim().toLowerCase();
  if (mp) match.map = mp;
  settings.interval = Math.max(2, Math.min(60, Number($('setInterval').value) || 6));
  settings.bank = Number($('setBank').value) || null;
  store.set('settings', settings);
  applyPrematch();
  update();
});

$('btnReset').addEventListener('click', () => {
  match.lockNames = false;
  match.prematchMapProb = null;
  $('setOddsA').value = ''; $('setOddsB').value = '';
  resetMatch();
  $('settings').close();
});

document.querySelector('.manual').addEventListener('click', (e) => {
  const cmd = e.target.dataset.m;
  if (!cmd) return;
  const ev = [];
  if (cmd === 'swap') match.aSide = match.aSide === 'CT' ? 'T' : 'CT';
  else if (cmd === 'swapTeams') {
    match.aIsLeft = !match.aIsLeft;
  } else {
    const [k, d] = cmd.split(':');
    const delta = Number(d);
    if (k === 'scoreA' || k === 'scoreB') {
      if (delta > 0 && !match.mapOver) commitRound(match, k === 'scoreA' ? 'A' : 'B', ev);
      else setScore(match, match.scoreA + (k === 'scoreA' ? delta : 0), match.scoreB + (k === 'scoreB' ? delta : 0), ev);
    } else {
      match[k] = Math.max(0, match[k] + delta);
    }
  }
  match.pending = null;
  logEvents(ev.length ? ev : ['Correction manuelle']);
  update();
});

// ---------- Démarrage ----------

fetch('/api/health').then((r) => r.json()).then((h) => {
  if (!h.credentials) status('paused', 'Clé API absente : mode démo/manuel');
}).catch(() => status('error', 'Serveur injoignable'));

if (new URLSearchParams(location.search).has('demo')) startDemo();
update();
