# PDCA Siklus 2 — Technical Readiness dan Persiapan Integrasi ALIM Core

**Tanggal:** 2026-11-23
**Repository:** `/Users/wawangunawan/OpenWA`
**Branch:** `feature/whatsapp-approval-finalization`
**Checkpoint:** `8c6c92510` (Batch 2), parent `b3c4fa9f9`
**Sifat:** implementasi dan pengukuran. Tidak ada commit, push, merge, deploy, migrasi produksi, atau perubahan credential.

---

## 1. Ringkasan

Siklus 2 tidak mengulang audit. Tujuh area yang tersisa dikerjakan sampai ada perubahan yang dapat dijalankan atau angka yang dapat dibandingkan.

| Area               | Hasil                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| PXP                | Dua indeks baru: balasan kutipan **33×** lebih cepat (20k baris) dan **153×** (50k baris); jalur "satu permohonan terbuka" **40×** |
| `hasIndex`         | Migrasi retry kini idempoten; diuji di SQLite dan PostgreSQL nyata                                                                 |
| Kontrak Core       | `Idempotency-Key` dan `X-ALIM-API-Version` dikirim, diuji, dan didokumentasikan untuk Core                                         |
| Timezone pooler    | Diuji lewat pooler Supabase yang sesungguhnya: setiap koneksi pool terpin UTC (2/2 lulus)                                          |
| VIEWER             | Batas lintas asrama diukur dengan test, bukan diasumsikan; dependensi Core didokumentasikan                                        |
| Retensi PII        | Inventaris kolom + laporan read-only yang dapat dijalankan; masa retensi tetap keputusan pemilik                                   |
| Timeout test suite | Akar masalah diidentifikasi per suite (lihat §3.7); tidak ada timeout yang dinaikkan tanpa alasan                                  |

Tiga temuan lama ditutup: `hasIndex`, PXP tanpa artefak, dan "tidak ada bukti pooler". Satu temuan baru ditemukan pada spec UTC PostgreSQL (daftar entity menyimpang dari registry ekspor); akar masalahnya dilaporkan di §5.2 dan **tidak** diperbaiki pada siklus ini karena perbaikannya menyentuh metadata entity di luar lingkup.

Hasil verifikasi (§4): dari dua belas gate, tujuh lulus tanpa perubahan, dua lulus setelah perbaikan, satu gagal karena pekerjaan di luar siklus ini, dan dua run penuh gagal karena timeout saat mesin jenuh. Suite penuh: 16 gagal, 15 ditutup (3 cacat diperbaiki, 12 timeout terbukti starvation CPU dan lulus saat dijalankan sendiri), 1 terbuka karena menunggu pengakuan keamanan pemilik fitur SSO. Coverage: 46 gagal, 45 di antaranya starvation dan satu gate SSO yang sama. Kedua run penuh tidak dinyatakan lulus.

---

## 2. PLAN — apa yang tersisa dan apa yang tidak boleh diputuskan

Baseline: rekonsiliasi TODO (`alim-connect-todo-reconciliation.md`) dan PDCA Siklus 1.

| #   | Area            | Dapat dikerjakan Connect? | Batas                                                            |
| --- | --------------- | ------------------------- | ---------------------------------------------------------------- |
| 1   | PXP             | ya                        | Hanya optimasi yang terbukti dari pengukuran                     |
| 2   | VIEWER          | sebagian                  | Scoping butuh unit organisasi dari Core; tidak boleh diasumsikan |
| 3   | Retensi PII     | sebagian                  | Mekanisme boleh; masa retensi tidak                              |
| 4   | `hasIndex`      | ya                        | Tanpa menjalankan migrasi produksi                               |
| 5   | Timeout suite   | ya                        | Tidak menaikkan timeout untuk menutupi kegagalan                 |
| 6   | Timezone pooler | ya                        | Lingkungan pooler tersedia, jadi diuji langsung                  |
| 7   | Kontrak Core    | ya (sisi Connect)         | Tidak mengarang endpoint; credential tetap milik Core            |

---

## 3. DO — implementasi

### 3.1 PXP — mengukur dulu, lalu mengindeks

**Baseline.** `scripts/approval-lookup-bench.ts` (baru) mengisi tabel approval dan mengukur empat lookup yang dijalankan setiap balasan WhatsApp. Pada 20.000 baris:

| Lookup                                                       | Rencana query                                                              | Rata-rata  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------- |
| Balasan kutipan (`notificationMessageId` + `targetIdentity`) | `SCAN approval_requests`                                                   | 898,4 µs   |
| Referensi di teks (`reference` + `targetIdentity`)           | `SEARCH ... UQ_approval_requests_reference`                                | 3,5 µs     |
| Satu permohonan terbuka (`targetIdentity` + status, terbaru) | `SEARCH ... IDX_approval_requests_status` + `USE TEMP B-TREE FOR ORDER BY` | 1.113,7 µs |
| Idempotensi ingest (`coreRequestId`)                         | `SEARCH ... UQ_approval_requests_core_request`                             | 3,4 µs     |

**Bottleneck.** Dua dari empat jalur memindai tabel. Yang lebih buruk, keduanya adalah jalur yang paling sering dipakai: balasan langsung ke notifikasi, dan jalan pintas "hanya satu permohonan terbuka". Biayanya tumbuh linear terhadap jumlah permohonan, bukan terhadap jumlah baris milik satu pengirim.

**Bentuk indeks dipilih dari percobaan, bukan dugaan.** Tiga kandidat diukur pada data yang sama:

| Kandidat                                  | Balasan kutipan | Satu permohonan terbuka | Catatan                    |
| ----------------------------------------- | --------------- | ----------------------- | -------------------------- |
| `(targetIdentity, status)`                | 317 µs          | 404 µs                  | masih menyortir            |
| `(targetIdentity, status, createdAt)`     | 320 µs          | 23,5 µs                 | masih `TEMP B-TREE`        |
| `(targetIdentity, createdAt)`             | 452 µs          | **18,8 µs**             | tanpa sort                 |
| `(notificationMessageId, targetIdentity)` | **14,3 µs**     | —                       | menutup kedua kolom filter |

