const multer = require('multer');

// Simpan di memori saja (bukan disk) - file .torrent cuma dipakai sebentar
// untuk dibaca lalu diserahkan ke aria2, tidak pernah perlu disimpan permanen.
const torrentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB cukup untuk file .torrent mana pun
  },
  fileFilter(req, file, cb) {
    if (!file.originalname.toLowerCase().endsWith('.torrent')) {
      return cb(new Error('File harus berformat .torrent'));
    }
    cb(null, true);
  },
});

module.exports = { torrentUpload };
