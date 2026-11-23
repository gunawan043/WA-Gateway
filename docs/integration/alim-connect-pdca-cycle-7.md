# Laporan PDCA Siklus 7 — Persiapan Eksekusi Staging

**Tanggal:** 2026-11-23 · **Repo:** OpenWA (Connect) · **Branch:** `feature/whatsapp-approval-finalization`
**Commit awal siklus:** `9a9537358` · **Referensi rekonsiliasi Core:** `495506c5`

Laporan ini memisahkan empat jenis bukti yang tidak boleh dicampur, karena sebelumnya hal itulah yang
membuat status terbaca lebih baik daripada kenyataannya:

| Jenis bukti                                 | Status siklus ini                                            |
| ------------------------------------------- | ------------------------------------------------------------ |
| Pekerjaan persiapan (kode, runner, dokumen) | **selesai dan terverifikasi**                                |
| Hasil dengan Core mock di batas HTTP        | **lulus**, dan kini juga membuktikan identitas payload retry |
| Hasil HTTP nyata ke Core staging            | **belum ada** — kredensial staging tetap tidak tersedia      |
| Blocker yang bergantung pada Core           | **terbuka**, dirinci di §7                                   |

---

## 1. Yang diukur, bukan diasumsikan

| Pertanyaan                                      | Jawaban siklus ini                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Kode Connect siap menjalankan uji staging?      | **Ya.** Satu cacat nyata pada section Core nyata ditemukan dan diperbaiki (§3.1)               |
| Kontrak header/versi/idempotensi sudah benar?   | **Ya, dibuktikan di batas HTTP** (§3.2)                                                        |
| Ada request yang pernah sampai ke Core staging? | **Tidak.** `ALIM_CORE_BASE_URL` tidak ada; guard keluar exit 2 sebelum apa pun dijalankan (§6) |
| Dokumen rekonsiliasi env masih salah?           | **Ya, dua baris.** Sudah dikoreksi (§3.4)                                                      |
| Regresi dari perubahan siklus ini?              | **Tidak ada** (§8)                                                                             |

---

## 2. Fakta kontrak dari Core yang dipakai sebagai dasar

Ditetapkan pada siklus rekonsiliasi Core (`495506c5`, dibuktikan lewat implementasi dan test, bukan
dokumentasi):

1. `Idempotency-Key` **harus sama** dengan `command_id` di body — beda satu karakter → `422
idempotency_key_mismatch`, nol baris tersimpan.
2. Replay identik → `200`, `duplicate: true`.
3. `command_id` sama dengan payload berbeda → `409 command_id_reused`.
4. `external_message_id` yang sudah dipakai → `409 external_message_replayed`.
5. Versi kontrak yang diterima: `1`.
6. Nama `CONNECT_*` adalah milik **Core** (`config/services.php`), bukan Connect.

Connect tidak mengubah perilaku untuk memenuhi poin 1–5: kode sudah mengirim keduanya secara konsisten.
Yang berubah adalah _bukti_-nya dan dokumennya.

---

## 3. Implementasi

### 3.1 Cacat nyata pada section Core nyata (approval)

Section `Z. ALIM Core sungguhan` di `test/approval-http.e2e-spec.ts` belum pernah benar-benar berjalan —
selalu ter-skip karena tidak ada `ALIM_CORE_BASE_URL`. Ketika dijalankan, ia gagal bukan karena Core,
tetapi karena dirinya sendiri:

| Gejala                                                     | Sebab                                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `409 identity_reassign_requires_flag` saat memetakan nomor | Suite B memetakan nomor uji yang sama ke personel lain; pemetaan harus eksplisit `reassign: true`                                               |
| `no command was created`                                   | Balasan memakai `PROBE-C5-…`, yang **bukan** bentuk referensi yang dikenali parser (`PREFIX-YYYY-NNN`)                                          |
| `no command was created` (lagi)                            | Ingest tidak mengirim `targetCorePersonId`, sehingga `request.targetCorePersonId` kosong dan pemeriksaan "pengirim = tujuan" tidak pernah cocok |