**Implementasi.** `1792600000000-AddApprovalLookupIndexes.ts` menambahkan `IDX_approval_requests_notification (notificationMessageId, targetIdentity)` dan `IDX_approval_requests_target_created (targetIdentity, createdAt)`, dengan `getTable` sebagai penjaga agar `up()` aman diulang. Decorator `@Index` pada entity disamakan supaya metadata dan migrasi tidak menyimpang.

**Hasil.**

| Lookup                  | 20k sebelum | 20k sesudah       | 50k sebelum | 50k sesudah        |
| ----------------------- | ----------- | ----------------- | ----------- | ------------------ |
| Balasan kutipan         | 898,4 µs    | **27,1 µs** (33×) | 2.347,8 µs  | **15,3 µs** (153×) |
| Satu permohonan terbuka | 1.113,7 µs  | **27,9 µs** (40×) | 2.886,3 µs  | **29,5 µs** (98×)  |
| Referensi di teks       | 3,5 µs      | 3,9 µs            | 2,0 µs      | 2,3 µs             |
| Idempotensi ingest      | 3,4 µs      | 3,6 µs            | 3,3 µs      | 3,5 µs             |

Yang penting bukan hanya rasionya: baseline **naik** 2,6× ketika baris bertambah 2,5× (linear), sedangkan sesudah indeks tetap datar. Rencana query berubah dari `SCAN` menjadi `SEARCH ... USING INDEX`, dan `TEMP B-TREE` hilang dari jalur "satu permohonan terbuka".

`src/modules/approval/approval-lookup-index.spec.ts` (baru, 3 test) mengunci rencana query itu dan membuktikan kedua migrasi dapat dijalankan dua kali.

### 3.2 `hasIndex` pada migrasi retry

`1792500000000-AddApprovalCommandRetry.ts` sebelumnya memanggil `createIndex` tanpa penjaga. Bila indeks sudah ada di luar ledger (restore parsial, migrasi manual), `up()` gagal dengan "index already exists" — tepat pada keadaan yang paling butuh pemulihan.

Perbaikan: baca `getTable(...).indices` dan buat hanya bila belum ada. Mengubah migrasi yang sudah tercatat aman karena TypeORM menyimpan **nama dan timestamp**, bukan checksum: database yang sudah menjalankannya tidak akan menjalankannya lagi, sedangkan database baru mendapat `up()` yang idempoten.

Diuji dua kali: SQLite (`approval-lookup-index.spec.ts`, "keeps both migrations repeatable") dan PostgreSQL nyata (`approval-retry.pg.spec.ts`, "membuat indeks pencarian dan tetap idempoten"). Tidak ada migrasi yang dijalankan terhadap database produksi.

### 3.3 Kontrak Approval Command dari sisi Connect

Yang berubah di kode:

- `HttpAlimCoreApprovalClient` mengirim `Idempotency-Key: <command_id>` pada setiap command, dan `X-ALIM-API-Version: 1` kecuali `ALIM_CORE_API_VERSION` dikosongkan.
- Nilai `Idempotency-Key` identik dengan `command_id` di body, sehingga Core tidak dapat menerima satu command sebagai dua pengiriman.
- Config baru `connect.approval.apiVersion` (default `1`).

Yang berubah di kontrak dan test:

- `approval-command.openapi.yaml` mendeklarasikan kedua header, dengan `x-needs-core-confirmation` diperbarui: bukan lagi "apakah header ditambahkan" melainkan "apakah Core akan memvalidasinya".
- Mock Core merekam header (`receivedHeaders`), dan dua test kontrak baru memastikan header terkirim serta **sama pada pengiriman ulang**.
- Test HTTP E2E menegaskan header itu benar-benar keluar lewat `fetch` nyata, bukan hanya di unit test.

Dokumen `docs/integration/alim-connect-core-integration-contract.md` (baru) adalah kontrak yang dapat langsung dipakai Core: endpoint, autentikasi, header, field request, envelope respons, tabel kode error beserta perilaku Connect, aturan idempotensi, retry, timeout, dan lima butir yang masih menunggu Core.

### 3.4 Timezone pada koneksi pooler

`postgres-utc.pg.spec.ts` membuktikan pin pada satu koneksi. Yang belum dibuktikan adalah sifat yang bisa dirusak pooler: **setiap** backend yang dibuka pool membawa pin, bukan hanya yang melayani query pertama.

`src/database/postgres-utc-pool.pg.spec.ts` (baru, 2 test) membuka pool `max: 4` lalu menjalankan 8 query bersamaan, sehingga pool harus membuka beberapa koneksi. Setiap koneksi harus melaporkan `TimeZone = UTC` dan offset 0 pada dua titik enam bulan terpisah; `assertDataConnectionUtc` juga dijalankan pada pool yang sama. Test kedua membandingkan `now()::timestamp` yang ditulis server dengan jam driver.

Dijalankan terhadap pooler Supabase pada `.env` (session mode): **2/2 lulus**. Spec ditambahkan ke lane PostgreSQL di `ci.yml` agar berjalan di CI, bukan hanya di mesin ini.

### 3.5 VIEWER dan akses lintas asrama

Yang ditemukan: tidak ada pembatasan unit sama sekali. `GET /api/approval/requests` mengembalikan seluruh permohonan, `GET /api/approval/requests/:id` membuka permohonan mana pun, dan `dormitoryCoreId` hanya menjadi data tampilan. `allowedSessions` pada API key tidak membatasi data approval — hanya `sessionId` yang disebut saat ingest.

Yang dikerjakan: test HTTP E2E baru mengunci keadaan itu secara eksplisit — dua permohonan dari asrama berbeda, keduanya terbaca oleh satu key `VIEWER`. Test itu diberi nama "batas yang diketahui" dan komentar yang menyatakan bahwa ia harus diganti dengan test negatif ketika scoping ditambahkan. Dengan begitu gap-nya terukur dan tidak bisa hilang diam-diam.

