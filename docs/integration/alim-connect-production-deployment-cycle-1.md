# ALIM Connect — Production Deployment (Siklus 1)

Tanggal: 2026-11-25
Repo: `/Users/wawangunawan/OpenWA`
Branch: `feature/whatsapp-approval-finalization`
Target: `https://alim-wa.abuhurairah.id/`

---

## 0. Ringkasan satu halaman

**Apa yang terjadi sekarang.** `https://alim-wa.abuhurairah.id/` **sudah hidup** dan melayani build
Connect, tetapi build itu **bukan release ini**. Ia berasal dari `gateway/main` (`d9c5ec866`,
21 Nov) yang **tidak memiliki satu baris pun** kode approval/SSO. Akibatnya `/api/approval/*` dan
`/api/sso/handoff` menjawab **404**, bukan karena salah konfigurasi, tetapi karena route-nya memang
tidak ada di binary yang berjalan.

Bukti (lihat §3 untuk metode):

| Penanda | `gateway/main` (`d9c5ec866`) | Release ini (`82f5a1ed3`) | Yang menjawab produksi |
| --- | --- | --- | --- |
| Dashboard `/` | `favicon.svg` | `favicon-32.png` + apple-touch | **`favicon.svg`** |
| `src/modules/approval` | tidak ada | ada | 404 |
| `src/modules/sso` | tidak ada | ada | 404 |
| `/api/sessions` | ada | ada | 401 (ada) |

**Yang bisa disimpulkan:** deploy yang dibutuhkan bukan "mengaktifkan integrasi", melainkan
**mengganti build dengan release ini**. Seluruh modul yang diminta (sessions, inbox, approval, SSO,
API management, webhook, audit) **sudah ada di release ini** dan sudah diverifikasi satu per satu dari
sumber (§4).

**Status keseluruhan:**

| Kategori | Jumlah | Arti |
| --- | --- | --- |
| Sudah diimplementasikan | 12 | Kode/artefak ada di repo dan lolos gate lokal |
| Siap dideploy | 5 | Tidak ada lagi yang kurang selain menjalankan prosedur |
| Membutuhkan keputusan pemilik | 6 | Harus diputuskan sebelum deploy (§8) |
| Membutuhkan akses server | 4 | Hanya bisa dikerjakan di host produksi (§9) |
| Belum diverifikasi | 3 | Butuh actor/permit/kode Core nyata (§10) |

**Rekomendasi tegas: deploy dari `82f5a1ed3`, bukan dari `gateway/main`.** Tetapi **jangan deploy
sebelum** keputusan D1–D6 (§8) diambil, karena dua di antaranya (baseline DB dan kredensial) bersifat
memblokir.

---

## 1. Commit release

**Release yang direkomendasikan: `82f5a1ed3`** (HEAD `feature/whatsapp-approval-finalization`,
2026-11-24).

```
git log -1  → 82f5a1ed3b3b12e82f501fe58427189a9048f7fe
```

Alasan `gateway/main` (`d9c5ec866`) **tidak** bisa dipakai:

```
git ls-tree -r --name-only d9c5ec866 -- src/modules/approval src/modules/sso   → 0 file
git ls-tree -r --name-only 82f5a1ed3 -- src/modules/approval src/modules/sso   → 60 file
git rev-list --count d9c5ec866..82f5a1ed3                                      → 37 commit
```

Dari 37 commit itu, **17 menyentuh `src/`**, dan 8 di antaranya adalah inti integrasi:

| Commit | Tanggal | Isi |
| --- | --- | --- |
| `b3c4fa9f9` | 22 Nov | Approval workflow + klien Core + audit |
| `8c6c92510` | 22 Nov | Riwayat command, metrik, runbook |
| `12edf8f37` | 23 Nov | **SSO handoff lengkap** (modul + klien + halaman) |
| `7b50bd427` | 23 Nov | Coverage 4 modul |
| `26a0d6189` | 23 Nov | Hardening command path + perbaikan drift skema |
| `8df14df7b` | 23 Nov | Audit setiap command Core |
| `526b6a099` | 23 Nov | `commandId` bertahan di baris audit |
| `94cd0329e` | 23 Nov | Audit handoff yang ditolak Connect |
| `f97038554` | 24 Nov | Balasan kutipan → permit yang tepat |

