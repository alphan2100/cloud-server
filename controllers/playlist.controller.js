const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const PlaylistModel = require('../models/playlist.model');
const MusicModel = require('../models/music.model');

const PlaylistController = {
  /**
   * GET /playlists
   * List playlist milik user
   */
  list: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const playlists = PlaylistModel.listByUser(userId);

    return res.json({ success: true, data: playlists });
  }),

  /**
   * POST /playlists
   * Buat playlist baru
   * Body: { name, description, track_ids: [1,2,3] (optional) }
   */
  create: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { name, description, track_ids } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new AppError('Nama playlist wajib diisi', 400, 'VALIDATION_ERROR');
    }

    const playlistId = PlaylistModel.create(userId, {
      name: name.trim(),
      description: description || null,
    });

    // Tambah tracks jika ada
    let addedTracks = 0;
    if (Array.isArray(track_ids) && track_ids.length > 0) {
      addedTracks = PlaylistModel.addTracks(playlistId, track_ids);
    }

    const playlist = PlaylistModel.getById(playlistId, userId);

    return res.status(201).json({
      success: true,
      message: 'Playlist berhasil dibuat',
      data: playlist,
      added_tracks: addedTracks,
    });
  }),

  /**
   * GET /playlists/:id
   * Detail playlist + tracks
   */
  getById: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const playlistId = req.params.id;

    const playlist = PlaylistModel.getById(playlistId, userId);
    if (!playlist) {
      throw new AppError('Playlist tidak ditemukan', 404, 'NOT_FOUND');
    }

    const tracks = PlaylistModel.getTracks(playlistId, userId);

    return res.json({
      success: true,
      data: { ...playlist, tracks: tracks || [] },
    });
  }),

  /**
   * PUT /playlists/:id
   * Update playlist (name, description)
   */
  update: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const playlistId = req.params.id;
    const { name, description } = req.body;

    const playlist = PlaylistModel.getById(playlistId, userId);
    if (!playlist) {
      throw new AppError('Playlist tidak ditemukan', 404, 'NOT_FOUND');
    }

    const updated = PlaylistModel.update(playlistId, userId, {
      name: name !== undefined ? name : undefined,
      description: description !== undefined ? description : undefined,
    });

    return res.json({
      success: true,
      message: 'Playlist berhasil diupdate',
      updated: updated > 0,
    });
  }),

  /**
   * DELETE /playlists/:id
   * Hapus playlist
   */
  delete: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const playlistId = req.params.id;

    const deleted = PlaylistModel.delete(playlistId, userId);
    if (!deleted) {
      throw new AppError('Playlist tidak ditemukan', 404, 'NOT_FOUND');
    }

    return res.json({
      success: true,
      message: 'Playlist berhasil dihapus',
    });
  }),

  /**
   * POST /playlists/:id/tracks
   * Tambah track(s) ke playlist
   * Body: { track_ids: [1,2,3] } atau { track_id: 1 }
   */
  addTracks: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const playlistId = req.params.id;
    const { track_ids, track_id } = req.body;

    const playlist = PlaylistModel.getById(playlistId, userId);
    if (!playlist) {
      throw new AppError('Playlist tidak ditemukan', 404, 'NOT_FOUND');
    }

    // Normalisasi: support track_id (single) atau track_ids (array)
    const ids = Array.isArray(track_ids) ? track_ids : track_id ? [track_id] : [];
    if (ids.length === 0) {
      throw new AppError('track_ids atau track_id wajib diisi', 400, 'VALIDATION_ERROR');
    }

    // Validasi: pastikan semua track milik user dan tidak di-delete
    for (const tid of ids) {
      const track = MusicModel.getTrackById(tid);
      if (!track || track.user_id !== userId || track.deleted_at) {
        throw new AppError(`Track ${tid} tidak valid`, 400, 'VALIDATION_ERROR');
      }
    }

    const added = PlaylistModel.addTracks(playlistId, ids);

    return res.json({
      success: true,
      message: `${added} track berhasil ditambahkan ke playlist`,
      added,
    });
  }),

  /**
   * DELETE /playlists/:id/tracks/:trackId
   * Hapus track dari playlist
   */
  removeTrack: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id: playlistId, trackId } = req.params;

    const playlist = PlaylistModel.getById(playlistId, userId);
    if (!playlist) {
      throw new AppError('Playlist tidak ditemukan', 404, 'NOT_FOUND');
    }

    const removed = PlaylistModel.removeTrack(playlistId, trackId);
    if (!removed) {
      throw new AppError('Track tidak ada di playlist', 404, 'NOT_FOUND');
    }

    return res.json({
      success: true,
      message: 'Track berhasil dihapus dari playlist',
    });
  }),

  /**
   * PUT /playlists/:id/reorder
   * Reorder tracks di playlist
   * Body: { track_ids: [3,1,2] } - urutan baru
   */
  reorder: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const playlistId = req.params.id;
    const { track_ids } = req.body;

    if (!Array.isArray(track_ids) || track_ids.length === 0) {
      throw new AppError('track_ids wajib diisi (array)', 400, 'VALIDATION_ERROR');
    }

    const playlist = PlaylistModel.getById(playlistId, userId);
    if (!playlist) {
      throw new AppError('Playlist tidak ditemukan', 404, 'NOT_FOUND');
    }

    PlaylistModel.reorderTracks(playlistId, track_ids);

    return res.json({
      success: true,
      message: 'Urutan track berhasil diupdate',
    });
  }),
};

module.exports = PlaylistController;