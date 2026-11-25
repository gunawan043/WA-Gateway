# Permintaan ke Pemilik Deployment Core — Aktor Uji, Permit, dan Kode SSO

**Untuk:** pemilik/operator ALIM Core (bukan tim Connect)
**Dari:** operator ALIM Connect · **Tanggal:** 2026-11-25 · **Siklus:** 12
**Balasan ke dokumen ini cukup "butir N selesai" + bukti di kolom kanan.** Tidak ada rahasia di sini,
dan tidak ada rahasia yang boleh dikirim lewat chat/tiket biasa.

Latar singkat: Connect sudah mengirim approval command lewat HTTP nyata ke Core, kredensial diterima,
dan Core menjawab `403 actor_identity_unmapped`. Artinya **yang kurang hanya data uji di Core**, bukan
kredensial atau kode Connect. Tiga hal di bawah membuka semua uji yang tersisa.

---

## 1. Yang kami minta (ringkas)

| #   | Butir                                                                             | Batas waktu / jumlah                    | Bukti yang kami terima                                                                                    |
| --- | --------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A   | Nomor WhatsApp Kepala Asrama uji yang **sudah dipetakan & terverifikasi** di Core | 1 nomor, khusus staging                 | digit E.164 tanpa `+` (mis. `6281xxxxxxxxx`) — ini bukan rahasia, boleh lewat tiket                       |
| B   | `core_user_id` akun personel untuk nomor A                                        | 1 UUID                                  | UUID (`core_user_id`) + pernyataan "aktif & berwenang Kepala Asrama"                                      |
| C   | Kewenangan approval personel B                                                    | —                                       | pernyataan singkat: untuk asrama mana, dan bahwa ia boleh menyetujui/menolak izin di asrama itu           |
| D   | Satu permit **terbuka** untuk diuji                                               | 1 permit, sekali pakai                  | UUID permit (`request_id`) **atau** alur Core mengirim permit lewat `POST /api/approval/requests` Connect |
| E   | Satu kode handoff SSO **baru**                                                    | 1 kode, sekali pakai, berlaku ±10 menit | **lewat jalur rahasia yang disepakati saja** (lihat §4)                                                   |
| F   | Konfirmasi migration/schema                                                       | —                                       | pernyataan "migration staging sudah dijalankan" + ref `git` Core yang terpasang                           |

### 1.1 Hal yang perlu dipastikan untuk A–C

1. **Nomor A adalah nomor staging, bukan nomor siapa pun yang sungguhan bekerja.** Core boleh memakai
   nomor uji khusus atau nomor anggota tim yang setuju.
2. **Personel B aktif** dan **tidak** dalam status nonaktif/diblokir — Connect menolak akun Connect yang
   dinonaktifkan, dan Core menolak personel yang tidak aktif.
3. Personel B **berwenang sebagai Kepala Asrama untuk asrama permit D**. Kalau tidak, Core akan menolak
   dengan kode otorisasi yang berbeda — itu bukan kegagalan integrasi, tetapi uji harus diulang dengan
   permit/asrama yang cocok.
4. Bentuk `actor_external_id` yang dikirim Connect adalah **digit E.164 tanpa `+`**. Kalau Core mengharapkan
   bentuk lain (mis. dengan `+` atau `@s.whatsapp.net`), **itu perubahan kontrak** dan harus disepakati
   sebelum uji — mohon tulis di balasan.

### 1.2 Untuk D (permit)

Connect hanya bisa menerima permit melalui `POST /api/approval/requests` (dengan header
`X-ALIM-CONNECT-INGEST-KEY`). Dua cara, pilih yang mudah:

- **Cara 1 (disarankan):** Core mengirim permit uji ke Connect staging lewat endpoint itu, lalu kirimkan
  `core_request_id`/`request_id`-nya; Connect akan mencari permitnya sendiri.
- **Cara 2:** kirimkan UUID permit yang sudah dibuat, **plus** konfirmasi bahwa permit itu
  `request_id` yang sama dengan yang dikirim ke endpoint approval (Connect memakai `request_id`, bukan
  nomor lain).

Permit harus **terbuka** (`PENDING_APPROVAL` di Core) pada saat uji, dan **bukan** permit produksi.

