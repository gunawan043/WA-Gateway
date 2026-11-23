# PDCA Siklus 1 — E2E HTTP Approval dengan Mock Core

**Tanggal:** 2026-11-22
**Repository:** `/Users/wawangunawan/OpenWA`
**Branch:** `feature/whatsapp-approval-finalization`
**HEAD:** `8c6c92510` (Batch 2)
**Lingkup:** ALIM Connect saja. Tidak ada perubahan ALIM Core, RBAC, migrasi, credential, atau konfigurasi produksi.
**Sifat:** siklus PDCA tertutup dengan bukti eksekusi. Tidak ada commit, push, merge, deploy, atau aktivasi fitur.

---

## 1. Ringkasan

Target siklus ini adalah membuktikan bahwa alur approval bekerja melalui **HTTP sungguhan** dengan Core tiruan yang berdiri tepat di batas HTTP — bukan dengan memanggil controller langsung dan bukan dengan mengganti `ApprovalService`.

Hasilnya: satu suite e2e baru berisi **18 test, 18 lulus**, mencakup alur normal, keamanan, reliability, dan observability. Lane e2e penuh lulus **380 test** (21 dilewati), dan seluruh gate lain yang dijalankan pada siklus ini lulus.

Selama pengerjaan ditemukan **enam kegagalan**, semuanya di harness test (pemuatan modul, token metrik, bentuk helper, cache render, penamaan variabel, dan lint). **Tidak ada bug produksi yang ditemukan**, sehingga tidak ada perubahan pada `src/`. Itu bukan klaim bahwa produksi bebas bug — hanya bahwa jalur yang diuji berperilaku sesuai kontrak tanpa perlu diperbaiki.

---

## 2. PLAN — target dan batas

### 2.1 Yang harus dibuktikan

| Area                     | Target                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Ingest                   | Permohonan masuk lewat `POST /api/approval/requests` dan tersimpan                              |
| Autentikasi ingest       | Kredensial layanan wajib; salah atau tidak ada harus ditolak                                    |
| DTO dan identitas aktor  | Body divalidasi sebelum menyimpan; identitas dipetakan lewat endpoint nyata                     |
| Persistensi              | Request, command, dan riwayat tersimpan pada database test yang terisolasi                      |
| Pemrosesan command       | Balasan WhatsApp memicu command lewat rantai hook nyata                                         |
| HTTP ke mock Core        | Klien HTTP asli mengirim request nyata ke server loopback                                       |
| Sukses dan penolakan     | `applied` menjadi `APPROVED`; penolakan Core menjadi `REJECTED` dengan pesan tersamarkan        |
| Idempotensi dan duplikat | Pesan yang sama tidak membuat keputusan kedua; `duplicate` dari Core diterima sebagai hasil sah |
| Timeout dan kegagalan    | Timeout tidak pernah menghasilkan `APPROVED`; kegagalan dapat dipulihkan retry                  |
| Status akhir dan riwayat | Status permohonan dan status command konsisten dan dapat dibaca lewat `include=commands`        |
| Notifikasi dan metrik    | Metrik mengikuti transisi aktual, tanpa hitung ganda, tanpa PII                                 |
| Keamanan response        | Tidak ada body mentah Core, id pesan WhatsApp, kredensial, atau topologi sesi yang bocor        |

### 2.2 Batas yang ditetapkan sebelum menulis kode

- Mock Core berada di **batas HTTP**, bukan pengganti `ApprovalService` atau logika bisnis.
- Controller tidak dipanggil langsung; semua permintaan lewat HTTP.
- Klien HTTP dan DI yang dipakai adalah yang asli.
- Database test terisolasi; tidak menyentuh data pengembangan.
- Mock tidak boleh dapat menggantikan Core di produksi.
- Tidak mengubah perilaku produksi agar test lebih mudah.
- Tidak membuat mock yang selalu berhasil.

---

## 3. DO — yang dibangun

### 3.1 Berkas baru

