// Analyse d'un export du journal ProBet :
//   node tools/analyse-journal.mjs probet-journal-AAAA-MM-JJ.json [autres exports…]
// Affiche le bilan, le calibrage, les paris par marché, et rejoue le modèle actuel sur les
// débuts de round enregistrés (pour mesurer l'effet d'un changement du modèle).
import { readFileSync } from 'node:fs';
import { summarize, settle } from '../extension/journal.js';
import { toMatch } from '../extension/hltv.js';
import { analyze } from '../extension/engine.js';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage : node tools/analyse-journal.mjs export.json …'); process.exit(1); }
const j = { maps: {} };
for (const f of files) Object.assign(j.maps, JSON.parse(readFileSync(f, 'utf8')).journal.maps);

const f3 = (x) => (x == null ? '—' : x.toFixed(3));
const p0 = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const sm = summarize(j);
console.log(`Maps : ${sm.maps} (${sm.finished} terminées)`);
console.log(`Rounds : ${sm.rounds.n}, Brier ${f3(sm.rounds.brier)}`);
console.log(`Map (à chaque début de round) : ${sm.map.n}, Brier ${f3(sm.map.brier)}`);
if (sm.map.vsHltv) console.log(`  même moments, ProBet ${f3(sm.map.vsHltv.probet)} contre HLTV ${f3(sm.map.vsHltv.hltv)} (n=${sm.map.vsHltv.n})`);
console.log(`Avant-match : ${sm.prior.n} maps, Brier ${f3(sm.prior.brier)}`);
for (const [name, cal] of [['round', sm.rounds.calibration], ['map', sm.map.calibration]]) {
  console.log(`\nCalibrage ${name} (favori) : tranche → annoncé / observé (n)`);
  for (const b of cal) console.log(`  ${p0(b.lo)}–${p0(b.hi)} : ${p0(b.predicted)} / ${p0(b.observed)} (${b.n})`);
}

// Paris par type de marché.
const groups = new Map();
for (const e of Object.values(j.maps)) {
  for (const p of Object.values(e.picks)) {
    const won = settle(p.id, e);
    if (won == null) continue;
    const g = `${p.kind} ${p.id.replace(/\d+(\.\d+)?|-/g, '').replace(/:.*/, '')}`;
    const s = groups.get(g) ?? { n: 0, won: 0, p: 0 };
    s.n++; s.won += won; s.p += p.p ?? 0;
    groups.set(g, s);
  }
}
console.log('\nParis : marché → gagnés / proposés (annoncé)');
for (const [g, s] of groups) console.log(`  ${g} : ${s.won}/${s.n} = ${p0(s.won / s.n)} (annoncé ${p0(s.p / s.n)})`);

// Rejeu du modèle actuel sur les débuts de round enregistrés.
const replay = [];
for (const e of Object.values(j.maps)) {
  for (const R of Object.values(e.rounds)) {
    if (!R.w || !R.start?.sb) continue;
    try {
      const m = toMatch(R.start.sb, e.meta || {}, { econ: {} });
      const res = analyze(m);
      if (Number.isFinite(res.pRound)) replay.push([res.pRound, R.start.pr, R.w === 'A' ? 1 : 0]);
    } catch { /* relevé illisible */ }
  }
}
const brier = (xs) => xs.reduce((s, [p, y]) => s + (p - y) ** 2, 0) / xs.length;
if (replay.length) {
  console.log(`\nRejeu (${replay.length} rounds) : modèle actuel ${f3(brier(replay.map(([p, , y]) => [p, y])))}, ` +
    `modèle au moment du match ${f3(brier(replay.map(([, p, y]) => [p, y])))}`);
}
