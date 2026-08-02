const path = require('path');
const fs = require('fs');
const pool = require('../config/db');
const MusicModel = require('../models/music.model');
const MusicBrainzService = require('./musicbrainz.service');
const ITunesService = require('./itunes.service');
const { smartParseFilename } = require('./filename-parser.service');
const {
  downloadCover,
  downloadCoverFromItunes,
  generatePlaceholderCover,
  deleteCover,
  coverExists,
} = require('./cover-art.service');

/**
 * Service untuk orkestrasi scan media audio (Smart Scan):
 * 1. Smart parse filename → ekstrak artist, title, feat, track number, year
 * 2. Query iTunes untuk metadata lengkap (cover art HD, album, genre, duration)
 * 3. Fallback ke MusicBrainz jika iTunes tidak ada
 * 4. Download / generate cover art
 * 5. Simpan ke music.db
 *
 * Fitur:
 * - Smart filename parser (15+ pola, underscore, Jepang, dll.)
 * - iTunes enrichment (gratis, no auth, cover HD 600x600)
 * - MusicBrainz fallback (MBID + Cover Art Archive)
 * - Incremental scan (skip file yang sudah ter-scan)
 * - Skip track yang sudah di-koreksi user (user_corrected = 1)
 * - Scan job tracking (progress)
 * - Re-scan single track
 */

/**
 * Cek apakah file adalah audio berdasarkan mime_type atau ekstensi
 */
function isAudioFile(mimeType, filename) {
  if (mimeType && mimeType.startsWith('audio/')) return true;
  if (!filename) return false;
  const audioExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.wma', '.opus', '.weba'];
  const ext = path.extname(filename).toLowerCase();
  return audioExtensions.includes(ext);
}

/**
 * Proses satu file audio: smart parse → iTunes → MusicBrainz fallback → save to DB
 * @param {Object} file - row dari MySQL files table
 * @param {number} userId
 * @returns {Promise<Object>} - { success, trackId, error }
 */
