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

Butuh Node 20+, git, dan Chrome/Chromium **versi 116 atau lebih baru** (di bawah itu service worker extension mati di tengah job).

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
| `blockerSelector` | elemen CAPTCHA/verifikasi (iframe Cloudflare/captcha juga dideteksi otomatis) |
| `limitSelector` | modal batas penggunaan atau ajakan upgrade |

Kalau UI Venice berubah, cukup kalibrasi ulang. Semua selector juga bisa
diedit sebagai JSON di halaman Options.

## Input

Ada dua jalur mengisi kotak pesan dan menekan kirim:

- **Sintetis (default).** Event buatan JavaScript (`execCommand`, event `paste`,
  dll). Tidak butuh izin tambahan, tapi editor rich text (ProseMirror/Lexical)
  kadang menolaknya, dan `element.click()` bisa tertelan oleh app yang mengikat
  ke `pointerdown`. Isi kotak selalu diverifikasi; kalau gagal, ada pesan error.
- **Tepercaya (opsional, lewat `debugger`).** Saat "Input tepercaya" dinyalakan
  di Options, extension memakai CDP (`chrome.debugger`) untuk mengirim event
  keyboard/mouse **asli** — mengetik per karakter dan mengklik di koordinat
  tombol. Lebih andal karena halaman menerimanya seperti input manusia
  (`isTrusted` true, rangkaian pointer/mouse lengkap). Teks panjang (>2000
  karakter) diketik sampai ambang lalu sisanya di-`insertText` sekaligus.

Jalur tepercaya adalah yang utama saat dinyalakan; jalur sintetis tetap jadi
cadangan. Kalau `debugger` gagal attach — paling sering karena **DevTools
sedang terbuka** di tab itu ("Another debugger is already attached") — job
tidak batal: extension turun ke jalur sintetis dan mencatatnya di panel.

Batasan jalur tepercaya:
- Butuh izin `debugger`. Extension hanya attach ke tab Venice yang sedang
  dikunci, hanya saat ada job berjalan, dan **selalu detach** saat job selesai,
  Stop, tab ditutup, atau idle >30 detik. Debugger tidak pernah ditinggal
  terpasang.
- Muncul bar "Chrome is being controlled by automated software". Karena itu
  defaultnya mati: nyalakan setelah selesai mengkalibrasi selector.
- DevTools tidak bisa dibuka bersamaan di tab yang sama selagi aktif.

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
| `abandon [--delete-branch]` | buang pekerjaan yang belum selesai, kembali ke branch awal (opsional hapus branch agent) |
| `token` | tampilkan token extension |
| `catalog` | cetak katalog tool (opsional, untuk Custom Instructions) |

| Variabel | Default | Keterangan |
|-|-|-|
| `BRIDGE_ROOT` | — | folder proyek, wajib |
| `BRIDGE_TEST_CMD` | kosong | tanpa test, perubahan tidak terverifikasi |
| `BRIDGE_AUTONOMY` | `L1` | L1 = konfirmasi tiap patch dan shell; L2 = otomatis, tanya hanya untuk perintah di luar allowlist; L3 = otomatis penuh, perintah di luar allowlist ditolak (dengan `BRIDGE_SHELL=full`, L3 menjalankan perintah shell sendiri dan hanya bertanya untuk yang ditandai berisiko) |
| `BRIDGE_MODEL` | `deepseek` | regex label model; dicek sebelum tiap kirim; kosongkan untuk menonaktifkan |
| `BRIDGE_SHELL` | mati | `full` menyalakan tool `bash`, `powershell`, dan `cmd` (lihat "Shell penuh"). Bukan sandbox |
| `BRIDGE_SHELL_KEEP_ENV` | kosong | nama env var rahasia yang tetap diteruskan ke shell penuh, pisah koma (mis. `MY_API_KEY` untuk `curl`) |
| `BRIDGE_SHELL_MAX_TIMEOUT_S` | 600 | batas atas `timeout_s` yang boleh diminta model per perintah |
| `BRIDGE_ENV_KEYS` | mati | `1` untuk mengizinkan `fs_read` file `.env` dengan nilai dimasking (`KEY=***`). Nilai disembunyikan, tetapi **nama kunci tetap terkirim** ke Venice (mis. `STRIPE_LIVE_SECRET_KEY`); nyalakan hanya jika nama variabelmu tidak sensitif. Tidak pernah berlaku untuk file kunci/sertifikat |
| `BRIDGE_MAX_EXPLORE` / `BRIDGE_MAX_STEPS` | 10 / 60 | batas langkah |
| `BRIDGE_STEP_DELAY_MS` | 1500 | jeda antar giliran supaya UI siap |
| `BRIDGE_DELAY_JITTER` | 0.35 | mengacak jeda antar giliran dalam ±fraksi ini (clamp 0..0.9; `0` = tanpa acak). Jeda poll di dalam extension juga diacak ±0.25, minimal 100ms |
| `BRIDGE_PORT` | 8765 | port WebSocket |
| `BRIDGE_EXT_ORIGIN` | — | kunci ke satu extension: `chrome-extension://<id>` |
| `BRIDGE_WORKSPACE` | `./workspace` | lokasi state, log, PLAN, NOTES, dan .bak |

