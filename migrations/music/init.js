const fs = require('fs');
const path = require('path');
const { db, MUSIC_DB_PATH } = require('../../config/musicDb');

/**
 * Runner migrasi khusus SQLite (music.db)
 * Menjalankan semua file .sql di folder ini secara berurutan.
 * SQLite mendukung multiple statement via db.exec(), jadi tidak perlu split manual.
 *
 * Fitur:
 * - Tracking migrations di tabel _music_migrations (skip yang sudah dijalankan)
 * - Error handling per-file
 */
async function runMigrations() {
  try {
    console.log(`🎵 Music DB path: ${MUSIC_DB_PATH}`);

    // Buat tabel tracking migrations jika belum ada
    db.exec(`
      CREATE TABLE IF NOT EXISTS _music_migrations (
        filename TEXT PRIMARY KEY,
        executed_at TEXT DEFAULT (datetime('now'))
      );
    `);

    const files = fs
      .readdirSync(__dirname)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('⚠️  Tidak ada file migrasi .sql ditemukan');
      process.exit(0);
    }

    let executed = 0;
    let skipped = 0;

    for (const file of files) {
      // Cek apakah migration sudah pernah dijalankan
      const alreadyRun = db.prepare('SELECT filename FROM _music_migrations WHERE filename = ?').get(file);

      if (alreadyRun) {
        console.log(`⏭️  Skip ${file} (sudah dijalankan)`);
        skipped++;
        continue;
      }

      console.log(`🚀 Menjalankan ${file}`);

      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');

      // SQLite better-sqlite3 mendukung exec untuk multiple statements
      db.exec(sql);

      // Catat migration yang sudah dijalankan
      db.prepare('INSERT INTO _music_migrations (filename) VALUES (?)').run(file);

      console.log(`✅ ${file} selesai`);
      executed++;
    }

    console.log(`🎉 Migrasi music.db selesai: ${executed} dijalankan, ${skipped} di-skip`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Migrasi music.db gagal');
    console.error(err);
    process.exit(1);
  }
}

runMigrations();