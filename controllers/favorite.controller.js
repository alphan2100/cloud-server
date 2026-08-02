const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const FavoriteModel = require('../models/favorite.model');
const MusicModel = require('../models/music.model');

const FavoriteController = {
  /**
   * GET /favorites
   * List favorite tracks milik user
   * Query: page, limit
   */
  list: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const tracks = FavoriteModel.listByUser(userId, { limit, offset });
    const total = FavoriteModel.countByUser(userId);

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
   * POST /favorites/:trackId
   * Toggle favorite (add jika belum, remove jika sudah)
   */
  toggle: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const trackId = parseInt(req.params.trackId);

    if (!trackId) {
      throw new AppError('Track ID tidak valid', 400, 'VALIDATION_ERROR');
    }

    // Validasi track milik user
    const track = MusicModel.getTrackById(trackId);
    if (!track) {
      throw new AppError('Track tidak ditemukan', 404, 'NOT_FOUND');
    }
    if (track.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    const result = FavoriteModel.toggle(userId, trackId);

    return res.json({
      success: true,
      message: result.isFavorite ? 'Track ditambahkan ke favorite' : 'Track dihapus dari favorite',
      is_favorite: result.isFavorite,
    });
  }),

  /**
   * DELETE /favorites/:trackId
   * Hapus favorite
   */
  remove: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const trackId = parseInt(req.params.trackId);

    const removed = FavoriteModel.remove(userId, trackId);

    return res.json({
      success: true,
      message: removed ? 'Favorite dihapus' : 'Track tidak ada di favorite',
      removed,
    });
  }),

  /**
   * GET /favorites/check/:trackId
   * Cek apakah track difavoritkan
   */
  check: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const trackId = parseInt(req.params.trackId);

    const isFavorite = FavoriteModel.isFavorite(userId, trackId);

    return res.json({
      success: true,
      is_favorite: isFavorite,
    });
  }),
};

module.exports = FavoriteController;