Setelan input tepercaya diatur di **Options extension** (bukan env var, karena
jalurnya di dalam browser):

| Setelan Options | Default | Keterangan |
|-|-|-|
| `BRIDGE_TRUSTED_INPUT` (checkbox "Input tepercaya") | mati | pakai event asli via `debugger`. Lebih andal pada editor rich text. Mati = perilaku lama (event sintetis) |
| `BRIDGE_TYPE_DELAY_MS` (Jeda antar ketik) | 35 | jeda antar penekanan tombol pada jalur tepercaya |
| `BRIDGE_TYPE_JITTER` (Jitter ketik) | 0.5 | mengacak jeda ketik ±fraksi ini (clamp 0..0.9), minimal 8ms |

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

## Shell penuh (opsional)

Secara default model hanya punya `shell_safe`: daftar kecil program (git, npm,
ls, grep, ...) dengan argumen yang diperiksa. Dengan `BRIDGE_SHELL=full`, model
juga mendapat shell sungguhan, seperti CLI biasa:

```bash
export BRIDGE_SHELL=full
export BRIDGE_AUTONOMY=L1        # tetap L1 sampai kamu nyaman
node daemon.mjs run "cek apakah API staging hidup lalu perbaiki timeout-nya"
```

| Tool | Dipakai untuk |
|-|-|
| `bash` | Linux, macOS, Git Bash di Windows |
| `powershell` | `pwsh` (semua OS) atau Windows PowerShell |
| `cmd` | `cmd.exe` (hanya Windows) |

Yang tersedia dideteksi otomatis saat mulai; hanya yang ditemukan yang
ditawarkan ke model. Di Windows, `bash` yang ada di PATH bisa jadi WSL: di sana
sistem berkas yang terlihat berbeda dari Windows, jadi lebih aman pakai Git Bash.

Cara kerjanya:
- Tiap panggilan adalah proses baru di folder proyek. `cd` dan variabel tidak
  terbawa ke panggilan berikutnya. Argumen opsional `timeout_s` (dibatasi
  `BRIDGE_SHELL_MAX_TIMEOUT_S`).
- **Konfirmasi:** L1 dan L2 bertanya sebelum setiap perintah. L3 menjalankan
  sendiri, kecuali perintah yang ditandai berisiko (menghapus rekursif, `sudo`,
  `git push`/`reset --hard`, `curl | sh`, mengirim data keluar lewat `curl -d`/`-F`,
  `scp`/`rsync`/`nc`, operasi disk, dan menyentuh file yang tampak rahasia seperti
  `.env` atau `id_rsa`). L3 + shell penuh juga minta persetujuan sekali di awal.
- **Env var rahasia dibuang** dari proses anak (nama mengandung TOKEN, SECRET,
  PASSWORD, API_KEY, dst). Kalau `curl` memang butuh satu, daftarkan namanya di
  `BRIDGE_SHELL_KEEP_ENV`.
- **Output disamarkan** sebelum dikirim ke Venice: private key, token GitHub/AWS,
  `sk-...`, JWT, `Bearer ...`, dan nilai `NAMA_RAHASIA=...`. Ini upaya terbaik,
  bukan jaminan.
