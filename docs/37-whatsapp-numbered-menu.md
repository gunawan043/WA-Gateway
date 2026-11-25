# Panduan Menu WhatsApp Bernomor — SD IT Putra

Panduan ini menyiapkan menu interaktif untuk nomor WhatsApp sekolah memakai fitur
**Autoreply Rule** bawaan ALIM Connect. Tidak ada kode baru, tidak ada plugin, dan tidak ada
migrasi basis data: kelima aturan di bawah dibuat lewat API yang sudah berjalan dan bisa diubah
kapan saja tanpa men-deploy ulang.

Menu yang dihasilkan:

```
Assalamu'alaikum, selamat datang di SD IT Putra 🌿

Silakan balas dengan nomor:
1. Profil sekolah
2. Pendaftaran siswa baru
3. Biaya pendidikan
4. Hubungi admin
```

## 1. Cara kerjanya, dan batasnya

Autoreply Rule mengevaluasi setiap pesan masuk terhadap aturan milik satu sesi. **Aturan pertama
yang cocok menjawab**, lalu aturan itu diam di chat tersebut selama `cooldownSeconds`. Tidak ada
aturan kedua yang ikut menjawab pesan yang sama.

Yang perlu dipahami sebelum memakai menu nomor:

| Perilaku                                               | Konsekuensi                                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aturan dicocokkan per pesan, bukan per sesi percakapan | Tidak ada state "sedang di menu mana". Balasan `2` kapan pun tetap menjawab menu 2                                                                      |
| Tidak ada state berarti tidak ada kedaluwarsa          | Orang yang kembali sebulan kemudian tetap mendapat menu yang sama — untuk sekolah ini justru diinginkan                                                 |
| `equals` hanya cocok bila seluruh isi pesan sama       | Pengguna yang menulis "saya mau nomor 2" **tidak** cocok. Itu disengaja: `contains` untuk satu digit akan menangkap banyak pesan yang tidak dimaksudkan |
| Balasan selalu memuat menu lengkap lagi                | Setiap balasan diakhiri daftar menu, sehingga pengguna selalu punya konteks berikutnya                                                                  |

> **Menu tombol/list native WhatsApp belum tersedia.** Kontrak engine
> (`src/engine/interfaces/whatsapp-engine.interface.ts`, `MessagingCapability`) mendukung teks,
> media, lokasi, kontak, stiker, dan poll — tetapi tidak ada `sendButtons`/`sendList`. Engine
> whatsapp-web.js tidak punya jalur kirim tombol sama sekali, dan Baileys hanya bisa _membalas_
> prompt tombol yang sudah ada. Menu bernomor adalah bentuk yang berjalan di kedua engine hari ini.

## 2. Prasyarat

Tiga hal, dalam urutan ini:

1. **Sesi WhatsApp sudah tersambung** dan Anda tahu `sessionId`-nya (lihat `GET /api/sessions`).
2. **API key ber-role `operator` atau lebih tinggi.** `POST /api/sessions/:sessionId/automation-rules`
   memakai `@RequireRole(ApiKeyRole.OPERATOR)`. Role `viewer` akan ditolak `403`.
3. **Nomor pengirim tidak dicocokkan ke diri sendiri.** Pesan yang dikirim akun itu sendiri
   (`fromMe`) tidak pernah dievaluasi, jadi tidak ada risiko membalas diri sendiri.

## 3. Aturan yang dipasang

Urutan pembuatan menentukan prioritas, karena aturan pertama yang cocok menang. Buat **menu 1–4
lebih dulu**, lalu **sambutan paling akhir**, supaya sambutan (yang kondisinya paling longgar)
tidak pernah mendahului pilihan menu.

| #   | Nama aturan               | Kondisi                               | Cooldown  |
| --- | ------------------------- | ------------------------------------- | --------- |
| 1   | Menu 1 — Profil sekolah   | `body` `equals` `1`                   | 5 detik   |
| 2   | Menu 2 — Pendaftaran      | `body` `equals` `2`                   | 5 detik   |
| 3   | Menu 3 — Biaya pendidikan | `body` `equals` `3`                   | 5 detik   |
| 4   | Menu 4 — Hubungi admin    | `body` `equals` `4`                   | 5 detik   |
| 5   | Sambutan + menu utama     | `body` `contains` `halo` **atau** `p` | 300 detik |

`caseSensitive` sengaja dibiarkan `false` (default) pada semua aturan, supaya pengguna yang
menulis `HALO` atau `Halo` tetap dilayani.

Sambutan memakai `contains` dan bukan "tanpa kondisi", karena aturan tanpa kondisi menjawab
**setiap** pesan — termasuk ucapan terima kasih setelah menu selesai. `contains` pada kata
sambutan yang wajar membuatnya menjawab pembuka percakapan saja.

## 4. Perintah pemasangan

Ganti `$BASE`, `$KEY`, dan `$SID` lebih dulu. Tidak ada rahasia di berkas ini — perintahnya
membaca dari variabel lingkungan shell Anda.

```bash
BASE=https://alim-wa.abuhurairah.id
SID=<sessionId>
KEY=<API key ber-role operator>     # jangan disimpan di riwayat shell bersama

create() {  # $1 nama, $2 body JSON
  curl -sS -X POST "$BASE/api/sessions/$SID/automation-rules" \
    -H "X-API-Key: $KEY" -H 'content-type: application/json' \
    --data "$2" -w '\n%{http_code}\n'
}
```

### Menu 1 — Profil sekolah

