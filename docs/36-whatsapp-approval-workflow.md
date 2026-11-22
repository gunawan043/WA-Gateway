# 36. WhatsApp Approval Workflow (ALIM Core ↔ ALIM Connect)

> **Status: implementasi 2026-11-22, belum diaktifkan di produksi.** Endpoint Core dan modul Connect
> sudah ada beserta pengujiannya, tetapi feature flag lifecycle GTK tetap **OFF**, belum ada migrasi
> produksi, belum ada backfill, dan belum ada kredensial baru yang dipasang. Dokumen ini mencatat apa
> yang benar-benar dibangun, apa yang masih mock, dan keputusan yang masih menunggu pemilik sistem.
>
> **Kedudukan dokumen.** [35a](./35a-alim-core-organization-mapping.md) tetap baseline arsitektur,
> [35b](./35b-alim-core-api-coordination-and-safety-plan.md) tetap gerbang D9, dan
> [35c](./35c-alim-core-connect-api-contract-draft.md) tetap draf Tahap 0. Dokumen ini adalah
> kelanjutannya: kontrak command yang nyata, implementasi kedua sisi, dan hasil pengujian.

---

## 1. Batas arsitektur yang dipegang

| Aturan                          | Wujud dalam kode                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| Core adalah sumber kebenaran    | Status izin hanya berubah di `dormitory_permits`; Connect tidak menyimpan keputusan final |
| Connect tidak menyentuh DB Core | Hanya satu panggilan HTTP: `POST /api/connect/v1/approval-commands`                       |
| API master tetap read-only      | `connect-v1.openapi.yaml` tidak berubah dan tidak memuat `approval-commands`              |
| Command punya kontrak sendiri   | `approval-command.openapi.yaml` + `approval-command.spec.ts` di lane kontrak              |
| Kewenangan divalidasi Core      | `DormitoryPolicyAccess::canApprovePermitCommand()`                                        |
| `scopeType=unit` tetap nonaktif | Tidak disentuh di pekerjaan ini                                                           |
| Tidak ada API tulis generik     | Endpoint hanya menerima keputusan izin yang sudah ada                                     |

---

## 2. Sisi Core

### 2.1 Endpoint

```
POST /api/connect/v1/approval-commands
```

Middleware: `connect.approval-key` (subclass `VerifyConnectApprovalApiKey`) + `throttle:60,1`.

Autentikasi memakai API key terpisah dari POS/recruitment:

- header default `X-ALIM-CONNECT-APPROVAL-KEY` (middleware juga menerima `Authorization: Bearer`);
- wajib memiliki cakupan `approval:command`; key tanpa cakupan ditolak `403 insufficient_scope`
  sebelum autentikasi, sehingga key tidak pernah menjadi kredensial tulis umum;
- perbandingan `hash_equals`, throttle percobaan gagal, IP allowlist opsional, respons `no-store`.

Konfigurasi (`config/services.php`, prefix `connect_approval`): `api_key`, `header`, `allowed_ips`,
`require_https`, `auth_fail_limit`, `scopes`, `max_duration_days` (default 365).

### 2.2 Aktor tidak pernah dipercaya dari payload

`actor_core_person_id` hanya disimpan sebagai referensi audit. Aktor sebenarnya diambil dari
`connect_actor_identities`:

1. identitas WhatsApp dinormalkan (`0812…`, `+62 …`, `628…@s.whatsapp.net` → `628…`);
2. baris harus `channel=whatsapp`, `is_active`, dan `verified_at` terisi;
3. user Core harus ada dan `is_active`.

Kegagalan masing-masing: `actor_identity_missing`, `actor_identity_unmapped`, `actor_inactive`.

### 2.3 Kewenangan

`canApprovePermitCommand(User $user, string $dormitoryId)` sengaja **lebih ketat** daripada policy web:

- `dormitory.head_id === user->id`, atau
- `DormitoryStaffAssignment` aktif dengan posisi `kepala_asrama` pada asrama tersebut.

Wakil kepala asrama, Super Admin, System Admin, dan pencocokan teks `employment.jabatan` **tidak**
diterima di jalur command. Ini keputusan sadar (lihat §6.1).

### 2.4 Idempotensi

| Kunci                                            | Perilaku                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `command_id` sama, payload sama                  | `200` + `outcome=duplicate`, `duplicate=true`, status izin tidak berubah |
| `command_id` sama, payload beda                  | `409 command_id_reused`                                                  |
| `external_message_id` sudah dipakai command lain | `409 external_message_replayed`                                          |
| Balapan unik saat `INSERT`                       | `resolveRace()` menjawab duplikat/konflik, bukan 500                     |

