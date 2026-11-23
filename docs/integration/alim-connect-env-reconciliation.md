# Rekonsiliasi Environment Variable ALIM Connect ↔ ALIM Core

**Tanggal:** 2026-11-23 · **Siklus:** PDCA 6 · **Status:** hasil pemeriksaan kode aktual

Dokumen ini menjawab satu pertanyaan: untuk setiap nama variabel yang dipakai dalam komunikasi
Connect ↔ Core, **apa nama yang benar-benar dibaca kode**, ke arah mana request berjalan, dan
apakah dua nama berbeda berarti dua credential berbeda.

Tidak ada nilai rahasia di dokumen ini. Hanya nama dan sifatnya.

---

## 1. Aturan penentu: arah request, bukan nama

Sebuah nilai adalah **credential milik Core** bila Core menerbitkannya dan Connect **mengirimnya
keluar**. Sebuah nilai adalah **credential milik Connect** bila Connect menerbitkannya dan **Core
mengirimnya masuk**.

Konsekuensi yang mudah salah: `ALIM_CONNECT_SSO_KEY` berbunyi seperti milik Connect, tetapi ia
**dikeluarkan** Connect ke Core — jadi ia kredensial Core, disimpan di sisi Connect. Sebaliknya
`ALIM_CONNECT_INGEST_KEY` juga berbunyi seperti milik Connect, dan memang milik Connect: Core harus
memegangnya untuk memanggil Connect.

---

## 2. Peta lengkap

### 2.1 Keluar: Connect → Core

| Nama di kode (aktual)           | Arah   | Fungsi                                                    | Wajib | Default di kode                |
| ------------------------------- | ------ | --------------------------------------------------------- | ----- | ------------------------------ |
| `ALIM_CORE_BASE_URL`            | keluar | host Core untuk kedua integrasi                           | ya    | kosong (integrasi mati)        |
| `ALIM_CONNECT_SSO_KEY`          | keluar | nilai header exchange SSO                                 | ya    | kosong (SSO mati)              |
| `ALIM_CONNECT_SSO_API_HEADER`   | keluar | nama header yang membawa key SSO                          | tidak | `X-ALIM-CONNECT-SSO-KEY`       |
| `ALIM_CORE_APPROVAL_API_KEY`    | keluar | nilai header command approval                             | ya    | kosong (command tidak dikirim) |
| `ALIM_CORE_APPROVAL_API_HEADER` | keluar | nama header yang membawa key approval                     | tidak | `X-ALIM-CONNECT-APPROVAL-KEY`  |
| `ALIM_CORE_API_VERSION`         | keluar | nilai `X-ALIM-API-Version`; kosong = header tidak dikirim | tidak | `1`                            |
| `ALIM_CORE_TIMEOUT_MS`          | keluar | batas waktu satu panggilan HTTP                           | tidak | `5000`                         |
| `ALIM_CONNECT_SSO_AUDIENCE`     | keluar | `audience` di body exchange                               | tidak | `connect`                      |
| `ALIM_CONNECT_SSO_SCOPE`        | keluar | `scope` di body exchange                                  | tidak | `whatsapp.embed`               |

Dua key (`ALIM_CONNECT_SSO_KEY`, `ALIM_CORE_APPROVAL_API_KEY`) **harus berbeda**: Core mencakupkannya
ke `sso:exchange` dan `approval:command` secara terpisah.

### 2.2 Masuk: Core → Connect

| Nama di kode (aktual)     | Arah            | Fungsi                                                                                     | Wajib                     | Default                                               |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------ | ------------------------- | ----------------------------------------------------- |
| `ALIM_CONNECT_INGEST_KEY` | masuk           | Core membuktikan diri ke `POST /api/approval/requests`; header `X-ALIM-CONNECT-INGEST-KEY` | untuk menerima permohonan | kosong → rute menjawab **503**                        |
| `ALIM_CORE_WEB_ORIGIN`    | masuk (browser) | satu-satunya Origin yang boleh mem-post handoff dan meng-embed Connect                     | ya untuk SSO              | kosong → SSO mati, `frame-ancestors` tidak diperlebar |
| `TRUSTED_PROXIES`         | masuk           | proxy yang `X-Forwarded-For`-nya dipercaya saat menilai IP pemanggil                       | tidak                     | kosong → hanya alamat socket                          |

### 2.3 Nama di instruksi yang **tidak ada** di kode

