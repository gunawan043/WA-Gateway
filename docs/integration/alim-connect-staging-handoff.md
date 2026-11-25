# Serah-Terima Staging: ALIM Connect ⇄ ALIM Core

**Status:** menunggu Core dan operator hosting · **Diperbarui:** PDCA siklus 10 (2026-11-23)

Dokumen ini adalah satu-satunya daftar yang perlu dijawab Core/operator sebelum uji HTTP nyata dapat
dijalankan. Semua nilai rahasia **tidak** dikirim lewat dokumen ini, chat, atau commit — hanya lewat
secret manager (lihat §4).

---

## 1. Yang diminta dari Core (pemilik: Core)

| #   | Hal                                                                       | Bentuk nilai yang diterima                                                                     | Menghambat             |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | URL dasar staging, HTTPS, tanpa garis miring akhir                        | contoh bentuk: `https://<host staging>`                                                        | semua uji HTTP nyata   |
| 2   | Kunci layanan scope `sso:exchange`                                        | string rahasia                                                                                 | SSO                    |
| 3   | Origin browser Core staging (skema + host)                                | contoh bentuk: `https://<host staging>`                                                        | SSO                    |
| 4   | Kunci layanan scope `approval:command`                                    | string rahasia                                                                                 | Approval               |
| 5   | Nama header yang dibaca Core (SSO & approval)                             | default Core `X-ALIM-CONNECT-SSO-KEY` / `X-ALIM-CONNECT-APPROVAL-KEY`; konfirmasi bila berubah | hanya bila diubah      |
| 6   | Versi kontrak yang diterima                                               | `1` (default Connect `ALIM_CORE_API_VERSION`)                                                  | hanya bila berbeda     |
| 7   | Satu kode handoff **baru** per uji sukses SSO                             | kode sekali-pakai yang diterbitkan Core                                                        | jalur sukses SSO       |
| 8   | Satu permit staging **terbuka** + aktor Kepala Asrama sah & terverifikasi | UUID permit + `core_user_id` aktor                                                             | command approval nyata |
| 9   | Konfirmasi migration staging sudah dijalankan dan diverifikasi            | pernyataan + `git` ref Core yang terpasang                                                     | keandalan hasil        |

Catatan untuk #7 dan #8: keduanya **data uji** yang habis/berubah setiap pemakaian. Jangan memakai data
produksi.

### Pemetaan aktor — permintaan spesifik (dari `403 actor_identity_unmapped`)

Core sudah menjawab `403 actor_identity_unmapped`, yang berarti request sampai dan kredensial dikenali.
Yang Core belum kenali adalah **orang yang mengirim keputusan**. Connect mengirim:

| Field di `POST /api/connect/v1/approval-commands` | Nilai yang Connect kirim                                                                                       | Yang harus dilakukan Core                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `actor_external_id`                               | `request.targetIdentity` — digit E.164 tanpa `+`, hasil normalisasi nomor Kepala Asrama (mis. `6281234567890`) | Core harus punya pemetaan WhatsApp terverifikasi nomor ini → personel                     |
| `actor_core_person_id`                            | `request.targetCorePersonId` — UUID personel dari Core sendiri                                                 | Personel ini harus aktif dan berwenang sebagai Kepala Asrama untuk asrama permit tersebut |

Karena keduanya berasal dari Core, **Connect tidak bisa memperbaikinya sendiri**: nomor uji harus
dipetakan ke personel uji **di Core**. Yang dibutuhkan Connect dari pemilik Core:

1. Satu **nomor WhatsApp uji** yang sudah dipetakan dan diverifikasi di Core, dan `core_user_id`
   personel itu.