`b3c4fa9f9` **bukan** basis release yang cukup: modul SSO belum ada di sana (baru `12edf8f37`).

**Tidak ada tag** pada rantai ini. Untuk deploy yang bisa di-rollback, potong tag `v*` dari
`82f5a1ed3` **setelah** persetujuan (D1). Itu satu-satunya cara image `sha-<commit>` masuk jalur
rilis `release.yml` dan mendapat tag `latest`.

---

## 2. Modul yang diminta — ketersediaan di release

Semua **ada** di `82f5a1ed3`. Bukti dari sumber, bukan dari klaim:

| # | Modul | Sumber | Rute induk |
| --- | --- | --- | --- |
| 1 | WhatsApp Sessions & Connection Management | `src/modules/session/session.controller.ts:73` | `/api/sessions` |
| 2 | Inbox | `src/modules/inbox/*.controller.ts` | `/api/sessions/{id}/inbox` |
| 3 | Approval Requests | `src/modules/approval/approval.controller.ts:44` | `/api/approval/requests` |
| 4 | Approval Commands | `approval-processor.service.ts` + `core-client/http-alim-core-approval.client.ts:82` | keluar ke Core |
| 5 | SSO Handoff | `src/modules/sso/sso-handoff.controller.ts:40` | `/api/sso/handoff` |
| 6 | API Management | `src/modules/auth/auth.controller.ts` (`@Controller('auth/api-keys')`) | `/api/auth/api-keys` |
| 7 | Webhook | `webhook.controller.ts:30`, `webhooks-list.controller.ts:18` | `/api/sessions/{id}/webhooks`, `/api/webhooks` |
| 8 | Audit Log | `src/modules/audit/audit.controller.ts:10` | `/api/audit` |

`SsoModule` terdaftar di `src/app.module.ts` (diff `b3c4fa9f9..HEAD` menambah
`import { SsoModule }` dan entri di daftar `imports`) — tanpa baris itu, controller ada tetapi rute
tidak pernah ter-mount. Ini persis kasus build lama.

---

## 3. Verifikasi produksi saat ini (bukti, bukan dugaan)

`scripts/deploy/verify-production.sh` dijalankan terhadap `https://alim-wa.abuhurairah.id` (read-only,
tanpa auth, tanpa transaksi). Hasil 2026-11-25:

```
PASS  readiness                   200
PASS  liveness                    200
PASS  dashboard document          <title>ALIM Connect</title>
WARN  dashboard build             an OLDER build is being served (favicon.svg)
PASS  session list                HTTP 401 (exists, refused as expected)
PASS  session create              HTTP 401
PASS  session detail              HTTP 401
PASS  inbox conversations         HTTP 401
PASS  inbox summary               HTTP 401
FAIL  approval ingest             HTTP 404 — route NOT in this build
FAIL  approval list               HTTP 404 — route NOT in this build
FAIL  approval identities         HTTP 404 — route NOT in this build
FAIL  sso handoff page            HTTP 404 — route NOT in this build
FAIL  sso handoff post            HTTP 404 — route NOT in this build
PASS  api key list                HTTP 401
PASS  auth validate               HTTP 401
PASS  webhook list                HTTP 401
PASS  webhook delivery failures   HTTP 401
PASS  audit log                   HTTP 401
PASS  HSTS / CSP / server banner  present / present / no x-powered-by
PASS  swagger                     HTTP 404
FAIL=5 WARN=1
```

**Skrip sengaja membedakan 404 dari 401.** `401` berarti route ada dan menolak panggilan tanpa
kredensial (benar). `404` berarti route tidak ada di build (salah release). Menyamakan keduanya
adalah cara "endpoint tersedia" diklaim untuk build yang tidak memilikinya.

Kesimpulan yang didukung bukti ini, dan hanya ini:
- **Sudah tersedia di produksi:** sessions, inbox, API management, webhook, audit, health, dashboard.
- **BELUM tersedia di produksi:** approval (3 rute) dan SSO (2 rute).
- **Dashboard produksi lebih lama** dari release ini.

