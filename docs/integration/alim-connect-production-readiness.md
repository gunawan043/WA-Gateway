# Production Readiness Check — ALIM Core dan ALIM Connect (read-only)

**Tanggal:** 2026-11-25 · **Siklus:** 12 lanjutan · **Sifat:** **read-only** — tidak ada data,
konfigurasi, migration, approval command, atau kode SSO yang dikirim/diubah; tidak ada push/merge/deploy.
**Repo Connect yang diperiksa:** `feature/whatsapp-approval-finalization`, HEAD `82f5a1ed3` + perubahan
siklus 12 di working tree (belum commit)

**Kesimpulan singkat:** deployment yang ada di mesin ini **bukan** deployment production. Core berjalan
sebagai instance lokal lewat HTTP polos (`127.0.0.1:8001`), dan Connect dikonfigurasi menunjuk ke sana
lewat HTTP polos pula. Tidak ada alamat, kredensial, atau konfigurasi production yang dapat diperiksa dari
sini. Hasilnya: **Core: TIDAK SIAP diuji sebagai production · Connect: TIDAK SIAP**, dengan enam
ketidaksesuaian konkret di bawah (§3) yang sebagian besar **akan menggagalkan atau merusak boot
production**, bukan sekadar uji.

---

## 0. Cakupan dan metode (apa yang benar-benar diperiksa)

| Diperiksa              | Cara                                                                                                         | Hasil                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Endpoint Core hidup    | `GET /health/`, `GET /login`, `POST` tanpa auth ke kedua endpoint Connect                                    | §1                                       |
| Konfigurasi Connect    | `.env`, `src/config/configuration.ts`, `src/config/env-precedence.ts`, `docker-compose.yml`, `charts/openwa` | §2                                       |
| Guard produksi di kode | `bootstrap-security.ts`, `core-client-policy.ts`, `core-web-origin.ts`, `configure-app.ts`                   | §3                                       |
| Database               | koneksi **baca saja** (`SELECT`/`information_schema`) + `src/database/data-source.ts`                        | §2.3                                     |
| Tidak dapat diperiksa  | Core production (URL/key/allowlist/migration), host Connect production, TLS proxy, secret manager            | §6 — tidak ada akses, dan tidak dikarang |

---

## 1. Status kesiapan ALIM Core — **TIDAK SIAP (production)**

| Aspek                             | Bukti aktual                                                                                                                                           | Status                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Instance yang tersedia            | `http://127.0.0.1:8001`, PHP 8.5.8, halaman login Core (`GET /login` → 200, judul "Masuk — ALIM")                                                      | lokal, **bukan staging/production** |
| Health                            | `GET /health/` → `200 {"status":"ok"}`                                                                                                                 | hidup                               |
| Rute SSO                          | `POST /api/connect/v1/sso/exchange` tanpa kunci → `401`; kode karangan → `404 code_not_found`                                                          | rute + auth bekerja                 |
| Rute approval                     | `POST /api/connect/v1/approval-commands` tanpa kunci → `401`; aktor tak dikenal → `403 actor_identity_unmapped`                                        | rute + auth bekerja                 |
| Kontrak yang benar-benar berjalan | `audience: connect`, `scope: whatsapp.embed` (default Connect) — sesuai `alim-connect-whatsapp-connect-sso-contract.md`; belum diuji dengan kode nyata | **belum terbukti**                  |
| HTTPS                             | Semua probe lewat `http://`; tidak ada listener TLS (8443 tertutup); respons tanpa `Strict-Transport-Security`                                         | **tidak ada TLS**                   |
| Allowlist IP                      | Tidak dapat diperiksa (konfigurasi milik Core)                                                                                                         | **tidak diketahui**                 |
| API key configuration             | Hanya terbukti "kunci yang dipakai diterima"; masa berlaku, scope, rotasi, dan siapa pemegangnya tidak dapat dibaca                                    | **tidak diketahui**                 |
| Migration/schema                  | `migrations` ada dengan kolom TypeORM, **0 baris**; 33 tabel `public`                                                                                  | **tidak diketahui**                 |

**Blocker Core:** endpoint yang bisa diuji adalah instance lokal HTTP. Tanpa URL HTTPS production, kunci
production, dan konfirmasi schema, tidak ada satu pun aspek production yang bisa dinyatakan siap.

---

## 2. Status kesiapan ALIM Connect — **TIDAK SIAP (production)**

