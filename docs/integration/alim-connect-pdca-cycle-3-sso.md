# PDCA Siklus 3 — WhatsApp Connect SSO Handoff

**Tanggal:** 2026-11-23
**Repository:** `/Users/wawangunawan/OpenWA` (ALIM Connect)
**Branch:** `feature/whatsapp-approval-finalization`
**Lingkup:** ALIM Connect saja. Tidak ada perubahan pada repository ALIM Core.
**Sifat:** siklus PDCA dengan hasil eksekusi. Checkpoint lokal `12edf8f37` (parent `8c6c92510`)
memuat seluruh pekerjaan SSO siklus ini. Tidak ada push, merge, deploy, perubahan credential
produksi, atau aktivasi integrasi produksi.

---

## 1. Ringkasan

Target siklus ini: membuktikan bahwa pengguna yang memiliki akses di ALIM Core dapat masuk ke
workspace WhatsApp Connect melalui handoff yang aman — tanpa berbagi cookie session, tanpa SSO key
di browser, dan tanpa melemahkan RBAC masing-masing aplikasi.

Hasil:

- **Implementasi selesai** di Connect: endpoint penerimaan handoff, klien exchange Core, pemetaan
  `core_user_id`, session Connect, CSP `frame-ancestors`, halaman loading/sukses/gagal, dan
  konfigurasi environment.
- **SSO:** 55 unit test (4 suite) + 22 test allowlist OpenAPI + **23 HTTP e2e test** lulus.
- **Browser test nyata dijalankan di Chrome 157.0.8103.80: 12/12 skenario lulus** (iframe lintas
  origin, form POST, `sessionStorage`, reload, logout, expired, used, akses langsung, CSP origin
  asing, idle expiry, tanpa cookie). Safari diblokir karena _Allow remote automation_ mati; Firefox
  tidak terpasang — keduanya dicatat belum teruji (§4.5).
- **Kesiapan approval:** 179 unit test (19 suite), 19 HTTP e2e, dan 86 contract test lulus;
  `Idempotency-Key` dan `X-ALIM-API-Version` terbukti terkirim di batas HTTP.
- **Stabilisasi teknis:** `npx tsc --noEmit` **0 error** (sebelumnya 6); drift `Division.sessionId`
  diperbaiki di 9 kolom join dan 4 migrasi; soak retry 5.000 command lulus; `coreResponseBody`
  dibatasi 16 KB; gate PostgreSQL (approval 9/9, UTC 12/12, pool 2/2) lulus.
- **Build, lint, OpenAPI (202 path), dan 968 test dokumentasi lulus.**

Tidak ada blocker yang menghalangi pekerjaan Connect. Blocker yang tersisa berada di sisi Core
(kredensial staging dan dua ketidaksesuaian kontrak) dan di lingkungan (Safari/Firefox).

---

## 2. PLAN — validasi kontrak dan kesiapan Connect

### 2.1 Yang diperiksa

| Area                             | Temuan                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Struktur NestJS, routing, prefix | Prefix global `/api`. Semua rute berada di bawahnya; tidak ada middleware CSRF.                                                                        |
| Autentikasi dan session          | Session dashboard = token opaque `owa_s1_…` di `sessionStorage`, dikirim di header `X-API-Key`. Tidak ada cookie.                                      |
| Pemetaan identitas eksternal     | Belum ada kolom `core_user_id`; `whatsapp_identities` hanya untuk approval dan tidak dapat dipakai ulang.                                              |
| Logout dan expiry                | `POST /api/auth/logout` mencabut baris `user_sessions`; expiry absolut sudah ada; idle timeout belum ada.                                              |
| Cookie dan reverse proxy         | Tidak ada cookie session. `TRUSTED_PROXIES` sudah dipakai untuk IP klien.                                                                              |
| HTTP client                      | Pola `HttpAlimCoreApprovalClient` tersedia: `fetch`, timeout, envelope, tanpa retry untuk 4xx.                                                         |
| CSP dan origin Core              | Helmet global; `frame-ancestors` belum dikonfigurasi dan `X-Frame-Options: SAMEORIGIN` akan memblokir embed.                                           |
| Kontrak Core                     | Diambil dari instruksi siklus ini; dokumen `docs/integration/alim-core-whatsapp-connect-implementation.md` **tidak ada** di repository Connect (§5.1). |

### 2.2 Keputusan teknis

1. **Browser menerima halaman HTML dari Connect, bukan JSON.** Form POST adalah navigasi, dan token
   tidak boleh masuk URL. Halaman sukses menulis token ke `sessionStorage` lalu
   `location.replace('/')`. Ini memakai mekanisme autentikasi yang sudah ada tanpa menambah cookie.
2. **Tidak ada cookie session baru.** Cookie di iframe pihak ketiga akan gagal di Safari dan
   memaksa `SameSite=None`, sementara aplikasi ini tidak punya CSRF middleware. Menambah cookie
   berarti menambah kelas serangan baru.
3. **Alias `/sso/handoff` → `/api/sso/handoff`.** Kontrak browser menyebut `/sso/handoff`; rute Nest
   dan OpenAPI tetap `/api/...`. Rewrite dilakukan sebelum routing, sehingga satu handler dan semua
   guard berjalan sekali.