### 2.5 Transaksi dan audit

Seluruh perubahan berjalan dalam satu `DB::transaction`:

1. `SELECT … FOR UPDATE` pada permit;
2. validasi ulang status di dalam lock (`pending`, bukan `cancelled`/`expired`);
3. `Auth::login($actor)` agar `approved_by` dan audit memakai aktor terverifikasi;
4. `expected_return_datetime = departure_datetime + approved_duration_days`;
5. `LeaveWorkflowService::approve()` / `reject()`;
6. `DormitoryAudit::log('DORMITORY_PERMIT_APPROVED'|'DORMITORY_PERMIT_REJECTED', …)` dengan
   `command_id`, `decision`, `source`, `external_message_id`, identitas eksternal, dan hash teks pesan;
7. `ApprovalCommand::create(…)` menyimpan payload hash dan respons.

Kegagalan di tengah transaksi tidak meninggalkan perubahan parsial — dibuktikan satu test khusus.

### 2.6 Kode error

`validation_failed`, `insufficient_scope`, `actor_identity_missing`, `actor_identity_unmapped`,
`actor_inactive`, `actor_not_authorized`, `permit_not_found`, `permit_not_decidable`,
`permit_not_actionable`, `permit_expired`, `permit_not_expired`, `duration_invalid`,
`duration_out_of_range`, `permit_missing_departure`, `command_id_reused`,
`external_message_replayed`, `quota_exceeded`.

Catatan bentuk: error middleware mengirim `errors: null`, error cakupan mengirim
`errors: {code}` tanpa `context`, error controller mengirim `errors: {code, context}`. Kontrak
menerima ketiganya.

### 2.7 Berkas

| Berkas                                                                            | Isi                                             |
| --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `app/Http/Middleware/VerifyConnectApprovalApiKey.php`                             | Key + cakupan `approval:command`                |
| `app/Http/Requests/Connect/ApprovalCommandRequest.php`                            | Validasi payload + envelope `validation_failed` |
| `app/Http/Controllers/Api/Connect/V1/ApprovalCommandController.php`               | Envelope respons                                |
| `app/Services/Connect/ApprovalCommandService.php`                                 | Idempotensi, otorisasi, transaksi, audit        |
| `app/Exceptions/ApprovalCommandException.php`                                     | Status HTTP + kode + context                    |
| `app/Models/ApprovalCommand.php`                                                  | Riwayat command                                 |
| `app/Models/ConnectActorIdentity.php`                                             | Pemetaan identitas WhatsApp → user Core         |
| `database/migrations/2026_11_22_000001_create_connect_actor_identities_table.php` | Tabel pemetaan                                  |
| `database/migrations/2026_11_22_000002_create_approval_commands_table.php`        | Tabel command                                   |
| `tests/Feature/ConnectApprovalCommandTest.php`                                    | 17 test, 66 assertion                           |

---

## 3. Sisi Connect

### 3.1 Komponen

| Komponen                      | Berkas                                                                   |
| ----------------------------- | ------------------------------------------------------------------------ |
| WhatsApp Identity Mapping     | `whatsapp-identity.service.ts`, entitas `whatsapp_identities`            |
| Approval Notification         | `approval-notification.service.ts`                                       |
| Reply Resolver                | `approval-reply-resolver.service.ts`                                     |
| Deterministic Message Parser  | `approval-message.parser.ts`                                             |
| Approval Processor            | `approval-processor.service.ts`                                          |
| Core Approval API Client      | `core-client/http-alim-core-approval.client.ts` (nyata), `mock-…` (mock) |
| Approval Status Tracker       | entitas `approval_requests` + `approval-status.ts`                       |
| WhatsApp Confirmation Handler | `approval-confirmation.service.ts`                                       |
| Penghubung pesan masuk        | `approval-inbound.hook.ts` (hook `message:received`, prioritas 50)       |

Provider WhatsApp tetap Baileys yang sudah ada; tidak ada provider baru dan tidak ada jalur kirim
kedua (`MessageService.sendText`).

### 3.2 Status internal dan pemetaan lima `decision`

Kontrak final Core menerima lima nilai. Connect hanya mengirim dua di antaranya dari WhatsApp;
tiga sisanya dipetakan saat Core mengembalikannya, bukan dikirim oleh Connect.