Ketiganya diperbaiki. Kegagalan kini keluar dengan diagnosa eksplisit (`identity mapping rejected: …`,
`no command was created: request status …`) alih-alih `expect(undefined).toBeDefined()`.

Bukti bahwa perbaikan ini benar dan bukan sekadar "dibuat lulus": setelah diperbaiki, section tersebut
**lulus** terhadap Core yang tidak dapat dihubungi hanya karena jalur mock Core di dalam suite yang
bertindak — di sana command berstatus `APPLIED`, `coreResponseCode 200`, `requestStatus APPROVED`.

### 3.2 Kontrak di batas HTTP, termasuk payload retry

`test/approval-http.e2e-spec.ts`:

- Test A sudah menegaskan `idempotency-key === body.command_id` dan `x-alim-api-version === '1'`.
- Test retry **kini** menegaskan bahwa percobaan kedua mengirim **body yang identik** (`toEqual`) dan
  header `Idempotency-Key` yang sama. Sebelumnya hanya `command_id` dan `external_message_id` yang
  dibandingkan, sehingga payload yang menyimpang (mis. `approved_duration_days`) akan lolos.

### 3.3 Guard kesiapan, dijaga oleh test yang membaca sumber

`src/common/alim-core-readiness.spec.ts` (baru) membandingkan `CHECKS` dari runner dengan kode aplikasi:
setiap nama harus benar-benar dibaca `src/config/configuration.ts`, harus terdaftar di
`BLANK_SHADOWED_ENV_KEYS`, tidak boleh berawalan `CONNECT_`, dan tiga setelan yang membuat sebuah run
berarti apa pun harus `required`. Dengan test ini, dokumen rekonsiliasi tidak dapat menyimpang diam-diam
lagi.

### 3.4 Koreksi dokumen

`docs/integration/alim-connect-env-reconciliation.md` dan `alim-connect-pdca-cycle-6.md` sebelumnya
menyebut `CONNECT_SSO_FRAME_ORIGIN` sebagai "satu nilai" dengan `ALIM_CORE_WEB_ORIGIN`, dan
`CONNECT_SSO_HANDOFF_URL` sebagai "tidak ada setelan". Keduanya salah arah: nilai Core itu menunjuk
**Connect**, sedangkan nilai Connect menunjuk **Core**. Sudah diganti, termasuk tambahan bahwa nama
header pun punya pasangan dua sisi (`ALIM_*_API_HEADER` ↔ `CONNECT_*_API_HEADER`).

`docs/integration/alim-connect-staging-verification.md`: baris tabel yang rusak (§7) diperbaiki, dan
ditambahkan baris versi kontrak (`ALIM_CORE_API_VERSION`, dikonfirmasi dari `configuration.ts:586`) serta
arah allowlist IP Core.

---

## 4. Berkas yang dibuat dan diubah