`test/approval-http.e2e-spec.ts` — 741 baris, 18 test dalam empat kelompok.

### 3.2 Bentuk mock Core

Mock adalah `http.createServer` yang mendengarkan di `127.0.0.1` pada port acak (`listen(0)`), sehingga tidak ada port tetap yang bisa bentrok. Setiap panggilan dicatat sebagai `{ path, method, headers, body }`, lalu dijawab oleh `responder` yang dapat diganti per test. `responder` dapat mengembalikan `delayMs`, dan pengiriman balasan memeriksa `res.writableEnded`/`res.destroyed` agar permintaan yang sudah dibatalkan klien (timeout) tidak menimbulkan error tulis.

Karena mock adalah server HTTP sungguhan, yang dieksekusi adalah `fetch` asli, `AbortController` asli, penyusunan body snake_case, dan pemetaan envelope — bukan stub method.

### 3.3 Modul aplikasi dan DI

`AppModule` dimuat dengan `require` di dalam `beforeAll`, **setelah** variabel lingkungan Core final. Ini penting karena `ConfigModule.forRoot` memanggil factory `configuration.ts` saat modul dievaluasi; `import` di puncak berkas akan membaca `process.env` sebelum nilai test terpasang. `require` juga mempertahankan registry modul, sehingga patch loopback dari `test/setup-e2e.ts` tetap berlaku (berbeda dari `jest.isolateModules`, yang memuat ulang `@nestjs/core`).

Yang diambil dari container adalah objek produksi: `AuthService`, `HookManager`, `ApprovalRetryService`, repository `ApprovalCommand`, dan `MetricsService`. API key admin, viewer, dan dua key berbatas sesi dibuat lewat `AuthService.createApiKey`. Pemetaan identitas dibuat lewat `POST /api/approval/identities`, bukan penyisipan baris langsung, sehingga audit dan aturan verifikasi ikut teruji.

### 3.4 Kebersihan state

`beforeEach` mengembalikan mock ke perilaku default dan menutup command `UNKNOWN`/`PENDING` yang ditinggalkan test sebelumnya menjadi `FAILED`, agar pass retry berikutnya tidak mengklaim baris lama. Ini pembersihan state test, bukan perubahan perilaku produksi.

Metrik dibaca dengan mengosongkan `cachedRender` lebih dulu, karena `MetricsService.render()` menyajikan string cache selama `METRICS_RENDER_TTL_MS`; tanpa itu delta selalu nol.

### 3.5 Cakupan per kelompok

| Kelompok         | Test | Isi                                                                                                                                                                                                                                              |
| ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Alur normal   | 3    | Ingest → hook → command ke mock → `APPROVED`; allowlist 16 field tanpa body Core/id pesan; penolakan Core → `REJECTED` + `lastError` tersamarkan                                                                                                 |
| B. Keamanan      | 6    | Ingest `401` tanpa/salah kredensial + delta metrik; `401` tanpa API key dan `403` VIEWER; `403` key sesi pada GET dan ingest; DTO `400` tanpa baris tersimpan; nomor invalid `400` + metrik `invalid`; klien asli dan penolakan mock di produksi |
| C. Reliability   | 6    | Pesan sama → satu command; timeout → `UNKNOWN`/`504`, bukan `APPROVED`; retry memakai `commandId` sama lalu pulih; `duplicate` sah; percobaan habis → `FAILED` tanpa mengubah permohonan; `PENDING` yatim dipulihkan setelah lease               |
| D. Observability | 3    | Delta metrik = jumlah transisi tanpa hitung ganda; notifikasi `skipped` tanpa `failed`; label hanya dari himpunan tetap, tanpa PII                                                                                                               |

### 3.6 Mock tidak dapat menggantikan Core di produksi

Test B6 memeriksa dua hal: klien yang terpasang adalah `HttpAlimCoreApprovalClient`, dan `assertApprovalCoreClientAllowed({ coreClient: 'mock', ... }, 'production')` melempar error. Jadi mock hanya hidup di lane test, dan kebijakan produksi menolaknya secara eksplisit.

