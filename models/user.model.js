const pool = require('../config/db');

const UserModel = {
  async create(username, passwordHash) {
    const [result] = await pool.query(
      `
      INSERT INTO users (
        username,
        password_hash
      )
      VALUES (?, ?)
      `,
      [username, passwordHash]
    );

    return result.insertId;
  },

  async findById(id) {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE id = ?',
      [id]
    );

    return rows[0];
  },

  async findByUsername(username) {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE username = ?',
      [username]
    );

    return rows[0];
  }
};

module.exports = UserModel;