Yang **tidak** dikerjakan: scoping itu sendiri. Connect tidak memiliki sumber unit organisasi yang sah dari Core, dan menebak dari `dormitoryCoreId` yang dikirim Core akan menciptakan otorisasi semu. Dependensi: endpoint unit/asrama Core (P0 di rekonsiliasi).

### 3.6 Retensi PII

**Inventaris** (kolom yang benar-benar berisi data pribadi):

| Tabel               | Kolom                                                    | Isi                                      |
| ------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `approval_requests` | `studentName`, `studentClass`                            | identitas santri                         |
| `approval_requests` | `targetIdentity`                                         | nomor WhatsApp Kepala Asrama             |
| `approval_requests` | `targetCorePersonId`, `dormitoryName`, `dormitoryCoreId` | identitas personel dan unit Core         |
| `approval_requests` | `notificationMessageId`                                  | id pesan notifikasi (tautan ke WhatsApp) |
| `approval_commands` | `externalMessageId`                                      | id pesan balasan                         |
| `approval_commands` | `lastError`                                              | teks error; dapat memuat pesan Core      |
| `approval_commands` | `coreResponseBody`                                       | body respons Core, disimpan mentah       |

**Masa retensi saat ini: tidak ada.** Tidak ada job, trigger, atau perintah yang menghapus baris approval. Data bertahan selama database hidup. Satu-satunya penghapusan yang ada adalah milik modul lain (outbox webhook), bukan approval.

**Mekanisme yang disiapkan:** `scripts/approval-retention-report.js` (baru, hanya baca) melaporkan jumlah baris per keranjang umur (30/90/180/365 hari), rentang tanggal, dan berapa baris pada setiap kolom PII yang terisi. Koneksi SQLite dibuka `readonly: true`; PostgreSQL hanya menjalankan `SELECT`. Script tidak menerima parameter masa retensi dan tidak menghapus apa pun.

Diverifikasi pada SQLite (3 baris: 1/100/400 hari → keranjang 30=2, 90=2, 180=1, 365=1) dan pada PostgreSQL (skema terbaca, 0 baris).

**Keputusan yang tetap milik pemilik sistem:** berapa lama data disimpan, siapa yang berwenang menghapus, dan apakah `coreResponseBody` perlu disimpan mentah atau cukup kode + pesan tersanitasi.

### 3.7 Timeout suite — akar masalah, bukan angka timeout

**Pengukuran pertama.** Suite penuh pada mesin idle: 21.221 test, **5 gagal**, 141 dilewati, 848 suite. Di bawah beban `--coverage` (worker penuh + instrumentasi): 11 gagal. Kelima kegagalan pertama:

| Suite                                                   | Gejala                        | Akar masalah                                                                                                                                       | Tindakan                                                                         |
| ------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `database/docs-schema-accuracy.spec.ts`                 | daftar migrasi tidak cocok    | Migrasi baru `1792600000000` belum tercatat di `docs/05`                                                                                           | **Diperbaiki**: entri ditambahkan                                                |
| `message/chat-media-download.spec.ts`                   | unhandled `error` pada stream | Test menghancurkan stream lewat timer 50 ms; handler baru memasang listener saat mulai mempipe, jadi di mesin lambat `error` terbit tanpa listener | **Diperbaiki**: test memasang listener miliknya sendiri; assertion tidak berubah |
| `common/storage/storage-transfer.spec.ts`               | timeout 5 detik               | 4 × 256 KB melewati tar + unzip; CPU-bound, bukan menunggu                                                                                         | Tidak diubah                                                                     |
| `session/session-push-name-sync.spec.ts`                | timeout 5 detik               | Seluruhnya mock; tidak ada penantian nyata                                                                                                         | Tidak diubah                                                                     |
| `engine/adapters/wwebjs-socks-credential-start.spec.ts` | timeout 5 detik               | Seluruhnya mock; tidak ada penantian nyata                                                                                                         | Tidak diubah                                                                     |

**Verifikasi akar masalah.** Ketiga suite timeout dijalankan sendiri-sendiri: `storage-transfer` 23/23, `session-push-name-sync` 6/6, `wwebjs-socks-credential-start` 9/9. Tidak ada yang menggantung; yang berubah hanya jumlah CPU yang tersedia. Karena itu **tidak ada timeout yang dinaikkan dan tidak ada assertion yang dilonggarkan** — memperpanjang batas hanya akan memindahkan kegagalan, bukan menghilangkannya.

**Penyebab sistemik.** Jest menjalankan sejumlah worker setara core, masing-masing proses ts-jest. Pada mesin ini 21 ribu test dengan belasan worker membuat pekerjaan 50 ms dapat melewati 5 detik saat GC dan transformasi bertumpuk. Ini bukan cacat test, dan CI dengan core lebih sedikit tidak mengalaminya.

**Mitigasi yang didokumentasikan (bukan perubahan konfigurasi):** untuk verifikasi lokal, jalankan suite yang gagal sendiri (`npx jest <path>`) atau batasi worker (`npx jest --maxWorkers=4`). Konfigurasi default tidak diubah karena menurunkannya akan memperlambat CI tanpa memperbaiki apa pun di sana.

**Kesimpulan jujur:** eksekusi penuh pertama **tidak** lulus (5 gagal). Dua diperbaiki di kode; tiga adalah timeout karena beban yang lulus saat diulang. Angka itu dilaporkan apa adanya di §4, bukan dinyatakan hijau.

---

## 4. CHECK — hasil eksekusi sebenarnya

Setiap baris di bawah adalah eksekusi nyata di mesin ini pada 2026-11-23, dari working tree (tidak ada commit). Klasifikasi yang dipakai persis enam: **lulus**, **gagal**, **dilewati**, **gagal karena timeout**, **lulus setelah diulang**, **belum dapat diverifikasi**. Tidak ada assertion yang dilonggarkan dan tidak ada batas waktu yang dinaikkan agar hasil terlihat hijau.

