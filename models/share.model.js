const pool = require('../config/db');
const crypto = require('crypto');

const ShareModel = {
  async create(userId, itemType, itemId, permission, expiresAt = null) {
    const shareToken = crypto.randomBytes(32).toString('hex');

    const [result] = await pool.query(
      `
      INSERT INTO shares (user_id, item_type, item_id, share_token, permission, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [userId, itemType, itemId, shareToken, permission, expiresAt]
    );

    return { id: result.insertId, shareToken };
  },

  async findByToken(token) {
    const [rows] = await pool.query(
      `
      SELECT s.*, 
        CASE 
          WHEN s.expires_at IS NOT NULL AND s.expires_at < NOW() THEN 1 
          ELSE 0 
        END as is_expired
      FROM shares s
      WHERE s.share_token = ?
      LIMIT 1
      `,
      [token]
    );
    return rows[0] || null;
  },

  async findByUserAndItem(userId, itemType, itemId) {
    const [rows] = await pool.query(
      `
      SELECT * FROM shares
      WHERE user_id = ? AND item_type = ? AND item_id = ?
      ORDER BY created_at DESC
      `,
      [userId, itemType, itemId]
    );
    return rows;
  },

  async findByUser(userId) {
    const [rows] = await pool.query(
      `
      SELECT s.*, 
        CASE 
          WHEN s.item_type = 'file' THEN f.original_filename 
          WHEN s.item_type = 'folder' THEN fo.folder_name 
        END as item_name
      FROM shares s
      LEFT JOIN files f ON s.item_type = 'file' AND s.item_id = f.id
      LEFT JOIN folders fo ON s.item_type = 'folder' AND s.item_id = fo.id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC
      `,
      [userId]
    );
    return rows;
  },

  async delete(id, userId) {
    const [result] = await pool.query(
      `
      DELETE FROM shares
      WHERE id = ? AND user_id = ?
      `,
      [id, userId]
    );
    return result.affectedRows > 0;
  },

  async deleteByToken(token, userId) {
    const [result] = await pool.query(
      `
      DELETE FROM shares
      WHERE share_token = ? AND user_id = ?
      `,
      [token, userId]
    );
    return result.affectedRows > 0;
  },
};

module.exports = ShareModel;