4. **`coreUserId` sebagai kolom unik nullable.** Bukan tabel baru, bukan pencocokan email. Akun
   tidak pernah dibuat otomatis.
5. **Tidak ada mock exchange.** Berbeda dari approval, mock exchange akan membuat session nyata
   tanpa Core. Tanpa konfigurasi, endpoint menjawab `503`.
6. **Idle timeout global, bukan per-jenis session.** `user_sessions` tidak menyimpan asal session;
   menambah kolom hanya untuk SSO akan memperluas skema tanpa manfaat. Default 0 (nonaktif), dan
   dokumentasi menetapkan nilainya untuk deployment SSO.

---

## 3. DO — yang dibangun

### 3.1 Berkas baru

| Berkas                                                                               | Isi                                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `src/config/core-web-origin.ts`                                                      | Parsing origin Core, `frame-ancestors`, allowlist Origin   |
| `src/modules/sso/core-client/alim-core-sso.client.ts`                                | Interface, hasil exchange, taksonomi kegagalan             |
| `src/modules/sso/core-client/http-alim-core-sso.client.ts`                           | Klien HTTP nyata: timeout, tanpa retry, tanpa log rahasia  |
| `src/modules/sso/sso-handoff.service.ts`                                             | Exchange → mapping → session, dalam urutan yang aman       |
| `src/modules/sso/sso-handoff.controller.ts`                                          | `GET`/`POST /api/sso/handoff`, Origin, throttle, HTML/JSON |
| `src/modules/sso/sso-pages.ts`                                                       | Halaman loading, sukses, dan setiap kondisi gagal          |
| `src/modules/sso/dto/sso-handoff.dto.ts`                                             | DTO `code`/`state`                                         |
| `src/modules/sso/sso.module.ts`                                                      | Wiring modul                                               |
| `src/database/migrations-main/1792700000000-AddUserCoreUserId.ts`                    | Kolom `users.coreUserId` + indeks unik                     |
| `scripts/sso-browser-harness.js`                                                     | Harness Core + halaman embed untuk browser test            |
| `scripts/sso-browser-test.js`                                                        | Driver puppeteer: 12 asersi browser nyata untuk lembar §6  |
| `test/sso-handoff-http.e2e-spec.ts`                                                  | 23 test HTTP dengan Core palsu di batas HTTP               |
| `src/modules/sso/**/*.spec.ts`, `src/config/core-web-origin.spec.ts`, migration spec | 55 unit test                                               |
| `docs/integration/alim-connect-whatsapp-connect-sso-contract.md`                     | Kontrak final sisi Connect                                 |
| `docs/integration/alim-connect-sso-browser-test.md`                                  | Prosedur browser test yang dapat direproduksi              |

### 3.2 Berkas yang diubah

| Berkas                                                 | Perubahan                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `src/configure-app.ts`                                 | Rewrite `/sso/handoff`, `frame-ancestors`, `frameguard` hanya saat origin Core dikonfigurasi |
| `src/config/configuration.ts`                          | Namespace `connect.sso`, `auth.sessionIdleTimeoutMinutes`                                    |
| `src/config/env-precedence.ts`                         | Key SSO + idle timeout; juga `ALIM_CORE_API_VERSION` yang sebelumnya hilang                  |
| `src/config/swagger.config.ts`                         | Tag `sso`                                                                                    |
| `src/app.module.ts`                                    | `SsoModule`                                                                                  |
| `src/modules/auth/entities/user.entity.ts`             | `coreUserId` + indeks unik                                                                   |
| `src/modules/auth/users.service.ts`                    | `findByCoreUserId`, validasi duplikat, create/update                                         |
| `src/modules/auth/dto/user.dto.ts`                     | `coreUserId` pada create/update/response                                                     |
| `src/modules/auth/auth-users.controller.ts`            | Meneruskan `coreUserId` + audit                                                              |
| `src/modules/auth/auth.module.ts`                      | Ekspor `UsersService`                                                                        |
| `src/modules/auth/session-auth.service.ts`             | TTL per-issue, idle timeout                                                                  |
| `docker-compose.yml`, `docker-compose.dev.yml`         | Forward env SSO + idle timeout                                                               |
| `.env.example`, `docs/05`, `docs/06`, `docs/README.md` | Dokumentasi konfigurasi, skema, endpoint, indeks                                             |
| `openapi.json`                                         | Diregenerasi (202 path)                                                                      |

Tidak ada perubahan pada workflow approval WhatsApp, tidak ada refactor luas, dan tidak ada
perubahan pada repository Core.

### 3.3 Alur yang diimplementasikan

```
Core page (iframe) → form POST /sso/handoff
  → Origin allowlist + throttle + DTO
  → POST Core /api/connect/v1/sso/exchange (X-ALIM-CONNECT-SSO-KEY, timeout, no retry)
  → users.coreUserId lookup (no auto-create)
  → user_sessions insert (token baru)
  → HTML sukses: sessionStorage + location.replace('/')
```

Kegagalan di titik mana pun sebelum `user_sessions insert` tidak meninggalkan session.

