const FileModel = require('../models/file.model');
const FolderModel = require('../models/folder.model');
const pool = require('../config/db');
const fs = require('fs');
const path = require('path');
const { AppError } = require('../middlewares/error.middleware');
const CacheMiddleware = require('../middlewares/cache.middleware');
const { remuxVideo, isVideoFile } = require('./video-remux.service');
const { generateThumbnail, deleteThumbnail, getThumbnailPath } = require('./thumbnail.service');
const { normalizeMimeType, isVideoFile: isVideoDetect } = require('../utils/mime-detector');

class UploadService {
  /**
   * Process and store an uploaded file
   * @param {Object} options
   * @param {number} options.userId
   * @param {string|null} options.folderId
   * @param {string} options.filePath - Path to the temp file
   * @param {string} options.originalName
   * @param {string} options.storedName
   * @param {number} options.fileSize
   * @param {string} options.mimeType
   * @param {boolean} options.isTemp - If true, file is in temp dir and needs to be moved
   * @returns {Promise<Object>} { fileId, file }
   */
  async processFile({ userId, folderId, filePath, originalName, storedName, fileSize, mimeType, isTemp = false }) {
    // Normalize MIME type: detect from extension if browser sent incorrect type
    // (e.g., MKV files often come as 'application/octet-stream' instead of 'video/x-matroska')
    mimeType = normalizeMimeType(mimeType, originalName);

    // 1. Validasi folder milik user
    if (folderId !== null) {
      const folder = await FolderModel.findById(folderId);
      if (!folder) {
        throw new AppError('Folder tidak ditemukan', 404, 'NOT_FOUND');
      }
      if (folder.user_id !== userId) {
        throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
      }
    }

    // 2. Cek duplikasi nama
    const exists = await FileModel.existsByName(userId, folderId, originalName);
    if (exists) {
      // Hapus file sementara
      try {
        if (filePath && fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath);
        }
      } catch (e) {
        console.error('Gagal menghapus file saat konflik nama:', e.message);
      }
      throw new AppError('File already exist', 409, 'CONFLICT');
    }

    // 3. Tentukan path tujuan akhir
    const targetDir = path.join(
      process.env.UPLOADS_DIR,
      `user_${userId}`,
      folderId === null ? 'folder_root' : `folder_${folderId}`
    );

    // 4. Buat direktori jika belum ada
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetPath = path.join(targetDir, storedName);

    // 5. Jika file berasal dari temp, pindahkan ke lokasi final
    if (isTemp) {
      await fs.promises.rename(filePath, targetPath);
    } else if (filePath !== targetPath) {
      // Copy jika perlu
      await fs.promises.copyFile(filePath, targetPath);
      // Hapus source jika berbeda
      if (filePath !== targetPath && fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    }

    // 6. Simpan ke database
    const fileId = await FileModel.create({
      user_id: userId,
      folder_id: folderId,
      original_filename: originalName,
      stored_filename: storedName,
      file_path: targetPath,
      file_size: fileSize,
      mime_type: mimeType,
    });

    // 7. Auto-remux video untuk streaming support
    if (isVideoFile(mimeType)) {
      try {
        await remuxVideo(targetPath, targetPath);
        console.log(`Video remux selesai: ${originalName}`);
      } catch (err) {
        console.error(`Gagal remux video ${originalName}: ${err.message}`);
      }
    }

    // 8. Generate thumbnail untuk gambar dan video
    try {
      await generateThumbnail(targetPath, mimeType);
    } catch (err) {
      console.error(`Gagal membuat thumbnail ${originalName}: ${err.message}`);
    }

    // 9. Invalidate cache
    CacheMiddleware.invalidateUser(userId);

    return {
      fileId,
      file: {
        original_name: originalName,
        stored_name: storedName,
        size: fileSize,
        mime_type: mimeType,
      },
    };
  }
}

module.exports = new UploadService();