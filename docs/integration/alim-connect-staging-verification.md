# Prosedur Verifikasi Integrasi dengan ALIM Core Staging

**Siklus:** PDCA 6 · **Status kode:** siap — tidak ada perubahan kode yang dibutuhkan untuk menjalankan
dokumen ini. Yang belum ada hanya nilai konfigurasi dari Core.

Dokumen ini dapat dieksekusi apa adanya setelah Core menerbitkan nilai di §1. Setiap langkah mencetak
bukti yang dapat ditempel ke laporan tanpa membocorkan rahasia.

---

## 1. Yang harus disediakan Core / operator staging

| #   | Nilai                                                                    | Diberikan oleh                                             | Dipakai untuk                                                                                    | Blocker?                                                             |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 1   | URL dasar Core staging (tanpa garis miring akhir)                        | Core                                                       | `ALIM_CORE_BASE_URL`                                                                             | **ya**                                                               |
| 2   | Kunci layanan `sso:exchange`                                             | Core                                                       | `ALIM_CONNECT_SSO_KEY`                                                                           | **ya** untuk SSO                                                     |
| 3   | Origin browser Core staging (skema + host, tanpa path)                   | Core                                                       | `ALIM_CORE_WEB_ORIGIN`                                                                           | **ya** untuk SSO                                                     |
| 4   | Kunci layanan `approval:command`                                         | Core                                                       | `ALIM_CORE_APPROVAL_API_KEY`                                                                     | **ya** untuk approval                                                |
| 5   | Nilai yang dipakai Core untuk membaca header approval                    | Core                                                       | `ALIM_CORE_APPROVAL_API_HEADER` — bila Core memakai nama lain dari `X-ALIM-CONNECT-APPROVAL-KEY` | tidak (default cocok bila Core setuju)                               |
| 5b  | Versi kontrak yang diterima Core (`1`)                                   | Core                                                       | `ALIM_CORE_API_VERSION` (default `1`)                                                            | tidak — Core hanya menolak versi tak dikenal                         |
| 5c  | Alamat IP **keluar** server Core staging                                 | Core                                                       | daftar `CONNECT_*_ALLOWED_IPS` **di sisi Core**                                                  | tidak untuk Connect; **ya** bila Core menyaring IP keluar ke Connect |
| 6   | Kunci layanan yang **Core** akan pakai untuk memanggil Connect           | operator Connect (diterbitkan sendiri), diserahkan ke Core | `ALIM_CONNECT_INGEST_KEY`                                                                        | tidak untuk E2E keluar; **ya** bila Core akan mendorong permohonan   |
| 7   | Satu kode handoff yang **baru** untuk uji exchange sukses                | Core, setiap kali uji                                      | `--sso-code=`                                                                                    | tidak (hanya jalur sukses)                                           |
| 8   | Konfirmasi `audience` dan `scope` yang Core terima                       | Core                                                       | `ALIM_CONNECT_SSO_AUDIENCE`, `ALIM_CONNECT_SSO_SCOPE`                                            | tidak (default `connect` / `whatsapp.embed`)                         |
| 9   | Satu `dormitory_permits` staging yang masih terbuka dan boleh diputuskan | Core                                                       | uji approval                                                                                     | tidak untuk uji penolakan                                            |

Butir 7 dan 9 adalah **data uji**, bukan konfigurasi: keduanya habis/berubah setiap kali dipakai.
Jangan memakai data produksi.

Daftar CIDR staging untuk allowlist IP **tidak** diperlukan: Connect belum mengimplementasikan
allowlist IP (lihat `alim-connect-env-reconciliation.md` §3).

---

## 2. Konfigurasi (sekali)

