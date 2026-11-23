# Kontrak Integrasi ALIM Core — WhatsApp Connect SSO Handoff (sisi Connect)

**Tanggal:** 2026-11-23
**Repository:** `/Users/wawangunawan/OpenWA` (ALIM Connect)
**Status:** final dari sisi Connect. Kontrak Core diambil dari instruksi implementasi Core yang
diberikan pada siklus ini; lihat §10 untuk dua ketidaksesuaian yang harus dikonfirmasi pemilik Core.
**Kontrak mesin:** `openapi.json` (`POST /api/sso/handoff`) — diregenerasi dengan `npm run openapi:export`.
**Test:** unit + `test/sso-handoff-http.e2e-spec.ts` (23 test HTTP).

Dokumen ini menjelaskan apa yang **Connect kirim** dan apa yang **Connect harapkan dari Core**.
Tidak ada endpoint Core baru yang diusulkan.

---

## 1. Ringkasan alur

```
Browser (di dalam iframe di halaman Core)
  │  1. GET halaman WhatsApp Connect di Core
  │  2. Core menerbitkan one-time handoff code
  │  3. form POST (application/x-www-form-urlencoded) → https://connect/sso/handoff
  ▼
ALIM Connect  POST /sso/handoff  (alias dari POST /api/sso/handoff)
  │  4. validasi Origin (allowlist), rate limit, DTO
  │  5. server-to-server POST /api/connect/v1/sso/exchange  ──► ALIM Core
  │       header X-ALIM-CONNECT-SSO-KEY
  │       body { code, audience: "connect", scope: "whatsapp.embed", state? }
  │  6. Core membalas core_user_id, name, email, audience, scope, issued_at, redeemed_at
  │  7. Connect memetakan core_user_id → akun Connect yang SUDAH ADA
  │  8. Connect membuat session Connect (token owa_s1_…)
  ▼
Halaman HTML dari Connect menulis token ke sessionStorage lalu location.replace('/')
```

**Yang tidak pernah terjadi:**

- SSO key tidak pernah dikirim ke browser.
- Handoff code tidak pernah masuk URL, query string, redirect, referrer, atau log.
- Connect tidak menerima cookie session Core dan tidak mengirim cookie apa pun.
- Connect tidak membuat akun baru dari data Core.
- Connect tidak memakai role/jabatan/assignment Core sebagai otorisasi.

---

## 2. Endpoint Connect yang menerima handoff

| Item     | Nilai                                                               |
| -------- | ------------------------------------------------------------------- |
| Method   | `POST`                                                              |
| Alamat   | `/sso/handoff` (browser) → `/api/sso/handoff` (rute Nest, OpenAPI)  |
| Body     | `application/x-www-form-urlencoded` (form browser) atau JSON        |
| Auth     | tidak ada kredensial Connect; lihat §5                              |
| Throttle | 5 percobaan/menit dan 20/jam per IP klien                           |
| Respons  | `text/html` untuk browser; `application/json` bila klien memintanya |

`configureApp` menulis ulang tepat dua path (`/sso/handoff` → `/api/sso/handoff`) sebelum routing,
sehingga guard, throttler, body parser, dan DTO pipe berjalan satu kali. Tidak ada permukaan `/sso`
lain.

### 2.1 Request body

| Field   | Tipe   | Wajib | Arti                                              |
| ------- | ------ | ----- | ------------------------------------------------- |
| `code`  | string | ya    | 1–512 karakter. Opaque bagi Connect.              |
| `state` | string | tidak | Diteruskan apa adanya ke Core; tidak ditafsirkan. |

`whitelist: true` dan `forbidNonWhitelisted: true` aktif: field lain ditolak `400`.

### 2.2 Respons

Browser menerima halaman HTML:

- **Sukses** — halaman menulis `sessionStorage['openwa_api_key'] = <token>` dan menjalankan
  `location.replace('/')`. `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  `X-Robots-Tag: noindex`. Tidak ada `Set-Cookie`.
- **Gagal** — halaman berisi judul, pesan, dan tombol "Kembali ke ALIM Core" (bila
  `ALIM_CORE_WEB_ORIGIN` dikonfigurasi). Kode handoff tidak pernah ditampilkan.

Klien yang mengirim `Accept: application/json` menerima `{ ok, userId, expiresAt }` (sukses) atau
`{ ok: false, code, message }` (gagal). **Token tidak pernah ada di respons JSON.**

---

## 3. Panggilan Connect → Core

| Item     | Nilai                                              |
| -------- | -------------------------------------------------- |
| Method   | `POST`                                             |
| Path     | `/api/connect/v1/sso/exchange`                     |
| Base URL | `ALIM_CORE_BASE_URL` (tanpa garis miring di akhir) |
| Header   | `X-ALIM-CONNECT-SSO-KEY: <ALIM_CONNECT_SSO_KEY>`   |
| Body     | `application/json`                                 |
| Timeout  | `ALIM_CONNECT_SSO_TIMEOUT_MS`, default 5000 ms     |
| Retry    | **tidak ada** — code bersifat one-time             |

```json
{
  "code": "…",
  "audience": "connect",
  "scope": "whatsapp.embed",
  "state": "…"
}
```

`state` hanya dikirim bila browser mengirimkannya.

### 3.1 Respons sukses yang diterima

Connect menerima **dua bentuk** yang mungkin dari Core:

1. Field langsung: `{ "core_user_id": "…", "audience": "connect", … }`
2. Envelope yang dipakai endpoint integrasi Core lain:
   `{ "success": true, "data": { "core_user_id": "…" }, "errors": null }`

Keduanya diterima karena kontrak Core pada instruksi menyebut field langsung, sedangkan endpoint
Core lain memakai envelope. Bila `data` adalah objek, `data` yang dibaca; selain itu objek teratas.

Field yang dipakai:

| Field          | Wajib | Perilaku Connect                                                     |
| -------------- | ----- | -------------------------------------------------------------------- |
| `core_user_id` | ya    | Satu-satunya kunci pemetaan identitas. Kosong → `contract_mismatch`. |
| `audience`     | tidak | Bila ada dan ≠ `connect` → `audience_mismatch` (tanpa session).      |
| `scope`        | tidak | Bila ada dan ≠ `whatsapp.embed` → `scope_mismatch` (tanpa session).  |
| `name`         | tidak | Deskriptif. **Tidak pernah** dipakai mencari akun.                   |
| `email`        | tidak | Deskriptif. **Tidak pernah** dipakai mencari akun.                   |
| `issued_at`    | tidak | Disimpan di hasil exchange, tidak dipakai untuk otorisasi.           |
| `redeemed_at`  | tidak | Idem.                                                                |

### 3.2 Pemetaan error

| HTTP Core | `errors.code`                       | Hasil Connect        | HTTP ke browser |
| --------- | ----------------------------------- | -------------------- | --------------- |
| `401`     | —                                   | `invalid_key`        | `502`           |
| `403`     | `insufficient_scope`                | `insufficient_scope` | `502`           |
| `403`     | `audience_mismatch`                 | `audience_mismatch`  | `403`           |
| `403`     | `scope_mismatch`                    | `scope_mismatch`     | `403`           |
| `403`     | `user_inactive`                     | `user_inactive`      | `403`           |
| `403`     | `permission_revoked`                | `permission_revoked` | `403`           |
| `404`     | `code_not_found`                    | `code_not_found`     | `400`           |
| `409`     | `code_already_used`                 | `code_already_used`  | `409`           |
| `410`     | `code_expired`                      | `code_expired`       | `410`           |
| `422`     | `invalid_payload` / `code_required` | sesuai code          | `400` / `422`   |
| `429`     | —                                   | `core_error`         | `502`           |
| `5xx`     | —                                   | `core_error`         | `502`           |
| —         | koneksi putus / DNS                 | `core_unreachable`   | `502`           |
| —         | timeout                             | `core_timeout`       | `504`           |

`429` dan `5xx` **tidak** di-retry: code sudah mungkin terpakai di sisi Core, dan mengulang tanpa
kepastian dapat membakar code atau membuat dua session. Orang memulai ulang handoff dari Core.

---

## 4. Pemetaan identitas

- `users.coreUserId` (kolom baru, unik, nullable) menyimpan `core_user_id`.
- Lookup hanya lewat kolom itu. Nama dan email tidak pernah dipakai.
- Tidak ada akun yang dibuat otomatis. Bila tidak ada baris yang cocok → `identity_not_mapped` (`403`).
- Bila akun Connect ada tetapi `isActive = false` → `account_disabled` (`403`).
- Role dan permission Connect tetap milik Connect. Role Core tidak dibaca dan tidak dipetakan.
- Pemetaan diisi administrator lewat `POST /api/auth/users` atau `PATCH /api/auth/users/:id`
  (`coreUserId`, `null`/string kosong untuk melepas pemetaan). Duplikat ditolak `409`.

---

## 5. Keamanan handoff

### 5.1 CSRF

Aplikasi ini **tidak memakai cookie session**: kredensial dashboard dikirim di header `X-API-Key`
dan disimpan di `sessionStorage`. Karena itu tidak ada middleware CSRF global dan tidak ada cookie
yang bisa "ditunggangi" form lintas situs. Tidak ada pengecualian CSRF yang ditambahkan — tidak ada
pemeriksaan CSRF global untuk dikecualikan.

Kontrol pengganti, semuanya aktif pada endpoint ini:

1. **Origin allowlist** — `Origin` (fallback `Referer`) harus sama persis dengan
   `ALIM_CORE_WEB_ORIGIN`. Tidak ada wildcard. `Origin: null` (iframe sandbox) ditolak.
2. **Rate limit** — 5/menit dan 20/jam per IP klien.
3. **Validasi payload** — DTO dengan whitelist; kode wajib, maksimum 512 karakter.
4. **One-time code** — hanya Core yang dapat menerbitkan dan menukar; Connect tidak pernah
   menganggap kode valid berdasarkan data browser.

### 5.2 Session

- Session dibuat hanya setelah exchange sukses **dan** pemetaan valid.
- Token dibuat baru setiap handoff (`owa_s1_` + 32 byte acak), sehingga tidak ada identifier yang
  bisa di-set penyerang (session fixation).
- Expiry absolut: `ALIM_CONNECT_SSO_SESSION_TTL_HOURS` bila > 0, selain itu `AUTH_SESSION_TTL_HOURS`.
- Idle timeout: `AUTH_SESSION_IDLE_TIMEOUT_MINUTES` (default 0 = nonaktif). Nilai > 0 menolak dan
  mencabut session yang diam terlalu lama. Berlaku untuk semua session dashboard, bukan hanya SSO.
- Logout memakai `POST /api/auth/logout` yang sudah ada; session dicabut di baris `user_sessions`.
- Cookie session Core tidak pernah dibaca, diteruskan, atau disimpan.

### 5.3 iframe

- CSP: `frame-ancestors 'self' <ALIM_CORE_WEB_ORIGIN>`; tanpa wildcard.
- `X-Frame-Options` dinonaktifkan **hanya ketika** origin Core dikonfigurasi, karena header itu
  tidak bisa menyebut origin kedua dan akan memblokir embed di browser yang masih menghormatinya.
  Proteksi CSP lain tidak berubah.
- `SameSite=None; Secure` tidak dipakai sebagai solusi: Connect tidak memakai cookie untuk session,
  sehingga pemblokiran third-party cookie tidak memutus alur. Yang tetap dibutuhkan adalah
  `sessionStorage` yang tidak diblokir di iframe; halaman sukses menampilkan pesan bila browser
  memblokirnya.

---

## 6. Konfigurasi environment

| Variabel                             | Wajib | Default                  | Arti                                                           |
| ------------------------------------ | ----- | ------------------------ | -------------------------------------------------------------- |
| `ALIM_CORE_BASE_URL`                 | ya*   | —                        | Origin Core, tanpa trailing slash. Dipakai juga oleh approval. |
| `ALIM_CONNECT_SSO_KEY`               | ya*   | —                        | Key scope `sso:exchange`. Berbeda dari key approval/ingest.    |
| `ALIM_CORE_WEB_ORIGIN`               | ya*   | —                        | Origin browser Core untuk CSP dan allowlist Origin.            |
| `ALIM_CONNECT_SSO_API_HEADER`        | tidak | `X-ALIM-CONNECT-SSO-KEY` | Nama header key.                                               |
| `ALIM_CONNECT_SSO_TIMEOUT_MS`        | tidak | `5000`                   | Timeout satu panggilan exchange.                               |
| `ALIM_CONNECT_SSO_AUDIENCE`          | tidak | `connect`                | Audience yang diminta dan diverifikasi.                        |
| `ALIM_CONNECT_SSO_SCOPE`             | tidak | `whatsapp.embed`         | Scope yang diminta dan diverifikasi.                           |
| `ALIM_CONNECT_SSO_SESSION_TTL_HOURS` | tidak | `0` (pakai default auth) | Umur absolut session hasil handoff.                            |
| `AUTH_SESSION_IDLE_TIMEOUT_MINUTES`  | tidak | `0` (nonaktif)           | Idle timeout semua session dashboard.                          |

\* SSO **nonaktif** (endpoint menjawab `503`) bila `ALIM_CORE_BASE_URL`, `ALIM_CONNECT_SSO_KEY`,
atau `ALIM_CORE_WEB_ORIGIN` tidak valid/kosong. Tidak ada mode mock: Connect tidak akan membuat
session tanpa Core.

`ALIM_CORE_WEB_ORIGIN` harus berupa origin (`scheme://host[:port]`), tanpa path, query, fragment,
kredensial, atau wildcard. Nilai tidak valid menghasilkan `null` dan mempertahankan
`frame-ancestors 'self'`.

