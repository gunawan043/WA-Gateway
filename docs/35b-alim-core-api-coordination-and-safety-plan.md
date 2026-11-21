# 35b. Koordinasi API ALIM Core dan Production Safety Plan

> **Status:** rancangan dan rencana, 2026-11-21. Tidak ada implementasi. Tidak ada perubahan pada
> ALIM Core maupun ALIM Connect.
>
> **Kedudukan dokumen:** [35a](./35a-alim-core-organization-mapping.md) menetapkan pemetaan dan
> prinsipnya (disetujui sebagai baseline). Dokumen ini adalah **paket kerja untuk tim ALIM Core** dan
> **gerbang D9**: implementasi API belum disetujui, dan baru dapat dimulai setelah Production Safety
> Plan serta peninjauan risiko produksi di sini ditinjau dan disetujui.
>
> **Yang bukan dokumen ini:** bukan kontrak final (kontrak ada di
> `docs/integration/alim-connect-api-design.md` milik Core), bukan persetujuan implementasi, bukan
> jadwal, dan bukan pengganti peninjauan keamanan Core.

---

## 1. Ringkasan

ALIM Connect membutuhkan tujuh jenis data organisasi dari Core — unit, sekolah, jabatan, orang,
penempatan, assignment struktural, dan tugas tambahan — lalu feed perubahannya. Desain API-nya sudah
ada di Core, tetapi **belum satu endpoint pun diimplementasikan** dan belum ada change ledger. Karena
itu paket ini dipisahkan menjadi tiga hal yang tidak boleh dicampur:

| Hal                         | Status              | Pemilik        | Gerbang                                    |
| --------------------------- | ------------------- | -------------- | ------------------------------------------ |
| Pemetaan dan prinsip        | Disetujui           | Pemilik sistem | —                                          |
| Kebutuhan API (dokumen ini) | Untuk ditinjau      | Connect → Core | Persetujuan tim Core                       |
| Implementasi API            | **Belum disetujui** | Core           | Production Safety Plan + peninjauan risiko |
| Sinkronisasi di Connect     | Belum dimulai       | Connect        | Endpoint Core tersedia dan stabil          |

Empat hal yang paling menentukan:

1. **API harus baca-saja.** Hanya `GET`, tanpa endpoint tulis, tanpa migration, tanpa perubahan skema.
   Fase 1–2 tidak memerlukan perubahan skema Core sama sekali.
2. **Kill switch harus ada sebelum endpoint pertama.** Core sudah memilikinya
   (`IntegrationApiConfig::enabled` → `503`); paket ini mewajibkan prefix `connect` memakainya, bukan
   membuat mekanisme baru.
3. **Beban harus dibatasi sebelum dibuka.** Middleware integrasi hari ini hanya membatasi percobaan
   autentikasi yang gagal; trafik sah tidak dibatasi. Limiter per key wajib ditambahkan sebelum
   endpoint Connect dipakai.
4. **Kualitas data harus diperiksa sebelum diekspos.** `parent_id` tanpa FK, `domain_id` yang tidak
   tersimpan, dan cascade delete adalah temuan Core yang akan terlihat sebagai "bug Connect" bila
   tidak diselesaikan lebih dulu.

---

## 2. Prinsip yang mengikat paket ini

1. Core adalah single source of truth; Connect tidak menyimpan master.
2. Tidak ada akses langsung ke database Core; hanya API resmi.
3. Connect tidak menulis ke Core: tidak ada `POST`/`PUT`/`PATCH`/`DELETE`.
4. Kegagalan integrasi tidak boleh mengganggu operasional Connect maupun Core.
5. Identitas memakai UUID Core.
6. Kunci integrasi Connect terpisah dari POS dan Recruitment.
7. Setiap perubahan kontrak setelah beku memerlukan versi baru dan persetujuan kedua pihak.
8. Tidak ada perubahan pada RBAC Fase 1a.

---

## 3. Kebutuhan API Connect

### 3.1 Urutan ketergantungan

```
unit ──► sekolah ──► jabatan ──► orang ──► penempatan ──► assignment struktural ──► tugas tambahan
  │                                                                                      │
  └──────────────────────────────► perubahan (changes) ◄─────────────────────────────────┘
```

Connect tidak dapat memakai assignment sebelum unit dan orang ada, dan tidak dapat menautkan akun
sebelum orang ada. Karena itu prioritas endpoint mengikuti urutan di atas, bukan abjad.

