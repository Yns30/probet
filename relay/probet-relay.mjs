#!/usr/bin/env node
// ProBet — relais entre deux PC.
// Le PC « collecteur » (pages HLTV et Stake ouvertes) envoie ici, en continu, ce que lisent ses
// pages ; le PC « affichage » reçoit tout en direct et fait tourner le panneau ProBet comme si les
// pages étaient ouvertes chez lui. Aucune dépendance : Node.js 18 ou plus suffit.
//
//   node probet-relay.mjs            (port 8787)
//   node probet-relay.mjs 9000       (autre port)
//
// Accès protégé par un code (affiché au démarrage, gardé dans probet-relay-code.txt) à saisir
// dans les réglages ProBet des deux PC. Seules des données publiques transitent (scores, cotes,
// journal des matchs), jamais rien du compte Stake.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || process.env.PROBET_PORT || 8787);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const CODE_FILE = path.join(DIR, 'probet-relay-code.txt');
const MAX_BODY = 30 * 1024 * 1024;
const KEEP_MS = 15 * 60 * 1000; // une page muette depuis 15 min est oubliée

function loadCode() {
  try {
    const c = fs.readFileSync(CODE_FILE, 'utf8').trim();
    if (c) return c;
  } catch { /* premier lancement */ }
  const c = crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(CODE_FILE, `${c}\n`);
  return c;
}
const CODE = loadCode();

// Dernier état connu de chaque page (clé « state:12 », « book:34 »), renvoyé à chaque
// nouvel affichage qui se connecte.
const cache = new Map();
let journal = null; // texte JSON du journal du collecteur
let journalAt = 0;
const clients = new Set();
let lastPush = 0;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-probet-code',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Private-Network': 'true',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...CORS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('trop gros')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function broadcast(item) {
  const line = `data: ${JSON.stringify(item)}\n\n`;
  for (const res of clients) res.write(line);
}

function ingest(item) {
  if (!item || typeof item !== 'object' || item.id == null) return;
  const id = String(item.id);
  if (item.type === 'gone') {
    cache.delete(`state:${id}`);
    cache.delete(`book:${id}`);
  } else if (item.type === 'state' || item.type === 'book') {
    cache.set(`${item.type}:${id}`, { ...item, at: Date.now() });
  } else return;
  broadcast(item);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at > KEEP_MS) {
      cache.delete(k);
      broadcast({ type: 'gone', id: v.id, kind: v.type });
    }
  }
  for (const res of clients) res.write(': ok\n\n'); // garde la connexion ouverte
}, 15000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relais');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (url.pathname === '/' && req.method === 'GET') {
    send(res, 200, `ProBet relais : en marche. Pages suivies : ${cache.size}. Affichages connectés : ${clients.size}.\n`, 'text/plain; charset=utf-8');
    return;
  }
  const code = req.headers['x-probet-code'] || url.searchParams.get('code');
  if (code !== CODE) { send(res, 403, { error: 'code incorrect' }); return; }

  try {
    if (url.pathname === '/status' && req.method === 'GET') {
      send(res, 200, { ok: true, pages: cache.size, viewers: clients.size, lastPush, journalAt });
    } else if (url.pathname === '/push' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      for (const item of body.items || []) ingest(item);
      lastPush = Date.now();
      send(res, 200, { ok: true, viewers: clients.size });
    } else if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      for (const v of cache.values()) res.write(`data: ${JSON.stringify(v)}\n\n`);
      if (journalAt) res.write(`data: ${JSON.stringify({ type: 'journal', at: journalAt })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (url.pathname === '/journal' && req.method === 'POST') {
      const text = await readBody(req);
      JSON.parse(text); // vérifie que c'est bien du JSON
      journal = text;
      journalAt = Date.now();
      broadcast({ type: 'journal', at: journalAt });
      send(res, 200, { ok: true });
    } else if (url.pathname === '/journal' && req.method === 'GET') {
      if (!journal) send(res, 404, { error: 'pas encore de journal' });
      else send(res, 200, journal);
    } else {
      send(res, 404, { error: 'inconnu' });
    }
  } catch (e) {
    send(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('');
  console.log('  ProBet relais en marche.');
  console.log('');
  console.log(`  Code à saisir dans ProBet (Réglages > Deux PC) : ${CODE}`);
  console.log('  Adresse à saisir (une de celles-ci, selon le réseau) :');
  for (const ip of ips) console.log(`     http://${ip}:${PORT}`);
  console.log('');
  console.log('  Laissez cette fenêtre ouverte. Ctrl+C pour arrêter.');
  console.log('');
});
