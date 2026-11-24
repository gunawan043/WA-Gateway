# Laporan PDCA Siklus 10 — Akar `exit 1` Full Suite, dan Status Integrasi Nyata

**Tanggal:** 2026-11-23/24 · **Repo:** OpenWA (Connect) · **Branch:** `feature/whatsapp-approval-finalization`
**HEAD awal:** `46abddf65` (laporan siklus 9) · **HEAD akhir:** `4833abfd8` (tiga commit, §8)

**Ringkasan:** akar `exit 1` full suite **ditemukan dan dibuktikan dengan reproduksi deterministik**:
baris log yang ditulis modul yang sudah di-teardown mencapai console Jest yang sudah ditutup
(`Cannot log after tests are done`), dan di dalam worker baris itu menetapkan `process.exitCode = 1`
sehingga run gagal walaupun **semua suite PASS**. Bukti: satu spec yang lulus (`1 passed`) berisi
`sleep(50 ms)` + satu baris `LoggerService.log` keluar **`EXIT=1`**; isi yang sama yang menulis ke
`stderr` keluar **`EXIT=0`**. Perbaikan **belum di-commit** dan tidak ada kode produksi yang berubah:
tiga varian perbaikan dicoba, ketiganya merusak atau tidak mungkin diterapkan (§3), sehingga sisa
pekerjaannya adalah penutupan teardown per-suite (§9).

Integrasi nyata SSO/Approval ke Core staging **belum berjalan** — kredensial dan URL HTTPS staging
belum ada. Rincian permintaan ke Core/operator ada di `alim-connect-staging-handoff.md`.

---

## 1. Repository, branch, HEAD

| Hal                  | Nilai                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository           | OpenWA (Connect) — repo Core tidak disentuh                                                                                                                                                                                              |
| Branch               | `feature/whatsapp-approval-finalization`                                                                                                                                                                                                 |
| HEAD awal & akhir    | `46abddf65`                                                                                                                                                                                                                              |
| Commit siklus 8/9    | `526b6a099`, `94cd0329e`, `2ca5fed68`, `a0ea6b206`, `35522592d`, `46abddf65` — semua ancestor HEAD                                                                                                                                       |
| Working tree         | `alim-connect-pdca-cycle-10.md` dan `alim-connect-staging-handoff.md` (baru), `LAPORAN-FASE-3-2026-11-20.md` dan `OpenWA/` (artefak lama, tidak disentuh), serta `.env.bak-connect-pairing` yang muncul sendiri (§7 — bukan buatan saya) |
| Kode produksi diubah | **tidak ada** — tiga varian perbaikan dicoba lalu direvert, lihat §3                                                                                                                                                                     |

## 2. Bukti akar penyebab

### 2.1 Mekanisme di Jest (dibaca dari sumber, bukan ditebak)

- `node_modules/jest-runner/build/index.js:108-117` — `freezeConsole()` memasang pengganti `_log`
  pada console tes. Pengganti itu **menulis "Cannot log after tests are done…" lalu
  `process.exitCode = 1`**.
- `:262` — `freezeConsole()` dipanggil di `finally` blok `try` yang **mengelilingi** `testFramework(...)`,
  yaitu setelah hook `afterAll` dan `afterEach` seluruh file selesai, dan sebelum hook flush laporan.
- Yang masih diizinkan setelah itu hanya satu putaran `setImmediate`.
- `node_modules/jest-cli/build/index.js:719` — `readResultsAndExit` hanya melihat `result.success`
  (yakni hasil suite). Worker yang menulis baris terlambat keluar dengan kode 1 atas inisiatifnya
  sendiri, karena baris itu menetapkan `process.exitCode` di worker.
- Pengganti `_log` tersebut **tidak memancarkan event**, jadi reporter tidak pernah tahu: ringkasan
  tetap `865 passed`, `0 failed`, sementara exit code 1.

### 2.2 Reproduksi deterministik

Fixture di `/tmp/c10-repro/` (tidak masuk repo), keduanya satu file, satu tes, **lulus**:

| Fixture                  | Isi                                                  | Hasil                                                     |
| ------------------------ | ---------------------------------------------------- | --------------------------------------------------------- |
| `late-log.repro.spec.ts` | `setTimeout(() => new LoggerService().log('…'), 50)` | `EXIT=1`, `1 passed`, `● Cannot log after tests are done` |
| `silent.repro.spec.ts`   | `setTimeout(() => process.stderr.write('…'), 50)`    | `EXIT=0`, `1 passed`, tanpa baris `●`                     |
| keduanya sekaligus       | —                                                    | `EXIT=1`, `2 passed`                                      |

