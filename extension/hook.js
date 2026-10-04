// S'exécute dans la page HLTV, avant ses propres scripts.
// Observe (sans rien modifier) les messages reçus par le tableau live de la page
// et les transmet au script de contenu de l'extension. Aucune requête supplémentaire.
(() => {
  const KEYS = /"(scoreboard|log|fullLog)"|counterTerroristScore/;
  const relay = (text) => {
    if (typeof text === 'string' && text.length > 8 && KEYS.test(text)) {
      window.postMessage({ __probet: true, text }, window.location.origin);
    }
  };
  const decode = (data) => {
    if (typeof data === 'string') relay(data);
    else if (data instanceof Blob) data.text().then(relay, () => {});
    else if (data instanceof ArrayBuffer) relay(new TextDecoder().decode(data));
  };

  const NativeWS = window.WebSocket;
  window.WebSocket = new Proxy(NativeWS, {
    construct(target, args) {
      const ws = new target(...args);
      ws.addEventListener('message', (e) => decode(e.data));
      return ws;
    },
  });

  // socket.io peut commencer en "long polling" HTTP avant de passer en websocket.
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      if (this.responseType === '' || this.responseType === 'text') relay(this.responseText);
    });
    return send.apply(this, args);
  };
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const p = nativeFetch.apply(this, args);
    const url = String(args[0]?.url || args[0] || '');
    if (/socket\.io|scorebot/i.test(url)) {
      p.then((r) => r.clone().text().then(relay, () => {}), () => {});
    }
    return p;
  };
})();
