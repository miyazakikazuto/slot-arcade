'use strict';

/**
 * Lollipop Arcade — Slot Engine (murni, tanpa DOM)
 * Dipakai oleh browser (window.SlotEngine) dan Node (require).
 *
 * Semua fungsi deterministik terhadap seed → mudah di-test & bisa
 * direproduksi (konsep provably-fair untuk edukasi).
 */

/* ------------------------------------------------------------------ */
/* Konstanta game                                                      */
/* ------------------------------------------------------------------ */

const REEL_COUNT = 5;
const ROW_COUNT = 3;

/** Simbol: bobot = frekuensi di strip, pay = bayaran x lineBet (3/4/5 beruntun) */
const SYMBOLS = {
  WILD:    { name: 'Wild Permen',  icon: '🌈', weight: 2, pay: { 3: 30, 4: 90, 5: 300 } },
  SCATTER: { name: 'Lollipop',     icon: '🍭', weight: 2, pay: null }, // bayar di mana saja
  DIAMOND: { name: 'Permen Berlian', icon: '💎', weight: 4, pay: { 3: 20, 4: 50, 5: 150 } },
  STAR:    { name: 'Bintang Gula', icon: '⭐', weight: 5, pay: { 3: 14, 4: 34, 5: 100 } },
  HEART:   { name: 'Hati Manis',   icon: '❤️', weight: 6, pay: { 3: 10, 4: 28, 5: 80 } },
  GRAPE:   { name: 'Anggur',       icon: '🍇', weight: 7, pay: { 3: 8,  4: 20, 5: 55 } },
  LEMON:   { name: 'Lemon',        icon: '🍋', weight: 8, pay: { 3: 5,  4: 15, 5: 40 } },
  CHERRY:  { name: 'Ceri',         icon: '🍒', weight: 8, pay: { 3: 5,  4: 14, 5: 28 } },
};

/** Urutan tetap untuk membangun strip (interleaving merata) */
const SYMBOL_ORDER = ['WILD', 'SCATTER', 'DIAMOND', 'STAR', 'HEART', 'GRAPE', 'LEMON', 'CHERRY'];

/** Bayaran SCATTER = kelipatan total bet (lineBet x jumlah garis) */
const SCATTER_PAY = { 3: 4, 4: 20, 5: 100 };

/** Free spins: {sebelum, sesudah} — base game vs retrigger saat free spin */
const FREE_SPINS_BASE = { 3: 5, 4: 8, 5: 12 };
const FREE_SPINS_RETRIGGER = { 3: 3, 4: 5, 5: 8 };
const FREE_SPINS_CAP = 50;
const FREE_SPIN_MULTIPLIER = 2;

/** 10 payline — per reel (0..4) barisnya (0=atas, 1=tengah, 2=bawah) */
const PAYLINES = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
  [1, 0, 1, 0, 1],
];

/* ------------------------------------------------------------------ */
/* RNG                                                                 */
/* ------------------------------------------------------------------ */

/** PRNG cepat 32-bit → [0, 1) */
function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash string → uint32 (cyrb-style), untuk seed:nonce → rng per spin */
function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** Seed acak untuk seed baru (crypto bila ada) */
function randomSeed() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    g.crypto.getRandomValues(buf);
    return buf[0];
  }
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}

/** rng dari seed string (mis. seed + ':' + nonce) */
function rngFromString(seedStr) {
  return mulberry32(hashString(seedStr));
}

/* ------------------------------------------------------------------ */
/* Reel strip                                                          */
/* ------------------------------------------------------------------ */

/** Strip per reel: simbol berbobot besar disebar merata (interleaving deterministik) */
function buildStrip() {
  const maxW = Math.max.apply(null, SYMBOL_ORDER.map((s) => SYMBOLS[s].weight));
  const strip = [];
  for (let k = 0; k < maxW; k++) {
    for (const s of SYMBOL_ORDER) {
      if (SYMBOLS[s].weight > k) strip.push(s);
    }
  }
  return strip;
}

const STRIPS = [];
for (let r = 0; r < REEL_COUNT; r++) STRIPS.push(buildStrip());

/**
 * Putaran: stop acak uniform per reel → grid[reel][row].
 * @returns {{grid: string[][], stops: number[]}}
 */
function spin(rng) {
  const grid = [];
  const stops = [];
  for (let r = 0; r < REEL_COUNT; r++) {
    const strip = STRIPS[r];
    const stop = Math.floor(rng() * strip.length);
    stops.push(stop);
    const col = [];
    for (let row = 0; row < ROW_COUNT; row++) {
      col.push(strip[(stop + row) % strip.length]);
    }
    grid.push(col);
  }
  return { grid, stops };
}

/* ------------------------------------------------------------------ */
/* Evaluasi kemenangan                                                 */
/* ------------------------------------------------------------------ */

/**
 * Evaluasi satu grid.
 * @param {string[][]} grid grid[reel][row]
 * @param {{lineBet?: number, totalBet?: number, freeSpin?: boolean, retrigger?: boolean}} opts
 *   lineBet  : bet per garis (default 1)
 *   totalBet : bet total per spin = lineBet x jumlah garis (untuk bayaran scatter)
 *   freeSpin : sedang di mode free spin (multiplier x2)
 *   retrigger: free spin ini terjadi saat mode free spin (tabel retrigger)
 */
