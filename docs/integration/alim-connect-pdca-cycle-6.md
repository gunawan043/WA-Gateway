# Laporan PDCA Siklus 6 — Verifikasi Integrasi Nyata dengan ALIM Core Staging

**Tanggal:** 2026-11-23
**Repository:** `/Users/wawangunawan/OpenWA` (ALIM Connect)
**Branch:** `feature/whatsapp-approval-finalization`
**Lingkup:** ALIM Connect saja. Tidak ada perubahan pada repository, kode, migrasi, atau konfigurasi
ALIM Core.
**Sifat:** siklus PDCA dengan hasil eksekusi. Dua commit checkpoint lokal; **tidak ada push, merge,
deploy, atau perubahan database produksi.** Browser test di-skip sesuai keputusan.

---

## 1. Ringkasan jujur di awal

| Pertanyaan                                                    | Jawaban                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Apakah integrasi nyata dengan Core terverifikasi?             | **Belum. 0%.** Tidak ada `ALIM_CORE_BASE_URL` maupun kredensial staging di mesin ini                                |
| Apakah ada hasil simulasi yang disajikan sebagai bukti nyata? | **Tidak.** Guard menolak berjalan (exit 2) dan menyatakan tidak ada yang dijalankan                                 |
| Apa yang benar-benar selesai?                                 | Satu celah audit nyata ditutup, diagnostik kesiapan diperluas, dan prosedur staging siap dieksekusi tanpa ubah kode |

---

## 2. Rekonsiliasi kontrak Core–Connect (§2 instruksi)

Diperiksa terhadap **kode aktual**, bukan dokumen.

| Butir yang diminta                                    | Temuan                                                                                                                                       | Status                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Endpoint SSO `/api/connect/v1/sso/exchange`           | `http-alim-core-sso.client.ts:71`                                                                                                            | **sesuai**                                |
| Endpoint approval `/api/connect/v1/approval-commands` | `http-alim-core-approval.client.ts:82`                                                                                                       | **sesuai**                                |
| API version `1`                                       | `ALIM_CORE_API_VERSION`, default `1`; kosong = header tidak dikirim                                                                          | **sesuai**                                |
| Header approval sesuai konfigurasi Core               | `ALIM_CORE_APPROVAL_API_HEADER`, default `X-ALIM-CONNECT-APPROVAL-KEY`                                                                       | **sesuai, dapat dikonfigurasi**           |
| `Idempotency-Key` **tidak** sama dengan `command_id`  | Kode saat ini mengirim **nilai yang sama**                                                                                                   | **TIDAK sesuai — diputuskan, lihat §2.1** |
| Key yang sama dipakai ulang saat retry                | `commandId` tetap per baris; header diturunkan dari `commandId`                                                                              | **sesuai**                                |
| Actor identity dari mapping Core yang valid           | Balasan: `identities.findVerified` (aktif **dan** terverifikasi); Core tetap menyelesaikan aktor sendiri                                     | **sesuai**                                |
| SSO audience, scope, TTL, one-time, session mapping   | `audience`/`scope` dikirim & diverifikasi pada balasan; TTL sesi terpisah; tanpa retry                                                       | **sesuai**                                |
| Revocation tidak dapat dilewati retry                 | Balasan baru dari mapping yang dicabut ditolak **sebelum** command dibuat; worker retry tidak menanyakan ulang kewenangan, Core yang menolak | **sesuai dengan batas terdokumentasi**    |

### 2.1 Keputusan: `Idempotency-Key` tetap sama dengan `command_id`

Instruksi §2 meminta keduanya berbeda; kontrak terdokumentasi
(`alim-connect-core-integration-contract.md` §4 dan §9), komentar kode, dan assertion E2E justru
mewajibkan keduanya **sama** ("alasan utama `Idempotency-Key` dan `command_id` harus konsisten").

Keputusan diambil bersama pemilik: **dipertahankan sama**. Alasannya teknis: timeout bukan berarti
Core gagal, sehingga pengiriman ulang harus menghasilkan `duplicate` yang sama di lapisan header
maupun body. Nilai acak yang berbeda per percobaan justru menghapus kesempatan Core mem-dedupe lebih
awal. Tidak ada kode yang diubah; yang ditambahkan hanya pencatatan keputusan ini agar tidak muncul
lagi sebagai "kontradiksi".

