# Laporan PDCA Siklus 9 — HTTP Nyata ke ALIM Core Staging

**Tanggal:** 2026-11-23 · **Repo:** OpenWA (Connect) · **Branch:** `feature/whatsapp-approval-finalization`
**HEAD sebelum siklus:** `35522592d` (semua lima commit siklus 8 diverifikasi ancestor HEAD)

**Ringkasan:** target siklus — bukti SSO dan Approval nyata lewat HTTP ke Core staging — **belum tercapai**;
kredensial staging tidak tersedia. Yang diselesaikan siklus ini: **akar penyebab `exit 1` pada full suite
ditemukan dan dibuktikan** (bukan coverage threshold), dan pekerjaan independen §G diverifikasi ulang.

---

## 1. Repository, branch, HEAD

| Hal             | Nilai                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Repository      | OpenWA (Connect) — tidak ada perubahan pada repo Core                                                                |
| Branch          | `feature/whatsapp-approval-finalization`                                                                             |
| HEAD awal       | `35522592d`                                                                                                          |
| Working tree    | bersih selain `LAPORAN-FASE-3-2026-11-20.md` dan `OpenWA/` (artefak lama, tidak disentuh)                            |
| Commit siklus 8 | `526b6a099`, `94cd0329e`, `2ca5fed68`, `a0ea6b206`, `35522592d` — kelimanya `git merge-base --is-ancestor HEAD` = ya |

## 2. Implementasi aktual

Siklus ini **tidak menambah fitur**. Dua perubahan, keduanya menutup pekerjaan §C dan §E:

1. **Investigasi full suite `exit 1` (§9)** — penyebab ditemukan dan dibuktikan; tidak ada kode yang
   diubah untuk "menutupinya".
2. **Pemeriksaan runner ulang (§3)** — konfirmasi ulang bahwa guard, sanitasi, dan nama variabel masih
   sesuai; tidak ada perubahan yang dibutuhkan.

## 3. Persiapan integration runner (verifikasi ulang, bukan audit baru)

| Hal yang diperiksa                    | Hasil                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `CHECKS` runner                       | 5 nama, semuanya dibaca `src/config/configuration.ts`; dijaga `src/common/alim-core-readiness.spec.ts` (5/5 lulus) |
| `CONNECT_*` bukan milik Connect       | Ditolak oleh spec (nama berawalan `CONNECT_` gagal)                                                                |
| `ALIM_CONNECT_SSO_EXPECTED_CORE_USER` | Dibaca suite, bukan aplikasi; dilaporkan guard sebagai `SSO success proof`                                         |
| Sanitasi secret                       | 5 nilai penanda pada E2E: **0 kemunculan** di stdout+stderr (siklus 8)                                             |
| Guard tanpa kredensial                | `Not ready.` exit **2** — tidak dipaksa berjalan                                                                   |

## 4. Hasil internal / mock

| Gerbang              | Hasil                                                          |
| -------------------- | -------------------------------------------------------------- |
| `tsc --noEmit`       | 0 error                                                        |
| `npm run lint`       | 0 error                                                        |
| HTTP E2E (mock Core) | 46 lulus, 2 skip (jalur sukses SSO + replay, butuh kode nyata) |
| PG lane              | 134/134, 14 suite, 0 skip                                      |
| OpenAPI              | bersih                                                         |

## 5. Hasil HTTP dengan Core staging nyata

**Tidak ada.** `env | grep -c '^ALIM_'` = 0, tidak ada `.env.staging`, guard keluar `2`. Tidak ada satu pun
request HTTP ke Core staging, dan tidak ada yang dilaporkan sebagai hasil integrasi.

## 6. Bukti SSO

Tidak ada bukti staging. Asersi yang akan membuktikannya sudah terpasang sejak siklus 8 (HTTP 200, tanpa
token di body JSON, tepat satu sesi, `core_user_id` cocok, replay ditolak).