### 3.2 Daftar endpoint yang diminta

| Prioritas | Endpoint                                   | Dipakai untuk               | Fase Connect | Butuh change ledger |
| --------- | ------------------------------------------ | --------------------------- | ------------ | ------------------- |
| P0        | `GET /organization/units`                  | Read model unit + hierarki  | Tahap 1      | Tidak               |
| P0        | `GET /organization/units/{id}`             | Detail unit                 | Tahap 1      | Tidak               |
| P0        | `GET /organization/schools`                | Read model sekolah          | Tahap 1      | Tidak               |
| P0        | `GET /organization/positions`              | Read model jabatan          | Tahap 1      | Tidak               |
| P0        | `GET /organization/people`                 | Read model orang            | Tahap 1      | Tidak               |
| P0        | `GET /organization/people/{id}`            | Detail orang                | Tahap 1      | Tidak               |
| P1        | `GET /organization/work-unit-assignments`  | Penempatan                  | Tahap 1      | Tidak               |
| P1        | `GET /organization/structural-assignments` | Penugasan struktural        | Tahap 1      | Tidak               |
| P1        | `GET /organization/additional-tasks`       | Tugas tambahan (dua sumber) | Tahap 1      | Tidak               |
| P1        | `GET /organization/snapshot`               | Bootstrap dan rekonsiliasi  | Tahap 1      | Tidak               |
| P2        | `GET /organization/changes`                | Incremental + tombstone     | Tahap 5      | **Ya**              |

Path lengkap mengikuti desain Core: `/api/connect/v1/...`. Paket ini tidak meminta path lain dan tidak
meminta endpoint tulis.

### 3.3 Field dan filter minimum

