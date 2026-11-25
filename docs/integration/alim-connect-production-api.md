# ALIM Connect — Panduan API Production

Berlaku untuk deployment `https://alim-wa.abuhurairah.id`.
Diverifikasi terhadap sumber release `82f5a1ed3` (`openapi.json`, versi API `0.30.3`).

> **Status.** Dokumen ini menjelaskan kontrak API yang **ada di kode release**. Apakah sebuah endpoint
> sudah benar-benar tersedia di produksi diverifikasi terpisah dengan
> `scripts/deploy/verify-production.sh`, dan hasilnya dicatat di
> `docs/integration/alim-connect-production-deployment-cycle-1.md` §7. Jangan menganggap semua endpoint
> di bawah sudah aktif sebelum skrip itu hijau.

---

## 1. Base URL

| Lingkungan | Base URL |
| --- | --- |
| Production | `https://alim-wa.abuhurairah.id/api` |
| Dokumentasi OpenAPI | `https://alim-wa.abuhurairah.id/api/docs` (hanya bila `ENABLE_SWAGGER=true`) |
| Health (tanpa auth) | `https://alim-wa.abuhurairah.id/api/health`, `/api/health/live`, `/api/health/ready` |
| Dashboard | `https://alim-wa.abuhurairah.id/` (SPA yang dilayani proses yang sama) |

Semua route berada di bawah prefix `api` (`src/config/app-validation.ts` → `setGlobalPrefix('api')`).
Dashboard memanggil origin yang sama (`/api`), jadi CORS tidak dibutuhkan untuk pemakaian normal;
`CORS_ORIGINS` hanya untuk klien lain.

**HTTPS wajib.** Produksi menolak boot bila `ALIM_CORE_BASE_URL` atau `ALIM_CORE_WEB_ORIGIN`
memakai `http://` di luar loopback (`src/config/core-transport-policy.ts`).

---

## 2. Mekanisme autentikasi

Empat mekanisme berbeda, untuk pemanggil yang berbeda:

| Pemanggil | Mekanisme | Header |
| --- | --- | --- |
| API klien / SDK / dashboard | API key | `X-API-Key: <key>` |
| Dashboard (sesi browser) | Bearer session token | `Authorization: Bearer <token>` |
| ALIM Core → Connect (ingest permit) | Kunci layanan Core | `X-ALIM-CONNECT-INGEST-KEY: <key>` |
| Connect → ALIM Core | Kunci layanan per-arah | `X-ALIM-CONNECT-APPROVAL-KEY`, `X-ALIM-CONNECT-SSO-KEY` |
| Scrape metrik | Bearer token | `Authorization: Bearer <METRICS_TOKEN>` |

- **`X-API-Key`** adalah kunci utama. Setiap kunci punya *role* (`VIEWER`, `ADMIN`, …) dan opsional
  daftar sesi yang diizinkan (`allowedSessions`) serta allowlist IP. Kunci `ADMIN` tidak otomatis
  dianggap "Core" — ingest permit memakai guard terpisah (§5).
- **Kunci layanan Core tidak pernah dipakai sebagai `X-API-Key`.** Ingest memakai guard sendiri
  dengan `timingSafeEqual`, dan bila `ALIM_CONNECT_INGEST_KEY` kosong rute menjawab **503**, bukan
  terbuka.
- **SSO** tidak memakai API key: browser memposting kode sekali pakai dari halaman Core (§6).

Kunci pertama dibuat dari `API_MASTER_KEY` saat boot pertama (tabel `api_keys` kosong). Nilai
`API_MASTER_KEY` tidak pernah dikembalikan API.

---

## 3. Manajemen API key

Dashboard → *API Keys*, atau HTTP:

| Metode | Path | Role | Keterangan |
| --- | --- | --- | --- |
| `GET` | `/api/auth/api-keys` | ADMIN | Daftar kunci (tanpa nilai rahasia) |
| `POST` | `/api/auth/api-keys` | ADMIN | Buat kunci; **nilai penuh hanya dikembalikan sekali** |
| `GET` | `/api/auth/api-keys/{id}` | ADMIN | Detail satu kunci |
| `PUT` | `/api/auth/api-keys/{id}` | ADMIN | Ubah nama/role/scope |
| `DELETE` | `/api/auth/api-keys/{id}` | ADMIN | Hapus |
| `POST` | `/api/auth/api-keys/{id}/revoke` | ADMIN | Cabut tanpa menghapus baris (jejak audit tetap) |
| `POST` | `/api/auth/validate` | — | Validasi kunci |