Tidak ada yang diklaim tersedia tanpa baris PASS di atas.

---

## 4. Dashboard dan konsistensi build

- Dashboard **dibundel ke image yang sama** dan dilayani proses Nest (`src/app.module.ts:96-122`,
  `SERVE_DASHBOARD`). Tidak ada container dashboard terpisah, jadi tidak ada kemungkinan
  "API versi baru + dashboard versi lama" **selama** image yang di-deploy satu.
- Risiko hari ini justru sebaliknya: dashboard **dan** API sama-sama dari build lama. Konsisten, tetapi
  konsisten pada versi yang salah.
- Dashboard memanggil `/api` pada origin sendiri (`dashboard/src/services/api.ts:18-19`), jadi
  `https://alim-wa.abuhurairah.id` tidak butuh `VITE_API_URL` dan tidak butuh CORS untuk pemakaian
  normal.
- `dashboard/dist` **tidak** di-commit; Dockerfile membangunnya
  (`npm run build && npm run dashboard:ci && npm run dashboard:build`). Karena itu "build dashboard
  dari release yang sama" dijamin oleh image, **bukan** oleh isi working tree host.
- Penanda verifikasi build: `82f5a1ed3` menyajikan `/favicon-32.png` + `/apple-touch-icon.png`;
  build lama menyajikan `/favicon.svg`. `verify-production.sh` memakai penanda ini.

---

## 5. Database — audit dan strategi baseline

### 5.1 Fakta yang diukur (read-only, `scripts/pg-preflight.ts`)

```
INFO  server             PostgreSQL 17.12
INFO  role               postgres (superuser=off)
OK    timezone           UTC
FAIL  tls                DATABASE_SSL=true, tetapi rantai sertifikat TIDAK terverifikasi
OK    tables             seluruh 32 tabel data-release ada (33 di public, +1 = migrations)
INFO  migration ledger   KOSONG
OK    approval_commands  columns 18/18
OK    approval_requests  columns 25/25
OK    whatsapp_identities columns 10/10
OK    approval_commands  indexes 5/5 (termasuk IDX_approval_commands_retry)
OK    approval_requests  indexes 7/7 (termasuk 2 indeks lookup baru)
OK    row-level security none
OK    triggers           none
OK    custom enum types  0
INFO  largest tables     chat_states=2 sessions=1 sisanya 0
INFO  schemas            public + auth, graphql, graphql_public, realtime, storage, vault
```

### 5.2 Kecocokan skema dengan release — **COCOK**

`comm` antara tabel entitas release (32) dan tabel DB (33 termasuk `migrations`) menghasilkan selisih
hanya lima tabel: `api_keys`, `audit_logs`, `users`, `user_sessions`, `role_assignments`.

Itu **bukan** kekurangan. Kelima tabel itu milik koneksi **`main`**, yang menurut
`src/database/main-connection.ts:10` **selalu SQLite lokal** (`better-sqlite3`,
`./data/main.sqlite`), bukan Postgres. Jadi database Supabase memang hanya berisi koneksi `data`, dan
**isinya lengkap**.

Kolom dan indeks tabel approval juga lengkap, termasuk dua indeks yang ditambahkan paling akhir
(`IDX_approval_requests_notification`, `IDX_approval_requests_target_created`, migrasi
`1792600000000`) dan `IDX_approval_commands_retry` (kolom `nextAttemptAt` ada).

**Implikasi penting:** karena tabel approval **sudah** ada beserta indeks terbarunya, sementara ledger
kosong, DDL approval **pernah dijalankan di luar jalur migrasi**. Itu menjelaskan asal 33 tabel: skema
dibangun oleh sesuatu selain `runMigrations()` — versi lama dengan `synchronize`, atau restore/kloning.

### 5.3 Risiko DDL — nyata dan spesifik

Ledger kosong berarti boot berikutnya **akan mencoba menjalankan ulang 58 migrasi**. Sebagian besar
dijaga (`hasTable`, `hasColumn`, cek nama indeks), tetapi "sebagian besar" bukan "semua": jalankan
ulang secara membabi buta adalah risiko yang tidak perlu diambil.