### 2.1 Integrasi ke Core

| Aspek                        | Nilai yang terbaca                                                | Status                                      |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| `ALIM_CORE_BASE_URL`         | `http://127.0.0.1:8001`                                           | **HTTP polos, loopback** — bukan production |
| `ALIM_CORE_WEB_ORIGIN`       | `http://127.0.0.1:8001`                                           | **HTTP polos** — lihat risiko R2            |
| `ALIM_CONNECT_CORE_CLIENT`   | `http`                                                            | benar (guard produksi menolak `mock`)       |
| `ALIM_CORE_APPROVAL_API_KEY` | ada (64 char)                                                     | ada, tetapi milik instance lokal            |
| `ALIM_CONNECT_SSO_KEY`       | ada (64 char)                                                     | ada, tetapi milik instance lokal            |
| `ALIM_CONNECT_INGEST_KEY`    | ada (64 char)                                                     | ada, tetapi milik instance lokal            |
| `ALIM_CONNECT_API_VERSION`   | `1`                                                               | sesuai kontrak                              |
| Header kontrak               | default (`X-ALIM-CONNECT-SSO-KEY`, `X-ALIM-CONNECT-APPROVAL-KEY`) | sesuai kontrak                              |
| `Idempotency-Key`            | = `command_id`, dikirim di setiap command                         | sesuai kontrak                              |
| Timeout / retry              | default 5000 ms; retry 5× / 60 s / lease 60 s                     | tidak di-override                           |

Forwarding ke container benar: `docker-compose.yml:414-435` meneruskan 20+ variabel `ALIM_*` termasuk
`ALIM_CONNECT_SSO_KEY`, `ALIM_CORE_WEB_ORIGIN`, `ALIM_CONNECT_SSO_AUDIENCE/SCOPE` — jadi tidak ada kunci
yang "hilang" di jalur compose. Registry blank-shadow (`env-precedence.ts:261-283`) juga memuat semuanya.

### 2.2 Secret aplikasi lain (wajib untuk boot production)

`.env` yang diperiksa **hanya** memuat 20 kunci (WWEBJS, DATABASE, ALIM_*). Tidak ada
`API_MASTER_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CORS_ORIGINS`, `TRUSTED_PROXIES`,
`CSP_UPGRADE_INSECURE_REQUESTS`. Ini konsekuensi wajar dari file yang dibuat untuk uji integrasi, tetapi
artinya file ini **bukan** konfigurasi production (§3 K2, K3).

### 2.3 Database

| Aspek         | Bukti aktual                                                                                      | Status              |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------------- |
| Tipe          | `DATABASE_TYPE=postgres` (bukan SQLite — syarat "tidak memakai SQLite staging" **terpenuhi**)     | lulus               |
| Server        | PostgreSQL **17.12**, database `postgres` di pooler Supabase (`aws-0-ap-northeast-2`)             | terjangkau          |
| Skema         | 33 tabel publik, termasuk `approval_requests`, `approval_commands`, `messages` (17 kolom)         | tabel integrasi ada |
| Migration     | `migrations` ada dengan kolom TypeORM, **0 baris**; 33 tabel `public`                             | lihat K4            |
| TLS DB        | `DATABASE_SSL=true`, `DATABASE_SSL_REJECT_UNAUTHORIZED=false`                                     | lihat R3            |
| Jalur migrasi | `data-source.ts` memaksa `synchronize: false`; runtime memakai `pg-boot-migrations` di bawah lock | benar               |

### 2.4 Deployment dan layanan

| Aspek                | Bukti                                                                                                                                           | Status                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Image/entrypoint     | `Dockerfile` + `docker-entrypoint.sh` ada; dashboard dibundel dan disajikan pada port 2785                                                      | siap secara artefak     |
| Port                 | `127.0.0.1:${API_PORT:-2785}:2785` — **tidak diekspos ke publik**, TLS proxy wajib di depan                                                     | benar, dengan prasyarat |
| Healthcheck          | ada pada layanan `openwa-api`                                                                                                                   | benar                   |
| Helm                 | `charts/openwa` menyatakan "Any variable from .env.example is valid" di `values.env`                                                            | tidak diverifikasi      |
| Proses yang berjalan | Core PHP aktif pada 8001; **Connect tidak berjalan** (`3000`, `8000` tertutup; port 2785 juga) — tidak ada instance Connect yang bisa diperiksa | —                       |