| Berkas                                                  | Perubahan                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/common/alim-core-readiness.spec.ts`                | **baru** — 5 test yang membandingkan runner dengan kode aplikasi         |
| `scripts/alim-core-integration-lane.ts`                 | `Check`/`CHECKS` diekspor; entry point dijaga `require.main === module`  |
| `test/approval-http.e2e-spec.ts`                        | payload retry identik; section Core nyata diperbaiki dan diberi diagnosa |
| `docs/integration/alim-connect-env-reconciliation.md`   | arah `CONNECT_*` dikoreksi; pasangan nama header ditambahkan             |
| `docs/integration/alim-connect-pdca-cycle-6.md`         | tabel rekonsiliasi dikoreksi                                             |
| `docs/integration/alim-connect-staging-verification.md` | tabel §7 diperbaiki; baris versi kontrak dan allowlist IP ditambahkan    |

Tidak ada perubahan pada `src/` selain file test. Tidak ada skema, migrasi, atau kontrak yang berubah.

---

## 5. Verifikasi yang dijalankan (bukti)

| Gerbang                     | Hepa    | Hasil                                                                                     |
| --------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `tsc --noEmit`              | 3 GB    | 0 error                                                                                   |
| `npm run lint`              | 3 GB    | 0 error                                                                                   |
| `npm run build`             | 3 GB    | sukses                                                                                    |
| Unit + contract (`jest`)    | 3 GB    | lihat §8                                                                                  |
| HTTP E2E (SSO + approval)   | 3 GB    | **43 lulus, 3 skip** (2 suite)                                                            |
| PG lane (`test:pg-lane`)    | default | **134/134, 14 suite, 0 skip**                                                             |
| Guard kesiapan tanpa nilai  | —       | exit **2**, menyebut `ALIM_CORE_BASE_URL`, `ALIM_CONNECT_SSO_KEY`, `ALIM_CORE_WEB_ORIGIN` |
| Guard kesiapan dengan nilai | —       | exit **0**, kedua integrasi `ready`                                                       |
| Kebocoran nilai pada guard  | —       | 5 nilai penanda di-grep: **0 kemunculan** di stdout+stderr                                |

Heap 6 GB tidak dipakai di mana pun. Tes dijalankan serial terhadap PG dan E2E karena mesin 8 GB.

### 5.1 Empat cacat di section Core nyata — riwayat perbaikannya

Ditemukan berurutan saat section itu dijalankan dengan Core palsu "yang tidak dapat dihubungi":

1. `409 identity_reassign_requires_flag` → `reassign: true`.
2. `expect([200,201]).toContain(status)` gagal karena `expect(Number)` membandingkan angka dengan array →
   pemeriksaan eksplisit.
3. `no command was created` → referensi `PROBE-C5-…` tidak dikenali parser → `IZN-2026-NNNNNNNN`.
4. `no command was created` → `targetCorePersonId` tidak diingest → ditambahkan eksplisit.

Setelah keempatnya, hasil: `[real-core] {"status":"APPLIED","attempts":1,"coreResponseCode":200,"requestStatus":"APPROVED"}`.

---

## 6. Status staging: belum ada, dan apa yang diminta

```
$ env | grep -c '^ALIM_'     → 0
$ npm run test:core-integration:lane
  SSO (exchange)     MISSING ALIM_CORE_BASE_URL, ALIM_CONNECT_SSO_KEY, ALIM_CORE_WEB_ORIGIN
  approval (command) MISSING ALIM_CORE_BASE_URL, ALIM_CORE_APPROVAL_API_KEY, ALIM_CONNECT_INGEST_KEY
  Not ready.         (exit 2)