Praktik yang ditegakkan kode:
- Kunci disimpan sebagai hash; dengan `API_KEY_PEPPER` di-set (HMAC-SHA256), tanpa itu SHA-256 biasa.
  **Pepper hanya bisa dipasang sebelum kunci pertama dibuat** — memasangnya belakangan mengunci semua
  kunci yang ada.
- `ALLOW_DEV_API_KEY=true` **ditolak di produksi** (menanam `dev-admin-key` yang publik).

---

## 4. Konfigurasi webhook

Webhook didaftarkan **per sesi**: `/api/sessions/{sessionId}/webhooks`.

| Metode | Path | Keterangan |
| --- | --- | --- |
| `POST` | `/api/sessions/{sessionId}/webhooks` | Daftarkan |
| `GET` | `/api/sessions/{sessionId}/webhooks` | Daftar |
| `GET` | `/api/sessions/{sessionId}/webhooks/{id}` | Detail |
| `PUT` | `/api/sessions/{sessionId}/webhooks/{id}` | Ubah |
| `DELETE` | `/api/sessions/{sessionId}/webhooks/{id}` | Hapus |
| `POST` | `/api/sessions/{sessionId}/webhooks/{id}/test` | Kirim event uji |
| `GET` | `/api/webhooks` | Semua webhook lintas sesi |
| `GET` | `/api/webhooks/delivery-failures` | Kegagalan pengiriman |
| `POST` | `/api/webhooks/delivery-failures/redrive` | Kirim ulang |

**Event yang bisa dilanggan** (`WEBHOOK_EVENTS`, `webhook.dto.ts`):
`message.received`, `message.sent`, `message.ack`, `message.receipt`, `message.failed`,
`message.revoked`, `message.reaction`, `message.edited`, `status.received`, `session.status`,
`session.qr`, `session.authenticated`, `session.disconnected`, `session.reconnect_loop`,
`session.restriction`, `presence.update`, `event.response`, `poll.vote`, `group.join`, `group.leave`,
`group.update`, … dan `*` untuk semua.

**Keamanan penerima.** Setiap pengiriman membawa:

| Header | Isi |
| --- | --- |
| `X-OpenWA-Signature` | `sha256=<hex>` — HMAC-SHA256 atas **body mentah** memakai `secret` webhook |
| `X-OpenWA-Event` | nama event |
| `X-OpenWA-Delivery-Id` | id unik pengiriman |
| `X-OpenWA-Idempotency-Key` | kunci idempotensi penerima |
| `X-OpenWA-Retry-Count` | percobaan ke- |

`secret` minimal **16 karakter** (bukan saran: HMAC atas 4 karakter bisa dipecahkan dari satu sampel).
Secret tidak pernah dikembalikan oleh route mana pun. Penerima **wajib** memverifikasi tanda tangan
atas byte mentah, bukan hasil parse ulang JSON.

---

## 5. Endpoint approval

Dua arah, dua kredensial.

### 5.1 Core → Connect (ingest permit)

```
POST /api/approval/requests
X-ALIM-CONNECT-INGEST-KEY: <kunci ingest>
Content-Type: application/json
```

Field body (dari `IngestApprovalRequestDto`):

| Field | Wajib | Keterangan |
| --- | --- | --- |
| `coreRequestId` | ya | UUID permit di Core |
| `reference` | ya | Referensi yang dikutip di WhatsApp, mis. `IZN-2026-00125` |
| `studentName` | ya | |
| `permitType` | ya | mis. `pulang` |
| `studentClass`, `dormitoryCoreId`, `dormitoryName` | tidak | |
| `requestedDurationDays` | tidak | 1–365 |
| `departureAt`, `expectedReturnAt` | tidak | ISO 8601 |
| `targetCorePersonId` | tidak | UUID Kepala Asrama di Core |
| `targetIdentity` | tidak | Nomor WhatsApp tujuan (JID atau digit) |
| `sessionId` | tidak | Sesi WhatsApp pengirim notifikasi |
| `coreStatus` | tidak | Status di Core |
| `notify` | tidak | Kirim notifikasi sekarang (default `true`) |

Jawaban: `200` dengan view permit, `401` bila kunci salah, `409` bila subjek berubah setelah
diproses (`approval_subject_immutable`), `503` bila ingest belum dikonfigurasi.

### 5.2 Dashboard → Connect

