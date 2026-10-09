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
  w.eval(read('lib/engine.js'));
  w.eval(read('game.js'));
  return dom;
}

const num = (el) => Number(el.textContent.replace(/\D/g, ''));

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
  } finally {
    dom.window.close();
  }
});
