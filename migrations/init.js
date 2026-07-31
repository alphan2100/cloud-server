const fs = require('fs');
const path = require('path');
const pool = require('../config/db_init');

async function runMigrations() {
  try {
    const files = fs
      .readdirSync(__dirname)
      .filter(file => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      console.log(`🚀 Menjalankan ${file}`);

      const sql = fs.readFileSync(
        path.join(__dirname, file),
        'utf8'
      );

      // Split multiple statements jika ada
      const statements = sql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      for (const statement of statements) {
        await pool.query(statement + ';');
      }

      console.log(`✅ ${file} selesai`);
    }

    console.log('🎉 Semua migration selesai');

    process.exit(0);

  } catch (err) {
    console.error('❌ Migration gagal');
    console.error(err);

    process.exit(1);
  }
}

runMigrations();
