const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const torrentService = require('../services/torrent.service');

function normalizeFolderId(rawFolderId) {
  if (rawFolderId === 'null' || rawFolderId === '' || rawFolderId === undefined || rawFolderId === null) {
    return null;
  }
  return String(rawFolderId);
}

const TorrentController = {
  /**
   * POST /torrents/preview
   * Body: { magnet: string }  ATAU  multipart dengan field "torrent" (.torrent file)
   * Mengembalikan info file SEBELUM download dimulai.
   */
  preview: asyncHandler(async (req, res) => {
    let data;

    if (req.file) {
      data = torrentService.previewFromTorrentBuffer(req.file.buffer);
    } else if (req.body.magnet) {
      data = torrentService.previewFromMagnet(req.body.magnet);
    } else {
      throw new AppError('Sertakan magnet URI atau file .torrent', 400, 'VALIDATION_ERROR');
    }

    return res.json({ success: true, data });
  }),

  /**
   * POST /torrents/start
   * Body: { magnet, folder_id, name } ATAU multipart { torrent (file), folder_id }
   * Mulai download via aria2.
   */
  start: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const folderId = normalizeFolderId(req.body.folder_id ?? req.query.folder_id);

    let task;
    if (req.file) {
      task = await torrentService.startFromTorrentBuffer(userId, folderId, req.file.buffer, req.file.originalname);
    } else if (req.body.magnet) {
      task = await torrentService.startFromMagnet(userId, folderId, req.body.magnet, req.body.name);
    } else {
      throw new AppError('Sertakan magnet URI atau file .torrent', 400, 'VALIDATION_ERROR');
    }

    return res.status(201).json({ success: true, data: task });
  }),

  /**
   * GET /torrents/:gid/status
   * Dipanggil berkala oleh frontend untuk polling progress.
   */
  status: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { gid } = req.params;
    const data = await torrentService.getStatus(userId, gid);
    return res.json({ success: true, data });
  }),

  /** POST /torrents/:gid/pause */
  pause: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { gid } = req.params;
    const data = await torrentService.pauseTask(userId, gid);
    return res.json({ success: true, data });
  }),

  /** POST /torrents/:gid/resume */
  resume: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { gid } = req.params;
    const data = await torrentService.resumeTask(userId, gid);
    return res.json({ success: true, data });
  }),

  /**
   * DELETE /torrents/:gid
   * Satu endpoint untuk semua kasus "buang task":
   * - Task aktif/paused -> dibatalkan, file temp & file .torrent dihapus.
   * - Task error (gagal, tidak bisa resume) -> file temp yang tersisa dihapus.
   * - Task done/cancelled -> sekadar dibuang dari daftar (tidak ada file tersisa).
   */
  remove: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { gid } = req.params;
    await torrentService.removeTask(userId, gid);
    return res.json({ success: true, message: 'Task dihapus' });
  }),
};

module.exports = TorrentController;