- **Git dijaga:** perintah shell tidak boleh memindahkan state yang dipakai
  checkpoint. Commit liar dibatalkan (perubahannya tetap di working tree), pindah
  branch dikembalikan, `git stash` di-pop. Kalau riwayat dimundurkan, run halt;
  `resume` rollback ke checkpoint terakhir.
- **Stop / Ctrl+C** mematikan seluruh pohon proses perintah yang sedang jalan.
  Proses latar belakang yang dimulai model dimatikan saat run berakhir atau di-pause.
- Tidak tersedia saat eksplorasi (fase itu tetap read-only).
- stdin perintah ditutup, jadi program yang menunggu input interaktif akan gagal
  alih-alih menggantung. `git` tidak akan meminta password.

**Batasan jujur.** Ini bukan sandbox. Perintah berjalan dengan hak aksesmu dan
bisa membaca atau menulis apa saja yang bisa kamu akses, termasuk di luar
`BRIDGE_ROOT`. Kurungan path, daftar file rahasia, dan `focus.json` **tidak
berlaku** di dalam shell. Penanda "berisiko" hanyalah rem sebelum bahaya, bukan
batas: perintah yang sengaja dikaburkan bisa lolos. Apa pun yang dicetak
perintah akan terkirim ke Venice. Karena itu: mulai dari L1, baca setiap
perintah sebelum menjawab `y`, dan untuk L2/L3 jalankan daemon di container atau
VM yang hanya berisi salinan proyek.

## Keamanan

- Semua path dikurung di dalam `BRIDGE_ROOT`. Symlink keluar ditolak, dan `.git/` tidak bisa disentuh.
- File rahasia (`.env*`, `*.pem`, `*.key`, `id_rsa`, `credentials.json`, `secrets.*`, dan sejenisnya) ditolak oleh semua jalur baca: `fs_read`, `grep_search`, `git_read`, dan `shell_safe`. Pemeriksa `shell_safe` sadar-flag, jadi `grep -r SECRET .env`, `rg SECRET /`, `cp -t /tmp ...`, `git show HEAD:.env`, dan `git diff --no-index /etc/...` semuanya ditolak. Diff dan grep lewat git juga memakai pathspec exclude untuk file rahasia.
- `shell_safe` berjalan tanpa shell (`execFile`), dan variabel lingkungan yang mirip token atau password dibuang. `git` hanya untuk subcommand baca.
- **Shell penuh (`BRIDGE_SHELL=full`)** menonaktifkan semua jaminan path di atas untuk perintah yang dijalankannya; baca bagian "Shell penuh".
- **Batasan penting (bukan sandbox):** `npm`, `npx`, `node`, `pytest`, `cargo`, dan `go` ada di allowlist, padahal semuanya bisa menjalankan kode apa saja dari proyek. Begitu juga `BRIDGE_TEST_CMD`, yang berjalan dengan `cwd` di root tetapi **tanpa isolasi** — test bisa menulis ke luar root. Kurungan path dan denylist rahasia hanya mengatur argumen perintah; mereka **tidak** menahan kode yang dijalankan perintah itu. Contoh nyata: `node -e "require('fs').readFileSync('/etc/passwd')"` atau skrip test yang membaca `.env` tetap bisa membaca file apa pun milik user dan mengirim hasilnya balik ke Venice. Ditambah risiko prompt injection dari isi file, kurungan path saja tidak cukup. **Untuk L2/L3, jalankan daemon di container atau VM** dengan hanya salinan proyek di dalamnya.
- WebSocket hanya bind ke 127.0.0.1, Origin harus berasal dari extension, dan token dikirim lewat subprotocol (bukan query string URL, supaya tidak muncul di log). Hanya satu tab Venice yang boleh terhubung; tab kedua ditolak.
- File di luar git disalin ke `workspace/bak/` sebelum ditimpa.
- Output tool dibungkus penanda acak per pesan dan ditandai sebagai data, bukan instruksi.
- Izin `debugger` (untuk input tepercaya) hanya dipakai pada tab Venice yang dikunci: mengirim event keyboard/mouse (`Input.dispatchKeyEvent`, `Input.dispatchMouseEvent`, `Input.insertText`) ke tab itu. Tidak membaca DOM, jaringan, atau tab lain, dan selalu detach di akhir job. Default mati.
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
sudah dirender), kurungan path dan pemeriksa shell sadar-flag (termasuk upaya
bocor rahasia dan keluar root), penolakan `git show HEAD:.env` / `--no-index`,
runner end-to-end dengan otak palsu (plan, merah lalu hijau, BLOCKED + rollback,
stop + resume, wajib `fs_read` ulang, nomor langkah dipalsukan, peringatan test
dilonggarkan, halt + resume karena penghalang), auth WebSocket lewat subprotocol,
dua kondisi hang (cancel sebelum tersambung, tab ditutup saat menunggu), jitter
(deterministik saat 0, dalam rentang, clamp), shell penuh (konfirmasi per level, penanda berisiko, penyamaran output, env dibuang, timeout membunuh anak proses, penjaga git, Stop), builder plan CDP dan `CdpSession`
dengan debugger tiruan (attach gagal → fallback, error di tengah → lapor sejauh
mana, detach idempoten, watchdog, external detach), dan driver DOM di Chromium
termasuk deteksi penghalang (CAPTCHA/logout di tengah balasan, kedipan sesaat
diabaikan), jalur input tepercaya, dan fallback saat transport tepercaya gagal.