Field minimum per entitas ada di [35a §8.3](./35a-alim-core-organization-mapping.md#83-data-minimum-yang-disinkronkan).
Filter yang dibutuhkan Connect:

| Endpoint               | Filter wajib                                        | Filter opsional             |
| ---------------------- | --------------------------------------------------- | --------------------------- |
| units                  | `updated_since`, `is_active`                        | `parent_id`, `type`, `q`    |
| schools                | `updated_since`, `is_active`                        | `work_unit_id`, `q`         |
| positions              | `updated_since`, `is_active`                        | `domain_id`, `jenis_gtk_id` |
| people                 | `updated_since`, `is_active`                        | `work_unit_id`, `q`         |
| work-unit-assignments  | `updated_since`                                     | `work_unit_id`, `user_id`   |
| structural-assignments | `updated_since`, `status`, `include_deleted`        | `user_id`, `school_id`      |
| additional-tasks       | `updated_since`, `source`                           | `user_id`, `work_unit_id`   |
| snapshot               | `types`, `active_only`, `include_deleted`, `format` | —                           |
| changes                | `since` (wajib), `types`, `limit`                   | `cursor`                    |

Catatan: `updated_since` pada master (unit, sekolah, jabatan) **belum ada** di POS/Recruitment dan
harus menjadi bagian dari implementasi Connect, bukan ditambahkan kemudian.

### 3.4 Kriteria penerimaan kontrak

Sebuah endpoint dianggap siap dipakai Connect bila:

1. `id` selalu UUID string dan stabil untuk entitas yang sama.
2. Setiap item memuat `updated_at` yang berubah pada setiap penulisan.
3. `per_page` dibatasi 200; respons menyertakan `meta.pagination`.
4. `include_deleted=true` hanya berlaku pada snapshot/changes dan mengembalikan `deleted_at`.
5. Relasi yang diminta lewat `include` tidak menimbulkan N+1 (dibuktikan dengan query log di staging).
6. Respons memakai envelope `ApiResponse` yang sama dengan POS/Recruitment.
7. `401`/`403`/`422`/`429`/`503` konsisten dengan tabel error di desain Core.
8. `X-ALIM-API-Version` dikirim di respons.
9. `Cache-Control: no-store, private` ada di setiap respons.
10. Fixture contoh disediakan untuk dijadikan dasar mock Connect.

---

## 4. Keputusan kontrak yang harus disepakati sebelum coding

| No  | Hal                  | Yang perlu disepakati                                                                         | Mengapa penting                                         |
| --- | -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| K1  | Semantik waktu       | `updated_at` memakai zona aplikasi; `updated_since` inklusif; `snapshot_at` adalah batas atas | Salah tafsir zona menghasilkan data terlewat atau dobel |
| K2  | Versi kontrak        | Versi di path (`/v1`) dan header; aturan kompatibilitas aditif                                | Menghindari pemutusan diam-diam                         |
| K3  | Pagination           | `page`/`per_page` untuk list; cursor untuk `changes`                                          | Snapshot besar tidak boleh memuat semua sekaligus       |
| K4  | Urutan `changes`     | deterministik `(occurred_at, id, source)`                                                     | Cursor hanya benar bila urutannya stabil                |
| K5  | Arti `delete`        | soft delete vs hard delete vs "tidak muncul lagi"                                             | Connect membutuhkan tombstone yang tidak ambigu         |
| K6  | Idempotensi          | pengiriman ulang tidak mengubah hasil                                                         | `changes` bersifat at-least-once                        |
| K7  | Penanganan `null`    | `domain_id`, `decree_id`, `end_date`, `work_unit_id` turunan                                  | Connect tidak boleh menebak                             |
| K8  | Kunci tugas tambahan | `(source, id)` komposit                                                                       | Dua tabel dengan id yang tidak saling unik              |
| K9  | Autentikasi          | header `X-ALIM-CONNECT-KEY`, key terpisah, allowlist IP                                       | Least privilege                                         |
| K10 | Rate limit           | angka per menit untuk list/snapshot/changes                                                   | Trafik sah belum dibatasi hari ini                      |

Kontrak beku (freeze) ditandatangani setelah K1–K10 disepakati. Setelah beku, perubahan hanya boleh
aditif dan memerlukan persetujuan kedua pihak.

---

## 5. Kebutuhan non-fungsional

| Aspek            | Kebutuhan                                                           | Cara membuktikan                                   |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| Baca-saja        | Tidak ada rute tulis di prefix `connect`                            | `route:list` diperiksa; uji negatif 405/404        |
| Latensi list     | p95 < 500 ms pada volume produksi                                   | uji beban di staging dengan data produksi tersalin |
| Latensi snapshot | selesai < 5 menit untuk volume saat ini; dapat dipaginasi           | uji snapshot penuh                                 |
| Ketersediaan     | kegagalan integrasi tidak menurunkan ketersediaan aplikasi Core     | uji timeout/limiter                                |
| Kesegaran data   | master ≤ 1 jam; assignment ≤ 15 menit bila endpoint tersedia        | metrik jeda sinkronisasi                           |
| Beban DB         | tidak menambah query berat pada jam sibuk                           | query log + `EXPLAIN`; indeks diverifikasi         |
| Keamanan         | tidak ada PII di luar matriks; token tidak pernah tercatat          | audit log + review kode                            |
| Observability    | setiap request punya `X-Request-Id`; kegagalan tercatat tanpa token | log dan metrik                                     |

Angka volume produksi **belum diukur** dalam audit ini. Angka pada desain Core adalah ilustrasi.
Sebelum go/no-go, tim Core mengukur jumlah baris per entitas dan menetapkan anggaran request
berdasarkan angka tersebut.

---

## 6. Production Safety Plan

### 6.1 Prinsip

1. **Tidak menyentuh skema.** Fase 1–2 hanya membaca; tidak ada migration baru untuk integrasi.
2. **Tidak menyentuh data.** Tidak ada penulisan, backfill, seeder, atau perbaikan data sebagai bagian
   dari integrasi. Perbaikan data adalah pekerjaan terpisah dengan persetujuannya sendiri.
3. **Tidak menyentuh POS/Recruitment.** Prefix, key, dan middleware mereka tidak diubah.
4. **Dapat dimatikan tanpa deploy.** Kill switch di `system_settings`.
5. **Dapat dibuktikan sebelum dibuka.** Staging dengan salinan data, lalu canary satu entitas.

### 6.2 Kontrol yang sudah ada di Core

Diverifikasi pada `app/Http/Middleware/VerifyIntegrationApiKey.php` dan
`app/Support/IntegrationApiConfig.php`:

| Kontrol                        | Perilaku                                               |
| ------------------------------ | ------------------------------------------------------ |
| HTTPS wajib di produksi        | `403` bila bukan HTTPS (`require_https` default true)  |
| Disable switch                 | `503` bila `enabled=false`, tanpa deploy               |
| Key belum dikonfigurasi        | `503`                                                  |
| IP allowlist                   | `403` bila IP tidak cocok; opsional                    |
| Perbandingan key constant-time | `hash_equals`                                          |
| Throttle autentikasi gagal     | 10 percobaan/menit per IP                              |
| Header `no-store`              | `Cache-Control: no-store, private`, `Pragma: no-cache` |
| Audit tanpa token              | log peringatan berisi IP dan path, tidak berisi key    |
| Key terenkripsi                | `system_settings` dengan prefix `enc:v1:`              |

Kesimpulan: mekanisme yang dibutuhkan **sudah ada**. Implementasi Connect cukup menambah subclass
`VerifyConnectApiKey` dengan prefix `connect`, bukan mekanisme baru.

### 6.3 Kontrol yang harus ditambah sebelum endpoint dibuka

| Kontrol                      | Kondisi hari ini                        | Yang diminta                                                              |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| Rate limit trafik sah        | **Tidak ada** (hanya auth gagal)        | Named limiter per key: list 120/menit, snapshot 6/menit, changes 60/menit |
| Batas waktu query            | Belum ditetapkan khusus untuk integrasi | `statement_timeout` untuk koneksi integrasi                               |
| Isolasi beban snapshot       | Tidak ada                               | Snapshot dijalankan job terjadwal, bukan request interaktif               |
| Audit pembacaan              | Hanya kegagalan auth                    | Log ringkas per request (key id, path, jumlah baris) tanpa PII            |
| Indeks untuk `updated_since` | Belum diverifikasi untuk semua tabel    | `EXPLAIN` pada setiap query baru; indeks ditambah bila perlu              |
| Batas `per_page`             | Ditetapkan di desain (1–200)            | Ditegakkan di validasi request                                            |
| Kill switch per konsumen     | Ada (prefix)                            | Diuji sebelum go-live                                                     |

Catatan penting: rate limit trafik sah adalah **prasyarat**, bukan penyempurnaan. Tanpa itu, satu
bug di Connect dapat membebani Core tanpa batas.

### 6.4 Pemeriksaan kualitas data (blocking)

Pemeriksaan ini dijalankan di staging dengan salinan data produksi, dan hasilnya dilampirkan pada
berkas go/no-go. Integrasi tidak boleh dibuka bila ada temuan yang belum diputuskan.

| No  | Pemeriksaan                                                  | Ambang yang diusulkan    | Tindakan bila gagal                           |
| --- | ------------------------------------------------------------ | ------------------------ | --------------------------------------------- |
| Q1  | `work_units.parent_id` menunjuk unit yang tidak ada          | 0 baris                  | Putuskan: perbaiki data atau tandai `orphan`  |
| Q2  | Siklus pada `parent_id`                                      | 0 siklus                 | Perbaiki data sebelum ekspos                  |
| Q3  | `structural_positions.domain_id` null                        | Diukur; tidak harus 0    | Connect menampilkan "tanpa domain"            |
| Q4  | `gtk_work_unit` dengan lebih dari satu `is_primary` per user | Diukur                   | Connect memilih deterministik; laporkan       |
| Q5  | `schools.work_unit_id` menunjuk unit yang tidak ada          | 0 baris                  | Perbaiki data                                 |
| Q6  | `structural_assignments` dengan `school_id` hilang           | 0 baris                  | Perbaiki data                                 |
| Q7  | `users` tanpa `gtk_profile`/`gtk_employment`                 | Diukur                   | Connect menampilkan tanpa status              |
| Q8  | Duplikasi natural key (email, npsn, code)                    | 0 baris                  | Tidak boleh diekspos sebelum bersih           |
| Q9  | Jumlah baris per entitas                                     | Dicatat sebagai baseline | Menjadi anggaran beban                        |
| Q10 | `updated_at` null atau tidak berubah pada update             | 0 baris                  | Wajib diperbaiki; snapshot bergantung padanya |

Q1, Q2, Q5, Q6, Q8, dan Q10 bersifat **blocking**. Sisanya harus diukur dan diputuskan.

### 6.5 Tahapan peluncuran

| Tahap | Lingkungan                      | Cakupan                                     | Kriteria naik                         |
| ----- | ------------------------------- | ------------------------------------------- | ------------------------------------- |
| L0    | Lokal/staging                   | Fixture, bukan data produksi                | Kontrak dan fixture cocok             |
| L1    | Staging + salinan data produksi | Semua endpoint P0, satu entitas per request | Q1–Q10 dievaluasi; p95 terukur        |
| L2    | Produksi, read-only             | Hanya `units` dan `schools`                 | 24 jam tanpa 5xx; beban terukur       |
| L3    | Produksi, read-only             | Tambah `positions`, `people`                | 24 jam tanpa 5xx                      |
| L4    | Produksi, read-only             | Tambah assignment dan tugas tambahan        | 72 jam tanpa 5xx; snapshot stabil     |
| L5    | Produksi                        | `changes` (setelah ledger ada)              | Tombstone terbukti; tidak ada regresi |

Setiap tahap dapat dihentikan tanpa memengaruhi tahap sebelumnya, karena Connect hanya membaca.

### 6.6 Anggaran beban

Anggaran ditetapkan setelah Q9. Kerangka yang diusulkan:

| Jenis panggilan  | Frekuensi maksimum      | Ukuran halaman | Catatan                        |
| ---------------- | ----------------------- | -------------- | ------------------------------ |
| Snapshot penuh   | 1×/24 jam               | 200            | Di luar jam sibuk              |
| List inkremental | 1×/15 menit per entitas | 200            | Berhenti saat `has_more=false` |
| Changes          | 1×/5 menit              | 500            | Hanya setelah ledger tersedia  |
| Rekonsiliasi     | 1×/24 jam               | 200            | Setelah snapshot               |

Aturan tambahan: backoff eksponensial pada `429`/`5xx`; tidak ada retry tak terbatas; tidak ada
paralelisasi lebih dari dua request bersamaan.

### 6.7 Observability

Metrik yang harus tersedia di Core (per prefix `connect`):

- jumlah request per endpoint dan status;
- p50/p95/p99 latensi;
- jumlah baris yang dikembalikan per request;
- `429` per key;
- error 5xx beserta `X-Request-Id`.

Metrik yang harus tersedia di Connect:

- waktu sukses terakhir per entitas;
- jumlah baris per sinkronisasi dan selisihnya dari baseline;
- jumlah `unresolved` (unit/person yang tidak ditemukan);
- status circuit breaker.

### 6.8 Kill switch dan rollback

| Skenario            | Tindakan                                                       | Waktu berlaku        |
| ------------------- | -------------------------------------------------------------- | -------------------- |
| Core terbebani      | `connect_enabled=false` → `503` pada semua request Connect     | Segera, tanpa deploy |
| Data terlihat salah | Matikan integrasi; Connect memakai data terakhir               | Segera               |
| Kunci bocor         | Rotasi key; allowlist IP diperketat; audit akses               | < 1 jam              |
| Endpoint bermasalah | Nonaktifkan endpoint lewat limiter/flag; versi baru bila perlu | < 1 hari             |

Connect tidak melakukan auto-revoke grant saat integrasi dimatikan. Data terakhir tetap dipakai dan
ditandai `stale`.

### 6.9 Penanganan insiden

| Tingkat | Definisi                                                | Tindakan                                                 |
| ------- | ------------------------------------------------------- | -------------------------------------------------------- |
| S1      | Core tidak dapat melayani, atau data sensitif terekspos | Matikan integrasi; eskalasi ke pemilik Core dan keamanan |
| S2      | Sebagian endpoint gagal atau lambat                     | Matikan endpoint terkait; Connect memakai data terakhir  |
| S3      | Data tidak lengkap tetapi tidak berbahaya               | Catat; perbaiki pada siklus berikutnya                   |

Setiap insiden mencatat: waktu, endpoint, `X-Request-Id`, dampak ke Connect, dan tindakan. Tidak ada
perbaikan data produksi yang dilakukan sebagai respons insiden tanpa persetujuan terpisah.

### 6.10 Jendela perubahan dan pembekuan

- Tidak ada deploy Core yang menyentuh tabel organisasi selama snapshot berjalan.
- Snapshot dijadwalkan di luar jam sibuk; jadwal disepakati bersama operasi Core.
- Perubahan kontrak dibekukan selama canary L2–L4.
- Migrasi Core (bila kelak diperlukan) tidak boleh satu rilis dengan aktivasi endpoint Connect.

### 6.11 Checklist go/no-go

| No  | Butir                                          | Bukti yang dilampirkan          | Status |
| --- | ---------------------------------------------- | ------------------------------- | ------ |
| 1   | Kontrak K1–K10 disepakati dan dibekukan        | dokumen kontrak bertanda tangan | —      |
| 2   | Q1, Q2, Q5, Q6, Q8, Q10 bersih atau diputuskan | laporan kualitas data           | —      |
| 3   | Rate limit trafik sah aktif                    | konfigurasi + uji 429           | —      |
| 4   | Kill switch diuji                              | catatan uji 503                 | —      |
| 5   | `EXPLAIN` setiap query baru diperiksa          | lampiran query plan             | —      |
| 6   | Staging L1 lulus dengan salinan data produksi  | laporan uji                     | —      |
| 7   | Observability tersedia di kedua sisi           | tangkapan metrik                | —      |
| 8   | Rencana rollback dan insiden disetujui         | dokumen ini §6.8–6.9            | —      |
| 9   | PIC dan jadwal ditetapkan                      | keputusan D9                    | —      |
| 10  | Peninjauan keamanan Core selesai               | catatan review                  | —      |

---

## 7. Peninjauan risiko terhadap sistem produksi

Risiko di bawah ini adalah risiko **Core** yang terlihat dari sisi integrasi. Connect tidak
memperbaikinya; Connect hanya memilih perilaku yang tidak memperburuknya.

| No  | Risiko                                                         | Pemicu                         | Dampak ke Connect                          | Kontrol / keputusan                                                     | Pemilik        |
| --- | -------------------------------------------------------------- | ------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------- | -------------- |
| P1  | Seeder menghapus `structural_positions`, cascade ke assignment | seeder dijalankan di produksi  | posisi dan assignment hilang; UUID berubah | Larang seeder di produksi; Connect tidak memakai posisi untuk otorisasi | Core           |
| P2  | Hard delete sekolah memicu cascade akademik dan assignment     | penghapusan sekolah            | assignment hilang tanpa tombstone          | Rekonsiliasi dua-run; larang hard delete sebagai prosedur rutin         | Core           |
| P3  | Hard delete SK memicu cascade assignment                       | penghapusan SK                 | assignment hilang                          | Sama seperti P2                                                         | Core           |
| P4  | `parent_id` tanpa FK berisi yatim/siklus                       | data lama                      | hierarki Connect salah                     | Q1/Q2 blocking; penanganan `orphan` di read model                       | Core + Connect |
| P5  | `domain_id` posisi tidak tersimpan saat seeding                | `$fillable` tidak memuat field | domain kosong                              | Q3 diukur; Connect menampilkan "tanpa domain"; perbaikan data terpisah  | Core           |
| P6  | Tidak ada change ledger                                        | —                              | penghapusan tidak terdeteksi cepat         | Tahap 5 ditunda; rekonsiliasi harian                                    | Core           |
| P7  | `gtk_work_unit` tanpa lifecycle                                | —                              | penempatan tidak dapat dinyatakan berakhir | Baris hilang = berakhir; rekonsiliasi                                   | Core           |
| P8  | `PermissionRebuildObserver` tidak menangani seluruh assignment | perubahan assignment           | permission Core basi                       | Connect tidak memakai permission Core (D2)                              | Core           |
| P9  | Trafik Connect membebani DB produksi                           | bug/loop di Connect            | latensi Core naik                          | Rate limit, backoff, jadwal, kill switch                                | Connect        |
| P10 | Kunci integrasi bocor                                          | kebocoran env/log              | akses baca seluruh organisasi              | Key terpisah, allowlist IP, rotasi, audit                               | Core + Connect |
| P11 | Data pribadi terbawa ke Connect                                | field berlebih di kontrak      | pelanggaran privasi                        | Matriks field 35a §8.3; review kontrak                                  | Connect        |
| P12 | Perubahan kontrak memutus Connect                              | perubahan tanpa versi          | sinkronisasi gagal                         | Freeze + versioning K2                                                  | Core           |

---

## 8. Koordinasi dengan tim ALIM Core

### 8.1 Artefak yang diserahkan

| Artefak                                              | Isi                                           | Status                              |
| ---------------------------------------------------- | --------------------------------------------- | ----------------------------------- |
| [35a](./35a-alim-core-organization-mapping.md)       | Pemetaan, prinsip, keputusan D1–D14           | Disetujui                           |
| 35b (dokumen ini)                                    | Kebutuhan API, safety plan, risiko, checklist | Untuk ditinjau                      |
| Desain API Core                                      | Kontrak endpoint (milik Core)                 | Ada, belum diimplementasikan        |
| [35c](./35c-alim-core-connect-api-contract-draft.md) | Kontrak draf, mock, fixture, dan uji kontrak  | Dibuat (Tahap 0), menunggu tinjauan |

### 8.2 Peran

| Peran                     | Tanggung jawab                                                  |
| ------------------------- | --------------------------------------------------------------- |
| Pemilik API Core          | Implementasi endpoint, kualitas data, rate limit, observability |
| Pemilik integrasi Connect | Kontrak konsumen, mock, sinkronisasi, penanganan kegagalan      |
| Keamanan                  | Review key, allowlist, audit, PII                               |
| Operasi Core              | Jendela snapshot, pembekuan perubahan, insiden                  |
| Pemilik sistem            | Menyetujui implementasi, PIC, ruang lingkup, jadwal (D9)        |

### 8.3 Alur kerja yang diusulkan

```
35a + 35b ditinjau
  → kontrak K1–K10 disepakati dan dibekukan
    → tim Core menyiapkan staging + salinan data
      → Q1–Q10 dievaluasi; temuan blocking diselesaikan
        → L0 (fixture) dan L1 (staging) lulus
          → go/no-go (§6.11) ditandatangani
            → L2 canary (units + schools)
              → L3, L4 bertahap
                → L5 setelah change ledger
```

### 8.4 Aturan koordinasi

1. **Tidak ada kesepakatan lisan.** Setiap penyimpangan dari kontrak dicatat di dokumen ini atau di
   dokumen kontrak Core.
2. **Satu sumber kebenaran untuk kontrak.** Perubahan bentuk respons hanya melalui versi baru.
3. **Connect tidak mengirim pekerjaan ke Core melalui jalur tidak resmi** (tidak ada query DB, tidak
   ada akses langsung ke server).
4. **Setiap tahap punya kriteria keluar.** Tidak ada "lanjut sambil jalan".
5. **Keputusan yang belum ditetapkan tetap terbuka.** Tidak ada asumsi yang dinaikkan menjadi
   persetujuan teknis.

---

## 9. Batas yang tidak dilanggar

- Tidak ada perubahan source code Core oleh tim Connect.
- Tidak ada migration atau tabel baru di Core.
- Tidak ada perubahan pada API POS dan Recruitment.
- Tidak ada akses langsung ke database Core.
- Tidak ada perubahan data produksi.
- Tidak ada perubahan pada RBAC Fase 1a Connect.
- Tidak ada Fase 1b/1c dalam pekerjaan ini.
- Tidak ada aktivasi scope `unit` (D12).

---

## 10. Urutan setelah persetujuan

1. Pemilik sistem menetapkan PIC, ruang lingkup, dan jadwal (D9).
2. Kontrak K1–K10 dibekukan.
3. Core menyiapkan staging dan menjalankan Q1–Q10.
4. Connect menyiapkan fixture dan mock (Tahap 0, dapat dimulai lebih awal).
5. L0–L1, lalu go/no-go.
6. L2–L4 bertahap; L5 setelah change ledger.

Tidak ada langkah di atas yang boleh dimulai hanya karena dokumen ini ada.

---

## 11. Hal yang masih memerlukan keputusan

| No  | Keputusan                                 | Opsi                                                   | Rekomendasi                       |
| --- | ----------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| S1  | PIC Core dan Connect                      | nama peran, bukan nama orang                           | ditetapkan bersama jadwal D9      |
| S2  | Ruang lingkup rilis pertama               | (a) P0 saja; (b) P0+P1                                 | (a) — canary lebih kecil          |
| S3  | Jadwal dan jendela snapshot               | jam di luar sibuk                                      | disepakati dengan operasi Core    |
| S4  | Penyimpanan kunci Connect                 | (a) `system_settings`; (b) env                         | (a), dengan rotasi tercatat       |
| S5  | Koneksi baca khusus untuk integrasi       | (a) koneksi utama; (b) read replica                    | (b) bila tersedia; keputusan Core |
| S6  | Angka rate limit                          | mengikuti §6.6                                         | disesuaikan setelah Q9            |
| S7  | Pemilik perbaikan data Q1/Q2/Q5/Q6/Q8/Q10 | Core                                                   | Core, sebelum L2                  |
| S8  | Kanal dan jadwal komunikasi insiden       | (a) kanal operasi yang ada; (b) kanal khusus integrasi | (a)                               |

S1–S8 tetap terbuka sampai pemilik sistem menetapkannya. Dokumen ini tidak menganggap rekomendasi
sebagai persetujuan.
