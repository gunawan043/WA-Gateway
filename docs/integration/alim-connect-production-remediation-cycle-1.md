# Remediasi ALIM Connect — Production Release Readiness (Siklus 1)

Tanggal: 2026-11-25
Repo: `/Users/wawangunawan/OpenWA`
Branch: `feature/whatsapp-approval-finalization`
Peran: Senior NestJS Engineer / DevOps Engineer / Production Reliability Engineer

Dokumen acuan: `docs/integration/alim-connect-production-readiness.md`,
`docs/integration/alim-connect-cycle-12-core-request.md`,
`docs/integration/alim-connect-production-env.template.md`, laporan remediasi Core dari pemilik sistem.

---

## 0. Ringkasan keputusan (baca ini dulu)

| Pertanyaan | Jawaban | Bukti |
| --- | --- | --- |
| Apakah `b3c4fa9f9` basis release yang benar? | **TIDAK.** Commit itu adalah leluhur HEAD dan **31 commit di belakang**. Modul SSO belum ada di sana. | §1.3 |
| Release yang direkomendasikan | Segarkan branch ke `82f5a1ed3` (HEAD sekarang) atau lebih baru, lalu potong tag `v*`. | §1 |
| Apakah rute approval ada di release? | **YA** — `POST /api/approval/requests` sudah ada sejak `b3c4fa9f9`. | §2.1 |
| Apakah rute SSO ada di release? | **YA, tetapi baru sejak `12edf8f37`.** Release berbasis `b3c4fa9f9` **tidak** memiliki `/api/sso/handoff`. | §2.2 |
| Apakah 404 di produksi bisa dijelaskan? | **YA.** Build produksi lebih tua dari `12edf8f37` untuk SSO, dan lebih tua dari `b3c4fa9f9` untuk approval. Detail di §3. | §3 |
| Apakah aman menjalankan migrasi? | **BELUM.** Ledger kosong sementara 33 tabel ada; DDL menunggu keputusan pemilik DB. Dua temuan baru di §5 memperkuat larangan ini. | §5 |
| Kesimpulan kesiapan | Release **belum** siap. Kode sudah diperbaiki; yang tersisa adalah keputusan pemilik produksi dan Core (D1–D9). | §10 |

**Keputusan: JANGAN deploy pada siklus ini.** Kode sudah diremediasi; release menunggu:

1. persetujuan pemilik Core atas **kontrak dan kredensial** (§10 D2, D3),
2. keputusan pemilik DB atas **baseline migrasi** (§10 D4),
3. konfirmasi bahwa **proyek Supabase** boleh dipakai sebagai DB produksi (§10 D5),
4. **host Connect + TLS reverse proxy** (§10 D6).

---

## 1. Release commit yang direkomendasikan

### 1.1 Audit branch / HEAD / tag / worktree

```
git log -1        → 82f5a1ed3  feat(dashboard): use the ALIM Connect mark as the application logo
git branch        → feature/whatsapp-approval-finalization  (remote: gateway/feature/...)
git describe      → sdk/go/v0.12.1-221-g82f5a1ed3
git tag           → v0.8.1 … v0.8.19, v0.9.0 (tidak ada tag di rantai commit approval/SSO)
```

Worktree kotor **hanya** karena pekerjaan siklus ini plus dua file yang bukan milik saya:

```
 M docs/integration/alim-connect-staging-handoff.md     (siklus ini)
 M scripts/alim-core-probe.ts                            (siklus ini)
 M src/main.ts                                           (siklus ini)
 M test/approval-http.e2e-spec.ts                        (siklus ini)
?? LAPORAN-FASE-3-2026-11-20.md                          (bukan milik saya — tidak disentuh)
?? OpenWA/                                               (bukan milik saya — tidak disentuh)
?? docs/integration/alim-connect-cycle-12-core-request.md        (siklus sebelumnya)
?? docs/integration/alim-connect-pdca-cycle-12.md                (siklus sebelumnya)
?? docs/integration/alim-connect-production-env.template.md      (siklus sebelumnya)
?? docs/integration/alim-connect-production-readiness.md         (siklus sebelumnya)
?? src/common/alim-core-approval-proof.spec.ts                   (siklus sebelumnya)
?? src/common/alim-core-probe-verdict.spec.ts                    (siklus sebelumnya)
?? src/config/core-transport-policy.spec.ts                      (siklus sebelumnya)
?? src/config/core-transport-policy.ts                           (siklus sebelumnya)
?? docs/integration/alim-connect-production-remediation-cycle-1.md (dokumen ini)
```

**Tidak ada tag** yang menandai rantai approval/SSO. Ini sendiri temuan: satu-satunya jalan ke produksi adalah
image `sha-<commit>` dari job `docker` di `ci.yml` (hanya pada push ke `main`), atau `v*` lewat `release.yml`.
Branch ini belum punya keduanya.

### 1.2 Commit yang menyediakan setiap bagian integrasi

