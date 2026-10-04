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
  function hltvWinProb() {
    const labels = [...document.querySelectorAll('div, span, h2, h3')]
      .filter((el) => el.childElementCount === 0 && /win probability/i.test(el.textContent));
    for (const label of labels) {
      let box = label.parentElement;
      for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
        const nums = [...box.textContent.matchAll(/(\d{1,3}(?:[.,]\d)?)\s*%/g)].map((m) => parseFloat(m[1].replace(',', '.')));
        if (nums.length >= 2) return { p1: nums[0] / 100, p2: nums[1] / 100 };
      }
    }
    return null;
  }

  function readMeta() {
    const t1 = document.querySelector('.team1-gradient');
    const t2 = document.querySelector('.team2-gradient');
    const maps = [...document.querySelectorAll('.mapholder')].map((h) => ({
      name: txt(h.querySelector('.mapname')),
      s1: int(txt(h.querySelector('.results-left .results-team-score'))),
      s2: int(txt(h.querySelector('.results-right .results-team-score'))),
    }));
    const odds = [...document.querySelectorAll('tr.provider:not(.hidden)')]
      .map((tr) => [...tr.querySelectorAll('.odds-cell')]
        .map((c) => parseFloat(txt(c)?.replace(',', '.')))
        .filter((x) => x > 1 && x < 100))
      .filter((a) => a.length >= 2)
      .map((a) => [a[0], a[a.length - 1]]);
    const format = txt(document.querySelector('.preformatted-text'));
    state.meta = {
      team1: { name: txt(t1?.querySelector('.teamName')), id: teamId(t1) },
      team2: { name: txt(t2?.querySelector('.teamName')), id: teamId(t2) },
      format,
      bestOf: (/best of (\d)/i.exec(format || '') || [])[1] ? Number(/best of (\d)/i.exec(format)[1]) : null,
      maps,
      odds,
      hltvProb: hltvWinProb(),
      hasScorebot: Boolean(document.querySelector('#scoreboardElement')),
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
