// Relais Stake → panneau : stake.js (monde de la page) ne peut pas parler à l'extension,
// ce script le fait pour lui. Il garde aussi le dernier état pour un panneau ouvert après coup.
(() => {
  let last = null;
  const host = location.hostname.replace(/^www\./, '');
  const send = () => last && chrome.runtime.sendMessage({ type: 'probet:book', book: 'stake', host, url: location.href, fixture: last }).catch(() => {});
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'probet-stake' || !e.data.fixture) return;
    last = e.data.fixture;
    send();
  });
  chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === 'probet:book-get') send(); });
})();
