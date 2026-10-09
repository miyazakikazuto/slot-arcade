'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const E = require('../lib/engine.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Boot index.html + scripts di jsdom, state localStorage deterministik */
function boot(seed, coins) {
  const html = read('index.html').replace(/<script src="[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, {
    url: 'https://lollipop.local/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.localStorage.setItem(
    'lollipop-arcade:v1',
    JSON.stringify({ v: 1, coins, betIndex: 0, seed, nonce: 0, freeSpins: 0, history: [], lastBonus: 0 })
  );
  w.__SLOT_FAST__ = true; // hook test: jeda antar spin dipangkas ke <=20ms
  w.eval(read('lib/engine.js'));
  w.eval(read('game.js'));
  return dom;
}

const num = (el) => Number(el.textContent.replace(/\D/g, ''));

/** polling sampai kondisi terpenuhi */
async function until(pred, label, timeout = 10000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeout) throw new Error('timeout menunggu: ' + label);
    await tick(25);
  }
}

const isIdle = (d) =>
  d.getElementById('spinBtn').textContent === 'SPIN' &&
  d.getElementById('autoBtn').textContent === 'Auto';

/** Replay beli FS di engine — meniru runFreeSpinLoop di game.js */
function replayBuy(seed, startNonce, lineBet, totalBet) {
  let nonce = startNonce;
  let fsLeft = 10;
  let played = 0;
  let win = 0;
  while (fsLeft > 0 && played < 50) {
    fsLeft--;
    nonce++;
    const res = E.playSpin(E.rngFromString(seed + ':' + nonce), {
      lineBet,
      totalBet,
      freeSpin: true,
      retrigger: true,
    });
    win += res.totalWin;
    played++;
    if (res.freeSpinsAwarded > 0) fsLeft = Math.min(50, fsLeft + res.freeSpinsAwarded);
  }
  return { nonce, win, played };
}

/** Replay n spin base (tanpa FS) — dipakai test auto; seed 1 diverifikasi tanpa trigger */
function replayBase(seed, fromNonce, count, lineBet, totalBet) {
  let win = 0;
  for (let n = fromNonce + 1; n <= fromNonce + count; n++) {
    const res = E.playSpin(E.rngFromString(seed + ':' + n), { lineBet, totalBet });
    assert.equal(res.freeSpinsAwarded, 0, 'seed auto-test harus tanpa trigger');
    win += res.totalWin;
  }
  return win;
}

test('UI boot: reels ter-render, HUD & paytable terisi', async () => {
  const dom = boot(2, 1000);
  try {
    const d = dom.window.document;
    await tick();

    assert.ok(dom.window.SlotEngine, 'engine ter-attach ke window');
    assert.equal(d.querySelectorAll('#reels .reel').length, 5);
    d.querySelectorAll('#reels .reel').forEach((reel) => {
      assert.equal(reel.querySelectorAll('.cell').length, 3);
    });
    assert.equal(num(d.getElementById('coins')), 1000);
    assert.equal(num(d.getElementById('bet')), 10); // 1 x 10 payline
    assert.equal(d.querySelectorAll('#ptableBody tr').length, E.SYMBOL_ORDER.length);
    // kontrol baru: auto spin + beli free spin
    assert.equal(d.querySelectorAll('#autoCount option').length, 4);
    assert.equal(d.getElementById('autoBtn').textContent, 'Auto');
    assert.match(d.getElementById('buyFsBtn').textContent, /BELI FREESPIN/);
    assert.match(d.getElementById('buyFsBtn').textContent, /1[.,]700/, 'harga 170x bet=1.700');
    assert.match(d.getElementById('ruleBuy').textContent, /170× bet/, 'rule paytable terisi dinamis');
    // skin slot Indonesia: jackpot bar & turbo ada
    assert.match(d.getElementById('jackpot').textContent, /[\d.]+/, 'jackpot bar terisi');
    assert.match(d.getElementById('turboBtn').textContent, /Turbo/);
    assert.match(d.getElementById('hint').textContent, /demo/i);
    assert.match(d.querySelector('.footer').textContent, /tidak ada deposit/i);
  } finally {
    dom.window.close();
  }
});