```

Tidak ada satu pun request HTTP ke Core staging pada siklus ini, dan tidak ada yang diklaim sebagai
hasil integrasi nyata.

### 6.1 Yang harus diberikan Core (lewat secret manager, bukan chat/commit)

| #   | Nilai                                                       | Untuk                        | Blocker? |
| --- | ----------------------------------------------------------- | ---------------------------- | -------- |
| 1   | URL dasar staging (tanpa garis miring akhir)                | `ALIM_CORE_BASE_URL`         | ya       |
| 2   | Kunci `sso:exchange`                                        | `ALIM_CONNECT_SSO_KEY`       | SSO      |
| 3   | Origin browser Core staging                                 | `ALIM_CORE_WEB_ORIGIN`       | SSO      |
| 4   | Kunci `approval:command`                                    | `ALIM_CORE_APPROVAL_API_KEY` | approval |
| 5   | Konfirmasi nama header (default `X-ALIM-CONNECT-*-KEY`)     | kedua header                 | tidak    |
| 6   | Konfirmasi versi kontrak (`1`)                              | `X-ALIM-API-Version`         | tidak    |
| 7   | Satu kode handoff **baru** per uji sukses SSO               | `--sso-code=`                | tidak    |
| 8   | Satu permit staging terbuka + aktor Kepala Asrama sah       | uji approval                 | tidak    |
| 9   | CIDR egress staging Connect (untuk `CONNECT_*_ALLOWED_IPS`) | Core sisi masuk              | tidak    |

`ALIM_CONNECT_INGEST_KEY` diterbitkan di sisi Connect lalu diserahkan ke Core, bukan sebaliknya.

---

## 7. Blocker & batas yang jujur

| #   | Hal                                                                       | Status                                                                                                             |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| B1  | Tidak ada kredensial/URL staging di mesin ini                             | **Terbuka** — bergantung Core                                                                                      |
| B2  | Tidak ada kode handoff yang dapat diterbitkan Connect                     | **Terbuka** — hanya Core dapat menerbitkan; uji sukses SSO menunggu kode                                           |
| B3  | Tidak ada permit staging yang boleh diputuskan                            | **Terbuka** — uji command approval nyata menunggu data uji dari Core                                               |
| B4  | Script di `scripts/` di luar `tsconfig` tidak di-lint oleh `npm run lint` | **Diketahui, tidak diubah.** Menambahkannya memunculkan 5 error lama di 4 script lain (di luar lingkup siklus ini) |
| B5  | Connect belum punya allowlist IP masuk dari Core                          | **Batas desain** — penggantinya Origin allowlist + throttle + ingest key                                           |
| B6  | Pencabutan kewenangan tidak di-query ulang oleh retry                     | **Batas desain** — kewenangan final di Core                                                                        |

---

## 8. Plan / Do / Check / Act

**Plan.** Enam hal yang berdiri sendiri dari ketersediaan staging: koreksi dokumen env, verifikasi
runner terhadap kode, kontrak header/versi/idempotensi di batas HTTP, payload retry, skenario uji SSO &
approval, dan pemeriksaan kebocoran.

**Do.** Semua dikerjakan di §3. Satu cacat produk-produk-test (section Core nyata) ditemukan saat
benar-benar dijalankan, bukan saat dibaca.

**Check.**

| Gerbang                            | Hasil                                                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tsc / lint / build                 | 0 / 0 / sukses                                                                                                                                                                            |
| Unit + contract (`jest`, 2 worker) | 861 suite lulus, 14 skip, **3 suite gagal** — lihat catatan di bawah; ketiganya lulus saat dijalankan sendiri, dan _baseline_ tanpa perubahan siklus ini gagal **6 test di 3 suite lain** |
| HTTP E2E                           | 43 lulus, 3 skip (2 skip = section Core nyata, 1 = SSO sungguhan)                                                                                                                         |
| PG lane                            | 134/134, 14 suite, 0 skip                                                                                                                                                                 |
| Guard tanpa nilai                  | exit 2; guard dengan nilai exit 0; 0 kebocoran                                                                                                                                            |

**Catatan kegagalan penuh (tidak disamarkan).** Dua run penuh berturut-turut gagal di suite yang
berbeda setiap kali, semuanya lolos bila dijalankan sendiri:

| Run                               | Suite gagal                                                                                  | Bila dijalankan sendiri |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------- |
| dengan perubahan                  | `message-projector.tombstone-identity`, `message-mutation-projector`                         | 123/123 dan 4/4 lulus   |
| _baseline_ (perubahan di-_stash_) | `chat-media-archive.service` (977 dtk), `launch-args` (483 dtk), `session-ownership.service` | —                       |

Kesimpulan: suite ini tidak dapat dipakai sebagai bukti merah/hijau pada mesin 8 GB dengan beban
paralel lama. Yang dapat dipakai adalah subset yang relevan (`src/modules/session`:
**85/85 suite, 2251 lulus**) plus gerbang yang dijalankan serial (E2E, PG lane). Tidak ada threshold
coverage yang diturunkan dan tidak ada asersi yang dihapus.

**Act.** Siklus berikutnya tetap: begitu Butir 1–4 di §6.1 tersedia, jalankan
`npm run test:core-integration:lane` → `--approval` → `--sso-code=…` secara berurutan. Tidak ada
perubahan kode yang diharapkan dibutuhkan; bila ternyata dibutuhkan, itu temuan baru, bukan asumsi.

---

## 9. Kesimpulan

Persiapan staging **selesai**: runner, guard, dokumen, dan skenario uji sudah konsisten dengan kontrak
Core yang dibuktikan. Kontrak header, versi, dan idempotensi **terbukti di batas HTTP**, termasuk bahwa
retry mengirim ulang body dan key yang identik. Integrasi nyata dengan Core staging **belum** berjalan,
dan laporan ini tidak mengklaim sebaliknya.