**Belum teruji di Venice asli, perlu kalibrasi di akunmu:**
- Selector adalah tebakan; kalibrasi lewat panel sebelum dipakai.
- Deteksi akhir balasan ikut mengandalkan `stopButton`. Kalau selector itu salah,
  panel memberi peringatan dan driver memakai jeda stabil lebih panjang, tapi
  balasan panjang bisa terpotong. Kalibrasi `stopButton` dengan benar.
- Test driver di Chromium memakai halaman tiruan yang dibuat agar cocok dengan
  selector default (`test/fixtures/fake-chat.html`, `fake-chat-blocker.html`). Itu
  menguji logika driver (streaming, blok thinking, verifikasi input, kunci model,
  deteksi penghalang), **bukan** kecocokan dengan DOM Venice yang sebenarnya.
- `blockerSelector` dan `limitSelector` adalah tebakan paling spekulatif karena
  bergantung pada markup challenge/modal Venice; kalibrasi saat penghalang muncul.
- Shell penuh teruji di Linux dengan `bash`. Jalur `powershell` dan `cmd` hanya
  teruji pada tingkat deteksi dan logika; belum pernah dijalankan di Windows.
- Glue `chrome.debugger` di `background.js` (attach/detach nyata, pesan port)
  tidak di-unit-test karena butuh API Chrome; yang teruji adalah `CdpSession`
  dengan debugger tiruan. Jalur input tepercaya di Venice asli belum dicoba.

## Kalau muncul penghalang

Venice bisa menyisipkan penghalang di tengah sesi. Alat ini mendeteksi tiga
jenis (penghalang harus terlihat pada dua poll berturut-turut, supaya kedipan
sesaat tidak dianggap), lalu **halt dengan state tersimpan** — bukan menunggu
sampai timeout. CAPTCHA tidak pernah diselesaikan otomatis.

| Jenis | Yang terlihat | Yang dilakukan alat | Yang kamu lakukan |
|-|-|-|-|
| CAPTCHA/verifikasi (`blocked`) | tantangan Cloudflare/captcha | halt, panel disorot kuning | selesaikan verifikasi manual di tab, lalu `resume` |
| Batas/upgrade (`limit`) | modal limit atau ajakan upgrade | halt | tangani manual (tutup modal / tunggu / upgrade), lalu `resume` |
| Logout (`loggedout`) | kotak input hilang, balasan masih ada | halt | login lagi di tab, lalu `resume` |

`resume` membuka chat baru, membuang pekerjaan setengah jalan dari langkah
terakhir (rollback ke checkpoint terakhir), dan melanjutkan dari langkah yang
sama. Jatah langkah tidak terpakai oleh penghalang.

## Kalau daemon menggantung

Tidak seharusnya terjadi lagi. Kalau tab ditutup atau reload saat loop
berjalan, daemon menolak request yang tertunda dan mem-pause task; penghalang
di atas juga halt, tidak menggantung. Jalankan `node daemon.mjs resume` untuk
melanjutkan. Tekan Ctrl+C untuk menghentikan; sekali lagi untuk keluar paksa.
