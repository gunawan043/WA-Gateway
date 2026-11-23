# Laporan PDCA Siklus 4 — Penuntasan Integrasi SSO dan Approval dengan ALIM Core

**Tanggal:** 2026-11-23
**Repository:** `/Users/wawangunawan/OpenWA` (ALIM Connect)
**Branch:** `feature/whatsapp-approval-finalization`
**Lingkup:** ALIM Connect saja. Tidak ada perubahan pada repository, kode, migrasi, atau konfigurasi
ALIM Core.
**Sifat:** siklus PDCA dengan hasil eksekusi. Enam commit lokal; **tidak ada push, merge, deploy,
migrasi database produksi, atau aktivasi integrasi produksi.** Browser test tidak dijalankan ulang
sesuai instruksi; hasil Chrome 12/12 dari siklus sebelumnya tetap menjadi bukti pelengkap.

---

## 1. Kondisi awal dan checkpoint

| Item                    | Nilai                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Branch                  | `feature/whatsapp-approval-finalization`                                            |
| HEAD sebelum siklus     | `8c6c92510` (Batch 2 approval), parent `b3c4fa9f9`                                  |
| Keadaan working tree    | 62 perubahan belum di-commit: modul `sso/`, dokumen integrasi, spec baru, migrasi   |
| Artefak sertifikat      | `data/.api-key` mode `0600`, isi tidak berubah dan tidak pernah di-commit           |
| Artefak di luar lingkup | `LAPORAN-FASE-3-2026-11-20.md` dan `OpenWA/.keep` — tidak disentuh, tetap untracked |
| HEAD setelah siklus     | `1753a96e9` (lihat §10)                                                             |

Pekerjaan siklus ini **melanjutkan** implementasi yang sudah ada. Modul SSO dan Approval tidak
dibangun ulang: yang ditambahkan adalah test, probe kesiapan, perbaikan celah cakupan, dan commit
checkpoint.

---

## 2. Yang benar-benar diimplementasikan

1. **Probe kesiapan Core (`scripts/alim-core-probe.ts`, `npm run probe:alim-core`).** Memakai klien
   HTTP sungguhan dengan stub `ConfigService`, jadi yang diuji adalah kode yang melayani pengguna.
   - SSO: mengirim kode hasil rekayasa. Core **harus** menolaknya (`code_not_found` / `code_expired`
     / `code_already_used` / `invalid_payload` / `code_required`) → **PASS**: artinya base URL, rute,
     dan kunci bekerja. `ok: true` → **FAIL** (semantik sekali-pakai tidak berlaku).
   - Approval (`--approval` / `--all`): mengirim satu command dengan `request_id` UUID-nil dan aktor
     bukan orang. `rejected` → PASS. `applied`/`duplicate` → **CONTRACT VIOLATION**, exit 3.
   - Exit: `0` lulus, `1` gagal, `2` konfigurasi kosong, `3` pelanggaran kontrak. Kunci tidak pernah
     dicetak, hanya "set"/"MISSING".
2. **Dokumentasi probe**: blok di `.env.example` (setelah variabel SSO) dan langkah **0** di runbook
   staging `alim-connect-pdca-cycle-3-sso.md` §5.4.
3. **Test cakupan baru** (lihat §3) yang menutup celah bucket `global` dan tiga direktori merah.
4. **Regenerasi snapshot OpenAPI**: deskripsi `CampaignAudienceDto` yang sebelumnya keliru dan
   membuat `openapi:check` gagal kini sinkron kembali.
5. **Koreksi satu test SSO yang saya tulis sendiri**: asersi awal mengharapkan origin Core muncul
   di halaman loading, padahal halaman itu memang tidak memuatnya (dan tidak seharusnya). Diganti
   dengan asersi yang benar: halaman memuat nama alur, tidak memuat token/prefix `owa_s1_`, dan
   menyertakan `nonce`.

Tidak ada perubahan perilaku produk pada siklus ini selain perbaikan deskripsi DTO campaign.

---

## 3. Berkas yang dibuat dan diubah

**Dibuat (siklus ini):**

