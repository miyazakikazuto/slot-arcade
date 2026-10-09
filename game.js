/**
 * Lollipop Arcade — lapisan UI (game.js)
 * Engine murni ada di lib/engine.js (window.SlotEngine).
 * State koin demo disimpan di localStorage — tanpa uang asli.
 */
(function () {
  'use strict';

  const E = window.SlotEngine;
  const STORAGE_KEY = 'lollipop-arcade:v1';
  const BET_LEVELS = [1, 2, 5, 10, 20]; // lineBet → totalBet = level x 10 payline
  const START_COINS = 5000;
  const BONUS_AMOUNT = 500;
  const BONUS_COOLDOWN_MS = 60 * 1000;
  const FREE_SPINS_CAP = 50;
  // Beli Free Spin: bayar FS_BUY_MULT x totalBet → FS_BUY_SPINS free spin langsung.
  // EV terukur 10 FS (dengan retrigger, 20k sampel) ≈ 157.7 x totalBet → harga 170x (edge ~7%)
  const FS_BUY_SPINS = 10;
  const FS_BUY_MULT = 170;
  const FS_DELAY = 650;   // jeda antar free spin (ms)
  const AUTO_DELAY = 350; // jeda antar auto spin (ms)

  /* ---------------- state ---------------- */
  const defaultState = () => ({
    v: 1,
    coins: START_COINS,
    betIndex: 0,
    seed: E.randomSeed(),
    nonce: 0,
    freeSpins: 0,
    history: [],
    lastBonus: 0,
  });

  let state = load();
  let busy = false;
  let autoLeft = null; // null = manual; angka = sisa auto spin; Infinity = ∞

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.v === 1) return Object.assign(defaultState(), s);
      }
    } catch (_) { /* abaikan corrupt → state default */ }
    return defaultState();
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  const lineBet = () => BET_LEVELS[state.betIndex];
  const totalBet = () => lineBet() * E.PAYLINES.length;
  const minTotalBet = () => BET_LEVELS[0] * E.PAYLINES.length;

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);
  const reelsEl = $('reels');
  const coinsEl = $('coins');
  const betEl = $('bet');
  const winEl = $('win');
  const hintEl = $('hint');
  const toastEl = $('toast');
  const historyEl = $('history');
  const fsmodeEl = $('fsmode');
  const fscountEl = $('fscount');
  const bonusBtn = $('bonusBtn');
  const spinBtn = $('spinBtn');
  const autoBtn = $('autoBtn');
  const autoCountEl = $('autoCount');
  const buyFsBtn = $('buyFsBtn');
  const turboBtn = $('turboBtn');
  const jackpotEl = $('jackpot');

  let turbo = false; // percepat animasi (gaya slot: tombol Turbo)
  const seedTextEl = $('seedText');
  const nonceTextEl = $('nonceText');

  const reelEls = [];

  function buildReels() {
    for (let i = 0; i < E.REEL_COUNT; i++) {
      const reel = document.createElement('div');
      reel.className = 'reel';
      const strip = document.createElement('div');
      strip.className = 'strip';
      reel.appendChild(strip);
      reelsEl.appendChild(reel);
      reelEls.push(reel);
    }
  }

  const icon = (sym) => E.SYMBOLS[sym].icon;
  const cellHtml = (sym) => '<div class="cell">' + icon(sym) + '</div>';
  const randSym = () => {
    const strip = E.STRIPS[0];
    return strip[Math.floor(Math.random() * strip.length)];
  };

  /** Render grid statis (tanpa animasi) — dipakai saat load */
  function renderStatic(grid) {
    for (let i = 0; i < E.REEL_COUNT; i++) {
      const strip = reelEls[i].querySelector('.strip');
      if (strip.getAnimations) strip.getAnimations().forEach((a) => a.cancel());
      strip.style.transform = 'none';
      strip.innerHTML = grid[i].map(cellHtml).join('');
    }
  }

  /* ---------------- HUD ---------------- */
  function updateHud() {
    coinsEl.textContent = state.coins.toLocaleString('id-ID');
    betEl.textContent = totalBet().toLocaleString('id-ID');
    if (state.freeSpins > 0) {
      fsmodeEl.classList.remove('hidden');
      fscountEl.textContent = state.freeSpins;
    } else {
      fsmodeEl.classList.add('hidden');
    }
    seedTextEl.textContent = String(state.seed).padStart(10, '0');
    nonceTextEl.textContent = state.nonce;
    buyFsBtn.textContent = 'BELI FREESPIN · ' + buyCost().toLocaleString('id-ID');
    buyFsBtn.disabled = busy || autoLeft !== null || state.coins < buyCost();
    autoCountEl.disabled = busy || autoLeft !== null;
    updateAutoBtn();
    updateBonusVisibility();
  }

  function updateBonusVisibility() {
    const canClaim =
      state.coins < totalBet() && Date.now() - (state.lastBonus || 0) > BONUS_COOLDOWN_MS;
    bonusBtn.classList.toggle('hidden', !canClaim);
    if (state.coins < minTotalBet()) {
      hintEl.textContent = 'Koin habis? Klaim bonus gratis di bawah (tanpa pembelian).';
    } else if (state.coins < totalBet()) {
      hintEl.textContent = 'Bet terlalu besar untuk koinmu — turunkan bet atau klaim bonus gratis.';
    } else {
      hintEl.textContent = 'Tekan SPIN atau tombol Spasi. Ini game demo, koin tidak bisa diuangkan.';
    }
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.add('hidden'), 1400);
  }

  function addHistory(item) {
    state.history.unshift(item);
    state.history = state.history.slice(0, 10);
    renderHistory();
  }

  function renderHistory() {
    if (!state.history.length) {
      historyEl.innerHTML = '<li class="empty">Belum ada spin.</li>';
      return;
    }
    historyEl.innerHTML = state.history
      .map((h) => {
        const winCls = h.win > 0 ? 'hw' : '';
        const tag = (h.free ? '🍀 ' : '') + '#' + h.nonce;
        return (
          '<li><span>' + tag + ' · bet ' + h.bet + '</span>' +
          '<span class="' + winCls + '">' + (h.win > 0 ? '+' : '') + h.win + '</span></li>'
        );
      })
      .join('');
  }

  /* ---------------- animasi reel ---------------- */
  function animateReels(grid) {
    const perReel = [];
    for (let i = 0; i < E.REEL_COUNT; i++) {
      perReel.push(
        new Promise((resolve) => {
          const reel = reelEls[i];
          const strip = reel.querySelector('.strip');
          if (strip.getAnimations) strip.getAnimations().forEach((a) => a.cancel());
          strip.style.transform = 'none';

          // fallback tanpa Web Animations API: langsung tampilkan hasil
          if (typeof strip.animate !== 'function') {
            strip.innerHTML = grid[i].map(cellHtml).join('');
            resolve();
            return;
          }

          // isi acak (visual) + 3 hasil akhir di bawah
          const dur = turbo ? 240 + i * 60 : 650 + i * 230; // turbo = animasi cepat
          const fillerCount = 8 + i * 5;
          const parts = [];
          for (let k = 0; k < fillerCount; k++) parts.push(cellHtml(randSym()));
          for (let row = 0; row < E.ROW_COUNT; row++) parts.push(cellHtml(grid[i][row]));
          strip.innerHTML = parts.join('');

          const cellH = strip.children[0].clientHeight;
          const offset = fillerCount * cellH;
          const anim = strip.animate(
            [
              { transform: 'translateY(0px)' },
              { transform: 'translateY(' + -offset + 'px)' },
            ],
            {
              duration: dur,
              easing: 'cubic-bezier(.15,.85,.25,1)',
              fill: 'forwards',
            }
          );
          const done = () => {
            anim.cancel();
            strip.style.transform = 'none';
            strip.innerHTML = grid[i].map(cellHtml).join('');
            resolve();
          };
          if (anim.finished && anim.finished.then) anim.finished.then(done, done);
          else setTimeout(done, dur);
        })
      );
    }
    return Promise.all(perReel);
  }

  function highlightWins(res) {
    clearWins();
    res.lineWins.forEach((w) => {
      w.cells.forEach(([reel, row]) => {
        const cell = reelEls[reel].querySelector('.strip').children[row];
        if (cell) cell.classList.add('win');
      });
    });
  }

  function clearWins() {
    document.querySelectorAll('.cell.win').forEach((c) => c.classList.remove('win'));
  }

  /* ---------------- spin ---------------- */
  const fastMode = () => window.__SLOT_FAST__ === true; // hook test: percepat jeda
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, fastMode() ? Math.min(ms, 20) : ms));
  }

  async function runSingleSpin(isFree) {
    state.nonce++;
    const rng = E.rngFromString(state.seed + ':' + state.nonce);
    const bet = totalBet();
    if (!isFree) state.coins = Math.max(0, state.coins - bet);

    const res = E.playSpin(rng, {
      lineBet: lineBet(),
      totalBet: bet,
      freeSpin: isFree,
      retrigger: isFree,
    });

    updateHud();
    save();

    clearWins();
    await animateReels(res.grid);

    if (res.totalWin > 0) {
      state.coins += res.totalWin;
      highlightWins(res);
      const fmt = res.totalWin.toLocaleString('id-ID');
      const mult = res.totalWin / Math.max(1, bet);
      if (res.scatterCount >= 3 && res.freeSpinsAwarded > 0) {
        toast('FREE SPIN +' + res.freeSpinsAwarded + '!');
      } else if (mult >= 30) {
        toast('JACKPOT! +' + fmt);
      } else if (mult >= 15) {
        toast('MEGA WIN! +' + fmt);
      } else if (mult >= 5) {
        toast('MENANG BESAR! +' + fmt);
      } else {
        toast('MENANG ' + fmt);
      }
    }

    if (res.freeSpinsAwarded > 0) {
      state.freeSpins = Math.min(FREE_SPINS_CAP, state.freeSpins + res.freeSpinsAwarded);
    }

    winEl.textContent = res.totalWin.toLocaleString('id-ID');
    addHistory({ nonce: state.nonce, bet: isFree ? 0 : bet, win: res.totalWin, free: isFree });
    updateHud();
    save();
    return res;
  }

  /** Mainkan sisa free spin — dipakai spin normal, beli FS, dan retrigger */
  async function runFreeSpinLoop() {
    let played = 0;
    while (state.freeSpins > 0 && played < FREE_SPINS_CAP) {
      state.freeSpins--;
      updateHud();
      save();
      await sleep(turbo ? 0 : FS_DELAY);
      await runSingleSpin(true);
      played++;
    }
    state.freeSpins = 0;
    // highlight menang dibiarkan sampai spin berikutnya (clearWins ada di runSingleSpin)
  }

  function buyCost() {
    return FS_BUY_MULT * totalBet();
  }

  async function doBaseSpin() {
    await runSingleSpin(false);
    await runFreeSpinLoop();
  }

  /* ---------------- spin manual ---------------- */
  async function onSpin() {
    if (autoLeft !== null) {
      autoLeft = null; // SPIN/Spasi berfungsi sbg STOP saat auto berjalan
      return;
    }
    if (busy) return;
    if (state.freeSpins > 0) return; // free spin loop yang jalan
    if (state.coins < totalBet()) {
      updateBonusVisibility();
      return;
    }

    busy = true;
    setButtons(true);
    updateHud();
    try {
      await doBaseSpin();
    } finally {
      busy = false;
      setButtons(false);
      updateHud();
    }
  }

  /* ---------------- auto spin ---------------- */
  function updateAutoBtn() {
    if (autoLeft === null) {
      autoBtn.textContent = 'Auto';
      autoBtn.classList.remove('is-stop');
      autoBtn.disabled = busy; // aktif lagi saat idle; saat manual/buy spin → disabled
    } else {
      autoBtn.textContent = autoLeft === Infinity ? 'STOP ∞' : 'STOP (' + autoLeft + ')';
      autoBtn.classList.add('is-stop');
      autoBtn.disabled = false; // tombol stop selalu bisa diklik
    }
  }

  function startAuto() {
    if (busy || autoLeft !== null) return;
    if (state.coins < totalBet()) {
      updateBonusVisibility();
      return;
    }
    const n = Number(autoCountEl.value);
    autoLeft = n > 0 ? n : Infinity;
    updateAutoBtn();
    runAuto();
  }

  async function runAuto() {
    busy = true;
    setButtons(true);
    updateHud();
    try {
      while (autoLeft !== null && autoLeft > 0 && state.coins >= totalBet()) {
        if (autoLeft !== Infinity) autoLeft--;
        updateAutoBtn();
        await doBaseSpin();
        if (autoLeft === null || autoLeft === 0) break;
        await sleep(turbo ? 60 : AUTO_DELAY);
      }
    } finally {
      autoLeft = null;
      busy = false;
      setButtons(false);
      updateHud();
    }
  }

  /* ---------------- beli free spin ---------------- */
  async function buyFreeSpins() {
    if (busy || autoLeft !== null) return;
    const cost = buyCost();
    if (state.coins < cost) {
      toast('Koin kurang untuk beli FS');
      updateBonusVisibility();
      return;
    }
    busy = true;
    setButtons(true);
    try {
      state.coins -= cost;
      state.freeSpins = Math.min(FREE_SPINS_CAP, state.freeSpins + FS_BUY_SPINS);
      updateHud();
      save();
      toast('🎟️ BELI FREESPIN: +' + FS_BUY_SPINS + ' (−' + cost.toLocaleString('id-ID') + ')');
      await runFreeSpinLoop();
    } finally {
      busy = false;
      setButtons(false);
      updateHud();
    }
  }

  function setButtons(disabled) {
    spinBtn.disabled = disabled;
    $('betUp').disabled = disabled;
    $('betDown').disabled = disabled;
    $('betMax').disabled = disabled;
    $('paytableBtn').disabled = disabled;
    $('resetSeed').disabled = disabled;
    spinBtn.textContent = disabled ? (autoLeft !== null ? 'AUTO…' : '…') : 'SPIN';
    updateAutoBtn();
  }

  /* ---------------- kontrol ---------------- */
  function changeBet(dir) {
    if (busy) return;
    state.betIndex = Math.min(
      BET_LEVELS.length - 1,
      Math.max(0, state.betIndex + dir)
    );
    updateHud();
    save();
  }

  function claimBonus() {
    if (Date.now() - (state.lastBonus || 0) <= BONUS_COOLDOWN_MS) return;
    state.lastBonus = Date.now();
    state.coins += BONUS_AMOUNT;
    save();
    updateHud();
    toast('🎁 +' + BONUS_AMOUNT + ' koin gratis!');
  }

  function resetSeed() {
    if (busy) return;
    state.seed = E.randomSeed();
    state.nonce = 0;
    save();
    updateHud();
    toast('Seed baru: ' + state.seed);
  }

  /* ---------------- paytable modal ---------------- */
  function buildPaytable() {
    const rows = E.SYMBOL_ORDER.map((id) => {
      const s = E.SYMBOLS[id];
      const p = s.pay;
      const cells = p ? ['<td>' + p[3] + 'x</td>', '<td>' + p[4] + 'x</td>', '<td>' + p[5] + 'x</td>']
                      : ['<td colspan="3">3/4/5 di mana pun → ' +
                          E.SCATTER_PAY[3] + 'x/' + E.SCATTER_PAY[4] + 'x/' + E.SCATTER_PAY[5] +
                          'x bet + Free Spin</td>'];
      return (
        '<tr><td>' + s.icon + ' ' + s.name + '</td>' + cells.join('') + '</tr>'
      );
    });
    $('ptableBody').innerHTML = rows.join('');
    const ruleBuy = $('ruleBuy');
    if (ruleBuy) {
      ruleBuy.textContent = '🎟️ Beli Freespin: bayar ' + FS_BUY_MULT + '× bet (' +
        buyCost().toLocaleString('id-ID') + ' koin di bet sekarang) → langsung ' +
        FS_BUY_SPINS + ' Free Spin (retrigger tetap +3). Harga berubah ikut bet.';
    }
  }

  /* ---------------- init ---------------- */
  function init() {
    buildReels();
    buildPaytable();

    // grid contoh saat load (tanpa evaluasi)
    const grid = [];
    for (let i = 0; i < E.REEL_COUNT; i++) {
      const col = [];
      for (let r = 0; r < E.ROW_COUNT; r++) col.push(randSym());
      grid.push(col);
    }
    renderStatic(grid);

    updateHud();
    renderHistory();

    spinBtn.addEventListener('click', onSpin);
    autoBtn.addEventListener('click', () => {
      if (autoLeft !== null) autoLeft = null; // STOP
      else startAuto();
    });
    buyFsBtn.addEventListener('click', buyFreeSpins);
    turboBtn.addEventListener('click', () => {
      turbo = !turbo;
      turboBtn.classList.toggle('is-on', turbo);
      toast(turbo ? '⚡ TURBO ON' : 'Turbo off');
    });
    // jackpot bar: angka hiasan demo (bukan uang), naik pelan
    let jackpotNum = 1287543210;
    setInterval(() => {
      jackpotNum += 1 + Math.floor(Math.random() * 50000);
      jackpotEl.textContent = jackpotNum.toLocaleString('id-ID');
    }, 3000);
    $('betUp').addEventListener('click', () => changeBet(1));
    $('betDown').addEventListener('click', () => changeBet(-1));
    $('betMax').addEventListener('click', () => {
      if (busy) return;
      state.betIndex = BET_LEVELS.length - 1;
      updateHud();
      save();
    });
    bonusBtn.addEventListener('click', claimBonus);
    $('resetSeed').addEventListener('click', resetSeed);

    $('paytableBtn').addEventListener('click', () => $('paytable').classList.remove('hidden'));
    $('paytableClose').addEventListener('click', () => $('paytable').classList.add('hidden'));
    $('paytable').addEventListener('click', (e) => {
      if (e.target === $('paytable')) $('paytable').classList.add('hidden');
    });

    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) {
        const modalOpen = !$('paytable').classList.contains('hidden');
        if (modalOpen) return;
        e.preventDefault();
        onSpin();
      }
    });

    // cek lagi cooldown bonus
    setInterval(updateBonusVisibility, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
