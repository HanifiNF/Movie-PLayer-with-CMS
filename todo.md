1. Menambahkan film previe di dashboard sehingga operator dapat melihat film yang diputar di monitor kedua dengan melihatnnya di dashboard, tidak perlu hd, dan berbentuk layar kecil agar bisa muat di dashboard, tujuannya hanya untuk mengetahui apakah film berjalan dengan normal

2. Dual-player preloading untuk transisi film presisi waktu (planned feature)

   Tujuan:
   - Film berikutnya harus dapat terlihat tepat pada batas waktu schedule sekaligus dimulai dari frame `Start film at` yang dikonfigurasi.
   - Waktu persiapan VLC tidak boleh menggeser awal schedule atau membuat beberapa detik awal film terlewat.

   Rancangan:
   - Tambahkan `PlaybackDeckManager` dengan dua deck VLC: deck aktif dan deck preload.
   - Setiap deck memiliki proses VLC, RC port, lifecycle, status, serta output target yang terisolasi.
   - Beberapa detik sebelum pergantian timeline, deck preload memuat film berikutnya dalam keadaan tersembunyi dan mute.
   - Deck preload di-pause, di-seek ke `Start film at`, lalu harus mengonfirmasi input, posisi, dan kesiapan decoder.
   - Tepat pada batas waktu schedule, output dan audio berpindah secara atomik ke deck preload; deck lama kemudian dibersihkan dan menjadi kandidat preload berikutnya.
   - Dashboard, preview, pause/play, seek, volume, audio output, checkpoint, dan watchdog hanya mengontrol deck yang sedang aktif.
   - Film gap dan idle mode tetap menjadi fase timeline eksplisit dan tidak boleh menyalakan audio dari deck preload.
   - Jika preload gagal atau perangkat tidak cukup kuat, Player harus kembali ke transisi single-VLC yang sekarang tanpa menghentikan schedule.

   Keamanan dan validasi:
   - Gunakan RC port berbeda untuk setiap deck dan cegah konflik proses/output window.
   - Pastikan hanya satu deck yang audible dan terlihat pada satu waktu.
   - Uji dua pembacaan LDG gateway secara bersamaan, penggunaan CPU/GPU/RAM, pergantian monitor, crash recovery, serta token/license expiry.
   - Tambahkan tes transisi tanpa gap, dengan gap, `Start film at`, loop, late join, manual seek, dan restart Player.