---

## 4. CHECK — hasil pengujian

### 4.1 Peta 16 skenario wajib

| #   | Skenario                                    | Bukti                                                                                |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Handoff valid menghasilkan session          | e2e `A. exchanges server-to-server…` — token dipakai `/api/auth/me`, 1 baris session |
| 2   | Handoff expired ditolak                     | e2e `B. expired` → `410`, halaman kedaluwarsa, 0 session                             |
| 3   | Handoff sudah digunakan ditolak             | e2e `B. already-used` → `409`, 1 session untuk dua percobaan                         |
| 4   | Code dimanipulasi ditolak                   | e2e `B. tampered` → `400`; mock menerima nilai manipulasi, bukan keputusan lokal     |
| 5   | Audience/scope tidak cocok ditolak          | e2e `B. audience or scope mismatch` + unit client                                    |
| 6   | SSO key salah ditolak Core                  | e2e `B. Core 401` → `502`, 0 session; header yang dikirim tetap key terkonfigurasi   |
| 7   | Permission dicabut                          | e2e `B. permission_revoked` → `403`, 0 session                                       |
| 8   | User Core inactive                          | e2e `B. user_inactive` → `403`, 0 session                                            |
| 9   | Identitas tidak terpetakan, tanpa akun baru | e2e `C. unmapped` → `403`; jumlah user tidak berubah                                 |
| 10  | Gangguan koneksi Core                       | e2e `C. unreachable` → `502/504`, 0 session                                          |
| 11  | SSO key dan code tidak di log               | e2e `G.` menangkap stdout/stderr; tidak ada key/code                                 |
| 12  | Session fixation dicegah                    | e2e `D. no fixation` — dua token berbeda; cookie penyerang diabaikan                 |
| 13  | Session expiry berfungsi                    | e2e `D. absolute expiry` dan `D. idle` → `401`; idle juga mencabut baris             |
| 14  | Logout mengakhiri session                   | e2e `D. logout` → `204`, lalu `/api/auth/me` `401`                                   |
| 15  | Akses langsung tanpa autentikasi ditolak    | e2e `D. direct access` → `401` pada `/api/auth/me` dan `/api/sessions`               |
| 16  | Origin iframe tidak diizinkan ditolak       | e2e `E.` — Origin asing `403` sebelum Core dipanggil; CSP tanpa wildcard             |

Concurrency: e2e `F.` mengirim dua redemption paralel untuk satu code; hasilnya tepat satu `200`,
satu `409`, dan satu session.

### 4.2 Angka aktual

Semua dijalankan ulang pada 2026-11-23 setelah perubahan siklus ini, satu proses berat pada satu
waktu (heap 2–3 GB; tidak ada 6 GB).

