# Laporan PDCA Siklus 12 — Bukti Integrasi Nyata: Approval, SSO, dan Aktor Staging

**Tanggal:** 2026-11-24/25 · **Repo:** OpenWA (Connect) · **Branch:** `feature/whatsapp-approval-finalization`
**HEAD awal:** `82f5a1ed3` (penutupan siklus 11) · **HEAD akhir:** `82f5a1ed3` + perubahan siklus ini di
working tree, **belum di-commit** (batasan siklus 12: tidak push tanpa persetujuan)

**Ringkasan satu paragraf:** jalur HTTP nyata Connect → Core sudah **terbukti sampai ke Core**, bukan
sampai ke mock: kunci SSO dan kunci approval diterima Core (401 pada `GET`, 404 `code_not_found` /
403 `actor_identity_missing` pada `POST`), dan penolakan yang tersisa **bukan** masalah koneksi atau
kredensial melainkan **data uji dari Core** (aktor belum dipetakan, permit belum ada, kode SSO belum
diterbitkan). Tiga kriteria keberhasilan siklus ini **belum** terpenuhi karena itu, dan laporan ini
menyebutkan persis apa yang harus dikirim Core untuk masing-masing. Di sisi Connect, siklus ini
menemukan dan memperbaiki empat cacat bukti yang akan membuat laporan "lulus" padahal tidak
membuktikan apa-apa (§3), dan mengubah bagian nyata approval agar membalas dari nomor aktor yang
benar — balasan dari nomor lain ditolak Connect _sebelum_ Core dipanggil, sehingga setiap run
sebelumnya yang memakai nomor mock tidak pernah menguji Core sama sekali.

**Status per kriteria:**

| #   | Kriteria                                                | Status    | Bukti / sebab                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Approval WhatsApp diproses Core dengan aktor terpetakan | **BELUM** | Nomor uji `6281234567890` yang dikirim sebagai aktor (nomor contoh dokumentasi, **tidak** dipetakan di Core) dijawab Core `403 actor_identity_unmapped`, baik lewat balasan WhatsApp maupun lewat command langsung. Command-nya benar-benar sampai ke Core (§5). |
| 2   | Status permit dan audit Core terverifikasi              | **BELUM** | Butuh kriteria 1. Status permit hanya bisa dibaca di Core setelah ada permit nyata; Connect menyiapkan verifikasi sisi Connect (audit `APPROVAL_COMMAND`, `coreStatus`) dan mencetak `coreStatus` permit untuk dicocokkan operator dengan Core.                  |
| 3   | SSO sukses dengan kode nyata                            | **BELUM** | Kode harus diterbitkan Core (sekali pakai) lewat UI-nya; Connect tidak boleh mengarangnya. Jalur **penolakan** nyata terbukti (§6).                                                                                                                              |

---

## 1. Environment yang diuji (tanpa rahasia)

| Hal                                                       | Nilai                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core                                                      | `http://127.0.0.1:8001` — instance Core sungguhan di mesin pengembang, **bukan staging** dan **bukan mock**                                                                                                                                                                                        |
| Pembeda dari mock                                         | Suite e2e menyalakan mock Core di port acak (`127.0.0.1:<port acak>`) _setelah_ nilai operator ditangkap; bagian nyata mengarahkan `ConfigService` ke `127.0.0.1:8001` sebelum request. Siklus ini menambah pemeriksaan bahwa **tidak ada** command yang masuk ke recorder mock (§3, bukti di §5). |
| Core `/health/`                                           | `200 {"status":"ok"}` (tanpa auth)                                                                                                                                                                                                                                                                 |
| Core `POST /api/connect/v1/sso/exchange` tanpa kunci      | `401`                                                                                                                                                                                                                                                                                              |
| Core `POST /api/connect/v1/approval-commands` tanpa kunci | `401`                                                                                                                                                                                                                                                                                              |
| Kunci Connect (SSO, approval, ingest)                     | sudah ada di `.env`; **tidak** dicetak di laporan ini                                                                                                                                                                                                                                              |
| Jalur HTTP                                                | clause penuh: `ALIM_CONNECT_CORE_CLIENT=http`, `ALIM_CONNECT_API_VERSION=1`, header default (`X-ALIM-CONNECT-SSO-KEY`, `X-ALIM-CONNECT-APPROVAL-KEY`)                                                                                                                                              |
| Aktor uji                                                 | `ALIM_CONNECT_STAGING_ACTOR_NUMBER=6281234567890` (nomor contoh dari dokumentasi, **bukan** pemetaan Core) + `ALIM_CONNECT_STAGING_ACTOR_CORE_USER=00000000-0000-4000-8000-000000000007` (UUID karangan untuk memaksa bagian nyata berjalan)                                                       |
| RAM / cara jalan                                          | satu proses berat pada satu waktu; `--maxWorkers=1`/`2`; tanpa full suite                                                                                                                                                                                                                          |