| `decision` Core       | Sumber yang sah                              | Status internal Connect |
| --------------------- | -------------------------------------------- | ----------------------- |
| `approved`            | Balasan Kepala Asrama (`SETUJU <n> HARI`)    | `APPROVED`              |
| `rejected`            | Balasan Kepala Asrama (`TOLAK`)              | `REJECTED`              |
| `needs_clarification` | Proses internal Connect (durasi belum jelas) | `NEEDS_CLARIFICATION`   |
| `expired`             | Proses internal berwenang / jawaban Core     | `EXPIRED`               |
| `cancelled`           | Proses internal berwenang / jawaban Core     | `CANCELLED`             |

`WHATSAPP_DECISIONS` di `core-client/alim-core-approval.client.ts` hanya berisi `approved` dan
`rejected`, sehingga teks WhatsApp tidak pernah dapat mengakhiri proses sebagai `expired` atau
`cancelled`. Bila Core menjawab dengan salah satu nilai non-final, Connect memetakan status lokal
sesuai tabel di atas dan mengirim konfirmasi yang sesuai (`kedaluwarsa`/`dibatalkan`/minta
klarifikasi) — bukan pesan "DISETUJUI". `PENDING_APPROVAL` → `PROCESSING` → `APPROVED`/`REJECTED`
tetap dijaga `TRANSITIONS` di `approval-status.ts`. Status izin yang mengikat tetap `coreStatus`
dari Core.

### 3.3 Format pesan

| Balasan                        | Hasil                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `SETUJU 2 HARI IZN-2026-00125` | Command `approved` dengan durasi 2                                                                  |
| `TOLAK IZN-2026-00125`         | Command `rejected`                                                                                  |
| `SETUJU IZN-2026-00125`        | `NEEDS_CLARIFICATION` — durasi **tidak** di-default                                                 |
| `SETUJU 400 HARI …`            | `invalid_duration`, tidak ada command                                                               |
| Balasan tanpa referensi        | Hanya bila reply langsung ke pesan notifikasi (message id cocok) atau tepat satu permohonan terbuka |

Parser deterministik: tidak menebak, tidak membaca teks bebas.

### 3.4 Urutan pemrosesan

1. abaikan grup, pesan dari diri sendiri, dan teks yang bukan balasan persetujuan;
2. tolak `externalMessageId` yang sudah pernah menjadi command (duplikat);
3. identitas pengirim harus terverifikasi;
4. parse pesan;
5. kaitkan ke satu permohonan (quoted → referensi → satu-satunya permohonan terbuka);
6. pengirim harus orang yang dituju (`targetCorePersonId`);
7. command `PENDING`/`UNKNOWN` yang belum selesai memblokir keputusan berbeda, tetapi mengizinkan
   retry dengan `commandId` yang sama (worker retry melakukan ini otomatis, §3.6);
8. permohonan harus masih dapat diputuskan;
9. kirim command ke Core;
10. **hanya setelah Core menyatakan sukses** status lokal diperbarui dan konfirmasi WhatsApp dikirim.

### 3.5 Kondisi khusus

| Kondisi                           | Perilaku                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Nomor tak dikenal                 | Diabaikan; balasan opsional lewat `ALIM_CONNECT_REPLY_UNKNOWN`                                                      |
| Nomor belum tertaut GTK           | `unknown_sender`, tidak ada command                                                                                 |
| Aktor tak berwenang / beda asrama | Core menolak `403`, Connect meneruskan alasan                                                                       |
| Balasan ambigu                    | Tidak diproses; minta klarifikasi bila perlu                                                                        |
| Durasi tidak valid                | Ditolak dengan alasan, tanpa command                                                                                |
| Sudah diputuskan                  | `not_decidable`, tidak ada command baru                                                                             |
| Kedaluwarsa / dibatalkan          | Core menolak `permit_not_actionable` / `permit_expired`                                                             |
| Webhook / pesan berulang          | Duplikat by `external_message_id`, `commandId` tetap                                                                |
| Core timeout / 5xx                | Command `UNKNOWN`, pesan "belum dapat dipastikan"; worker retry mengirim ulang `commandId` yang sama dengan backoff |
| Retry habis                       | Command `FAILED`, `nextAttemptAt=null`, menunggu pemeriksaan manual; balasan baru tidak membuat command kedua       |
| Core menolak command              | Status lokal mengikuti penolakan, alasan disampaikan                                                                |

### 3.6 Retry worker `UNKNOWN` dan pemulihan `PENDING`

