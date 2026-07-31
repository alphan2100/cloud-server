const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const FileModel = require('../models/file.model');
const FolderModel = require('../models/folder.model');
const pool = require('../config/db');
const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const CacheMiddleware = require('../middlewares/cache.middleware');
const { deleteThumbnail, getThumbnailPath, generateThumbnail, thumbnailExists } = require('../services/thumbnail.service');
const { isVideoFile } = require('../services/video-remux.service');

const UPLOADS_DIR = process.env.UPLOADS_DIR;

const MoveController = {
  /**
   * PUT /move/file/:id
   * Memindahkan file ke folder lain
   */
  moveFile: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;
    const { target_folder_id } = req.body;

    const normalizedTargetId = target_folder_id === undefined || target_folder_id === null
      ? null
      : (target_folder_id === '' || target_folder_id === 'null' ? null : target_folder_id);

    const file = await FileModel.findById(id);

    if (!file) {
      throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (file.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    if (normalizedTargetId !== null) {
      const targetFolder = await FolderModel.findById(normalizedTargetId);
      if (!targetFolder) {
        throw new AppError('Folder tujuan tidak ditemukan', 404, 'NOT_FOUND');
      }
      if (targetFolder.user_id !== userId) {
        throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
      }
    }

    // Cek duplikasi nama di folder tujuan
    const duplicate = await FileModel.existsByName(userId, normalizedTargetId, file.original_filename, id);
    if (duplicate) {
      throw new AppError('File already exist', 409, 'CONFLICT');
    }

    // Pindahkan file fisik
    const oldPath = file.file_path;
    const targetDir = path.join(
      UPLOADS_DIR,
      `user_${userId}`,
      normalizedTargetId === null ? 'folder_root' : `folder_${normalizedTargetId}`
    );
    const newPath = path.join(targetDir, file.stored_filename);

    // Buat direktori tujuan jika belum ada
    await fs.mkdir(targetDir, { recursive: true });

    // Pindahkan file
    try {
      await fs.rename(oldPath, newPath);
    } catch (err) {
      // Jika rename gagal (beda partisi), copy lalu hapus
      await fs.copyFile(oldPath, newPath);
      await fs.unlink(oldPath);
    }

    // Pindahkan thumbnail jika ada
    const oldThumbPath = getThumbnailPath(oldPath);
    if (fsSync.existsSync(oldThumbPath)) {
      const newThumbPath = getThumbnailPath(newPath);
      const newThumbDir = path.dirname(newThumbPath);
      await fs.mkdir(newThumbDir, { recursive: true });
      try {
        await fs.rename(oldThumbPath, newThumbPath);
      } catch (err) {
        await fs.copyFile(oldThumbPath, newThumbPath);
        await fs.unlink(oldThumbPath);
      }
    }

    // Juga cek variant .jpg untuk video thumbnail
    const oldThumbJpg = oldThumbPath.replace(/\.\w+$/, '.jpg');
    if (oldThumbJpg !== oldThumbPath && fsSync.existsSync(oldThumbJpg)) {
      const newThumbJpg = getThumbnailPath(newPath).replace(/\.\w+$/, '.jpg');
      const newThumbJpgDir = path.dirname(newThumbJpg);
      await fs.mkdir(newThumbJpgDir, { recursive: true });
      try {
        await fs.rename(oldThumbJpg, newThumbJpg);
      } catch (err) {
        await fs.copyFile(oldThumbJpg, newThumbJpg);
        await fs.unlink(oldThumbJpg);
      }
    }

    // Update database
    await pool.query(
      `UPDATE files SET folder_id = ?, file_path = ? WHERE id = ?`,
      [normalizedTargetId, newPath, id]
    );

    // Hapus folder upload sumber jika kosong
    const oldDir = path.dirname(oldPath);
    if (fsSync.existsSync(oldDir)) {
      try {
        const remaining = fsSync.readdirSync(oldDir);
        if (remaining.length === 0) {
          fsSync.rmdirSync(oldDir);
        }
      } catch (e) { /* ignore */ }
    }

    // Hapus folder thumbnail sumber jika kosong
    const oldThumbDir = path.dirname(oldThumbPath);
    if (fsSync.existsSync(oldThumbDir)) {
      try {
        const remaining = fsSync.readdirSync(oldThumbDir);
        if (remaining.length === 0) {
          fsSync.rmdirSync(oldThumbDir);
        }
      } catch (e) { /* ignore */ }
    }

    CacheMiddleware.invalidateUser(userId);

    return res.json({
      success: true,
      message: 'File berhasil dipindahkan',
    });
  }),

  /**
   * PUT /move/folder/:id
   * Memindahkan folder ke folder lain (termasuk semua sub-folder dan file di dalamnya)
   */
  moveFolder: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;
    const { target_parent_id } = req.body;

    const normalizedTargetId = target_parent_id === undefined || target_parent_id === null
      ? null
      : (target_parent_id === '' || target_parent_id === 'null' ? null : target_parent_id);

    const folder = await FolderModel.findById(id);

    if (!folder) {
      throw new AppError('Folder tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (folder.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    if (normalizedTargetId !== null) {
      const targetFolder = await FolderModel.findById(normalizedTargetId);
      if (!targetFolder) {
        throw new AppError('Folder tujuan tidak ditemukan', 404, 'NOT_FOUND');
      }
      if (targetFolder.user_id !== userId) {
        throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
      }

      const descendantIds = await FolderModel.getAllDescendantIds(id);
      if (descendantIds.includes(Number(normalizedTargetId))) {
        throw new AppError('Tidak dapat memindahkan folder ke dalam sub-foldernya sendiri', 400, 'BAD_REQUEST');
      }
    }

    if (folder.parent_id === normalizedTargetId) {
      throw new AppError('Folder sudah berada di lokasi tersebut', 400, 'BAD_REQUEST');
    }

    // Update parent_id di database
    await pool.query(
      `UPDATE folders SET parent_id = ? WHERE id = ?`,
      [normalizedTargetId, id]
    );

    CacheMiddleware.invalidateUser(userId);

    return res.json({
      success: true,
      message: 'Folder berhasil dipindahkan',
    });
  }),

  /**
   * POST /copy/file/:id
   * Menyalin file ke folder lain (membuat duplikat)
   */
  copyFile: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;
    const { target_folder_id } = req.body;

    const normalizedTargetId = target_folder_id === undefined || target_folder_id === null
      ? null
      : (target_folder_id === '' || target_folder_id === 'null' ? null : target_folder_id);

    const file = await FileModel.findById(id);

    if (!file) {
      throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (file.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    if (normalizedTargetId !== null) {
      const targetFolder = await FolderModel.findById(normalizedTargetId);
      if (!targetFolder) {
        throw new AppError('Folder tujuan tidak ditemukan', 404, 'NOT_FOUND');
      }
      if (targetFolder.user_id !== userId) {
        throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
      }
    }

    // Cek duplikasi nama di folder tujuan
    const duplicate = await FileModel.existsByName(userId, normalizedTargetId, file.original_filename);
    if (duplicate) {
      throw new AppError('File already exist', 409, 'CONFLICT');
    }

    // Tentukan path baru untuk file salinan
    const targetDir = path.join(
      UPLOADS_DIR,
      `user_${userId}`,
      normalizedTargetId === null ? 'folder_root' : `folder_${normalizedTargetId}`
    );
    await fs.mkdir(targetDir, { recursive: true });

    // Buat nama stored filename baru (dengan timestamp baru)
    const timestamp = Date.now();
    const ext = path.extname(file.stored_filename);
    const baseName = path.basename(file.stored_filename, ext);
    const cleanBaseName = baseName.replace(/^\d+-/, '');
    const newStoredFilename = `${timestamp}-${cleanBaseName}${ext}`;
    const newPath = path.join(targetDir, newStoredFilename);

    // Copy file fisik
    await fs.copyFile(file.file_path, newPath);

    // Jika file adalah video, lakukan remux pada salinan
    if (isVideoFile(file.mime_type)) {
      try {
        const { remuxVideo } = require('../services/video-remux.service');
        await remuxVideo(newPath, newPath);
      } catch (err) {
        console.error(`Gagal remux video (copy) ${file.original_filename}: ${err.message}`);
      }
    }

    // Generate thumbnail untuk salinan
    try {
      await generateThumbnail(newPath, file.mime_type);
    } catch (err) {
      console.error(`Gagal membuat thumbnail (copy) ${file.original_filename}: ${err.message}`);
    }

    // Buat record database baru untuk file salinan
    const newFileId = await FileModel.create({
      user_id: userId,
      folder_id: normalizedTargetId,
      original_filename: file.original_filename,
      stored_filename: newStoredFilename,
      file_path: newPath,
      file_size: file.file_size,
      mime_type: file.mime_type,
    });

    CacheMiddleware.invalidateUser(userId);

    return res.json({
      success: true,
      message: 'File berhasil disalin',
      file_id: newFileId,
    });
  }),

  /**
   * POST /copy/folder/:id
   * Menyalin folder ke folder lain (membuat duplikat seluruh isinya)
   */
  copyFolder: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;
    const { target_parent_id } = req.body;

    const normalizedTargetId = target_parent_id === undefined || target_parent_id === null
      ? null
      : (target_parent_id === '' || target_parent_id === 'null' ? null : target_parent_id);

    const folder = await FolderModel.findById(id);

    if (!folder) {
      throw new AppError('Folder tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (folder.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    if (normalizedTargetId !== null) {
      const targetFolder = await FolderModel.findById(normalizedTargetId);
      if (!targetFolder) {
        throw new AppError('Folder tujuan tidak ditemukan', 404, 'NOT_FOUND');
      }
      if (targetFolder.user_id !== userId) {
        throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
      }
    }

    // Cek duplikasi nama di folder tujuan
    const duplicate = await FolderModel.existsByName(userId, normalizedTargetId, folder.folder_name);
    if (duplicate) {
      throw new AppError('Folder already exist', 409, 'CONFLICT');
    }

    // Buat folder baru
    const newFolderId = await FolderModel.create(userId, normalizedTargetId, folder.folder_name);

    // Salin semua file di dalam folder ini ke folder baru
    const files = await FileModel.findByFolderIdRecursive(id);
    for (const file of files) {
      const oldPath = file.file_path;
      const newDir = path.join(
        UPLOADS_DIR,
        `user_${userId}`,
        `folder_${newFolderId}`
      );
      await fs.mkdir(newDir, { recursive: true });

      const timestamp = Date.now();
      const ext = path.extname(file.stored_filename);
      const baseName = path.basename(file.stored_filename, ext);
      const cleanBaseName = baseName.replace(/^\d+-/, '');
      const newStoredFilename = `${timestamp}-${cleanBaseName}${ext}`;
      const newPath = path.join(newDir, newStoredFilename);

      // Copy file fisik
      await fs.copyFile(oldPath, newPath);

      // Jika video, remux salinan
      if (isVideoFile(file.mime_type)) {
        try {
          const { remuxVideo } = require('../services/video-remux.service');
          await remuxVideo(newPath, newPath);
        } catch (err) {
          console.error(`Gagal remux video (copy folder) ${file.original_filename}: ${err.message}`);
        }
      }

      // Generate thumbnail untuk salinan
      try {
        await generateThumbnail(newPath, file.mime_type);
      } catch (err) {
        console.error(`Gagal membuat thumbnail (copy folder) ${file.original_filename}: ${err.message}`);
      }

      // Buat record database baru
      await FileModel.create({
        user_id: userId,
        folder_id: newFolderId,
        original_filename: file.original_filename,
        stored_filename: newStoredFilename,
        file_path: newPath,
        file_size: file.file_size,
        mime_type: file.mime_type,
      });
    }

    // Salin semua sub-folder (rekursif)
    const subFolders = await FolderModel.findSubFolders(id);
    for (const subFolder of subFolders) {
      const newSubFolderId = await FolderModel.create(userId, newFolderId, subFolder.folder_name);

      const subFiles = await FileModel.findByFolderIdRecursive(subFolder.id);
      for (const file of subFiles) {
        const oldPath = file.file_path;
        const newDir = path.join(
          UPLOADS_DIR,
          `user_${userId}`,
          `folder_${newSubFolderId}`
        );
        await fs.mkdir(newDir, { recursive: true });

        const timestamp = Date.now();
        const ext = path.extname(file.stored_filename);
        const baseName = path.basename(file.stored_filename, ext);
        const cleanBaseName = baseName.replace(/^\d+-/, '');
        const newStoredFilename = `${timestamp}-${cleanBaseName}${ext}`;
        const newPath = path.join(newDir, newStoredFilename);

        await fs.copyFile(oldPath, newPath);

        if (isVideoFile(file.mime_type)) {
          try {
            const { remuxVideo } = require('../services/video-remux.service');
            await remuxVideo(newPath, newPath);
          } catch (err) {
            console.error(`Gagal remux video (copy subfolder) ${file.original_filename}: ${err.message}`);
          }
        }

        try {
          await generateThumbnail(newPath, file.mime_type);
        } catch (err) {
          console.error(`Gagal membuat thumbnail (copy subfolder) ${file.original_filename}: ${err.message}`);
        }

        await FileModel.create({
          user_id: userId,
          folder_id: newSubFolderId,
          original_filename: file.original_filename,
          stored_filename: newStoredFilename,
          file_path: newPath,
          file_size: file.file_size,
          mime_type: file.mime_type,
        });
      }

      const subSubFolders = await FolderModel.findSubFolders(subFolder.id);
      for (const subSubFolder of subSubFolders) {
        const newSubSubFolderId = await FolderModel.create(userId, newSubFolderId, subSubFolder.folder_name);

        const subSubFiles = await FileModel.findByFolderIdRecursive(subSubFolder.id);
        for (const file of subSubFiles) {
          const oldPath = file.file_path;
          const newDir = path.join(
            UPLOADS_DIR,
            `user_${userId}`,
            `folder_${newSubSubFolderId}`
          );
          await fs.mkdir(newDir, { recursive: true });

          const timestamp = Date.now();
          const ext = path.extname(file.stored_filename);
          const baseName = path.basename(file.stored_filename, ext);
          const cleanBaseName = baseName.replace(/^\d+-/, '');
          const newStoredFilename = `${timestamp}-${cleanBaseName}${ext}`;
          const newPath = path.join(newDir, newStoredFilename);

          await fs.copyFile(oldPath, newPath);

          if (isVideoFile(file.mime_type)) {
            try {
              const { remuxVideo } = require('../services/video-remux.service');
              await remuxVideo(newPath, newPath);
            } catch (err) {
              console.error(`Gagal remux video (copy subsubfolder) ${file.original_filename}: ${err.message}`);
            }
          }

          try {
            await generateThumbnail(newPath, file.mime_type);
          } catch (err) {
            console.error(`Gagal membuat thumbnail (copy subsubfolder) ${file.original_filename}: ${err.message}`);
          }

          await FileModel.create({
            user_id: userId,
            folder_id: newSubSubFolderId,
            original_filename: file.original_filename,
            stored_filename: newStoredFilename,
            file_path: newPath,
            file_size: file.file_size,
            mime_type: file.mime_type,
          });
        }
      }
    }

    CacheMiddleware.invalidateUser(userId);

    return res.json({
      success: true,
      message: 'Folder berhasil disalin',
      folder_id: newFolderId,
    });
  }),
};

module.exports = MoveController;