### 2.2 Rekonsiliasi nama environment

Lengkap di `docs/integration/alim-connect-env-reconciliation.md`. Ringkas:

| Nama di instruksi §2         | Nama aktual                  | Hubungan                                                                                          |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `ALIM_CORE_BASE_URL`         | sama                         | keluar, wajib untuk keduanya                                                                      |
| `ALIM_CONNECT_SSO_KEY`       | sama                         | **keluar** — kredensial milik Core, bukan Connect                                                 |
| `ALIM_CORE_WEB_ORIGIN`       | sama                         | mengisi allowlist Origin **dan** `frame-ancestors` sekaligus                                      |
| `ALIM_CORE_APPROVAL_API_KEY` | sama                         | keluar                                                                                            |
| `ALIM_CONNECT_INGEST_KEY`    | sama                         | **masuk** — Core memegangnya untuk memanggil Connect                                              |
| `CONNECT_SSO_API_KEY`        | `ALIM_CONNECT_SSO_KEY`       | **satu credential yang sama**, bukan dua                                                          |
| `CONNECT_APPROVAL_API_KEY`   | `ALIM_CORE_APPROVAL_API_KEY` | satu credential yang sama                                                                         |
| `CONNECT_SSO_FRAME_ORIGIN`   | `ALIM_CORE_WEB_ORIGIN`       | satu nilai, bukan dua setelan                                                                     |
| `CONNECT_SSO_HANDOFF_URL`    | tidak ada setelan            | rute milik Connect sendiri di `POST /api/sso/handoff`                                             |
| `CONNECT_*_ALLOWED_IPS`      | **tidak ada di kode**        | belum diimplementasikan; penggantinya Origin allowlist + throttle (SSO) dan ingest key (approval) |

Semua variabel yang dibaca kode terverifikasi terdaftar di `BLANK_SHADOWED_ENV_KEYS`, sehingga nilai
kosong dari compose berarti "tidak di-set" dan tidak menutupi `.env`.

---

## 3. Implementasi aktual yang dilakukan

### 3.1 Jejak audit command (celah nyata, ditutup)

Sebelum siklus ini, satu-satunya aksi audit approval adalah `approval_identity_changed`. Keputusan
yang dikirim ke Core — dari balasan WhatsApp maupun dari worker retry — **tidak** meninggalkan baris
audit. Instruksi §3 meminta audit mencatat actor, command, hasil, dan korelasi request, jadi celah ini
ditutup:

- `AuditAction.APPROVAL_COMMAND` baru, satu baris per hasil command: `applied`, `duplicate`,
  `unavailable`, `exhausted`, `rejected`, `request_missing`.
- Isi: `commandId`, `coreRequestId`, `decision`, `approvedDurationDays`, `attempts`, `commandStatus`,
  `requestStatus`, `coreResponseCode`, `coreErrorCode`, `actorCorePersonId`.
- Ditulis di processor, sehingga jalur retry tercakup dengan sendirinya, dan **sebelum** konfirmasi
  WhatsApp dikirim — kegagalan pengiriman tidak dapat menyembunyikan keputusan yang sudah ditetapkan
  Core.
- **Sengaja tidak** memuat teks balasan, nomor pengirim, atau kredensial. Dua test menegaskan hal ini
  (unit dan E2E).
- Korelasi request: `AuditService` menstempel request id aktif, jadi baris audit tertaut ke baris log
  yang sama.

### 3.2 Diagnostik kesiapan staging diperluas

Lane sebelumnya memeriksa 2 setelan per integrasi. Tiga setelan lain yang menentukan apakah sebuah run
berarti apa pun tadinya tidak terlihat — termasuk `ALIM_CORE_WEB_ORIGIN` yang mematikan SSO bila
kosong. Sekarang setiap pemeriksaan menyebut akibatnya dan dipisah:

- `blocks` — bagian Core nyata akan skip atau fitur mati.
- `degrades` — fitur hidup, tetapi satu jalur menjawab 503 (`ALIM_CONNECT_INGEST_KEY`).

Setiap setelan hanya muncul di bawah integrasi yang memilikinya (`ALIM_CORE_WEB_ORIGIN` bukan lagi
"blocker approval"). Nilai **tidak pernah** dicetak.

### 3.3 Prosedur staging siap eksekusi