```bash
# 1..5 + 8 dari §1. Jangan commit nilai ini; isi di .env staging atau environment orchestrator.
export ALIM_CORE_BASE_URL='<url core staging>'
export ALIM_CONNECT_SSO_KEY='<kunci sso:exchange>'
export ALIM_CORE_WEB_ORIGIN='<origin browser core staging>'
export ALIM_CORE_APPROVAL_API_KEY='<kunci approval:command>'
export ALIM_CONNECT_INGEST_KEY='<kunci yang Core pegang>'
export ALIM_CONNECT_CORE_CLIENT=http      # tanpa ini aplikasi memakai klien mock
```

`ALIM_CONNECT_CORE_CLIENT=http` bukan opsional: dengan nilai lain Connect memakai klien mock dan
tidak ada satu pun request yang sampai ke Core. Di lingkungan produksi aplikasi menolak boot dengan
mock, jadi nilai ini melindungi staging dari hasil yang menyesatkan.

Setiap nilai di atas terdaftar di `BLANK_SHADOWED_ENV_KEYS`, sehingga nilai kosong berarti
"tidak di-set" — bukan string kosong yang menutupi `.env`.

---

## 3. Gerbang kesiapan

```bash
npm run test:core-integration:lane
```

Harapan: **exit 0** dan kedua baris `ready`. Bila masih `MISSING`, guard menyebut nama yang kurang
dan **tidak menjalankan apa pun** (exit 2). Jangan lanjut sebelum exit 0 — run dengan konfigurasi
belum lengkap hanya akan menjalankan section mock dan terbaca seperti lulus.

---

## 4. SSO: jalur penolakan (tidak memakan kode)

```bash
npm run test:core-integration
```

Menjalankan `test/sso-handoff-http.e2e-spec.ts`, yang mencakup:

| Yang dibuktikan          | Cara dibuktikan                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Kode rekaan ditolak Core | Core menjawab 4xx bisnis, Connect menjawab penolakan, **tidak ada sesi** dibuat                        |
| Kode/kunci tidak bocor   | stdout + stderr diperiksa tidak memuat kode dan tidak memuat kunci                                     |
| Endpoint & header benar  | Penolakan bisnis (bukan `core_error`/`core_unreachable`) membuktikan rute, base URL, dan header sampai |
| Tanpa sesi palsu         | `user_sessions` tidak bertambah                                                                        |

`core_unreachable` atau `core_error` di sini berarti **konfigurasi/jejaring**, bukan penolakan Core:
periksa base URL dan header sebelum menganggap kode uji salah.

---

## 5. SSO: jalur sukses (memakan satu kode)

Minta kode baru ke Core, lalu dalam satu perintah:

```bash
npm run test:core-integration -- --sso-code='<kode baru>'
```

Yang harus terlihat pada bukti:

1. `PASS` dengan `core_user_id` yang **Anda kenali** sebagai orang yang meminta kode.
2. Satu baris `[real-core]` (bila diaktifkan di suite) memuat `core_user_id` dan status.
3. Sesi Connect dibuat untuk akun yang **sudah ada**; bila `core_user_id` belum terpetakan ke akun,
   hasilnya penolakan `identity_not_mapped` — itu perilaku yang benar, bukan kegagalan.

Kode bersifat sekali-pakai dan dihabiskan oleh langkah ini, termasuk bila pertukaran gagal.

---

## 6. Approval: satu command nyata

```bash
npm run test:core-integration -- --approval
```

Membutuhkan butir 9 (§1): satu permit staging yang masih terbuka. Suite:

1. Menerbitkan permohonan lewat `POST /api/approval/requests` (sebagai Core, dengan ingest key).
2. Mensimulasikan balasan WhatsApp Kepala Asrama dan memastikan command terkirim ke Core.
3. Mencatat satu baris `[real-core]` berisi `commandId`, `status`, `attempts`, `coreResponseCode`,
   `errorCode`, `requestStatus`, `coreStatus` — inilah bukti untuk laporan.

Yang harus terlihat:

| Asersi                             | Arti bila gagal                                             |
| ---------------------------------- | ----------------------------------------------------------- |
| `coreResponseCode` ∈ {200,201,202} | Core menolak atau tidak menerima header — salah konfigurasi |
| `status` ∈ {APPLIED, DUPLICATE}    | Core menjawab bisnis lain; periksa `errorCode`              |
| `requestStatus = APPROVED`         | Negara lokal tidak mengikuti Core                           |

**Bukti tidak ada pemrosesan ganda:** kirim ulang command yang sama (suite melakukannya) → Core harus
menjawab `duplicate` dan status permit tidak berubah. Header `Idempotency-Key` memakai nilai yang sama
dengan `command_id` di body pada setiap percobaan; ini keputusan kontrak yang disengaja (§9
`alim-connect-core-integration-contract.md`) dan diverifikasi di batas HTTP oleh suite.

---

## 7. Retry, timeout, replay, dan kredensial tidak sah

| Skenario             | Cara memicu                                                         | Bukti yang diharapkan                                                                                      |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Timeout              | `ALIM_CORE_TIMEOUT_MS=1` lalu kirim satu command                    | Command `UNKNOWN`, bukan gagal; tidak ada keputusan ganda                                                  |
| Retry dengan id sama | `ALIM_CONNECT_RETRY_MAX_ATTEMPTS=3`, lalu `npm run … -- --approval` | `attempts` bertambah, `commandId` **tidak berubah**, body percobaan ulang identik dengan percobaan pertama |
| Replay               | Kirim ulang command setelah `APPLIED`                               | `duplicate`, permit tidak berubah                                                                          |
| Konflik payload      | `command_id` sama, isi body berbeda                                 | Core 409 `command_id_reused` → command `REJECTED`, tidak di-retry                                          |
| Kredensial tidak sah | `ALIM_CORE_APPROVAL_API_KEY` salah                                  | Core 401/403 → command `REJECTED`, tidak di-retry                                                          |
| Retry habis          | timeout tetap, `maxAttempts` kecil                                  | Command `FAILED`, `nextAttemptAt = null`                                                                   |
| Pencabutan akses     | Core mencabut pemetaan, lalu balasan baru datang                    | Penolakan sebelum command dikirim (`unknown_sender`)                                                       |

**Pencabutan tidak dapat dilewati oleh retry, dengan batas yang perlu dinyatakan:** worker retry
tidak menanyakan ulang ke Core apakah aktor masih berwenang — ia mengirim ulang command yang
**sudah** dibuat. Kewenangan final tetap di Core, yang menyelesaikan aktor dari pemetaan
terverifikasi miliknya, sehingga command dari aktor yang dicabut ditolak di sana. Yang Connect
jamin adalah bahwa **balasan baru** dari nomor yang dipetakan ulang/dinonaktifkan tidak akan pernah
menjadi command baru.

---

## 8. Jejak audit

Setiap hasil command menulis satu baris `approval_command`. Periksa:

```bash
curl -s -H "x-api-key: <key ADMIN>" "$BASE/audit?action=approval_command&limit=20"
```

(`GET /audit`, tanpa prefix global — jalur `api` tidak dipasang oleh `main.ts`.)

Baris memuat `commandId`, `coreRequestId`, `decision`, `attempts`, `commandStatus`,
`coreResponseCode`, `coreErrorCode`, `actorCorePersonId`, dan `outcome`. Baris **tidak** memuat teks
balasan WhatsApp, nomor pengirim, atau kunci apa pun.

Korelasi ke request HTTP: audit menstempel request id aktif, jadi baris dapat ditelusuri ke baris log
yang sama.

---

## 9. Yang tidak termasuk prosedur ini

- Browser Chrome/Safari/Firefox — di-skip sesuai keputusan; bukan blocker.
- Allowlist IP untuk Core — belum diimplementasikan.
- Scoping `VIEWER` per unit dan retensi PII — menunggu keputusan pemilik.
