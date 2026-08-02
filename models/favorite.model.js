const { db } = require('../config/musicDb');

/**
 * Model untuk tabel favorites di music.db (SQLite)
 */
const FavoriteModel = {
  /**
   * Toggle favorite (add jika belum, remove jika sudah)
   * Return { isFavorite: boolean }
   */
  toggle(userId, trackId) {
    const existing = db
      .prepare('SELECT id FROM favorites WHERE user_id = ? AND track_id = ?')
      .get(userId, trackId);

    if (existing) {
      db.prepare('DELETE FROM favorites WHERE id = ?').run(existing.id);
      return { isFavorite: false };
    }

    db.prepare('INSERT INTO favorites (user_id, track_id) VALUES (?, ?)').run(userId, trackId);
    return { isFavorite: true };
  },

  /**
   * Tambah favorite (jika belum ada)
   */
  add(userId, trackId) {
    try {
      db.prepare('INSERT INTO favorites (user_id, track_id) VALUES (?, ?)').run(userId, trackId);
      return true;
    } catch (err) {
      // Sudah ada (unique constraint)
      return false;
    }
  },

  /**
   * Hapus favorite
   */
  remove(userId, trackId) {
    const info = db
      .prepare('DELETE FROM favorites WHERE user_id = ? AND track_id = ?')
      .run(userId, trackId);
    return info.changes > 0;
  },

  /**
   * Cek apakah track difavoritkan user
   */
  isFavorite(userId, trackId) {
    const row = db
      .prepare('SELECT id FROM favorites WHERE user_id = ? AND track_id = ?')
      .get(userId, trackId);
    return !!row;
  },

  /**
   * List favorite tracks milik user
   */
  listByUser(userId, { limit = 50, offset = 0 } = {}) {
    return db
      .prepare(
        `SELECT t.*, a.name as artist_name, al.title as album_title, al.cover_path as album_cover_path,
                f.created_at as favorited_at
         FROM favorites f
         INNER JOIN tracks t ON f.track_id = t.id
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         WHERE f.user_id = ? AND t.deleted_at IS NULL
         ORDER BY f.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(userId, limit, offset);
  },

  /**
   * Count favorite tracks milik user
   */
  countByUser(userId) {
    return db
      .prepare(
        `SELECT COUNT(*) as total 
         FROM favorites f 
         INNER JOIN tracks t ON f.track_id = t.id
         WHERE f.user_id = ? AND t.deleted_at IS NULL`
      )
      .get(userId).total;
  },
};

module.exports = FavoriteModel;