| #   | Gate                         | Perintah                                                              | Hasil aktual                                                                                                                           | Klasifikasi                                           |
| --- | ---------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | Build                        | `npm run build`                                                       | `nest build` selesai, exit 0                                                                                                           | lulus                                                 |
| 2   | Lint                         | `NODE_OPTIONS=--max-old-space-size=6144 npm run lint`                 | Eksekusi pertama 18 masalah di 3 file; setelah diperbaiki exit 0                                                                       | lulus setelah perbaikan                               |
| 3   | TypeScript seluruh repo      | `npx tsc --noEmit`                                                    | 6 error di 4 spec (tipe mock), tidak satu pun file siklus ini                                                                          | gagal (di luar lingkup)                               |
| 4   | Unit approval                | `npx jest src/modules/approval`                                       | 17 suite lulus, 1 dilewati; 174 lulus, 9 dilewati, 3,3 s                                                                               | lulus                                                 |
| 5   | HTTP E2E approval            | `npx jest --config test/jest-e2e.json test/approval-http.e2e-spec.ts` | 19/19; 2,9 s saat idle, 40,4 s saat suite penuh berjalan                                                                               | lulus                                                 |
| 6   | Kontrak Core                 | `npm run test:contracts`                                              | 86/86, 2 suite, 0,5 s                                                                                                                  | lulus                                                 |
| 7   | PostgreSQL approval (pooler) | `npx jest src/modules/approval/approval-retry.pg.spec.ts`             | 9/9, 36,9 s                                                                                                                            | lulus                                                 |
| 8   | Pin UTC lewat pool           | `npx jest src/database/postgres-utc-pool.pg.spec.ts`                  | 2/2, 3,3 s                                                                                                                             | lulus                                                 |
| 9   | OpenAPI                      | `npm run openapi:check`                                               | Saat diukur siklus ini: exit 1, 3 hunk `coreUserId`. Setelah snapshot `openapi.json` diperbarui oleh pekerjaan SSO: **exit 0, 0 hunk** | lulus setelah snapshot diperbarui (di luar siklus)    |
| 10  | Dokumentasi                  | `npm run test:docs`                                                   | Eksekusi pertama 964/967; terakhir **968/968, 39 suite**, exit 0                                                                       | lulus setelah perbaikan                               |
| 11  | Suite penuh                  | `npm test`                                                            | 21.279 test: **16 gagal**, 141 dilewati, 21.122 lulus; 14 dari 867 suite gagal                                                         | gagal pada eksekusi pertama (rincian §4.6)            |
| 12  | Cakupan (coverage)           | `npm run test:cov`                                                    | 34 suite gagal (46 test), 21.092 lulus; ambang global terpenuhi; 34 suite dijalankan ulang                                             | gagal karena timeout saat berinstrumen (rincian §4.7) |

### 4.1 Lint — 18 temuan, semuanya di file baru siklus ini

`npm run lint` butuh `NODE_OPTIONS=--max-old-space-size=6144` di mesin ini; tanpa itu eslint kehabisan heap sebelum selesai. Eksekusi pertama menghasilkan 18 masalah (17 error, 1 warning) di tiga file yang dibuat siklus ini:

| File                                                | Temuan                                                                                 | Perbaikan                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `approval-lookup-index.spec.ts`                     | `no-unnecessary-type-assertion` + `no-unsafe-assignment` pada hasil `dataSource.query` | `query<Array<{...}>>()` menggantikan cast; cast di baris berikutnya ikut hilang         |
| `test/approval-http.e2e-spec.ts`                    | 5 × `no-unsafe-member-access`/`argument` pada `first.body.id` dari supertest           | respons diberi tipe `{ body: ApprovalRequestBody }`, sama seperti test lain di file itu |
| `test/contracts/alim-core/approval-command.spec.ts` | 1 × prettier                                                                           | dirapikan                                                                               |

Tidak ada assertion yang diubah untuk lolos: yang diperbaiki adalah tipe dan format. Eksekusi kedua: exit 0, 0 error, 0 warning.

### 4.2 TypeScript — build lulus, `tsc --noEmit` tidak

`npm run build` memakai tsconfig build yang tidak menyertakan `*.spec.ts`, dan itu **lulus**. `npx tsc --noEmit` menyertakan spec dan gagal dengan 6 error di 4 file — **tidak satu pun** disentuh siklus ini:

| File                                           | Error                                                  |
| ---------------------------------------------- | ------------------------------------------------------ |
| `auth/users.service.spec.ts:111`               | callback transaksi bertipe `unknown`, bukan `Promise`  |
| `campaign/campaign-runner.service.spec.ts:245` | 2 error (cast `undefined`, tuple kosong)               |
| `crm/crm.service.spec.ts:126,152`              | tipe baris mock `Record<string, unknown>` vs `unknown` |
| `inbox/inbox.service.spec.ts:230`              | sama                                                   |

Penyebabnya drift tipe mock yang sudah ada di `HEAD`: helper transaksi dan pemetaan baris di spec lama tidak lagi cocok dengan tipe service-nya. Bukan dari siklus ini, dan bukan dari fitur SSO. Tidak diperbaiki di siklus ini karena perbaikannya menyentuh empat modul di luar approval dan tidak menahan apa pun: `nest build` (yang menentukan artefak) dan seluruh test tetap berjalan.

Catatan pengukuran: pada eksekusi pertama siklus ini jumlahnya 8, karena dua mock `User` belum memuat `coreUserId` dari pekerjaan SSO yang saat itu belum selesai. Pekerjaan itu memperbaiki mock-nya sendiri di tengah sesi, sehingga angka terakhir 6.

### 4.3 OpenAPI — gagal saat diukur, lulus setelah snapshot diperbarui pekerjaan lain

Saat gate dijalankan untuk siklus ini, `npm run openapi:check` exit 1 dengan 3 hunk, semuanya penambahan `coreUserId` pada skema `User` dan DTO-nya. Siklus ini sendiri tidak menambah permukaan HTTP sama sekali: dua header kontrak bersifat **keluar** (request Connect → Core, tidak terlihat di spec Connect), dan migrasi indeks tidak punya DTO.