| Bagian | Commit | Tanggal |
| --- | --- | --- |
| Approval request/commands, klien Core, audit | `b3c4fa9f9` | 2026-11-22 |
| Riwayat command, metrik, runbook | `8c6c92510` | 2026-11-22 |
| **SSO handoff** (modul, klien, halaman, DTO) | **`12edf8f37`** | 2026-11-23 |
| Coverage 4 modul | `7b50bd427` | 2026-11-23 |
| Hardening command path + perbaikan drift skema | `26a0d6189` | 2026-11-23 |
| Lane PG lokal | `61ead34ea` | 2026-11-23 |
| Audit **setiap** command Core | `8df14df7b` | 2026-11-23 |
| `commandId` bertahan di baris audit | `526b6a099` | 2026-11-23 |
| Guard staging diuji terhadap kode | `6bd7e25b7` | 2026-11-23 |
| Audit handoff yang ditolak Connect | `94cd0329e` | 2026-11-23 |
| Reply kutipan → permit yang tepat | `f97038554` | 2026-11-24 |
| Bagian real-Core tidak lagi diam-diam menguji mock | `b400ac68f` | 2026-11-24 |
| Batas waktu wa-version | `493c5559e` | 2026-11-24 |
| Teardown adapter/lifecycle | `c6ea49f4d` | 2026-11-24 |
| Lepas parked work | `b263c17aa` | 2026-11-24 |

`git log --oneline b3c4fa9f9..HEAD -- src/` menghasilkan **14 commit**, dan `git diff --stat b3c4fa9f9..HEAD`
menghasilkan **161 file, +14 943 / −253** untuk seluruh repo (termasuk dashboard dan dokumen).

**Delta yang relevan terhadap rilis:** seluruh `src/modules/sso` (baru), `src/modules/sso` di
`src/app.module.ts`, `apiVersion` di `configuration.ts`, `IDX_approval_commands_retry` guard di migrasi
`1792500000000`, migrasi baru `1792600000000-AddApprovalLookupIndexes`, dua `@Index` baru pada entitas
`ApprovalRequest`, audit per-command, hook `message:sent`, dan penautan kutipan di `f97038554`.

### 1.3 Verdict: `b3c4fa9f9` bukan basis release

Bukti langsung, `git ls-tree b3c4fa9f9 -- src/modules/sso` → **kosong**. Rute SSO:

```
git show 12edf8f37:src/modules/sso/sso-handoff.controller.ts
  → @Controller('sso'); @Get('handoff'); @Post('handoff')
```

Jadi build yang dibuat dari `b3c4fa9f9` **tidak** bisa menjawab `GET/POST /api/sso/handoff` — 404 adalah satu-satunya
kemungkinan. Sebaliknya, `POST /api/approval/requests` sudah ada di `b3c4fa9f9`
(`git show b3c4fa9f9:src/modules/approval/approval.controller.ts` → `@Controller('approval')` + `@Post('requests')`
+ `@UseGuards(ApprovalIngestGuard)`), sehingga 404 pada rute itu berarti build produksi **lebih tua lagi**.

### 1.4 Rekomendasi

Basis release: **`82f5a1ed3`** (HEAD sekarang), atau commit setelahnya pada branch yang sama. Modul SSO sudah
lengkap sejak `12edf8f37`; commit sesudahnya semuanya perbaikan yang justru dibutuhkan produksi
(audit per-command, `commandId` pada baris audit, reply-by-quote, guard retry index, dan dua indeks lookup).

Jangan memotong tag dari `b3c4fa9f9`. Jangan memakai tag `sdk/go/*` untuk image aplikasi.

---

## 2. Bukti bahwa endpoint ada di sumber release

### 2.1 Tabel rute (HEAD `82f5a1ed3`)

Prefix global `api` berasal dari `src/config/app-validation.ts:95` (`app.setGlobalPrefix('api')`), sehingga
nama rute di controller perlu ditambah `/api`.

| Rute HTTP | Sumber | Guard / auth | Kontrak |
| --- | --- | --- | --- |
| `POST /api/approval/requests` | `approval.controller.ts:55` | `ApprovalIngestGuard` (`x-alim-connect-ingest-key`) | Core → Connect |
| `GET /api/approval/requests` | `:84` | `VIEWER` | Dashboard |
| `GET /api/approval/requests/:id` | `:93` | `VIEWER` | Dashboard (+ `?include=commands`) |
| `POST /api/approval/requests/:id/notify` | `:110` | `ADMIN` | Dashboard |
| `POST /api/approval/identities` | `:118` | `ADMIN` | Dashboard |
| `GET /api/sso/handoff` | `sso-handoff.controller.ts:52` | `@Public()`, tanpa throttle | Halaman loading di iframe Core |
| `POST /api/sso/handoff` | `:63` | `@Public()` + allowlist Origin + throttle 5/menit | Core → Connect (form body) |
| `GET /api/health`, `/api/health/live`, `/api/health/ready` | health controller | publik / probe | Docker healthcheck |

`openapi.json` di HEAD memuat `/api/approval/requests`, `/api/approval/requests/{id}`,
`/api/approval/requests/{id}/notify`, `/api/approval/identities`, `/api/sso/handoff`, `/api/health*`.

### 2.2 Rute keluar ke Core (Connect → Core)

| Tujuan | Klien | Header | Metode |
| --- | --- | --- | --- |
| `POST {ALIM_CORE_BASE_URL}/api/connect/v1/approval-commands` | `http-alim-core-approval.client.ts:82` | `X-ALIM-CONNECT-APPROVAL-KEY`, `Idempotency-Key` = `command_id`, `X-ALIM-API-Version` | fetch, timeout `ALIM_CORE_TIMEOUT_MS` |
| `POST {ALIM_CORE_BASE_URL}/api/connect/v1/sso/exchange` | `http-alim-core-sso.client.ts:71` | `X-ALIM-CONNECT-SSO-KEY` | fetch, **tanpa retry**, timeout `ALIM_CONNECT_SSO_TIMEOUT_MS` |

