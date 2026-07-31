const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 20, // Mengizinkan hingga 20 koneksi simultan aktif
  queueLimit: 0
});

// Fungsi untuk mengetes koneksi saat server pertama kali berjalan
const testConnection = async () => {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Koneksi ke database MySQL berhasil.');
    connection.release();
  } catch (error) {
    console.error('❌ Gagal terhubung ke database:', error.message);
    process.exit(1); // Hentikan aplikasi jika database gagal terhubung
  }
};

testConnection();

module.exports = pool;