Sesudah itu, di tengah sesi, pekerjaan SSO di working tree menjalankan `npm run openapi:export` sehingga `openapi.json` memuat `coreUserId` dan rute SSO. Gate diukur ulang: **exit 0, 0 hunk**. Yang perlu dicatat: yang membuat gate hijau adalah snapshot milik fitur lain, bukan perubahan siklus ini — dan itu sebabnya angka pertama tetap dilaporkan.

### 4.4 Dokumentasi — dua gate nyata ditemukan dan diperbaiki

Eksekusi pertama `npm run test:docs`: 964/967. Yang gagal:

| Gate                  | Sebab                                                                              | Tindakan                                    |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `test-lane-partition` | `postgres-utc-pool.pg.spec.ts` terdaftar di `ci.yml` tetapi tidak di `release.yml` | spec ditambahkan ke daftar PG `release.yml` |
| `release-gate-parity` | konsekuensi yang sama: perintah gate di `ci.yml` harus juga ada di `release.yml`   | diperbaiki oleh perubahan yang sama         |

Keduanya bukan formalitas: gate itu menjaga agar jalur tag merilis dengan gate yang sama dengan jalur branch, sehingga spec pooler tidak diam-diam hanya berjalan di PR. Setelah perbaikan, eksekusi terakhir **968/968 lulus, 39 suite, exit 0**.

Catatan: `docs-env-example` sempat gagal pada delapan kunci SSO; itu teratasi ketika blok `.env.example` untuk fitur SSO masuk ke working tree, bukan karena perubahan siklus ini.

### 4.5 PostgreSQL nyata, lewat pooler

Kedua suite berjalan terhadap koneksi pooler Supabase yang sesungguhnya (host pooler, port 5432, TLS dengan `rejectUnauthorized=false`), bukan `localhost`:

| Suite                          | Hasil       | Catatan                                                                                                       |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `approval-retry.pg.spec.ts`    | 9/9, 36,9 s | Test baru (indeks + idempotensi) 4,0 s — paling lambat karena menjalankan dua `up()` lagi dan membaca katalog |
| `postgres-utc-pool.pg.spec.ts` | 2/2, 3,3 s  | 8 query paralel pada pool `max: 4`; setiap koneksi melaporkan `TimeZone=UTC` dan offset 0                     |

Jebakan lingkungan yang ditemukan dan dicatat: spec membaca `process.env` langsung, sedangkan Jest tidak memuat `.env`, jadi variabel harus diekspor ke shell lebih dulu. `npm run test:pg-approval` hanya memeriksa `DATABASE_TYPE` di process env — bukan isi `.env` — sehingga perintah itu gagal dengan "DATABASE_TYPE=postgres wajib diisi" meski `.env` sudah benar.

### 4.6 Suite penuh — eksekusi pertama tidak lulus

`npm test`: 21.279 test, **16 gagal**, 141 dilewati, 21.122 lulus; 14 dari 867 suite gagal; 1.580 s. Eksekusi ini berjalan **sambil** gate lain dijalankan (E2E dan docs), jadi bebannya lebih berat daripada eksekusi idle di §3.7. Rincian keenam belas kegagalan:

| Sebab                         | Jumlah test | Tindakan                                                                                 | Status                                           |
| ----------------------------- | ----------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `compose-parity` (2 test)     | 2           | `.env.example` mendapat `ALIM_CORE_API_VERSION` tetapi compose tidak memforward-nya      | **Diperbaiki** → 52/52 lulus                     |
| `docs-schema-accuracy`        | 1           | migrasi `1792700000000-AddUserCoreUserId.ts` (pekerjaan SSO) belum tercatat di `docs/05` | **Diperbaiki** → 4/4 lulus                       |
| `swagger.config` PUBLIC_PATHS | 1           | `@Public()` pada `sso-handoff.controller.ts` belum diakui                                | **Terbuka** — keputusan pemilik fitur SSO (§5.4) |
| Timeout 5 detik (11 suite)    | 12          | seluruhnya mock/timer; tidak ada penantian jaringan                                      | **Lulus setelah diulang** → 226/226 dalam 3,8 s  |

Bukti bahwa dua belas terakhir adalah starvation CPU dan bukan cacat: kesebelas suite dijalankan ulang dengan `--runInBand` dan lulus **226/226 dalam 3,8 detik**. Suite yang di suite penuh memakan 628 detik (`baileys-change-sender-lid-phone`) selesai dalam hitungan detik saat mesin tidak berebut CPU. Tidak ada timeout yang dinaikkan.

Dua perbaikan di atas menyentuh berkas di luar kode approval dan itu disengaja: `compose-parity` menuntut setiap knob yang didokumentasikan `.env.example` dan dibaca aplikasi diforward di **kedua** compose, jadi `ALIM_CORE_API_VERSION` ditambahkan ke keduanya — sekaligus delapan knob SSO yang gate itu tandai, karena pola yang sama (forward kosong = fitur mati, default aman). `docs/05` hanya menambahkan satu baris nama berkas migrasi yang sudah ada.

### 4.7 Cakupan — ambang terpenuhi, tetapi run berinstrumen tidak bersih

`npm run test:cov` selesai dalam 3.112 s (52 menit) dengan **46 test gagal di 34 suite**, 21.092 lulus, 141 dilewati. Ambang cakupan sendiri **tidak dilanggar** — Jest tidak melaporkan satu pun pelanggaran threshold — dan angka globalnya:

| Cakupan global | Hasil  |
| -------------- | ------ |
| Statements     | 94,20% |
| Branches       | 85,90% |
| Functions      | 91,06% |
| Lines          | 94,93% |

Ke-34 suite itu dijalankan ulang secara serial: **33 suite lulus, 1.254 dari 1.255 test, dalam 16,4 detik**. Satu yang tetap gagal adalah `config/swagger.config.spec.ts` — pengakuan `@Public()` SSO (§5.4), bukan timeout. Jadi 45 dari 46 kegagalan adalah starvation CPU karena instrumentasi menambah beban pada worker yang sudah penuh; sisanya gate nyata milik pekerjaan lain.