---

## 3. Delta antara sumber release dan produksi

Produksi saat ini: build 21 November. Tiga commit yang relevan terhadap keputusan approval/SSO berlatar tanggal
22–23 November. Maka:

| Gejala yang dilaporkan | Penyebab yang terbukti dari git | Rilis yang menjawab |
| --- | --- | --- |
| `GET /api/sso/handoff` → 404 | build sebelum `12edf8f37` (2026-11-23); `src/modules/sso` belum ada | `≥ 12edf8f37` |
| `POST /api/approval/requests` → 404 | build sebelum `b3c4fa9f9` (2026-11-22); modul approval belum ada | `≥ b3c4fa9f9` |
| `GET /api/sessions` → 401, aset dashboard 21 November | modul lama masih berjalan; tidak ada `SsoModule`/`ApprovalModule` di build | `≥ 12edf8f37` |
| Core URL produksi `http://127.0.0.1:8001` | konfigurasi, bukan kode | §6 + guard baru di `core-transport-policy.ts` |

Modul lama yang masih berjalan **bukan** bukti kode rusak; itu bukti **build yang belum diganti**. Remediasi di
sisi kode pada siklus ini justru memastikan bahwa build lama tidak bisa "kelihatan benar" di produksi: sejak
`src/main.ts` memanggil `assertCoreTransportAllowed`, produksi dengan `ALIM_CORE_BASE_URL=http://127.0.0.1:8001`
akan **gagal boot** dengan pesan yang menyebut nama variabel, bukan menjalankan integrasi ke loopback.

---

## 4. Audit deployment

### 4.1 Artefak yang ada

| Artefak | Isi | Catatan |
| --- | --- | --- |
| `Dockerfile` (multi-stage) | builder `node:22-slim` digest-pinned, `npm ci --include=dev`, `npm run build` + dashboard build; stage produksi `NODE_ENV=production` | build arch-independent; base image di-pin digest |
| `docker-entrypoint.sh` | memperbaiki kepemilikan volume, menjalankan sebagai user `openwa` lewat `gosu` | aman untuk non-root |
| `docker-compose.yml` | `openwa-api` **build dari konteks**, `openwa-data:/app/data`, healthcheck `curl -f http://localhost:2785/api/health/ready`, `stop_grace_period: 75s` | port host `127.0.0.1:${API_PORT:-2785}:2785` |
| `charts/openwa` | StatefulSet + Service + ingress + PDB + Secret + ConfigMap | `image.repository: ghcr.io/rmyndharis/openwa`, `tag: ""` |
| `.github/workflows/ci.yml` | job `docker`: image `sha-<commit>`, tag branch setelah boot-smoke | hanya pada `push` ke `main` |
| `.github/workflows/release.yml` | `on: push: tags: ['v*']`; build → boot-smoke → promote `latest` | satu-satunya jalur `latest` |
| Env forwarding compose | baris 414–435 meneruskan semua `ALIM_*` yang dibutuhkan | `ALIM_CORE_WEB_ORIGIN` dan `ALIM_CORE_API_VERSION` sudah ikut |

### 4.2 Celah deployment yang ditemukan

1. **Compose membangun dari konteks, bukan dari image rilis.** `docker compose up --build` di host produksi akan
   membangun ulang dari worktree apa pun di sana — itu tidak deterministik dan tidak rollback-able. Deployment
   produksi **harus** memakai image digest (mis. `ghcr.io/<repo>:sha-<commit>` atau `@sha256:…`), bukan build lokal.
2. **Tidak ada prosedur rilis/migrasi terpisah.** Migrasi berjalan **di dalam boot** aplikasi
   (`src/database/pg-boot-migrations.ts` → `migrator.runMigrations()` di bawah `pg_advisory_lock`). Maka
   "deploy" pada praktiknya = "start proses baru yang menjalankan migrasi". Konsekuensinya rollback image **tidak**
   membatalkan migrasi. Ini yang membuat migrasi perlu keputusan eksplisit (§5).
3. **Healthcheck** sudah dari dalam container (`localhost:2785`), tepat: tidak bergantung pada port host.
4. **Port host terikat loopback** — benar untuk arsitektur "di belakang reverse proxy TLS". Proxy belum
   terdokumentasi di repo; itu blocker D6.
5. **Tidak ada Redis/MinIO wajib**: keduanya `required: false` di compose. Tidak ada volume yang dihapus oleh
   release.

### 4.3 Strategi rilis yang repeatable, verifiable, rollback-able (belum dijalankan)

Prinsip: **image immutable, konfigurasi terpisah dari image, migrasi diakui sebagai perubahan yang tidak di-rollback
oleh image.**