## 7. Bukti Approval

Tidak ada bukti staging. Asersi terpasang: audit cocok dengan jawaban Core, `Idempotency-Key =
command_id`, body retry identik, balasan kedua tanpa command baru, command `UNKNOWN` di-retry dengan
`command_id` sama.

## 8. Retry, duplicate, identity, audit

Tidak ada bukti staging. Yang berubah sejak siklus 8 dan tetap berlaku: `commandId` dipertahankan pada
baris audit (setelah `requestId` agar tidak tertimpa), dan penolakan SSO pasca-Core tercatat sebagai
`user_login_failed`.

## 9. Investigasi full suite `exit 1` — akar penyebab ditemukan

### 9.1 Gejala

Enam run serial berlingkup penuh (`--maxWorkers=1`): semua melaporkan 865 suite / 21 429 test lulus, dan
semua keluar dengan `exit 1`. Pada satu run, satu test plugin sandbox gagal dengan 504 (lulus sendiri).

### 9.2 Yang dibuktikan, berurutan

| Langkah | Alat                                                                                                                                  | Temuan                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1       | Jalankan subset (`src/modules/approval`, `src/modules/sso`) dengan `--coverage`                                                       | `exit 1` dan **176 baris** `Jest: Coverage … does not meet` — threshold memang gagal untuk subset |
| 2       | Replika evaluasi threshold jest (istanbul) atas `coverage/coverage-final.json` subset                                                 | `global` 14,28% baris < 77% → wajar gagal. **Kesimpulan: `exit 1` = threshold, bukan crash**      |
| 3       | Run penuh dengan `--json --outputFile`                                                                                                | `success: true`, `numFailedTests: 0`, `numRuntimeErrorTestSuites: 0`, `snapshot.failure: false`   |
| 4       | Replika threshold atas coverage run penuh                                                                                             | **0 grup** di bawah threshold; `global` 95,25% baris                                              |
| 5       | `grep "does not meet"` pada stdout+stderr run penuh                                                                                   | **0 kemunculan**                                                                                  |
| 6       | Patch sementara `node_modules/jest-cli/build/index.js` di `/tmp` untuk mencetak `results.success` pada call site `readResultsAndExit` | `[wrap] results.success=true failedTests=0 runtimeErrors=0` → **jest-cli menyimpulkan 0**         |

### 9.3 Kesimpulan

1. **`exit 1` pada run penuh bukan threshold coverage.** Tidak ada grup di bawah threshold, tidak ada
   pesan threshold, dan `results.success` bernilai `true`.
2. **`exit 1` pada subset memang threshold** — itu perilaku benar dan sudah lama berlaku: `collectCoverageFrom`
   mengukur semua file, jadi menjalankan subset dengan `--coverage` selalu gagal. Bila operator membaca
   run subset dengan `--coverage`, itulah sumber "exit 1 yang tidak dijelaskan".
3. Pada run penuh, kode keluar datang dari luar `results.success` — yaitu setelah `readResultsAndExit`,
   ketika proses menunggu handle yang belum tertutup (`openHandlesTimeout` 1000 ms, lalu jaminan
   `process.exitCode = 1` di handler `exit`). Bukti pendukung: satu run membutuhkan 924 detik untuk suite
   `session-delete-claim` yang normalnya 28 detik, dan run lain menulis 24 MB log ke stderr. Ini bukan
   kegagalan test, tetapi juga **bukan** kondisi yang bisa disebut hijau.
4. Karena itu **tidak ada** yang diubah pada threshold, asersi, maupun timeout. Pemakaian `--json`
   dipakai sebagai bukti, bukan sebagai jalan pintas.

### 9.4 Status