| Metode | Path | Role | Keterangan |
| --- | --- | --- | --- |
| `GET` | `/api/approval/requests` | VIEWER | Daftar (filter `status`, `limit` 1–200) |
| `GET` | `/api/approval/requests/{id}` | VIEWER | Detail; `?include=commands` menambah riwayat command |
| `POST` | `/api/approval/requests/{id}/notify` | ADMIN | Kirim ulang notifikasi |
| `POST` | `/api/approval/identities` | ADMIN | Petakan nomor WhatsApp → `corePersonId` |

**Alur keputusan.** Kepala Asrama menjawab di WhatsApp (mis. `SETUJU 2 HARI`) — tidak ada endpoint
HTTP untuk menyetujui. Balasan diproses hook `message:received`, ditautkan ke permit lewat kutipan
pesan notifikasi, lalu menjadi *approval command* ke Core.

### 5.3 Connect → Core (approval command)

```
POST {ALIM_CORE_BASE_URL}/api/connect/v1/approval-commands
X-ALIM-CONNECT-APPROVAL-KEY: <kunci approval>
Idempotency-Key: <command_id>
X-ALIM-API-Version: 1
```

`Idempotency-Key` **selalu sama** dengan `command_id` di body: pengiriman ulang harus menghasilkan
jawaban `duplicate` yang sama di kedua lapisan. Body membawa `command_id`, `request_id`, `decision`,
`approved_duration_days`, `actor_external_id`, `actor_core_person_id`, `source`,
`external_message_id`, `message_text`, `notes`.

Hasil: 4xx bisnis bersifat terminal (`REJECTED`), `429`/5xx/timeout menjadi `UNKNOWN` dan dicoba lagi
dengan `command_id` yang sama, hingga `FAILED`.

Status permit lokal: `PENDING_APPROVAL`, `PROCESSING`, `NEEDS_CLARIFICATION`, `APPROVED`, `REJECTED`,
`EXPIRED`, `CANCELLED`.

---

## 6. Endpoint SSO

```
GET  /api/sso/handoff    → halaman loading (iframe Core)
POST /api/sso/handoff    → tukar kode sekali pakai menjadi sesi Connect
```

Aturan yang ditegakkan:

- **Body form** (`application/x-www-form-urlencoded`) atau JSON; field `code` (wajib), `state` (opsional).
  Kode **tidak pernah** diterima dari query string atau URL.
- **Origin harus persis** `ALIM_CORE_WEB_ORIGIN`. Tanpa `Origin`/`Referer` → 403 `origin_required`;
  origin lain → 403 `origin_not_allowed`.
- **Rate limit** 5/menit dan 20/jam per IP.
- **Tanpa retry** ke Core: kode bersifat sekali pakai. Timeout = `504`, bukan "mungkin berhasil".
- Sesi hanya dibuat setelah (1) Core menukar kode, (2) `core_user_id` terpetakan ke akun Connect
  aktif. Tidak ada pembuatan akun otomatis.
- Klien yang meminta `application/json` menerima hasil **tanpa token**; browser menerima halaman HTML
  yang menaruh token ke `sessionStorage`.

Kode kegagalan: `not_configured` (503), `origin_required`/`origin_not_allowed` (403),
`identity_not_mapped` (403), `account_disabled` (403), `code_not_found` (400),
`code_already_used` (409), `code_expired` (410), `code_required` (422), `invalid_payload` (400),
`audience_mismatch`/`scope_mismatch`/`permission_revoked`/`user_inactive` (403),
`invalid_key`/`contract_mismatch`/`core_error`/`core_unreachable` (502), `core_timeout` (504),
`session_issue_failed` (500).

---

## 7. Endpoint sesi WhatsApp

Semua di bawah `/api/sessions`.

| Metode | Path | Keterangan |
| --- | --- | --- |
| `POST` | `/api/sessions` | Buat sesi |
| `GET` | `/api/sessions` | Daftar sesi |
| `GET` | `/api/sessions/{id}` | Detail status |
| `GET`/`PATCH` | `/api/sessions/{id}/config` | Konfigurasi sesi |
| `POST` | `/api/sessions/{id}/start` | Mulai koneksi |
| `POST` | `/api/sessions/{id}/stop` | Hentikan |
| `POST` | `/api/sessions/{id}/logout` | Logout WhatsApp |
| `POST` | `/api/sessions/{id}/force-kill` | Paksa berhenti |
| `GET` | `/api/sessions/{id}/qr` | QR untuk pemindaian |
| `POST` | `/api/sessions/{id}/pairing-code` | Kode pairing |
| `DELETE` | `/api/sessions/{id}` | Hapus |
| `GET`/`PATCH` | `/api/sessions/{id}/proxy` | Proxy per sesi |