`ApprovalRetryService` memakai scheduler yang sudah ada (`startGuardedInterval`), bukan queue baru.

- Command disimpan sebagai `PENDING` dengan lease `nextAttemptAt = now + ALIM_CONNECT_RETRY_LEASE_MS`
  sebelum dikirim. Bila proses berhenti di antara simpan dan kirim, baris itu dipulihkan setelah
  lease habis — dengan `commandId` dan `externalMessageId` yang sama, bukan command baru.
- Satu pass memindai command `UNKNOWN` dan `PENDING` yang `nextAttemptAt` kosong atau sudah lewat.
- Baris diklaim dengan `UPDATE … WHERE status IN ('PENDING','UNKNOWN') AND (nextAttemptAt IS NULL OR nextAttemptAt <= now)`;
  `nextAttemptAt` sekaligus menjadi lease, sehingga dua proses tidak mengirim command yang sama.
- Parameter `now` pada klaim dikonversi dengan `DateTransformer.to()` agar berbentuk sama dengan
  isi kolom: PostgreSQL menyimpan `timestamp` sebagai waktu lokal, SQLite menyimpan teks ISO.
  `andWhere` tidak melewati transformer seperti `.set()`/`find`, sehingga `toISOString()` membuat
  Postgres membaca waktu naif dan selisih zona waktu membuat klaim tidak pernah cocok. Cacat ini
  tidak terlihat di SQLite dan hanya muncul saat suite PostgreSQL dijalankan.
- Proses yang mati di tengah pengiriman meninggalkan lease yang habis sendiri; restart melanjutkan
  baris yang sama.
- Backoff eksponensial `baseDelayMs × 2^(n-1)`, dibatasi `maxDelayMs`.
- Setelah `maxAttempts`, command diparkir `FAILED` lewat update bersyarat: hanya baris yang masih
  `PENDING`/`UNKNOWN` yang boleh berubah, sehingga hasil final yang ditetapkan proses lain
  (`APPLIED`/`REJECTED`) tidak pernah tertimpa.
- Command yang permohonannya sudah tidak ada juga diparkir `FAILED`, agar tidak diulang setiap pass.
- `duplicate` dari Core dianggap hasil pemulihan yang sah, bukan kegagalan.
- Tidak ada konfirmasi sukses/gagal kepada Kepala Asrama dari worker; konfirmasi hanya dikirim
  setelah Core menyatakan hasil final.

### 3.7 Konfigurasi

```
ALIM_CONNECT_CORE_CLIENT=mock|http
ALIM_CORE_BASE_URL=
ALIM_CORE_APPROVAL_API_KEY=
ALIM_CORE_APPROVAL_API_HEADER=X-ALIM-CONNECT-APPROVAL-KEY
ALIM_CONNECT_INGEST_KEY=
ALIM_CORE_TIMEOUT_MS=5000
ALIM_CONNECT_REPLY_UNKNOWN=false
ALIM_CONNECT_RETRY_INTERVAL_MS=60000      # 0 menonaktifkan worker
ALIM_CONNECT_RETRY_BATCH_SIZE=20
ALIM_CONNECT_RETRY_MAX_ATTEMPTS=5
ALIM_CONNECT_RETRY_BASE_DELAY_MS=30000
ALIM_CONNECT_RETRY_MAX_DELAY_MS=900000
ALIM_CONNECT_RETRY_LEASE_MS=60000
```

Default `mock`: tidak ada panggilan jaringan, dan mock **tidak** berpura-pura menjadi endpoint Core.
Mode `http` memakai klien nyata; tanpa `baseUrl`/`apiKey` hasilnya `unavailable`
(`core_not_configured`), bukan keputusan.

**Penjaga produksi.** `createApprovalCoreClient()` memanggil
`assertApprovalCoreClientAllowed()` pada jalur startup, bukan hanya di dokumentasi. Bila
`NODE_ENV=production`, boot gagal (`ApprovalCoreClientConfigError`) kecuali
`ALIM_CONNECT_CORE_CLIENT=http` **dan** `ALIM_CORE_BASE_URL` serta
`ALIM_CORE_APPROVAL_API_KEY` terisi. Konfigurasi produksi yang tidak lengkap tidak pernah
jatuh diam-diam ke mock. Sebagai lapis kedua, `MockAlimCoreApprovalClient.sendApprovalCommand()`
melempar error di produksi, sehingga mock tidak dapat menghasilkan status `applied` final.
Di `development`/`test` mock tetap diizinkan.

