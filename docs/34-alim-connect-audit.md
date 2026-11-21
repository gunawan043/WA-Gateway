# 34 — ALIM Connect: Audit Repository dan Peta Perubahan

Status: **baseline audit**, 2026-11-21. Dokumen ini memetakan PRD ALIM Connect ke kondisi
repository apa adanya, lalu menetapkan urutan perubahan yang tidak merusak fondasi yang sudah
berjalan. Dokumen ini bukan spesifikasi fitur; setiap fase mendapat dokumen dan rencana sendiri
sebelum implementasi.

Keputusan pemilik sistem yang mengikat dokumen ini:

- Stack tetap **NestJS 11 + TypeORM** dan skema database yang sudah ada.
- Provider WhatsApp tetap yang berjalan sekarang (Baileys); migrasi provider adalah keputusan
  terpisah.
- Integrasi ALIM Core hanya melalui kontrak API; **tidak ada akses langsung ke database ALIM**.
- Role dan permission dikembangkan menuju 8 peran operasional dengan cakupan unit, tim, dan objek.
- Fitur yang belum ada dilengkapi bertahap; fitur yang sudah ada dipertahankan.
- Tidak ada refactor besar atau penggantian fondasi tanpa persetujuan.

---

## 34.1 Ringkasan Kondisi Aktual

| Aspek | Kondisi |
| --- | --- |
| Backend | NestJS 11, TypeORM, dua koneksi: `main` (SQLite: `api_keys`, `users`, `user_sessions`, `audit_logs`) dan `data` (SQLite/PostgreSQL) |
| Modul | 35 modul di `src/modules/` (auth, session, message, inbox, division, campaign, crm, automation, contact, template, webhook, integration, events, audit, stats, metrics, search, media, plugins, mcp, dst.) |
| Entitas | 33 entitas; 35 tabel (termasuk tabel engine) |
| API | 195 path OpenAPI, 123 di antaranya tercakup 5 SDK |
| Realtime | Socket.IO dengan event per sesi, chat-scope filter, dan Redis adapter untuk multi-node |
| Queue | BullMQ + Redis (opsional), retry, dead-letter untuk webhook dan integrasi |
| Dashboard | React 19 + Vite + TanStack Query, 15 locale, 1.547 kunci terjemahan |
| Tes | Backend ±20.800 tes (821 suite), dashboard 2.844 tes, plus lane dokumentasi 39 suite |
| Deployment | LiteSpeed Passenger, SQLite, produksi di `alim-wa.abuhurairah.id` |

Fondasi yang sudah kuat dan tidak perlu dibangun ulang: idempotensi pesan, outbox webhook,
audit log, queue dengan retry, plugin sandbox, event WebSocket, migrasi berversi dengan gerbang
drift, dan kontrak API yang dijaga gerbang dokumentasi.

---

## 34.2 Peta Modul PRD ke Repository

Legenda: **A** = sudah ada dan memadai, **B** = ada tetapi belum memenuhi PRD, **C** = belum ada.