`docs/integration/alim-connect-staging-verification.md`: apa yang harus Core sediakan (dengan penanda
**blocker** atau tidak), gerbang kesiapan, jalur penolakan dan sukses SSO, satu command approval nyata,
tabel skenario retry/timeout/replay/kredensial salah, cara memeriksa audit, dan batas yang jujur soal
pencabutan kewenangan. Tidak ada langkah yang memerlukan perubahan kode.

---

## 4. Berkas yang dibuat dan diubah

| Berkas                                                    | Perubahan                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| `src/modules/audit/entities/audit-log.entity.ts`          | +`APPROVAL_COMMAND`                                                 |
| `src/modules/approval/approval-processor.service.ts`      | `AuditService` opsional + `auditCommand()` di setiap jalur terminal |
| `src/modules/approval/approval-processor.service.spec.ts` | +3 test audit (applied, rejected, retry/exhausted)                  |
| `test/approval-http.e2e-spec.ts`                          | +1 test membaca baris audit lewat repository aplikasi               |
| `openapi.json`                                            | satu nilai enum baru (delta 1 baris, diperiksa)                     |
| `docs/36-whatsapp-approval-workflow.md`                   | bagian jejak audit command                                          |
| `scripts/alim-core-integration-lane.ts`                   | pemeriksaan lengkap + pembedaan blocks/degrades                     |
| `docs/integration/alim-connect-env-reconciliation.md`     | **baru**                                                            |
| `docs/integration/alim-connect-staging-verification.md`   | **baru**                                                            |

---

## 5. Hasil pengujian (serial, satu proses berat pada satu waktu)

| #   | Gerbang                  | Hasil                                                     | Exit      |
| --- | ------------------------ | --------------------------------------------------------- | --------- |
| 1   | `npx tsc --noEmit`       | 0 error                                                   | 0         |
| 2   | `npm run lint`           | 0 error (sempat 3 error di kode saya, diperbaiki)         | 0         |
| 3   | `npm run build`          | lulus                                                     | 0         |
| 4   | Unit approval + audit    | **212 lulus**, 9 skip (pre-existing), 22 suite            | 0         |
| 4   | `npm run test:contracts` | **86/86**                                                 | 0         |
| 5   | E2E SSO + Approval       | **43 lulus**, 3 skip (hanya section Core nyata)           | 0         |
| 6   | Lane PostgreSQL          | **134/134, 0 skip, 14 suite**                             | 0         |
| 7   | Lane Core staging        | exit **2**, tidak ada yang dijalankan                     | 2 (benar) |
| 8   | Full suite + coverage    | **21.418 lulus**, 141 skip, 864 suite, tanpa pesan ambang | 0         |
| -   | `npm run test:docs`      | **969/969**, 39 suite                                     | 0         |
| -   | `npm run openapi:check`  | exit 0 setelah regenerasi satu nilai enum                 | 0         |

Ambang coverage, assertion, dan security test **tidak** diubah.

Catatan kegagalan yang ditemukan dan diperbaiki selama gerbang berjalan:

1. `require-await` dan dua pelanggaran Prettier di kode saya → diperbaiki.
2. E2E gagal karena saya memakai referensi `IZN-2026-103` yang sudah dipakai test lain (`unique
constraint` → 500). Dipindah ke `IZN-2026-104`.
3. `ALIM_CORE_WEB_ORIGIN` sempat tampil sebagai blocker approval — bug logika scope di lane saya
   sendiri, diperbaiki sebelum commit.

---

## 6. Bukti SSO dengan Core staging nyata

**Tidak ada.** Tidak ada kode handoff, base URL, maupun kunci yang tersedia di mesin ini; `env` dan
`.env` tidak memuat satu pun variabel `ALIM_*`. Tidak ada kode uji SSO yang dijalankan, dan tidak ada
klaim bahwa exchange pernah berhasil. Bukti yang dapat dijanjikan begitu kredensial ada: `PASS` dengan
`core_user_id` yang dikenali pemohon, tanpa sesi dibuat dari kode rekaan.

## 7. Bukti Approval dengan Core staging nyata

**Tidak ada**, dengan alasan yang sama. Tidak ada command yang pernah dikirim ke Core sungguhan.
Kemungkinan menjawab "tidak ada pemrosesan ganda" pada Core **tidak dapat** dibuktikan dari sini; yang
sudah terbukti hanya perilaku terhadap mock yang setia kontrak (86 test kontrak + 19 E2E).