**Kredensial ingest.** `ALIM_CONNECT_INGEST_KEY` adalah kredensial layanan Core untuk
`POST /approval/requests`, terpisah dari API key ADMIN milik pengguna Connect. Bila kosong,
endpoint menjawab `503` (`integrasi Core tidak aktif`) — bukan terbuka — sehingga key ADMIN
Connect tidak dapat dipakai untuk memalsukan permohonan. Nilai dikirim di header
`X-Alim-Connect-Ingest-Key` dan dibandingkan dengan `timingSafeEqual`; nilai salah atau tidak
ada menghasilkan `401`.

### 3.8 Endpoint Connect

`POST /api/approval/requests` (ingest dari Core), `GET /api/approval/requests`,
`GET /api/approval/requests/:id`, `POST /api/approval/requests/:id/notify`,
`POST /api/approval/identities`. Semua memakai `@RequireRole` dan menolak key yang dibatasi sesi.
Ingest juga memerlukan kredensial layanan Core (`X-Alim-Connect-Ingest-Key`, §3.7); rute lain
cukup peran.

`POST /approval/identities` menormalkan nomor lebih dulu dan menolak (400) nilai yang tidak menjadi
8–15 digit, sehingga tidak ada baris dengan identitas kosong. `isVerified` **tidak** punya default:
pemanggilan endpoint tidak pernah dengan sendirinya membuat pemetaan dianggap terverifikasi.
`isActive` default `true`; `isActive: false` mencabut pemetaan tanpa menghapus riwayatnya.

Memindahkan nomor yang sudah terpetakan ke personel Core lain ditolak `409`
(`identity_reassign_requires_flag`) kecuali permintaan menyertakan `reassign: true`. Pemindahan
eksplisit mengosongkan `verifiedAt`; verifikasi harus dikirim ulang pada permintaan yang sama atau
sesudahnya. `isVerified: true` adalah pernyataan operator, bukan bukti identitas.

Setiap perubahan pemetaan — `create`, `update`, `reassign`, `verify`, `deactivate` — dicatat sebagai
`approval_identity_changed` lewat `AuditService`, lengkap dengan aktor dari kredensial yang
terautentikasi (principal API key), waktu, jenis perubahan, nilai sebelum dan sesudah, serta hasil.
Percobaan `reassign` yang ditolak juga dicatat (`result: 'rejected'`) agar upaya pengambilalihan
nomor tetap terlihat. Tidak ada nilai mentah kredensial yang disimpan di audit.

Respons endpoint permohonan memakai DTO tampilan, bukan entitas mentah: hanya
`id`, `coreRequestId`, `reference`, `studentName`, `studentClass`, `dormitoryCoreId`,
`dormitoryName`, `permitType`, `requestedDurationDays`, `departureAt`, `expectedReturnAt`, `status`,
`coreStatus`, `clarificationCount`, `decidedAt`, `decisionSource`, `notificationSentAt`,
`createdAt`, `updatedAt`. Kolom operasional internal (`targetIdentity`, `targetCorePersonId`,
`sessionId`, `notificationMessageId`, `lastCommandId`, `metadata`) tidak diekspos. Data operasional
tetap dapat dibaca ADMIN lewat basis data/audit, bukan lewat API permohonan.

**Batasan yang diketahui:** belum ada scoping per asrama/unit. `VIEWER` dapat membaca seluruh
permohonan yang tersimpan, bukan hanya unitnya. Ini dicatat sebagai keterbatasan, bukan dipalsukan
dengan nama peran; penambahan scope unit memerlukan kolom dan aturan otorisasi baru di Core.

Subjek otorisasi bersifat tetap: `targetIdentity` hanya boleh diikat saat permohonan masih
`PENDING_APPROVAL`, dan perubahan subjek setelah itu — termasuk pada `PROCESSING` atau status final —
ditolak `409` (`approval_subject_immutable`). Ingest ulang dengan nilai yang sama tetap diterima,
sehingga retry/duplikat dari Core tidak mengubah subjek dan tidak mengganggu pemulihan `PENDING`.
Nilai `targetIdentity` yang dikirim tetapi tidak dapat dinormalkan menjadi digit ditolak `400`,
bukan diabaikan — supaya bug Core tidak menyamar sebagai "tidak ada perubahan".

Migrasi: `1792400000000-CreateApprovalWorkflow.ts` (tiga tabel aditif, tanpa FK, `hasTable` guard)
dan `1792500000000-AddApprovalCommandRetry.ts` (kolom `lastError`, `lastAttemptAt`,
`nextAttemptAt` + indeks `(status, nextAttemptAt)`).