test('spin: koin terpotong, hasil = engine, kemenangan masuk, tersimpan', async () => {
  const dom = boot(2, 1000);
  try {
    const w = dom.window;
    const d = w.document;
    await tick();

    // hasil ekspektasi dihitung ulang dari engine (seed 2, nonce 1)
    const rng = E.rngFromString('2:1');
    const expected = E.playSpin(rng, { lineBet: 1, totalBet: 10 });
    assert.ok(expected.freeSpinsAwarded === 0, 'seed dipilih agar tanpa free spin');

    d.getElementById('spinBtn').click();
    await tick(50);

    const expCoins = 1000 - 10 + expected.totalWin;
    assert.equal(num(d.getElementById('coins')), expCoins);
    assert.equal(num(d.getElementById('win')), expected.totalWin);
    assert.equal(num(d.getElementById('nonceText')), 1);

    // grid di layar = grid hasil spin
    const reels = d.querySelectorAll('#reels .reel');
    const grid = [];
    for (let r = 0; r < 5; r++) {
      grid.push([...reels[r].querySelectorAll('.cell')].map((c) => c.textContent));
    }
    for (let r = 0; r < 5; r++) {
      for (let row = 0; row < 3; row++) {
        assert.equal(grid[r][row], E.SYMBOLS[expected.grid[r][row]].icon, `cell ${r},${row}`);
      }
    }

    // sel menang di-highlight
    const winCells = d.querySelectorAll('.cell.win').length;
    const uniq = new Set(expected.lineWins.flatMap((l) => l.cells.map(String)));
    assert.equal(winCells, uniq.size);

    // history & localStorage
    assert.equal(d.querySelectorAll('#history li').length, 1);
    assert.match(d.getElementById('history').textContent, /#1/);
    const saved = JSON.parse(w.localStorage.getItem('lollipop-arcade:v1'));
    assert.equal(saved.coins, expCoins);
    assert.equal(saved.nonce, 1);

    // spin kedua → nonce 2, deterministik
    d.getElementById('spinBtn').click();
    await tick(50);
    assert.equal(num(d.getElementById('nonceText')), 2);
  } finally {
    dom.window.close();
  }
});

test('kontrol bet & modal paytable', async () => {
  const dom = boot(2, 1000);
  try {
    const d = dom.window.document;
    await tick();

    d.getElementById('betUp').click();
    assert.equal(num(d.getElementById('bet')), 20);
    d.getElementById('betDown').click();
    assert.equal(num(d.getElementById('bet')), 10);
    d.getElementById('betMax').click();
    assert.equal(num(d.getElementById('bet')), 200); // 20 x 10 payline

    const modal = d.getElementById('paytable');
    assert.ok(modal.classList.contains('hidden'));
    d.getElementById('paytableBtn').click();
    assert.ok(!modal.classList.contains('hidden'));
    d.getElementById('paytableClose').click();
    assert.ok(modal.classList.contains('hidden'));

    // toggle turbo
    const turboBtn = d.getElementById('turboBtn');
    assert.ok(!turboBtn.classList.contains('is-on'));
    turboBtn.click();
    assert.ok(turboBtn.classList.contains('is-on'), 'turbo aktif');
    turboBtn.click();
    assert.ok(!turboBtn.classList.contains('is-on'), 'turbo nonaktif lagi');
  } finally {
    dom.window.close();
  }
});

test('koin habis → tombol bonus gratis muncul & memberi +500', async () => {
  const dom = boot(2, 0);
  try {
    const w = dom.window;
    const d = w.document;
    await tick();

    const bonus = d.getElementById('bonusBtn');
    assert.ok(!bonus.classList.contains('hidden'), 'bonus terlihat saat koin < bet');
    assert.match(d.getElementById('hint').textContent, /koin habis/i);

    bonus.click();
    assert.equal(num(d.getElementById('coins')), 500);
    assert.ok(bonus.classList.contains('hidden'), 'bonus tersembunyi setelah klaim (cooldown)');

    const saved = JSON.parse(w.localStorage.getItem('lollipop-arcade:v1'));
    assert.equal(saved.coins, 500);
    assert.ok(saved.lastBonus > 0);
    // beli FS tidak bisa saat koin < harga (1.700)
    assert.ok(d.getElementById('buyFsBtn').disabled, 'tombol beli FS disabled saat koin 0');
  } finally {
    dom.window.close();
  }
});

test('auto spin 10x: jalan 10 spin, hasil = replay engine, berhenti rapi', async () => {
  const dom = boot(1, 1000); // seed 1: 10 spin pertama tanpa trigger FS
  try {
    const d = dom.window.document;
    await tick();

    d.getElementById('autoCount').value = '10';
    d.getElementById('autoBtn').click();
    assert.match(d.getElementById('spinBtn').textContent, /AUTO/, 'spin menampilkan mode auto');

    await until(() => isIdle(d), 'auto 10 selesai');

    const expectedWin = replayBase(1, 0, 10, 1, 10);
    assert.equal(num(d.getElementById('nonceText')), 10, 'tepat 10 spin');
    assert.equal(num(d.getElementById('coins')), 1000 - 10 * 10 + expectedWin);
    assert.equal(d.querySelectorAll('#history li').length, 10);
    assert.equal(d.getElementById('autoBtn').textContent, 'Auto');
    assert.equal(d.getElementById('spinBtn').textContent, 'SPIN');
    assert.ok(d.getElementById('fsmode').classList.contains('hidden'));

    const saved = JSON.parse(dom.window.localStorage.getItem('lollipop-arcade:v1'));
    assert.equal(saved.nonce, 10);
    assert.equal(saved.coins, 1000 - 100 + expectedWin);
  } finally {
    dom.window.close();
  }
});

test('tombol STOP menghentikan auto spin lebih awal', async () => {
  const dom = boot(1, 10000);
  try {
    const d = dom.window.document;
    await tick();

    d.getElementById('autoCount').value = '50';
    d.getElementById('autoBtn').click();
    await until(() => num(d.getElementById('nonceText')) >= 2, 'auto mulai berjalan');
    assert.match(d.getElementById('autoBtn').textContent, /STOP/);

    d.getElementById('autoBtn').click(); // STOP
    await until(() => isIdle(d), 'auto berhenti');
    const stopped = num(d.getElementById('nonceText'));
    assert.ok(stopped < 50, `berhenti awal (nonce=${stopped})`);

    await tick(150);
    assert.equal(num(d.getElementById('nonceText')), stopped, 'tidak ada spin tambahan setelah STOP');
    assert.equal(d.getElementById('autoBtn').textContent, 'Auto');
  } finally {
    dom.window.close();
  }
});

test('beli free spin: bayar 170x bet → 10 FS, kemenangan = replay engine', async () => {
  const SEED = 424242;
  const START = 5000;
  const COST = 170 * 10; // 170 x totalBet(10)
  const dom = boot(SEED, START);
  try {
    const d = dom.window.document;
    await tick();
    assert.equal(num(d.getElementById('coins')), START);

    d.getElementById('buyFsBtn').click();
    assert.match(d.getElementById('fsmode').textContent, /FREE SPIN/, 'banner FS langsung tampil');
    await until(() => isIdle(d), 'beli FS selesai');

    const expected = replayBuy(SEED, 0, 1, 10);
    assert.equal(num(d.getElementById('nonceText')), expected.nonce, 'jumlah spin FS = replay');
    assert.equal(num(d.getElementById('coins')), START - COST + expected.win);
    assert.ok(expected.played >= 10, 'minimal 10 free spin termain');

    // semua entri history = free spin (bet 0)
    const saved = JSON.parse(dom.window.localStorage.getItem('lollipop-arcade:v1'));
    assert.equal(saved.coins, START - COST + expected.win);
    assert.equal(saved.freeSpins, 0, 'sisa FS habis');
    assert.equal(saved.history.filter((h) => h.free).length, saved.history.length);
    assert.ok(d.getElementById('fsmode').classList.contains('hidden'));
    assert.ok(!d.getElementById('buyFsBtn').disabled, 'tombol beli aktif lagi setelah selesai');
  } finally {
    dom.window.close();
  }
});
