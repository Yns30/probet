// Lecture locale et gratuite du HUD : OCR Tesseract (dans le navigateur) + analyse de pixels.
// Produit une lecture au même format que celui consommé par tracker.js.
import {
  binarize, countAlive, sideFromColor, isRed, parseScore, parseTimer, signature, sigDiff, baselineOf,
} from './pixels.js';

export const ZONES = [
  { id: 'scoreL', label: 'Score gauche', required: true },
  { id: 'scoreR', label: 'Score droite', required: true },
  { id: 'timer', label: 'Chrono du round' },
  { id: 'playersL', label: 'Cartes joueurs gauche (les 5)' },
  { id: 'playersR', label: 'Cartes joueurs droite (les 5)' },
  { id: 'colorL', label: 'Couleur équipe gauche (CT/T)' },
  { id: 'colorR', label: 'Couleur équipe droite (CT/T)' },
];

const PSM_LINE = '7';
const PSM_WORD = '8';

// Récupère les pixels d'une zone (coordonnées en fractions de l'image source).
export function cropPixels(source, zone, scaleToHeight = null) {
  const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
  const x = Math.round(zone.x * sw), y = Math.round(zone.y * sh);
  const w = Math.max(1, Math.round(zone.w * sw)), h = Math.max(1, Math.round(zone.h * sh));
  const k = scaleToHeight ? scaleToHeight / h : 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x, y, w, h, 0, 0, c.width, c.height);
  return { canvas: c, ctx, img: ctx.getImageData(0, 0, c.width, c.height) };
}

// Prépare une zone de texte pour l'OCR : agrandie, binarisée, avec marge blanche.
function ocrCanvas(source, zone) {
  const { img } = cropPixels(source, zone, 72);
  binarize(img);
  const pad = 16;
  const c = document.createElement('canvas');
  c.width = img.width + pad * 2; c.height = img.height + pad * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.putImageData(img, pad, pad);
  return c;
}

export async function createReader(onProgress) {
  const T = window.Tesseract;
  if (!T) throw new Error('Tesseract non chargé');
  const worker = await T.createWorker('eng', 1, {
    workerPath: '/vendor/tesseract/worker.min.js',
    corePath: '/vendor/tesseract-core',
    langPath: '/vendor/lang',
    logger: (m) => onProgress?.(m),
  });
  const cache = new Map(); // id → { sig, value, conf }
  let currentParams = '';

  async function ocr(source, zone, id, whitelist, parse) {
    const { img } = cropPixels(source, zone, 24);
    const sig = signature(img);
    const prev = cache.get(id);
    if (prev && sigDiff(sig, prev.sig) < 3) return prev;
    const canvas = ocrCanvas(source, zone);
    let value = null, conf = 0;
    for (const psm of [PSM_LINE, PSM_WORD]) {
      const params = `${whitelist}|${psm}`;
      if (params !== currentParams) {
        await worker.setParameters({ tessedit_char_whitelist: whitelist, tessedit_pageseg_mode: psm });
        currentParams = params;
      }
      const { data } = await worker.recognize(canvas);
      value = parse(data.text);
      conf = data.confidence / 100;
      if (value != null) break;
    }
    const out = { sig, value, conf };
    cache.set(id, out);
    return out;
  }

  // calib : { zones: {id: {x,y,w,h}}, baseline: {playersL, playersR}, sensitivity }
  async function read(source, calib) {
    const z = calib.zones || {};
    const sl = z.scoreL ? await ocr(source, z.scoreL, 'scoreL', '0123456789', parseScore) : null;
    const sr = z.scoreR ? await ocr(source, z.scoreR, 'scoreR', '0123456789', parseScore) : null;
    const tm = z.timer ? await ocr(source, z.timer, 'timer', '0123456789:.', parseTimer) : null;
    const bomb = z.timer && tm?.value == null ? isRed(cropPixels(source, z.timer).img) : false;
    const alive = (id) => (z[id] ? countAlive(cropPixels(source, z[id]).img, calib.baseline?.[id], calib.sensitivity) : null);
    const side = (id) => (z[id] ? sideFromColor(cropPixels(source, z[id]).img) : null);
    const aliveL = alive('playersL'), aliveR = alive('playersR');
    const scores = [sl?.value, sr?.value];
    const visible = scores.every((v) => v != null);
    const confs = [sl, sr].filter(Boolean).map((x) => x.conf);
    return {
      hud_visible: visible,
      map: null,
      left: { name: null, score: sl?.value ?? null, side: side('colorL'), alive: aliveL, money: null, buy: 'unknown' },
      right: { name: null, score: sr?.value ?? null, side: side('colorR'), alive: aliveR, money: null, buy: 'unknown' },
      phase: !visible ? 'not_ingame' : bomb ? 'bomb_planted' : 'live',
      round_timer: tm?.value ?? null,
      bomb_planted: bomb,
      bomb_site: null,
      maps_left: null, maps_right: null, best_of: null,
      key_facts: [],
      confidence: confs.length ? Math.min(...confs) : 0,
      noisy: true,
    };
  }

  // Référence "5 joueurs en vie" pour les cartes joueurs, à capturer pendant le temps d'achat.
  function baseline(source, calib) {
    const out = {};
    for (const id of ['playersL', 'playersR']) {
      if (calib.zones?.[id]) out[id] = baselineOf(cropPixels(source, calib.zones[id]).img);
    }
    return out;
  }

  return { read, baseline, reset: () => cache.clear(), terminate: () => worker.terminate() };
}
