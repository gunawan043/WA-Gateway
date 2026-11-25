# ALIM Connect — Production Deployment Cycle 2 Execution

Tanggal: 2026-11-25
Rilis terpasang: `da5ac8187` (tag `alim-connect-prod-20261125`)
Host: Hostinger shared hosting, Passenger + Node 22, SQLite
Situs: `https://alim-wa.abuhurairah.id/`
Status keseluruhan: **AKTIF**

---

## 1. Ringkasan

ALIM Connect kini berjalan di produksi dengan modul approval dan SSO terpasang. Rilis lama
(`d9c5ec866`, 21 Nov) tidak memuat `src/modules/approval` maupun `src/modules/sso`, sehingga seluruh
rute modul itu menjawab 404. Build baru dipasang sebagai artefak, bukan dibangun di server.

Core (`https://alim.abuhurairah.id/`) tidak disentuh sama sekali dan tetap menjawab 302.

## 2. Status per prioritas

| # | Prioritas | Status | Bukti |
|---|---|---|---|
| 1 | Rilis benar terpasang | DONE | `dist/modules/approval` (26 js), `dist/modules/sso` (7 js) |
| 2 | Verifikasi endpoint dari sumber | DONE | Tabel di §5 |
| 3 | Konfigurasi produksi | DONE | `ALIM_CONNECT_CORE_CLIENT=disabled` |
| 4 | Deploy di `alim-wa.abuhurairah.id` | DONE | root 200, 0,31 s |
| 5 | Integrasi Core aktif | BLOCKED | Aktor Core belum dibuat pemilik Core |
| 6 | Dokumen operasional | DONE | dokumen ini + `alim-connect-production-api.md` |
| 7 | Audit DB produksi | NOT APPLICABLE | Produksi memakai SQLite lokal, bukan Supabase |

## 3. Penyebab 503 dan perbaikannya

Tiga masalah terpisah, ditangani berurutan.

**3.1 Kuota proses habis (akar 503 pertama).**
`npm run dashboard:build` di server memakai Vite dan melahirkan ratusan proses anak. Build berjalan
26 menit tanpa selesai, `fork` gagal (`Resource temporarily unavailable`), Passenger tidak bisa
menyalakan worker, dan situs jadi 503. Proses itu (PID 3298584) dibunuh, sisa clone `release-new`
(941 MB) dihapus.

**3.2 Build lama tanpa modul.** `dist` produksi diverifikasi tidak memuat `modules/approval` maupun
`modules/sso`, sesuai dugaan: build dari `gateway/main`.

**3.3 Bug konfigurasi `disabled` (ditemukan saat deploy).**
Setelah `ALIM_CONNECT_CORE_CLIENT=disabled` disetel, aplikasi tetap menolak boot:

```
ApprovalCoreClientConfigError: ALIM_CONNECT_CORE_CLIENT harus "http" atau "disabled" di produksi
```

Penyebabnya `src/config/configuration.ts:580`, yang hanya mengenal `http` lalu memetakan semua nilai
lain ke `mock`. Mode `disabled` jadi tidak mungkin dipakai di produksi — justru satu-satunya tempat
mode itu dirancang untuk dipakai. Diperbaiki dengan `resolveApprovalCoreClient` yang meneruskan
`disabled` apa adanya, menormalkan huruf besar/kecil dan spasi, dan tetap menjatuhkan nilai tak dikenal
ke `mock` agar gerbang produksi terus menolak salah ketik.

Perbaikan diuji: `configuration.spec.ts` 45/45, suite approval + transport policy 216 lulus / 0 gagal.

## 4. Perubahan di server

| Objek | Aksi | Cadangan |
|---|---|---|
| `openwa/dist` | diganti build `da5ac8187` | `dist.old-20261125-050128` (22 MB, di server) |
| `openwa/dashboard/dist` | diganti 4,0 MB / 129 file | `dashboard/dist.old-20261125-050132` (19 MB, di server) |
| `openwa/.env` | + `ALIM_CONNECT_CORE_CLIENT=disabled` | `.env.pre-deploy-20261125-050330` |
| `openwa/node_modules` | **tidak diubah** | — |
| `release-new/` | dihapus (941 MB) | — |
| `alim.abuhurairah.id` | tidak disentuh | — |