### 1.3 Untuk E (kode SSO)

Kode diterbitkan Core saat pengguna menekan "masuk ke Connect" dari UI Core (atau lewat alur handoff
yang sama). Kode bersifat **sekali pakai** dan **berumur pendek**, jadi:

- terbitkan **saat kami siap menjalankan uji**, bukan sebelumnya;
- kirim lewat jalur rahasia (§4);
- sertakan `core_user_id` yang **diharapkan** — Connect akan membandingkan identitas yang dikembalikan
  Core dengan nilai itu, sehingga kalau Core salah mengembalikan akun, uji **gagal**, bukan lulus diam.

---

## 2. Apa yang akan kami lakukan setelah data ada

Tidak ada langkah baru bagi Core; perintahnya sudah ada di repo Connect:

```
set -a; . ./.env; set +a
export ALIM_CONNECT_STAGING_ACTOR_NUMBER=<A>
export ALIM_CONNECT_STAGING_ACTOR_CORE_USER=<B>
npm run test:core-integration:lane        # guard: kedua integrasi "ready"
npm run test:core-integration -- --approval
```

Uji akan:

1. Membalas notifikasi izin dari **nomor A** (`SETUJU 1 HARI <referensi permit>`).
2. Memastikan command benar-benar dikirim ke Core (bukan mock) dan Core menerimanya (`2xx`).
3. Mengirim **replay identik** (ID command sama) — Core harus menjawab `duplicate`, bukan keputusan kedua.
4. Mengirim command dengan ID sama tetapi isi berbeda — harus **ditolak**.
5. Mencatat `commandId`, `coreResponseCode`, status permit di Connect, dan status permit menurut Core —
   angka-angka ini yang akan kami minta Anda cocokkan dengan audit Core.

Untuk SSO: satu kode E dipakai sekali, lalu kami verifikasi sesi terbentuk, identitas sesuai `core_user_id`,
token tidak muncul di respons/log, dan kode yang sama ditolak pada pemakaian kedua.

**Kami tidak akan**: menyentuh permit produksi, mengubah repo Core, mengubah kontrak tanpa persetujuan,
atau "mengarang" hasil.

---

## 3. Kalau salah satu butir belum bisa

Katakan butir mana yang belum bisa dan **mengapa** — kami tidak butuh alasan detail, cukup statusnya.
Kami bisa jalan bertahap:

- **A+B+D saja** → approval nyata bisa dibuktikan (kriteria 1 & 2). SSO tetap tertunda.
- **E saja** → SSO sukses bisa dibuktikan (kriteria 3). Approval tetap tertunda.
- **F** → tanpa ini hasil tetap bisa dibaca, tetapi kami akan menandainya "belum dikonfirmasi".

---

## 4. Mekanisme pertukaran rahasia

- **Bukan rahasia, boleh lewat tiket/chat biasa:** nomor A (digit), `core_user_id` B, UUID permit D,
  ref `git` Core F.
- **Rahasia — hanya lewat jalur yang sudah disepakati:** kode SSO E, dan kunci layanan apa pun
  (`sso:exchange`, `approval:command`, `X-ALIM-CONNECT-INGEST-KEY`). Pakai secret manager organisasi
  atau kanal sekali-baca yang disepakati; **jangan** lewat dokumen ini, commit, atau pesan biasa.
- Kode E dan kunci **tidak akan kami cetak** di laporan: suite sudah memeriksa ketiadaan kode/kunci di
  stdout dan stderr.

---

## 5. Balasan yang kami butuhkan (isi apa adanya)

```
A. Nomor WhatsApp uji          : 6281_____________
B. core_user_id                : ________-____-____-____-____________
C. Kewenangan                  : Kepala Asrama <nama asrama>, boleh approve: ya / tidak
D. Permit uji                  : request_id ____________ (atau: sudah dikirim ke Connect, id = ____________)
E. Kode SSO                    : [dikirim lewat jalur rahasia; core_user_id yang diharapkan: ____________]
F. Migration staging           : sudah dijalankan (ya/tidak), ref git Core: ____________
   Bentuk actor_external_id    : digit tanpa "+" / bentuk lain: ____________
```
