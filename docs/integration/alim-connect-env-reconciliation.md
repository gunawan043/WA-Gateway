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

### 2.3 Dipasang di Core, bukan di Connect (`CONNECT_*`)

Sebagian besar nama `CONNECT_*` **ada**, tetapi bukan milik Connect: semuanya dibaca
`config/services.php` di repository ALIM Core. Menyetelnya di Connect tidak berpengaruh apa pun.
Dialah sisi yang harus dipasang operator Core.

| Nama (`CONNECT_*`)             | Pemilik | Arah yang dijelaskan         | Fungsi                                                                                         |
| ------------------------------ | ------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `CONNECT_SSO_API_KEY`          | Core    | masuk ke Core                | nilai yang dicocokkan terhadap key yang dikirim Connect (`ALIM_CONNECT_SSO_KEY`)               |
| `CONNECT_SSO_SCOPES`           | Core    | —                            | cakupan key SSO; default `sso:exchange`                                                        |
| `CONNECT_SSO_FRAME_ORIGIN`     | Core    | **Connect → Core (browser)** | origin **Connect** yang boleh di-iframe Core dan dipakai di `frame-src` CSP halaman embed Core |
| `CONNECT_SSO_HANDOFF_URL`      | Core    | **Connect → Core (browser)** | URL halaman handoff **Connect** (`https://connect/sso/handoff`) yang di-iframe Core            |
| `CONNECT_SSO_ALLOWED_IPS`      | Core    | masuk ke Core                | allowlist CIDR egress Connect di sisi Core                                                     |
| `CONNECT_APPROVAL_API_KEY`     | Core    | masuk ke Core                | nilai yang dicocokkan terhadap key yang dikirim Connect (`ALIM_CORE_APPROVAL_API_KEY`)         |
| `CONNECT_APPROVAL_SCOPES`      | Core    | —                            | cakupan key approval; default `approval:command`                                               |
| `CONNECT_APPROVAL_ALLOWED_IPS` | Core    | masuk ke Core                | allowlist CIDR egress Connect di sisi Core                                                     |
| `CONNECT_*_REQUIRE_HTTPS`      | Core    | —                            | menolak request non-HTTPS                                                                      |

**Nama header juga milik Core.** `CONNECT_SSO_API_HEADER` dan `CONNECT_APPROVAL_API_HEADER` (di Core,
defaultnya persis `X-ALIM-CONNECT-SSO-KEY` dan `X-ALIM-CONNECT-APPROVAL-KEY`) adalah pasangan dari
`ALIM_CONNECT_SSO_API_HEADER` dan `ALIM_CORE_APPROVAL_API_HEADER` di Connect. Bila salah satu sisi
mengganti nama header, sisi lain tidak tahu apa pun — request hanya gagal 401. Ubah keduanya, atau
biarkan default di kedua sisi.

**Koreksi terhadap versi sebelumnya dokumen ini.** Dua baris di tabel lama salah dan sudah diganti:

- `CONNECT_SSO_FRAME_ORIGIN` **bukan** pasangan `ALIM_CORE_WEB_ORIGIN`. Keduanya berbicara arah
  berlawanan: `ALIM_CORE_WEB_ORIGIN` (Connect) menyebut origin **Core**; `CONNECT_SSO_FRAME_ORIGIN`
  (Core) menyebut origin **Connect**. Mengisi satu dengan nilai yang lain akan membuat kedua sisi
  memercayai origin yang salah — dan SSO tetap mati di salah satu sisi tanpa pesan yang jelas.
- `CONNECT_SSO_HANDOFF_URL` **bukan** "tidak ada setelan". Ia ada, di Core, dan harus berisi rute
  handoff milik Connect.

### 2.4 Pasangan credential: satu nilai untuk dua nama

| Nilai yang sama          | Nama di Connect                        | Nama di Core                            |
| ------------------------ | -------------------------------------- | --------------------------------------- |
| key `sso:exchange`       | `ALIM_CONNECT_SSO_KEY` (dikirim)       | `CONNECT_SSO_API_KEY` (dicocokkan)      |
| key `approval:command`   | `ALIM_CORE_APPROVAL_API_KEY` (dikirim) | `CONNECT_APPROVAL_API_KEY` (dicocokkan) |
| nama header key SSO      | `ALIM_CONNECT_SSO_API_HEADER`          | `CONNECT_SSO_API_HEADER`                |
| nama header key approval | `ALIM_CORE_APPROVAL_API_HEADER`        | `CONNECT_APPROVAL_API_HEADER`           |

Dua nama, satu nilai. Ini bukan dua credential; menerbitkan dua nilai berbeda akan membuat setiap
request ditolak 401/403 oleh Core.

Satu nilai yang **memang berbeda tiap sisi** adalah kunci masuk: `ALIM_CONNECT_INGEST_KEY` (Connect)
harus sama dengan nilai yang dipegang Core untuk memanggil `POST /api/approval/requests`. Nilainya
diterbitkan operator Connect dan diserahkan ke Core, bukan sebaliknya.

---

## 3. Allowlist IP: dua arah, dua keadaan

**Outbound (Core memfilter Connect).** `CONNECT_SSO_ALLOWED_IPS` dan `CONNECT_APPROVAL_ALLOWED_IPS`
ada dan berlaku di Core. Isinya CIDR egress staging Connect. Tanpa itu, Core menerima request dari
IP mana pun yang memegang key.

**Inbound (Connect memfilter Core).** Connect **tidak** memiliki allowlist IP untuk request yang
masuk dari Core. Yang berlaku sekarang:

| Rute yang dipanggil Core      | Pengganti allowlist IP sekarang                               |
| ----------------------------- | ------------------------------------------------------------- |
| `POST /api/sso/handoff`       | allowlist **Origin** ketat + throttle 5/menit & 20/jam per IP |
| `POST /api/approval/requests` | `ALIM_CONNECT_INGEST_KEY` (fail-closed 503 bila kosong)       |

Kunci layanan + throttle sudah membatasi dampak, tetapi keduanya tidak menyebut asal jaringan. Ini
batas yang diketahui, bukan fitur tersembunyi: jangan melaporkan Connect punya allowlist IP Core.
Menambahkannya butuh daftar CIDR ingress Core, dan itu pekerjaan terpisah.

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