function evaluate(grid, opts) {
  opts = opts || {};
  const lineBet = opts.lineBet != null ? opts.lineBet : 1;
  const totalBet = opts.totalBet != null ? opts.totalBet : lineBet * PAYLINES.length;
  const multiplier = opts.freeSpin ? FREE_SPIN_MULTIPLIER : 1;
  const lineWins = [];
  let lineWinTotal = 0;

  for (let li = 0; li < PAYLINES.length; li++) {
    const rows = PAYLINES[li];
    const cells = rows.map((row, reel) => ({ reel, row, sym: grid[reel][row] }));
    if (cells[0].sym === 'SCATTER') continue;

    // Kandidat = simbol unik di garis (termasuk WILD sendiri)
    const candidates = [];
    for (const c of cells) {
      if (c.sym !== 'SCATTER' && candidates.indexOf(c.sym) === -1) candidates.push(c.sym);
    }

    let best = null;
    for (const cand of candidates) {
      let count = 0;
      for (const c of cells) {
        if (c.sym === cand || c.sym === 'WILD') count++;
        else break;
      }
      if (count < 3) continue;
      const pay = (SYMBOLS[cand].pay[count] || 0) * lineBet;
      if (pay > 0 && (!best || pay > best.amount)) {
        best = {
          line: li,
          symbol: cand,
          count,
          amount: pay * multiplier,
          cells: cells.slice(0, count).map((c) => [c.reel, c.row]),
        };
      }
    }
    if (best) {
      lineWins.push(best);
      lineWinTotal += best.amount;
    }
  }

  // Scatter: bayar di posisi mana pun
  let scatterCount = 0;
  const scatterCells = [];
  for (let r = 0; r < REEL_COUNT; r++) {
    for (let row = 0; row < ROW_COUNT; row++) {
      if (grid[r][row] === 'SCATTER') {
        scatterCount++;
        scatterCells.push([r, row]);
      }
    }
  }
  const sc = Math.min(scatterCount, 5);
  const scatterWin = sc >= 3 ? SCATTER_PAY[sc] * totalBet * multiplier : 0;

  // Free spins
  let freeSpinsAwarded = 0;
  if (sc >= 3) {
    const table = opts.retrigger ? FREE_SPINS_RETRIGGER : FREE_SPINS_BASE;
    freeSpinsAwarded = table[sc];
  }

  return {
    grid,
    lineWins,
    lineWinTotal,
    scatterCount,
    scatterCells,
    scatterWin,
    freeSpinsAwarded,
    multiplier,
    totalWin: lineWinTotal + scatterWin,
  };
}

/** spin + evaluate sekaligus dari satu rng */
function playSpin(rng, opts) {
  const s = spin(rng);
  const res = evaluate(s.grid, opts);
  res.stops = s.stops;
  return res;
}

/* ------------------------------------------------------------------ */
/* Simulasi RTP (untuk test & tuning matematika game)                  */
/* ------------------------------------------------------------------ */

/**
 * Simulasi n spin (termasuk semua free spin) → rincian RTP.
 * Deterministik: hasil sama untuk (spins, seed) yang sama.
 */
function simulate(spins, seed, opts) {
  opts = opts || {};
  const lineBet = opts.lineBet != null ? opts.lineBet : 1;
  const totalBet = lineBet * PAYLINES.length;
  const rng = mulberry32(seed >>> 0);

  let bets = 0;
  let totalWin = 0;
  let lineWin = 0;
  let scatterWin = 0;
  let fsWin = 0;
  let fsPlayed = 0;
  let triggers = 0;
  let maxWin = 0;

  for (let i = 0; i < spins; i++) {
    bets += totalBet;
    const res = playSpin(rng, { lineBet, totalBet });
    lineWin += res.lineWinTotal;
    scatterWin += res.scatterWin;
    totalWin += res.totalWin;
    if (res.totalWin > maxWin) maxWin = res.totalWin;

    if (res.freeSpinsAwarded > 0) triggers++;

    // Mainkan free spins (retrigger pakai tabel retrigger, cap anti-infinite)
    let fsLeft = res.freeSpinsAwarded;
    while (fsLeft > 0 && fsPlayed < FREE_SPINS_CAP * spins) {
      fsLeft--;
      fsPlayed++;
      const fr = playSpin(rng, { lineBet, totalBet, freeSpin: true, retrigger: true });
      lineWin += fr.lineWinTotal;
      scatterWin += fr.scatterWin;
      fsWin += fr.totalWin;
      totalWin += fr.totalWin;
      if (fr.totalWin > maxWin) maxWin = fr.totalWin;
      if (fr.freeSpinsAwarded > 0) fsLeft += fr.freeSpinsAwarded;
    }
  }

  return {
    spins,
    bets,
    totalWin,
    lineWin,
    scatterWin,
    fsWin,
    fsPlayed,
    triggers,
    maxWin,
    rtp: totalWin / bets,
  };
}

/* ------------------------------------------------------------------ */
/* Export (UMD ringan)                                                 */
/* ------------------------------------------------------------------ */

const api = {
  REEL_COUNT,
  ROW_COUNT,
  SYMBOLS,
  SYMBOL_ORDER,
  SCATTER_PAY,
  FREE_SPINS_BASE,
  FREE_SPINS_RETRIGGER,
  FREE_SPIN_MULTIPLIER,
  PAYLINES,
  STRIPS,
  mulberry32,
  hashString,
  randomSeed,
  rngFromString,
  buildStrip,
  spin,
  evaluate,
  playSpin,
  simulate,
};

if (typeof module === 'object' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.SlotEngine = api;
}
