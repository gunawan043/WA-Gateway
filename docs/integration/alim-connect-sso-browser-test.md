# Prosedur Browser Test — WhatsApp Connect SSO Handoff

**Tanggal:** 2026-11-23
**Status:** Chrome **lulus 12/12** (headless, Google Chrome 157.0.8103.80, lihat §6). Safari belum
dapat dijalankan (Remote Automation dimatikan di mesin ini) dan Firefox tidak terpasang; keduanya
dicatat sebagai blocker, bukan sebagai lulus.

Dokumen ini tidak mengklaim kompatibilitas browser telah terbukti di luar Chrome. Hasil setiap
browser diisi di §6, dan kegagalan dijelaskan, bukan dihapus.

Chrome dijalankan otomatis oleh `scripts/sso-browser-test.js` (puppeteer) terhadap harness
`scripts/sso-browser-harness.js`; langkah manual di §3 tetap berlaku untuk Safari/Firefox dan untuk
memeriksa hal-hal yang hanya terlihat dengan mata (mis. apakah spinner benar-benar sempat tampil).

---

## 1. Yang diuji

| #   | Skenario                                        | Kenapa tidak cukup dengan HTTP test      |
| --- | ----------------------------------------------- | ---------------------------------------- |
| 1   | iframe lintas origin memuat Connect             | `frame-ancestors` ditegakkan browser     |
| 2   | form POST lintas origin ke `/sso/handoff`       | Perilaku navigasi form, bukan `fetch`    |
| 3   | halaman loading terlihat selama exchange        | Dokumen lama dipertahankan saat navigasi |
| 4   | `sessionStorage` di dalam iframe pihak ketiga   | Kebijakan storage berbeda per browser    |
| 5   | redirect ke workspace di dalam iframe           | `location.replace('/')` di frame         |
| 6   | session bertahan setelah reload iframe          | `sessionStorage` per browsing context    |
| 7   | logout mengakhiri session dan menampilkan login | Alur SPA, bukan hanya 401                |
| 8   | session kedaluwarsa menampilkan login           | Alur SPA + `401`                         |
| 9   | origin yang tidak diizinkan tidak dapat embed   | Header CSP ditegakkan browser            |

---

## 2. Prasyarat

1. Dashboard dibangun: `npm run dashboard:build` (harness memuat workspace, bukan API saja).
2. Connect dijalankan dengan harness sebagai Core:

   ```bash
   ALIM_CORE_BASE_URL=http://localhost:4400 \
   ALIM_CORE_WEB_ORIGIN=http://localhost:4400 \
   ALIM_CONNECT_SSO_KEY=browser-test-key \
   AUTH_SESSION_IDLE_TIMEOUT_MINUTES=30 \
   npm run build:all && node dist/main
   ```

3. Buat akun Connect dan petakan ke `core-browser-test` (harness memakai id itu):

   ```bash
   # dengan API key ADMIN
   curl -sS -X POST http://localhost:2785/api/auth/users \
     -H "X-API-Key: $ADMIN_KEY" -H 'content-type: application/json' \
     -d '{"email":"browser-test@example.com","name":"Browser Test","password":"a-long-passphrase","assignments":[{"role":"agent","scopeType":"global"}],"coreUserId":"core-browser-test"}'
   ```

   Bila akun sudah ada: `PATCH /api/auth/users/:id` dengan `{"coreUserId":"core-browser-test"}`.

4. Jalankan harness: `node scripts/sso-browser-harness.js`
5. Buka `http://localhost:4400`.

> Catatan: `localhost:4400` dan `localhost:2785` adalah origin berbeda (port berbeda), jadi ini
> benar-benar iframe lintas origin. Jangan mengganti salah satunya menjadi `127.0.0.1` pada satu
> sisi saja — origin harus persis sama dengan `ALIM_CORE_WEB_ORIGIN`.

### 2.1 Menjalankan versi otomatis (Chrome)

`scripts/sso-browser-test.js` menjalankan skenario §3 di Chrome sungguhan dan mencetak lembar hasil
untuk §6. Prasyaratnya sama dengan di atas, ditambah:

```bash
AUTH_SESSION_IDLE_TIMEOUT_MINUTES=1   # skenario 9 menunggu idle timeout; 0 mematikannya
```

Lalu:

```bash
node scripts/sso-browser-test.js          # HEADLESS=false untuk melihat jendelanya
SKIP_EXPIRY=1 node scripts/sso-browser-test.js   # lewati skenario 9 (~65 s)
```

Skrip keluar dengan kode 1 bila ada skenario yang gagal, dan menyebut penyebabnya (mis. 429 dari
rate limit handoff, atau Connect/harness belum berjalan).