async function scanSingleFile(file, userId) {
  try {
    // 0. Cek apakah track sudah di-koreksi user → skip auto-rescan
    const existingTrack = MusicModel.getTrackByFileId(file.id);
    if (existingTrack && existingTrack.user_corrected === 1) {
      console.log(`[MusicScan] Skip file ${file.id} - sudah di-koreksi user`);
      return { success: true, trackId: existingTrack.id, skipped: true };
    }

    // 1. Smart parse filename
    const parsed = smartParseFilename(file.original_filename);

    // 2. Query iTunes untuk metadata lengkap (prioritas utama)
    let enriched = null;
    let metadataSource = 'filename';

    if (parsed.title && parsed.title !== 'Unknown') {
      try {
        enriched = await ITunesService.enrichMetadata(parsed.artist, parsed.title);
        if (enriched) {
          metadataSource = 'itunes';
        }
      } catch (err) {
        console.warn(`[iTunes] Gagal untuk "${parsed.title}": ${err.message}`);
      }
    }

    // 3. Fallback ke MusicBrainz jika iTunes tidak ada
    if (!enriched && parsed.title && parsed.title !== 'Unknown') {
      try {
        enriched = await MusicBrainzService.enrichMetadata(parsed.artist, parsed.title);
        if (enriched) {
          metadataSource = 'musicbrainz';
        }
      } catch (err) {
        console.warn(`[MusicBrainz] Gagal untuk "${parsed.title}": ${err.message}`);
      }
    }

    // 4. Tentukan metadata final
    // Priority: enriched (iTunes/MusicBrainz) > smart parse filename
    const finalMeta = {
      title: enriched?.title || parsed.title,
      artistName: enriched?.artist?.name || parsed.artist || 'Unknown Artist',
      artistMbid: enriched?.artist?.mbid || null,
      albumTitle: enriched?.album?.title || 'Unknown Album',
      albumMbid: enriched?.album?.mbid || null,
      albumReleaseDate: enriched?.album?.releaseDate || null,
      releaseGroupId: enriched?.album?.releaseGroupId || null,
      trackMbid: enriched?.mbid || null,
      duration: enriched?.duration || null,
      trackNumber: enriched?.trackNumber || parsed.trackNumber || null,
      genre: enriched?.genre || null,
      year: enriched?.year || parsed.year || null,
      bitrate: null,
      coverArtUrl: null,
      featArtist: parsed.feat || null,
      previewUrl: enriched?.previewUrl || null,
      metadataSource,
    };

    // Tentukan cover art URL berdasarkan source
    if (metadataSource === 'itunes' && enriched?.album?.coverArtUrl) {
      finalMeta.coverArtUrl = enriched.album.coverArtUrl;
    } else if (metadataSource === 'musicbrainz' && enriched?.coverArt?.frontUrl) {
      finalMeta.coverArtUrl = enriched.coverArt.frontUrl;
    }

    // 5. Upsert artist
    const artistId = MusicModel.upsertArtist({
      mbid: finalMeta.artistMbid,
      name: finalMeta.artistName,
    });

    // 6. Download / generate cover art
    let coverPath = null;
    let coverUrl = finalMeta.coverArtUrl;

    if (finalMeta.coverArtUrl) {
      if (metadataSource === 'itunes') {
        // Download dari iTunes (gunakan iTunes collectionId atau hash)
        const coverId = enriched?.album?.itunesId || `album_${artistId}_${finalMeta.albumTitle}`;
        coverPath = await downloadCoverFromItunes(finalMeta.coverArtUrl, coverId);
      } else {
        // Download dari Cover Art Archive (MusicBrainz)
        coverPath = await downloadCover(finalMeta.coverArtUrl, finalMeta.albumMbid);
      }
    }

    // Fallback: generate placeholder jika tidak ada cover
    if (!coverPath) {
      const coverId = finalMeta.albumMbid || `album_${artistId}_${finalMeta.albumTitle}`;
      coverPath = await generatePlaceholderCover(coverId, finalMeta.albumTitle || finalMeta.artistName);
    }

    // 7. Upsert album
    const albumId = MusicModel.upsertAlbum({
      mbid: finalMeta.albumMbid,
      title: finalMeta.albumTitle,
      artistId,
      releaseDate: finalMeta.albumReleaseDate,
      coverPath,
      coverUrl,
    });

    // 8. Insert atau update track
    if (existingTrack) {
      // Update track yang sudah ada (re-scan)
      MusicModel.updateTrack(existingTrack.id, {
        mbid: finalMeta.trackMbid,
        title: finalMeta.title,
        artist_id: artistId,
        album_id: albumId,
        duration: finalMeta.duration,
        track_number: finalMeta.trackNumber,
        genre: finalMeta.genre,
        year: finalMeta.year,
        bitrate: finalMeta.bitrate,
        file_path: file.file_path,
        metadata_source: finalMeta.metadataSource,
        feat_artist: finalMeta.featArtist,
        preview_url: finalMeta.previewUrl,
      });
      return { success: true, trackId: existingTrack.id, updated: true };
    }

    // Insert track baru
    const trackId = MusicModel.createTrack({
      user_id: userId,
      file_id: file.id,
      mbid: finalMeta.trackMbid,
      title: finalMeta.title,
      artist_id: artistId,
      album_id: albumId,
      duration: finalMeta.duration,
      track_number: finalMeta.trackNumber,
      genre: finalMeta.genre,
      year: finalMeta.year,
      bitrate: finalMeta.bitrate,
      file_path: file.file_path,
      metadata_source: finalMeta.metadataSource,
      feat_artist: finalMeta.featArtist,
      preview_url: finalMeta.previewUrl,
    });

    return { success: true, trackId, updated: false };
  } catch (err) {
    console.error(`[MusicScan] Error scanning file ${file.id}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Get audio files dari MySQL yang belum di-scan (incremental)
 * atau semua audio files jika force=true
 */
async function getAudioFilesToScan(userId, fileIds = null, scanAll = false) {
  let sql = `SELECT id, original_filename, file_path, mime_type
             FROM files
             WHERE user_id = ? AND deleted_at IS NULL AND (
               mime_type LIKE 'audio/%'
               OR LOWER(original_filename) LIKE '%.mp3'
               OR LOWER(original_filename) LIKE '%.wav'
               OR LOWER(original_filename) LIKE '%.flac'
               OR LOWER(original_filename) LIKE '%.m4a'
               OR LOWER(original_filename) LIKE '%.aac'
               OR LOWER(original_filename) LIKE '%.ogg'
               OR LOWER(original_filename) LIKE '%.wma'
               OR LOWER(original_filename) LIKE '%.opus'
             )`;
  const params = [userId];

  if (fileIds && fileIds.length > 0) {
    const placeholders = fileIds.map(() => '?').join(',');
    sql += ` AND id IN (${placeholders})`;
    params.push(...fileIds);
  }

  const [rows] = await pool.query(sql, params);

  if (scanAll) {
    return rows;
  }

  // Incremental: filter file yang belum ada di music.db atau belum di-scan
  const scannedFileIds = new Set(
    rows
      .filter((r) => {
        const track = MusicModel.getTrackByFileId(r.id);
        return track && track.scanned_at;
      })
      .map((r) => r.id)
  );

  return rows.filter((r) => !scannedFileIds.has(r.id));
}

const MusicScanService = {
  /**
   * Scan audio files milik user
   * @param {number} userId
   * @param {Object} options
   * @param {Array<number>} options.fileIds - specific file IDs to scan
   * @param {boolean} options.scanAll - scan semua audio file (termasuk yang sudah ter-scan)
   * @returns {Promise<number>} - scan job ID
   */
  async startScan(userId, { fileIds = null, scanAll = false } = {}) {
    const filesToScan = await getAudioFilesToScan(userId, fileIds, scanAll);

    if (filesToScan.length === 0) {
      // Tetap buat job dengan total 0 (completed immediately)
      const jobId = MusicModel.createScanJob(userId, 0);
      MusicModel.completeScanJob(jobId, {});
      return jobId;
    }

    // Buat scan job
    const jobId = MusicModel.createScanJob(userId, filesToScan.length);

    // Jalankan scan di background (tidak block request)
    this._processScanJob(jobId, filesToScan, userId).catch((err) => {
      console.error(`[MusicScan] Job ${jobId} fatal error:`, err);
      MusicModel.completeScanJob(jobId, { error: err.message });
    });

    return jobId;
  },

  /**
   * Process scan job di background
   */
  async _processScanJob(jobId, files, userId) {
    let processed = 0;
    let failed = 0;

    for (const file of files) {
      try {
        const result = await scanSingleFile(file, userId);
        if (result.success) {
          processed += 1;
        } else {
          failed += 1;
        }
      } catch (err) {
        console.error(`[MusicScan] Error processing file ${file.id}:`, err);
        failed += 1;
      }

      // Update progress setiap file
      MusicModel.updateScanJobProgress(jobId, { processed, failed });
    }

    MusicModel.completeScanJob(jobId, { failed });
    console.log(`[MusicScan] Job ${jobId} selesai: ${processed} processed, ${failed} failed`);

    // Cleanup orphaned albums & artists setelah scan selesai
    this._cleanupOrphanedData();
  },

  /**
   * Cleanup orphaned albums & artists
   * Hapus album/artist yang tidak punya track lagi + hapus cover dari disk
   */
  _cleanupOrphanedData() {
    try {
      // Cleanup orphaned albums (dapat list dengan cover_path)
      const orphanedAlbums = MusicModel.cleanupOrphanedAlbums();

      // Hapus cover art dari disk untuk album yang dihapus
      for (const album of orphanedAlbums) {
        if (album.cover_path) {
          deleteCover(album.cover_path);
        }
      }

      // Cleanup orphaned artists
      const deletedArtists = MusicModel.cleanupOrphanedArtists();

      if (orphanedAlbums.length > 0 || deletedArtists > 0) {
        console.log(
          `[MusicScan] Cleanup: ${orphanedAlbums.length} orphaned albums, ${deletedArtists} orphaned artists dihapus`
        );
      }
    } catch (err) {
      console.error('[MusicScan] Cleanup orphaned data gagal:', err.message);
    }
  },

  /**
   * Re-scan single track (by track_id di music.db)
   * Skip jika track sudah di-koreksi user
   */
  async rescanTrack(trackId, userId) {
    const track = MusicModel.getTrackById(trackId);
    if (!track) {
      throw new Error('Track tidak ditemukan');
    }
    if (track.user_id !== userId) {
      throw new Error('Akses ditolak');
    }

    // Skip jika sudah di-koreksi user
    if (track.user_corrected === 1) {
      return { success: true, trackId, skipped: true, message: 'Track sudah di-koreksi user' };
    }

    // Ambil info file dari MySQL
    const [rows] = await pool.query('SELECT id, original_filename, file_path, mime_type FROM files WHERE id = ?', [
      track.file_id,
    ]);
    if (rows.length === 0) {
      throw new Error('File tidak ditemukan di storage');
    }

    const result = await scanSingleFile(rows[0], userId);
    return result;
  },

  /**
   * Get scan job status
   */
  getScanJobStatus(jobId) {
    return MusicModel.getScanJobById(jobId);
  },

  /**
   * Auto-scan single file setelah upload (untuk integrasi upload.service)
   */
  async autoScanFile(fileId, userId) {
    try {
      const [rows] = await pool.query(
        'SELECT id, original_filename, file_path, mime_type FROM files WHERE id = ? AND user_id = ?',
        [fileId, userId]
      );
      if (rows.length === 0) return null;

      const file = rows[0];
      if (!isAudioFile(file.mime_type, file.original_filename)) return null;

      const result = await scanSingleFile(file, userId);
      return result;
    } catch (err) {
      console.error(`[MusicScan] Auto-scan failed for file ${fileId}:`, err);
      return null;
    }
  },
};

module.exports = MusicScanService;