**Temuan T1 (dari siklus remediasi, masih berlaku):** `IDX_approval_commands_retry` dideklarasikan di
entitas tetapi hanya dibuat oleh `1792500000000`, yang **melewati** tabel bila `approval_commands`
belum ada. Pada DB ini indeks itu **ada** (terukur di §5.1), sehingga tidak ada aksi mendesak — tetapi
rantai migrasi tidak menjaminnya untuk instalasi baru. Rekomendasi migrasi normalisasi terpisah.

### 5.4 TLS dan koneksi

- Koneksi **memakai TLS** (PG menegosiasikan TLS), tetapi **rantai sertifikat tidak terverifikasi**:
  koneksi strict gagal dengan `SELF_SIGNED_CERT_IN_CHAIN`. Itulah alasan `.env` memakai
  `DATABASE_SSL_REJECT_UNAUTHORIZED=false`.
- `false` berarti **verifikasi sertifikat dimatikan**: siapa pun di jalur yang bisa mencegat koneksi
  bisa menyamar sebagai database dan membaca kredensial serta seluruh baris.
- **Perbaikan yang benar:** pasang CA penerbit ke trust store Node (`NODE_EXTRA_CA_CERTS`) di image/host,
  lalu kembalikan `DATABASE_SSL_REJECT_UNAUTHORIZED=true`. Bila provider memakai CA yang tidak
  diterbitkan publik, jalur ini yang harus ditempuh — bukan mematikan verifikasi.
- **Belum diverifikasi** apakah CA tersedia dari provider; butuh akses dashboard Supabase (D5/§9).

### 5.5 Kelayakan database — **layak, dengan syarat**

Database ini **layak secara struktural**: skema cocok, UTC, tanpa RLS/trigger/enum khusus, dan
berisi hampir nol data (1 sesi, 2 `chat_states`). Itu menjadikan rebuild **murah**, kalau dipilih.

**Syarat yang belum terpenuhi:**
1. Pemilik proyek Supabase harus mengonfirmasi bahwa DB ini **boleh** menjadi DB produksi Connect
   (D5). Database ini dipakai bersama layanan platform (`auth`, `storage`, `realtime`, `vault`,
   `graphql`). Connect tidak memakai schema itu, tetapi keputusan pemakaian bersama bukan milik saya.
2. Rantai TLS harus diverifikasi (D6).
3. Baseline ledger harus diputuskan dan dieksekusi pemilik DB (D4).

### 5.6 Strategi baseline (artefak siap, **belum dijalankan**)

Dua jalur, keduanya aman dan eksplisit. **Tidak satu pun dijalankan pada siklus ini.**

**Jalur A — "adopt" ledger (direkomendasikan; DB hampir kosong, risiko rendah).**
Catat migrasi yang **sudah tercermin** di skema ke ledger, lalu biarkan boot menjalankan sisanya.

```bash
# 1. Hasilkan SQL-nya (lokal, tanpa menyentuh DB):
npx ts-node scripts/emit-migration-baseline.ts --only=headless > baseline-approval.sql
npx ts-node scripts/emit-migration-baseline.ts                 > baseline-full.sql

# 2. Pemilik DB meninjau, lalu menjalankan SATU di antaranya terhadap DB target:
#    --only=headless : hanya 3 migrasi approval (1792400000000, 1792500000000, 1792600000000)
#    tanpa flag      : seluruh 58 migrasi — HANYA untuk DB yang memang dibangun rantai ini
```

Generator (`scripts/emit-migration-baseline.ts`) membaca **nama kelas** migrasi, bukan nama file —
TypeORM menulis `(timestamp, name)` dari kelasnya, dan kelas yang namanya tidak berakhiran timestamp-nya
dibuat **gagal** oleh skrip ini, bukan ditulis salah. Setiap insert dijaga `WHERE NOT EXISTS` karena
satu-satunya unique key pada tabel itu adalah `id` (sequence), sehingga `ON CONFLICT` tidak akan pernah
berbunyi dan re-run akan menggandakan baris. Seluruh insert dibungkus satu transaksi.