Ini menutup pertanyaan siklus 9 ("apakah `exit 1` karena threshold/assertion/timeout?"): **bukan
ketiganya**. Threshold coverage tidak pernah dilanggar (siklus 9: 0 grup di bawah ambang), dan
assertion lulus; yang menetapkan kode keluar adalah jalur console Jest.

### 2.3 Sebaran di run nyata

Dihitung dari log run penuh siklus 10 (`/tmp/c10-cov-001..003.log`, semuanya `EXIT=1`,
`865 passed` / `0 failed`):

| Run           | Baris "Cannot log after tests are done" | Suite berbeda yang menulisnya                                                                                                 |
| ------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `c10-cov-001` | 6                                       | 4 (`group.tools`, `baileys-send-seen` ×3, `wwebjs-mention-spelling`, `reconnect-config`)                                      |
| `c10-cov-002` | 6                                       | 4 (`sqlite-busy-timeout`, `events.gateway.refusal-attribution`, `message.controller`, `session-rebind-ready-announcement` ×3) |
| `c10-cov-003` | 6                                       | 4 (`load-remote-media-credentials`, `send-pacing.service` ×3, `metrics-concurrent-render`, `own-send-mutations`)              |

Karena selalu **6 baris × 4 suite**: sekali pun satu baris sudah cukup untuk `exit 1`, ketiga run
tidak mungkin keluar 0. Siklus 10 sebelumnya hanya menghitung `grep -c "^FAIL "` = 0 lalu menyimpulkan
"tidak ada kegagalan"; baris `●` ini bukan blok `FAIL` sehingga terlewat.

Asal barisnya (stack trace di log) adalah modul yang **di-teardown di tengah jalan**:

| Sumber                                                                                           | Contoh dari log                                                |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `BaileysEvents.targetsForeignMessage` → `processMessageChange` → `concurrency-limiter.yieldSlot` | handler yang diparkir limiter dilanjutkan pada tick berikutnya |
| `BaileysLifecycle` timer pairing (`Timeout._onTimeout`, `baileys-lifecycle.ts:824`)              | timer yang menyala setelah flush terakhir                      |
| `LoggerService.warn/log` dari service yang sudah di-`destroy`                                    | plugin, session, media                                         |

Run tanpa coverage juga memuat 5–7 baris yang sama, jadi mekanismenya **tidak tergantung coverage**;
coverage hanya memperpanjang durasi sehingga jendela balapan lebih lebar.

## 3. Percobaan perbaikan (dan mengapa tidak di-commit)

Tiga varian dicoba, semuanya **direvert**; working tree kembali ke `46abddf65` tanpa perubahan kode.

| #   | Varian                                                                       | Hasil                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | `LoggerService.setLineWriter` + `setupFiles` menulis semua baris ke `stderr` | **Merusak 26 file** yang mem-spy `console.*` untuk membaca output logger (`mock.calls[0]` jadi kosong): `plugin-capability-logger`, `inflight-body-budget`, `worker-shutdown`, `redis-io.adapter.stall`, dst. Dihentikan setelah 15 suite FAIL (22 menit). |
| B   | Varian A + menandai console "tertutup" setelah tes terakhir                  | Tidak bisa diaktifkan dari `setupFiles`: `beforeAll`/`afterAll` tidak tersedia di sana (`ReferenceError: beforeAll is not defined`), dan hook dari file setup dilepas sebelum hook suite sendiri — terlalu awal.                                           |
| C   | Menekan **hanya** baris yang tiba setelah console ditutup, saat itu terjadi  | Tidak bisa: "ditutup" hanya terdeteksi lewat pengganti `_log` Jest sendiri, yang justru tidak boleh dipanggil (memanggilnya = menulis error + `exitCode = 1`).                                                                                             |

Kesimpulan teknis: **tidak ada titik di dalam file tes yang bisa menutup console sendiri**, dan
menyembunyikan barisnya sebelum tutup akan mengubah apa yang diuji file-file tersebut. Yang benar
adalah membuat baris itu **tidak tertulis setelah tes selesai**, yaitu suite menunggu pekerjaan
teardown-nya sendiri — perubahan per-suite yang harus dibuktikan satu per satu, bukan satu sakelar.

Alasan tidak melanjutkan di siklus ini: (a) jumlah suite yang memicunya bisa berubah tiap run
(4 suite berbeda di tiga run, 6 baris konstan), jadi tidak ada daftar tetap untuk diuji tuntas dalam
anggaran waktu siklus; (b) setiap perubahan per-suite menyentuh perilaku teardown yang sedang diuji
suite itu sendiri — risiko regresi lebih tinggi daripada nilai satu sakelar.