| Modul PRD | Yang ada sekarang | Status | Gap utama |
| --- | --- | --- | --- |
| Omnichannel Inbox (§4.1) | `inbox` (percakapan, catatan, status, assignment, SLA, laporan), `division`, `events` | B | Baru WhatsApp; belum ada label/prioritas percakapan, pencarian isi lintas percakapan, dan histori assignment sebagai entitas |
| Contact Management (§4.2) | `contact` membaca buku alamat engine; `label` = label WhatsApp; `crm` menyimpan deal per `chatId` | C | Tidak ada tabel kontak lokal, identitas lintas kanal, relasi terverifikasi ke ALIM, atau consent |
| Team & Agent (§4.3) | `division` (anggota = API key, per sesi), `division_agents`, `users` | B | Tim belum punya supervisor, kapasitas, ketersediaan, atau histori keanggotaan; konsep "tim" masih menempel pada routing |
| Chatbot & Automation (§4.4) | `automation_rules` (autoreply satu pesan, kondisi memakai filter webhook), `takeover` | B | Tidak ada log eksekusi, fallback terukur, pemicu jam layanan/label/tiket, atau flow builder |
| Ticketing & SLA (§4.5) | SLA first-response di `inbox_conversations` + `inbox_sla.service.ts` | C | Tiket belum ada sebagai entitas; SLA masih 24/7, belum memakai kalender jam layanan; belum ada eskalasi/reopen beralasan |
| Campaign Management (§4.6) | `campaign`, `campaign_recipients`, `campaign_segments`, `templates` | B | Tidak ada consent/opt-out, approval, atau penegakan kebijakan provider sebelum kirim |
| Analytics & Reporting (§4.7) | `stats`, laporan inbox (`GET /inbox/reports`), `metrics` Prometheus | B | Belum per unit/tim, belum perbandingan periode, belum ekspor ber-audit, belum penanda sampel kurang |
| AI Assistant (§4.8) | — | C | Seluruhnya |
| Employee Performance (§5) | — | C | Seluruhnya: KPI, quality evaluation, komposisi skor, coaching |
| Integrasi ALIM Core (§6) | — | C | Seluruhnya; kontrak API belum tersedia |
| Audit & Compliance (§9) | `audit_logs`, enum aksi dengan gerbang cakupan | A/B | Kuat untuk aksi yang ada; belum mencakup permission, ekspor, evaluasi, dan consent |
| Channel abstraction (§7.4) | `engine/interfaces/whatsapp-engine.interface.ts` + dua adapter | A/B | Abstraksi sudah ada untuk WhatsApp; belum ada kontrak provider kanal non-WhatsApp |

### 34.2.1 Yang sudah lebih matang dari PRD

Beberapa hal di PRD sudah terlampaui dan tidak perlu disentuh:

- **Idempotensi dan outbox** pesan/webhook sudah berjalan dengan retry, dead-letter, dan
  rekonsiliasi; PRD memintanya di §7.5–7.6.
- **Audit** sudah menjadi enum tertutup yang dijaga tes; aksi baru wajib menambah enum dan
  pemakaiannya.
- **Multi-node** sudah didukung (lease sesi, Redis adapter, klaim atomik pada SLA sweeper).
- **Backup/restore** seluruh tabel data sudah ada dan diparity-check dengan entitas.

---

## 34.3 Identitas Produk: Apa yang Diubah, Apa yang Dipertahankan

Ada 368 file yang menyebut "OpenWA". Mengganti semuanya akan merusak kompatibilitas. Pemisahannya:

### Diubah (identitas yang dilihat pengguna)

| Lokasi | Perubahan |
| --- | --- |
| `dashboard/src/i18n/locales/*.json` → `common.appName` (15 file) | `ALIM Connect` |
| `dashboard/index.html` `<title>` | `ALIM Connect` |
| `src/config/swagger.config.ts` (judul, deskripsi, kontak) | `ALIM Connect API` |
| `docs/01-project-overview.md`, `README.md` | Judul dan paragraf pembuka |
| Footer dashboard | Tetap mencantumkan atribusi upstream: "ALIM Connect · dibangun di atas OpenWA" |
| `src/modules/mcp/mcp.server.ts` `serverInfo.name` | Ditinjau terpisah; nama ini terlihat oleh klien MCP |

### Dipertahankan (permukaan kompatibilitas)

| Hal | Alasan |
| --- | --- |
| Nama paket npm `openwa`, nama paket SDK, image Docker, chart Helm | Klien dan pipeline yang sudah ada merujuk nama ini |
| Header `X-OpenWA-Signature` | Penerima webhook sudah memverifikasi header ini; mengganti nama = memutus integrasi |
| Variabel lingkungan `OPENWA_*` | Konfigurasi produksi dan dokumentasi operator |
| Nama file `data/openwa.sqlite`, `data/main.sqlite` | Backup dan runbook |
| Path API | Tidak mengandung merek; jangan diubah tanpa versi baru |
| ID plugin dan namespace tool MCP | Kontrak dengan pengguna plugin |
| Dokumen 02–33 | Sebutan "OpenWA" di sana sebagian merujuk proyek upstream/SDK; diganti hanya saat dokumen itu disentuh |

Aturan: **rebranding adalah lapisan identitas, bukan rename global.** Setiap penggantian harus
disertai alasan kompatibilitas, dan gerbang tes tidak boleh dilonggarkan untuk itu.