2. Pernyataan bahwa personel tersebut berwenang sebagai Kepala Asrama untuk permit uji (#8).
3. Konfirmasi bentuk `actor_external_id` yang Core harapkan (digit tanpa `+`, atau dengan awalan lain).
   Connect mengirim digit saja; bila Core mengharapkan bentuk lain, itu perubahan kontrak dan harus
   disepakati lebih dulu.

Begitu ketiganya ada, operator Connect mengisi `ALIM_CONNECT_STAGING_ACTOR_NUMBER` dan
`ALIM_CONNECT_STAGING_ACTOR_CORE_USER` pada saat menjalankan lane; tanpa keduanya bagian Approval
nyata **di-skip** dan lane tidak boleh dianggap lulus.

**Diperbarui siklus 12:** kedua variabel itu dibaca dari **environment proses saat menjalankan lane**,
bukan dari `data/.env.generated` maupun `.env` (yang perlu di-`export` lebih dulu). Menyimpannya di
konfigurasi tersimpan membuat bagian Approval nyata **skip** tanpa pesan apa pun. Bentuk nomor yang
diterima: digit E.164 tanpa `+` (8–15 digit); `0812…`, `+62 812…`, dan `62812…@s.whatsapp.net` juga
dinormalisasi Connect, tetapi bentuk angka-lah yang dikirim ke Core sebagai `actor_external_id`.

## 2. Yang disediakan operator Connect (pemilik: operator Connect)

| #   | Hal                                                                                     | Diserahkan ke                       | Cara                             |
| --- | --------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------- |
| A   | `ALIM_CONNECT_INGEST_KEY` (kunci yang dipakai Core untuk `POST /api/approval/requests`) | Core                                | secret manager Core              |
| B   | CIDR **egress** server Connect staging                                                  | Core, untuk `CONNECT_*_ALLOWED_IPS` | tiket/Slack privat, bukan commit |
| C   | Konfirmasi bahwa Connect staging memakai `ALIM_CONNECT_CORE_CLIENT=http`                | tim Connect                         | checklist deploy                 |

Butir B dibutuhkan **hanya bila** Core memasang allowlist IP keluar; Connect sendiri tidak punya
allowlist IP masuk (penggantinya: Origin allowlist + throttle untuk SSO, ingest key untuk approval).

### Status butir B dan A (diperbarui 2026-11-24)

| Butir                         | Status                                    | Bukti / alasan                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B — IP egress                 | **belum ada, dan sengaja tidak dikarang** | Pengujian sejauh ini berjalan dari mesin pengembang di belakang NAT; `os.networkInterfaces()` hanya melihat `192.168.x.x` privat, yang **bukan** IP egress publik dan tidak berguna sebagai CIDR allowlist. IP egress yang sah hanya bisa dibaca dari host Connect staging. Perintah untuk operator, dari host itu: `curl -s https://api.ipify.org` (atau `dig +short myip.opendns.com @resolver1.opendns.com`). Kirim CIDR-nya lewat tiket/Slack privat. |
| A — `ALIM_CONNECT_INGEST_KEY` | **belum diserahkan**                      | Kuncinya harus **dibuat** dulu (32+ byte acak, mis. `openssl rand -hex 32`), lalu dimasukkan ke secret manager **Core** dan ke environment Connect staging. Jangan pernah dikirim lewat chat, tiket, commit, atau dokumen ini. Core memakai nilai yang sama di header `X-ALIM-CONNECT-INGEST-KEY`; nilai berbeda = `401`, nilai kosong di Connect = `503`.                                                                                                |

Selama A belum ada, ingest dari Core berjalan 503 dan sebuah permit tidak bisa masuk lewat jalur
sungguhan; lane akan melaporkannya sebagai `degrades ALIM_CONNECT_INGEST_KEY`, bukan lulus.

## 3. Hal yang harus dikerjakan Core sebelum menyatakan "siap"

1. Migration staging dijalankan dan diverifikasi (butir 9).
2. Key `sso:exchange` dan `approval:command` diterbitkan dengan scope tepat, diteruskan lewat secret
   manager.
3. `CONNECT_SSO_HANDOFF_URL` di Core menunjuk rute handoff **Connect** (`https://<connect>/sso/handoff`),
   dan `CONNECT_SSO_FRAME_ORIGIN` berisi origin **Connect** — keduanya arah berlawanan dari
   `ALIM_CORE_WEB_ORIGIN` yang dipegang Connect.
4. Bila allowlist IP dipasang: CIDR egress Connect (butir B) sudah dimasukkan.

## 4. Mekanisme penyerahan rahasia

- Rahasia (butir 2, 4, A) hanya lewat **secret manager** organisasi (atau vault setara). Tidak lewat chat,
  tiket, commit, maupun dokumen ini.
- Connect membaca rahasia dari environment proses atau `.env` yang dimuat `load-env`; nilai kosong
  dianggap "tidak di-set" (`BLANK_SHADOWED_ENV_KEYS`).
- Bukti uji tidak pernah mencetak rahasia: guard mencetak nama yang hilang saja, dan suite memeriksa
  ketiadaan kunci/kode di stdout/stderr.

## 5. Yang akan berjalan begitu semua tersedia

```
npm run test:core-integration:lane      # gerbang: exit 0, kedua integrasi "ready"
npm run test:core-integration -- --approval
ALIM_CONNECT_SSO_TEST_CODE='<kode>' \
ALIM_CONNECT_SSO_EXPECTED_CORE_USER='<core_user_id>' \
npm run test:core-integration -- --sso-code='<kode>'
```

Bentuk `npm run test:core-integration -- --flag` memang yang dibaca skrip (`scripts/alim-core-integration-lane.ts:80-81`);
`:lane` hanya menambahkan penjaga. Kedua bentuk diteruskan argumennya lewat `--`, tanpa `--` npm akan
menganggap flag itu nama skrip.

**Diperbarui siklus 10:** jalur Approval dan SSO pada `scripts/alim-core-integration-lane.ts` atau
suite E2E-nya **belum** benar-benar dijalankan terhadap Core sungguhan (kredensialnya belum ada, lihat
`alim-connect-pdca-cycle-10.md` §6). Nama flag di atas dibaca ulang dari skrip pada siklus 10 tapi
belum terbukti di jaringan nyata.

Permintaan HTTP yang benar-benar keluar (untuk dikonfirmasi Core di log mereka) — semuanya diverifikasi
ulang terhadap kode pada siklus 10:

| Arah                     | Metode & path                                                                 | Header                                                                                                                               | Body ringkas                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect → Core           | `POST /api/connect/v1/sso/exchange`                                           | `<header SSO>: <key sso:exchange>`                                                                                                   | `code`, `audience`, `scope`, `state?`                                                                                                                                   |
| Connect → Core           | `POST /api/connect/v1/approval-commands`                                      | `<header approval>: <key approval:command>`, `Idempotency-Key: <command_id>`, `X-ALIM-API-Version: 1`                                | `command_id`, `request_id`, `decision`, `approved_duration_days`, `actor_external_id`, `actor_core_person_id`, `source`, `external_message_id`, `message_text`, `notes` |
| Core → Connect           | `POST /api/approval/requests`                                                 | `X-ALIM-CONNECT-INGEST-KEY: <ingest key>` (konstanta `APPROVAL_INGEST_HEADER` di `src/modules/approval/approval-ingest.guard.ts:14`) | data permit untuk diuji                                                                                                                                                 |
| Core → browser → Connect | `POST /sso/handoff` (rute Connect, `@Controller('sso')` + `@Post('handoff')`) | body form (bukan header)                                                                                                             | `code`, `state?`                                                                                                                                                        |

Keduanya diverifikasi terhadap `src/modules/sso/core-client/http-alim-core-sso.client.ts` dan
`src/modules/approval/core-client/http-alim-core-approval.client.ts` pada HEAD saat dokumen ini dibuat.