| Pemeriksaan                                                             | Hasil                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run build`                                                         | lulus                                                                                      |
| `npm run lint` (seluruh repo, `NODE_OPTIONS=--max-old-space-size=3072`) | lulus, 0 error. Diulang di siklus 4 setelah spec baru: 0 error                             |
| `npx tsc --noEmit` (termasuk spec)                                      | **0 error** (sebelumnya 6); diulang di siklus 4: 0 error                                   |
| `npm run openapi:check`                                                 | gagal dulu (1 hunk, `security: []` pada handoff), lalu **exit 0** setelah `openapi:export` |
| Unit SSO (`src/modules/sso`)                                            | **55 lulus / 4 suite**; 83 lulus / 5 suite setelah `sso-handoff.controller.spec.ts` (28)   |
| `src/config/swagger.config.spec.ts` (allowlist publik)                  | **22 lulus**                                                                               |
| `test/sso-handoff-http.e2e-spec.ts`                                     | **23 lulus / 1 suite**                                                                     |
| Browser test Chrome (`scripts/sso-browser-test.js`)                     | **12/12 lulus**, Chrome 157.0.8103.80                                                      |
| Unit approval (`src/modules/approval`, tanpa spec PG)                   | **179 lulus / 19 suite**                                                                   |
| `test/approval-http.e2e-spec.ts`                                        | **19 lulus / 1 suite**                                                                     |
| `npm run test:contracts`                                                | **86 lulus / 2 suite**                                                                     |
| `npm run test:pg-approval` (PostgreSQL nyata, pooler)                   | **9/9 lulus** (35,8 s)                                                                     |
| `src/database/postgres-utc.pg.spec.ts`                                  | **12/12 lulus** (94,0 s)                                                                   |
| `src/database/postgres-utc-pool.pg.spec.ts`                             | **2/2 lulus** (3,9 s)                                                                      |
| `npm run test:docs`                                                     | **968 lulus / 39 suite**                                                                   |
| `npx jest --coverage --maxWorkers=2`                                    | tabel 94,24 / 85,94 / 91,11 / 94,97; 2 timeout; **ambang Jest merah** (lihat catatan)      |
| `npx jest --maxWorkers=2` (regresi penuh)                               | 854/855 suite lulus, 21.142 test lulus, 1 timeout karena beban                             |
| Suite yang gagal dijalankan sendiri                                     | `session-proxy-large-answer` + `batched-prune` 28/28; `wwebjs-web-version-cache` 3/3       |
| `compose-parity.spec.ts`                                                | 52 lulus                                                                                   |
| `npm run format:check`                                                  | merah: utang pre-existing (lihat 4.4)                                                      |
| `openapi.json`                                                          | 202 path, `POST /api/sso/handoff` ada, `security: []`                                      |

**Catatan cakupan.** Run `--coverage` mencetak tabel 94,24/85,94/91,11/94,97 (di atas seluruh ambang
global 77/66/80/77) tetapi pemeriksaan ambang Jest melaporkan `functions 74,01% < 80%` dan dua ambang
direktori. Kedua angka memakai denominator berbeda di dalam Jest; perbedaan yang sama tereproduksi
pada satu suite dan pada checkout `HEAD` yang belum memuat siklus ini. Jadi gate cakupan **tidak
dapat dinyatakan hijau**, tetapi penyebabnya pelaporan ambang yang sudah ada, bukan penurunan
cakupan dari pekerjaan ini. Rincian: `alim-connect-todo-reconciliation.md` §4.12.

### 4.3 Temuan yang diperbaiki dalam siklus ini

1. **`ALIM_CORE_API_VERSION` hilang dari `BLANK_SHADOWED_ENV_KEYS`.** Compose mem-forward-nya, tetapi
   daftar precedence tidak memuatnya, sehingga gate `env-precedence` gagal (2 test). Diperbaiki.
2. **`sso` tidak terdaftar sebagai tag Swagger.** Gate `openapi-contract` gagal. Diperbaiki.
3. **Status `422`/`504` didokumentasikan tetapi tidak dideklarasikan.** Gate `docs-06` gagal.
   Dekorator ditambahkan dan `openapi.json` diregenerasi.
4. **`docker-compose.yml`/`.dev` tidak mem-forward env SSO.** Deploy compose tidak akan dapat
   mengaktifkan SSO. Diperbaiki.
5. **Lint/prettier pada berkas baru.** Diperbaiki dengan `eslint --fix` dan perbaikan manual.
6. **Duplikasi baris env di kedua berkas compose.** Saat blok SSO ditambahkan,
   `AUTH_SESSION_IDLE_TIMEOUT_MINUTES` dan tujuh key SSO/Core tertulis dua kali di `docker-compose.yml`
   dan `docker-compose.dev.yml`. YAML tetap valid (keduanya item list), tetapi menyesatkan dan membuat
   diff berisik. Duplikat dihapus; `compose-parity` (52 test) lulus ulang.
7. **Dua spec membangun objek `User` lengkap tanpa `coreUserId`.** Kolom baru wajib pada tipe
   entitas, sehingga `npx tsc --noEmit -p tsconfig.json` — gate CI yang ikut memeriksa berkas
   `*.spec.ts` — gagal dengan TS2322. `coreUserId: null` ditambahkan ke factory `user()` di
   `auth-users.controller.spec.ts` dan `auth-session.controller.spec.ts`; kedua suite lulus ulang.
8. **`@Public()` pada handoff tidak ada di allowlist OpenAPI.** `swagger.config.spec.ts` gagal pada
   dua tripwire (`EXPECTED_PUBLIC_CONTROLLERS` dan `PUBLIC_PATHS`). Ditambahkan dengan komentar yang
   menyatakan mengapa rute itu publik dalam arti OpenAPI (tanpa kredensial Connect) dan kontrol apa
   yang menggantikan API key (allowlist Origin, throttle, kode sekali pakai). Rute lain tidak
   kehilangan proteksi; 22/22 lulus.
9. **Enam error TypeScript pre-existing.** Diperbaiki secara tertarget tanpa refactor: tipe
   `EntityManager` pada mock `ds.transaction`, tuple `mock.calls` yang tidak bertipe di
   `campaign-runner`, dan `row as Record<string, unknown>` pada empat mock lain. `npx tsc --noEmit`
   kini 0 error, dan keempat suite terkait lulus 77/77.
10. **Drift `Division.sessionId` dan delapan kolom join lain.** Akar masalahnya bukan spec: TypeORM
    menyalin tipe primary key ke kolom join (`RelationJoinColumnBuilder`), sehingga `length` pada
    `@Column` yang juga `@JoinColumn` membuat metadata tidak valid di PostgreSQL. `length` dihapus
    dari sembilan kolom (`sessionId`, `divisionId`, `stageId`, `dealId`, `campaignId`), DDL empat
    migrasi disamakan menjadi `varchar` tanpa batas, dan snapshot drift (21 pernyataan
    `temporary_*`) diperbarui per tabel. `migration-drift.spec.ts` 2/2 lulus.
11. **`postgres-utc.pg.spec.ts` memakai daftar entity tulisan tangan.** Diganti 13 glob yang sama
    dengan `data-source.ts`, lookup repository memakai nama metadata, dan `jest.setTimeout(60_000)`
    ditambahkan — 5 detik default membatalkan export 27 detik dan meninggalkan `importInFlight`,
    yang lalu membuat tujuh test berikutnya gagal dengan `409` karena alasan yang salah. 12/12
    lulus (94 s).
12. **Snapshot OpenAPI basi setelah handoff menjadi publik.** `openapi:check` gagal dengan satu
    hunk pada `/api/sso/handoff` (`security: []`, error response tanpa `ErrorResponse`). Snapshot
    diregenerasi; pemeriksaan ulang exit 0.
13. **Tiga masalah lint pada berkas baru** (dua prettier, satu `eslint-disable` yang tidak lagi
    diperlukan). Diperbaiki; `npm run lint` seluruh repo exit 0.

### 4.4 Temuan yang tidak diperbaiki (di luar lingkup)

1. **`docs/README.md` menautkan `alim-connect-pdca-cycle-2.md` yang tidak ada.** Tautan rusak
   pre-existing; tidak diubah karena bukan bagian siklus ini.
2. **`npm run openapi:export` memakan 7–16 menit** pada boot penuh di mesin ini; pada run terakhir
   (cache hangat) 21 detik. Bukan cacat produk.
3. **`npm run format:check` sudah merah di HEAD.** `docs/04-security-design.md`,
   `docs/17-dashboard-design.md`, `docs/32-laravel-integration.md`, `docs/34-alim-connect-audit.md`,
   dan tiga dokumen `docs/integration/` dari siklus sebelumnya tidak sesuai Prettier. Diverifikasi
   dengan menjalankan Prettier pada versi `HEAD` berkas yang sama, jadi bukan akibat siklus ini.
   Dokumen baru siklus ini diformat bersih; dokumen lama tidak disentuh agar diff tetap fokus pada
   SSO.

### 4.5 Browser test nyata (Chrome lulus, Safari/Firefox belum)

`scripts/sso-browser-test.js` menjalankan dua origin sungguhan (Core mock di `localhost:4400`,
Connect di `localhost:2785`) di Chrome headless dan menguji hal-hal yang tidak dapat dibuktikan
oleh HTTP test: `frame-ancestors` yang ditegakkan browser, navigasi form POST, `sessionStorage`
dalam iframe pihak ketiga, dan `location.replace` di dalam frame.

| #   | Asersi                                                                                  | Hasil |
| --- | --------------------------------------------------------------------------------------- | ----- |
| 1   | Dokumen loading merender spinner + "Menghubungkan ke ALIM Connect…"                     | lulus |
| 2   | Workspace tampil di dalam iframe; frame berakhir di `http://localhost:2785/`            | lulus |
| 3   | Token `owa_s1_…` ada di `sessionStorage`; `document.cookie` kosong                      | lulus |
| 4   | Token dan code tidak pernah muncul di URL                                               | lulus |
| 5   | Reload **iframe** mempertahankan workspace tanpa POST `/sso/handoff` baru (1 → 1)       | lulus |
| 6   | Logout → login, dan tetap login setelah reload (token dihapus)                          | lulus |
| 7   | Handoff kedaluwarsa → "Handoff kedaluwarsa", tanpa session                              | lulus |
| 8   | Handoff sudah dipakai → "Handoff sudah dipakai"                                         | lulus |
| 9   | Akses langsung `:2785/` → login, bukan workspace                                        | lulus |
| 10  | Origin asing `:4401` diblokir `frame-ancestors`; POST langsung `403 origin_not_allowed` | lulus |
| 11  | Idle 65 s dengan `AUTH_SESSION_IDLE_TIMEOUT_MINUTES=1` → reload memaksa login           | lulus |
| 12  | Tidak ada `Set-Cookie`, tidak ada error console, tidak ada respons ≥ 400                | lulus |

