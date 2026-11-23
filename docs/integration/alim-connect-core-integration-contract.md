# Kontrak Integrasi ALIM Core — Approval Command API (sisi Connect)

**Tanggal:** 2026-11-23
**Status:** final dari sisi ALIM Connect; menunggu konfirmasi Core pada lima butir di §10.
**Kontrak mesin:** `test/contracts/alim-core/approval-command.openapi.yaml` (OpenAPI 3.1, `provisional`)
**Test kontrak:** `npm run test:contracts` — 86 test, termasuk klien HTTP nyata terhadap mock Core.

Dokumen ini menjelaskan apa yang **ALIM Connect kirim** dan apa yang **ALIM Core harus lakukan** agar
integrasi dapat diuji tanpa menebak. Tidak ada endpoint baru yang diusulkan: hanya
`POST /api/connect/v1/approval-commands`, endpoint yang sudah ada di kontrak Core.

---

## 1. Ringkasan alur

```
WhatsApp reply → Connect parse → Connect simpan command (PENDING)
              → POST /api/connect/v1/approval-commands
              → Core memutuskan dan menyimpan status izin
              → Connect menyimpan hasil, membalas WhatsApp hanya setelah Core sukses
```

Core adalah satu-satunya pihak yang memutuskan izin. Connect tidak pernah menyimpan keputusan final
sendiri; `approval_requests.status` adalah cermin posisi alur, bukan sumber kebenaran.

---

## 2. Endpoint

| Item     | Nilai                                              |
| -------- | -------------------------------------------------- |
| Method   | `POST`                                             |
| Path     | `/api/connect/v1/approval-commands`                |
| Base URL | `ALIM_CORE_BASE_URL` (tanpa garis miring di akhir) |
| Body     | `application/json`, snake_case                     |
| Respons  | `application/json`                                 |

Tidak ada endpoint lain yang dipanggil Connect untuk approval. Semua operasi baca tetap milik
kontrak master read-only (`connect-v1.openapi.yaml`).

---

## 3. Autentikasi service-to-service

| Header                        | Wajib | Isi                                      |
| ----------------------------- | ----- | ---------------------------------------- |
| `X-ALIM-CONNECT-APPROVAL-KEY` | ya    | Kredensial layanan khusus Connect → Core |

- Nama header dapat diubah lewat `ALIM_CORE_APPROVAL_API_HEADER`; nilai default di atas adalah yang
  dipakai kontrak.
- Core juga menerima `Authorization: Bearer <key>` sebagai cadangan, tetapi Connect **selalu** memakai
  header di atas. Jangan mengandalkan bearer untuk membedakan Connect dari klien lain.
- Kredensial ini bukan API key pengguna dan tidak boleh sama dengan key dashboard. Cakupannya hanya
  `approval:command`.
- Rotasi: dua kredensial berlaku bersamaan selama jendela rotasi; Connect mengganti nilainya lewat
  environment, tanpa perubahan kode. Belum ada kredensial yang diterbitkan — itu tetap pekerjaan Core
  (§10 butir 3).

---

## 4. Header kontrak

| Header               | Wajib | Nilai                    | Perilaku Core yang diharapkan                                                        |
| -------------------- | ----- | ------------------------ | ------------------------------------------------------------------------------------ |
| `Idempotency-Key`    | tidak | sama dengan `command_id` | Bila dipakai, harus menghasilkan idempotensi yang sama dengan `command_id` di body.  |
| `X-ALIM-API-Version` | tidak | `1`                      | Boleh diabaikan. Bila divalidasi, nilai yang tidak dikenal harus `422`, bukan `500`. |
| `content-type`       | ya    | `application/json`       | Tolak selain itu dengan `415` atau `422`.                                            |
| `accept`             | ya    | `application/json`       | —                                                                                    |

Connect mengirim `Idempotency-Key` dan `X-ALIM-API-Version` pada setiap command. Versi dapat
dikosongkan lewat `ALIM_CORE_API_VERSION=` bila Core menyatakan header itu tidak diterima; Connect
tidak bergantung pada balasan atas header mana pun.

---

## 5. Request body

| Field                    | Tipe                  | Wajib | Arti                                                                                                                  |
| ------------------------ | --------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| `command_id`             | string (uuid)         | ya    | Kunci idempotensi utama. Nilainya tetap pada setiap pengiriman ulang.                                                 |
| `request_id`             | string (uuid)         | ya    | `dormitory_permits.id` di Core.                                                                                       |
| `decision`               | enum                  | ya    | `approved` \| `rejected` \| `needs_clarification` \| `expired` \| `cancelled`. Dari WhatsApp hanya dua nilai pertama. |
| `approved_duration_days` | integer \| null       | tidak | Wajib bila `decision = approved`. `null` untuk `rejected`.                                                            |
| `actor_external_id`      | string                | ya    | Nomor WhatsApp aktor setelah normalisasi. Referensi audit, bukan dasar otorisasi.                                     |
| `actor_core_person_id`   | string (uuid) \| null | tidak | Petunjuk audit. Core **wajib** menyelesaikan aktor dari pemetaan WhatsApp terverifikasi, bukan dari field ini.        |
| `source`                 | string                | ya    | Selalu `whatsapp` dari Connect.                                                                                       |
| `external_message_id`    | string                | ya    | WhatsApp message id. Unik per command; pesan yang sama tidak boleh menjadi dua command.                               |
| `message_text`           | string \| null        | tidak | Teks balasan asli yang diparse (`SETUJU 2 HARI`, `TOLAK`).                                                            |
| `notes`                  | string \| null        | tidak | Selalu `null` dari jalur WhatsApp.                                                                                    |