**Rate limit.** `/sso/handoff` membatasi 5 permintaan per menit per IP (kontrol keamanan, bukan
gangguan). Satu kali jalan penuh memakai 5 POST, jadi jalankan ulang setelah me-restart Connect —
limiter-nya in-memory — atau tunggu 60 detik. Skrip mendeteksi halaman 429 dan mengatakannya,
bukannya melaporkan "halaman kedaluwarsa tidak muncul".

**Hati-hati `data/.api-key`.** Boot pertama dengan `API_MASTER_KEY` menulis kunci itu ke
`data/.api-key` (relatif terhadap direktori kerja), bahkan ketika `MAIN_DATABASE_NAME` menunjuk
database sementara. Kalau file itu menyimpan kunci pengembangan Anda, salin dulu dan kembalikan
setelah pengujian — kunci lama tetap berlaku karena database pengembangan tidak disentuh.

---

## 3. Langkah per browser

Ulangi untuk **Chrome**, **Safari**, dan **Firefox** (versi terbaru; catat nomor versi).

### 3.1 Alur sukses

1. Buka `http://localhost:4400/?mode=valid`.
2. Amati iframe: halaman "Menghubungkan ke ALIM Connect…" tampil sebelum respons POST tiba.
3. Setelah exchange, halaman "Berhasil masuk" muncul sebentar lalu workspace Connect tampil di
   dalam iframe.
4. Di DevTools → Application/Storage → Session Storage → origin `localhost:2785`, pastikan ada
   `openwa_api_key` berawalan `owa_s1_` dan **tidak** ada cookie session.
5. Reload iframe (klik kanan → Reload Frame, atau reload halaman penuh). Workspace harus tetap
   tampil tanpa handoff baru.
6. Buka `http://localhost:2785/api/auth/me` di tab baru dengan header tidak mungkin dari browser;
   cukup pastikan UI menampilkan nama akun yang dipetakan.

**Lulus bila:** tidak ada error CSP di console, workspace tampil, session bertahan setelah reload,
dan tidak ada cookie `openwa_*` yang dibuat.

### 3.2 Logout

1. Dari workspace di iframe, klik Logout.
2. Halaman login Connect tampil.
3. Reload iframe: tetap di halaman login (session sudah dicabut, bukan hanya dihapus dari UI).

### 3.3 Handoff kedaluwarsa

1. Buka `http://localhost:4400/?mode=expired`.
2. Harus tampil halaman "Handoff kedaluwarsa" dengan tombol "Kembali ke ALIM Core".
3. Tidak ada session yang dibuat: buka `http://localhost:2785` di tab yang sama setelah menghapus
   `sessionStorage`; halaman login tampil.

### 3.4 Handoff sudah dipakai

1. Buka `http://localhost:4400/?mode=used`.
2. Harus tampil "Handoff sudah dipakai".

### 3.5 Akses langsung tanpa autentikasi

1. Buka `http://localhost:2785` di tab baru (bukan dari Core).
2. Halaman login tampil; workspace tidak dapat diakses.

### 3.6 Origin yang tidak diizinkan

1. Ubah sementara `ALIM_CORE_WEB_ORIGIN` ke origin lain (mis. `http://localhost:4401`) dan restart
   Connect, atau buka halaman harness dari port lain.
2. Iframe harus diblokir browser karena `frame-ancestors` tidak mencantumkan origin itu; console
   menampilkan pelanggaran CSP dan halaman Connect tidak dirender.
3. POST langsung dari origin itu harus dijawab `403` (`origin_not_allowed`).

### 3.7 Session kedaluwarsa

1. Set `AUTH_SESSION_IDLE_TIMEOUT_MINUTES=1` (atau `ALIM_CONNECT_SSO_SESSION_TTL_HOURS=1` lalu
   tunggu), login lewat handoff, diamkan melewati batas, lalu lakukan aksi di workspace.
2. Permintaan berikutnya dijawab `401` dan SPA kembali ke halaman login. Tidak ada session yang
   bangkit kembali setelah reload.

---

## 4. Yang harus dicatat

Untuk setiap browser, catat:

- Versi browser dan OS.
- Apakah halaman loading terlihat.
- Apakah `sessionStorage` dapat ditulis di iframe; bila tidak, apakah pesan blokir tampil.
- Apakah workspace tampil dan bertahan setelah reload.
- Apakah logout dan expiry mengembalikan ke halaman login.
- Pesan CSP di console (bila ada).
- Perilaku cookie: tidak ada `Set-Cookie` dari Connect.

---

## 5. Blocker yang sudah diketahui

1. **Belum ada Core/staging sungguhan.** Harness meniru Core, termasuk one-time semantics, tetapi
   bukan implementasi Core. Hasil browser test ini membuktikan perilaku browser terhadap Connect,
   bukan integrasi dengan Core.
2. **Safari: Remote Automation dimatikan.** Safari 26.6.2 terpasang, tetapi `safaridriver` menolak
   membuat sesi: _"You must enable 'Allow remote automation' in the Developer section of Safari
   Settings"_. Ini saklar GUI (atau `safaridriver --enable` dengan hak admin) yang tidak dapat
   dinyalakan tanpa persetujuan operator. Sampai itu dilakukan, Safari **belum diuji** — bukan lulus
   dan bukan gagal.