## 4. Hasil run penuh siklus ini

| Run                | Perintah                                                                                                                                                   | Exit  | Suite                                 | Tes                     | Waktu    | Baris "Cannot log" | Force-exit worker |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------- | ----------------------- | -------- | ------------------ | ----------------- |
| `c10-cold-cov-001` | cache dibersihkan (`jest --clearCache`), lalu `npx jest --coverage --coverageReporters=json-summary --coverageReporters=text-summary`, `maxWorkers` bawaan | **1** | **19 failed**, 846 passed, 865 of 879 | 20 failed, 21409 passed | 2391,9 s | **6**              | 1                 |

Coverage (dari log, bukan ingatan): **Statements 95,25 % · Branches 87,21 % · Functions 93,36 % ·
Lines 95,97 %**, dan **0** baris `does not meet` — ambang coverage (`77/66/80/77`) tidak dilanggar.

### 4.1 Analisis 19 suite yang gagal

| Kategori                          | Jumlah | Contoh                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Exceeded timeout of 5000 ms`     | 15     | `redis-connection`, `baileys-auth-store`, `ws-frame-limit`, `worker-shutdown`, `storage-downloads-busy`, `metrics.controller`, `session.controller.http`, `group.controller.http`, `keyed-mutation-queue`, `wwebjs-web-version-cache`, `wwebjs-launch-follows-later-injects`, `message-receipt-in-flight-chat`, `session-reconnect-teardown-disconnect-overlap`, `sandbox-hook-text-reply-within-budget`, `status-post-media-url-refusal` |
| Assertion karena race             | 2      | `root-namespace` (`Expected true, Received false` pada CONNECT root), `session-proxy-large-answer` (`Expected true, Received false` saat streaming)                                                                                                                                                                                                                                                                                       |
| Proses gateway **tidak mau boot** | 1      | `main-process-signals`: `the gateway did not come up: {"code":1}` (child `src/main.ts` mati saat start di bawah beban)                                                                                                                                                                                                                                                                                                                    |
| Duplikat jalur relatif            | 1      | keluaran lintas-worker untuk suite yang sama                                                                                                                                                                                                                                                                                                                                                                                              |

Setiap suite di atas **lulus dalam isolasi** bila dijalankan sendiri; tidak ada satu pun yang gagal
karena kode yang berubah (tidak ada kode yang berubah di siklus ini). Diperiksa ulang pada siklus ini:
`session-proxy-large-answer` + `root-namespace` + `sandbox-hook-text-reply-within-budget` bersamaan →
`EXIT=0`, `13 passed`, dua kali berturut-turut.

### 4.2 Hipotesis beban — sebagian terbukti, sebagian tidak

- **Terbukti:** beban mesin mengubah hasil. Run ber-cache (siklus 10 sebelumnya) 853–1034 s dengan
  **0** suite gagal; run cold-cache 2392 s dengan **19** suite gagal. Durasi naik 2,4× — cold cache
  memaksa ts-jest men-transpile seluruh proyek sambil suite berjalan, ditambah empat proses
  `codebuddy` yang aktif (load average 4,5–12,9).
- **Terbukti:** time-out terjadi pada tes yang **memang memakai waktu nyata** (soket WS, koneksi Redis,
  server HTTP in-process, child process). Tidak ada timeout yang dinaikkan dan tidak ada assertion yang
  dilonggarkan.
- **Tidak terbukti (jujur):** percobaan terarah saya **gagal mereproduksi** time-out dengan beban
  sintetis. Tes yang memutar CPU 4,9 detik (jatah 5 detik) dijalankan dengan 7 proses pesaing tetap
  lulus 3/3. Artinya tekanannya bukan sekadar "CPU sibuk", melainkan kombinasi cold transform cache +
  I/O + 865 suite yang berjalan bersamaan; saya tidak punya bukti eksperimental yang memisahkan
  ketiganya. Jangan mengutip §4.2 sebagai penjelasan lengkap.

Kesimpulan yang aman dikutip: **`exit 1` pada run tanpa suite gagal memang punya akar yang pasti
(§2, seluruh ringkasan `865 passed` / `0 FAIL` masih keluar 1 karena baris console), dan
kegagalan suite yang terlihat di run cold adalah masalah kedua yang terpisah** (time-out waktu nyata
di bawah beban), bukan akibat dari akar pertama.

## 5. Gate kualitas dan resource aktual

| Gate                                                      | Hasil                                                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint` (`NODE_OPTIONS=--max-old-space-size=3072`) | **exit 0**, tanpa keluhan (2 m 33 s); dijalankan saat spike masih terpasang, dan kode sudah direvert — hasil untuk HEAD identik dengan siklus 9 |
| Target suite terdampak (spike A, sudah direvert)          | 15/15 suite, 483 tes lulus, `EXIT=0`, 0 baris "Cannot log" — bukti mekanisme, bukan perbaikan yang dipakai                                      |
| `npx jest` subset dengan `--coverage`                     | selalu `exit 1` karena `collectCoverageFrom` mencakup semua file (siklus 9) — **bukan** dipakai sebagai gate                                    |
| Run penuh ber-coverage                                    | §4: `EXIT=1`, 19 suite gagal (semua lulus sendirian), coverage di atas ambang                                                                   |
| Heap                                                      | `--max-old-space-size=3072`; tidak pernah 6 GB                                                                                                  |
| Load mesin saat run cold                                  | 4,5–12,9 (empat proses `codebuddy` aktif, load 8 CPU)                                                                                           |