---

## 3. Ketidaksesuaian konfigurasi/kontrak (dengan bukti dan sumber kode)

| #      | Temuan                                                                                                                   | Bukti                                                                                                                                                                                                                                                                                                                                                       | Dampak                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **K1** | **`parseCoreWebOrigin` menerima `http:`** untuk origin Core, walau komentarnya menyebut cleartext "hanya untuk loopback" | `src/config/core-web-origin.ts:31-33` — memeriksa protokol `https:` **atau** `http:`, tanpa pemeriksaan host loopback                                                                                                                                                                                                                                       | konfigurasi production dengan `http://` akan diterima diam-diam dan melemahkan embed SSO (lihat R2). Semua 20+ variabel `ALIM_*` **memang** diteruskan `docker-compose.yml:414-435`, jadi tidak ada kunci yang hilang di jalur compose |
| **K2** | **`API_MASTER_KEY` wajib di production, tapi tidak ada di `.env`**                                                       | `src/config/bootstrap-security.ts:130` (`MIN_PROD_MASTER_KEY_LENGTH`, daftar placeholder dilarang), `docker-compose.yml:283`                                                                                                                                                                                                                                | **boot production gagal/ditolak** tanpa kunci 32+ char yang bukan placeholder                                                                                                                                                          |
| **K3** | **CORS production tanpa `CORS_ORIGINS`**                                                                                 | `configure-app.ts:187-191`: wildcard ditolak di production, peringatan dicetak                                                                                                                                                                                                                                                                              | permintaan browser lintas-origin ke API akan diblokir; dashboard disajikan same-origin sehingga aman, tetapi integrasi browser lain tidak                                                                                              |
| **K4** | **Tabel `migrations` kosong padahal 33 tabel sudah ada**                                                                 | Lihat **§8** — kolom ledger bertipe TypeORM (`id`, `timestamp`, `name`), kosong, sementara `approval_requests`/`approval_commands` ada; TypeORM default `migrationsTableName = "migrations"` (`node_modules/typeorm/migration/MigrationExecutor.js:33`); `src/database/pg-boot-migrations.ts:149` menjalankan `runMigrations()`, yang mencatat ke tabel itu | schema dibangun tanpa jalur migration, atau ledger-nya diganti. Boot production akan mencoba **semua** migration terhadap schema yang sudah ada → risiko R4                                                                            |
| **K5** | **`ALIM_CORE_BASE_URL` & `ALIM_CORE_WEB_ORIGIN` masih HTTP polos**                                                       | `.env`; `parseCoreWebOrigin` menerima `http:` walau komentarnya menyebut "hanya untuk loopback"                                                                                                                                                                                                                                                             | di production: komunikasi Core dan embed SSO lewat cleartext                                                                                                                                                                           |
| **K6** | **`F` (migration/schema Core) dan bentuk `actor_external_id` belum dikonfirmasi Core**                                   | permintaan siklus 12 §1 belum dijawab                                                                                                                                                                                                                                                                                                                       | kontrak bisa berbeda (mis. Core mengharapkan `+` atau `@s.whatsapp.net`) — perubahan kontrak, bukan bug                                                                                                                                |

Kontrak HTTP yang **sudah cocok** dan tidak perlu diubah: path kedua endpoint, nama header default,
`X-ALIM-API-Version: 1`, `Idempotency-Key` = `command_id`, body command (10 field), `audience`/`scope`
SSO, dan `frame-ancestors` yang hanya mengizinkan origin Core.

---

## 4. Risiko keamanan yang harus diselesaikan sebelum production