---

## 4. Kontrak dan pengujian

### 4.1 Artefak kontrak

| Artefak                 | Lokasi                                                   |
| ----------------------- | -------------------------------------------------------- |
| Dokumen kontrak command | `test/contracts/alim-core/approval-command.openapi.yaml` |
| Mock Core command       | `test/contracts/alim-core/approval-command.mock.ts`      |
| Uji kontrak             | `test/contracts/alim-core/approval-command.spec.ts`      |
| Validator bersama       | `test/contracts/alim-core/schema-validator.ts`           |

Lane: `npm run test:contracts` (kedua spec). Mock meniru envelope Core sebenarnya, termasuk
`errors: null` dari middleware, `validation_failed` dari FormRequest, dan semantik idempotensi.

### 4.2 Hasil

| Perintah                                                                | Hasil                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `php artisan test tests/Feature/ConnectApprovalCommandTest.php`         | 23 lulus, 84 assertion                                                                                                                                                                                                                                                                                                                   |
| `php artisan test tests/Feature/GtkWorkUnitLifecycleTest.php`           | 13 lulus, 38 assertion                                                                                                                                                                                                                                                                                                                   |
| `php artisan test tests/Feature/Dormitory tests/Feature/Sarpras …`      | 247 lulus, 3 gagal (pre-existing, §6.7)                                                                                                                                                                                                                                                                                                  |
| `php artisan test tests/Feature/DashboardJabatanTest.php`               | 6 lulus, 2 gagal (pre-existing, §6.7)                                                                                                                                                                                                                                                                                                    |
| `php artisan test tests/Feature/Authorization tests/Unit/Authorization` | 45 lulus, 97 assertion                                                                                                                                                                                                                                                                                                                   |
| `npx jest src/modules/approval`                                         | 152 lulus, 7 dilewati (suite PostgreSQL tanpa server) — 16 suite: parser, processor, service, controller, hook, resolver, klien HTTP, retry worker, pemulihan `PENDING`, konfirmasi, backup, batas keamanan identitas, kebijakan klien Core, mock Core, penjaga ingest, DTO respons                                                      |
| `npm run test:pg-approval` (PostgreSQL nyata)                           | 7 lulus di database sementara sendiri: `gen_random_uuid()` ketiga tabel, replay `UNKNOWN` dengan `commandId` sama, pemulihan `PENDING` setelah lease habis, lease yang masih berjalan tidak disentuh, hanya satu dari dua worker mengklaim baris, status final tidak tertimpa, parkir manual; `down()` kedua migration ikut diverifikasi |
| `npm run test:contracts`                                                | 84 lulus (2 suite)                                                                                                                                                                                                                                                                                                                       |
| `npm run test:docs`                                                     | 967 lulus (39 suite)                                                                                                                                                                                                                                                                                                                     |
| `npm test` (unit penuh)                                                 | 836 suite lulus, 9 suite gagal karena timeout beban (kesembilannya lulus 659/659 saat dijalankan sendiri dengan `--onlyFailures`); tidak ada kegagalan yang terkait modul approval                                                                                                                                                       |
| `npx jest src/modules/approval --coverage`                              | modul approval 94,15% statement, 79,25% branch, 92,85% function, 93,93% line (ambang `./src/modules/approval/` 86/72/85/86)                                                                                                                                                                                                              |
| `npx eslint` (seluruh `src`, `test`)                                    | bersih                                                                                                                                                                                                                                                                                                                                   |
| `npx tsc --noEmit`                                                      | tidak ada error baru (6 error lama di spec lain, di luar modul approval)                                                                                                                                                                                                                                                                 |
| `npm run openapi:check`                                                 | lulus setelah `openapi.json` diekspor ulang (201 path)                                                                                                                                                                                                                                                                                   |

### 4.3 Bug yang ditemukan uji kontrak

Klien HTTP melaporkan timeout sebagai `core_unreachable`, bukan `core_timeout`, karena Node
membungkus abort menjadi `TypeError: fetch failed`. Diperbaiki dengan memeriksa
`controller.signal.aborted` (otoritatif) di samping `error.name === 'AbortError'`.

### 4.4 Penjaga lane PostgreSQL di CI