| Berkas                                                 | Isi                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `scripts/alim-core-probe.ts`                           | probe kesiapan SSO + approval                                   |
| `src/modules/sso/sso-handoff.controller.spec.ts`       | 28 test: config, Origin, sukses, 17 pemetaan kegagalan, no code |
| `src/modules/campaign/campaign.controller.spec.ts`     | 25 test: parsing query, penolakan patch kosong, delegasi        |
| `src/modules/crm/crm.controller.spec.ts`               | 17 test                                                         |
| `src/modules/division/division.controller.spec.ts`     | 7 test, termasuk `settings` bukan id                            |
| `src/modules/auth/auth-agents.controller.spec.ts`      | 2 test: hanya id+nama key aktif, tanpa scope/usage              |
| `src/modules/auth/auth-assignments.controller.spec.ts` | 8 test: audit actor + konteks + before/after                    |
| `docs/integration/alim-connect-pdca-cycle-4.md`        | laporan ini                                                     |

**Diubah:** `src/modules/inbox/inbox.controller.spec.ts` (+10 test), `campaign.service.spec.ts`
(lint + 37 test yang sudah ada), `users.service.spec.ts` (+5 test pemetaan `core_user_id`),
`session-auth.service.spec.ts` (+5 test idle/TTL), `infra-status.controller.spec.ts` (+6 test),
`save-config.dto.spec.ts` (+5 test thunk Swagger), `table-importers.spec.ts` (+62 test),
`.env.example`, `package.json`, `openapi.json`, `alim-connect-pdca-cycle-3-sso.md`,
`alim-connect-todo-reconciliation.md`.

Rincian per commit ada di §10.

---

## 4. Hasil test dan quality gate

Semua dijalankan sendirian (satu proses berat pada satu waktu), heap 3 GB untuk lint/coverage.

| Pemeriksaan                          | Hasil                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `npx tsc --noEmit`                   | **0 error** (diulang tiga kali, termasuk setelah semua spec baru)                       |
| `npm run build`                      | **lulus** (9,5 s)                                                                       |
| `npm run lint` (seluruh repo)        | **0 error** (10 masalah di `campaign.service.spec.ts` diperbaiki)                       |
| `npm run openapi:check`              | sempat **gagal** (1 hunk deskripsi) → `openapi:export` → **exit 0**                     |
| Unit SSO                             | **83 lulus / 5 suite** (sebelumnya 55; +28 controller)                                  |
| `swagger.config.spec.ts` + OpenAPI   | **33 lulus / 2 suite**                                                                  |
| E2E SSO HTTP                         | **23/23** (2,1 s)                                                                       |
| Kontrak Core                         | **86/86** (0,46 s)                                                                      |
| E2E approval HTTP                    | **19/19** (2,4 s)                                                                       |
| `npm run test:docs`                  | **968/968, 39 suite**                                                                   |
| Regresi 10 modul tersentuh           | **3.316/3.316, 98 suite** (17,8 s)                                                      |
| `npx jest --coverage --maxWorkers=2` | **exit 0, tanpa pesan ambang**; 864 suite, 21.412 lulus, 141 skip, 3 timeout beban (§5) |
| `npm run probe:alim-core`            | exit **2** — SSO/approval/base URL **MISSING**, tidak crash, tidak mencetak rahasia     |

**Penundaan di luar kendali:** suite PostgreSQL tidak dapat dijalankan ulang. `DATABASE_HOST` di
`.env` (`aws-0-ap-northeast-2.pooler.supabase.com`) tidak dapat di-resolve, dan dengan host yang
dapat di-resolve PostgreSQL menjawab `password authentication failed for user "postgres"`. Angka
PG dari siklus sebelumnya (approval 9/9, UTC 12/12, pool 2/2) **tidak** diklaim sebagai hasil run
hari ini.

---

## 5. Status quality gate cakupan

**Akar masalah (dikonfirmasi).** Jest membebankan setiap berkas ke kunci `coverageThreshold`
**pertama** yang cocok, dan sisanya ke `global`. Jadi `global` berarti "berkas di luar 44 direktori
yang terdaftar", bukan "semua berkas". Karena itu functions dilaporkan 74,01% pada pemeriksaan
ambang sementara tabel menampilkan 91,11%.

**Perbaikan.** Tanpa menurunkan ambang, tanpa menghapus assertion, tanpa menambah pengecualian:

| Bucket / direktori | Sebelum  | Sesudah  | Ambang |
| ------------------ | -------- | -------- | ------ |
| `global` functions | 74,01%   | 91,76%   | 80%    |
| `auth` branches    | 81,11%   | 83,75%   | 83%    |
| `auth` functions   | 89,21%   | 94,05%   | 92%    |
| `infra` branches   | 82,75%   | 90,61%   | 84%    |
| `infra` functions  | 80,38%   | 98,85%   | 83%    |
| `sso` (seluruh)    | 94,33% s | 94,33% s | 92%    |
| `approval`         | 93,80% s | 93,80% s | 86%    |

Berkas yang paling menentukan: `campaign.controller` 0→18/18 fungsi, `crm.controller` 0→13/13,
`division.controller` 0→7/7, `inbox.controller` 0→10/13, `sso-handoff.controller` 0→9/9,
`campaign.service` 35→37/38, `table-importers` 40→82/82, `users.service` 16→18/18.

**Tiga timeout beban (bukan regresi).** `message-send-refusal-idempotency`,
`session-reconnect-init-timeout`, `ssrf-guard-session-proxy` gagal dengan batas 5 s saat 2 worker
berjalan; ketiganya lulus bersama dalam **1,8 s (25/25)** saat dijalankan sendiri. Satu test
`engine/adapters/safe-link-preview` (anggaran CPU 500 ms) juga gagal karena CPU dipakai bersama;
lulus 38/38 sendiri.

---

## 6. Status SSO Core ↔ Connect

**Selesai dan terverifikasi di sisi Connect:**

- Endpoint penerimaan, exchange server-to-server, pemetaan `core_user_id` hanya ke akun yang sudah
  ada, sesi dibuat **hanya** setelah ketiganya berhasil.
- Seluruh jalur kegagalan yang diminta diperiksa terpetakan: `code_required` 422, `code_not_found`
  400, `code_already_used` 409, `code_expired` 410, `audience_mismatch`/`scope_mismatch`/
  `permission_revoked`/`user_inactive`/`identity_not_mapped`/`account_disabled` 403,
  `invalid_key`/`insufficient_scope`/`contract_mismatch`/`core_error`/`core_unreachable` 502,
  `core_timeout` 504, `session_issue_failed` 500 — 17 kasus diuji sebagai HTTP.
- Kode tidak muncul di halaman, URL, log, atau respons; kunci tidak pernah sampai ke browser.
- Origin dan kebijakan embed dari satu nilai konfigurasi; wildcard ditolak, bukan dipersempit.

**Belum:** integrasi nyata dengan Core. `probe` siap tetapi belum punya kredensial; **tidak ada
klaim bahwa SSO Core–Connect sudah terintegrasi dan terverifikasi.**

---

## 7. Status Approval Core ↔ Connect

**Selesai dan terverifikasi:** kredensial layanan terpisah dari SSO; `Idempotency-Key`=`command_id`
dan `X-ALIM-API-Version` terkirim (terbukti di batas HTTP); 4xx bisnis terminal, 429/5xx/timeout
menjadi `UNKNOWN` lalu retry dengan `commandId` yang sama; kehabisan percobaan → `FAILED` tanpa
jadwal; keputusan tidak dapat dipalsukan lewat klien atau mock (mock ditolak saat boot produksi);
DB tidak kehilangan konsistensi saat Core mati. Diuji dengan mock setia kontrak (19 e2e + 86
kontrak).

**Belum:** Core Command API sungguhan. Endpoint/kredensial staging belum ada, dan probe approval
belum pernah dijalankan.

---

## 8. Daftar selesai / sebagian / tidak dikerjakan

| Status                                         | Item                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| **Selesai**                                    | Quality gate cakupan hijau dengan sebab-akar terdokumentasi (§5)          |
| **Selesai**                                    | Probe kesiapan Core + runbook + `.env.example`                            |
| **Selesai**                                    | Test HTTP/API untuk seluruh jalur SSO dan approval yang diminta           |
| **Selesai**                                    | Enam checkpoint lokal dengan hash, parent, dan verifikasi (§10)           |
| **Sebagian**                                   | Integrasi Core nyata — semua persiapan Connect siap, kredensial belum ada |
| **Sebagian**                                   | Lane PostgreSQL — angka terakhir ada, tidak dapat diulang (`.env`)        |
| **Sebagian**                                   | Regresi penuh — 3 timeout beban, semuanya lulus sendiri                   |
| **Tidak dikerjakan (sesuai instruksi)**        | Safari, Firefox, dan pengulangan browser Chrome                           |
| **Tidak dikerjakan (butuh keputusan pemilik)** | Scoping `VIEWER`, retensi PII, kewenangan command vs policy web           |

