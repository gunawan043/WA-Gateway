# Laporan PDCA Siklus 5 — Integrasi Nyata dengan ALIM Core

**Tanggal:** 2026-11-23
**Repository:** `/Users/wawangunawan/OpenWA` (ALIM Connect)
**Branch:** `feature/whatsapp-approval-finalization`
**Lingkup:** ALIM Connect saja. Tidak ada perubahan pada repository, kode, migrasi, atau konfigurasi
ALIM Core.
**Sifat:** siklus PDCA dengan hasil eksekusi (Plan → Do → Check → Act). Dua commit checkpoint lokal;
**tidak ada push, merge, deploy, atau perubahan database produksi.** Browser test tetap di-skip
sesuai instruksi.

---

## 1. Rekonsiliasi Git

| Item                | Nilai                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch              | `feature/whatsapp-approval-finalization`                                                                                                                                                                       |
| HEAD sebelum siklus | `2bd2174d1` (laporan siklus 4), parent `1753a96e9`                                                                                                                                                             |
| Rantai tujuh commit | `2bd2174d1` ← `1753a96e9` ← `44c76094b` ← `26a0d6189` ← `7b50bd427` ← `677403cee` ← `12edf8f37` ← `8c6c92510` ← `b3c4fa9f9`                                                                                    |
| Artefak siklus 4    | Terverifikasi ada di `2bd2174d1`: `scripts/alim-core-probe.ts`, `src/modules/sso/sso-handoff.controller.spec.ts`, `src/modules/infra/table-importers.spec.ts`, `docs/integration/alim-connect-pdca-cycle-4.md` |
| Working tree        | Bersih kecuali dua artefak di luar lingkup: `LAPORAN-FASE-3-2026-11-20.md`, `OpenWA/.keep`                                                                                                                     |

Semua hasil siklus 4 memang tersimpan. Tidak ada pekerjaan yang diulang.

---

## 2. PostgreSQL: dari tidak dapat dijalankan menjadi hijau penuh

### 2.1 Akar masalah, diperiksa setahap demi setahap

