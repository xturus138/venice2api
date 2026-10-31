# venice-bridge

Agent coding lokal yang memakai **chat Venice di browser** sebagai otak. Semua
eksekusinya (baca file, patch, test, commit, rollback) terjadi di komputermu.

```
Venice web (otak, cuma teks) ⇄ extension Chrome (tangan, DOM saja) ⇄ daemon Node (otot, file + shell)
                                             WebSocket 127.0.0.1 + token
```

> **Peringatan.** ToS Venice 12(d) melarang akses otomatis ke situs web dan
> menyebut sanksi suspensi atau penghentian akun. Alat ini melanggar ketentuan
> itu, dan risiko akun sepenuhnya kamu tanggung. Alat ini tidak berusaha
> menyembunyikan diri: panelnya terlihat dan tidak ada penyamaran.

## Alur satu task

1. **Persiapan.** Daemon membuat branch `agent/<slug>-<id>`, lalu meng-commit kondisi awal sebagai checkpoint 0.
2. **Eksplorasi (read-only, maks 10 langkah).** Model memakai `fs_list`, `fs_read`, `grep_search`, dan `git_read`, lalu mengirim PLAN + NOTES.
3. **Gerbang.** PLAN tampil di terminal. Kamu approve, beri koreksi, atau berhenti.
4. **Eksekusi (maks 60 langkah).** `focus_set` (maks 4 file) → patch → `step_done`. Test dijalankan: hijau berarti di-commit sebagai checkpoint, merah dikirim balik ke model.
   - Error yang sama 3x membuat model wajib `fs_read` ulang sebelum patch berikutnya.
   - 3 kegagalan berbeda (atau 6 kali merah) membuat langkah itu BLOCKED: rollback ke checkpoint terakhir, lanjut ke langkah berikutnya.
5. **Review.** Diff total tampil, lengkap dengan peringatan kalau ada test yang dihapus, dilonggarkan, atau di-skip. Kamu approve, minta perbaikan, atau tolak (rollback ke checkpoint 0). Tidak pernah ada push.

Kalau proses mati atau di-Stop, jalankan `resume`. Perubahan setengah jalan di-rollback, lalu chat baru dibuka dengan ringkasan plan dan progres.

## Setup

Butuh Node 20+, git, dan Chrome atau Chromium.

```bash
npm install
node daemon.mjs token          # salin token ini
```

1. Buka `chrome://extensions`, aktifkan Developer mode, klik **Load unpacked**, lalu pilih folder `ext/`.
2. Buka **Options** extension, tempel token, lalu Simpan.
3. Buka tab Venice. Panel "Venice Bridge" akan muncul di kanan bawah.

### Kalibrasi selector (wajib sebelum pakai)

Selector default di `ext/selectors.js` masih **tebakan**, karena DOM Venice
tidak bisa diakses waktu kode ini ditulis. Di panel:

1. Pilih key, misalnya `assistantMessage`, lalu klik **Kalibrasi**.
2. Klik elemen yang sesuai di halaman, misalnya salah satu balasan model.
3. Pilih kandidat dari daftar. Angka di samping kandidat adalah jumlah elemen yang cocok. Untuk `assistantMessage`, pilih yang jumlahnya sama dengan jumlah balasan model (bukan pesanmu).
4. Klik **Tes selector** untuk memeriksa hasilnya.

| Key | Isinya |
|-|-|
| `input` | kotak tempat mengetik pesan |
| `sendButton` | tombol kirim (kalau tidak ada, Enter yang ditekan) |
| `stopButton` | tombol yang hanya muncul saat model masih menjawab |
| `assistantMessage` | satu elemen per balasan model |
| `excludeInMessage` | bagian balasan yang diabaikan, misalnya blok "thinking" |
| `newChatButton` | tombol chat baru (tanpa reload halaman) |
| `modelLabel` | label nama model aktif (klik = buka picker) |
| `modelOption` | entri di picker model |

Kalau UI Venice berubah, cukup kalibrasi ulang. Semua selector juga bisa
diedit sebagai JSON di halaman Options.

## Pemakaian

```bash
export BRIDGE_ROOT=~/proyek-salinan     # SALINAN proyek, bukan aslinya
export BRIDGE_TEST_CMD="npm test"
node daemon.mjs run "tambahkan validasi email di form signup"
```

| Perintah | Fungsi |
|-|-|
| `run "<task>"` | mulai task baru |
| `resume` | lanjutkan task yang terputus |
| `status` | tampilkan `workspace/state.json` |
| `abandon` | buang pekerjaan yang belum selesai, kembali ke branch awal |
| `token` | tampilkan token extension |
| `catalog` | cetak katalog tool (opsional, untuk Custom Instructions) |