| #      | Risiko                                                                                                                                    | Bukti                                                                     | Perbaikan                                                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | **Cleartext ke Core** membawa kunci approval/SSO dan kode handoff di header/body                                                          | `.env` HTTP; Core tanpa HSTS/TLS                                          | wajib HTTPS di sisi Core **dan** `ALIM_CORE_BASE_URL=https://…` di Connect. Pertimbangkan guard boot yang menolak `http://` non-loopback di `NODE_ENV=production` (belum ada di kode) |
| **R2** | **Origin Core HTTP** melemahkan izin embed SSO                                                                                            | `ALIM_CORE_WEB_ORIGIN=http://…`; `parseCoreWebOrigin` membolehkan `http:` | di production harus `https://<host Core>`; `X-Frame-Options`/CSP saat ini hanya mengizinkan origin itu                                                                                |
| **R3** | **`DATABASE_SSL_REJECT_UNAUTHORIZED=false`** mematikan verifikasi sertifikat → rentan MITM ke database                                    | `.env`                                                                    | pakai CA chain yang dipercaya (`rejectUnauthorized: true` + CA), bukan `false`                                                                                                        |
| **R4** | **`migrations` kosong** → boot production bisa mencoba menerapkan ulang migration yang schema-nya sudah ada                               | K4                                                                        | tentukan ulang baseline: tandai migration yang sudah diterapkan, jangan jalankan ulang; lakukan di jendela terpisah, bukan saat uji integrasi                                         |
| **R5** | **Tidak ada `API_MASTER_KEY`** → boot production gagal                                                                                    | K2                                                                        | sediakan lewat secret manager, 32+ char, bukan placeholder                                                                                                                            |
| **R6** | **Rate limit per-IP** bergantung `TRUSTED_PROXIES`; tanpa itu semua klien di belakang proxy berbagi satu bucket                           | `proxy-aware-throttler.guard.ts:1-22`                                     | set `TRUSTED_PROXIES` ke CIDR proxy saat deploy                                                                                                                                       |
| **R7** | **Ingest endpoint** `/api/approval/requests` dilindungi satu kunci statis + throttle; Core harus dipastikan kirim dari IP yang diharapkan | `approval-ingest.guard.ts` (`timingSafeEqual`, aman)                      | konfirmasi allowlist/IP egress Core bila Core memakai allowlist; rotasi `ALIM_CONNECT_INGEST_KEY` berkala                                                                             |

---

## 5. Prasyarat yang masih menghalangi pengujian production

1. **URL HTTPS Core production** + **kunci `sso:exchange`** dan **`approval:command`** production, lewat
   secret manager. (Tanpa ini semua pengujian production tidak bisa diarahkan ke Core yang benar.)
2. **Kunci `ALIM_CONNECT_INGEST_KEY` production** yang **dibuat baru** dan dipasang di kedua sisi.
3. **Host Connect production + TLS reverse proxy**, dan `ALIM_CORE_WEB_ORIGIN=https://<host Core>`.
4. **`API_MASTER_KEY`, `ADMIN_EMAIL/PASSWORD`, `CORS_ORIGINS`, `TRUSTED_PROXIES`** untuk instance Connect
   production.
5. **Keputusan baseline migration** (K4/R4) — tanpa ini boot production berisiko.
6. **Aktor, permit, kode SSO** dari Core (butir A–E siklus 12), dengan **penegasan tertulis bahwa ketiganya
   bukan data production**.
7. **Konfirmasi schema Core** dan bentuk `actor_external_id`.

---

## 6. Yang tidak bisa diperiksa dari sini (dinyatakan, bukan diasumsikan)

- Konfigurasi Core production: URL, kunci, allowlist IP, migration, versi kode Core.
- Host Connect production dan reverse proxy/TLS-nya.
- Isi secret manager kedua pihak.
- Apakah database yang diperiksa (Supabase `postgres`) adalah database **production** Connect: dari sini
  hanya terbukti tipe dan schema-nya. `migrations` kosong (K4) **menunjukkan** ini bukan database yang
  dibangun lewat jalur migration normal, tetapi tanpa konfirmasi pemilik tidak bisa dipastikan.

---

## 7. Rekomendasi langkah berikutnya

1. **Jangan** mengarahkan uji ke production sebelum R1–R5 selesai dan prasyarat 1–4 tersedia.
2. Lengkapi dulu uji **staging** yang sudah terbukti jalurnya (Siklus 12): aktor + permit + kode SSO
   cukup untuk membuktikan tiga kriteria, tanpa menyentuh production.
3. Setelah itu, pengujian production terbatas yang aman: satu permit uji non-produksi, satu kode SSO
   sekali pakai, tanpa approval permit produksi, dengan rollback kunci jika gagal.

---

## 8. Investigasi ledger migration kosong (read-only, 2026-11-25)

Yang dibaca (semua `SELECT`/`information_schema`, tidak ada DDL/migrasi):