```
Langkah 0 (pra-rilis, di luar produksi)
  - Branch release = commit yang lolos semua gate (§9).
  - Dokumen daftar variabel produksi terisi lengkap (§6) — nilai diisi di secret store, bukan di repo.

Langkah 1 — build & verifikasi image
  - Image dibangun oleh CI (sha-<commit>), bukan di host.
  - Catat digest image: IMAGE_DIGEST.
  - Tidak ada tag `latest` yang dipakai untuk produksi.

Langkah 2 — backup & verifikasi (WAJIB sebelum boot versi baru)
  - pg_dump (custom format) dari DB data dan DB main; ukuran + checksum dicatat.
  - Salinan `openwa-data` volume (sessions/media/plugins) yang tidak ingin hilang.
  - Restore-verify di instance terpisah (scripts/smoke-test-backup-restore.sh pola), bukan di produksi.
  - Simpan artefak backup + checksum di lokasi terpisah dari host.

Langkah 3 — snapshot ledger SEBELUM boot baru
  - SELECT count(*), min(timestamp), max(timestamp) FROM migrations;   (data conn)
  - SELECT * FROM migrations ORDER BY timestamp;                        (main conn, migrationsTableName default)
  - Catat daftar tabel public sebelum dan sesudah.

Langkah 4 — deploy image baru (satu replika dulu)
  - Set IMAGE_DIGEST, jalankan satu instance.
  - Tunggu /api/health/ready → 200.
  - Boot menjalankan migrasi di bawah advisory lock; kalau gagal, bisnis berhenti di sini (aman: belum ada
    trafik baru yang diteruskan).

Langkah 5 — verifikasi
  - Daftar rute (§2) dijawab: 404→ hilang; guard dijawab (401/403/503, bukan 404).
  - Versi aplikasi yang dilaporkan build = IMAGE_DIGEST.
  - Ledger naik hanya dengan migrasi yang memang baru, tidak ada migrasi lama yang "dijalankan ulang".

Langkah 6 — arahkan trafik penuh, amati, lalu tandai rilis
  - Probe: approval ingest dengan key salah → 401 (bukan 404); SSO handoff dengan Origin salah → 403
    (bukan 503) setelah kredensial diisi.
```

**Rollback:**

| Situasi | Tindakan | Catatan |
| --- | --- | --- |
| Boot baru gagal sebelum trafik | jalankan lagi image lama (`IMAGE_DIGEST` sebelumnya) | migrasi yang sudah terlanjur jalan **tidak** otomatis mundur |
| Versi baru jalan, migrasi menambah kolom/indeks (aditif) | rollback image saja | kolom/indeks ekstra tidak mengganggu versi lama (semua migrasi approval bersifat aditif: §5.3) |
| Versi baru jalan, data perlu mundur | restore backup Langkah 2 | hanya setelah keputusan pemilik DB; **bukan** `migration:revert` di produksi |
| `migration:revert` | **dilarang** untuk siklus ini | `1792400000000` `down()` melakukan `DROP TABLE approval_commands / approval_requests / whatsapp_identities` |

---

## 5. Audit DB dan migrasi

### 5.1 Kondisi yang diketahui (dari siklus sebelumnya, read-only)

- `public.migrations` punya tepat tiga kolom TypeORM (`id`, `timestamp`, `name`) dan **0 baris**, sementara
  `public` berisi **33 tabel**.
- Pemilik `postgres`, `CREATE` benar, `search_path` `"$user", public, extensions`.
- Kode Connect **tidak pernah** mengosongkan ledger: jalur aplikasi hanya `runMigrations()`; tidak ada
  `TRUNCATE`, `DELETE FROM migrations`, atau `synchronize` pada koneksi data di produksi
  (`data-source.ts` memaksa `synchronize: false`, `pg-boot-migrations.ts:108` memaksa `migrationsRun: false`).

Maka ledger kosong berasal dari **luar aplikasi**: skema dibuat tanpa jalur migrasi (mis. dari versi lama dengan
`synchronize`, atau dari restore/kloning), atau ledger disetel ulang/diganti. Ini keputusan pemilik DB.

### 5.2 Migrasi yang menyusun alur approval/SSO

| Migrasi | Sifat | Aman bila dijalankan pada DB yang sudah punya skema? |
| --- | --- | --- |
| `1792400000000-CreateApprovalWorkflow` | membuat 3 tabel baru, guard `hasTable` per tabel | **Ya** — kalau tabel sudah ada, dilewati; tidak menghapus apa pun |
| `1792500000000-AddApprovalCommandRetry` | menambah 3 kolom + 1 indeks, guard `hasColumn`/nama indeks | **Ya** — sejak `26a0d6189` indeks dijaga nama, sehingga tidak gagal "index already exists" |
| `1792600000000-AddApprovalLookupIndexes` | hanya menambah 2 indeks, guard `hasTable` + cek per-indeks | **Ya** — hanya baca; `down()` hanya menjatuhkan indeks yang dibuatnya |

**Tidak ada migrasi baru yang menyentuh tabel lain** untuk integrasi ini. Tidak ada `DROP`/`TRUNCATE` di `up()`.
`down()` hanya berbahaya bila **dipanggil** — dan itu memang dilarang (§4.3).

### 5.3 Temuan baru (belum tercatat di siklus sebelumnya)