---

## 4. CHECK — hasil aktual

### 4.1 Gate

| Pemeriksaan                                                           | Hasil                                                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                                       | **lulus**                                                                                                         |
| `npm run lint` (`NODE_OPTIONS=--max-old-space-size=6144`)             | **lulus**, tanpa error                                                                                            |
| `npx tsc --noEmit`                                                    | 6 error **pre-existing** di spec `users/campaign/crm/inbox`; tidak ada di approval dan tidak tersentuh siklus ini |
| `npx jest src/modules/approval`                                       | 170 lulus, 8 dilewati                                                                                             |
| `npx jest --config test/jest-e2e.json test/approval-http.e2e-spec.ts` | **18 lulus, 18 total**                                                                                            |
| `npm run test:e2e` (lane penuh)                                       | 35 suite lulus, 4 dilewati; 380 test lulus, 21 dilewati, 401 total                                                |
| `npm run test:contracts`                                              | 84 lulus                                                                                                          |
| `npm run test:pg-approval` (PostgreSQL nyata)                         | 8/8 lulus                                                                                                         |
| `npm run openapi:check`                                               | lulus (201 path, snapshot identik)                                                                                |
| `npm run test:docs`                                                   | 967 lulus / 39 suite                                                                                              |
| `npm run test:cov`                                                    | 21.065/21.214 lulus; 11 timeout karena beban → `--onlyFailures` 401/401 lulus; cakupan di §4.2                    |

Catatan `tsc --noEmit`: repository ini tidak memiliki skrip `typecheck`; gate kompilasinya adalah `nest build`, yang memakai `tsconfig.build.json` dan tidak menyertakan berkas spec. Enam error itu berada di berkas yang tidak diubah pada siklus ini dan karena itu bukan regresi.

### 4.2 Cakupan dan suite penuh

`npm run test:cov` menjalankan seluruh suite unit sekaligus mengukur cakupan, jadi satu eksekusi menjawab dua gate: suite penuh dan ambang cakupan.

| Cakupan                 | Statement | Branch | Function | Line   | Ambang (stmt/br/fn/line) |
| ----------------------- | --------- | ------ | -------- | ------ | ------------------------ |
| Global                  | 94,41%    | 86,16% | 91,28%   | 98,59% | 77 / 66 / 80 / 77        |
| `src/modules/approval/` | 93,80%    | 79,92% | 91,51%   | 99,91% | 86 / 72 / 85 / 86        |

Seluruh ambang terlampaui. Angka dihitung dari `coverage/coverage-final.json` yang ditulis Jest pada eksekusi yang sama, lalu dibandingkan dengan `coverageThreshold` di `package.json`. Eksekusi itu keluar non-nol karena 11 timeout di bawah, bukan karena ambang cakupan.

Hasil suite penuh pada eksekusi itu: **21.214 test** — 21.065 lulus, 11 gagal, 138 dilewati; 838 suite lulus, 9 gagal, 13 dilewati. Kesebelas kegagalan adalah timeout 5 detik bawaan di bawah beban paralel (suite `queue/worker-shutdown`, `webhook/webhook-redrive`, `engine/adapters/baileys-quote-on-receipt`, dan enam lainnya), bukan assertion yang salah. Dijalankan ulang dengan `npx jest --onlyFailures`: **401/401 lulus di 9 suite**. Pola ini sama dengan audit sebelumnya (15 timeout, semuanya lulus saat diulang) dan tidak berkaitan dengan berkas yang diubah pada siklus ini.

### 4.3 Kegagalan yang ditemukan selama siklus