Di luar Fase 0 masih ada delapan kalimat di katalog locale yang menyebut "OpenWA" sebagai pelaku
(`numberChecker.noSession.desc`, ketiga `infrastructure.*.builtInDesc`, `plugins.empty.description`,
`sessions.restriction.passkey_required_note`, `infrastructure.migration.invalidFile`) dan rujukan
ke katalog plugin OpenWA. Penggantiannya mekanis karena nama merek tetap Latin di semua bahasa,
tetapi menyentuh 15 katalog, jadi dikerjakan bersama pass teks berikutnya. `login.footer` (atribusi
penulis asli) dan `X-OpenWA-Signature` (kontrak webhook) tidak ikut diganti.

---

## 34.4 Role dan Permission

### Kondisi sekarang

- `ApiKeyRole` hanya `admin` / `operator` / `viewer` (`src/modules/auth/entities/api-key.entity.ts`).
- Otorisasi memakai `@RequireRole`, `@RequireUnscopedKey`, `@ChatScoped('fenced'|'filtered'|'agnostic')`,
  serta scope `allowedSessions` dan `allowedChats` pada API key.
- Setiap user memiliki satu `api_keys` row; seluruh sistem membaca `request.apiKey`.
- `division_agents` menyimpan keanggotaan per API key, per sesi.

### Kebutuhan PRD

Delapan peran operasional, satu akun bisa punya beberapa penugasan, dan akses dibatasi unit, tim,
serta objek. Permission berasal dari ALIM Core, tetapi harus tetap ditegakkan di server.

### Usulan yang aditif (tanpa membongkar guard yang ada)

1. **Pertahankan `api_keys.role`** sebagai peran kasar untuk kompatibilitas dan untuk kunci mesin.
2. Tambah tabel `role_assignments` (koneksi `main`, karena menempel pada user/key):
   `userId`/`apiKeyId`, `role`, `scopeType` (`global`|`unit`|`team`|`session`), `scopeId`,
   `source` (`local`|`alim`), `externalId`, `validFrom`, `validTo`.
3. Tambah `PermissionService` yang menghitung permission efektif per request dari penugasan aktif,
   lalu satu decorator `@RequirePermission('ticket.write')`. Guard lama tetap dipakai untuk rute
   yang belum dimigrasikan.
4. Pemetaan awal agar tidak ada yang kehilangan akses: `admin` → `system_admin` + `connect_admin`,
   `operator` → `agent`, `viewer` → `analyst`. Pemetaan ini ditulis di dokumen migrasi dan diuji.
5. Sinkronisasi ALIM Core mengisi `role_assignments` dengan `source = 'alim'`; penugasan lokal tetap
   berlaku sampai ada keputusan tata kelola.

Yang **tidak** dilakukan: mengganti `ApiKeyRole` secara langsung, atau menaruh logika permission di
UI. UI hanya menyembunyikan; server tetap memutuskan.

---

## 34.5 Integrasi ALIM Core

### Batas yang disarankan

Modul baru `src/modules/alim-core/`:

- `alim-core.contract.ts` — tipe untuk `/me`, `/me/assignments`, `/me/permissions`,
  `/organization/units`, `/people/*`, beserta bentuk error dan versi kontrak.
- `alim-core.client.ts` — HTTP client dengan timeout, retry ber-backoff, dan batas payload.
- `alim-core-auth.service.ts` — verifikasi token (issuer, audience, expiry, scope) atau pertukaran
  kredensial jangka pendek bila OAuth2/OIDC belum tersedia.
- `alim-core-sync.service.ts` — sinkronisasi berkala/event, menulis `alim_sync_logs`.
- `alim-core.mock.ts` — server palsu yang menyajikan fixture, aktif lewat `ALIM_CORE_MOCK=true`.

### Aturan

- Tidak ada query langsung ke database ALIM, termasuk untuk laporan.
- Snapshot lokal selalu ditandai `externalId`, `syncedAt`, dan `source`; bukan sumber otoritatif.
- Kegagalan ALIM Core tidak boleh menghentikan inbox: login lokal tetap jalan, permission terakhir
  yang tervalidasi dipakai sampai kedaluwarsa, dan kegagalan dicatat.
- Kontrak diuji dengan fixture, bukan dengan asumsi endpoint yang belum ada.

### Urutan aman

Kontrak + mock lebih dulu, lalu adapter nyata. Dengan begitu Fase 1 (RBAC) dan Fase 2 (tiket) bisa
berjalan tanpa menunggu ALIM Core.