**T1 — Dua indeks `approval_commands` tidak pernah dibuat oleh rantai migrasi.** Entitas
`approval-command.entity.ts:21-24` mendeklarasikan 4 indeks, tetapi `1792400000000` hanya membuat 3
(`UQ_approval_commands_command`, `UQ_approval_commands_external_message`, `IDX_approval_commands_request`).
`IDX_approval_commands_retry` hanya muncul di `1792500000000`, yang **melewati** tabel jika
`approval_commands` tidak ada pada saat migrasi itu berjalan. Pada DB yang dibangun dengan skema approval sejak
awal (ledger kosong → ketiga migrasi approval **belum** berjalan), rantai berakhir tanpa indeks retry; lalu
migrasi `1792500000000` tidak akan mengulanginya. Worker retry memakai `status + nextAttemptAt` untuk sweep
(`approval-retry.service.ts`), jadi tanpa indeks itu sweep menjadi pemindaian penuh.

Bukti:
```
git show b3c4fa9f9:src/modules/approval/entities/approval-command.entity.ts | grep @Index
  → 4 indeks, termasuk IDX_approval_commands_retry
git show HEAD:src/database/migrations/1792400000000-CreateApprovalWorkflow.ts | grep "CREATE .*INDEX"
  → hanya 3 (tidak ada retry)
```

Catatan: ini **bukan** regresi rilis ini — sudah ada sejak `b3c4fa9f9`. Ia tidak menghalangi release, tetapi
menjadi **rekomendasi** untuk migrasi normalisasi berikutnya (lihat §10 D8), bukan perubahan DDL pada siklus ini.

**T2 — Gerbang drift migrasi belum mencakup modul approval.** `src/database/migrations/__tests__/migration-drift.spec.ts`
memuat daftar glob entitas secara eksplisit; `src/modules/approval/**` tidak ada di daftar itu. Akibatnya,
drift entitas↔migrasi pada `approval_requests`/`approval_commands` **tidak** akan tertangkap gerbang ini.
Bukti: `grep -ci approval known-migration-drift.json` → `0`, dan daftar entitas di spec berhenti di `division`.
Rekomendasi: tambahkan `join(repoRoot, 'src/modules/approval/**/*.entity{.ts,.js}')` ke `dataConnection()` dan
regenerasi snapshot — sebagai perubahan terpisah, dengan review, karena snapshot akan berubah besarnya.

### 5.4 Baseline: hanya rekomendasi, tidak dieksekusi

Untuk DB yang memiliki 33 tabel tetapi ledger kosong, urutan yang **aman untuk diputuskan pemilik DB** adalah:

1. Backup + restore-verify (Langkah 2 §4.3).
2. Bandingkan daftar tabel/kolom/indeks sebenarnya dengan yang dideklarasikan rantai migrasi (read-only).
3. Putuskan salah satu:
   a. **Fresh start**: buat DB baru dari rantai migrasi, pindahkan data secara terkontrol (bukan pada siklus ini).
   b. **Adopt**: isi ledger dengan semua migrasi yang sudah benar-benar tercermin di skema, lalu jalankan
      migrasi sisanya. Ini **menulis** ke ledger dan karena itu **hanya** boleh atas persetujuan pemilik DB.
4. Jangan pernah "coba-coba" `migration:run` pada DB produksi untuk melihat apa yang terjadi.

---

## 6. Daftar konfigurasi wajib

Sumber template: `docs/integration/alim-connect-production-env.template.md` (tanpa secret).
Nama variabel diverifikasi terhadap `src/config/configuration.ts`, `docker-compose.yml:414-435`, dan guard boot.

### 6.1 Core integration

| Variabel | Wajib di produksi | Aturan | Guard di kode |
| --- | --- | --- | --- |
| `ALIM_CONNECT_CORE_CLIENT` | ya | harus `http` | `assertApprovalCoreClientAllowed` → boot gagal jika `mock` |
| `ALIM_CORE_BASE_URL` | ya | **https** di luar loopback | `assertCoreTransportAllowed` (baru) |
| `ALIM_CORE_APPROVAL_API_KEY` | ya | kunci approval, **berbeda** dari SSO | `assertApprovalCoreClientAllowed` (kosong → boot gagal) |
| `ALIM_CONNECT_SSO_KEY` | ya bila SSO aktif | kunci SSO, `sso:exchange` | tidak ada guard: kosong → SSO 503 |
| `ALIM_CONNECT_INGEST_KEY` | ya | kunci ingest Core → Connect | kosong → `POST /approval/requests` 503 |
| `ALIM_CORE_WEB_ORIGIN` | ya bila SSO aktif | origin persis, https kecuali loopback | `parseCoreWebOrigin` → null (SSO mati) bila tidak valid; `assertCoreTransportAllowed` menolak http non-loopback |
| `ALIM_CORE_APPROVAL_API_HEADER` | tidak | biarkan default `X-ALIM-CONNECT-APPROVAL-KEY` | — |
| `ALIM_CONNECT_SSO_API_HEADER` | tidak | biarkan default `X-ALIM-CONNECT-SSO-KEY` | — |
| `ALIM_CORE_API_VERSION` | tidak | default `1`; kosong = header tidak dikirim | — |
| `ALIM_CORE_TIMEOUT_MS` | tidak | default 5000 | — |
| `ALIM_CONNECT_SSO_TIMEOUT_MS` | tidak | default 5000 | — |
| `ALIM_CONNECT_SSO_AUDIENCE` / `_SCOPE` | tidak | default `connect` / `whatsapp.embed` | respons Core divalidasi terhadap nilai ini |
| `ALIM_CONNECT_RETRY_*` | tidak | default aman | — |