| Pemeriksaan    | Hasil                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabel ledger   | `public.migrations`, kolom persis `id`, `timestamp`, `name` — dan ini **skema yang ditulis TypeORM** (`MigrationExecutor.js:33`: `migrationsTableName ?? "migrations"`, tabel dibuat dengan tiga kolom itu) |
| Isi ledger     | `0` baris                                                                                                                                                                                                   |
| Tabel aplikasi | 33 tabel `public`, termasuk `messages`, `approval_requests`, `approval_commands`                                                                                                                            |
| Pemilik tabel  | `postgres` (mayoritas), satu tabel milik `supabase_realtime_admin`                                                                                                                                          |
| Peran & hak    | user memakai `role: postgres` lewat session pooler; `has_database_privilege(...,'CREATE')` = true                                                                                                           |
| `search_path`  | `"$user", public, extensions`                                                                                                                                                                               |
| Server         | PostgreSQL 17.12 (dialihkan lewat proxy Supabase, IPv6 2406:…)                                                                                                                                              |

Cara Connect menulis ledger: satu-satunya jalur runtime adalah `src/database/pg-boot-migrations.ts:149`
(`migrator.runMigrations({ transaction })`) di bawah `pg_advisory_lock`; `migrationsRun` data source
dinonaktifkan di tempat yang sama, dan `synchronize` selalu `false`. Jadi ledger **seharusnya** terisi
oleh setiap boot PostgreSQL.

Dua kemungkinan yang konsisten dengan bukti, **belum bisa dibedakan tanpa riwayat deployment**:

1. **Schema dibuat tanpa jalur migration Connect** — mis. lewat `synchronize` pada rilis lama (entitas
   disinkronkan, ledger tidak disentuh) atau restore/import skema. Ledger lalu dibuat kosong oleh boot.
2. **Ledger pernah diganti/direset** — database atau schema dipulihkan dari dump yang tidak memuat baris
   ledger, atau `migrations` di-truncate/di-drop setelah schema ada.

Bukti yang bisa membedakannya (minta ke pemilik database, bukan dijalankan sekarang): tanggal pembuatan
relasi di `pg_class`/`pg_stat_user_tables`, riwayat backup/restore, dan log boot pertama yang pernah
menjalankan migration. Code Connect sendiri **tidak** mengosongkan ledger: `createMainDataSource`
(`src/database/main-connection.ts:78-95`) justru menolak boot bila ledger SQLite memuat migration yang
tidak dikirim rilis — tidak ada jalur yang men-truncate — dan `pg-boot-migrations` hanya menjalankan
`runMigrations()`. Jadi pengosongan berasal dari luar proses aplikasi. **Yang pasti:** ledger kosong bukan berarti schema belum dibuat, dan menjalankan
`migration:run` sekarang akan mencoba membuat ulang 58 migration di atas schema yang sudah ada.

**Keputusan yang dibutuhkan sebelum deploy** (tidak dijalankan di sini):

1. Konfirmasi pemilik database (akun/role `postgres` dipakai bersama dengan komponen Supabase lain).
2. Tentukan baseline: tandai migration yang **sudah** tercermin di schema, jangan dijalankan ulang.
3. Uji baseline di salinan database, bukan di production.
4. Baru setelah itu jadwalkan boot pertama production dengan migration terkendali.

---

## 9. Perubahan yang dibuat siklus ini (belum commit)

| Berkas                                                     | Perubahan                                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/core-transport-policy.ts`                      | baru — `insecureCoreUrlReason`, `insecureCoreOriginReason`, `assertCoreTransportAllowed`                                                             |
| `src/config/core-transport-policy.spec.ts`                 | baru — 12 test (https diterima, http non-loopback ditolak, loopback tetap boleh, `localhost.example.com` ditolak, pesan menyebut nama variabel saja) |
| `src/main.ts`                                              | `assertCoreTransportAllowed(...)` dijalankan sebelum guard secret, hanya berlaku saat `NODE_ENV=production`                                          |
| `docs/integration/alim-connect-production-env.template.md` | baru — template `.env` production berisi nama variabel wajib tanpa nilai rahasia + prosedur rollback                                                 |
| `docs/integration/alim-connect-production-readiness.md`    | §8 investigasi ledger, §9 perubahan, K4 diperbarui                                                                                                   |

Gate yang lulus setelah perubahan: `tsc --noEmit`, `eslint` pada berkas yang disentuh,
`core-transport-policy` + `bootstrap-security` + `core-client-policy` (92 test), dan `test:docs` (969).