---

## 7. Batasan deployment

- **Dashboard dan API harus satu origin.** Halaman sukses menulis `sessionStorage` untuk origin
  Connect; bila dashboard disajikan dari origin lain (`VITE_API_URL`), token tidak akan terlihat
  oleh SPA. Alur SSO ini tidak dirancang untuk deployment split-origin.
- Dashboard harus disajikan (`dashboardServingEnabled`); deployment API-only tidak punya workspace
  untuk dituju setelah handoff.
- `ALIM_CORE_WEB_ORIGIN` adalah origin **browser** Core, bukan URL internal server-ke-server.

---

## 8. Cara memverifikasi

```bash
# Unit: origin, klien HTTP, service, halaman, migrasi
npx jest src/config/core-web-origin.spec.ts src/modules/sso \
  src/database/migrations-main/__tests__/1792700000000-AddUserCoreUserId.spec.ts --runInBand

# HTTP end-to-end dengan Core palsu di batas HTTP (23 test)
npx jest --config ./test/jest-e2e.json test/sso-handoff-http.e2e-spec.ts --runInBand

# Kontrak OpenAPI (setelah perubahan rute/DTO)
npm run openapi:export && npm run openapi:check
```

---

## 9. Yang tidak diuji di sini

- Core sungguhan: mock hanya membuktikan sisi Connect. Envelope, kewenangan, dan one-time semantics
  Core yang sebenarnya belum dijalankan.
