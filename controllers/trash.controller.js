const pool = require('../config/db');
const fs = require('fs');
const path = require('path');
const FileModel = require('../models/file.model');
const FolderModel = require('../models/folder.model');
const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const CacheMiddleware = require('../middlewares/cache.middleware');
const { deleteThumbnail, generateThumbnail, thumbnailExists } = require('../services/thumbnail.service');

const UPLOADS_DIR = process.env.UPLOADS_DIR;

const TrashController = {
  /**
   * GET /trash
   * Mendapatkan semua file & folder yang sudah di-soft-delete (trash)
   * Mengembalikan struktur: folders dengan files di dalamnya + files standalone
   */
  getTrash: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const [deletedFolders] = await pool.query(
      `SELECT id, folder_name, 'folder' as type, deleted_at
       FROM folders
       WHERE user_id = ? AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`,
      [userId]
    );

    const [deletedFiles] = await pool.query(
      `SELECT id, original_filename as name, 'file' as type, file_size, mime_type, folder_id, deleted_at
       FROM files
       WHERE user_id = ? AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`,
      [userId]
    );

    // Kelompokkan files ke dalam foldernya
    const trashedFolderIds = new Set(deletedFolders.map(f => f.id))
    
    // Files yang parent foldernya juga di-trash → masuk ke dalam folder
    // Files yang parent foldernya tidak di-trash atau null → standalone
    const foldersWithFiles = deletedFolders.map(folder => ({
      ...folder,
      files: deletedFiles.filter(f => f.folder_id === folder.id)
    }))

    // Files yang tidak memiliki folder (parent tidak di-trash atau null)
    const standaloneFiles = deletedFiles.filter(f => 
      f.folder_id === null || !trashedFolderIds.has(f.folder_id)
    )

    return res.json({ 
      success: true, 
      data: {
        folders: foldersWithFiles,
        files: standaloneFiles,
      }
    });
  }),

  /**
   * POST /trash/restore/:type/:id
   * Mengembalikan item dari trash (type: 'file' atau 'folder')
   */
  restore: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { type, id } = req.params;

    if (!['file', 'folder'].includes(type)) {
      return res.status(400).json({
        success: false, code: 'BAD_REQUEST',
        message: 'Tipe item harus "file" atau "folder"',
      });
    }

    if (type === 'folder') {
      // Cek folder exists
      const [folders] = await pool.query(
        `SELECT id FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`,
        [id, userId]
      );
      if (folders.length === 0) {
        return res.status(404).json({
          success: false, code: 'NOT_FOUND',
          message: 'Folder tidak ditemukan di trash',
        });
      }

      // Ambil semua descendant (sub-folder)
      const descendantIds = await FolderModel.getAllDescendantIds(id);
      const placeholders = descendantIds.map(() => '?').join(',');

      // Restore semua sub-folder
      await pool.query(
        `UPDATE folders SET deleted_at = NULL WHERE id IN (${placeholders})`,
        descendantIds
      );

      // Restore semua file di dalam folder-folder tersebut
      await pool.query(
        `UPDATE files SET deleted_at = NULL WHERE folder_id IN (${placeholders}) AND deleted_at IS NOT NULL`,
        descendantIds
      );

      // Auto-regenerate thumbnails for restored files
      const [restoredFiles] = await pool.query(
        `SELECT id, file_path, mime_type, original_filename FROM files WHERE folder_id IN (${placeholders}) AND deleted_at IS NULL`,
        descendantIds
      );

      for (const file of restoredFiles) {
        if (file.file_path && !thumbnailExists(file.file_path)) {
          try {
            await generateThumbnail(file.file_path, file.mime_type);
            console.log(`Thumbnail regenerated for restored file: ${file.original_filename}`);
          } catch (err) {
            console.error(`Failed to regenerate thumbnail for ${file.original_filename}:`, err.message);
          }
        }
      }
    } else {
      // type === 'file'
      const [files] = await pool.query(
        `SELECT id, folder_id FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`,
        [id, userId]
      );
      if (files.length === 0) {
        return res.status(404).json({
          success: false, code: 'NOT_FOUND',
          message: 'File tidak ditemukan di trash',
        });
      }

      const file = files[0];

      // Jika parent folder masih di trash, restore juga
      if (file.folder_id) {
        const [parents] = await pool.query(
          `SELECT id FROM folders WHERE id = ? AND deleted_at IS NOT NULL`,
          [file.folder_id]
        );
        if (parents.length > 0) {
          await pool.query(
            `UPDATE folders SET deleted_at = NULL WHERE id = ?`,
            [file.folder_id]
          );
        }
      }

      // Restore file
      await pool.query(
        `UPDATE files SET deleted_at = NULL WHERE id = ?`,
        [id]
      );

      // Auto-regenerate thumbnail if missing
      const restoredFile = await FileModel.findById(id);
      if (restoredFile && restoredFile.file_path && !thumbnailExists(restoredFile.file_path)) {
        try {
          await generateThumbnail(restoredFile.file_path, restoredFile.mime_type);
          console.log(`Thumbnail regenerated for restored file: ${restoredFile.original_filename}`);
        } catch (err) {
          console.error(`Failed to regenerate thumbnail for ${restoredFile.original_filename}:`, err.message);
        }
      }
    }

    CacheMiddleware.invalidateUser(userId);

    return res.json({
      success: true,
      message: `${type === 'file' ? 'File' : 'Folder'} berhasil dipulihkan`,
    });
  }),

  /**
   * DELETE /trash/:type/:id
   * Menghapus permanen item dari trash
   */
  deletePermanent: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { type, id } = req.params;

    if (!['file', 'folder'].includes(type)) {
      return res.status(400).json({
        success: false, code: 'BAD_REQUEST',
        message: 'Tipe item harus "file" atau "folder"',
      });
    }

    if (type === 'file') {
      const file = await FileModel.findById(id);

      if (!file || file.user_id !== userId) {
        return res.status(404).json({
          success: false, code: 'NOT_FOUND',
          message: 'File tidak ditemukan',
        });
      }

      // Hapus thumbnail jika ada
      if (file.file_path) {
        deleteThumbnail(file.file_path);
      }

      // Hapus folder thumbnail jika kosong
      try {
        const { getThumbnailPath } = require('../services/thumbnail.service');
        const thumbDir = path.dirname(getThumbnailPath(file.file_path));
        if (fs.existsSync(thumbDir)) {
          const remaining = fs.readdirSync(thumbDir);
          if (remaining.length === 0) {
            fs.rmdirSync(thumbDir);
          }
        }
      } catch (e) { /* ignore */ }

      // Hapus fisik file
      try {
        if (file.file_path && fs.existsSync(file.file_path)) {
          await fs.promises.unlink(file.file_path);
        }
      } catch (err) {
        console.error('Gagal menghapus file fisik:', err.message);
      }

      // Hapus record dari database (hard delete)
      await pool.query('DELETE FROM files WHERE id = ?', [id]);
    } else {
      const folder = await FolderModel.findById(id);

      if (!folder || folder.user_id !== userId) {
        return res.status(404).json({
          success: false, code: 'NOT_FOUND',
          message: 'Folder tidak ditemukan',
        });
      }

      // Hapus fisik semua file di folder ini dan sub-foldernya
      const folderIds = await FolderModel.getAllDescendantIds(id);
      const placeholders = folderIds.map(() => '?').join(',');

      const [filesInFolderTree] = await pool.query(
        `SELECT file_path FROM files WHERE user_id = ? AND folder_id IN (${placeholders})`,
        [userId, ...folderIds]
      );

      for (const file of filesInFolderTree) {
        if (file.file_path) {
          deleteThumbnail(file.file_path);
        }
        try {
          if (file.file_path && fs.existsSync(file.file_path)) {
            await fs.promises.unlink(file.file_path);
          }
        } catch (err) {
          console.error('Gagal menghapus file fisik:', err.message);
        }
      }

      // Hapus direktori folder + thumbnail mirror
      for (const folderId of folderIds) {
        const dirPath = path.join(UPLOADS_DIR, `user_${userId}`, `folder_${folderId}`);
        try {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
        } catch (e) {
          // Abaikan jika direktori tidak ada
        }

        // Hapus direktori thumbnail mirror
        const thumbDirPath = dirPath.replace(
          path.sep + 'uploads' + path.sep,
          path.sep + 'thumbnails' + path.sep
        );
        if (fs.existsSync(thumbDirPath)) {
          try {
            await fs.promises.rm(thumbDirPath, { recursive: true, force: true });
          } catch (e) { /* ignore */ }
        }
      }

      // Hard delete dari database (CASCADE akan menghapus file & sub-folder)
      await pool.query('DELETE FROM folders WHERE id = ?', [id]);
    }

    CacheMiddleware.invalidateUser(userId);

    return res.json({
      success: true,
      message: `${type === 'file' ? 'File' : 'Folder'} berhasil dihapus permanen`,
    });
  }),

  /**
   * DELETE /trash/empty
   * Mengosongkan seluruh trash user
   */
  emptyTrash: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    // ========== 1. Ambil semua folder yang di-trash + sub-folders ==========
    const [trashedFolders] = await pool.query(
      `SELECT id FROM folders WHERE user_id = ? AND deleted_at IS NOT NULL`,
      [userId]
    );

    let allFolderIds = [];
    for (const folder of trashedFolders) {
      const descendantIds = await FolderModel.getAllDescendantIds(folder.id);
      allFolderIds.push(...descendantIds);
    }
    allFolderIds = [...new Set(allFolderIds)];

    // ========== 2. Hapus fisik direktori folder + thumbnail mirror ==========
    for (const folderId of allFolderIds) {
      const dirPath = path.join(UPLOADS_DIR, `user_${userId}`, `folder_${folderId}`);
      try {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
      } catch (e) {
        // Abaikan jika direktori tidak ada
      }

      // Hapus direktori thumbnail mirror
      const thumbDirPath = dirPath.replace(
        path.sep + 'uploads' + path.sep,
        path.sep + 'thumbnails' + path.sep
      );
      if (fs.existsSync(thumbDirPath)) {
        try {
          await fs.promises.rm(thumbDirPath, { recursive: true, force: true });
        } catch (e) { /* ignore */ }
      }
    }

    // ========== 3. Hapus FILE di dalam folder yang di-trash ==========
    if (allFolderIds.length > 0) {
      const placeholders = allFolderIds.map(() => '?').join(',');
      const [filesInTrashedFolders] = await pool.query(
        `SELECT id, file_path FROM files WHERE user_id = ? AND folder_id IN (${placeholders})`,
        [userId, ...allFolderIds]
      );

      for (const file of filesInTrashedFolders) {
        if (file.file_path) {
          deleteThumbnail(file.file_path);
        }
        try {
          if (file.file_path && fs.existsSync(file.file_path)) {
            await fs.promises.unlink(file.file_path);
          }
        } catch (e) {
          // Abaikan error
        }
      }

      await pool.query(
        `DELETE FROM files WHERE user_id = ? AND folder_id IN (${placeholders})`,
        [userId, ...allFolderIds]
      );
    }

    // ========== 4. Hapus FOLDER yang di-trash (hard delete) ==========
    for (const folder of trashedFolders) {
      await pool.query('DELETE FROM folders WHERE id = ?', [folder.id]);
    }

    // ========== 5. Hapus FILE yang langsung di-trash (bukan di dalam folder) ==========
    const [directTrashedFiles] = await pool.query(
      `SELECT id, file_path FROM files WHERE user_id = ? AND deleted_at IS NOT NULL`,
      [userId]
    );

    for (const file of directTrashedFiles) {
      if (file.file_path) {
        deleteThumbnail(file.file_path);
      }
      try {
        if (file.file_path && fs.existsSync(file.file_path)) {
          await fs.promises.unlink(file.file_path);
        }
      } catch (e) {
        // Abaikan error
      }
    }

    await pool.query(
      `DELETE FROM files WHERE user_id = ? AND deleted_at IS NOT NULL`,
      [userId]
    );

    CacheMiddleware.invalidateUser(userId);

    return res.json({
      success: true,
      message: 'Trash berhasil dikosongkan',
    });
  }),
};

module.exports = TrashController;