const { db } = require('../config/musicDb');

/**
 * Model untuk tabel playlists & playlist_tracks di music.db (SQLite)
 */
const PlaylistModel = {
  /**
   * Buat playlist baru
   */
  create(userId, { name, description = null, coverPath = null }) {
    const info = db
      .prepare(
        `INSERT INTO playlists (user_id, name, description, cover_path)
         VALUES (?, ?, ?, ?)`
      )
      .run(userId, name, description, coverPath);
    return info.lastInsertRowid;
  },

  /**
   * Get playlist by id (cek kepemilikan user)
   */
  getById(id, userId) {
    return db
      .prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?')
      .get(id, userId);
  },

  /**
   * Get playlist by id (tanpa cek user, untuk internal use)
   */
  getByIdAny(id) {
    return db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
  },

  /**
   * List playlist milik user
   */
  listByUser(userId) {
    return db
      .prepare(
        `SELECT p.*,
                (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) as track_count
         FROM playlists p
         WHERE p.user_id = ?
         ORDER BY p.updated_at DESC`
      )
      .all(userId);
  },

  /**
   * Update playlist
   */
  update(id, userId, { name, description, coverPath }) {
    const sets = [];
    const params = [];
    if (name !== undefined) {
      sets.push('name = ?');
      params.push(name);
    }
    if (description !== undefined) {
      sets.push('description = ?');
      params.push(description);
    }
    if (coverPath !== undefined) {
      sets.push('cover_path = ?');
      params.push(coverPath);
    }
    if (sets.length === 0) return 0;
    sets.push("updated_at = datetime('now')");
    params.push(id, userId);
    const info = db
      .prepare(`UPDATE playlists SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...params);
    return info.changes;
  },

  /**
   * Hapus playlist (CASCADE akan hapus playlist_tracks)
   */
  delete(id, userId) {
    const info = db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(id, userId);
    return info.changes;
  },

  /**
   * Get semua track di playlist (urut by position)
   */
  getTracks(playlistId, userId) {
    // Pastikan playlist milik user
    const playlist = db
      .prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?')
      .get(playlistId, userId);
    if (!playlist) return null;

    return db
      .prepare(
        `SELECT t.*, a.name as artist_name, al.title as album_title, al.cover_path as album_cover_path,
                pt.position, pt.added_at,
                CASE WHEN f.id IS NOT NULL THEN 1 ELSE 0 END as is_favorite
         FROM playlist_tracks pt
         INNER JOIN tracks t ON pt.track_id = t.id
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN favorites f ON f.track_id = t.id AND f.user_id = ?
         WHERE pt.playlist_id = ? AND t.deleted_at IS NULL
         ORDER BY pt.position ASC`
      )
      .all(userId, playlistId);
  },

  /**
   * Tambah track ke playlist
   * Jika track sudah ada di playlist, skip (unique index)
   */
  addTrack(playlistId, trackId, position = null) {
    try {
      // Jika position tidak ditentukan, ambil position max + 1
      if (position === null) {
        const row = db
          .prepare('SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM playlist_tracks WHERE playlist_id = ?')
          .get(playlistId);
        position = row.next_pos;
      }
      const info = db
        .prepare(
          `INSERT INTO playlist_tracks (playlist_id, track_id, position)
           VALUES (?, ?, ?)`
        )
        .run(playlistId, trackId, position);
      // Update updated_at playlist
      db.prepare("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?").run(playlistId);
      return info.lastInsertRowid;
    } catch (err) {
      // Unique constraint violation → track sudah ada
      if (err.message.includes('UNIQUE constraint failed')) {
        return null;
      }
      throw err;
    }
  },

  /**
   * Tambah multiple tracks ke playlist
   */
  addTracks(playlistId, trackIds) {
    let added = 0;
    // Ambil position max saat ini
    let nextPos = db
      .prepare('SELECT COALESCE(MAX(position), 0) as max_pos FROM playlist_tracks WHERE playlist_id = ?')
      .get(playlistId).max_pos;

    const insertStmt = db.prepare(
      `INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`
    );
    const addMany = db.transaction((ids) => {
      for (const trackId of ids) {
        try {
          nextPos += 1;
          insertStmt.run(playlistId, trackId, nextPos);
          added += 1;
        } catch (err) {
          // skip duplicate
          nextPos -= 1;
        }
      }
    });
    addMany(trackIds);

    if (added > 0) {
      db.prepare("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?").run(playlistId);
    }
    return added;
  },

  /**
   * Hapus track dari playlist
   */
  removeTrack(playlistId, trackId) {
    const info = db
      .prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
      .run(playlistId, trackId);
    if (info.changes > 0) {
      // Reorder positions agar sequential
      db.prepare(
        `UPDATE playlist_tracks 
         SET position = (
           SELECT COUNT(*) FROM playlist_tracks pt2 
           WHERE pt2.playlist_id = playlist_tracks.playlist_id 
           AND pt2.position < playlist_tracks.position
         ) + 1
         WHERE playlist_id = ?`
      ).run(playlistId);
      db.prepare("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?").run(playlistId);
    }
    return info.changes;
  },

  /**
   * Reorder tracks di playlist
   * @param {number} playlistId
   * @param {Array<number>} trackIds - urutan baru track_id
   */
  reorderTracks(playlistId, trackIds) {
    const reorder = db.transaction((ids) => {
      for (let i = 0; i < ids.length; i++) {
        db.prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?')
          .run(i + 1, playlistId, ids[i]);
      }
    });
    reorder(trackIds);
    db.prepare("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?").run(playlistId);
    return true;
  },

  /**
   * Cek apakah track ada di playlist
   */
  isTrackInPlaylist(playlistId, trackId) {
    const row = db
      .prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
      .get(playlistId, trackId);
    return !!row;
  },
};

module.exports = PlaylistModel;