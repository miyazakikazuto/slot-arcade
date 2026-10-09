'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/engine.js');

/* ------------------------------------------------------------------ */
/* Helper: grid dasar — tiap reel diisi simbol BERBEDA                */
/* (cross-reel beda simbol → tidak ada garis yang bisa menang)         */
/* ------------------------------------------------------------------ */
const BASE_REEL_SYMS = ['CHERRY', 'LEMON', 'GRAPE', 'HEART', 'STAR'];

function baseGrid() {
  return BASE_REEL_SYMS.map((sym) => [sym, sym, sym]);
}

/* ------------------------------------------------------------------ */
/* RNG                                                                 */
/* ------------------------------------------------------------------ */

test('mulberry32 deterministik & distribusi mendekati uniform', () => {
  const a = E.mulberry32(42);
  const b = E.mulberry32(42);
  let sum = 0;
  const n = 100000;
  for (let i = 0; i < n; i++) {
    const x = a();
    assert.equal(x, b()); // seed sama → rangkaian sama
    assert.ok(x >= 0 && x < 1);
    sum += x;
  }
  const mean = sum / n;
  assert.ok(Math.abs(mean - 0.5) < 0.01, `mean=${mean}`);
});

test('hashString stabil dan peka terhadap input', () => {
  assert.equal(E.hashString('123:1'), E.hashString('123:1'));
  assert.notEqual(E.hashString('123:1'), E.hashString('123:2'));
  assert.equal(E.hashString(''), E.hashString(''));
  assert.ok(Number.isInteger(E.hashString('abc')));
});

test('rngFromString(seed:nonce) reproduksibel', () => {
  const r1 = E.rngFromString('999:7');
  const r2 = E.rngFromString('999:7');
  const seq1 = [r1(), r1(), r1()];
  const seq2 = [r2(), r2(), r2()];
  assert.deepEqual(seq1, seq2);
});

/* ------------------------------------------------------------------ */
/* Reel strip & distribusi                                             */
/* ------------------------------------------------------------------ */

test('strip berisi semua simbol sesuai bobot', () => {
  const strip = E.buildStrip();
  const totalWeight = E.SYMBOL_ORDER.reduce((s, id) => s + E.SYMBOLS[id].weight, 0);
  assert.equal(strip.length, totalWeight);
  for (const id of E.SYMBOL_ORDER) {
    assert.equal(strip.filter((s) => s === id).length, E.SYMBOLS[id].weight, id);
  }
});

test('probabilitas simbol di strip = bobot/total (50k draw)', () => {
  const strip = E.STRIPS[0];
  const rng = E.mulberry32(7);
  const counts = {};
  const n = 50000;
  for (let i = 0; i < n; i++) {
    const s = strip[Math.floor(rng() * strip.length)];
    counts[s] = (counts[s] || 0) + 1;
  }
  const totalWeight = E.SYMBOL_ORDER.reduce((s, id) => s + E.SYMBOLS[id].weight, 0);
  for (const id of E.SYMBOL_ORDER) {
    const expected = E.SYMBOLS[id].weight / totalWeight;
    const actual = (counts[id] || 0) / n;
    assert.ok(Math.abs(actual - expected) < 0.01, `${id}: ${actual} vs ${expected}`);
  }
});

/* ------------------------------------------------------------------ */
/* spin()                                                              */
/* ------------------------------------------------------------------ */

test('spin: grid valid 5x3, deterministik per seed, stop in range', () => {
  const rng = E.mulberry32(1234);
  const s1 = E.spin(rng);
  const s2 = E.spin(E.mulberry32(1234));
  assert.deepEqual(s1.grid, s2.grid);
  assert.deepEqual(s1.stops, s2.stops);

  assert.equal(s1.grid.length, 5);
  for (let r = 0; r < 5; r++) {
    assert.equal(s1.grid[r].length, 3);
    assert.ok(s1.stops[r] >= 0 && s1.stops[r] < E.STRIPS[r].length);
    for (const sym of s1.grid[r]) {
      assert.ok(E.SYMBOLS[sym], `simbol valid: ${sym}`);
    }
  }
  // verifikasi konsistensi strip: cell row k = strip[(stop+k) % len]
  for (let r = 0; r < 5; r++) {
    const strip = E.STRIPS[r];
    for (let row = 0; row < 3; row++) {
      assert.equal(s1.grid[r][row], strip[(s1.stops[r] + row) % strip.length]);
    }
  }
});

/* ------------------------------------------------------------------ */
/* evaluate() — kasus tangan                                           */
/* ------------------------------------------------------------------ */

test('menang 3-of-kind di garis tengah = paytable x lineBet', () => {
  const g = baseGrid();
  g[1][1] = 'CHERRY';
  g[2][1] = 'CHERRY';
  const res = E.evaluate(g, { lineBet: 1, totalBet: 10 });
  assert.equal(res.lineWins.length, 1);
  const w = res.lineWins[0];
  assert.equal(w.line, 0); // garis tengah
  assert.equal(w.symbol, 'CHERRY');
  assert.equal(w.count, 3);
  assert.equal(w.amount, E.SYMBOLS.CHERRY.pay[3] * 1);
  assert.equal(res.totalWin, E.SYMBOLS.CHERRY.pay[3]);
  assert.equal(res.freeSpinsAwarded, 0);
});