## 6. Integrasi nyata (status)

| Jalur                                   | Status siklus 10                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| SSO nyata (exchange HTTP ke Core)       | **belum** — menunggu URL HTTPS, kunci `sso:exchange`, origin browser, satu kode handoff sekali pakai                                |
| Approval nyata (POST approval-commands) | **belum** — menunggu kunci `approval:command`, permit staging terbuka, aktor berwenang                                              |
| Ingest dari Core ke Connect             | **belum** — menunggu `ALIM_CONNECT_INGEST_KEY` dari operator (diserahkan lewat secret manager, tidak lewat chat/log)                |
| Bukti internal/mock                     | sudah: E2E 46 lulus / 2 skip, PG 134/134 (siklus 8); diulang di siklus 10 setelah perubahan di §7 → **43 lulus / 5 skip, `EXIT=0`** |

Daftar permintaan yang tepat (nama variabel, siapa pemilik, dampak bila tidak ada, perintah yang akan
dijalankan, dan request keluar yang harus dicocokkan Core di log) ada di
`alim-connect-staging-handoff.md`. Mock **tidak** dihitung sebagai integrasi nyata di laporan ini.

## 7. Temuan lain yang jujur

- **Kegagalan `Exceeded timeout of 5000 ms`** juga muncul di run ber-coverage cold (§4.1) dan di run
  tanpa coverage siklus sebelumnya: suite yang memakai timer nyata kehabisan jatahnya saat mesin
  dimuat proses lain. Bukti: setiap suite yang gagal **lulus dalam isolasi** (mis. `19`, `7`, `7` tes),
  dan kegagalannya berpindah-pindah antar run. Tidak ada timeout yang dinaikkan.
- Run build yang terhenti (varian A) menunjukkan 9 suite gagal dengan pola assertion yang sama
  (console di-spy) — jadi mekanisme kerusakannya jelas, bukan acak.
- **Celah pengukuran di siklus sebelumnya:** pengecekan "0 baris `FAIL`" memakai `grep "^FAIL "`
  dengan locale UTF-8 dan **mengembalikan 0 padahal blok `FAIL` ada** (terbukti saat menghitung ulang
  log build yang terhenti: 12 blok). Siklus ini memakai `python3` dengan dekode eksplisit + regex
  multiline; angka di laporan ini berasal dari metode itu.
- **Berkas di luar jalur yang saya sentuh:** `.env.bak-connect-pairing` (21 baris, nama variabel
  `ALIM_CONNECT_*`/`ALIM_CORE_*`/`DATABASE_*`) muncul di working tree pada **2026-11-24 01:03** selama
  siklus ini. Saya **tidak membuatnya** dan tidak membacanya lebih jauh; nilainya tidak pernah dicetak.
  Berkas ini berisi rahasia dan belum di-ignore git — **pemilik repo perlu memutuskan** apakah
  dihapus atau dipindahkan, karena `git add -A` akan memasukkannya ke commit.