Job `test-postgres` pada `ci.yml` dan `release.yml` kini menetapkan `DATABASE_TYPE=postgres` (beserta
host/port/user/password/name) di tingkat job, bukan per langkah. Sebelum spec dijalankan, sebuah
langkah `Assert the PostgreSQL lane is configured` memeriksa `process.env.DATABASE_TYPE` dan keluar
dengan kode 1 bila bukan `postgres`. Tanpa penjaga itu, spec PostgreSQL akan melewati dirinya sendiri
(`describe.skip`) dan job tetap hijau meski tidak ada satu pun yang berjalan. Urutan langkah (penjaga
sebelum spec) dan keberadaan penjaga itu sendiri dikunci oleh `src/common/test-lane-partition.spec.ts`,
sehingga tidak bisa dihapus tanpa membuat gate gagal.

---

## 5. Integrasi nyata vs mock

| Bagian                                       | Status                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| Core endpoint + validasi + transaksi + audit | Nyata, teruji terhadap SQLite test suite                                          |
| Connect parser, resolver, status, konfirmasi | Nyata, teruji                                                                     |
| Panggilan Connect → Core                     | Klien HTTP nyata ada; **default masih mock**, produksi wajib `http` (boot gagal)  |
| Kredensial service-to-service                | Mekanisme ada (`ALIM_CONNECT_INGEST_KEY`), **belum diisi** di lingkungan mana pun |
| Migrasi di produksi                          | Belum dijalankan                                                                  |
| Feature flag lifecycle GTK                   | Tetap OFF                                                                         |

---

## 6. Risiko dan keputusan terbuka

### 6.1 Kewenangan command vs policy web

Policy web menerima wakil kepala asrama, Super/System Admin, dan teks `employment.jabatan`.
Command hanya menerima Kepala Asrama dengan penugasan aktif. Ini disengaja, tetapi **perlu
keputusan pemilik sistem** apakah wakil kepala asrama boleh menyetujui lewat WhatsApp.

### 6.2 `decision` Connect kini selaras dengan kontrak final

Core menerima `approved`, `rejected`, `needs_clarification`, `expired`, `cancelled`. Tipe klien,
mock, entitas, migrasi, dan pemetaan status Connect memakai kelima nilai tersebut. Connect tetap
hanya **mengirim** `approved`/`rejected` dari WhatsApp; tiga nilai lain hanya dipetakan saat Core
mengembalikannya. Tidak ada kontrak Core yang diubah.

### 6.3 Cakupan pengujian unit Connect

Seluruh komponen utama kini punya test terarah: `approval.service`, `approval.controller`,
`approval-inbound.hook`, `approval-reply-resolver.service`, `approval-message.parser`,
`http-alim-core-approval.client`, `mock-alim-core-approval.client`, `core-client-policy`,
`approval-ingest.guard`, `approval-response.dto`, `approval-retry.service`,
`approval-processor.service`, `whatsapp-identity.security`, dan `approval-backup`. Skenario
mencakup identitas valid/tidak, aktor tidak berwenang, permohonan tidak ditemukan/sudah diputuskan,
seluruh kelas respons Core (200 applied, 200 duplicate, 401, 403, 404, 409, 422, 429, 500), timeout
sebelum/sesudah Core menyimpan, webhook duplikat, retry dengan `commandId` sama, dua worker
bersamaan, restart saat `UNKNOWN`, dan konfirmasi yang tidak pernah mendahului Core. Untuk hardening
ini ditambahkan: boot produksi menolak mock/konfigurasi tidak lengkap, mock menolak mengirim di
produksi, ingest menolak tanpa kredensial layanan (401) dan menolak saat belum dikonfigurasi (503),
`reassign` tanpa flag ditolak `409` beserta audit penolakannya, perubahan identitas tercatat dengan
aktor dan nilai sebelum/sesudah, serta subjek otorisasi tidak berubah pada `PENDING`/`PROCESSING`/final.

### 6.4 Retry otomatis sudah ada

`ApprovalRetryService` berjalan lewat `startGuardedInterval` dan memakai `nextAttemptAt` sebagai
jadwal sekaligus lease. Batas percobaan, backoff, dan interval dapat diatur lewat environment;
`intervalMs=0` menonaktifkannya. Command yang habis percobaan menjadi `FAILED` dan menunggu
pemeriksaan manual, bukan dikirim tanpa batas.

### 6.5 Cakupan `@RequireRole` bertambah lima