| #   | Gejala                                                                    | Akar masalah                                                                                  | Perbaikan                                                                |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | `A dynamic import callback was invoked without --experimental-vm-modules` | `await import('../src/app.module')` di lane jest e2e tidak diizinkan tanpa flag VM            | Muat `AppModule` dengan `require` di dalam `beforeAll` setelah env final |
| 2   | `GET /api/metrics` mengembalikan `404`                                    | Endpoint metrik mati bila `METRICS_TOKEN` tidak diset                                         | Set token di module scope dan kirim `Authorization: Bearer`              |
| 3   | `ingest(...).expect is not a function`                                    | Helper `ingest` dideklarasikan `async`, sehingga mengembalikan Promise, bukan `Test`          | Jadikan sinkron dan kembalikan `Test` agar bisa dirantai                 |
| 4   | Delta metrik selalu 0                                                     | `MetricsService.render()` menyajikan cache selama TTL                                         | Kosongkan `cachedRender` di helper `metrics()`                           |
| 5   | `TypeError: request is not a function`                                    | Variabel lokal `const request = ingested.body` menutupi import supertest                      | Impor sebagai `supertest` dan tulis ulang pemanggilan                    |
| 6   | 8 error eslint                                                            | Satu `no-useless-assignment` pada inisialisasi `body` mock, tujuh pelanggaran format prettier | Hapus inisialisasi berlebih, jalankan prettier, lint ulang bersih        |

Semua kegagalan berada di harness. Tidak ada yang menuntut perubahan `src/`.

### 4.4 Test yang dilewati

8 test approval yang dilewati adalah spec PostgreSQL yang `describe.skip` tanpa `DATABASE_TYPE=postgres`; dijalankan terpisah terhadap PostgreSQL nyata dan lulus 8/8. 21 test e2e yang dilewati adalah suite yang memang bergantung pada engine atau sesi WhatsApp nyata. Tidak ada test yang dilewati karena siklus ini.

---

## 5. ACT — tindakan dan dampak

### 5.1 Tindakan atas kegagalan

Setiap kegagalan di §4.3 diperbaiki di sumbernya, bukan dengan melonggarkan assertion. Dua perbaikan menghasilkan aturan yang sekarang dikomentari di kode agar tidak terulang: urutan env-sebelum-`require` (`approval-http.e2e-spec.ts:187-194`) dan alasan `cachedRender` harus dikosongkan sebelum membaca metrik.

Tidak ada bug produksi, jadi tidak ada perbaikan produksi dan tidak ada regresi baru di luar suite itu sendiri. Suite itu **adalah** regresi untuk perilaku yang sebelumnya hanya diuji di tingkat unit.

### 5.2 Temuan yang ditutup

1. **Tahap 1 roadmap selesai.** Sebelumnya kesiapan integrasi menyebut "tidak ada test yang memanggil Core melalui HTTP". Kini seluruh jalur HTTP Connect→Core diuji, termasuk `fetch`, abort, envelope, dan retry.
2. **Kriteria penerimaan Tahap 1 terpenuhi seluruhnya**, ditambah timeout, duplikasi, pemulihan lease, metrik, dan penjagaan mock di produksi.
3. **Sanitasi `lastError` terbukti lewat HTTP**, bukan hanya di unit test DTO: pesan penolakan Core keluar tanpa URL, email, nomor telepon, atau pasangan kredensial.

### 5.3 Temuan yang tetap terbuka

| Temuan                                                      | Status | Alasan                                                            |
| ----------------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| E2E terhadap Core sungguhan                                 | Belum  | Butuh endpoint aktif dan kredensial staging dari Core             |
| Kontrak `provisional` (Idempotency-Key, X-ALIM-API-Version) | Belum  | Menunggu konfirmasi Core                                          |
| Retensi data pribadi                                        | Belum  | Keputusan pemilik sistem                                          |
| Scoping `VIEWER` per unit                                   | Belum  | Keputusan pemilik; butuh endpoint organisasi Core bila dipilih    |
| `hasIndex` pada migrasi retry yang sudah ter-commit         | Belum  | Perubahan migrasi ter-commit butuh persetujuan; bukan temuan baru |
| Pengukuran before/after PXP                                 | Belum  | Butuh artefak pengukuran; dijadwalkan terpisah                    |
| Lima kegagalan test Core yang pre-existing                  | Belum  | Milik Core; tidak dapat diperbaiki dari repository ini            |

