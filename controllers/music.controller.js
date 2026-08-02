
const fs = require('fs');
const path = require('path');
const { asyncHandler, AppError } = require('../middlewares/error.middleware.js');
const MusicModel = require('../models/music.model.js');
const MusicScanService = require('../services/music-scan.service.js');
const { coverExists } = require('../services/cover-art.service.js');

const MusicController = {
  /**
   * POST /music/scan
   * Scan metadata audio
   * Body: { file_ids: [1,2,3] } atau { scan_all: true }
   */
  scan: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { file_ids, scan_all } = req.body;

    const jobId = await MusicScanService.startScan(userId, {
      fileIds: Array.isArray(file_ids) ? file_ids : null,
      scanAll: scan_all === true,
    });

    return res.status(202).json({
      success: true,
      message: 'Scan dimulai',
      job_id: jobId,
    });
  }),

  /**
   * GET /music/scan/:jobId/status
   * Cek status scan job
   */
  getScanStatus: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { jobId } = req.params;

    const job = MusicModel.getScanJobById(jobId);
    if (!job) {
      throw new AppError('Scan job tidak ditemukan', 404, 'NOT_FOUND');
    }
    if (job.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    const progress = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 100;

    return res.json({
      success: true,
      data: {
        ...job,
        progress,
      },
    });
  }),

  /**
   * GET /music/tracks
   * List tracks milik user (pagination, filter, search)
   * Query: page, limit, artist_id, album_id, search
   */
  listTracks: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const artistId = req.query.artist_id ? parseInt(req.query.artist_id) : null;
    const albumId = req.query.album_id ? parseInt(req.query.album_id) : null;
    const search = req.query.search || null;

    const tracks = MusicModel.listTracksByUser(userId, { limit, offset, artistId, albumId, search });
    const total = MusicModel.countTracksByUser(userId, { artistId, albumId, search });

    return res.json({
      success: true,
      data: tracks,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    });
  }),

  /**
   * GET /music/tracks/:id
   * Detail track
   */
  getTrack: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const trackId = req.params.id;

    const track = MusicModel.getTrackById(trackId);
    if (!track) {
      throw new AppError('Track tidak ditemukan', 404, 'NOT_FOUND');
    }
    if (track.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    return res.json({ success: true, data: track });
  }),

  /**
   * POST /music/tracks/:id/rescan
   * Re-fetch metadata untuk satu track
   */
  rescanTrack: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const trackId = req.params.id;

    const track = MusicModel.getTrackById(trackId);
    if (!track) {
      throw new AppError('Track tidak ditemukan', 404, 'NOT_FOUND');
    }
    if (track.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    const result = await MusicScanService.rescanTrack(trackId, userId);

    return res.json({
      success: true,
      message: 'Track berhasil di-rescan',
      data: result,
    });
  }),

  /**
   * GET /music/tracks/:id/cover
   * Serve cover image untuk track
   */
  getTrackCover: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const trackId = req.params.id;

    const track = MusicModel.getTrackById(trackId);
    if (!track) {
      throw new AppError('Track tidak ditemukan', 404, 'NOT_FOUND');
    }
    if (track.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    const coverPath = track.album_cover_path;
    if (!coverPath || !coverExists(coverPath)) {
      throw new AppError('Cover tidak ditemukan', 404, 'NOT_FOUND');
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 hours

    const stream = fs.createReadStream(coverPath);
    stream.pipe(res);
  }),

  /**
   * GET /music/search
   * Search track/artist/album
   */
  search: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { q } = req.query;

    if (!q || q.trim().length < 1) {
      throw new AppError('Query search tidak boleh kosong', 400, 'VALIDATION_ERROR');
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const tracks = MusicModel.listTracksByUser(userId, { limit, offset, search: q });
    const total = MusicModel.countTracksByUser(userId, { search: q });

    return res.json({
      success: true,
      data: tracks,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  }),

  /**
   * GET /music/albums
   * List album milik user
   */
  listAlbums: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const albums = MusicModel.listAlbumsByUser(userId, { limit, offset });

    return res.json({ success: true, data: albums });
  }),

  /**
   * GET /music/albums/:id
   * Detail album + tracks
   */
  getAlbum: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const albumId = req.params.id;

    const album = MusicModel.getAlbumById(albumId);
    if (!album) {
      throw new AppError('Album tidak ditemukan', 404, 'NOT_FOUND');
    }

    // Get tracks in album milik user
    const tracks = MusicModel.listTracksByUser(userId, { albumId, limit: 200 });

    return res.json({
      success: true,
      data: { ...album, tracks },
    });
  }),

  /**
   * GET /music/artists
   * List artist milik user
   */
  listArtists: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const artists = MusicModel.listArtistsByUser(userId, { limit, offset });

    return res.json({ success: true, data: artists });
  }),

  /**
   * GET /music/artists/:id
   * Detail artist + tracks
   */
  getArtist: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const artistId = req.params.id;

    const artist = MusicModel.getArtistById(artistId);
    if (!artist) {
      throw new AppError('Artist tidak ditemukan', 404, 'NOT_FOUND');
    }

    const tracks = MusicModel.listTracksByUser(userId, { artistId, limit: 200 });

    return res.json({
      success: true,
      data: { ...artist, tracks },
    });
  }),

  /**
   * POST /music/tracks/:id/play
   * Record play (increment play count)
   */
  recordPlay: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const trackId = req.params.id;

    const track = MusicModel.getTrackById(trackId);
    if (!track) {
      throw new AppError('Track tidak ditemukan', 404, 'NOT_FOUND');
    }
    if (track.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    MusicModel.recordPlay(userId, trackId);

    return res.json({ success: true, message: 'Play recorded' });
  }),

  /**
   * GET /music/recent
   * Recently played tracks
   */
  getRecent: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

    const tracks = MusicModel.getRecentlyPlayed(userId, { limit });

    return res.json({ success: true, data: tracks });
  }),

  /**
   * GET /music/most-played
   * Most played tracks
   */
  getMostPlayed: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

    const tracks = MusicModel.getMostPlayed(userId, { limit });

    return res.json({ success: true, data: tracks });
  }),

  /**
   * PUT /music/tracks/:id
   * Update metadata track (user correction)
   * Set user_corrected = 1 agar tidak di-override oleh auto-rescan
   * Body: { title, artist_name, album_title, year, genre, feat_artist, track_number }
   */
  updateTrackMetadata: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const trackId = req.params.id;
    const { title, artist_name, album_title, year, genre, feat_artist, track_number } = req.body;

    const track = MusicModel.getTrackById(trackId);
    if (!track) {
      throw new AppError('Track tidak ditemukan', 404, 'NOT_FOUND');
    }
    if (track.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    // Upsert artist jika artist_name diberikan
    let artistId = track.artist_id;
    if (artist_name !== undefined) {
      artistId = MusicModel.upsertArtist({ name: artist_name });
    }

    // Upsert album jika album_title diberikan
    let albumId = track.album_id;
    if (album_title !== undefined) {
      albumId = MusicModel.upsertAlbum({
        title: album_title,
        artistId,
      });
    }

    // Update track metadata
    MusicModel.updateTrackMetadata(trackId, {
      title,
      artist_id: artistId,
      album_id: albumId,
      year,
      genre,
      feat_artist,
      track_number,
    });

    // Return updated track
    const updatedTrack = MusicModel.getTrackById(trackId);

    return res.json({
      success: true,
      message: 'Metadata track berhasil diupdate',
      data: updatedTrack,
    });
  }),

  /**
   * POST /music/cleanup
   * Hapus album & artist yang tidak punya track lagi (orphaned)
   * Juga hapus cover art dari disk
   */
  cleanup: asyncHandler(async (req, res) => {
    const { deleteCover } = require('../services/cover-art.service');

    // Cleanup orphaned albums
    const orphanedAlbums = MusicModel.cleanupOrphanedAlbums();

    // Hapus cover art dari disk
    for (const album of orphanedAlbums) {
      if (album.cover_path) {
        deleteCover(album.cover_path);
      }
    }

    // Cleanup orphaned artists
    const deletedArtists = MusicModel.cleanupOrphanedArtists();

    return res.json({
      success: true,
      message: 'Cleanup selesai',
      data: {
        deleted_albums: orphanedAlbums.length,
        deleted_artists: deletedArtists,
      },
    });
  }),
};

module.exports = MusicController;