- **Tertutup:** dugaan bahwa `exit 1` berasal dari threshold coverage atau dari kegagalan test.
- **Terbuka (pekerjaan kualitas):** handle yang tertahan setelah run penuh pada mesin 8 GB. Alat ukur yang
  dibutuhkan (`--detectOpenHandles`) sangat lambat pada run penuh; perlu diukur pada subset yang
  mereproduksi penundaan teardown, bukan pada seluruh 865 suite.

## 10. Quality gate dan exit code

| Gerbang       | Command                              | Exit  | Hasil                                                                                             |
| ------------- | ------------------------------------ | ----- | ------------------------------------------------------------------------------------------------- |
| Type-check    | `tsc --noEmit -p tsconfig.json`      | 0     | 0 error                                                                                           |
| Lint          | `npm run lint`                       | 0     | 0 error                                                                                           |
| Build         | `npm run build`                      | 0     | sukses                                                                                            |
| E2E (mock)    | `jest --config test/jest-e2e.json`   | 0     | 46 lulus, 2 skip                                                                                  |
| PG lane       | `npm run test:pg-lane`               | 0     | 134/134, 14 suite                                                                                 |
| OpenAPI       | `npm run openapi:check`              | 0     | bersih                                                                                            |
| Guard staging | `npm run test:core-integration:lane` | 2     | `Not ready.`                                                                                      |
| Full suite    | `jest --coverage --maxWorkers=1`     | **1** | `results.success=true`, 0 test gagal, 0 grup di bawah threshold; exit dari fase sesudahnya (§9.3) |

## 11. Resource aktual

- MacBook Pro M1, 8 GB. Satu proses berat pada satu waktu.
- Heap: 2 GB untuk unit/E2E; 3 GB untuk `tsc` dan `lint`. **Tidak ada** pemakaian heap 6 GB.
- Seluruh pengujian serial (`--maxWorkers=1` / `--runInBand`). Tidak ada dua suite berat bersamaan.
- Browser testing (Chrome/Safari/Firefox) di-skip sesuai keputusan.

## 12. Commit lokal dan working tree

Working tree bersih terhadap pelacakan (hanya artefak lama `LAPORAN-FASE-3-2026-11-20.md` dan `OpenWA/`).
Perubahan siklus 9 hanya dokumen laporan ini dan tautan di laporan siklus 8; satu commit lokal, tanpa push,
merge, atau deploy.

## 13. Blocker dan pemilik tindak lanjut

| #   | Blocker                                                                     | Pemilik          | Dampak                               |
| --- | --------------------------------------------------------------------------- | ---------------- | ------------------------------------ |
| B1  | URL staging, kunci `sso:exchange`, origin browser, kunci `approval:command` | Core             | Semua bukti HTTP nyata menunggu      |
| B2  | Kode handoff sekali-pakai                                                   | Core             | Jalur sukses SSO menunggu            |
| B3  | Permit staging + aktor sah terverifikasi                                    | Core             | Command approval nyata menunggu      |
| B4  | `ALIM_CONNECT_INGEST_KEY` belum diserahkan ke Core                          | operator Connect | Core belum bisa mendorong permohonan |
| B5  | Handle tertahan setelah run penuh                                           | Connect          | Full suite belum dapat disebut hijau |
| B6  | `scripts/` di luar `tsconfig` dan `npm run lint`                            | Connect          | 5 error lama di 4 script lain        |

## 14. Keputusan Act

1. Segera setelah B1–B4 terpenuhi: `test:core-integration:lane` → `--approval` →
   dengan `ALIM_CONNECT_SSO_TEST_CODE` + `ALIM_CONNECT_SSO_EXPECTED_CORE_USER`.
2. Jangan menjalankan subset dengan `--coverage` lalu membaca `exit 1` sebagai kegagalan; gunakan
   `--coverage=false` untuk subset, dan run penuh untuk gerbang coverage.
3. Lanjutkan B5 sebagai pekerjaan kualitas tersendiri, dengan bukti dari `results.success` (lulus) dan
   daftar handle, bukan dengan menaikkan `openHandlesTimeout`.