| Variabel | Default | Keterangan |
|-|-|-|
| `BRIDGE_ROOT` | — | folder proyek, wajib |
| `BRIDGE_TEST_CMD` | kosong | tanpa test, perubahan tidak terverifikasi |
| `BRIDGE_AUTONOMY` | `L1` | L1 = konfirmasi tiap patch dan shell; L2 = otomatis, tanya hanya untuk perintah di luar allowlist; L3 = otomatis penuh, perintah di luar allowlist ditolak |
| `BRIDGE_MODEL` | `deepseek` | regex label model; dicek sebelum tiap kirim; kosongkan untuk menonaktifkan |
| `BRIDGE_MAX_EXPLORE` / `BRIDGE_MAX_STEPS` | 10 / 60 | batas langkah |
| `BRIDGE_STEP_DELAY_MS` | 1500 | jeda antar giliran supaya UI siap |
| `BRIDGE_PORT` | 8765 | port WebSocket |
| `BRIDGE_EXT_ORIGIN` | — | kunci ke satu extension: `chrome-extension://<id>` |
| `BRIDGE_WORKSPACE` | `./workspace` | lokasi state, log, PLAN, NOTES, dan .bak |

Selama loop berjalan, jangan mengetik di tab Venice yang sama. Tombol
**Stop** di panel atau Ctrl+C di terminal menghentikan runner, dan state
tetap tersimpan.

## Format yang dipakai model

Model menjawab dengan **satu aksi per balasan** di dalam code block:

````
```tool
{"tool": "fs_read", "args": {"path": "src/app.js", "start": 1, "end": 120}}
```
````

```
PATCH src/app.js
<<<<<<< SEARCH
minimal 3 baris yang disalin persis
=======
pengganti
>>>>>>> REPLACE
```

`WRITE <path>` untuk file baru, `PLAN` / `NOTES` untuk rencana. Katalog
lengkapnya ikut terkirim di pesan pertama setiap chat (`node daemon.mjs catalog`).

Aturan patch:
- SEARCH harus cocok tepat satu kali. Hanya perbedaan spasi di akhir baris yang ditoleransi.
- SEARCH minimal 3 baris. Nomor baris yang ikut tersalin dibuang otomatis.
- Path harus ada di `focus.json`.
- `WRITE` hanya untuk file yang belum ada.

## Keamanan

- Semua path dikurung di dalam `BRIDGE_ROOT`. Symlink keluar ditolak, dan `.git/` tidak bisa disentuh.
- File rahasia (`.env*`, `*.pem`, `id_rsa`, `credentials.json`, dan sejenisnya) **tidak pernah dibaca**, supaya isinya tidak terkirim ke Venice.
- `shell_safe` berjalan tanpa shell (`execFile`), dan variabel lingkungan yang mirip token atau password dibuang. `git` hanya untuk subcommand baca, dan `find -exec/-delete` ditolak.
- **Batasan penting:** `npm`, `npx`, `node`, `pytest`, `cargo`, dan `go` ada di allowlist, padahal semuanya bisa menjalankan kode apa saja dari proyek. Begitu juga perintah test. Ditambah risiko prompt injection dari isi file, artinya allowlist **bukan sandbox**. Untuk L2/L3, jalankan daemon di container atau VM.
- WebSocket hanya bind ke 127.0.0.1, wajib token, dan Origin harus berasal dari extension.
- File di luar git disalin ke `workspace/bak/` sebelum ditimpa.
- Setiap aksi dicatat di `workspace/log.jsonl`.

## Pemulihan manual

```bash
git reset --hard <checkpoint>   # sha ada di workspace/state.json
git switch main && git branch -D agent/<slug>-<id>
rm workspace/state.json
```

Atau cukup `node daemon.mjs abandon`.

## Test

```bash
npm test
```

Yang dicakup test: patch, parser balasan (termasuk teks dari markdown yang
sudah dirender), kurungan path dan allowlist shell, runner end-to-end dengan
otak palsu (plan, merah lalu hijau, BLOCKED + rollback, stop + resume,
peringatan test dilonggarkan), keamanan WebSocket, dan driver DOM di Chromium
memakai halaman chat tiruan (`test/fixtures/fake-chat.html`).

**Belum teruji:** halaman Venice yang asli. Selector dan deteksi akhir
balasan perlu dicoba dan dikalibrasi di akunmu.