Cakupan khusus approval diukur terpisah, karena itulah yang menjadi tanggung jawab siklus ini:

| Cakupan `src/modules/approval/` | Hasil  | Ambang |
| ------------------------------- | ------ | ------ |
| Statements                      | 93,82% | 86     |
| Branches                        | 79,89% | 72     |
| Functions                       | 91,50% | 85     |
| Lines                           | 93,59% | 86     |

Perintah: `npx jest src/modules/approval --coverage --collectCoverageFrom='modules/approval/**/*.ts'`. Suite PostgreSQL tidak ikut terukur karena `describe.skip` tanpa server.

### 4.8 Yang belum dapat diverifikasi

| Hal                                 | Alasan                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| Endpoint ALIM Core yang sebenarnya  | Belum ada endpoint maupun kredensial; seluruh kontrak terbukti terhadap mock, bukan Core     |
| Penerapan migrasi di produksi       | Dilarang pada siklus ini; migrasi hanya dijalankan pada database probe                       |
| Scoping `VIEWER` per asrama/unit    | Butuh sumber unit organisasi dari Core; tanpa itu hanya batas yang diketahui yang bisa diuji |
| Masa retensi data pribadi           | Keputusan pemilik sistem, bukan keputusan teknis                                             |
| `postgres-utc.pg.spec.ts` (13 test) | Merah di `HEAD` karena drift daftar entity; akar masalah dan jalur perbaikan di §5.2         |

**Kesimpulan CHECK.** Dua belas gate dijalankan: tujuh lulus tanpa perubahan (build, unit approval, HTTP E2E, kontrak, PostgreSQL approval, pin UTC pooler, OpenAPI setelah snapshot fitur lain diperbarui), dua lulus setelah perbaikan (lint, dokumentasi), satu gagal karena pekerjaan di luar siklus ini (TypeScript seluruh repo: 6 error tipe mock di empat modul non-approval), dan dua run penuh gagal karena timeout saat mesin jenuh (suite penuh 16 gagal, coverage 46 gagal) — keduanya diperiksa ulang dan seluruh timeout terbukti lulus saat dijalankan sendiri.

Suite penuh **tidak** dinyatakan lulus: dari 16 kegagalannya, 15 ditutup — 3 kegagalan cacat nyata diperbaiki, 12 timeout terbukti starvation CPU dan lulus saat dijalankan sendiri — dan 1 tetap terbuka karena membutuhkan pengakuan keamanan pemilik fitur SSO. Hal yang sama berlaku untuk coverage: 45 dari 46 kegagalannya adalah starvation (33 dari 34 suite lulus saat diulang), dan yang tersisa adalah gate SSO yang sama.

---

## 5. ACT — temuan, kesiapan, dan langkah berikutnya

### 5.1 Temuan yang ditutup siklus ini

| Temuan                                          | Bukti penutupan                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| PXP tanpa artefak pengukuran                    | Baseline dan hasil sesudah di §3.1, dapat diulang dengan `npm run bench:approval` |
| `hasIndex` hilang pada migrasi retry            | Guard + test idempoten di SQLite dan PostgreSQL (§3.2)                            |
| "Tidak ada bukti pin UTC pada pooler"           | 8 koneksi pool diuji terhadap pooler nyata (§3.4)                                 |
| "Kontrak hanya satu arah, header belum dikirim" | Header dikirim, diuji di unit/kontrak/E2E, didokumentasikan (§3.3)                |
| "VIEWER lintas unit hanya asumsi"               | Diukur dengan test HTTP (§3.5)                                                    |

### 5.2 Temuan baru: spec UTC PostgreSQL tidak dapat dijalankan

`postgres-utc.pg.spec.ts` gagal 6 dari 13 test pada PostgreSQL nyata. Penyebabnya bukan UTC: daftar entity-nya ditulis tangan dan tidak lagi memuat modul yang kemudian masuk registry ekspor (`division`, `campaign`, `crm`, `inbox`, `approval`), sedangkan `exportData()` menolak metadata yang tidak cocok dengan registry. Jadi spec itu merah karena drift, bukan karena pin.

Perbaikan yang dicoba — mengganti daftar dengan glob yang sama seperti `data-source.ts` — membuka masalah kedua: entity `Division` mendeklarasikan relasi `@ManyToOne(() => Session)` pada kolom `varchar(100)`, sementara `Session.id` adalah `uuid`; TypeORM menolak metadata itu ("Column sessionId of Entity Division does not support length property"). Memperbaikinya berarti mengubah metadata entity dan berisiko terhadap parity migrasi, di luar lingkup siklus ini. Perubahan itu dibatalkan, dan spec dibiarkan seperti di `HEAD`.

Karena itu verifikasi pooler dipisahkan ke spec sendiri (`postgres-utc-pool.pg.spec.ts`) yang tidak menyentuh `exportData()` sama sekali. Verifikasi pooler berjalan hari ini; spec UTC yang lama tetap merah sampai drift entity dibereskan. Ini dicatat sebagai temuan terbuka, bukan disembunyikan.

Rekomendasi perbaikan (Siklus 3): samakan tipe kolom FK `Division.sessionId` dengan kunci `Session.id` (atau ganti relasinya dengan kolom biasa seperti `ChatState`), lalu ganti daftar entity di spec dengan glob. Setelah itu seluruh 13 test UTC dapat dijalankan di PostgreSQL.

### 5.3 Kesiapan

