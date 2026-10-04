// Serveur local ProBet : sert l'interface et relaie les images du stream vers Claude.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { readFrame, MODEL } from './src/vision.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 12 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('image trop lourde'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const hasCredentials = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

async function handleAnalyze(req, res) {
  try {
    const body = await readBody(req);
    const t0 = Date.now();
    const out = await readFrame(body);
    send(res, 200, { ...out, ms: Date.now() - t0 });
  } catch (err) {
    let status = err.status || 500;
    let message = err.message;
    if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(message)) {
      status = 401;
      message = 'Clé API Anthropic invalide ou absente (ANTHROPIC_API_KEY).';
    }
    else if (err instanceof Anthropic.RateLimitError) message = 'Limite de débit atteinte, nouvel essai au prochain cycle.';
    else if (err instanceof Anthropic.APIConnectionError) { status = 502; message = 'Connexion à l’API Claude impossible.'; }
    else if (err instanceof SyntaxError) { status = 502; message = 'Réponse illisible du modèle.'; }
    console.error('[analyze]', message);
    send(res, status, { error: message });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'interdit' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'introuvable' });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/analyze') return handleAnalyze(req, res);
  if (req.method === 'GET' && req.url === '/api/health') {
    return send(res, 200, { ok: true, model: MODEL, credentials: hasCredentials() });
  }
  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 405, { error: 'méthode non autorisée' });
});

server.listen(PORT, HOST, () => {
  console.log(`ProBet CS2 → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Modèle vision : ${MODEL}${hasCredentials() ? '' : '  (⚠ ANTHROPIC_API_KEY non définie — mode manuel/démo uniquement)'}`);
});
