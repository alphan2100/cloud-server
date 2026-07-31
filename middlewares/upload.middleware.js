const multer = require('multer');
const path = require('path');
const fs = require('fs');

function normalizeFolderId(rawFolderId) {
  if (
    rawFolderId === undefined ||
    rawFolderId === null ||
    rawFolderId === '' ||
    rawFolderId === 'null'
  ) {
    return 'root';
  }

  const folderId = String(rawFolderId);
  return /^\d+$/.test(folderId) ? folderId : null;
}

const storage = multer.diskStorage({

  destination(req, file, cb) {

    const userId = req.user.id;
    const folderId = normalizeFolderId(req.body.folder_id ?? req.query.folder_id);

    if (folderId === null) {
      return cb(new Error('folder_id tidak valid'));
    }

    const uploadDir = path.join(
      process.env.UPLOADS_DIR,
      `user_${userId}`,
      `folder_${folderId}`
    );

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, {
        recursive: true,
      });
    }

    cb(null, uploadDir);
  },

  filename(req, file, cb) {

    const ext = path.extname(file.originalname);

    const uniqueName =
      `${Date.now()}-${Math.random()
        .toString(36)
        .substring(2)}${ext}`;

    cb(null, uniqueName);
  },

});

function fileFilter(req, file, cb) {
  // Skip metadata files (macOS .DS_Store, ._, Windows Thumbs.db, desktop.ini)
  const name = file.originalname;
  if (name === '.DS_Store' || name.startsWith('._') ||
      name === 'Thumbs.db' || name === 'desktop.ini') {
    return cb(null, false); // reject silently
  }
  // Izinkan semua file lainnya
  cb(null, true);
}

// Get max file size from environment variable (default: 5GB)
const getMaxFileSize = () => {
  const envSize = process.env.MAX_FILE_SIZE;
  if (envSize && !isNaN(parseInt(envSize))) {
    return parseInt(envSize);
  }
  // Default to 5GB if not set or invalid
  return 5 * 1024 * 1024 * 1024;
};

// Regular upload middleware
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: getMaxFileSize(),
  },
});

// Chunk upload middleware with smaller size limit per chunk
const chunkUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const userId = req.user.id;
      const tempDir = path.join(process.env.UPLOADS_DIR, 'temp', `user_${userId}`);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      cb(null, tempDir);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname);
      const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2)}${ext}`;
      cb(null, uniqueName);
    },
  }),
  fileFilter: (req, file, cb) => {
    // Accept all file types for chunks
    cb(null, true);
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per chunk
  },
});

module.exports = {
  upload,
  chunkUpload,
};
