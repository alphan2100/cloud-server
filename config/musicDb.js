require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Path ke file music.db (bisa dikonfigurasi via .env)
const MUSIC_DB_PATH = process.env.MUSIC_DB_PATH
  ? path.resolve(process.env.MUSIC_DB_PATH)
  : path.join(__dirname, '..', 'music.db');

// Pastikan direktori parent ada
const dbDir = path.dirname(MUSIC_DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Buat koneksi SQLite (WAL mode untuk performa lebih baik)
const db = new Database(MUSIC_DB_PATH);

// Aktifkan foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Test koneksi & info
 */
function testConnection() {
  try {
    const row = db.prepare('SELECT sqlite_version() as version').get();
    console.log(`✅ Koneksi ke music.db (SQLite ${row.version}) berhasil: ${MUSIC_DB_PATH}`);
  } catch (err) {
    console.error('❌ Gagal terhubung ke music.db:', err.message);
    process.exit(1);
  }
}

module.exports = {
  db,
  MUSIC_DB_PATH,
  testConnection,
};