3. **Firefox tidak terpasang** di mesin ini (`/Applications/Firefox.app` tidak ada). Puppeteer juga
   hanya mengemudikan Firefox Nightly, bukan Firefox biasa. Firefox **belum diuji**.
4. **Safari dan storage pihak ketiga.** Safari membatasi storage di iframe pihak ketiga. Halaman
   sukses mendeteksi kegagalan `sessionStorage` dan menampilkan pesan, tetapi bila Safari memblokir
   storage, alur tidak dapat diselesaikan di iframe. Ini harus dicatat sebagai temuan, bukan
   dianggap lulus. Solusi yang mungkin (di luar siklus ini): membuka Connect di tab tingkat atas
   dengan mekanisme handoff yang tetap tanpa code di URL.
5. **Chrome third-party cookie phase-out tidak relevan untuk cookie** (Connect tidak memakai cookie),
   tetapi partitioning storage dapat memengaruhi `sessionStorage` di iframe. Chrome 157 lolos pada
   mesin ini; perilaku pada profil dengan kebijakan perusahaan dapat berbeda dan tidak diuji di sini.
6. **Dashboard dan API harus satu origin.** Harness mengasumsikan keduanya di `localhost:2785`.
7. **Tidak ada otomatisasi browser di CI.** `scripts/sso-browser-test.js` tidak dijalankan oleh
   `npm test` atau lane e2e; ia dijalankan manual karena membutuhkan Chrome dan dua origin.

---

## 6. Lembar hasil (isi setelah dijalankan)

Dijalankan **2026-11-23** dengan `node scripts/sso-browser-test.js` (headless) terhadap harness di
`localhost:4400` dan Connect di `localhost:2785`.

| Browser | Versi         | Loading | sessionStorage  | Workspace | Reload | Logout | Expired | CSP bersih | Catatan                                                                              |
| ------- | ------------- | ------- | --------------- | --------- | ------ | ------ | ------- | ---------- | ------------------------------------------------------------------------------------ |
| Chrome  | 157.0.8103.80 | ya      | ya (`owa_s1_…`) | ya        | ya     | ya     | ya      | ya         | 12/12 skenario; tidak ada cookie, tidak ada error console, token tidak pernah di URL |
| Safari  | 26.6.2        | —       | —               | —         | —      | —      | —       | —          | **belum diuji**: `safaridriver` menolak sesi karena _Allow remote automation_ mati   |
| Firefox | —             | —       | —               | —         | —      | —      | —       | —          | **belum diuji**: Firefox tidak terpasang; puppeteer hanya mendukung Firefox Nightly  |

Rincian Chrome (setiap baris adalah satu asersi skrip):

| #   | Skenario                                                                                                   | Hasil |
| --- | ---------------------------------------------------------------------------------------------------------- | ----- |
| 1   | Dokumen loading (`GET /sso/handoff`) merender spinner + "Menghubungkan ke ALIM Connect…"                   | lulus |
| 2   | Workspace tampil di dalam iframe setelah exchange (`frame` berakhir di `http://localhost:2785/`)           | lulus |
| 3   | Token `owa_s1_…` ada di `sessionStorage` frame; `document.cookie` kosong                                   | lulus |
| 4   | Token/code tidak pernah muncul di URL (top page maupun frame)                                              | lulus |
| 5   | Reload **iframe** mempertahankan workspace tanpa POST `/sso/handoff` baru (1 → 1)                          | lulus |
| 6   | Logout mengembalikan ke halaman login dan tetap login setelah reload (token dihapus)                       | lulus |
| 7   | Handoff kedaluwarsa menampilkan "Handoff kedaluwarsa", tanpa session                                       | lulus |
| 8   | Handoff yang sudah dipakai menampilkan "Handoff sudah dipakai"                                             | lulus |
| 9   | Akses langsung `http://localhost:2785/` menampilkan login, bukan workspace                                 | lulus |
| 10  | Origin asing (`localhost:4401`) diblokir `frame-ancestors`; POST langsung dijawab `403 origin_not_allowed` | lulus |
| 11  | Idle 65 s dengan `AUTH_SESSION_IDLE_TIMEOUT_MINUTES=1` → reload memaksa login, token dibersihkan           | lulus |
| 12  | Tidak ada `Set-Cookie` dari Connect, tidak ada error console, tidak ada respons ≥ 400                      | lulus |

**Kesimpulan:** Chrome lulus seluruh skenario. Safari dan Firefox **belum** terverifikasi; lihat §5
butir 2–3 untuk alasan dan cara membukanya. Kompatibilitas lintas browser tidak boleh dinyatakan
terbukti sampai kedua baris itu terisi.