Gate `src/modules/auth/permission-coverage.spec.ts` menolak pertumbuhan `@RequireRole`, dan lima rute
approval menambahnya (186 → 191). Rute ini tetap memakai `@RequireRole` karena memberinya permission
sendiri (`approval.read`/`approval.decide`) berarti memperluas katalog RBAC dan matriks peran — sebuah
keputusan desain yang tidak diambil di pekerjaan ini. Pertambahan itu dicatat eksplisit di gate
tersebut; konversi ke `@RequirePermission` menjadi langkah tersendiri.

### 6.6 Tabel approval ikut backup/restore

`whatsapp_identities`, `approval_requests`, dan `approval_commands` kini terdaftar di
`EXPORT_TABLES` dengan urutan pulih identitas → permohonan → command, dan diimpor lewat descriptor
di `TABLE_IMPORTERS`. Ketiganya tidak memiliki FK ke `sessions`, sehingga import menghapusnya
eksplisit sebelum `DELETE FROM sessions` (urutan terbalik) agar restore ke instance asal tidak
bertabrakan pada primary key.

Konsekuensi: pemetaan identitas, status permohonan, dan ledger command bertahan setelah restore.
Yang tetap harus dilakukan operator setelah restore adalah mengirim ulang notifikasi yang belum
terkirim; `POST /api/approval/requests/:id/notify` tersedia untuk itu.

`src/modules/approval/approval-backup.spec.ts` memutar data lewat descriptor nyata dan membuktikan
pemetaan identitas serta relasi permohonan–command bertahan, termasuk command `UNKNOWN` beserta
jadwal retry-nya.

### 6.7 Lima kegagalan test Core yang pre-existing

Bukan regresi pekerjaan ini. Bukti: `config/gtk_work_unit.php` tidak ada, sehingga
`config('gtk_work_unit.lifecycle.enabled', false)` bernilai `false` dan `scopeCurrent()` menjadi
no-op; `DormitoryMasterController.php`, `routes/web.php`, dan seluruh view dashboard tidak berubah
pada diff ini (`git diff --stat cfc86817` untuk `tests/Feature/DashboardJabatanTest.php`,
`app/Http/Controllers/Dashboard`, `app/Services/Dashboard`, `resources/views/dashboard`,
`resources/views/user/dashboard` kosong); file test-nya sendiri juga tidak berubah.

| Test                                                                              | Gejala                                                     | Sebab                                                                                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DashboardJabatanTest > dashboard jabatan menampilkan header filter dan kpi`      | tidak memuat `Tahun Ajaran`                                | Dashboard tidak lagi menampilkan teks itu                                                                                    |
| `DashboardJabatanTest > dashboard memakai salam islami dan kaldik bulan berjalan` | tidak memuat `Assalamu'alaikum warahmatullahi wabarakatuh` | `welcome-banner.blade.php` kini hanya menampilkan `Assalamu'alaikum,`                                                        |
| `DormitoryProfileAccessTest > kepala asrama tidak bisa membuka asrama lain`       | `200`, diharapkan `403`                                    | `hasMasterAccess()` menganggap pemegang permission `dormitory_view` sebagai master, sehingga `canAccessDormitory()` dilewati |
| `DormitoryProfileAccessTest > pengguna tanpa izin asrama ditolak`                 | `302`, diharapkan `403`                                    | `myProfile()` mengalihkan pengguna tanpa asrama, tidak menolak                                                               |
| `SatuanPendidikanSidebarTest > waka yang tetap mengajar mendapat menu guru`       | halaman tidak memuat `Menu Guru`                           | Logika menu guru tidak menyertakan waka yang masih mengajar                                                                  |

Yang tersisa, semuanya di luar cakupan pekerjaan ini: putuskan apakah test atau view yang benar pada
dua kasus dashboard; putuskan apakah test atau controller yang benar pada dua kasus asrama (yang
pertama menyiratkan celah otorisasi nyata bila controller yang benar); dan perbaiki sumber menu guru
pada kasus terakhir.

---

## 7. Langkah berikutnya

1. Sepakati §6.1 dengan pemilik sistem Core (kewenangan command vs policy web).
2. Pasang key `connect_approval` di lingkungan non-produksi, jalankan migrasi aditif, lalu uji
   end-to-end dengan `ALIM_CONNECT_CORE_CLIENT=http`. Ini belum dilakukan: tanpa key dan Core
   non-produksi, integrasi lintas proses belum dapat dinyatakan berhasil.
3. Aktifkan feature flag lifecycle GTK hanya setelah Batch 1 selesai diverifikasi terpisah.
4. Putuskan lima kegagalan test Core yang pre-existing (§6.7) bersama pemilik Core.