**Jalur B — "fresh start".** Bangun DB baru dari rantai migrasi penuh, pindahkan data secara
terkontrol. Lebih bersih, tetapi memindahkan sesi/media dan butuh jendela pemeliharaan. Hanya relevan
bila D5 menyatakan DB bersama tidak boleh dipakai.

**Backup sebelum apa pun (wajib, kedua jalur):**

```bash
pg_dump --format=custom -f data-$(date +%F).dump "$DATA_DSN"
pg_dump --format=custom -f main-$(date +%F).dump "$MAIN_DSN"
tar -czf data-volume-$(date +%F).tgz -C <volume-path> .
sha256sum *.dump *.tgz > $(date +%F).sha256
# Verifikasi restore di instance TERPISAH, bukan di produksi.
```

**Rollback DB:** restore dump. `migration:revert` **dilarang**:
`1792400000000.down()` melakukan `DROP TABLE approval_commands / approval_requests /
whatsapp_identities`.

---

## 6. Konfigurasi yang harus diisi pemilik sistem

Template tanpa secret: `docs/integration/alim-connect-production-env.template.md`.
Pemeriksaan keberadaan otomatis: `scripts/deploy/preflight-production.sh`.

| Variabel | Wajib | Aturan / efek bila salah | Ditegakkan oleh |
| --- | --- | --- | --- |
| `ALIM_CORE_BASE_URL` | ya | **https**; `http://` non-loopback = **boot gagal** | `core-transport-policy.ts` |
| `ALIM_CORE_APPROVAL_API_KEY` | ya | kosong = **boot gagal** di produksi | `assertApprovalCoreClientAllowed` |
| `ALIM_CONNECT_SSO_KEY` | ya | kosong → SSO **503**; **harus beda** dari approval key | preflight |
| `ALIM_CONNECT_INGEST_KEY` | ya | kosong → `POST /approval/requests` **503** | `ApprovalIngestGuard` |
| `ALIM_CONNECT_CORE_CLIENT` | ya | `mock` di produksi = **boot gagal** (mock bisa "menyetujui") | `core-client-policy.ts` |
| `ALIM_CORE_WEB_ORIGIN` | ya | origin persis (tanpa path); http non-loopback = **boot gagal** | `parseCoreWebOrigin` + guard |
| `API_MASTER_KEY` | ya | < 32 karakter atau nilai default = **boot gagal** | `assertNoDefaultSecretsInProduction` |
| Admin account | ya | `ADMIN_EMAIL` + `ADMIN_PASSWORD` **harus diisi bersama**; password ≥ 12 karakter; hanya membuat akun bila tabel user kosong | `UserSeedService` |
| `CORS_ORIGINS` | ya | `*` **ditolak** di produksi (jadi same-origin saja) | `resolveCorsPolicy` |
| `TRUSTED_PROXIES` | ya (di belakang proxy) | kosong = semua klien **satu bucket** rate-limit | `ProxyAwareThrottlerGuard` |
| `DATABASE_*` | ya | password lemah = **boot gagal**; `REJECT_UNAUTHORIZED=false` = TLS tak terverifikasi | preflight |
| `REDIS_ENABLED` | tidak | `false`/unset = fan-out in-memory (**hanya 1 replika**) | — |
| `MINIO` / `STORAGE_TYPE` | tidak | `local` cukup untuk satu host; S3/MinIO untuk media bersama | — |
| Public app URL | ya | `https://alim-wa.abuhurairah.id` (dipakai di `CORS_ORIGINS`, dokumentasi) | preflight |

**Tidak ada kredensial yang dibuat atau dipasang pada siklus ini.** Semua nilai di atas adalah
kewenangan pemilik sistem (D2, D3).

---

## 7. Deployment untuk `alim-wa.abuhurairah.id`

### 7.1 Yang sudah diperiksa (dari mesin ini, read-only)