---

## 34.6 Guardrail Teknis untuk Semua Fase

Ini adalah aturan yang harus diikuti setiap penambahan fitur, diambil dari kondisi repo:

1. **Entitas baru** wajib terdaftar di empat tempat: glob `src/app.module.ts`,
   `dataEntities` di `src/database/data-source.ts`, `migration-drift.spec.ts`, dan
   `export-tables.parity.spec.ts`. Tanpa itu, gate akan gagal atau backup kehilangan tabel.
2. **Migrasi** memakai SQL mentah bercabang `isPostgres` dengan guard `hasTable`/`hasColumn`;
   `down()` membalik dalam urutan FK. Kolom tanggal di SQLite memakai `text` agar tidak menambah
   drift.
3. **Koneksi**: data domain ke `data`; identitas, kunci, sesi login, dan audit ke `main`.
4. **Event realtime** baru wajib masuk `SUBSCRIBABLE_EVENTS` dan `CHAT_EVENTS` (bila membawa
   `chatId`), serta tabel event di `docs/06`.
5. **Audit**: setiap aksi sensitif menambah `AuditAction` dan benar-benar memakainya.
6. **API**: rute baru mendapat heading di `docs/06`, dekorator peran/scope, dan `openapi.json`
   diperbarui.
7. **Dashboard**: aturan CSS harus di bawah root halaman, hanya memakai variabel yang terdaftar,
   lolos forced-colors/RTL/kontras, dan setiap teks masuk 15 locale.
8. **UI** melewati alur `unslop`: audit temuan, arah desain, persetujuan, sembilan pass. Tidak ada
   perubahan visual yang mengubah perilaku, permission, atau kontrak API.

---

## 34.7 Urutan Pekerjaan yang Diusulkan

Urutan ini berbeda dari §12 PRD pada satu hal: PRD menaruh Auth/ALIM di Sprint 1, tetapi API ALIM
belum tersedia. Karena itu identitas dan RBAC dikerjakan lebih dulu, sementara kontrak ALIM
disiapkan paralel sebagai mock.

| Fase | Fokus | Hasil | Bergantung pada |
| --- | --- | --- | --- |
| **0** | Identitas produk | Dashboard, judul API, README, docs/01 menjadi ALIM Connect; permukaan kompatibilitas tetap | — |
| **1** | RBAC + Tim | `role_assignments`, `PermissionService`, 8 peran terpetakan, tim memperoleh supervisor/kapasitas/ketersediaan, histori keanggotaan | 0 |
| **2** | Tiket + SLA kalender | `tickets`, komentar, aktivitas, SLA event, jam layanan per tim, eskalasi, reopen beralasan | 1 |
| **3** | Kontak lokal + consent | `contacts`, `contact_identities`, `contact_consents`, relasi ALIM, deduplikasi beraudit | 1 |
| **4** | Integrasi ALIM Core | Kontrak + mock, lalu token/SSO nyata, `alim_sync_logs`, sinkronisasi assignment/permission | 1 |
| **5** | Automation lengkap | Log eksekusi, pemicu jam/label/tiket, fallback, penonaktifan oleh supervisor | 2 |
| **6** | Analytics + Performance | Ringkasan harian, KPI, quality evaluation, komposisi skor dengan ambang sampel | 2 |
| **7** | AI Assistant | Ringkasan, saran balasan, klasifikasi; tanpa kirim otomatis dan tanpa penilaian final | 3, 6 |

### Fase 0 — Identitas (kecil, aman)

- Ubah `common.appName`, judul halaman, judul OpenAPI, README, dan docs/01.
- Tambahkan dokumen ini ke indeks `docs/README.md`.
- Jangan menyentuh nama paket, image, header signature, env, atau path.
- Verifikasi: `openapi:check` (judul berubah, path tidak), tes dashboard, i18n parity.

### Fase 1 — RBAC dan Tim (fondasi, paling berisiko)

- Tabel `role_assignments` di `main`; `PermissionService`; decorator baru; pemetaan peran lama.
- Evolusi `divisions` menjadi tim operasional secara aditif: `supervisorKeyId`, `capacity`,
  `isAvailable` pada anggota, dan tabel histori keanggotaan. **Jangan** membuat entitas `teams`
  paralel yang menduplikasi routing.