Artefak diunggah sebagai tarball 3,6 MB. Backend di-build lokal (`nest build`, 14 MB) dan dashboard
(`vite build`, 8,4 detik, 4,0 MB) — keduanya tidak pernah dijalankan di server.

### Rencana hapus `node_modules`: dibatalkan

`dist/main.js` **masih memerlukan `node_modules`** saat runtime; NestJS tidak di-bundle. Diuji
langsung: memindahkan `typescript` dan `puppeteer-core` keluar langsung membuat situs 503, lalu
dikembalikan dan situs pulih. `node_modules` (496 MB) tetap utuh. Penghematan ruang harus dicari di
tempat lain, bukan di sini.

## 5. Verifikasi endpoint

Rute yang ada tetapi menuntut autentikasi menjawab **401**; rute yang tidak ada menjawab **404**.
Pembanding ini yang membuktikan modul benar-benar terpasang, bukan sekadar tidak error.

| Endpoint | Status | Makna |
|---|---|---|
| `/` | 200 (`<title>ALIM Connect</title>`) | dashboard tersaji |
| `/login` | 200 | halaman login tersedia |
| `/assets/index-Cu_DkuAw.js` | 200 | bundle dashboard baru |
| `/favicon-32.png` | 200 | ikon rilis baru |
| `GET /api/approval/requests` | 401 | rute approval ada |
| `POST /api/approval/identities` | 401 | rute identitas ada |
| `GET /api/sso/handoff` | 200 | halaman handoff tersaji |
| `GET /api/sessions` | 401 | sesi ada |
| `GET /api/sessions/:id/inbox/conversations` | 401 | inbox ada |
| `GET /api/auth/api-keys` | 401 | API management ada |
| `GET /api/audit` | 401 | audit log ada |
| `GET /api/webhooks` | 401 | webhook ada |
| `GET /api/approval/does-not-exist` | 404 | pembanding: rute karangan |
| `https://alim.abuhurairah.id/` | 302 | Core utuh |

## 6. Mode integrasi saat ini

`ALIM_CONNECT_CORE_CLIENT=disabled`.

Mode ini tidak pernah memutuskan apa pun dan tidak pernah menghubungi Core. Rute ingest approval
menjawab 503. Dashboard, sesi WhatsApp, inbox, API key, webhook, dan audit log berjalan normal.

Untuk mengaktifkan integrasi nyata, tiga nilai dibutuhkan sekaligus:

```
ALIM_CONNECT_CORE_CLIENT=http
ALIM_CORE_BASE_URL=<alamat Core, HTTPS>
ALIM_CORE_APPROVAL_API_KEY=<kunci dari pemilik Core>
ALIM_CONNECT_SSO_KEY=<kunci dari pemilik Core>
```

Tanpa aktor yang terpetakan di sisi Core, `http` akan gagal pada permintaan pertama — bukan pada
boot. Jadi penggantian ini menunggu pekerjaan di sisi Core, bukan pekerjaan di Connect.

## 7. Yang belum selesai

- **Integrasi Core (BLOCKED).** Menunggu aktor terpetakan dan kunci dari pemilik Core.
- **`API_KEY_PEPPER` belum disetel.** Peringatan muncul setiap boot. Menyetelnya sekarang akan
  mengunci setiap API key yang ada sampai hash lama dipulihkan, jadi ini keputusan pemilik, bukan
  perbaikan rutin.
- **Cadangan `dist.old-*` masih di server** (41 MB). Aman dihapus setelah beberapa hari tanpa masalah;
  sengaja disimpan sebagai jalur mundur.
- **`node_modules` 496 MB** tetap ada karena diwajibkan runtime.

## 8. Jalur mundur

```
cd ~/domains/alim-wa.abuhurairah.id/openwa
mv dist dist.broken && mv dist.old-20261125-050128 dist
cd dashboard && mv dist dist.broken && mv dist.old-20261125-050132 dist
cd .. && cp .env.pre-deploy-20261125-050330 .env
touch tmp/restart.txt
```

Cadangan lengkap sebelum seluruh pekerjaan ini:
`~/backups/openwa-release-20261125-022747` (dist, dashboard/dist, .env, openwa.sqlite, main.sqlite).