Manajemen koneksi (grup, chat, presence, pesan, media, kontak, label, status) berada di bawah
`/api/sessions/{id}/…` — 171 operasi tercatat di `openapi.json`.

---

## 8. Endpoint inbox

| Metode | Path | Keterangan |
| --- | --- | --- |
| `GET` | `/api/sessions/{sessionId}/inbox/conversations` | Daftar percakapan |
| `GET` | `/api/sessions/{sessionId}/inbox/summary` | Ringkasan (belum dibaca, SLA) |
| `GET` | `/api/sessions/{sessionId}/inbox/reports` | Laporan |
| `GET`/`PATCH` | `/api/sessions/{sessionId}/inbox/conversations/{chatId}` | Detail / ubah (assign, status) |
| `POST` | `/api/sessions/{sessionId}/inbox/conversations/{chatId}/notes` | Catatan internal |
| `DELETE` | `/api/sessions/{sessionId}/inbox/conversations/{chatId}/notes/{noteId}` | Hapus catatan |

---

## 9. Audit log

```
GET /api/audit        (ADMIN)
```

Setiap keputusan approval menulis satu baris audit. Isinya sengaja **tidak** memuat nomor WhatsApp,
teks pesan, atau kredensial — hanya `commandId`, `coreRequestId`, `actorCorePersonId`, status Core,
dan kode hasil. SSO mencatat login berhasil dan setiap penolakan **setelah** Core menyetujui
(`identity_not_mapped`, `account_disabled`, `session_issue_failed`).

---

## 10. Versi API

- Versi aplikasi (`openapi.json` → `info.version`): **0.30.3**.
- Header versi kontrak ke Core: `X-ALIM-API-Version: 1` (dari `ALIM_CORE_API_VERSION`, kosong =
  header tidak dikirim).
- Prefix `/api` adalah bagian dari URL; tidak ada versi di path (`/api/v1` tidak dipakai).

---

## 11. Format error dan rate limit

**Bentuk error** (`ErrorResponse`):

```json
{ "statusCode": 400, "message": "…", "error": "Bad Request", "code": "OPTIONAL_STABLE_CODE" }
```

`message` bisa berupa string atau array (satu entri per field yang ditolak pada 400 validasi).
`code` hanya ada pada sebagian error (mis. `SESSION_STOP_INCOMPLETE`, `SEND_PACING_LIMITED`).

**Error gateway-wide** (sebelum routing, bisa muncul di operasi mana pun):

| Status | Arti |
| --- | --- |
| `415` | `Content-Encoding` selain `identity` — kirim body tanpa kompresi |
| `413` | `Content-Length` melebihi batas in-flight untuk pemanggil ini |
| `503` + `Retry-After` | Terlalu banyak data body in-flight; atau shutdown sudah dimulai (semua route kecuali `/api/health*`) |

**Rate limit** — tiga jendela, dievaluasi berurutan (`app.module.ts`):

| Tier | Default |
| --- | --- |
| `short` | 10 permintaan / 1 detik |
| `medium` | 100 permintaan / 60 detik |
| `long` | 1.000 permintaan / 1 jam |

Bucket dikunci pada IP klien. **Tanpa `TRUSTED_PROXIES`, semua klien di belakang reverse proxy
berbagi satu bucket** — satu pemakai bisa mengunci yang lain. Jawaban `429` membawa `Retry-After`
(detik) dan `Retry-After-<tier>`.

Rate limit dibagikan lewat Redis bila `REDIS_ENABLED=true`; bila Redis mati, limiter **fail-open**
(demi ketersediaan), sehingga batas tidak berlaku selama gangguan.

---

## 12. Contoh singkat

```bash
BASE=https://alim-wa.abuhurairah.id

# Health (tanpa auth)
curl -sS "$BASE/api/health/ready"

# Daftar sesi
curl -sS "$BASE/api/sessions" -H "X-API-Key: $KEY"

# Ingest permit dari Core (dipanggil Core, bukan dashboard)
curl -sS -X POST "$BASE/api/approval/requests" \
  -H "X-ALIM-CONNECT-INGEST-KEY: $INGEST" -H 'content-type: application/json' \
  -d '{"coreRequestId":"…","reference":"IZN-2026-00125","studentName":"…","permitType":"pulang"}'

# Audit
curl -sS "$BASE/api/audit" -H "X-API-Key: $KEY"
```

Perintah di atas **tidak dijalankan** pada siklus ini terhadap produksi (transaksi approval dilarang).