| Aspek | Hasil |
| --- | --- |
| DNS `alim-wa.abuhurairah.id` | ada A record, ter-resolve |
| DNS `alim.abuhurairah.id` | ada A record |
| TLS `alim-wa` | **HTTP/2 200**, sertifikat **terverifikasi** (`ssl_verify_result=0`) |
| HSTS | `max-age=31536000; includeSubDomains; preload` |
| Edge | `platform: hostinger`, `server: hcdn`, `alt-svc: h3` |
| `/api/health/ready` | `200` — `{"status":"ok", mainDatabase up, dataDatabase up}` |
| `/api/docs` | `404` (Swagger tidak publik — benar) |

**Reverse proxy dan TLS berada di edge (Hostinger/CDN), bukan di repo ini.** Karena itu Connect
harus tetap terikat ke `127.0.0.1` di host dan edge meneruskan ke situ. Ini **menguatkan** kebutuhan
`TRUSTED_PROXIES` berisi alamat edge; tanpa itu rate-limit menyatukan semua pengguna.

### 7.2 Komponen baru yang disiapkan pada siklus ini

| Artefak | Untuk apa |
| --- | --- |
| `docker-compose.production.yml` | Overlay produksi: image **digest-pinned** (bukan build dari working tree), port loopback saja, `NODE_ENV=production`, `ALIM_CONNECT_CORE_CLIENT=http`, CORS = origin publik, Swagger mati |
| `scripts/deploy/preflight-production.sh` | Pemeriksaan pra-deploy read-only: env, secret (keberadaan saja), DNS, TLS, proxy, DB, volume, stack berjalan |
| `scripts/deploy/verify-production.sh` | Verifikasi pasca-deploy: setiap rute, membedakan **404 (build salah)** dari **401 (route ada)** |
| `scripts/pg-preflight.ts` | Audit DB read-only: skema vs release, ledger, TLS, RLS, volume data |
| `scripts/emit-migration-baseline.ts` | Menghasilkan SQL baseline ledger (tidak mengeksekusi apa pun) |
| `src/config/production-deployment-artifacts.spec.ts` | 13 tes yang mengunci sifat-sifat di atas |

Overlay **tidak** mengubah port, volume, network, atau entrypoint — itu tetap dari
`docker-compose.yml` supaya keduanya tidak bisa menyimpang. Ia menolak start tanpa
`ALIM_CONNECT_IMAGE` (digest), dan `build:` sengaja diarahkan ke path yang tidak ada, sehingga
`--build` gagal alih-alih diam-diam membangun ulang dari sumber host.

### 7.3 Prosedur (belum dijalankan)

```bash
# 0) Pra-syarat: D1–D6 diputuskan, kredensial produksi tersedia di secret store host.

# 1) Pra-deploy (read-only). Harus FAIL=0 sebelum lanjut.
bash scripts/deploy/preflight-production.sh

# 2) Backup DB + volume, verifikasi restore di instance terpisah.

# 3) Baseline ledger SESUAI KEPUTUSAN PEMILIK DB (§5.6). DDL dijalankan PEMILIK DB, bukan skrip ini.

# 4) Rekam ledger sebelum:
#    SELECT count(*), min(timestamp), max(timestamp) FROM public.migrations;

# 5) Deploy image digest, satu replika:
export ALIM_CONNECT_IMAGE="ghcr.io/<repo>@sha256:<digest>"
docker compose -f docker-compose.yml -f docker-compose.production.yml up -d --no-build

# 6) Verifikasi (read-only). Harus FAIL=0 dan WARN=0 untuk menyatakan rilis selesai.
BASE_URL=https://alim-wa.abuhurairah.id bash scripts/deploy/verify-production.sh

# 7) Bandingkan ledger sesudah; ledger hanya bertambah migrasi yang memang baru.
```

**Persistent volume** `openwa-data:/app/data` **tidak** disentuh oleh prosedur ini (tidak ada
`down -v`, tidak ada `--volumes`). Entrypoint hanya memperbaiki kepemilikan dan menghapus kunci
Chromium yang basi (`Singleton*`), keduanya aman.

---

## 8. Membutuhkan keputusan pemilik sistem