> Nomor dan UUID aktor di atas **sengaja nilai contoh**: tujuan run ini adalah membuktikan _apa yang
> Core jawab untuk aktor yang tidak dipetakan_, bukan mengarang bukti. Nilai asli hanya dimiliki Core.

## 2. Perubahan siklus ini (working tree, belum commit)

| Berkas                                             | Perubahan                                                                                        | Sebab                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `test/approval-http.e2e-spec.ts`                   | bagian `Z. ALIM Core sungguhan` ditulis ulang                                                    | empat cacat bukti (§3) + balasan dari nomor aktor                                               |
| `scripts/alim-core-probe.ts`                       | flag dibaca saat dipanggil (`selection()`); penolakan `actor_*` dilaporkan `WARN`, bukan `PASS`  | probe yang menolak aktornya sendiri dilaporkan sebagai bukti rute                               |
| `src/common/alim-core-probe-verdict.spec.ts`       | baru, 3 test                                                                                     | mengunci dua verdict probe di atas                                                              |
| `src/common/alim-core-approval-proof.spec.ts`      | baru, 7 test                                                                                     | mengunci apa yang dibaca bagian nyata approval                                                  |
| `docs/integration/alim-connect-staging-handoff.md` | §1 baris 8 dan §2 diperjelas: aktor **hanya** dari environment, bukan dari konfigurasi tersimpan | operator yang menyimpan aktor ke `data/.env.generated` melihat bagian nyata **skip** tanpa tahu |

Tidak ada perubahan kontrak API, tidak ada perubahan repo Core, tidak ada push.

## 3. Cacat bukti yang ditemukan dan diperbaiki

Siklus ini tidak mengulang audit siklus 10–11; keempat cacat ini ditemukan **karena** menjalankan
bagian nyata terhadap Core sungguhan, dan masing-masing akan membuat run terlihat lulus tanpa bukti:

1. **Balasan dikirim dari nomor mock.** Bagian nyata memakai `reply()` yang mengirim dari
   `TARGET_NUMBER` (`628111000001`), sedangkan permitnya ditujukan ke aktor staging. Processor menolak
   balasan itu `not_authorized` **sebelum Core dipanggil**; kalau permitnya kebetulan juga milik
   `TARGET_NUMBER`, suite B sudah memetakan nomor itu ke personel lain sehingga Core menolak aktornya.
   Dua-duanya bukan bukti tentang Core. Kini balasan datang dari `ACTOR_JID`
   (`<aktor>@s.whatsapp.net`).
2. **Membaca permit sebelum Core menjawab.** Hook balasan menyimpan command lalu memanggil Core tanpa
   menunggu jawabannya; pembacaan langsung sesudah `await reply(...)` melihat `PENDING_APPROVAL` tanpa
   command. Run pertama siklus ini karena itu melaporkan "no command was created" untuk permit yang
   command-nya memang sedang dikirim. Kini `waitForCommand()` menunggu command tersimpan dan statusnya
   lewat `PENDING` (maks 20 s), dan `coreStatus` diberi assertion `not.toBe('pending')`.
3. **Tidak ada bukti bahwa request sampai ke Core, bukan ke mock.** Kini bagian nyata memeriksa
   recorder mock: ada command → run gagal dengan pesan bahwa command masuk ke mock.