```bash
create "Menu 1 — Profil sekolah" '{
  "name": "Menu 1 — Profil sekolah",
  "cooldownSeconds": 5,
  "conditions": { "conditions": [ { "field": "body", "operator": "equals", "value": "1" } ] },
  "replyText": "SD IT Putra\n\nAlamat   : <alamat lengkap>\nJenjang  : SD (kelas 1-6)\nAkreditasi: <akreditasi>\nJam belajar: Senin-Jumat, <jam>\n\nKetik 0 untuk kembali ke menu utama."
}'
```

### Menu 2 — Pendaftaran siswa baru

```bash
create "Menu 2 — Pendaftaran" '{
  "name": "Menu 2 — Pendaftaran",
  "cooldownSeconds": 5,
  "conditions": { "conditions": [ { "field": "body", "operator": "equals", "value": "2" } ] },
  "replyText": "Pendaftaran siswa baru SD IT Putra\n\nSyarat:\n1. Fotokopi akta kelahiran\n2. Fotokopi kartu keluarga\n3. Pas foto 3x4 (2 lembar)\n4. Mengisi formulir pendaftaran\n\nGelombang dan kuota: <isi>\n\nKetik 0 untuk kembali ke menu utama."
}'
```

### Menu 3 — Biaya pendidikan

```bash
create "Menu 3 — Biaya pendidikan" '{
  "name": "Menu 3 — Biaya pendidikan",
  "cooldownSeconds": 5,
  "conditions": { "conditions": [ { "field": "body", "operator": "equals", "value": "3" } ] },
  "replyText": "Biaya pendidikan SD IT Putra\n\nUang pangkal : Rp <isi>\nSPP per bulan: Rp <isi>\nSeragam     : Rp <isi>\n\nRincian lengkap diberikan saat pendaftaran.\n\nKetik 0 untuk kembali ke menu utama."
}'
```

### Menu 4 — Hubungi admin

```bash
create "Menu 4 — Hubungi admin" '{
  "name": "Menu 4 — Hubungi admin",
  "cooldownSeconds": 5,
  "conditions": { "conditions": [ { "field": "body", "operator": "equals", "value": "4" } ] },
  "replyText": "Menghubungkan Anda ke admin.\n\nJam layanan: Senin-Jumat, <jam>\nWhatsApp: <nomor admin>\nEmail: <email>\n\nPesan Anda sudah kami terima dan akan dijawab pada jam layanan.\n\nKetik 0 untuk kembali ke menu utama."
}'
```

### Sambutan + menu utama

Dibuat terakhir supaya tidak pernah menang atas pilihan menu.

```bash
create "Sambutan + menu utama" '{
  "name": "Sambutan + menu utama",
  "cooldownSeconds": 300,
  "conditions": { "conditions": [ { "field": "body", "operator": "contains", "value": "halo" } ] },
  "replyText": "Assalamu'\''alaikum, selamat datang di SD IT Putra 🌿\n\nSilakan balas dengan nomor:\n1. Profil sekolah\n2. Pendaftaran siswa baru\n3. Biaya pendidikan\n4. Hubungi admin\n\nKetik 0 untuk menampilkan menu ini lagi."
}'
```

### Aturan tambahan: ketik `0`

Karena sambutan hanya menjawab "halo", ketik `0` perlu aturannya sendiri agar menu bisa
dipanggil kapan saja:

```bash
create "Menu 0 — Menu utama" '{
  "name": "Menu 0 — Menu utama",
  "cooldownSeconds": 5,
  "conditions": { "conditions": [ { "field": "body", "operator": "equals", "value": "0" } ] },
  "replyText": "Menu utama SD IT Putra 🌿\n\n1. Profil sekolah\n2. Pendaftaran siswa baru\n3. Biaya pendidikan\n4. Hubungi admin\n\nSilakan balas dengan nomor."
}'
```

## 5. Memeriksa hasilnya

Daftar aturan satu sesi, urut waktu dibuat — urutan yang sama dengan urutan pencocokan:

```bash
curl -sS "$BASE/api/sessions/$SID/automation-rules" -H "X-API-Key: $KEY"
```

Yang harus terlihat: **menu 0 dan 1–4 di atas, sambutan di bawah**. Bila sambutan tercatat lebih
dulu, hapus dan buat ulang — aturan dicocokkan menurut `createdAt`, bukan nama.

Uji dari nomor lain, bukan dari nomor sesi itu sendiri:

| Kirim              | Harapan                                  |
| ------------------ | ---------------------------------------- |
| `halo`             | Sambutan + menu                          |
| `1`                | Profil sekolah                           |
| `HALO`             | Sambutan + menu (tidak peka huruf besar) |
| `saya mau nomor 2` | Tidak dijawab menu — disengaja           |
| `0`                | Menu utama                               |

## 6. Mengubah dan menghapus

Balas `replyText` tanpa men-deploy apa pun:

```bash
curl -sS -X PATCH "$BASE/api/sessions/$SID/automation-rules/<ruleId>" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  --data '{"replyText":"Teks baru..."}'
```

Menonaktifkan sementara tanpa menghapus:

```bash
curl -sS -X PATCH "$BASE/api/sessions/$SID/automation-rules/<ruleId>" \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' --data '{"enabled":false}'
```

## 7. Kapan harus naik ke plugin

Menu bernomor ini tidak menyimpan state. Naik ke plugin (`docs/19-plugin-architecture.md`, hook
`message:received`) hanya bila Anda butuh salah satu dari ini:

- **State percakapan** — mis. "pilih 2 lalu pilih a/b/c" bertingkat.
- **Data dinamis** — daftar sekolah atau sisa kuota dibaca dari basis data, bukan teks tetap.
- **Penerusan otomatis ke admin** — mis. pesan ke-3 dalam satu percakapan langsung diteruskan.

Selama tiga hal itu belum dibutuhkan, aturan di atas lebih ringan, lebih mudah diubah, dan tidak
menambah kode yang harus dirawat.
