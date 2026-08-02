const { db } = require('../config/musicDb');

/**
 * Model untuk tabel artists, albums, tracks di music.db (SQLite)
 * Menggunakan better-sqlite3 (sync API).
 */
const MusicModel = {
  // ==================== ARTISTS ====================

  /**
   * Upsert artist by mbid (atau nama jika tidak ada mbid)
   * Return artist.id
   */
  upsertArtist({ mbid, name }) {
    if (!name) name = 'Unknown Artist';

    // Cek by mbid dulu jika ada
    if (mbid) {
      const existing = db.prepare('SELECT id FROM artists WHERE mbid = ?').get(mbid);
      if (existing) {
        // Update nama jika berbeda (misal dari "Unknown Artist" jadi nama asli)
        if (name && name !== 'Unknown Artist') {
          db.prepare('UPDATE artists SET name = ? WHERE id = ?').run(name, existing.id);
        }
        return existing.id;
      }
      // Insert baru dengan mbid
      const info = db
        .prepare('INSERT INTO artists (mbid, name) VALUES (?, ?)')
        .run(mbid, name);
      return info.lastInsertRowid;
    }

    // Tidak ada mbid → cari by nama
    const existingByName = db.prepare('SELECT id FROM artists WHERE name = ? AND mbid IS NULL').get(name);
    if (existingByName) return existingByName.id;

    const info = db.prepare('INSERT INTO artists (mbid, name) VALUES (NULL, ?)').run(name);
    return info.lastInsertRowid;
  },

  /**
   * Get artist by id
   */
  getArtistById(id) {
    return db.prepare('SELECT * FROM artists WHERE id = ?').get(id);
  },

  /**
   * List semua artist milik user (berdasarkan track yang dimiliki)
   */
  listArtistsByUser(userId, { limit = 50, offset = 0 } = {}) {
    return db
      .prepare(
        `SELECT DISTINCT a.id, a.mbid, a.name, a.created_at,
                COUNT(DISTINCT t.id) as track_count
         FROM artists a
         INNER JOIN tracks t ON t.artist_id = a.id
         WHERE t.user_id = ? AND t.deleted_at IS NULL
         GROUP BY a.id
         ORDER BY a.name ASC
         LIMIT ? OFFSET ?`
      )
      .all(userId, limit, offset);
  },

  // ==================== ALBUMS ====================

  /**
   * Upsert album by mbid (atau title+artist jika tidak ada mbid)
   * Return album.id
   */
  upsertAlbum({ mbid, title, artistId, releaseDate, coverPath, coverUrl }) {
    if (!title) title = 'Unknown Album';

    if (mbid) {
      const existing = db.prepare('SELECT id FROM albums WHERE mbid = ?').get(mbid);
      if (existing) {
        // Update field yang mungkin baru (cover, release date)
        db.prepare(
          `UPDATE albums 
           SET title = COALESCE(?, title),
               artist_id = COALESCE(?, artist_id),
               release_date = COALESCE(?, release_date),
               cover_path = COALESCE(?, cover_path),
               cover_url = COALESCE(?, cover_url)
           WHERE id = ?`
        ).run(title, artistId, releaseDate, coverPath, coverUrl, existing.id);
        return existing.id;
      }
      const info = db
        .prepare(
          `INSERT INTO albums (mbid, title, artist_id, release_date, cover_path, cover_url)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(mbid, title, artistId, releaseDate, coverPath, coverUrl);
      return info.lastInsertRowid;
    }

    // Tidak ada mbid → cari by title + artist
    const existingByTitle = db
      .prepare('SELECT id FROM albums WHERE title = ? AND (artist_id = ? OR (artist_id IS NULL AND ? IS NULL)) AND mbid IS NULL')
      .get(title, artistId, artistId);
    if (existingByTitle) {
      // Update cover jika belum ada
      if (coverPath) {
        db.prepare('UPDATE albums SET cover_path = COALESCE(cover_path, ?), cover_url = COALESCE(cover_url, ?) WHERE id = ?')
          .run(coverPath, coverUrl, existingByTitle.id);
      }
      return existingByTitle.id;
    }

    const info = db
      .prepare(
        `INSERT INTO albums (mbid, title, artist_id, release_date, cover_path, cover_url)
         VALUES (NULL, ?, ?, ?, ?, ?)`
      )
      .run(title, artistId, releaseDate, coverPath, coverUrl);
    return info.lastInsertRowid;
  },

  /**
   * Get album by id (dengan info artist)
   */
  getAlbumById(id) {
    return db
      .prepare(
        `SELECT al.*, a.name as artist_name
         FROM albums al
         LEFT JOIN artists a ON al.artist_id = a.id
         WHERE al.id = ?`
      )
      .get(id);
  },

  /**
   * List album milik user
   */
  listAlbumsByUser(userId, { limit = 50, offset = 0 } = {}) {
    return db
      .prepare(
        `SELECT DISTINCT al.id, al.mbid, al.title, al.release_date, al.cover_path,
                a.name as artist_name,
                COUNT(DISTINCT t.id) as track_count
         FROM albums al
         INNER JOIN tracks t ON t.album_id = al.id
         LEFT JOIN artists a ON al.artist_id = a.id
         WHERE t.user_id = ? AND t.deleted_at IS NULL
         GROUP BY al.id
         ORDER BY al.title ASC
         LIMIT ? OFFSET ?`
      )
      .all(userId, limit, offset);
  },

  /**
   * Update cover album
   */
  updateAlbumCover(albumId, coverPath, coverUrl) {
    db.prepare('UPDATE albums SET cover_path = ?, cover_url = ? WHERE id = ?')
      .run(coverPath, coverUrl, albumId);
  },

  // ==================== TRACKS ====================

  /**
   * Cek apakah track sudah ada berdasarkan file_id
   */
  getTrackByFileId(fileId) {
    return db.prepare('SELECT * FROM tracks WHERE file_id = ?').get(fileId);
  },

  /**
   * Insert track baru
   */
  createTrack(data) {
    const info = db
      .prepare(
        `INSERT INTO tracks (
          user_id, file_id, mbid, title, artist_id, album_id,
          duration, track_number, genre, year, bitrate, file_path, scanned_at,
          metadata_source, feat_artist, preview_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)`
      )
      .run(
        data.user_id,
        data.file_id,
        data.mbid || null,
        data.title,
        data.artist_id || null,
        data.album_id || null,
        data.duration || null,
        data.track_number || null,
        data.genre || null,
        data.year || null,
        data.bitrate || null,
        data.file_path || null,
        data.metadata_source || 'filename',
        data.feat_artist || null,
        data.preview_url || null
      );
    return info.lastInsertRowid;
  },

  /**
   * Update track (re-scan)
   */
  updateTrack(id, data) {
    db.prepare(
      `UPDATE tracks 
       SET mbid = ?, title = ?, artist_id = ?, album_id = ?,
           duration = ?, track_number = ?, genre = ?, year = ?, bitrate = ?,
           file_path = ?, scanned_at = datetime('now'),
           metadata_source = ?, feat_artist = ?, preview_url = ?
       WHERE id = ?`
    ).run(
      data.mbid || null,
      data.title,
      data.artist_id || null,
      data.album_id || null,
      data.duration || null,
      data.track_number || null,
      data.genre || null,
      data.year || null,
      data.bitrate || null,
      data.file_path || null,
      data.metadata_source || 'filename',
      data.feat_artist || null,
      data.preview_url || null,
      id
    );
  },

  /**
   * Update track metadata oleh user (manual correction)
   * Set user_corrected = 1 agar tidak di-override oleh auto-rescan
   */
  updateTrackMetadata(id, data) {
    const sets = [];
    const params = [];

    if (data.title !== undefined) {
      sets.push('title = ?');
      params.push(data.title);
    }
    if (data.artist_id !== undefined) {
      sets.push('artist_id = ?');
      params.push(data.artist_id);
    }
    if (data.album_id !== undefined) {
      sets.push('album_id = ?');
      params.push(data.album_id);
    }
    if (data.year !== undefined) {
      sets.push('year = ?');
      params.push(data.year);
    }
    if (data.genre !== undefined) {
      sets.push('genre = ?');
      params.push(data.genre);
    }
    if (data.feat_artist !== undefined) {
      sets.push('feat_artist = ?');
      params.push(data.feat_artist);
    }
    if (data.track_number !== undefined) {
      sets.push('track_number = ?');
      params.push(data.track_number);
    }

    // Selalu set user_corrected = 1 dan metadata_source = 'user_corrected'
    sets.push('user_corrected = 1');
    sets.push("metadata_source = 'user_corrected'");
    sets.push("scanned_at = datetime('now')");

    if (sets.length === 0) return;

    params.push(id);
    db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  },

  /**
   * Cek apakah track sudah di-koreksi oleh user
   */
  isUserCorrected(trackId) {
    const row = db.prepare('SELECT user_corrected FROM tracks WHERE id = ?').get(trackId);
    return row ? row.user_corrected === 1 : false;
  },

  /**
   * Get track by id (dengan join artist & album)
   */
  getTrackById(id) {
    return db
      .prepare(
        `SELECT t.*, 
                a.name as artist_name, a.mbid as artist_mbid,
                al.title as album_title, al.mbid as album_mbid,
                al.cover_path as album_cover_path, al.release_date as album_release_date
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         WHERE t.id = ?`
      )
      .get(id);
  },

  /**
   * List tracks milik user (dengan pagination & filter)
   */
  listTracksByUser(
    userId,
    { limit = 50, offset = 0, artistId = null, albumId = null, search = null } = {}
  ) {
    let sql = `SELECT t.*, 
                      a.name as artist_name,
                      al.title as album_title, al.cover_path as album_cover_path,
                      CASE WHEN f.id IS NOT NULL THEN 1 ELSE 0 END as is_favorite
               FROM tracks t
               LEFT JOIN artists a ON t.artist_id = a.id
               LEFT JOIN albums al ON t.album_id = al.id
               LEFT JOIN favorites f ON f.track_id = t.id AND f.user_id = t.user_id
               WHERE t.user_id = ? AND t.deleted_at IS NULL`;
    const params = [userId];

    if (artistId) {
      sql += ` AND t.artist_id = ?`;
      params.push(artistId);
    }
    if (albumId) {
      sql += ` AND t.album_id = ?`;
      params.push(albumId);
    }
    if (search) {
      sql += ` AND (t.title LIKE ? OR a.name LIKE ? OR al.title LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY t.title ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return db.prepare(sql).all(...params);
  },

  /**
   * Count tracks milik user (untuk pagination)
   */
  countTracksByUser(userId, { artistId = null, albumId = null, search = null } = {}) {
    let sql = `SELECT COUNT(*) as total FROM tracks t
               LEFT JOIN artists a ON t.artist_id = a.id
               LEFT JOIN albums al ON t.album_id = al.id
               WHERE t.user_id = ? AND t.deleted_at IS NULL`;
    const params = [userId];

    if (artistId) {
      sql += ` AND t.artist_id = ?`;
      params.push(artistId);
    }
    if (albumId) {
      sql += ` AND t.album_id = ?`;
      params.push(albumId);
    }
    if (search) {
      sql += ` AND (t.title LIKE ? OR a.name LIKE ? OR al.title LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    return db.prepare(sql).get(...params).total;
  },

  /**
   * Soft delete track (sinkron dengan files.deleted_at)
   */
  softDeleteTrack(trackId) {
    db.prepare("UPDATE tracks SET deleted_at = datetime('now') WHERE id = ?").run(trackId);
  },

  /**
   * Soft delete track by file_id
   */
  softDeleteByFileId(fileId) {
    db.prepare("UPDATE tracks SET deleted_at = datetime('now') WHERE file_id = ?").run(fileId);
  },

  /**
   * Restore track (clear deleted_at)
   */
  restoreTrack(trackId) {
    db.prepare('UPDATE tracks SET deleted_at = NULL WHERE id = ?').run(trackId);
  },

  /**
   * Restore track by file_id
   */
  restoreByFileId(fileId) {
    db.prepare('UPDATE tracks SET deleted_at = NULL WHERE file_id = ?').run(fileId);
  },

  /**
   * Hard delete track by file_id (permanent delete)
   * CASCADE akan menghapus playlist_tracks, favorites, play_history
   */
  deleteByFileId(fileId) {
    db.prepare('DELETE FROM tracks WHERE file_id = ?').run(fileId);
  },

  /**
   * Hard delete track by id
   */
  deleteById(trackId) {
    db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId);
  },

  /**
   * Get tracks yang belum di-scan (scanned_at IS NULL) milik user
   * untuk incremental scan
   */
  getUnscannedTrackFileIds(userId) {
    const rows = db
      .prepare('SELECT file_id FROM tracks WHERE user_id = ? AND scanned_at IS NULL AND deleted_at IS NULL')
      .all(userId);
    return rows.map((r) => r.file_id);
  },

  // ==================== CLEANUP (ORPHANED DATA) ====================

  /**
   * Hapus album yang tidak punya track lagi (orphaned)
   * Return array of deleted album objects (with cover_path) untuk hapus file dari disk
   */
  cleanupOrphanedAlbums() {
    const orphaned = db
      .prepare(
        `SELECT al.id, al.cover_path, al.title
         FROM albums al
         LEFT JOIN tracks t ON t.album_id = al.id
         WHERE t.id IS NULL`
      )
      .all();

    if (orphaned.length === 0) return [];

    const ids = orphaned.map((a) => a.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM albums WHERE id IN (${placeholders})`).run(...ids);

    return orphaned;
  },

  /**
   * Hapus artist yang tidak punya track lagi (orphaned)
   * Return jumlah artist yang dihapus
   */
  cleanupOrphanedArtists() {
    const result = db
      .prepare(
        `DELETE FROM artists 
         WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL)`
      )
      .run();
    return result.changes;
  },

  /**
   * Get album cover_path by id (untuk cek album lama sebelum rescan)
   */
  getAlbumCoverPath(albumId) {
    if (!albumId) return null;
    const row = db.prepare('SELECT cover_path FROM albums WHERE id = ?').get(albumId);
    return row?.cover_path || null;
  },

  // ==================== PLAY HISTORY ====================

  /**
   * Record play
   */
  recordPlay(userId, trackId) {
    db.prepare('INSERT INTO play_history (user_id, track_id) VALUES (?, ?)').run(userId, trackId);
  },

  /**
   * Get recently played
   */
  getRecentlyPlayed(userId, { limit = 20 } = {}) {
    return db
      .prepare(
        `SELECT t.*, a.name as artist_name, al.title as album_title, al.cover_path as album_cover_path,
                ph.played_at
         FROM play_history ph
         INNER JOIN tracks t ON ph.track_id = t.id
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         WHERE ph.user_id = ? AND t.deleted_at IS NULL
         ORDER BY ph.played_at DESC
         LIMIT ?`
      )
      .all(userId, limit);
  },

  /**
   * Get most played
   */
  getMostPlayed(userId, { limit = 20 } = {}) {
    return db
      .prepare(
        `SELECT t.*, a.name as artist_name, al.title as album_title, al.cover_path as album_cover_path,
                COUNT(ph.id) as play_count
         FROM play_history ph
         INNER JOIN tracks t ON ph.track_id = t.id
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         WHERE ph.user_id = ? AND t.deleted_at IS NULL
         GROUP BY t.id
         ORDER BY play_count DESC
         LIMIT ?`
      )
      .all(userId, limit);
  },

  // ==================== SCAN JOBS ====================

  /**
   * Create scan job
   */
  createScanJob(userId, total) {
    const info = db
      .prepare(
        `INSERT INTO scan_jobs (user_id, status, total, started_at)
         VALUES (?, 'running', ?, datetime('now'))`
      )
      .run(userId, total);
    return info.lastInsertRowid;
  },

  /**
   * Update scan job progress
   */
  updateScanJobProgress(jobId, { processed, failed } = {}) {
    const sets = [];
    const params = [];
    if (processed !== undefined) {
      sets.push('processed = ?');
      params.push(processed);
    }
    if (failed !== undefined) {
      sets.push('failed = ?');
      params.push(failed);
    }
    if (sets.length === 0) return;
    params.push(jobId);
    db.prepare(`UPDATE scan_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  },

  /**
   * Complete scan job
   */
  completeScanJob(jobId, { failed = 0, error = null } = {}) {
    db.prepare(
      `UPDATE scan_jobs 
       SET status = ?, completed_at = datetime('now'), failed = ?, error = ?
       WHERE id = ?`
    ).run(error ? 'failed' : 'completed', failed, error, jobId);
  },

  /**
   * Get scan job by id
   */
  getScanJobById(jobId) {
    return db.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(jobId);
  },

  /**
   * Get latest scan job milik user
   */
  getLatestScanJobByUser(userId) {
    return db
      .prepare('SELECT * FROM scan_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(userId);
  },
};

module.exports = MusicModel;