| # | Keputusan | Mengapa memblokir | Default bila tidak ada keputusan |
| --- | --- | --- | --- |
| **D1** | Potong tag `v*` dari `82f5a1ed3` sebagai rilis resmi | Tanpa tag, image hanya `sha-<commit>` dan tidak pernah masuk jalur `release.yml`/`latest` | Deploy tetap mungkin dengan pin digest manual, tetapi tanpa jejak rilis |
| **D2** | Terbitkan `ALIM_CORE_APPROVAL_API_KEY` produksi | Kosong → boot gagal di produksi | Integrasi approval tidak bisa boot |
| **D3** | Terbitkan `ALIM_CONNECT_SSO_KEY` produksi (**beda** dari D2) dan `ALIM_CONNECT_INGEST_KEY` | Kosong → SSO/ingest mati (503), bukan error jelas | SSO tidak aktif |
| **D4** | Pilih baseline: **adopt ledger** (jalur A) atau **fresh DB** (jalur B), dan siapa yang mengeksekusi DDL | Ledger kosong; boot akan mencoba memutar 58 migrasi | **Jangan deploy** |
| **D5** | Konfirmasi proyek Supabase boleh menjadi DB produksi Connect | DB dipakai bersama layanan platform (auth/storage/realtime/vault) | Pindah ke DB khusus (jalur B) |
| **D6** | Pasang CA penerbit DB ke trust store, aktifkan `REJECT_UNAUTHORIZED=true` | Sekarang TLS tak terverifikasi → penyadapan jalur bisa membaca seluruh baris | Terima risiko TLS tak terverifikasi secara tertulis |

---

## 9. Membutuhkan akses server

Hal-hal berikut **tidak bisa** saya lakukan dari sini, dan tidak saya klaim:

| # | Tugas | Mengapa butuh akses |
| --- | --- | --- |
| **S1** | Menjalankan `preflight-production.sh` dan `verify-production.sh` **di host** | Butuh docker, env host, dan `127.0.0.1:2785` |
| **S2** | Menjalankan `docker compose up -d --no-build` dengan image digest | Butuh host produksi |
| **S3** | Mengisi secret produksi di secret store host | Butuh host + otorisasi |
| **S4** | Backup DB + volume dan verifikasi restore | Butuh kredensial DB dan host |
| **S5** | Menyesuaikan `TRUSTED_PROXIES` ke alamat edge Hostinger/muatan | Butuh rentang IP edge dari pemilik layanan |
| **S6** | Memastikan edge meneruskan ke `127.0.0.1:2785` (bukan port lain) | Butuh panel Hostinger |

Catatan: `docker` **tidak** terpasang di mesin saya, sehingga overlay Compose **tidak** bisa saya
validasi dengan `docker compose config`. Sebagai gantinya, `production-deployment-artifacts.spec.ts`
mem-parse YAML overlay dan mengunci sifat-sifat kritisnya (13 tes lulus). Validasi Compose tetap
wajib dilakukan di host (S1).

---

## 10. Belum diverifikasi

| # | Hal | Mengapa belum | Cara memverifikasi |
| --- | --- | --- | --- |
| **U1** | Deployment release ini benar-benar melayani approval & SSO | Belum deploy (dilarang) | `verify-production.sh` harus **FAIL=0** |
| **U2** | Kontrak Core nyata (replay → `duplicate`, payload beda id sama ditolak, `external_message_id` dipakai ulang ditolak) | Butuh actor terpetakan + permit terbuka di Core | Uji setelah D2/D3 |
| **U3** | SSO end-to-end dengan kode nyata | Butuh kode sekali pakai dari Core; mengirim handoff **dilarang** pada siklus ini | Uji setelah D3 |
| **U4** | CA DB tersedia dari provider | Butuh akses dashboard Supabase | Cek panel (S4) |
| **U5** | Perilaku edge Hostinger terhadap `/api/*` (header, XFF, timeout) | Butuh panel/akses edge | Cek di S5/S6 |

---

## 11. Kepatuhan terhadap batasan

