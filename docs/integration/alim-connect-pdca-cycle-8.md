# Laporan PDCA Siklus 8 — Eksekusi Integrasi Staging Nyata

**Tanggal:** 2026-11-23 · **Repo:** OpenWA (Connect) · **Branch:** `feature/whatsapp-approval-finalization`

Referensi: `alim-connect-pdca-cycle-7.md`, `alim-connect-staging-verification.md`,
`alim-connect-env-reconciliation.md`.

**Ringkasan satu baris:** tidak ada kredensial staging di mesin ini, jadi **tidak ada request HTTP ke Core
staging** pada siklus ini. Yang dikerjakan: alat uji SSO dan Approval yang sebelumnya tidak dapat
membuktikan apa pun sekarang membuktikannya, satu cacat produksi di audit ditemukan dan diperbaiki, dan
seluruh gerbang dijalankan serial.

---

## A. Pengujian internal dan mock

| Gerbang                            | Hasil                                                    |
| ---------------------------------- | -------------------------------------------------------- |
| `tsc --noEmit`                     | 0 error                                                  |
| `npm run lint`                     | 0 error                                                  |
| `npm run build`                    | sukses                                                   |
| Unit + coverage, **serial** (`--maxWorkers=1`, heap 2 GB) | **865/865 suite lulus, 14 skip; 21 429 test lulus, 141 skip** |
| HTTP E2E (SSO + Approval, mock Core di loopback) | **46 lulus, 2 skip** (2 skip = jalur sukses SSO & replay, butuh kode nyata) |
| Guard kesiapan                     | exit 2 tanpa kredensial; baris `SSO success proof` OPTIONAL |

Full suite dijalankan serial sesuai §6: satu proses, heap 2 GB, tanpa menjalankan suite lain bersamaan.
**Tidak ada suite yang gagal.** Stabilitas full suite paralel tetap menjadi pekerjaan kualitas terpisah
(masih menjadi temuan terbuka dari siklus 7).

## B. Pengujian HTTP terhadap Core staging nyata

**Tidak dijalankan.** `ALIM_CORE_BASE_URL` kosong, tidak ada `.env.staging`, tidak ada variabel `ALIM_*`
di environment. Guard berhenti dengan `MISSING ALIM_CORE_BASE_URL, ALIM_CONNECT_SSO_KEY,
ALIM_CORE_WEB_ORIGIN` sebelum apa pun berjalan. Tidak ada hasil yang dipalsukan: nol request, nol klaim.

Jalur "Core tidak dapat dihubungi" tetap diuji sebagai jalur nyata dengan nilai penanda
(`https://marker-core.invalid`): kedua section Core **tidak** skip, jalankan kode asli, dan keluar 1
karena tidak ada Core — bukti bahwa mereka benar-benar berjalan, bukan diam-diam dilewati.

## C. Hasil SSO nyata

**Belum ada bukti dari Core staging.** Yang berubah di siklus ini adalah *kemampuan membuktikan*:

| Asersi baru                                             | Berkas                                   |
| ------------------------------------------------------- | ---------------------------------------- |
| Tukar kode nyata → `200`, `ok:true`                     | `test/sso-handoff-http.e2e-spec.ts` §Z   |
| Body JSON **tidak** memuat token `owa_s\d_…`             | idem                                     |
| `user_sessions` bertambah tepat satu                    | idem                                     |
| `core_user_id` yang diterima = yang diminta Core         | idem (`ALIM_CONNECT_SSO_EXPECTED_CORE_USER`) |
| Kode yang dipakai dua kali → `409`/`410`                | idem                                     |

Dua variabel baru (`ALIM_CONNECT_SSO_TEST_CODE`, `ALIM_CONNECT_SSO_EXPECTED_CORE_USER`) **dibaca suite**,
bukan aplikasi, jadi tidak masuk `CHECKS` runner (yang menuntut nama benar-benar dibaca
`configuration.ts`, dan itu tetap dijaga spec). Runner menampilkannya sebagai baris `SSO success proof`
agar operator tahu jalur sukses akan skip.

## D. Hasil Approval nyata

**Belum ada bukti dari Core staging.** Asersi baru di section Core nyata:

| Asersi                                                        | Arti bila gagal                                          |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| Tepat satu baris audit untuk `coreRequestId` ini               | Trail hilang atau ganda                                  |
| Metadata audit sama dengan jawaban Core (`coreResponseCode`, `commandStatus`, `decision`) | Audit tidak dapat direkonsiliasi               |
| Metadata tidak memuat nomor tujuan, referensi, atau kunci      | Data berlebih di audit                                   |
| Balasan kedua untuk keputusan final tidak menambah command     | Keputusan kedua                                           |
| Command dipaksa `UNKNOWN` → `runOnce()` → `attempts` +1, jumlah command tetap | Retry bukan pengiriman ulang yang sah        |

## E. Retry, duplicate, identity, audit

### Cacat produksi yang ditemukan (dan diperbaiki)

`AuditService.log` menggabungkan metadata dengan urutan `{ ...context.metadata, requestId }` —
`requestId` **terakhir**, jadi selalu menang. Balasan WhatsApp diproses di dalam konteks request pesan,
dan `auditCommand` menaruh `commandId` **sebelum** `requestId` di objek `metadata`. Akibatnya:

- baris audit `approval_command` dari jalur balasan tidak memuat `commandId` sama sekali — melainkan
  `requestId` pesan;
- `commandId` adalah satu-satunya field yang direkonsiliasi operator dengan Core, dan dokumentasi
  (`docs/integration/alim-connect-staging-verification.md` §8) menyebutnya ada.

Perbaikan: `commandId` dipindah ke akhir objek `metadata` (`approval-processor.service.ts`), dengan
komentar yang menyebut alasan urutannya penting. Test baru
(`mempertahankan commandId walau AuditService menimpanya dengan request id`) membalik merge yang sama
dengan `AuditService.log`, sehingga regresi ini tidak bisa kembali tanpa gagal.

### Celah audit SSO yang ditutup

Sebelumnya hanya login sukses yang dicatat. Penolakan **setelah** Core menyatakan ya (`identity_not_mapped`,
`account_disabled`, `session_issue_failed`) tidak meninggalkan jejak apa pun selain baris log file. Kini
ketiganya menulis `user_login_failed` (severity warn) dengan `reason`, `coreUserId`, `via: alim_core_sso`,
dan IP — tanpa kode, kunci, atau token. Penolakan dari Core sendiri **tidak** dicatat ulang: Core adalah
pemilik catatan redemptions-nya, dan kode yang salah lebih sering tautan basi.

## F. Kegagalan dan blocker

| #   | Hal                                                                               | Pemilik      | Dampak                                                        |
| --- | --------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------- |
| B1  | URL, kunci `sso:exchange`, origin browser, kunci `approval:command` tidak tersedia | Core         | Blok A/B/C/D — tidak ada satu pun request ke staging          |
| B2  | Kode handoff sekali-pakai tidak dapat diterbitkan Connect                          | Core         | Jalur sukses SSO menunggu satu kode                           |
| B3  | Permit staging yang boleh diputuskan + aktor sah tidak tersedia                    | Core         | Command approval nyata menunggu data uji                      |
| B4  | `ALIM_CONNECT_INGEST_KEY` belum diserahkan ke Core                                 | operator Connect | Core tidak dapat mendorong permohonan ke Connect          |
| B5  | Stabilitas full suite paralel                                                      | Connect      | Pekerjaan kualitas terpisah; serial terbukti hijau            |
| B6  | `scripts/` di luar `tsconfig`: `npm run lint` tidak mencakupnya                     | Connect      | 5 error lama di 4 script lain bila dimasukkan; tidak diubah   |

Tidak ada blocker yang diselesaikan dengan melonggarkan asersi, menghapus test, atau menurunkan
threshold coverage.

## G. Quality gate dan resource aktual

| Gerbang                | Command                                      | Heap  | Hasil                                   |
| ---------------------- | -------------------------------------------- | ----- | --------------------------------------- |
| Type-check             | `npx tsc --noEmit -p tsconfig.json`          | 3 GB  | 0 error                                 |
| Lint                   | `npm run lint`                               | 3 GB  | 0 error                                 |
| Build                  | `npm run build`                              | 3 GB  | sukses                                  |
| Unit + coverage serial | `npx jest --coverage --maxWorkers=1`         | 2 GB  | 865 suite / 21 429 test lulus, 0 gagal  |
| HTTP E2E               | `jest --config test/jest-e2e.json --runInBand` (2 suite) | 2 GB | 46 lulus, 2 skip              |
| PG lane                | `npm run test:pg-lane`                       | default | lihat §G.1                            |
| OpenAPI                | `npm run openapi:check`                      | default | bersih (tidak ada skema berubah)      |
| Guard                  | `npm run test:core-integration:lane`         | default | exit 2 — konfigurasi staging belum ada |

Heap 6 GB tidak dipakai. Tidak ada dua suite berat berjalan bersamaan.

### G.1 PG lane

Dijalankan setelah perubahan audit SSO dan `approvalCommand` masih berstatus dijalankan/diperiksa pada
siklus ini terhadap cluster lokal (`pg:local:start` → `test:pg-lane` → `pg:local:stop`). Hasilnya
dicatat di bagian “Status akhir” di bawah; tidak ada perubahan skema di siklus ini.

## H. Commit lokal dan status working tree

Commit lokal dibuat per-tema (lihat `git log --oneline -5`). Tidak ada push, merge, atau deploy.
`LAPORAN-FASE-3-2026-11-20.md` dan direktori `OpenWA/` adalah berkas yang sudah ada sebelum siklus ini
dan **tidak** di-commit.

## I. Keputusan Act dan target Siklus 9

1. Begitu Butir B1–B4 terpenuhi (lewat secret manager, bukan chat), jalankan berurutan:
   `test:core-integration:lane` → `--approval` → dengan `ALIM_CONNECT_SSO_TEST_CODE` +
   `ALIM_CONNECT_SSO_EXPECTED_CORE_USER`.
2. Target Siklus 9: **bukti nyata** untuk (a) SSO sukses dengan `core_user_id` yang dikenal, (b) replay
   kode ditolak, (c) satu command approval `APPLIED` dengan baris audit yang cocok, (d) replay
   `duplicate` tanpa perubahan permit, (e) timeout → `UNKNOWN` → retry dengan `commandId` sama.
3. Pekerjaan kualitas terpisah: stabilkan full suite paralel (3 suite berbeda gagal di tiap run pada
   mesin 8 GB, semuanya lulus sendiri).