### 6.2 Runtime & keamanan

| Variabel | Wajib | Aturan | Guard di kode |
| --- | --- | --- | --- |
| `NODE_ENV` | **ya, `production`** | tanpa ini semua guard produksi dilewati | `isNodeEnvUnset` → warning |
| `API_MASTER_KEY` | ya (tidak boleh kosong/lemah) | ≥ 32 karakter, bukan nilai default | `assertNoDefaultSecretsInProduction` |
| `CORS_ORIGINS` | ya, eksplisit | wildcard **ditolak** di produksi | `resolveCorsPolicy` |
| `TRUSTED_PROXIES` | ya bila di belakang proxy | IP/CIDR proxy; tanpa ini semua klien berbagi satu bucket rate-limit | `resolveClientIp`, `ProxyAwareThrottlerGuard` |
| `DATABASE_*` | ya | lihat §6.3 | `assertNoDefaultSecretsInProduction` (password lemah) |
| `DATABASE_SSL` / `DATABASE_SSL_REJECT_UNAUTHORIZED` | ya untuk PG terkelola | lihat §6.3 | — |
| `ENABLE_SWAGGER` | tidak | default **off** di produksi | `isSwaggerEnabled` |
| `VALIDATION_ERROR_DETAIL` | tidak | default **off** di produksi | `isValidationErrorDetailEnabled` |
| `ALLOW_DEV_API_KEY` | **harus tidak `true`** | dilarang di produksi | `assertNoDefaultSecretsInProduction` |
| `METRICS_TOKEN` | tidak | bila diisi, bukan placeholder | `assertNoDefaultSecretsInProduction` |
| `MAIN_DATABASE_SYNCHRONIZE` | **harus tidak `true`** | `true` memicu warning; jangan dipakai | `isMainDbSynchronizeInProduction` |

### 6.3 `DATABASE_SSL_REJECT_UNAUTHORIZED=false` dan kredensial

- `DATABASE_SSL_REJECT_UNAUTHORIZED=false` hanya boleh menyertai `DATABASE_SSL=true` dan **hanya** bila rantai
  sertifikat penyedia tidak ada di trust store Node. Itu melemahkan verifikasi sertifikat: siapa pun yang bisa
  mencegat koneksi bisa menyamar sebagai DB. Untuk produksi, jalur yang benar adalah menyediakan CA di trust store
  (`NODE_EXTRA_CA_CERTS`) dan menjaga `REJECT_UNAUTHORIZED=true`. Rekomendasi: **jangan pakai `false` di
  produksi.** (Nilai ini belum diubah; hanya rekomendasi.)
- **Kredensial produksi harus berbeda dari staging**: kunci approval, kunci SSO, ingest, `API_MASTER_KEY`, dan
  password DB. Kunci approval dan SSO **tidak** boleh sama — Core menyempitkannya ke scope berbeda
  (`approval:command` vs `sso:exchange`), dan menjaga pemisahan berarti kebocoran satu kunci tidak membuka yang lain.
- Rotasi ingest key: karena guard membandingkan terhadap **satu** nilai, rotasi berarti (a) set nilai baru di
  Core dan Connect bersamaan, lalu (b) restart Connect. Tidak ada mekanisme "dua kunci aktif". Rekomendasi
  operasional: lakukan rotasi di jendela singkat saat antrean approval kosong, dan catat waktu rotasi di runbook.
- **Jangan pernah** menampilkan nilai secret dalam log/dokumen ini. Semua pemeriksaan di template hanya
  memeriksa **keberadaan**, bukan nilai.

---

## 7. Temuan keamanan

| # | Temuan | Bukti | Tingkat | Status |
| --- | --- | --- | --- | --- |
| S1 | Core di produksi masih `http://127.0.0.1:8001` → kunci dikirim plaintext, dan menunjuk loopback (integrasi tidak akan pernah sampai Core) | konfigurasi produksi; `configuration.ts:581` | **Kritis** | **diremediasi di kode**: `src/config/core-transport-policy.ts` + `src/main.ts:100` → boot gagal di produksi. Nilai produksi sendiri belum diubah (dilarang) |
| S2 | `ALIM_CORE_WEB_ORIGIN` http non-loopback di produksi → siapa pun di jalur bisa menyamar sebagai Core dan memposting kode handoff | `core-web-origin.ts` menerima `http:` | **Tinggi** | **diremediasi di kode**: `insecureCoreOriginReason` + guard boot |
| S3 | Satu kunci dipakai untuk SSO dan approval | riwayat scaffold | **Tinggi** | **sudah dipisah di kode**: `ALIM_CONNECT_SSO_KEY` vs `ALIM_CORE_APPROVAL_API_KEY` (dua jalur config terpisah) |
| S4 | Mock Core bisa `APPROVED` tanpa Core di produksi | `core-client-policy.ts:38` | **Kritis** | **dijaga di kode** (boot gagal); pastikan `ALIM_CONNECT_CORE_CLIENT=http` |
| S5 | Tanpa `TRUSTED_PROXIES`, semua klien berbagi satu bucket rate-limit di belakang proxy | `proxy-aware-throttler.guard.ts:44-64` | **Sedang** | konfigurasi; guard hanya memperingatkan sekali |
| S6 | `DATABASE_SSL_REJECT_UNAUTHORIZED=false` mematikan verifikasi sertifikat DB | §6.3 | **Sedang** | rekomendasi: jangan pakai di produksi |
| S7 | `parseCoreWebOrigin` menerima `http:` untuk host apa pun pada level parser | `core-web-origin.ts:33` | **Rendah** (kini ditutup guard boot) | parser sengaja longgar untuk dev; guard produksi yang menegakkan |
| S8 | SSO handoff menerima kode dari Origin allowlist saja, tanpa token tambahan | `sso-handoff.controller.ts:105` | **Rendah (by design)** | kode sekali pakai milik Core + throttle 5/menit; terdokumentasi di komentar kelas |
| S9 | Baris audit tidak memuat nomor WhatsApp, teks pesan, atau kredensial | `approval-processor.service.ts` `auditCommand()` — hanya `commandId`, `coreRequestId`, `actorCorePersonId` | **Baik** | terverifikasi dari sumber |
| S10 | Log klien SSO tidak memuat kode/kunci | `http-alim-core-sso.client.ts:96,128` — hanya `reason` + status + kode error Core | **Baik** | terverifikasi dari sumber |
| S11 | Image rilis bisa "kelihatan benar" dari build lokal | `docker-compose.yml` `build:` | **Sedang** | prosedur §4.3: deploy mustahil tanpa image digest |
| S12 | Tidak ada tag rilis pada rantai approval/SSO | `git tag` | **Sedang** | proses: potong `v*` setelah approval |