## 8. Idempotency, retry, identity, audit

| Aspek                                         | Status                                | Bukti                                        |
| --------------------------------------------- | ------------------------------------- | -------------------------------------------- |
| Idempotency pesan (satu pesan → satu command) | terbukti (mock)                       | processor + E2E                              |
| Replay `command_id` yang sama                 | terbukti (mock)                       | E2E reliability                              |
| Retry dengan id sama, lease per baris         | terbukti (mock + PG)                  | `approval-retry.pg.spec.ts`                  |
| Retry habis → `FAILED`, tidak looping         | terbukti                              | processor, retry, PG                         |
| Identity hanya aktif + terverifikasi          | terbukti                              | `whatsapp-identity.security.spec.ts`, E2E    |
| Revocation pada balasan baru                  | terbukti                              | processor (`unknown_sender`)                 |
| Revocation saat retry                         | **dijamin Core**, bukan Connect       | dinyatakan di prosedur §7                    |
| Audit actor/command/hasil/korelasi            | **baru diimplementasikan & terbukti** | §3.1, 4 test                                 |
| Audit tanpa secret/PII                        | terbukti                              | 2 test menegaskan tidak ada nomor/teks/kunci |

---

## 9. Blocker yang masih ada dan pemiliknya

| #   | Blocker                                         | Pemilik                   | Menahan apa                                     |
| --- | ----------------------------------------------- | ------------------------- | ----------------------------------------------- |
| 1   | URL dasar Core staging                          | Core                      | semuanya                                        |
| 2   | Kunci `sso:exchange`                            | Core                      | SSO                                             |
| 3   | Origin browser Core staging                     | Core                      | SSO (tanpa ini SSO mati)                        |
| 4   | Kunci `approval:command`                        | Core                      | Approval                                        |
| 5   | Nama header yang dibaca Core untuk key approval | Core                      | hanya bila bukan `X-ALIM-CONNECT-APPROVAL-KEY`  |
| 6   | Satu kode handoff baru per uji sukses           | Core (data uji)           | jalur sukses SSO                                |
| 7   | Satu permit staging yang masih terbuka          | Core (data uji)           | uji approval nyata                              |
| 8   | Konfirmasi `audience`/`scope`                   | Core                      | hanya bila bukan `connect`/`whatsapp.embed`     |
| 9   | `DATABASE_*` Connect yang lama                  | operator Connect          | tidak lagi menahan (lane memakai klaster lokal) |
| 10  | Scoping `VIEWER`, retensi PII                   | pemilik                   | kesiapan produksi                               |
| 11  | Allowlist IP untuk Core                         | pemilik (perlu CIDR Core) | belum diimplementasikan                         |

---

## 10. Commit dan status working tree

| #   | Hash        | Parent      | Isi                                                       |
| --- | ----------- | ----------- | --------------------------------------------------------- |
| 1   | `8df14df7b` | `a29574cfb` | Audit command (enum, processor, 4 test, OpenAPI, docs/36) |
| 2   | `e18e6d3fb` | `8df14df7b` | Diagnostik kesiapan lane + dua dokumen integrasi          |

Working tree bersih kecuali dua artefak di luar lingkup yang sejak awal tidak disentuh:
`LAPORAN-FASE-3-2026-11-20.md` dan `OpenWA/.keep`.

Klaster PostgreSQL lokal sudah **dihentikan** (`npm run pg:local:stop`, `--status` → not running,
port 5432 bebas).

---

## 11. Status kesiapan dan rekomendasi siklus berikutnya

- **Kesiapan Connect: selesai.** Begitu nilai §9 butir 1–8 tersedia, `npm run test:core-integration:lane`
  harus berubah dari exit 2 menjadi `ready` tanpa perubahan kode, lalu prosedur staging dijalankan
  apa adanya.
- **Integrasi nyata: 0% terverifikasi** — dan itu satu-satunya pekerjaan tersisa untuk lingkup ini.
- Rekomendasi siklus 7: jalankan §4–§8 prosedur begitu kredensial ada; laporkan keluaran `[real-core]`
  apa adanya. Jika Core menolak `Idempotency-Key = command_id`, keputusan §2.1 perlu ditinjau ulang
  dengan bukti penolakan tersebut, bukan sebelumnya.