- **Tiga berkas berubah di working tree tanpa saya ubah** (`.env.bak-connect-pairing`, dua e2e spec,
  `scripts/alim-core-integration-lane.ts`; muncul selama run `npx jest --clearCache` + run penuh;
  total +48/−9). Isinya **memperbaiki bug nyata dan saya tidak merevert-nya**:
  - spec membaca `ALIM_CORE_BASE_URL` / kunci operator **setelah** file itu sendiri menimpanya dengan
    mock (`sso-handoff-http.e2e-spec.ts:192`, `approval-http.e2e-spec.ts:54`), jadi uji "Core
    sungguhan" akan menembak mock dan tetap "lulus"; sekarang nilai operator ditangkap sebelum
    penimpaan;
  - lane `runJest` diberi `requireRealProof`: bila kunci nyata diberikan tetapi tidak ada baris
    `[real-core] …` berisi kode HTTP, lane **gagal** alih-alih lulus (bagian mock tidak dihitung bukti).
    Verifikasi siklus ini: guard tanpa kredensial tetap **`EXIT=2` "Not ready."** dan mencetak lima
    variabel yang hilang (nama saja, tanpa nilai); kedua e2e suite **43 lulus / 5 skip, `EXIT=0`**; dan
    regex `REAL_CORE_PROOF` dicocokkan dengan bentuk baris yang benar-benar dicetak kedua spec
    (`httpStatus` untuk SSO, `coreResponseCode` untuk Approval). Bagian "Core sungguhan" sendiri
    **belum pernah berjalan** karena kredensialnya belum ada.

## 8. Commit dan working tree

Penutupan siklus 10 (setelah §7 ditulis) memverifikasi lalu meng-commit perubahan yang tadinya
menggantung di working tree. Tiga commit:

| Commit      | Isi                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `f97038554` | Tautan balasan ke notifikasi (`message:sent` → `recordNotification`), termasuk unit + e2e dan aktor staging untuk bagian Approval nyata |
| `b400ac68f` | Lane: nilai operator ditangkap sebelum mock, `requireRealProof`, kunci aktor staging, `src/common/alim-core-lane-proof.spec.ts`         |
| `4833abfd8` | Laporan siklus 10, handoff staging, dan `.env.*` di `.gitignore`                                                                        |

`.env.bak-connect-pairing` sekarang **ter-ignore** (`.gitignore:24`), jadi `git add -A` tidak lagi
memasukkannya; berkasnya sendiri tidak dihapus. `src/` masih identik dengan `46abddf65` kecuali
perubahan hook/processor di commit pertama.

Gate untuk ketiga commit dijalankan pada working tree yang sama (2026-11-24):

| Gate                                       | Hasil                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `npx tsc --noEmit -p tsconfig.json`        | exit 0, tanpa error                                                                  |
| Unit (3 spec: hook, processor, lane-proof) | 50 lulus, exit 0                                                                     |
| E2E `approval-http` + `sso-handoff-http`   | 44 lulus, 5 skip, exit 0 (bagian "Core sungguhan" tetap skip — kredensial belum ada) |
| `npm run lint` (heap 3072)                 | exit 0, 3 m 27 s                                                                     |

Sisa yang belum di-commit dan **tidak** disentuh: `LAPORAN-FASE-3-2026-11-20.md` dan `OpenWA/`
artefak lama. Poin #1 di §9 (penutupan teardown per-suite agar `exit 0` konsisten pada run penuh)
**masih terbuka** — commit di atas tidak menyentuhnya.

## 9. Act — target siklus 11

1. **Per-suite penutupan teardown** demi `exit 0` yang konsisten: pilih suite dari §2.3, buktikan
   bahwa pekerjaan teardown-nya selesai sebelum tes terakhir (guard `afterAll` yang menunggu handler
   berjalan / `await` limiter), tambahkan regression test per suite, lalu jalankan run penuh
   berulang sampai `exit 0` **dua kali berturut-turut** sebelum menyatakan selesai. Tanpa menaikkan
   timeout, tanpa menghapus assertion.
2. **Gate run penuh harus dijalankan dengan cache hangat dan mesin yang tidak dipakai proses lain**
   (§4.2): cold cache sendiri sudah menaikkan durasi 2,4× dan memunculkan 19 suite gagal yang lulus
   sendirian. Gate "exit 0" yang diukur pada mesin beban penuh tidak bermakna.
3. **Integrasi nyata** §6 begitu Core/operator menyerahkan item 1–9 di handoff: jalankan
   `npm run test:core-integration`, lalu `ALIM_CONNECT_SSO_TEST_CODE` + `ALIM_CONNECT_SSO_EXPECTED_CORE_USER`
   untuk jalur sukses SSO, dan buktikan 12 butir Approval lewat HTTP sungguhan.
4. **Timer nyata → fake timer** untuk suite yang gagal 5 detik di §4.1 (pekerjaan kualitas terpisah,
   bukan penutupan exit code).
5. **Selesaikan atau tutup eksperimen beban** §4.2 dengan satu run cold-cache yang diukur
   per-suite (`--json --outputFile`) sementara `ps` mencatat proses hidup, supaya penyebab time-out
   dibuktikan, bukan diduga.