| Pemeriksaan                  | Hasil                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_HOST` di `.env`    | `aws-0-ap-northeast-2.pooler.supabase.com` → **NXDOMAIN**. Pola host pooler yang sah adalah `aws-N-<region>.pooler.supabase.com`; nama ini tidak cocok       |
| `DATABASE_USERNAME`          | `postgres.<project-ref>` (bentuk pooler), `DATABASE_PASSWORD` dikutip `'…'`                                                                                  |
| Autentikasi dengan host lain | `password authentication failed` — kredensial **tidak** dapat dipakai                                                                                        |
| Sumber konfigurasi Jest      | Suite `*.pg.spec.ts` membaca `process.env.DATABASE_*` **langsung**; tidak ada `dotenv`. Jadi mengekspor variabel adalah jalur yang didukung, sama seperti CI |

**Kesimpulan:** blok `DATABASE_*` di `.env` tidak dapat dipakai. Sesuai instruksi, integrasi tidak
diarahkan ke kredensial produksi dan database produksi tidak disentuh sama sekali.

### 2.2 Konfigurasi pengujian lokal yang aman

`scripts/pg-local.ts` — klaster PostgreSQL 16 sekali pakai, **khusus lane ini**:

- Binari dari tarball rilis `theseus-rs/postgresql-binaries` (`16.16.0`) ke `.cache/postgres/bin`,
  dan `.cache/` sudah ada di `.gitignore` sehingga tidak pernah ter-commit.
- `initdb` dengan **locale default server** (seperti service `postgres:16-alpine` di CI), role /
  password / database semuanya `openwa`, `scram-sha-256`, hanya `127.0.0.1`.
- **Tidak membaca `.env`** — kredensial managed tidak pernah dikirim ke mana pun.
- `--start` sekarang benar-benar meninggalkan server berjalan setelah inisialisasi pertama, dan
  membangun ulang direktori yang `initdb`-nya tidak selesai (dulu mode `--start` berhenti setelah
  `initdb` dan menyisakan klaster mati).
- `--reset`, `--stop`, `--status`; port 5432, atau port bebas berikutnya bila sibuk.

### 2.3 Hasil lane PostgreSQL

Perintah: `npm run pg:local:start`, lalu ekspor baris yang dicetaknya, lalu `npm run test:pg-lane`
(14 suite, `TZ=Asia/Jakarta`, `--runInBand`).

| Percobaan                          | Hasil                                     |
| ---------------------------------- | ----------------------------------------- |
| Sebelum perbaikan                  | **42 gagal / 87 lulus** — 4 suite merah   |
| Setelah perbaikan, 3 kali berturut | **134 lulus, 0 skip, exit 0** (seed 26 s) |

**Dua penyebab kegagalan, keduanya bug test, bukan bug aplikasi:**

1. **Registri export vs metadata entity.** `EXPORT_TABLES` sudah memuat `divisions`,
   `division_*`, `approval_requests`, `approval_commands`, `whatsapp_identities`, tetapi tiga suite
   membangun daftar `entities` sendiri yang tidak memuat tabel-tabel itu. `exportData()` — dengan
   benar — menolak (`export-data: table "divisions" … entity metadata does not know it`). Ketiga
   suite kini memakai himpunan entity yang sama dengan koneksi data aplikasi.
2. **Aturan istilah FTS bergantung pada ctype database.** Suite FTS menguji database ber-ctype C,
   tetapi database yang didapat mewarisi default server. Pada server ber-locale C, `postgresCanIndex`
   memakai jalur ASCII untuk semua database, sehingga `안녕`/`¹²³` ditolak dengan pesan "ASCII".
   Suite kini **membaca ctype yang benar-benar dimiliki** dan melewati asersi default-ctype di server
   C (suite ctype-C sudah menguji server itu). Diverifikasi: **17/17 lulus** terhadap server
   non-C sungguhan, dan tetap 17/17 di server C.

> Dua suite juga butuh `pg_dump` dan `psql`; tanpanya keduanya **men-skip dirinya sendiri**, dan
> suite yang skip bukan suite yang lulus. Karena itu `pg-local` kini mencetak baris `export PATH=…`
> juga. Dengan itu lane berjalan **tanpa satu pun skip**.

---

## 3. SSO: kesiapan integrasi

Tanpa membangun ulang, yang diverifikasi ulang dan ditambah:

- Rute penerimaan `/sso/handoff`: allowlist Origin + throttle (5/menit, 20/jam per IP) → `POST
/api/connect/v1/sso/exchange` server-to-server dengan `X-ALIM-CONNECT-SSO-KEY`.
- Pertukaran kontrak: klien menerima body datar **dan** amplop `{success,data,errors}`;
  `core_user_id` wajib ada pada sukses.
- Pemetaan identitas: `users.coreUserId`, **tanpa** pembuatan akun otomatis.
- Sesi: `user_sessions` ditulis hanya setelah pertukaran berhasil; expiry, logout, dan idle TTL
  diuji sebagai unit (`session-auth.service.spec.ts`).
- **Tidak ada retry**; timeout → `core_timeout`, koneksi gagal → `core_unreachable`.

**Yang belum ada dan tidak dapat dibuat dari sisi Connect:** `ALIM_CORE_BASE_URL`,
`ALIM_CONNECT_SSO_KEY`, `ALIM_CORE_WEB_ORIGIN` (staging).

---

## 4. Approval: kesiapan integrasi

- Klien command dengan `Idempotency-Key` = `command_id` dan `X-ALIM-API-Version` (default `1`,
  tidak dikirim bila kosong).
- Kredensial layanan approval **terpisah** dari SSO (`ALIM_CORE_APPROVAL_API_KEY`).
- 4xx bisnis → `REJECTED`, terminal, tanpa retry. 429/5xx/timeout → `unavailable`/`UNKNOWN` lalu
  retry dengan `commandId` yang sama. `duplicate` / `outcome: duplicate` diterima.
- Identitas aktor: `targetCorePersonId`/`targetIdentity` dibekukan setelah permit meninggalkan
  `PENDING_APPROVAL`; nomor yang tidak dapat dinormalkan ditolak.
- Pemetaan galat, audit trail, lease per baris, dan backoff terbatas diuji sebagai unit dan PG.

**Yang belum ada:** `ALIM_CORE_BASE_URL`, `ALIM_CORE_APPROVAL_API_KEY` staging.

---

## 5. Lane integrasi nyata: satu perintah, menolak berpura-pura

Masalah yang ditutup: sesi E2E dunia-nyata **men-skip dirinya sendiri** tanpa kredensial, dan run
yang seluruhnya skip terbaca sama seperti run yang lulus.

`scripts/alim-core-integration-lane.ts` (`npm run test:core-integration`):

- Melaporkan mana dari `ALIM_CORE_BASE_URL`, `ALIM_CONNECT_SSO_KEY`, `ALIM_CORE_APPROVAL_API_KEY`
  yang tersedia — **nama saja, tidak pernah nilai**.
- Bila ada yang kosong → **exit 2** dan menyatakan tidak ada yang dijalankan.
- Bila tersedia → menjalankan kedua suite E2E secara serial, termasuk `--sso-code=<kode>`.
- `npm run test:core-integration:lane` memeriksa hal ini tanpa menjalankan suite.

Tambahan pada suite E2E (aktif hanya bila kredensial ada):

- **SSO:** kode rekaan **harus** ditolak Core sebagai penolakan bisnis 4xx dan tidak membuka sesi;
  kode dan kunci tidak boleh muncul di stdout/stderr.
- **Approval:** satu permohonan, satu balasan WhatsApp, satu command; `commandId`, status,
  `attempts`, `coreResponseCode`, `errorCode`, dan status permohonan dicetak satu baris untuk bukti.
- **Probe:** `--sso-code=` menukar kode yang dipegang pemanggil. Probe yang **mereka-reka** kode dan
  tetap dijawab Core dicatat sebagai **pelanggaran kontrak**, bukan lulus.

**Bukti hari ini:** guard keluar **2** dan tidak menjalankan apa pun. Ketiga bagian Core pada E2E
masih **skip**. Integrasi nyata **0% terverifikasi** — dan itu dinyatakan apa adanya.

---

## 6. Quality gate (satu proses berat pada satu waktu, heap 3 GB)

| Pemeriksaan                          | Hasil                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `npx tsc --noEmit`                   | **0 error** (menemukan `randomUUID` yang belum diimpor di spec SSO e2e — diperbaiki) |
| `npm run lint`                       | **0 error** (88 s)                                                                   |
| `npm run build`                      | **lulus**                                                                            |
| `npm run openapi:check`              | **exit 0** (202 path)                                                                |
| `npm run test:contracts`             | **86/86**, 2 suite                                                                   |
| E2E SSO + Approval                   | **42 lulus, 3 skip** (hanya bagian Core nyata)                                       |
| Lane PostgreSQL                      | **134/134, 0 skip**, 14 suite, exit 0                                                |
| `npm run test:docs`                  | **968/968**, 39 suite                                                                |
| Regresi 5 modul tersentuh            | **3.996/3.996**, 97 suite                                                            |
| `npx jest --coverage --maxWorkers=2` | **exit 0**, tanpa pesan ambang; **864 suite, 21.415 lulus**, 141 skip (7m20s)        |

Ambang cakupan dari siklus 4 **tidak diubah, tidak diturunkan, tidak dikecualikan**.

---

## 7. Daftar selesai / sebagian / tidak dikerjakan

| Status                                  | Item                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| **Selesai**                             | Lane PostgreSQL berjalan dan hijau penuh (134/134, 0 skip, 3x berturut)               |
| **Selesai**                             | Konfigurasi PG lokal yang aman, tidak menyentuh produksi, `.cache/` di-ignore         |
| **Selesai**                             | Lane integrasi Core + guard yang menolak klaim kesiapan palsu                         |
| **Selesai**                             | Bukti E2E dunia-nyata untuk SSO dan Approval yang siap dijalankan saat kredensial ada |
| **Selesai**                             | Seluruh quality gate hijau dengan ambang tidak berubah                                |
| **Selesai**                             | Dokumen ini + dua commit checkpoint lokal                                             |
| **Sebagian**                            | Integrasi nyata Core — persiapan Connect siap, kredensial staging belum ada           |
| **Tidak dikerjakan (sesuai instruksi)** | Browser test (Chrome/Safari/Firefox)                                                  |

---

## 8. Hambatan yang butuh Core / pemilik

1. **Endpoint + kredensial staging SSO** (`ALIM_CORE_BASE_URL`, `ALIM_CONNECT_SSO_KEY`).
2. **Nilai `ALIM_CORE_WEB_ORIGIN` staging** untuk allowlist dan CSP.
3. **Endpoint + kredensial Command API staging** (`ALIM_CORE_APPROVAL_API_KEY`).
4. **`ALIM_CONNECT_INGEST_KEY`** untuk rute penerimaan dari Core.
5. **`DATABASE_*` Connect** tetap tidak dapat dipakai. Lane PG kini mandiri lewat `pg-local`; kalau
   pemilik ingin lane memakai PostgreSQL terkelola, kredensialnya perlu diperbaiki.
6. Keputusan pemilik: scoping `VIEWER`, retensi PII, dan batas kewenangan command WhatsApp.

---

## 9. Commit lokal

| #   | Hash        | Parent      | Isi                                                                                                                                                              |
| --- | ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `61ead34ea` | `2bd2174d1` | Lane PG lokal (`scripts/pg-local.ts`, `.gitignore`, `test:pg-lane`, `pg:local:*`), perbaikan entity set di 3 suite PG, ctype-aware FTS suite, impor `randomUUID` |
| 2   | `3e21ef889` | `61ead34ea` | Lane integrasi Core (`scripts/alim-core-integration-lane.ts`, `test:core-integration*`), bagian Core nyata di kedua E2E, `--sso-code=` pada probe                |

Working tree bersih kecuali dua artefak di luar lingkup yang sejak awal tidak disentuh.

---

## 10. Persentase penyelesaian

- **PostgreSQL lane: 100%** — berjalan, hijau penuh, tanpa skip, dapat diulang.
- **Kesiapan Connect untuk menerima endpoint staging Core: 100%.**
- **SSO & Approval HTTP E2E untuk integrasi nyata: kesiapan 100%, eksekusi 0%** — menunggu kredensial.
- **Quality gate: 100%.**
- **Integrasi nyata dengan Core: 0% terverifikasi.**

**Total ruang lingkup siklus ini ≈ 85%.** Yang tersisa sepenuhnya bergantung pada Core menerbitkan
endpoint dan kredensial staging. Tidak ada pekerjaan Connect yang dapat dipindahkan dari 0% ke
terverifikasi tanpa itu, dan siklus ini tidak mengklaim sebaliknya.

---

## 11. Tindakan berikutnya

1. Core menerbitkan endpoint + kredensial staging (butir 1–4 §8).
2. Isi variabelnya, lalu jalankan `npm run test:core-integration:lane` → harus berubah dari exit 2
   menjadi daftar semua **ready**.
3. Jalankan `npm run test:core-integration -- --sso-code=<kode staging>` dan
   `npm run test:core-integration -- --all`; simpan keluaran `[real-core]` sebagai bukti.
4. Jalankan `npm run probe:alim-core -- --all`; `PASS` pada keduanya sebelum runbook §5.4.
5. Setelah pemilik memutuskan scoping `VIEWER` dan retensi, lanjutkan ke kesiapan produksi.