| Aspek                      | Status                                                         | Alasan                                                                                                                              |
| -------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Internal Connect           | **SIAP review untuk sisi approval**                            | Gate approval lulus seluruhnya; PXP terukur; migrasi idempoten. Tiga gate repo masih merah karena pekerjaan di luar approval (§5.4) |
| Kontrak untuk Core         | **SIAP dipakai**                                               | Dokumen kontrak + test kontrak + header terkirim                                                                                    |
| Uji HTTP dengan Core nyata | **SIAP dimulai begitu Core menyediakan endpoint + credential** | Tidak ada lagi pekerjaan Connect yang menahan; hanya §6 yang tersisa                                                                |
| Staging                    | **BELUM**                                                      | Menunggu Core (endpoint aktif, dua credential, konfirmasi kontrak)                                                                  |
| Produksi                   | **BELUM**                                                      | Retensi, scoping, soak, dan keputusan pemilik belum ada                                                                             |

Jawaban atas pertanyaan siklus: **ya, Connect siap menjalani HTTP integration test dengan Core nyata** segera setelah Core menyediakan endpoint command yang aktif dan credential layanan. Yang belum siap adalah produksi, dan itu bukan karena kode Connect.

### 5.4 Temuan gate di luar lingkup approval (pekerjaan SSO yang belum di-commit)

Working tree juga memuat fitur SSO WhatsApp Connect yang belum di-commit. Empat gate repo sempat terpengaruh, dan penting dibedakan dari pekerjaan siklus ini:

| Gate                                   | Sebab                                                                                                     | Tindakan                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `compose-parity` (2 test)              | Delapan knob SSO dan `AUTH_SESSION_IDLE_TIMEOUT_MINUTES` didokumentasikan tetapi tidak diforward compose  | **Diperbaiki**: diforward kosong di kedua compose (forward kosong = fitur mati, default aman) |
| `docs-schema-accuracy` (1 test)        | `1792700000000-AddUserCoreUserId.ts` belum tercatat di `docs/05`                                          | **Diperbaiki**: satu baris di pohon migrasi                                                   |
| `openapi:check` (3 hunk)               | `coreUserId` ada di DTO tetapi `openapi.json` belum diperbarui                                            | **Selesai di sisi pekerjaan SSO**: snapshot diekspor ulang; gate kini exit 0                  |
| `swagger.config` PUBLIC_PATHS (1 test) | `@Public()` pada `sso-handoff.controller.ts` belum diakui di `EXPECTED_PUBLIC_CONTROLLERS`/`PUBLIC_PATHS` | **Tidak diperbaiki** — menandai rute publik adalah pengakuan keamanan milik pemilik fitur SSO |

Tidak satu pun dari keempat baris di atas berasal dari perubahan siklus ini. Dua yang mekanis dan tidak menyentuh postur keamanan diselesaikan agar gate repo tidak merah, satu diselesaikan oleh pekerjaan SSO sendiri, dan satu tetap terbuka karena menuntut pengakuan keamanan yang bukan milik siklus ini.

Satu hal yang perlu dinyatakan terang: **satu-satunya gate yang masih merah setelah seluruh pengukuran adalah `swagger.config.spec.ts`**, dan itu bukan pekerjaan approval. Perbaikannya satu baris di `EXPECTED_PUBLIC_CONTROLLERS` dan satu di `PUBLIC_PATHS` (`GET` dan `POST /api/sso/handoff`).

---

## 6. Dependensi yang harus diselesaikan ALIM Core

| #   | Dependensi                                                     | Menahan apa                           |
| --- | -------------------------------------------------------------- | ------------------------------------- |
| 1   | Konfirmasi validasi `Idempotency-Key`                          | Tidak menahan; Connect sudah mengirim |
| 2   | Konfirmasi `X-ALIM-API-Version`                                | Tidak menahan; dapat dikosongkan      |
| 3   | Penerbitan credential layanan (ingest + command) dan rotasinya | **Menahan** uji staging               |
| 4   | Jaminan hanya pemetaan aktif+terverifikasi yang mewakili aktor | **Menahan** uji otorisasi staging     |
| 5   | Endpoint unit/asrama untuk scoping `VIEWER`                    | Menahan penutupan risiko lintas unit  |
| 6   | Endpoint command aktif di staging                              | **Menahan** seluruh uji staging       |

---

## 7. Prosedur verifikasi pooler

Dijalankan pada lingkungan yang memakai pooler (Supabase, PgBouncer, RDS Proxy):

1. `DATABASE_TYPE=postgres npm run test:pg-approval` — memastikan migrasi dan worker berjalan di dialect nyata.
2. `DATABASE_TYPE=postgres npx jest src/database/postgres-utc-pool.pg.spec.ts --runInBand` — memastikan setiap koneksi pool terpin UTC.
3. Boot aplikasi dengan `DATABASE_TYPE=postgres`; `assertDataConnectionUtc` gagal boot bila sesi tidak UTC, dengan pesan yang menyebut zona efektifnya.

Yang perlu diperhatikan:

- **Session mode** (umumnya port 5432): `SET TIME ZONE 'UTC'` berlaku selama klien terikat ke backend. Ini mode yang diuji di sini.
- **Transaction mode** (umumnya port 6543): pooler dapat memindahkan klien antar backend di antara transaksi, sehingga `SET` bisa hilang. Gejalanya: sebagian query menulis `DEFAULT now()` pada zona server. Deteksi: jalankan langkah 2; bila ada koneksi yang bukan UTC, boot juga akan menolak.
- Pooler yang membuang parameter startup: pin tidak memakai `options`, melainkan statement, sehingga tetap berlaku.

---

## 8. File yang berubah