4. **Probe approval melaporkan `PASS` untuk penolakan aktornya sendiri.** `npm run probe:alim-core --
--approval` mengirim aktor `probe-not-a-person`; Core menjawab `403 actor_identity_missing`, dan probe
   menyebut itu "route + key accepted" — benar untuk rute, menyesatkan untuk aktor. Kini dilaporkan
   `WARN` dengan penjelasan, dan spec mengunci kedua verdict.

Ditambah satu **bukti aktor baru**: `menolak aktor yang tidak dikenali Core, dan membuktikan yang
terpetakan diterima` mengirim dua command yang tidak menyebut permit apa pun (jadi tidak mungkin
menyetujui apa pun) — satu dengan nomor yang tidak mungkin dipetakan Core (nomor aktor dengan digit
terakhir diganti), satu dengan aktor staging. Yang pertama harus `actor_identity_unmapped`; yang kedua
harus ditolak **bukan** karena aktor (404 `request_not_found`). Tanpa pasangan ini, penolakan aktor
dan penolakan permit tidak bisa dibedakan dari laporan.

## 4. Jalankan yang benar (agar hasilnya bisa dipercaya)

`.env` **tidak** otomatis masuk ke environment proses skrip; guard membaca `process.env`. Tanpa
`set -a; . ./.env; set +a`, lane melaporkan semua nilai `MISSING` walaupun `.env` lengkap (§5 catatan
siklus 11). Variabel aktor harus di-export, bukan disimpan di `data/.env.generated`.

```
set -a; . ./.env; set +a
export ALIM_CONNECT_STAGING_ACTOR_NUMBER=<digit E.164, mis. 6281xxxxxxxxx>
export ALIM_CONNECT_STAGING_ACTOR_CORE_USER=<core_user_id aktor>
npm run test:core-integration:lane
npm run test:core-integration -- --approval
```

## 5. Hasil approval (HTTP nyata)

Run: `npx jest --config ./test/jest-e2e.json --testPathPatterns approval-http` dengan env §4 dan
aktor contoh `6281234567890`.

| Yang diperiksa                             | Hasil                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Balasan WhatsApp → command tersimpan       | **ya** — `commandId` UUID, `decision: approved`, `external_message_id: wamid-real-<uuid>`, dibuat dari balasan `ACTOR_JID`                                      |
| Request command benar-benar sampai ke Core | **ya** — Core menjawab dengan kode bisnisnya sendiri (`403 actor_identity_unmapped`), bukan mock; recorder mock tidak menerima command                          |
| `Idempotency-Key` = `command_id`           | diset oleh klien HTTP dan diuji pada bagian mock (`call.headers['idempotency-key'] === call.body.command_id`)                                                   |
| `X-ALIM-API-Version`                       | `1`                                                                                                                                                             |
| Jawaban Core untuk command nyata           | `HTTP 403`, `actor_identity_unmapped`, `coreResponseCode: 403`, `status: REJECTED`, `attempts: 1`                                                               |
| Status permit sesudahnya                   | `requestStatus: PENDING_APPROVAL`, `coreStatus: pending` — tidak berubah, karena Core tidak pernah menerapkan keputusan                                         |
| Bukti aktor: nomor tak terpetakan          | `403 actor_identity_unmapped`                                                                                                                                   |
| Bukti aktor: nomor aktor contoh            | `403 actor_identity_unmapped` ← menunjukkan nomor itu memang tidak dipetakan di Core                                                                            |
| Audit Connect (`APPROVAL_COMMAND`)         | ada, satu baris, `coreResponseCode`/`commandStatus`/`decision`/`coreRequestId` cocok dengan command; **tidak** memuat nomor aktor, referensi permit, atau kunci |
| Replay & penolakan                         | **belum berjalan** — hanya setelah ada keputusan yang diterapkan (kriteria 1)                                                                                   |
| Perubahan status permit                    | **belum** — Core belum menerapkan apa pun                                                                                                                       |

Bukti verbatim (dari keluaran suite, tanpa secret):

```
[real-core] approval command {"commandId":"976f55d5-…","status":"REJECTED","attempts":1,
  "coreResponseCode":403,"errorCode":"actor_identity_unmapped",
  "requestStatus":"PENDING_APPROVAL","coreStatus":"pending"}
[real-core] actor check {"unmapped":{"outcome":"rejected","httpStatus":403,"code":"actor_identity_unmapped"},
  "mapped":{"outcome":"rejected","httpStatus":403,"code":"actor_identity_unmapped"}}
```