- TLS/jaringan staging.
- Browser sungguhan: lihat `alim-connect-sso-browser-test.md`. Kompatibilitas Chrome/Safari/Firefox
  **belum terbukti** sampai prosedur itu dijalankan.

---

## 10. Temuan dan pertanyaan untuk pemilik Core

1. **Dokumen implementasi Core tidak ada di repository Connect.** Instruksi menyebut
   `docs/integration/alim-core-whatsapp-connect-implementation.md`, tetapi path itu tidak ada di
   `/Users/wawangunawan/OpenWA` (dan repository Core tidak boleh diubah). Kontrak yang dipakai
   berasal dari instruksi siklus ini. Mohon dokumen itu dibagikan dari repository Core agar dapat
   diperiksa ulang.
2. **Bentuk respons belum eksplisit.** Instruksi menyebut field langsung; endpoint Core lain memakai
   envelope `{ success, data, errors }`. Connect menerima keduanya. Konfirmasi mana yang final agar
   parsing dapat dipersempit.
3. **`audience`/`scope` di respons.** Connect menolak nilai yang tidak cocok, tetapi menerima respons
   yang tidak menyertakannya. Bila Core menjamin keduanya selalu ada, Connect dapat dibuat lebih
   ketat.
4. **Kode error 403 tanpa `errors.code`.** Connect memetakannya ke `core_error` (502). Bila Core
   selalu mengirim `errors.code`, tidak ada perubahan yang diperlukan.
5. **Masa berlaku code dan session.** Kontrak tidak menyebut TTL code; Connect tidak menyimpannya,
   jadi keputusan sepenuhnya milik Core.