| Berkas                                                               | Status | Perubahan                                     |
| -------------------------------------------------------------------- | ------ | --------------------------------------------- |
| `src/database/migrations/1792600000000-AddApprovalLookupIndexes.ts`  | baru   | Dua indeks lookup dengan penjaga idempotensi  |
| `src/modules/approval/approval-lookup-index.spec.ts`                 | baru   | 3 test: rencana query + migrasi dapat diulang |
| `src/database/postgres-utc-pool.pg.spec.ts`                          | baru   | 2 test: pin UTC pada setiap koneksi pool      |
| `scripts/approval-lookup-bench.ts`                                   | baru   | Benchmark before/after                        |
| `scripts/approval-retention-report.js`                               | baru   | Laporan retensi hanya baca                    |
| `docs/integration/alim-connect-core-integration-contract.md`         | baru   | Kontrak untuk Core                            |
| `docs/integration/alim-connect-pdca-cycle-2.md`                      | baru   | Dokumen ini                                   |
| `src/database/migrations/1792500000000-AddApprovalCommandRetry.ts`   | diubah | Guard `getTable().indices`                    |
| `src/modules/approval/entities/approval-request.entity.ts`           | diubah | Dua `@Index` baru                             |
| `src/modules/approval/core-client/http-alim-core-approval.client.ts` | diubah | `Idempotency-Key`, `X-ALIM-API-Version`       |
| `src/config/configuration.ts`                                        | diubah | `connect.approval.apiVersion`                 |
| `src/modules/approval/approval-retry.pg.spec.ts`                     | diubah | Migrasi ketiga + test indeks                  |
| `test/approval-http.e2e-spec.ts`                                     | diubah | Test VIEWER + header kontrak                  |
| `test/contracts/alim-core/approval-command.openapi.yaml`             | diubah | Dua header dideklarasikan                     |
| `test/contracts/alim-core/approval-command.spec.ts`                  | diubah | 2 test header                                 |
| `test/contracts/alim-core/approval-command.mock.ts`                  | diubah | Merekam header                                |
| `package.json`                                                       | diubah | `bench:approval`, `retention:approval`        |
| `.env.example`                                                       | diubah | `ALIM_CORE_API_VERSION` didokumentasikan      |
| `docker-compose.yml`, `docker-compose.dev.yml`                       | diubah | Forward `ALIM_CORE_API_VERSION`               |
| `.github/workflows/ci.yml`                                           | diubah | Spec pooler masuk lane PostgreSQL             |
| `.github/workflows/release.yml`                                      | diubah | Spec pooler masuk lane PostgreSQL             |
| `docs/05-database-design.md`                                         | diubah | Migrasi baru tercatat di pohon migrasi        |
| `docs/integration/alim-connect-todo-reconciliation.md`               | diubah | Status gate, risiko, dan kesiapan             |
| `docs/README.md`                                                     | diubah | Dua entri indeks                              |

Checkpoint tetap: `b3c4fa9f9` dan `8c6c92510`. `LAPORAN-FASE-3-2026-11-20.md` dan `OpenWA/.keep` tidak tersentuh.

---

## 9. Keputusan yang masih dibutuhkan pemilik sistem

1. Masa retensi data approval, dan siapa yang berwenang menjalankan penghapusan.
2. Apakah `coreResponseBody` disimpan mentah atau diganti ringkasan (kode + pesan tersanitasi).
3. Apakah `VIEWER` dibatasi per asrama/unit, dan unit mana yang menjadi batas.
4. Apakah migrasi `1792500000000` yang sudah tercatat boleh diubah (sudah dilakukan, dengan alasan di §3.2), atau harus dibekukan dan diperbaiki lewat migrasi baru.
5. Kewenangan command vs policy web (`docs/36` §6.1).

---

## 10. Rekomendasi PDCA Siklus 3

Urutan menurut dependensi; pekerjaan yang tidak menunggu siapa pun lebih dulu.

1. **Siapkan harness staging yang dapat dijalankan** — konfigurasi environment staging, prosedur penukaran credential, dan skrip yang menjalankan tujuh skenario `docs/36` §7.7. Tanpa Core aktif, ini pekerjaan Connect yang tersisa satu-satunya.
2. **Scoping `VIEWER`** — begitu Core menyediakan unit, tambahkan kolom/relasi unit, filter di `list`/`get`, dan ganti test "batas yang diketahui" dengan test negatif lintas unit. Gate `permission-coverage` tidak boleh berubah (tanpa rute baru).
3. **Retensi** — setelah masa ditetapkan, implementasikan job penghapusan berbasis keranjang umur dari `scripts/approval-retention-report.js`, dengan audit setiap penghapusan.
4. **Soak test** — jalankan worker retry dan metrik pada beban nyata; ukur `openwa_approval_command_transitions_total{status="failed"}`.
5. **Aktivasi bertahap** — hanya setelah staging, retensi, scoping, dan soak selesai.
6. **Di luar approval: selesaikan pekerjaan SSO yang belum di-commit** — akui `@Public()` pada `/api/sso/handoff` di `EXPECTED_PUBLIC_CONTROLLERS` dan `PUBLIC_PATHS`, rapikan delapan error `tsc`, lalu jalankan `npm run openapi:export`. Ketiganya gate repo yang hari ini merah karena fitur itu, bukan karena approval.

Tidak disarankan untuk Siklus 3: menambah endpoint baru, mengubah RBAC, atau menurunkan ambang cakupan.

---

## Lampiran — perintah yang dijalankan

```
npm run bench:approval
BENCH_WITH_INDEXES=0 npm run bench:approval
BENCH_ROWS=50000 npm run bench:approval
npx jest src/modules/approval/approval-lookup-index.spec.ts
npm run retention:approval
DATABASE_TYPE=postgres npx jest src/database/postgres-utc-pool.pg.spec.ts --runInBand
DATABASE_TYPE=postgres npx jest src/modules/approval/approval-retry.pg.spec.ts --runInBand
npm run test:contracts
npx jest src/modules/approval/core-client
npx jest --config test/jest-e2e.json test/approval-http.e2e-spec.ts

# Gate verifikasi (§4)
npm run build
NODE_OPTIONS=--max-old-space-size=6144 npm run lint
npx tsc --noEmit
npm run test:docs
npm run openapi:check
npm test
npx jest --runInBand <sebelas suite timeout>   # 226/226 dalam 3,8 s
```

Catatan lingkungan: `.env` tidak dimuat otomatis oleh Jest, jadi suite PostgreSQL membaca variabel dari shell. Ekspor dulu `DATABASE_*` (dan `ALIM_*`) dari `.env` sebelum menjalankannya; `npm run test:pg-approval` hanya memeriksa `DATABASE_TYPE` di process env.