### 7.1 Yang diperiksa dan **tidak** bermasalah

- **Kebocoran secret di audit**: tidak ada.
- **Kebocoran kode handoff di URL**: `GET /api/sso/handoff` tidak menerima kode; `POST` hanya menerima body.
  DTO menolak nilai non-string lewat `@ToStrictString()`.
- **Rate limit handoff**: 5/menit per IP, 20/jam (tier `short`/`medium`).
- **`Cache-Control`, `Referrer-Policy`, `X-Robots-Tag`** di halaman handoff.
- **Binding port container**: `127.0.0.1` di host — tidak terekspos langsung.

---

## 8. Strategi deployment dan rollback

Diringkas dari §4.3. Urutan perintah (placeholder, **belum dijalankan**; isi `<...>` oleh operator):

```
# 0. Prasyarat (di luar produksi)
#    - IMAGE_DIGEST sudah ditetapkan dan diuji di staging
#    - Variabel §6 sudah terisi di secret store

# 1. Backup
pg_dump --format=custom --file=/backup/data-<ts>.dump   "$DATA_DSN"
pg_dump --format=custom --file=/backup/main-<ts>.dump   "$MAIN_DSN"
sha256sum /backup/*.dump > /backup/<ts>.sha256
tar -czf /backup/data-volume-<ts>.tgz -C <volume-path> .

# 2. Snapshot ledger
psql "$DATA_DSN" -c "SELECT count(*), min(timestamp), max(timestamp) FROM migrations;"
psql "$MAIN_DSN" -c "SELECT * FROM migrations ORDER BY timestamp;"

# 3. Deploy image (satu replika)
IMAGE=ghcr.io/<repo>@sha256:<IMAGE_DIGEST> ...
#    (atau: docker compose up -d tanpa --build, dengan image digest di compose override)

# 4. Verifikasi
curl -fsS http://127.0.0.1:2785/api/health/ready
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:2785/api/approval/requests \
     -H 'content-type: application/json' -d '{}'        # harap 401 (bukan 404)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:2785/api/sso/handoff   # harap 200 (bukan 404)

# 5. Rollback image
IMAGE=ghcr.io/<repo>@sha256:<PREVIOUS_DIGEST> ...
#    Migrasi yang sudah berjalan TIDAK ikut mundur (lihat tabel §4.3)
```

---

## 9. Bukti verifikasi

Dijalankan pada siklus ini **tanpa** full Jest suite dan **tanpa** E2E (sesuai batasan).

| Pemeriksaan | Perintah | Hasil |
| --- | --- | --- |
| Guard transport baru, 12 kasus | `NODE_OPTIONS=--max-old-space-size=3072 npx jest src/config/core-transport-policy.spec.ts --runInBand` | `1 suite passed, 12 tests passed, 0.381 s` |
| Suite terkait approval/SSO/config | dijalankan pada siklus sebelumnya | 92 test lulus |
| Dokumentasi env | `npm run test:docs` | 969 lulus (siklus sebelumnya) |
| Lint | `NODE_OPTIONS=--max-old-space-size=3072 npm run lint` | 0 error (siklus sebelumnya) |
| Type check | `npx tsc --noEmit` | 0 error (siklus sebelumnya) |
| Endpoint ada di sumber release | `grep` + `openapi.json` + `git show <commit>:<file>` | §2 |
| `b3c4fa9f9` bukan basis rilis | `git ls-tree b3c4fa9f9 -- src/modules/sso` kosong | §1.3 |
| Migrasi approval aditif | pembacaan `179240…`, `179250…`, `179260…` | §5.2 |
| Indeks retry tidak dibuat rantai | pembacaan entitas vs migrasi | §5.3 T1 |
| Drift gate tidak memuat approval | pembacaan `migration-drift.spec.ts` | §5.3 T2 |