### 5.4 Dampak terhadap kesiapan

| Aspek                 | Sebelum siklus                  | Sesudah siklus                                                         |
| --------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| Internal ALIM Connect | Siap review internal            | Siap review internal, dengan bukti HTTP yang dapat dijalankan ulang    |
| Integrasi dengan Core | Belum siap; tidak ada test HTTP | Belum siap untuk Core nyata; jalur Connect→Core terbukti terhadap mock |
| Pengujian staging     | Belum dapat dimulai             | Belum dapat dimulai; urutan tujuh skenario tetap menunggu Core         |
| Produksi              | Belum siap                      | Belum siap; retensi, scoping, staging, dan soak masih terbuka          |

Tidak ada klaim kesiapan produksi dalam dokumen ini. Mock membuktikan sisi Connect, bukan perilaku Core.

---

## 6. Dependensi Core yang tersisa

1. Konfirmasi apakah `Idempotency-Key` HTTP ditambahkan di samping `command_id`.
2. Konfirmasi apakah `X-ALIM-API-Version` dipasang pada endpoint command.
3. Mekanisme kredensial layanan untuk ingest dan command, beserta prosedur rotasi.
4. Jaminan bahwa hanya pemetaan WhatsApp aktif dan terverifikasi yang mewakili aktor, dan pencabutan pemetaan mencabut kewenangan.
5. Ketersediaan endpoint organisasi bila scoping per unit dipilih.
6. Jadwal endpoint command aktif di staging dan penerbitan kredensial staging.

---

## 7. File yang berubah dan statistik

| Berkas                                                 | Status     | Perubahan                                     |
| ------------------------------------------------------ | ---------- | --------------------------------------------- |
| `test/approval-http.e2e-spec.ts`                       | baru       | 741 baris, 18 test                            |
| `docs/integration/alim-connect-pdca-cycle-1.md`        | baru       | dokumen ini                                   |
| `docs/integration/alim-connect-todo-reconciliation.md` | diperbarui | §4.11, ringkasan eksekutif, kesiapan, Tahap 1 |
| `docs/README.md`                                       | diperbarui | satu baris di tabel Integration audits        |
| `src/**`                                               | tidak      | tidak ada perubahan                           |

Checkpoint tetap: `b3c4fa9f9` (Batch 1) dan `8c6c92510` (Batch 2). Berkas yang dikecualikan tetap tidak tersentuh: `LAPORAN-FASE-3-2026-11-20.md` dan `OpenWA/.keep`.

---

## 8. Yang tidak dilakukan

- Tidak ada commit, push, merge, deploy, atau aktivasi fitur.
- Tidak ada perubahan RBAC, gate 191, atau perilaku produksi.
- Tidak ada perubahan skema, migrasi, atau database.
- Tidak ada perubahan repository ALIM Core.
- Tidak ada penerbitan atau perubahan credential.
- Tidak ada keputusan retensi atau scoping.
- Tidak ada perbaikan `hasIndex` pada migrasi yang sudah ter-commit.
- Tidak ada penyederhanaan PXP.

---

## Lampiran — perintah yang dijalankan

```
npx jest --config test/jest-e2e.json test/approval-http.e2e-spec.ts
npm run test:e2e
npm run build
NODE_OPTIONS=--max-old-space-size=6144 npm run lint
npx tsc --noEmit
npx jest src/modules/approval
npm run test:contracts
npm run openapi:check
npm run test:docs
DATABASE_TYPE=postgres node_modules/.bin/dotenv run -q -f .env -- npx jest src/modules/approval/approval-retry.pg.spec.ts
npm run test:cov
npx eslint test/approval-http.e2e-spec.ts
npx prettier --write test/approval-http.e2e-spec.ts
```