Dua test yang berjalan: `mengirim satu command dan mencatat jawaban Core yang sebenarnya` **lulus**
(dengan cabang "Core menolak" yang dilaporkan, bukan diklaim), `menolak aktor…` **gagal pada assertion
yang disengaja** karena aktor contoh tidak dipetakan — itulah bukti yang dicari.

## 6. Hasil SSO (HTTP nyata)

| Probe                             | Hasil                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe:alim-core` (kode karangan) | `PASS` — Core menjawab `404 code_not_found`: rute + kunci diterima                                                                                         |
| Suite e2e bagian `Z`              | `menolak kode yang tidak pernah diterbitkan Core` lulus; `mencatat kode status Core untuk kode yang direkayasa` lulus — kode dan kunci tidak muncul di log |
| Exchange kode nyata               | **skip** — belum ada kode yang diterbitkan Core                                                                                                            |

## 7. Known issues

| #   | Hal                                                                                                                                                             | Dampak                                                      | Status                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Dua test `baileys-events` ("three media deadlines…", "does not keep the process alive…") gagal hanya pada full run headless; lulus saat file dijalankan sendiri | tidak menghambat integrasi; memengaruhi `exit 0` full suite | open — lihat siklus 11 `b263c17aa`                         |
| 2   | `session-reconnect-stale-binding > is kept when the answer of the clear is late (answer failed: true)` timeout 5 s pada full run; lulus sendiri (25/25)         | sama                                                        | known issue timing, tidak diubah (tidak menaikkan timeout) |
| 3   | `probe:alim-core --approval` sekarang `WARN` untuk `actor_*`                                                                                                    | tidak ada                                                   | selesai siklus ini                                         |
| 4   | `scripts/` di luar `tsconfig.json`, jadi `eslint` pada `scripts/*.ts` melaporkan parsing error (sudah begitu sebelum siklus ini)                                | tidak ada; skrip tetap di-`ts-node`                         | known                                                      |

## 8. Blocker eksternal (Core)

| #   | Yang dibutuhkan                                                                                                                                                 | Untuk           | Bukti yang harus dikirim Core                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | Nomor WhatsApp uji yang **sudah dipetakan dan terverifikasi** di Core → `core_user_id` personel yang aktif dan berwenang sebagai Kepala Asrama untuk permit uji | kriteria 1 & 2  | `core_user_id` + pernyataan pemetaan & kewenangan; bentuk `actor_external_id` yang diharapkan (Connect mengirim digit E.164 tanpa `+`)                                               |
| B   | Satu permit staging **terbuka** untuk personel itu                                                                                                              | kriteria 1 & 2  | UUID permit (`request_id`) atau alur resmi agar Core mengirimnya lewat `POST /api/approval/requests` (butuh `ALIM_CONNECT_INGEST_KEY`, lihat `alim-connect-staging-handoff.md` §2 A) |
| C   | Satu kode handoff **baru** per uji SSO                                                                                                                          | kriteria 3      | kode sekali pakai + `core_user_id` yang diharapkan (dikirim lewat jalur rahasia, bukan dokumen)                                                                                      |
| D   | Status migration staging + ref `git` Core                                                                                                                       | keandalan hasil | pernyataan                                                                                                                                                                           |

Catatan: kunci SSO/approval **sudah** diterima Core lokal; yang belum ada adalah **data uji** di atas,
bukan kredensial.

## 9. Keputusan kesiapan integrasi

**Integrasi belum bisa dinyatakan selesai.** Yang terbukti siklus ini: jalur HTTP, auth, routing, dan
pembentukan command Connect bekerja sampai ke Core sungguhan; yang belum: penerapan keputusan nyata,
perubahan status permit, audit Core, dan SSO sukses — ketiganya menunggu data uji #A–#C.

Begitu #A dan #B ada, perintah yang dijalankan tidak berubah (§4), dan suite sudah mencetak yang
dibutuhkan untuk dicocokkan dengan Core: `commandId`, `coreResponseCode`, `requestStatus`,
`coreStatus`, serta replay dan status permit sesudah replay.