| Nama di instruksi §2       | Nama aktual                                                                  | Catatan                                                                               |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `CONNECT_SSO_API_KEY`      | `ALIM_CONNECT_SSO_KEY`                                                       | **credential Core** yang dikeluarkan Connect. Bukan milik Connect.                    |
| `CONNECT_APPROVAL_API_KEY` | `ALIM_CORE_APPROVAL_API_KEY` (+ `ALIM_CORE_APPROVAL_API_HEADER`)             | pasangan yang sama seperti di atas.                                                   |
| `CONNECT_SSO_FRAME_ORIGIN` | `ALIM_CORE_WEB_ORIGIN`                                                       | satu nilai mengisi allowlist Origin **dan** `frame-ancestors` CSP. Bukan dua setelan. |
| `CONNECT_SSO_HANDOFF_URL`  | tidak ada setelan; rute **milik Connect sendiri** di `POST /api/sso/handoff` | Yang dikonfigurasi adalah URL Core yang di-embed, bukan URL handoff Connect.          |
| `CONNECT_*_ALLOWED_IPS`    | tidak ada di kode                                                            | Lihat §3 — belum diimplementasikan.                                                   |

Jadi `CONNECT_SSO_API_KEY` dan `ALIM_CONNECT_SSO_KEY` adalah **satu credential yang sama**, bukan dua;
begitu pula pasangan approval. Menyetel empat nilai berbeda akan membuat dua di antaranya tidak
dibaca kode dan dua lainnya kosong.

---

## 3. `CONNECT_*_ALLOWED_IPS` — belum ada, dan alasannya

Kode tidak memiliki allowlist IP untuk rute Core. Yang ada saat ini sebagai pengganti:

| Rute                          | Pengganti allowlist IP sekarang                               |
| ----------------------------- | ------------------------------------------------------------- |
| `POST /api/sso/handoff`       | allowlist **Origin** ketat + throttle 5/menit & 20/jam per IP |
| `POST /api/approval/requests` | `ALIM_CONNECT_INGEST_KEY` (fail-closed 503 bila kosong)       |

Ini bukan kelalaian yang disembunyikan: allowlist IP statis untuk Core berarti daftar IP yang harus
dipelihara setiap kali Core memindahkan ingress, dan `ALIM_CORE_BASE_URL` berskema host. Ia **belum**
diimplementasikan, jadi jangan diasumsikan ada. Bila Core mensyaratkannya, pekerjaan itu terpisah dan
butuh daftar CIDR staging dari Core.

---

## 4. Penyesuaian yang dibutuhkan supaya benar-benar terbaca

Sesuai `docker-compose.yml`, setiap `${KEY:-}` yang kosong menjadi string kosong di `process.env`,
dan string kosong akan **menutupi** `.env` (dotenv `override: false`). Karena itu setiap key di §2
wajib terdaftar di `BLANK_SHADOWED_ENV_KEYS` (`src/config/env-precedence.ts`) agar nilai kosong
diperlakukan sebagai "tidak di-set".

Terverifikasi terdaftar: `ALIM_CONNECT_CORE_CLIENT`, `ALIM_CORE_BASE_URL`,
`ALIM_CORE_APPROVAL_API_KEY`, `ALIM_CORE_APPROVAL_API_HEADER`, `ALIM_CORE_API_VERSION`,
`ALIM_CONNECT_INGEST_KEY`, `ALIM_CORE_TIMEOUT_MS`, `ALIM_CONNECT_SSO_KEY`,
`ALIM_CONNECT_SSO_API_HEADER`, `ALIM_CONNECT_SSO_TIMEOUT_MS`, `ALIM_CONNECT_SSO_AUDIENCE`,
`ALIM_CONNECT_SSO_SCOPE`, `ALIM_CONNECT_SSO_SESSION_TTL_HOURS`, `ALIM_CORE_WEB_ORIGIN`.

`TRUSTED_PROXIES` **tidak** diteruskan compose dan bukan `${KEY:-}`, jadi ia hanya berlaku bila
disetel langsung di host atau di `.env` yang dimuat `load-env`.

---

## 5. Cara memverifikasi tanpa mencetak rahasia

```bash
npm run test:core-integration:lane      # exit 0 = siap, 2 = belum; hanya nama yang dicetak
```

Guard mencetak `ready`, `blocks <NAMA>` (bagian yang membuat section nyata ter-skip atau fitur mati),
atau `degrades <NAMA>` (fitur hidup tetapi satu jalur menjawab 503). Nilai tidak pernah dicetak —
diuji dengan nilai penanda dan grep: nol kemunculan.