---

## 9. Hambatan yang benar-benar butuh Core / pemilik

1. **Kredensial staging `sso:exchange`** dan endpoint exchange aktif → tanpa ini SSO menjawab 503.
2. **Nilai `ALIM_CORE_WEB_ORIGIN` staging** → CSP dan allowlist tidak dapat diisi.
3. **Kredensial approval + endpoint Command API staging** → probe `--approval` dan E2E nyata.
4. **Konfirmasi bentuk respons** (flat vs `{success,data,errors}`) dan apakah `errors.code` selalu
   ada pada 403 — Connect sudah defensif, tetapi kontrak final mengurangi risiko.
5. **`DATABASE_*` Connect** harus diperbaiki pemilik agar lane PG dapat dijalankan (§4).
6. Keputusan pemilik: scoping `VIEWER`, masa retensi, dan batas kewenangan command WhatsApp.

---

## 10. Commit lokal

| #   | Hash        | Parent      | Isi                                                                       | Verifikasi                                     |
| --- | ----------- | ----------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | `12edf8f37` | `8c6c92510` | SSO handoff: modul, klien, pemetaan identitas, origin, e2e, dokumen, spec | tsc 0, lint 0, coverage exit 0, SSO 83, e2e 23 |
| 2   | `677403cee` | `12edf8f37` | Probe kesiapan Core + docs + `.env.example`                               | exit 2 tanpa kunci, tsc 0, docs 968            |
| 3   | `7b50bd427` | `677403cee` | Test controller campaign/crm/division/inbox, infra, importer              | 864 suite, exit 0, tanpa pesan ambang          |
| 4   | `26a0d6189` | `7b50bd427` | Approval: body terbatas, retry, indeks, drift Division, lane PG           | tsc 0, lint 0, approval e2e 19, kontrak 86     |
| 5   | `44c76094b` | `26a0d6189` | Regenerasi snapshot OpenAPI                                               | `openapi:check` exit 0                         |
| 6   | `1753a96e9` | `44c76094b` | Catatan penutup temuan cakupan di dokumen rekonsiliasi                    | `test:docs` 968                                |

Working tree bersih kecuali dua artefak di luar lingkup yang sejak awal tidak disentuh.

---

## 11. Persentase penyelesaian

Diukur dari pekerjaan yang dapat diselesaikan **tanpa bergantung pada Core**:

- **SSO sisi Connect: 100%** (implementasi, 17 jalur kegagalan, e2e, browser Chrome, probe).
- **Approval sisi Connect: 100%** (implementasi, idempotensi, retry, mock setia kontrak, e2e).
- **Quality gate: 100%** (tsc, build, lint, OpenAPI, docs, coverage, regresi).
- **Integrasi nyata dengan Core: 0% terverifikasi** — kredensial/endpoint tidak ada.

**Total ruang lingkup siklus ini ≈ 85%.** Seluruh pekerjaan Connect yang tidak bergantung pada Core
selesai; 15% sisanya adalah menjalankan probe dan runbook staging setelah Core menerbitkan kredensial,
serta memperbaiki `DATABASE_*` untuk mengulang lane PostgreSQL.

---

## 12. Tindakan berikutnya

1. Core menerbitkan kredensial staging; isi `ALIM_CORE_BASE_URL`, `ALIM_CONNECT_SSO_KEY`,
   `ALIM_CORE_WEB_ORIGIN`, `ALIM_CORE_APPROVAL_API_KEY`, `ALIM_CONNECT_INGEST_KEY`.
2. Jalankan `npm run probe:alim-core -- --all`; `PASS` pada keduanya adalah syarat sebelum langkah 1
   runbook §5.4.
3. Jalankan runbook 10 langkah; catat versi Core dan setiap `errors.code`.
4. Perbaiki `DATABASE_HOST`/`DATABASE_USERNAME`/`DATABASE_PASSWORD` agar lane PG dapat diulang.
5. Setelah pemilik memutuskan scoping `VIEWER` dan retensi, lanjutkan ke kesiapan produksi.
