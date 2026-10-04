// Serveur local ProBet : sert l'interface et les fichiers de l'OCR (Tesseract.js).
// Aucune API externe : toute la lecture du stream se fait dans le navigateur.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// Préfixe d'URL → dossier servi.
const ROOTS = [
  ['/vendor/tesseract/', path.join(here, 'node_modules/tesseract.js/dist')],
  ['/vendor/tesseract-core/', path.join(here, 'node_modules/tesseract.js-core')],
  ['/vendor/lang/', path.join(here, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int')],
  ['/', path.join(here, 'public')],
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
};

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/') pathname = '/index.html';
  const [prefix, dir] = ROOTS.find(([p]) => pathname.startsWith(p));
  const file = path.normalize(path.join(dir, pathname.slice(prefix.length)));
  if (!file.startsWith(dir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('introuvable');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ProBet CS2 → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