test('hanya menang dari kiri — match di reel 2/3/4 tidak dihitung', () => {
  const g = baseGrid();
  g[2][1] = 'STAR';
  g[3][1] = 'STAR';
  g[4][1] = 'STAR'; // reel0=CHERRY, reel1=LEMON → gagal dari kiri
  const res = E.evaluate(g, { lineBet: 1, totalBet: 10 });
  assert.equal(res.lineWins.length, 0);
  assert.equal(res.totalWin, 0);
});

test('WILD substitusi simbol', () => {
  const g = baseGrid();
  g[0][1] = 'WILD';
  g[1][1] = 'CHERRY';
  g[2][1] = 'CHERRY'; // wild + 2 ceri = 3 beruntun dari kiri
  const res = E.evaluate(g, { lineBet: 1, totalBet: 10 });
  assert.equal(res.lineWins.length, 1);
  assert.equal(res.lineWins[0].symbol, 'CHERRY');
  assert.equal(res.lineWins[0].count, 3);
  assert.equal(res.lineWins[0].amount, E.SYMBOLS.CHERRY.pay[3]);
});

test('kandidat terbaik yang dipilih (DIAMOND 4 > WILD 3)', () => {
  const g = baseGrid();
  g[0][1] = 'DIAMOND';
  g[1][1] = 'DIAMOND';
  g[2][1] = 'WILD';
  g[3][1] = 'WILD';
  const res = E.evaluate(g, { lineBet: 1, totalBet: 10 });
  assert.equal(res.lineWins.length, 1);
  const w = res.lineWins[0];
  assert.equal(w.symbol, 'DIAMOND');
  assert.equal(w.count, 4);
  assert.equal(w.amount, E.SYMBOLS.DIAMOND.pay[4]);
});

test('SCATTER 3/4/5: bayar x totalBet + free spin 5/8/12', () => {
  const cases = [
    [3, E.SCATTER_PAY[3], 5],
    [4, E.SCATTER_PAY[4], 8],
    [5, E.SCATTER_PAY[5], 12],
  ];
  for (const [nScatter, payMul, fs] of cases) {
    const g = baseGrid();
    const spots = [[0, 0], [2, 1], [4, 2], [1, 2], [3, 0]];
    for (let i = 0; i < nScatter; i++) {
      const [r, row] = spots[i];
      g[r][row] = 'SCATTER';
    }
    const res = E.evaluate(g, { lineBet: 2, totalBet: 20 });
    assert.equal(res.scatterCount, nScatter);
    assert.equal(res.scatterWin, payMul * 20);
    assert.equal(res.freeSpinsAwarded, fs);
    assert.equal(res.totalWin, res.lineWinTotal + res.scatterWin);
  }
});

test('retrigger free spin pakai tabel kecil (3 → +3)', () => {
  const g = baseGrid();
  g[0][0] = 'SCATTER';
  g[2][1] = 'SCATTER';
  g[4][2] = 'SCATTER';
  const res = E.evaluate(g, { lineBet: 1, totalBet: 10, freeSpin: true, retrigger: true });
  assert.equal(res.freeSpinsAwarded, E.FREE_SPINS_RETRIGGER[3]);
});

test('free spin: semua kemenangan x2', () => {
  const g = baseGrid();
  g[1][1] = 'CHERRY';
  g[2][1] = 'CHERRY';
  const base = E.evaluate(g, { lineBet: 1, totalBet: 10 });
  const fs = E.evaluate(g, { lineBet: 1, totalBet: 10, freeSpin: true, retrigger: true });
  assert.equal(fs.multiplier, 2);
  assert.equal(fs.totalWin, base.totalWin * 2);
});

test('tanpa menang → totalWin 0', () => {
  const res = E.evaluate(baseGrid(), { lineBet: 1, totalBet: 10 });
  assert.equal(res.totalWin, 0);
  assert.equal(res.lineWins.length, 0);
  assert.equal(res.scatterCount, 0);
});

/* ------------------------------------------------------------------ */
/* Simulasi RTP                                                        */
/* ------------------------------------------------------------------ */

test('simulate: deterministik dan RTP di rentang wajar', () => {
  const a = E.simulate(30000, 20260101);
  const b = E.simulate(30000, 20260101);
  assert.equal(a.rtp, b.rtp); // seed sama → hasil identik

  assert.ok(a.triggers > 0, 'harus ada free spin trigger');
  assert.ok(a.fsPlayed > 0, 'harus ada free spin termain');
  assert.equal(a.rtp, a.totalWin / a.bets);
});

test('RTP engine di target ~0.90–1.00', () => {
  const r = E.simulate(50000, 777);
  assert.ok(
    r.rtp >= 0.9 && r.rtp <= 1.0,
    `RTP=${r.rtp.toFixed(4)} (line=${r.lineWin}, scatter=${r.scatterWin}, fs=${r.fsWin})`
  );
});