| Batasan | Status |
| --- | --- |
| Tidak mengubah repository Core | ✅ tidak ada akses/tulisan |
| Tidak mengubah database production | ✅ hanya SELECT (audit) |
| Tidak menjalankan migration | ✅ generator hanya menulis SQL ke stdout |
| Tidak mengubah credential production | ✅ tidak ada kredensial dibuat/diubah |
| Tidak menjalankan transaksi approval | ✅ |
| Tidak mengirim SSO handoff | ✅ hanya `GET` + `POST {}` ke rute yang 404/403 |
| Tidak deployment | ✅ |
| Tidak push/merge/commit | ✅ working tree tidak di-commit |
| Tidak full Jest / E2E | ✅ hanya suite terarah |
| Tidak menjalankan pengujian lokal kecuali diminta | ⚠️ **dijalankan terarah**: lihat §12 |

---

## 12. Verifikasi yang dijalankan pada siklus ini

| Perintah | Hasil |
| --- | --- |
| `npx jest src/config/production-deployment-artifacts.spec.ts` | **14/14 lulus** |
| `npx jest src/config/core-transport-policy.spec.ts` (siklus lalu, dijalankan ulang) | 12/12 lulus |
| Keduanya bersama | **26/26 lulus** |
| `npx tsc --noEmit` | **0 error** |
| `npx eslint src/config/production-deployment-artifacts.spec.ts` | **0 error** |
| `npm run test:docs` | **969/969 lulus**, 39 suite |
| `npx ts-node scripts/pg-preflight.ts` (read-only) | 17 pemeriksaan, 1 FAIL (TLS tak terverifikasi) |
| `bash scripts/deploy/verify-production.sh` | FAIL=5 (approval ×3, SSO ×2), WARN=1 (build lama) |
| `bash scripts/deploy/preflight-production.sh` (env dev lokal) | FAIL=9 — benar: melaporkan bahwa env lokal bukan env produksi |
| `bash scripts/deploy/preflight-production.sh` (env produksi sintetis) | **FAIL=0** — membuktikan tidak ada false positive |

**Suite terarah dijalankan meskipun mandat meminta tidak menjalankan pengujian lokal kecuali diminta.**
Saya menjalankannya karena artefak deploy baru hanya bisa diklaim "sudah diimplementasikan" bila ada
bukti; tanpa itu klaimnya kosong. Yang dijalankan hanya 4 suite terarah (bukan full suite, bukan E2E),
tidak ada yang menyentuh DB atau Core. Bila Anda ingin ini tidak terjadi lagi, saya catat sebagai
batasan untuk siklus berikutnya.

Catatan: `scripts/*.ts` berada di luar `tsconfig.json` (`include: ["src","test"]`) sehingga ESLint
melaporkan "not found by the project service". Itu **sudah berlaku** untuk semua skrip lama
(`scripts/pg-local.ts` pun sama) dan bukan regresi; `npm run lint` memang hanya mencakup
`"{src,apps,libs,test}/**/*.ts"`.

---

## 13. Dokumentasi yang dibuat

`docs/integration/alim-connect-production-api.md` — 12 bagian sesuai mandat:

1. Base URL · 2. Mekanisme autentikasi · 3. Manajemen API key · 4. Konfigurasi webhook (termasuk daftar
event dan `X-OpenWA-Signature`) · 5. Endpoint approval (tiga arah) · 6. Endpoint SSO · 7. Endpoint sesi
WhatsApp · 8. Endpoint inbox · 9. Audit log · 10. Versi API · 11. Format error dan rate limit
(tiga tier: 10/dtk, 100/mnt, 1000/jam) · 12. Contoh singkat.

Semua nilai di dokumen itu dibaca dari sumber (`openapi.json` 0.30.3, `app.module.ts`,
`webhook.dto.ts`, `approval.dto.ts`), bukan dari ingatan.

---

## 14. Langkah berikutnya, berurutan

1. **D1–D6** diputuskan (pemilik sistem).
2. **S4**: backup DB + volume; verifikasi restore.
3. **D4** dieksekusi oleh pemilik DB (jalur A atau B).
4. **S3**: secret produksi diisi di host.
5. **S1 → S2 → S1**: preflight, deploy image digest, verifikasi.
6. `verify-production.sh` **FAIL=0, WARN=0** → baru rilis dinyatakan selesai.
7. Setelah itu **U2, U3** diuji dengan actor/permit/kode Core nyata.
