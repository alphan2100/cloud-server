require('dotenv').config();

const bcrypt = require('bcrypt');
const pool = require('../config/db');

async function seedUser() {
  try {
    const username = process.env.SEED_USER_NAME;
    const password = process.env.SEED_USER_PASSWORD;

    const [existing] = await pool.query(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existing.length > 0) {
      console.log('⚠️ User admin sudah ada');
      process.exit(0);
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(
      `
      INSERT INTO users (
        username,
        password_hash
      )
      VALUES (?, ?)
      `,
      [username, passwordHash]
    );

    console.log('✅ Admin berhasil dibuat');
    console.log('Username:', username);
    console.log('Password:', password);

    process.exit(0);

  } catch (error) {
    console.error('❌ Seeder gagal');
    console.error(error);

    process.exit(1);
  }
}

seedUser();