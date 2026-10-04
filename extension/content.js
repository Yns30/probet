// Script de contenu (page de match HLTV) : rassemble les données live et les
// méta-données de la page, puis les envoie au panneau ProBet.
(async () => {
  const { extractEvents, describeLog } = await import(chrome.runtime.getURL('hltv.js'));

  const state = {
    url: location.href,
    matchId: (/\/matches\/(\d+)/.exec(location.pathname) || [])[1] || null,
    meta: null,
    scoreboard: null,
    log: [],
    frames: 0,
    lastFrameAt: null,
    timer: null,
    updatedAt: Date.now(),
  };

  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const int = (s) => (/^\d+$/.test(String(s || '').trim()) ? Number(String(s).trim()) : null);
  const teamId = (root) => {
    const a = root?.querySelector('a[href*="/team/"]');
    const m = a && /\/team\/(\d+)/.exec(a.getAttribute('href'));
    return m ? Number(m[1]) : null;
  };

  // Probabilité de victoire affichée par HLTV (si présente) : recherche par le texte.
  // Probabilité live affichée par HLTV. L'ordre des pourcentages dans le widget ne suit pas
  // forcément équipe 1 / équipe 2 : chaque pourcentage est rattaché au nom ou logo d'équipe
  // le plus proche qui le précède (ou le suit) dans le widget.
  function hltvWinProb() {
    const t1 = (state.meta?.team1?.name || document.querySelector('#scoreboardElement')?.dataset.team1Name || '').toLowerCase();
    const t2 = (state.meta?.team2?.name || document.querySelector('#scoreboardElement')?.dataset.team2Name || '').toLowerCase();
    const labels = [...document.querySelectorAll('div, span, h2, h3')]
      .filter((el) => el.childElementCount === 0 && /win probability/i.test(el.textContent));
    for (const label of labels) {
      let box = label.parentElement;
      for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
        const seq = [];
        for (const e of box.querySelectorAll('*')) {
          if (e.childElementCount) continue;
          const name = (e.tagName === 'IMG' ? (e.alt || e.title) : e.textContent).trim().toLowerCase();
          const m = /^(\d{1,3}(?:[.,]\d+)?)\s*%$/.exec(name);
          if (m) { const v = parseFloat(m[1].replace(',', '.')); if (v >= 0 && v <= 100) seq.push({ v }); }
          else if (t1 && name === t1) seq.push({ team: 1 });
          else if (t2 && name === t2) seq.push({ team: 2 });
        }
        const nums = seq.filter((x) => x.v != null);
        if (!nums.length) continue;
        // Équipe associée au premier pourcentage
        const idx = seq.indexOf(nums[0]);
        const before = seq.slice(0, idx).reverse().find((x) => x.team);
        const after = seq.slice(idx + 1).find((x) => x.team);
        const firstTeam = before?.team ?? after?.team ?? 1;
        const a = nums[0].v / 100;
        const b = nums.length >= 2 && Math.abs(nums[0].v + nums[1].v - 100) < 1.5 ? nums[1].v / 100 : 1 - a;
        const p1 = firstTeam === 1 ? a : b;
        return { p1, p2: 1 - p1, oriented: Boolean(before || after), html: box.outerHTML.slice(0, 2500) };
      }
    }
    return null;
  }

  const pct = (t) => { const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(t || ''); return m ? parseFloat(m[1].replace(',', '.')) / 100 : null; };
  const num = (t) => { const m = /(\d+)/.exec(t || ''); return m ? Number(m[1]) : null; };

  // Score par mi-temps d'une map jouée : "(4:8; 7:5)" avec la classe ct/t du côté de chaque équipe.
  function halves(holder) {
    const spans = [...holder.querySelectorAll('.results-center-half-score span.ct, .results-center-half-score span.t')];
    const out = [];
    for (let i = 0; i + 1 < spans.length; i += 2) {
      out.push({
        s1: int(txt(spans[i])) ?? 0, s2: int(txt(spans[i + 1])) ?? 0,
        side1: spans[i].classList.contains('ct') ? 'CT' : 'T',
      });
    }
    return out;
  }

  // Taux de victoire par map sur 3 mois (bloc "Map stats").
  function mapStats() {
    const out = {};
    for (const row of document.querySelectorAll('[map-stats-infobox="wins"] .map-stats-infobox-maps')) {
      const st = row.querySelectorAll('.map-stats-infobox-stats');
      if (st.length < 2) continue;
      const read = (el) => ({ w: pct(txt(el.querySelector('.map-stats-infobox-winpercentage'))), n: num(txt(el.querySelector('.map-stats-infobox-maps-played'))) });
      const a = read(st[0]), b = read(st[1]);
      out[(row.dataset.mapname || '').toLowerCase()] = { w1: a.w, n1: a.n, w2: b.w, n2: b.n };
    }
    return out;
  }

  function avgRating(attr) {
    try {
      const raw = document.querySelector('.lineups-compare-container')?.getAttribute(attr);
      const players = Object.values(JSON.parse(raw || '{}'));
      const r = players.map((p) => p.numericRating).filter((x) => typeof x === 'number');
      return r.length ? r.reduce((t, x) => t + x, 0) / r.length : null;
    } catch { return null; }
  }

  // Rating 3 mois de chaque joueur (identifiant HLTV = dbId du scorebot).
  function playerRatings() {
    const out = {};
    for (const attr of ['data-team1-players-data', 'data-team2-players-data']) {
      try {
        const raw = document.querySelector('.lineups-compare-container')?.getAttribute(attr);
        for (const p of Object.values(JSON.parse(raw || '{}'))) {
          if (p.playerId && typeof p.numericRating === 'number') out[p.playerId] = p.numericRating;
        }
      } catch { /* bloc absent */ }
    }
    return out;
  }

  function form(i) {
    const box = document.querySelectorAll('[data-past-matches-core] .past-matches-box')[i];
    if (!box) return null;
    return { won: box.querySelectorAll('.past-matches-score .won').length, lost: box.querySelectorAll('.past-matches-score .lost').length };
  }

  // Chrono du round affiché dans le scoreboard live (ex. "0:45").
  function readTimer() {
    const root = document.querySelector('#scoreboardElement');
    if (!root) return null;
    const sb = state.scoreboard;
    const scores = sb ? [`${sb.counterTerroristScore}:${sb.terroristScore}`, `${sb.terroristScore}:${sb.counterTerroristScore}`] : [];
    for (const el of root.querySelectorAll('*')) {
      if (el.childElementCount) continue;
      const t = el.textContent.trim();
      const m = /^([0-2]):([0-5]\d)$/.exec(t);
      if (m && !scores.includes(t)) return Number(m[1]) * 60 + Number(m[2]);
    }
    return null;
  }

  function readMeta() {
    const sbEl = document.querySelector('#scoreboardElement');
    const t1 = document.querySelector('.team1-gradient');
    const t2 = document.querySelector('.team2-gradient');
    const lineups = document.querySelectorAll('.lineup');
    const rank = (i) => num(txt(lineups[i]?.querySelector('.hltv-ranking')));
    const vrs = [...document.querySelectorAll('.vrs-forecast-left-numbers .vrs-forecast-points')].map((e) => num(txt(e)));
    const maps = [...document.querySelectorAll('.mapholder')].map((h) => ({
      name: txt(h.querySelector('.mapname')),
      s1: int(txt(h.querySelector('.results-left .results-team-score'))),
      s2: int(txt(h.querySelector('.results-right .results-team-score'))),
      halves: halves(h),
    }));
    const odds = [...document.querySelectorAll('tr.provider:not(.hidden)')]
      .map((tr) => [...tr.querySelectorAll('.odds-cell')]
        .map((c) => parseFloat(txt(c)?.replace(',', '.')))
        .filter((x) => x > 1 && x < 100))
      .filter((a) => a.length >= 2)
      .map((a) => [a[0], a[a.length - 1]]);
    const format = txt(document.querySelector('.preformatted-text'));
    const h2h = document.querySelectorAll('.head-to-head .bold');
    state.meta = {
      team1: {
        name: sbEl?.dataset.team1Name || txt(t1?.querySelector('.teamName')),
        id: Number(sbEl?.dataset.team1Id) || teamId(t1),
        rank: rank(0), vrs: vrs[0] ?? null, rating: avgRating('data-team1-players-data'), form: form(0),
      },
      team2: {
        name: sbEl?.dataset.team2Name || txt(t2?.querySelector('.teamName')),
        id: Number(sbEl?.dataset.team2Id) || teamId(t2),
        rank: rank(1), vrs: vrs[1] ?? null, rating: avgRating('data-team2-players-data'), form: form(1),
      },
      format,
      bestOf: (/best of (\d)/i.exec(format || '') || [])[1] ? Number(/best of (\d)/i.exec(format)[1]) : null,
      maps,
      mapStats: mapStats(),
      playerRatings: playerRatings(),
      odds,
      h2h: h2h.length >= 3 ? { w1: int(txt(h2h[0])), w2: int(txt(h2h[2])) } : null,
      hltvProb: hltvWinProb(),
      hasScorebot: Boolean(sbEl),
    };
  }

  let pending = null;
  function push() {
    state.updatedAt = Date.now();
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      chrome.runtime.sendMessage({ type: 'probet:state', state }).catch(() => {});
    }, 250);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__probet) return;
    const events = extractEvents(e.data.text);
    if (!events.length) return;
    state.frames += events.length;
    state.lastFrameAt = Date.now();
    for (const { event, data } of events) {
      if (event === 'scoreboard' && data && typeof data === 'object') state.scoreboard = data;
      else if (event === 'log' && Array.isArray(data?.log)) {
        // Le scorebot envoie les entrées les plus récentes en premier.
        for (const entry of [...data.log].reverse()) {
          const text = describeLog(entry);
          if (text) state.log.push({ t: Date.now(), text, type: Object.keys(entry)[0] });
        }
        state.log = state.log.slice(-60);
      }
    }
    state.timer = readTimer();
    push();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'probet:get') {
      readMeta();
      reply(state);
    }
  });

  const tick = () => { readMeta(); push(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick, { once: true });
  else tick();
  setInterval(tick, 4000);
})();
