// Analyse de pixels du HUD (fonctions pures sur des objets {data, width, height}
// au format ImageData), utilisables dans le navigateur et dans les tests Node.

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

// Statistiques couleur d'une image (ou d'une sous-zone x0..x1, y0..y1).
export function colorStats(img, x0 = 0, y0 = 0, x1 = img.width, y1 = img.height) {
  let n = 0, sat = 0, val = 0, blue = 0, orange = 0, red = 0, vivid = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const [h, s, v] = rgbToHsv(img.data[i], img.data[i + 1], img.data[i + 2]);
      n++; sat += s; val += v;
      if (s > 0.35 && v > 0.3) {
        vivid++;
        if (h >= 180 && h <= 255) blue++;
        else if (h >= 18 && h <= 65) orange++;
        else if (h < 12 || h > 340) red++;
      }
    }
  }
  return { sat: sat / n, val: val / n, blue: blue / n, orange: orange / n, red: red / n, vivid: vivid / n };
}

// Côté d'après la couleur dominante : bleu = CT, orange/jaune = T.
export function sideFromColor(img) {
  const s = colorStats(img);
  if (s.blue > 0.08 && s.blue > 2 * s.orange) return 'CT';
  if (s.orange > 0.08 && s.orange > 2 * s.blue) return 'T';
  return null;
}

// Zone majoritairement rouge (chrono remplacé par l'icône/couleur de bombe).
export const isRed = (img) => colorStats(img).red > 0.2;

// Découpe la zone des 5 cartes joueurs (empilées en colonne ou alignées en ligne).
export function slices(img, n = 5) {
  const vertical = img.height > img.width;
  const out = [];
  for (let k = 0; k < n; k++) {
    if (vertical) {
      const y0 = Math.floor((k * img.height) / n), y1 = Math.floor(((k + 1) * img.height) / n);
      out.push(colorStats(img, 0, y0, img.width, y1));
    } else {
      const x0 = Math.floor((k * img.width) / n), x1 = Math.floor(((k + 1) * img.width) / n);
      out.push(colorStats(img, x0, 0, x1, img.height));
    }
  }
  return out;
}

// "Vivacité" d'une carte joueur : un joueur mort est grisé et assombri.
export const vitality = (s) => s.sat * 0.6 + s.val * 0.4;

// Nombre de joueurs en vie, comparé à la référence capturée avec 5 joueurs en vie.
export function countAlive(img, baseline, sensitivity = 0.62) {
  const cur = slices(img).map(vitality);
  if (!baseline || baseline.length !== cur.length) {
    return cur.filter((v) => v > 0.22).length; // sans calibration : seuil absolu
  }
  return cur.filter((v, i) => v >= baseline[i] * sensitivity).length;
}

export const baselineOf = (img) => slices(img).map(vitality);

// Empreinte basse résolution pour éviter de relancer l'OCR si la zone n'a pas changé.
export function signature(img, w = 16, h = 8) {
  const out = new Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = Math.min(img.width - 1, Math.floor(((i + 0.5) * img.width) / w));
      const y = Math.min(img.height - 1, Math.floor(((j + 0.5) * img.height) / h));
      const p = (y * img.width + x) * 4;
      out[j * w + i] = (img.data[p] + img.data[p + 1] + img.data[p + 2]) / 3;
    }
  }
  return out;
}
export const sigDiff = (a, b) => (!a || !b || a.length !== b.length ? Infinity
  : a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length);

// Binarisation (Otsu) avec texte noir sur fond blanc, pour l'OCR. Modifie img en place.
export function binarize(img) {
  const n = img.width * img.height;
  const gray = new Uint8Array(n);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) {
    const g = Math.round(0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2]);
    gray[i] = g; hist[g]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  let bright = 0;
  for (let i = 0; i < n; i++) if (gray[i] > thr) bright++;
  const textIsBright = bright < n / 2; // le texte occupe la minorité des pixels
  for (let i = 0; i < n; i++) {
    const on = gray[i] > thr;
    const v = on === textIsBright ? 0 : 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

// Interprétation des textes OCR.
export function parseScore(text) {
  const m = /\d{1,2}/.exec(String(text).replace(/[oO]/g, '0').replace(/[lI|]/g, '1'));
  if (!m) return null;
  const v = parseInt(m[0], 10);
  return v <= 40 ? v : null;
}

export function parseTimer(text) {
  const t = String(text).replace(/\s/g, '').replace(/[oO]/g, '0');
  let m = /(\d):?(\d{2})/.exec(t);
  if (m) {
    const s = +m[1] * 60 + +m[2];
    return +m[2] < 60 && s <= 175 ? s : null;
  }
  m = /^(\d{1,2})[.,]\d$/.exec(t); // affichage "9.8" sous 10 s
  return m ? +m[1] : null;
}