Browser: **Google Chrome 157.0.8103.80** (bukan Chrome for Testing; `channel: 'chrome'` memakai
aplikasi yang terpasang). Hasil lengkap dan tabel per browser ada di
`alim-connect-sso-browser-test.md` §6.

Dua kegagalan driver ditemukan dan diperbaiki selama menjalankan tes ini — keduanya cacat tes,
bukan aplikasi:

- Reload halaman **atas** menerbitkan code baru (halaman Core selalu menerbitkan code saat dimuat),
  sehingga "session bertahan" dijawab oleh login baru. Driver sekarang me-reload iframe saja.
- Harness tidak menjawab `/favicon.ico`, dan 404 itu muncul sebagai error console. Rute `204`
  ditambahkan agar error console yang sebenarnya tidak tenggelam.

**Yang belum teruji:** Safari 26.6.2 menolak sesi `safaridriver` karena _Allow remote automation_
mati (saklar GUI / `safaridriver --enable` dengan hak admin); Firefox tidak terpasang dan puppeteer
hanya mendukung Firefox Nightly. Keduanya dicatat sebagai blocker di §5.2, bukan sebagai lulus.

### 4.6 Kesiapan integrasi approval (batas HTTP)

| Persyaratan kontrak                                         | Bukti                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Idempotency-Key` sama dengan `command_id`                  | `http-alim-core-approval.client.spec.ts:68-71`; e2e `call.headers['idempotency-key'] === body.command_id`               |
| `X-ALIM-API-Version` dikirim, dan tidak dikirim bila kosong | spec unit dua arah (`:71`, `:82-94`); `ALIM_CORE_API_VERSION` terdokumentasi di `.env.example`                          |
| Autentikasi layanan terpisah dari SSO                       | command memakai `X-ALIM-CONNECT-APPROVAL-KEY`; SSO memakai `X-ALIM-CONNECT-SSO-KEY`; tidak ada key yang dipakai bersama |
| Identitas aktor dari pemetaan, bukan tebakan                | e2e `A.` (aktor dari API key) dan unit `whatsapp-identity.security.spec.ts`                                             |
| Timeout/retry tidak menghasilkan keputusan ganda            | e2e `C.` — timeout → `UNKNOWN`/`504`, tidak pernah `APPROVED`; duplicate dari Core diterima sebagai hasil sah           |
| Pemetaan error sesuai kontrak                               | 4xx tidak di-retry, 5xx/timeout di-retry dengan `commandId` yang sama; e2e `C.`                                         |
| E2E tetap di batas HTTP                                     | `test/approval-http.e2e-spec.ts` menjalankan `AppModule` asli + `HttpAlimCoreApprovalClient` asli                       |

Tidak ada endpoint baru yang diciptakan dan tidak ada perubahan kontrak. Yang masih menunggu Core:
konfirmasi apakah Core akan memvalidasi kedua header tersebut dan ketersediaan endpoint staging.

### 4.7 Stabilisasi teknis

| Item                                           | Hasil                                                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drift `Division.sessionId` + 8 kolom join lain | diperbaiki di entity dan 4 migrasi; `postgres-utc.pg.spec.ts` 12/12, `migration-drift` 2/2                                                                                        |
| Test UTC PostgreSQL setelah perbaikan drift    | 12/12 (94 s), termasuk restore dua arah dan lease lintas restore                                                                                                                  |
| Enam error TypeScript                          | 0 error; tanpa refactor luas                                                                                                                                                      |
| Soak retry worker                              | `approval-retry.soak.spec.ts`: 400 command / 195 ms dan 5.000 command / 75 pass / 1.999 ms; semua baris terminal, tidak ada yang melewati `maxAttempts`, metrik sama dengan tabel |
| Metrik observability                           | delta metrik diuji di e2e `D.`; soak membandingkan hitungan metrik dengan isi tabel                                                                                               |
| Scoping VIEWER                                 | tetap terbuka, menunggu sumber unit organisasi dari Core (bukan pekerjaan Connect)                                                                                                |
| Retensi                                        | mekanisme `scripts/approval-retention-report.js` ada; **tidak** menghapus otomatis sebelum kebijakan disetujui                                                                    |
| Sanitisasi `coreResponseBody`                  | `core-response-body.ts` membatasi 16 KB (preview 4 KB) dan tidak pernah keluar lewat API; 4 unit test                                                                             |

Batas sumber daya: setiap gate dijalankan satu per satu dengan heap 2–3 GB pada MBP M1 8 GB. Tidak
ada assertion, ambang cakupan, atau test keamanan yang dihapus untuk menghemat waktu.

---

## 5. ACT — blocker dan kesiapan staging

### 5.1 Temuan untuk pemilik repository Core

1. **Dokumen implementasi Core tidak tersedia di repository Connect.** Instruksi menyebut
   `docs/integration/alim-core-whatsapp-connect-implementation.md`; path itu tidak ada di
   `/Users/wawangunawan/OpenWA`. Kontrak yang dipakai berasal dari instruksi siklus ini. Mohon
   dokumen aktual dibagikan agar dapat diverifikasi ulang.
2. **Bentuk respons belum final.** Instruksi menyebut field langsung; endpoint Core lain memakai
   envelope `{ success, data, errors }`. Connect menerima keduanya. Konfirmasi mana yang berlaku.
3. **`audience`/`scope` di respons.** Connect menolak nilai yang tidak cocok dan menerima respons
   yang tidak menyertakannya. Bila Core menjamin keduanya selalu ada, Connect dapat diperketat.
4. **403 tanpa `errors.code`.** Connect memetakannya ke `502 core_error`. Bila Core selalu mengirim
   `errors.code`, tidak ada perubahan yang diperlukan.

### 5.2 Blocker menuju staging

| Blocker                                               | Pemilik    | Dampak                                                           |
| ----------------------------------------------------- | ---------- | ---------------------------------------------------------------- |
| Kredensial staging `sso:exchange` belum diterbitkan   | Core       | Tanpa itu SSO menjawab `503`; jalur nyata tidak dapat dijalankan |
| Endpoint exchange belum aktif di staging              | Core       | Sama seperti di atas                                             |
| Nilai `ALIM_CORE_WEB_ORIGIN` staging belum ditetapkan | Core       | CSP dan allowlist Origin tidak dapat dikonfigurasi               |
| Konfirmasi bentuk respons dan `errors.code`           | Core       | Parsing sudah defensif, tetapi kontrak final mengurangi risiko   |
| Safari belum diuji (Remote Automation mati)           | Lingkungan | Matriks browser belum lengkap; lihat §4.5                        |
| Firefox belum diuji (tidak terpasang)                 | Lingkungan | Matriks browser belum lengkap; lihat §4.5                        |
| Dashboard dan API harus satu origin                   | Connect    | Deployment split-origin memerlukan desain handoff berbeda        |
| Core sungguhan belum pernah dihubungi                 | Core       | Mock hanya membuktikan sisi Connect                              |
| Retensi dan scoping `VIEWER` belum diputuskan         | Pemilik    | Tidak menghalangi staging SSO, tetapi menghalangi produksi       |

### 5.2.1 Kesiapan siklus 4 (2026-11-23, setelah checkpoint `12edf8f37`)

**Probe kesiapan.** `npm run probe:alim-core` (`scripts/alim-core-probe.ts`) memakai klien HTTP
sungguhan, bukan mock, sehingga satu perintah menjawab: base URL terjangkau, kunci diterima, rute
ada, dan bentuk respons sesuai. Ia tidak membuat sesi dan tidak memutuskan izin.

| Kondisi Core                          | Verdict | Arti                                           |
| ------------------------------------- | ------- | ---------------------------------------------- |
| `code_not_found`/`code_expired`/…     | PASS    | rute dan kunci diterima; Core menolak kode uji |
| `invalid_key`/`insufficient_scope`    | FAIL    | kredensial salah                               |
| `ok: true` untuk kode yang direkayasa | FAIL    | semantik sekali-pakai tidak berlaku            |
| command `applied`/`duplicate`         | FAIL    | Core menyetujui permohonan yang tidak ada      |

Hasil lokal tanpa kredensial: `ALIM_CORE_BASE_URL`, `ALIM_CONNECT_SSO_KEY`, dan
`ALIM_CORE_APPROVAL_API_KEY` **MISSING**, exit **2** ("nothing can be probed"). Artinya probe siap
dipakai tetapi **integrasi nyata belum dapat dijalankan**: semua langkah staging di §5.4 tetap
menunggu kredensial Core.

**Celah cakupan yang ditutup di siklus 4.** Pemeriksaan ambang Jest tidak lagi merah
(§4.2 siklus 4). Tiga hal yang sebelumnya hanya diuji di lane e2e sekarang juga diuji di `test:cov`:
`sso-handoff.controller.ts` 9/9 fungsi, dua controller auth tanpa spec (`auth-agents`,
`auth-assignments`), dan kontrak generik `table-importers` untuk ke-30 importer.

### 5.3 Rekomendasi

**Layak diuji di staging, dengan syarat** — bukan layak produksi.

Alasan:

- Seluruh jalur Connect yang dapat dibuktikan tanpa Core sudah dibuktikan: guard, DTO, Origin,
  throttle, exchange HTTP nyata, timeout, pemetaan, session, expiry, logout, CSP, dan tidak adanya
  session pada setiap kegagalan.
- Chrome sudah membuktikan perilaku browser terhadap Connect (12/12). Safari dan Firefox tetap
  harus dijalankan di mesin yang mengizinkannya, karena storage pihak ketiga adalah risiko nyata di
  Safari.
- Yang belum terbukti adalah perilaku Core. Itu hanya dapat dibuktikan di staging dengan kredensial
  Core.

Urutan uji staging yang disarankan:

1. Terbitkan kredensial staging dan aktifkan endpoint exchange.
2. Set `ALIM_CORE_BASE_URL`, `ALIM_CONNECT_SSO_KEY`, `ALIM_CORE_WEB_ORIGIN` di staging.
3. Petakan satu akun uji ke satu `core_user_id` staging.
4. Jalankan `alim-connect-sso-browser-test.md` pada Chrome, Safari, Firefox.
5. Ulangi skenario expired/used/revoked/unmapped dengan Core staging.
6. Baru setelah itu pertimbangkan produksi.

**Tidak disarankan** mengaktifkan SSO di produksi sebelum poin 1–5 selesai.

### 5.4 Runbook staging (SSO + approval)

Dijalankan di staging Connect, **bukan** produksi, dan hanya setelah Core menerbitkan kredensial.

**Konfigurasi minimum:**

```bash
ALIM_CORE_BASE_URL=https://<core-staging>          # tanpa trailing slash
ALIM_CORE_WEB_ORIGIN=https://<core-web-staging>    # origin yang meng-embed, bukan API
ALIM_CONNECT_SSO_KEY=<dari Core>                   # header X-ALIM-CONNECT-SSO-KEY
ALIM_CORE_API_VERSION=1
AUTH_SESSION_IDLE_TIMEOUT_MINUTES=30
CSP_UPGRADE_INSECURE_REQUESTS=true                 # staging di belakang TLS
```

Approval memakai kredensial terpisah: `ALIM_CORE_APPROVAL_API_KEY` (Connect → Core) dan
`ALIM_CONNECT_INGEST_KEY` (Core → Connect). Jangan memakai kunci SSO untuk keduanya.

**Langkah dan hasil yang diharapkan:**

| #   | Tindakan                                                                 | Hasil yang diharapkan                                                                                  |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 0   | `npm run probe:alim-core -- --all`                                       | `PASS` pada SSO dan approval; `2` bila kunci belum diisi, `3` bila Core menerima yang tidak seharusnya |
| 1   | `GET /health` dan `GET /api/auth/me` tanpa kredensial                    | `200` pada health, `401` pada `/api/auth/me`                                                           |
| 2   | Petakan satu akun uji: `PATCH /api/auth/users/:id {"coreUserId":"<id>"}` | `200`, `coreUserId` tampil di respons                                                                  |
| 3   | Buka Connect dari menu Core (iframe)                                     | workspace tampil; DevTools: `sessionStorage.openwa_api_key` berawalan `owa_s1_`, tanpa cookie          |
| 4   | Reload iframe                                                            | tetap masuk, tanpa POST `/sso/handoff` baru                                                            |
| 5   | Logout lalu reload                                                       | halaman login; `/api/auth/me` `401`                                                                    |
| 6   | Ulangi dengan akun yang belum dipetakan                                  | `403 identity_not_mapped`; jumlah user tidak bertambah                                                 |
| 7   | Cabut izin di Core lalu ulangi handoff                                   | `403 permission_revoked` (atau `user_inactive`)                                                        |
| 8   | Kirim satu permohonan uji dari Core ke Connect                           | `201`, command terkirim ke Core, status akhir `APPROVED`/`REJECTED`                                    |
| 9   | Putuskan jaringan Core saat command dikirim                              | status `UNKNOWN`, retry memakai `commandId` yang sama, tidak ada keputusan ganda                       |
| 10  | Periksa log Connect                                                      | tidak ada `code`, `owa_s1_`, atau kunci SSO/approval                                                   |

**Rollback:** kosongkan `ALIM_CORE_WEB_ORIGIN` (SSO kembali `503`, `X-Frame-Options: SAMEORIGIN`
berlaku lagi) dan `ALIM_CORE_APPROVAL_API_KEY` (command berhenti dikirim, baris tetap `PENDING`/
`UNKNOWN` untuk retry setelah kunci dipulihkan). Tidak ada migrasi baru yang perlu dibalik untuk
mematikan integrasi.

**Yang harus dicatat saat staging:** versi Core, `core_user_id` uji (bukan nama orang), kode status
setiap langkah, dan pesan `errors.code` dari Core. Jangan menyalin token atau kunci ke dokumen.

---

## 6. Perintah yang dijalankan

```bash
# statis
npx tsc --noEmit
npm run build
npm run lint
npm run openapi:export && npm run openapi:check
npm run test:docs