Catatan: satu-satunya tes yang saya jalankan pada siklus ini adalah suite baru `core-transport-policy` (bagian
dari implementasi P6; tidak memerlukan DB, Core, maupun jaringan). Hasilnya ada di baris pertama tabel di atas.
**Status resmi siklus ini adalah "kode diremediasi, bukan diuji ulang penuh".**

Yang **tidak** bisa diverifikasi pada siklus ini, dan alasannya:

- Kontrak Core nyata (P5, replay/duplikat/penolakan) — memerlukan actor terpetakan, permit terbuka, dan kode
  SSO baru (blocker A–C dari `alim-connect-cycle-12-core-request.md`).
- Skema DB produksi vs rantai migrasi — read-only dilarang ke produksi pada siklus ini.
- Perilaku reverse proxy — proxy belum ada di repo/lingkungan.

---

## 10. Blocker yang memerlukan keputusan pemilik sistem

| # | Blocker | Pemilik | Keputusan yang dibutuhkan | Dampak bila tidak diputuskan |
| --- | --- | --- | --- | --- |
| **D1** | Release basis | Tim Connect | Setujui `82f5a1ed3` (atau lebih baru) sebagai basis rilis, dan potong tag `v*` | Tidak ada tag → tidak ada image `latest` → produksi tidak bisa diperbarui secara terkontrol |
| **D2** | Kontrak Core | Pemilik Core | Konfirmasi: `Idempotency-Key` = `command_id`, `X-ALIM-API-Version: 1`, replay identik → `duplicate`, payload berbeda dengan id sama → ditolak, `external_message_id` dipakai ulang → ditolak, format `actor_external_id` | Tanpa konfirmasi, P5 tidak bisa dinyatakan lulus; Connect hanya bisa membuktikan bahwa ia **mengirim** header/field, bukan bahwa Core memvalidasinya |
| **D3** | Kredensial produksi | Pemilik Core + Tim Connect | Terbitkan kunci approval, kunci SSO, dan ingest produksi (**berbeda** dari staging) | `POST /approval/requests` → 503, SSO → 503; approval ke Core → `core_not_configured` |
| **D4** | Baseline migrasi | Pemilik DB | Putuskan: (a) DB baru dari rantai migrasi, atau (b) "adopt" ledger; termasuk siapa yang mengeksekusi DDL | Tanpa ini, boot baru **tidak boleh** dijalankan terhadap DB existing; ledger kosong + 33 tabel tidak aman dicoba-coba |
| **D5** | Proyek Supabase sebagai DB produksi | Pemilik sistem | Konfirmasi bahwa proyek (dengan auth/storage/realtime/vault) boleh menjadi DB produksi Connect, atau pindahkan ke DB khusus | Jika tidak boleh, D4 berlaku untuk DB tujuan yang baru |
| **D6** | Host Connect + TLS proxy | Tim Ops | Tentukan hostname publik, TLS termination, dan `TRUSTED_PROXIES` (IP/CIDR proxy) | Tanpa `TRUSTED_PROXIES` rate-limit salah; tanpa TLS, handoff membawa kode lewat jaringan |
| **D7** | `API_MASTER_KEY`, `CORS_ORIGINS` produksi | Tim Ops | Nilai master key (≥32 karakter) di secret store; daftar origin dashboard eksplisit | Tanpa master key kuat → boot gagal (sejak guard ada); CORS wildcard → ditolak di produksi |
| **D8** | Indeks `IDX_approval_commands_retry` tidak dibuat rantai (§5.3 T1) | Tim Connect | Setujui migrasi normalisasi terpisah pada siklus berikutnya | Bukan blocker rilis; worker retry lebih lambat tanpa indeks |
| **D9** | Drift gate tidak memuat approval (§5.3 T2) | Tim Connect | Setujui penambahan glob entitas approval + regenerasi snapshot | Bukan blocker rilis; risiko drift approval tidak tertangkap gerbang |

---

## Lampiran A — Yang diubah pada siklus ini

Hanya **satu** perubahan kode yang menambah perilaku produksi (guard transport), dan itu pun sudah ada di
worktree sebelum pergantian konteks; sisanya dokumen:

| File | Perubahan | Sifat |
| --- | --- | --- |
| `src/config/core-transport-policy.ts` | guard produksi: tolak `http://` untuk Core kecuali loopback; tolak origin http non-loopback | kode |
| `src/config/core-transport-policy.spec.ts` | 12 test | test |
| `src/main.ts` | panggilan guard sebelum `assertNoDefaultSecretsInProduction` | kode |
| `docs/integration/alim-connect-production-remediation-cycle-1.md` | dokumen ini | dokumen |

**Tidak disentuh**: `LAPORAN-FASE-3-2026-11-20.md`, `OpenWA/`, `.env` produksi, migrasi, kontrak OpenAPI,
`b3c4fa9f9`.

## Lampiran B — Perintah yang **tidak** dijalankan (dan mengapa)

| Perintah | Alasan |
| --- | --- |
| `npm test` / full Jest | dilarang eksplisit untuk siklus ini |
| `test:pg-lane`, `test:pg-approval` | tidak ada perubahan skema; DDL menunggu D4 |
| `migration:run` terhadap DB apa pun | DDL dilarang sebelum D4 |
| `git commit` / `push` / tag | menunggu instruksi terpisah |
| `docker compose up` / deploy | dilarang |
| Panggilan ke Core produksi | dilarang |