Contoh:

```json
{
  "command_id": "6f1c2a44-3c55-4c1e-9c1f-2b7d8e6a5f01",
  "request_id": "9f1c2a44-3c55-4c1e-9c1f-2b7d8e6a5f02",
  "decision": "approved",
  "approved_duration_days": 2,
  "actor_external_id": "628111000001",
  "actor_core_person_id": "9f1c2a44-3c55-4c1e-9c1f-2b7d8e6a5f03",
  "source": "whatsapp",
  "external_message_id": "wamid.HBgM...",
  "message_text": "SETUJU 2 HARI",
  "notes": null
}
```

---

## 6. Respons sukses

Envelope Core:

```json
{
  "success": true,
  "message": "Command diterapkan.",
  "data": {
    "outcome": "applied",
    "status": "approved",
    "secondary_status": null,
    "expected_return_datetime": "2026-11-25T10:00:00+07:00",
    "duplicate": false
  },
  "errors": null
}
```

| Field                           | Arti                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `data.outcome`                  | `applied` \| `needs_clarification` \| `expired` \| `cancelled` \| `duplicate`             |
| `data.status`                   | Status izin di Core (`approved`, `rejected`, …). Connect memakainya sebagai `coreStatus`. |
| `data.secondary_status`         | Opsional; disimpan bila ada.                                                              |
| `data.expected_return_datetime` | Opsional; mengoreksi perkiraan kembali pada permohonan.                                   |
| `data.duplicate`                | `true` bila command ini replay. Connect menandai command `DUPLICATE`, bukan `APPLIED`.    |

`outcome: "duplicate"` (atau `duplicate: true`) **wajib** untuk replay `command_id` yang sudah
diterapkan. Connect memperlakukannya sebagai hasil sah, bukan keputusan kedua: status permohonan
tetap mengikuti `data.status`, dan metrik mencatat satu transisi `duplicate`.

---

## 7. Respons error dan perilaku Connect

Envelope error Core: `{ "success": false, "message": "...", "data": null, "errors": { "code": "...", "context": {...} } }`

| HTTP      | `errors.code`                                                                                   | Arti                                        | Perilaku Connect                                        |
| --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `401`     | —                                                                                               | Key tidak dikirim atau salah                | Command `REJECTED`; tidak diulang.                      |
| `403`     | `insufficient_scope`                                                                            | Key tanpa cakupan `approval:command`        | Command `REJECTED`; tidak diulang.                      |
| `403`     | `actor_not_authorized`                                                                          | Aktor bukan Kepala Asrama aktif             | Command `REJECTED`; balasan WhatsApp "tidak berwenang". |
| `404`     | —                                                                                               | Permohonan tidak ditemukan                  | Command `REJECTED`; tidak diulang.                      |
| `409`     | `permit_not_decidable`                                                                          | Izin sudah final                            | Command `REJECTED`; status lokal mengikuti Core.        |
| `409`     | `command_id_reused`                                                                             | `command_id` dipakai dengan payload berbeda | Command `REJECTED`; **bug Connect**, bukan retry.       |
| `409`     | `external_message_replayed`                                                                     | Pesan sudah menjadi command lain            | Command `REJECTED`; tidak diulang.                      |
| `422`     | `validation_failed` / `duration_invalid` / `duration_out_of_range` / `permit_missing_departure` | Payload atau durasi tidak sah               | Command `REJECTED`; balasan WhatsApp menjelaskan.       |
| `429`     | —                                                                                               | Rate limit                                  | `UNKNOWN`; diulang dengan `command_id` yang sama.       |
| `5xx`     | —                                                                                               | Gangguan sementara                          | `UNKNOWN`; diulang dengan `command_id` yang sama.       |
| `0`/`504` | `core_unreachable` / `core_timeout`                                                             | Tidak ada balasan                           | `UNKNOWN`; diulang dengan `command_id` yang sama.       |

Aturan yang tidak boleh dilanggar Core:

1. **Jangan pernah** membalas `2xx` untuk command yang tidak diterapkan. Connect menganggap `2xx`
   dengan `success !== false` sebagai keputusan yang sah.
2. **Jangan** membalas `4xx` untuk kegagalan sementara. Connect tidak mengulang `4xx` selain `429`.
3. Replay harus idempoten: hasil kedua identik dengan yang pertama, dengan `duplicate: true`.

---

## 8. Identitas aktor

`actor_core_person_id` adalah **petunjuk audit**, bukan dasar otorisasi. Core harus:

1. Menyelesaikan nomor `actor_external_id` ke pemetaan WhatsApp yang **aktif dan terverifikasi**.
2. Memeriksa bahwa personel itu adalah Kepala Asrama aktif pada asrama permohonan.
3. Menolak dengan `403 actor_not_authorized` bila salah satu tidak terpenuhi.

Konsekuensi yang diterima Connect: pemetaan identitas di Connect tidak dapat menaikkan kewenangan
siapa pun. Bila pemetaan di Connect dan Core berbeda, Core yang menentukan; Connect mencatat
penolakan itu sebagai `REJECTED`.

Pencabutan pemetaan di Core harus langsung mencabut kewenangan, termasuk untuk command yang sedang
di-retry.

---

## 9. Idempotensi, retry, dan timeout

| Keadaan                             | Yang Connect lakukan                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| Balasan `2xx`                       | Simpan `APPLIED`/`DUPLICATE`, perbarui status permohonan, kirim konfirmasi WhatsApp.   |
| `429`/`5xx`/timeout/tidak terhubung | Simpan `UNKNOWN`, jadwalkan retry dengan `command_id` dan `Idempotency-Key` yang sama. |
| `4xx` bisnis                        | Simpan `REJECTED`, tidak diulang.                                                      |
| Retry habis                         | Simpan `FAILED`, `nextAttemptAt = null`, tunggu pemeriksaan manual.                    |

Parameter retry (dapat dikonfigurasi lewat environment):

| Parameter     | Default | Arti                                                           |
| ------------- | ------- | -------------------------------------------------------------- |
| `maxAttempts` | 5       | Termasuk percobaan pertama.                                    |
| `baseDelayMs` | 30.000  | Backoff eksponensial dari sini.                                |
| `maxDelayMs`  | 900.000 | Batas atas backoff.                                            |
| `leaseMs`     | 60.000  | Lease `nextAttemptAt`; mencegah dua worker mengirim bersamaan. |
| `timeoutMs`   | 5.000   | Batas waktu satu panggilan HTTP.                               |

Timeout Connect **tidak** berarti Core gagal: Core dapat menyelesaikan permintaan setelah Connect
membatalkan. Karena itu replay dengan `command_id` yang sama harus dijawab `duplicate`, bukan
diterapkan dua kali. Ini alasan utama `Idempotency-Key` dan `command_id` harus konsisten.

---

## 10. Butir yang masih menunggu keputusan Core

| #   | Pertanyaan                                                                  | Default Connect sampai dijawab                                  |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Apakah Core memvalidasi `Idempotency-Key`, atau hanya `command_id` di body? | Connect mengirim keduanya dengan nilai sama.                    |
| 2   | Apakah Core memvalidasi `X-ALIM-API-Version`?                               | Connect mengirim `1`; dapat dikosongkan lewat env.              |
| 3   | Mekanisme dan jadwal penerbitan kredensial layanan (ingest dan command).    | Tidak ada kredensial; jalur HTTP hanya diuji terhadap mock.     |
| 4   | Jaminan bahwa hanya pemetaan aktif+terverifikasi yang mewakili aktor.       | Connect mengirim `actor_core_person_id` sebagai petunjuk audit. |
| 5   | Ketersediaan endpoint organisasi (unit/asrama) untuk scoping `VIEWER`.      | `VIEWER` melihat seluruh unit (lihat §11).                      |

---

## 11. Batas yang diketahui, bukan cacat tersembunyi

1. **Scoping `VIEWER` belum ada.** Key `VIEWER` membaca seluruh permohonan lintas unit; belum ada
   sumber unit yang sah dari Core. Rincian dan dependensinya ada di `docs/integration/alim-connect-pdca-cycle-2.md` §5.
2. **Retensi PII belum ditetapkan.** Belum ada penghapusan otomatis; inventaris kolom dan alat
   laporan ada di dokumen yang sama §6.
3. **Kontrak masih `provisional`.** Selama Core belum mengonfirmasi §10, kontrak ini adalah
   kesepakatan satu sisi: Connect sudah memenuhi bagiannya, Core belum memverifikasi.

---

## 12. Cara Core memverifikasi

```bash
# 1. Command yang sah
curl -sS -X POST "$ALIM_CORE_BASE_URL/api/connect/v1/approval-commands" \
  -H "X-ALIM-CONNECT-APPROVAL-KEY: $KEY" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 6f1c2a44-3c55-4c1e-9c1f-2b7d8e6a5f01' \
  -H 'X-ALIM-API-Version: 1' \
  -d @command.json
# harap: 200, data.outcome = applied

# 2. Replay yang sama
# harap: 200, data.duplicate = true, status izin tidak berubah

# 3. command_id sama dengan payload berbeda
# harap: 409, errors.code = command_id_reused

# 4. Aktor tidak berwenang
# harap: 403, errors.code = actor_not_authorized
```

Sisi Connect dapat diuji tanpa Core sungguhan:

```bash
npm run test:contracts            # 86 test: dokumen, fixture, mock Core, klien HTTP nyata
npx jest --config test/jest-e2e.json test/approval-http.e2e-spec.ts   # 18 test HTTP end-to-end
```
