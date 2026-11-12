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

  // Diagnostic HLTV : comment la page se connecte au scorebot (adresses, messages envoyés, premiers
  // messages reçus). Uniquement des données publiques du match ; transmis sur demande du panneau.
  const net = { ws: [], sent: [], recv: [], http: [] };
  const keep = (list, item, max) => { if (list.length < max) list.push({ t: Date.now(), ...item }); };
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.__probetDiagGet) window.postMessage({ __probetDiagData: net }, window.location.origin);
  });

  const NativeWS = window.WebSocket;
  window.WebSocket = new Proxy(NativeWS, {
    construct(target, args) {
      const ws = new target(...args);
      keep(net.ws, { url: String(args[0] || '') }, 20);
      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') keep(net.recv, { data: e.data.slice(0, 1500) }, 12);
        decode(e.data);
      });
      const origSend = ws.send.bind(ws);
      ws.send = (d) => { keep(net.sent, { data: String(d).slice(0, 1500) }, 40); return origSend(d); };
      return ws;
    },
  });

  // socket.io peut commencer en "long polling" HTTP avant de passer en websocket.
  const send = XMLHttpRequest.prototype.send;
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (/socket\.io|scorebot/i.test(String(url))) keep(net.http, { url: String(url), method }, 20);
    return open.call(this, method, url, ...rest);
  };
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
      keep(net.http, { url, body: typeof args[1]?.body === 'string' ? args[1].body.slice(0, 1500) : null }, 20);
      p.then((r) => r.clone().text().then(relay, () => {}), () => {});
    }
    return p;
  };
})();
