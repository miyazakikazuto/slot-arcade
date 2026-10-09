# 🍭 Lollipop Arcade — Slot Game Demo (Tanpa Uang Asli)

Game slot/arcade **free-to-play** untuk hiburan & belajar pemrograman game.
**Bukan judi**: tidak ada deposit, tarik dana, uang asli, maupun pembelian koin.

---

## 1. Framework / Arsitektur

```
slot-arcade/
├── index.html          # Shell UI (HUD, reels, kontrol, paytable modal)
├── styles.css          # Tema permen, animasi win, responsive
├── game.js             # Lapisan UI: state, animasi reel, HUD, localStorage
├── lib/
│   └── engine.js       # ★ ENGINE MURNI (tanpa DOM) — bisa dipakai browser & Node
├── test/
│   ├── engine.test.js   # Unit test engine (node:test): RNG, strip, evaluation, RTP
│   └── ui.smoke.test.js # Smoke test UI di jsdom (boot, spin, HUD, bonus, modal)
├── package.json         # npm test -> node --test
└── README.md           # Dokumen ini
```

**Prinsip pemisahan lapisan:**

| Lapisan | File | Tanggung jawab |
|---|---|---|
| Engine (pure function) | `lib/engine.js` | RNG, strip reel, paytable, paylines, evaluasi kemenangan, simulasi RTP. **Tanpa DOM, tanpa state global** → mudah di-test. |
| UI | `game.js` | Render grid, animasi scroll reel, HUD koin/bet/win, free-spin loop, penyimpanan koin demo di localStorage. |
| View | `index.html` + `styles.css` | Markup & tema visual. |

Engine di-expose sebagai **UMD ringan**: browser → `window.SlotEngine`, Node → `require()`.

---

## 2. Algoritma

### 2.1 RNG (deterministic, provably-fair style)
- **PRNG**: `mulberry32(seed)` — cepat, 32-bit, cukup baik untuk game demo.
- **Seed per spin**: `cyrb-hash(seed akun + ":" + nonce)` → `mulberry32`. Karena seed & nonce
  ditampilkan di layar, hasil spin **bisa direproduksi** (konsep provably-fair, untuk edukasi).
- Seed diganti manual lewat tombol "Seed Baru".

### 2.2 Reel strip (distribusi simbol)
- 5 reel × 3 baris. Tiap reel punya **strip** (array simbol) dengan **bobot per simbol**.
- Strip dibangun deterministik: simbol berbobot besar disebar merata (interleaving),
  sehingga probabilitas simbol = `bobot / total_bobot` per posisi.
- **Stop** = `floor(rng() × panjang strip)` (uniform). Grid = 3 simbol berurutan dari stop.

```
bobot: WILD 2 · SCATTER 2 · DIAMOND 4 · STAR 5 · HEART 6 · GRAPE 7 · LEMON 8 · CHERRY 8
total = 42  →  P(SCATTER per posisi) = 2/42 ≈ 4.76%
```

### 2.3 Paylines (10 garis)
```
0: 11111 (tengah)   4: 21012 (∧)     8: 22100
1: 00000 (atas)      5: 10001         9: 10101
2: 22222 (bawah)     6: 12221
3: 01210 (∨)         7: 00122
```
(index = reel 0..4, angka = baris 0=atas, 1=tengah, 2=bawah)

### 2.4 Evaluasi kemenangan (murni fungsi)
1. Untuk tiap payline: ambil 5 simbol sepanjang garis.
2. Kandidat = semua simbol unik di garis (kecuali SCATTER). WILD substitusi.
   Hitung beruntun dari reel kiri: cocok jika `simbol kandidat` ATAU `WILD`.
3. Pilih kandidat dengan bayaran tertinggi; menang minimal **3 beruntun dari kiri**.
4. Bayaran = `paytable[simbol][count] × lineBet × multiplier`.
5. **SCATTER (Lollipop)**: muncul di posisi mana pun (bukan garis):
   - 3/4/5 → bayar `× lineBetTotal` + **Free Spins** (5 / 8 / 12).
   - Selama Free Spins: kemenangan **×2**, retrigger 3 scatter = +3 spin (cap 50).

### 2.5 RTP (Return-To-Player, simulasi)
- `engine.simulate(nSpin, seed)` memutar `n` spin + semua free-spin-nya,
  lalu menghitung `rtp = totalMenang / totalTaruhan`.
- Dipakai di unit test dengan seed tetap → **deterministic**, assert RTP di rentang wajar.
- **Hasil terukur** (50k spin × 5 seed): RTP ≈ **0.92–0.95** (rata-rata ~0.93) —
  paytable di-tune lewat simulasi, bukan tebakan.

### 2.6 Alur spin di UI
```
klik SPIN → kurangi koin → hash(seed:nonce) → rng → engine.spin()
         → build strip visual (isi acak + hasil akhir) → animasi scroll per reel
           (stagger kiri→kanan, cubic-bezier) → await semua reel selesai
         → engine.evaluate() → highlight sel menang → tambah koin → history
         → jika freeSpins > 0 → loop spin gratis otomatis (tanpa potong koin)
```

---

## 3. Guardrails (sengaja dibatasi)
- ❌ Tidak ada deposit / penarikan / uang asli / pembelian koin.
- ❌ Tidak ada koneksi pembayaran apa pun.
- ✅ Koin = kredit demo di localStorage, bisa klaim bonus gratis (+500) kalau habis.
- ✅ Disclaimer "game demo" selalu tampil di UI.

## 4. Cara main & test

```bash
# main: buka index.html langsung di browser (double-click), atau:
npm start          # npx serve .

# test (20 test: engine + UI smoke):
npm test           # = node --test
```

## 5. Roadmap
- [ ] Audio (spin sfx, win jingle) via WebAudio.
- [ ] Simulasi kemenangan di overlay garis payline (SVG).
- [ ] Game kedua di engine sama: "Fruit Arcade" (grid 6×5, cluster win).
- [ ] Untuk 2+ pemain: leaderboard localStorage per room (tetap tanpa uang).
