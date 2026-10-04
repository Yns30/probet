// Match simulé : produit des lectures au même format que la vision,
// pour tester l'interface sans stream ni clé API.
import { mapWinner, sideAt } from './engine.js';

export function createDemo(seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const st = {
    left: { name: 'Vitality', score: 0, side: 'CT' },
    right: { name: 'Spirit', score: 0, side: 'T' },
    maps: [0, 0], phase: 'freezetime', tick: 0, alive: [5, 5], bomb: false, timer: 115, buys: ['full', 'full'],
  };
  const strength = 0.58; // Vitality légèrement meilleur

  const startRound = () => {
    const r = st.left.score + st.right.score + 1;
    st.left.side = sideAt(r, 1, 'CT'); st.right.side = st.left.side === 'CT' ? 'T' : 'CT';
    const pistol = r === 1 || r === 13;
    st.buys = pistol ? ['eco', 'eco'] : [rnd() < 0.8 ? 'full' : 'force', rnd() < 0.75 ? 'full' : rnd() < 0.5 ? 'eco' : 'force'];
    st.phase = 'freezetime'; st.tick = 0; st.alive = [5, 5]; st.bomb = false; st.timer = 115;
  };

  const step = () => {
    st.tick++;
    if (st.phase === 'freezetime') {
      if (st.tick >= 2) { st.phase = 'live'; st.tick = 0; }
    } else if (st.phase === 'live' || st.phase === 'bomb_planted') {
      st.timer = Math.max(0, st.timer - 14);
      if (rnd() < 0.75) {
        const tIdx = st.left.side === 'T' ? 0 : 1;
        const pKillByLeft = strength + 0.04 * (st.alive[0] - st.alive[1]);
        if (rnd() < pKillByLeft) st.alive[1]--; else st.alive[0]--;
        if (!st.bomb && st.alive[tIdx] > 0 && rnd() < 0.25) { st.bomb = true; st.phase = 'bomb_planted'; }
      }
      const tIdx = st.left.side === 'T' ? 0 : 1, ctIdx = 1 - tIdx;
      let winner = null;
      if (st.alive[ctIdx] === 0) winner = tIdx;
      else if (st.alive[tIdx] === 0) winner = st.bomb ? (rnd() < 0.6 ? ctIdx : tIdx) : ctIdx;
      else if (st.tick > 8) winner = st.bomb ? tIdx : ctIdx;
      if (winner !== null) {
        (winner === 0 ? st.left : st.right).score++;
        st.phase = 'round_over'; st.tick = 0;
      }
    } else if (st.phase === 'round_over') {
      const a = st.left.score, b = st.right.score;
      if (mapWinner(a, b)) {
        st.maps[a > b ? 0 : 1]++;
        st.left.score = 0; st.right.score = 0;
        st.left.side = 'CT'; st.right.side = 'T';
      }
      if (st.tick >= 1) startRound();
    }
  };

  const read = () => ({
    hud_visible: true,
    map: 'de_mirage',
    left: { ...st.left, alive: st.alive[0], money: null, buy: st.buys[0] },
    right: { ...st.right, alive: st.alive[1], money: null, buy: st.buys[1] },
    phase: st.phase,
    round_timer: st.bomb ? null : st.timer,
    bomb_planted: st.bomb,
    bomb_site: st.bomb ? 'B' : null,
    maps_left: st.maps[0], maps_right: st.maps[1], best_of: 3,
    key_facts: st.phase === 'freezetime' && st.buys.includes('eco')
      ? [`${st.buys[0] === 'eco' ? st.left.name : st.right.name} en eco`]
      : st.alive[0] !== st.alive[1] && st.phase !== 'round_over'
        ? [`${st.alive[0]}v${st.alive[1]} en cours`] : [],
    confidence: 0.92,
  });

  return { next() { step(); return read(); }, read };
}