- Uji: akses diizinkan dan ditolak untuk setiap peran, migrasi data lama, dan kompatibilitas
  `admin`/`operator`/`viewer`.
- Risiko utama: satu guard yang terlewat membuka data lintas tim. Gerbang cakupan rute harus
  diperluas, bukan dilonggarkan.

### Fase 2 — Tiket dan SLA kalender

- `tickets`, `ticket_comments`, `ticket_activities`, `ticket_sla_events` di koneksi `data`.
- Tiket dibuat dari percakapan; status `open`/`in_progress`/`waiting`/`resolved`/`closed`.
- Kalender jam layanan per tim; timer berhenti di luar jam kerja; waktu tunggu kontak dipisahkan
  dari waktu kerja petugas.
- SLA inbox yang sudah ada tetap; tiket memakai mesin kalender yang sama.

### Fase 3 — Kontak lokal dan consent

- `contacts`, `contact_identities`, `contact_consents`; `chatId` menjadi salah satu identitas.
- Relasi ALIM disimpan sebagai referensi bertanda sumber dan waktu verifikasi.
- Consent menjadi syarat kampanye; opt-out adalah daftar pengecualian yang ditegakkan di runner.

### Fase 4 — ALIM Core

- Kontrak dan mock lebih dulu, diuji dengan fixture.
- Setelah API nyata tersedia: verifikasi token, sinkronisasi, dan fallback saat ALIM tidak dapat
  dihubungi.
- Tidak ada perubahan pada alur inbox bila ALIM mati.

### Fase 5–7

Mengikuti PRD §4.4, §4.7, §5, dan §4.8. Semuanya bergantung pada tiket (Fase 2) karena KPI
resolusi, reopen, dan quality evaluation mengambil sampel dari tiket dan percakapan.

---

## 34.8 Keputusan Terbuka

| Keputusan | Mengapa penting | Usulan |
| --- | --- | --- |
| Tim = divisi atau entitas baru? | Menentukan seluruh Fase 1 | Evolusi `divisions` secara aditif; nama rute dipertahankan |
| Sumber kebenaran permission saat ALIM mati | Menentukan keamanan dan ketersediaan | Cache penugasan tervalidasi dengan masa berlaku + audit |
| Jam layanan per tim atau per unit? | Akurasi SLA dan KPI | Per tim, dengan default tingkat sesi |
| Batas sampel minimum skor | Keadilan penilaian | Angka awal dari PRD, dapat dikonfigurasi, ditampilkan bersama skor |
| Cakupan rebranding dokumen 02–33 | Waktu dan risiko | Ganti saat dokumen disentuh; jangan sapu bersih sekaligus |
| Nama `serverInfo` MCP | Terlihat oleh klien AI | Tinjau bersama pemilik; bukan bagian Fase 0 |

---

## 34.9 Definition of Done per Fase

Mengacu pada PRD §12.1, dengan tambahan khusus repo ini:

- Migrasi berjalan di SQLite dan PostgreSQL, dengan `down()` yang diuji.
- `migration-drift` dan parity export/import lulus.
- Setiap rute baru punya heading di docs/06, dekorator peran/scope, dan entri OpenAPI.
- Setiap event baru punya entri di tabel event dan gerbang `SUBSCRIBABLE_EVENTS`.
- Setiap aksi sensitif menambah `AuditAction` yang benar-benar dipakai.
- Dashboard: 15 locale, gerbang CSS/RTL/kontras, `typecheck`, `test:unit`, `build`.
- Tidak ada akses langsung ke database ALIM.
- Tidak ada penurunan cakupan tes; suite yang gagal karena waktu diulang dan dicatat, bukan
  diabaikan.

---

## 34.10 Catatan tentang `unslop`

Skill `unslop` (CC BY 4.0, Damir Sokolovsky) terpasang di `~/.codebuddy/skills/unslop` dan wajib
dipakai untuk pekerjaan UI: periksa layar, audit temuan, tentukan heavy/light/no slop, ajukan lima
baris arah desain, tunggu persetujuan, lalu jalankan sembilan pass. Skill ini tidak mengubah
perilaku, permission, atau kontrak API; ia hanya memperbaiki kualitas antarmuka. Atribusi upstream
dipertahankan sesuai lisensi.
