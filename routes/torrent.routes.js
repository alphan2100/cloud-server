const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
const { torrentUpload } = require('../middlewares/torrent-upload.middleware');
const TorrentController = require('../controllers/torrent.controller');

// Preview info file sebelum download dimulai
router.post(
  '/preview',
  authMiddleware,
  torrentUpload.single('torrent'),
  TorrentController.preview
);

// Mulai download
router.post(
  '/start',
  authMiddleware,
  torrentUpload.single('torrent'),
  TorrentController.start
);

// Polling progress
router.get('/:gid/status', authMiddleware, TorrentController.status);

// Pause / resume
router.post('/:gid/pause', authMiddleware, TorrentController.pause);
router.post('/:gid/resume', authMiddleware, TorrentController.resume);

// Cancel (aktif) atau cleanup (gagal) atau buang dari daftar (selesai/dibatalkan)
router.delete('/:gid', authMiddleware, TorrentController.remove);

module.exports = router;