# kesiapan Core (sebelum ada trafik pengguna)
npm run probe:alim-core            # SSO saja
npm run probe:alim-core -- --all   # SSO + satu command approval yang tidak valid

# SSO
npx jest src/modules/sso --runInBand
npx jest src/config/swagger.config.spec.ts --runInBand
npx jest --config ./test/jest-e2e.json test/sso-handoff-http.e2e-spec.ts

# browser (butuh Connect + harness berjalan; lihat header skrip)
node scripts/sso-browser-harness.js &
node scripts/sso-browser-test.js

# approval
npx jest src/modules/approval --runInBand --testPathIgnorePatterns="\.pg\.spec\.ts"
npx jest --config ./test/jest-e2e.json test/approval-http.e2e-spec.ts
npm run test:contracts

# PostgreSQL (DATABASE_* diekspor dari .env lebih dulu)
npm run test:pg-approval
npx jest src/database/postgres-utc.pg.spec.ts --runInBand
npx jest src/database/postgres-utc-pool.pg.spec.ts --runInBand
```

Tidak ada commit, push, merge, deploy, migrasi ke lingkungan bersama, atau perubahan credential
dalam siklus ini.

---

## 7. Rekomendasi siklus berikutnya

1. **Selesaikan matriks browser.** Nyalakan _Allow remote automation_ di Safari (atau jalankan
   `safaridriver --enable` dengan hak admin), pasang Firefox Nightly untuk driver puppeteer, lalu
   jalankan `node scripts/sso-browser-test.js` dengan `BROWSER_CHANNEL` yang sesuai. Safari adalah
   risiko terbesar karena pembatasan storage pihak ketiga — bila `sessionStorage` diblokir, alur
   iframe tidak dapat diselesaikan dan desain handoff perlu alternatif tab tingkat atas.
2. **Staging dengan Core sungguhan** mengikuti §5.4, setelah kredensial dan endpoint tersedia.
3. **Putuskan gate cakupan (coverage).** Perbedaan denominator antara tabel dan ambang
   membuat gate ini tidak dapat dipercaya sebagai sinyal hijau/merah. Pilih salah satu: perbaiki
   `collectCoverageFrom` agar tidak memasukkan berkas tanpa statement, atau tambahkan lane e2e ke
   perhitungan cakupan untuk controller yang diuji di batas HTTP. Jangan menurunkan ambang.
4. **Retensi dan scoping `VIEWER`** tetap menunggu keputusan pemilik; mekanisme retensi sudah ada
   dan sengaja tidak diaktifkan otomatis.
5. **Pertimbangkan menjalankan `scripts/sso-browser-test.js` di CI** sebagai job manual
   (`workflow_dispatch`) dengan Chrome headless, karena satu-satunya bagian yang masih manual adalah
   dua origin dan akun uji — keduanya dapat disiapkan skrip.
