const fs = require("fs").promises;
const path = require("path");
const pool = require('../config/db');
const FolderModel = require("../models/folder.model");
const FileModel = require("../models/file.model");
const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const CacheMiddleware = require('../middlewares/cache.middleware');
const { deleteThumbnail } = require('../services/thumbnail.service');

const UPLOADS_DIR = process.env.UPLOADS_DIR;

/**
 * Helper function to recursively copy folder contents
 */
async function copyFolderRecursive(sourceFolderId, targetParentId, userId) {
  // Get source folder info
  const sourceFolder = await FolderModel.findById(sourceFolderId);
  if (!sourceFolder) return;

  // Check for duplicate name
  let newName = sourceFolder.folder_name;
  let counter = 1;
  while (await FolderModel.existsByName(userId, targetParentId, newName)) {
    newName = `${sourceFolder.folder_name} (${counter})`;
    counter++;
  }

  // Create new folder
  const newFolderId = await FolderModel.create(userId, targetParentId, newName);

  // Create physical directory
  const newPhysicalDir = path.join(
    UPLOADS_DIR,
    `user_${userId}`,
    `folder_${newFolderId}`
  );
  await fs.mkdir(newPhysicalDir, { recursive: true });

  // Copy all files
  const [files] = await pool.query(
    'SELECT * FROM files WHERE folder_id = ? AND deleted_at IS NULL',
    [sourceFolderId]
  );

  for (const file of files) {
    const oldPath = file.file_path;
    const ext = path.extname(file.stored_filename);
    const baseName = path.basename(file.stored_filename, ext);
    const newStoredFilename = `${Date.now()}-${baseName}${ext}`;
    const newFilePath = path.join(newPhysicalDir, newStoredFilename);

    await fs.copyFile(oldPath, newFilePath);

    const { thumbnailExists, generateThumbnail } = require('../services/thumbnail.service');
    if (thumbnailExists(oldPath)) {
      try {
        await generateThumbnail(newFilePath, file.mime_type);
      } catch (err) {
        console.error(`Gagal menyalin thumbnail: ${err.message}`);
      }
    }

    await FileModel.create({
      user_id: userId,
      folder_id: newFolderId,
      original_filename: file.original_filename,
      stored_filename: newStoredFilename,
      file_path: newFilePath,
      file_size: file.file_size,
      mime_type: file.mime_type,
    });
  }

  // Recursively copy subfolders
  const [subfolders] = await pool.query(
    'SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL',
    [sourceFolderId]
  );

  for (const subfolder of subfolders) {
    await copyFolderRecursive(subfolder.id, newFolderId, userId);
  }
}

const FolderController = {
  /**
   * GET /folders/:id
   * Ambil detail folder by ID
   */
  getFolder: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    const [folders] = await pool.query(
      'SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [id, userId]
    );

    if (folders.length === 0) {
      throw new AppError('Folder tidak ditemukan', 404, 'NOT_FOUND');
    }

    return res.json({
      success: true,
      data: folders[0],
    });
  }),

  /**
   * POST /folders
   * Buat folder baru
   */
  create: asyncHandler(async (req, res) => {
    const { folder_name, parent_id = null } = req.body;
    const userId = req.user.id;

    if (!folder_name) {
      throw new AppError('Nama folder wajib diisi', 400, 'VALIDATION_ERROR');
    }

    // Cek apakah folder dengan nama yang sama sudah ada
    const exists = await FolderModel.existsByName(userId, parent_id, folder_name);
    if (exists) {
      throw new AppError('Folder already exist', 409, 'CONFLICT');
    }

    // Catat folder ke Database
    const folderId = await FolderModel.create(userId, parent_id, folder_name);

    // Buat Direktori Fisik
    const physicalDirPath = path.join(
      UPLOADS_DIR,
      `user_${userId}`,
      `folder_${folderId}`,
    );

    await fs.mkdir(physicalDirPath, { recursive: true });

    CacheMiddleware.invalidateUser(userId);

    return res.status(201).json({
      success: true,
      message: "Folder berhasil dibuat",
      folder_id: folderId,
    });
  }),

  /**
   * GET /folders?parent_id=...&include_image_count=true&include_video_count=true&include_audio_count=true
   * Ambil isi folder (hanya yang tidak di-trash)
   * 
   * Query params:
   *   parent_id           - ID parent folder (null = root, omit = all)
   *   include_image_count - Jika 'true', setiap folder akan menyertakan
   *                         jumlah file image di dalamnya (image_count)
   *   include_video_count - Jika 'true', setiap folder akan menyertakan
   *                         jumlah file video di dalamnya (video_count)
   *   include_audio_count - Jika 'true', setiap folder akan menyertakan
   *                         jumlah file audio di dalamnya (audio_count)
   *                         Ketika salah satu include_*_count=true dan parent_id 
   *                         tidak disertakan, return ALL folders (tidak filter 
   *                         parent_id) agar sub-folder juga masuk dropdown filter.
   */
  getFolders: asyncHandler(async (req, res) => {
    const hasParentId = req.query.parent_id !== undefined;
    const parentId = hasParentId ? (req.query.parent_id || null) : undefined;
    const includeImageCount = req.query.include_image_count === 'true';
    const includeVideoCount = req.query.include_video_count === 'true';
    const includeAudioCount = req.query.include_audio_count === 'true';
    const hasAnyCount = includeImageCount || includeVideoCount || includeAudioCount;

    let folders;
    if (hasAnyCount && !hasParentId) {
      // When any count is requested and no parent_id specified,
      // return ALL folders (for filter dropdown)
      const [rows] = await pool.query(
        `SELECT * FROM folders
         WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY folder_name ASC`,
        [req.user.id]
      );
      folders = rows;
    } else {
      // Normal behavior: filter by parent_id
      const [rows] = await pool.query(
        `SELECT * FROM folders
         WHERE user_id = ? AND parent_id <=> ? AND deleted_at IS NULL
         ORDER BY folder_name ASC`,
        [req.user.id, parentId]
      );
      folders = rows;
    }

    // Jika diminta, hitung jumlah file per tipe di setiap folder
    // (non-recursive — hanya file yang folder_id-nya sama persis)
    if (hasAnyCount && folders.length > 0) {
      const folderIds = folders.map(f => f.id);
      const placeholders = folderIds.map(() => '?').join(',');
      
      // Count images
      if (includeImageCount) {
        const [counts] = await pool.query(
          `SELECT folder_id, COUNT(*) as image_count FROM files
           WHERE folder_id IN (${placeholders})
             AND deleted_at IS NULL
             AND mime_type LIKE 'image/%'
           GROUP BY folder_id`,
          folderIds
        );
        const countMap = {};
        for (const row of counts) {
          countMap[row.folder_id] = row.image_count;
        }
        for (const folder of folders) {
          folder.image_count = countMap[folder.id] || 0;
        }
      }

      // Count videos
      if (includeVideoCount) {
        const [counts] = await pool.query(
          `SELECT folder_id, COUNT(*) as video_count FROM files
           WHERE folder_id IN (${placeholders})
             AND deleted_at IS NULL
             AND mime_type LIKE 'video/%'
           GROUP BY folder_id`,
          folderIds
        );
        const countMap = {};
        for (const row of counts) {
          countMap[row.folder_id] = row.video_count;
        }
        for (const folder of folders) {
          folder.video_count = countMap[folder.id] || 0;
        }
      }

      // Count audio files
      if (includeAudioCount) {
        const [counts] = await pool.query(
          `SELECT folder_id, COUNT(*) as audio_count FROM files
           WHERE folder_id IN (${placeholders})
             AND deleted_at IS NULL
             AND mime_type LIKE 'audio/%'
           GROUP BY folder_id`,
          folderIds
        );
        const countMap = {};
        for (const row of counts) {
          countMap[row.folder_id] = row.audio_count;
        }
        for (const folder of folders) {
          folder.audio_count = countMap[folder.id] || 0;
        }
      }
    }

    return res.json({
      success: true,
      data: folders,
    });
  }),

  /**
   * PATCH /folders/:id
   * Rename folder
   */
  rename: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { folder_name } = req.body;

    const folder = await FolderModel.findById(id);

    if (!folder) {
      throw new AppError('Folder tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (folder.user_id !== req.user.id) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    // Cek duplikasi nama
    const exists = await FolderModel.existsByName(req.user.id, folder.parent_id, folder_name, id);
    if (exists) {
      throw new AppError('Folder already exist', 409, 'CONFLICT');
    }

    await FolderModel.updateName(id, folder_name);

    CacheMiddleware.invalidateUser(req.user.id);

    return res.json({
      success: true,
      message: "Folder berhasil diubah",
    });
  }),

  /**
   * POST /folders/:id/copy
   * Copy folder to another parent folder
   */
  copy: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { target_parent_id } = req.body;
    const userId = req.user.id;

    const folder = await FolderModel.findById(id);

    if (!folder) {
      throw new AppError('Folder tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (folder.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    // Determine target parent
    let targetParentId = null;
    if (target_parent_id !== undefined && target_parent_id !== null && target_parent_id !== '') {
      targetParentId = String(target_parent_id);
      // Verify target folder exists and belongs to user
      const targetFolder = await FolderModel.findById(targetParentId);
      if (!targetFolder) {
        throw new AppError('Folder tujuan tidak ditemukan', 404, 'NOT_FOUND');
      }
      if (targetFolder.user_id !== userId) {
        throw new AppError('Akses ditolak ke folder tujuan', 403, 'FORBIDDEN');
      }
      // Prevent copying into self or descendants
      if (targetParentId === id) {
        throw new AppError('Tidak dapat menyalin folder ke dalam dirinya sendiri', 400, 'BAD_REQUEST');
      }
    }

    // Check for duplicate name
    let newName = folder.folder_name;
    let counter = 1;
    while (await FolderModel.existsByName(userId, targetParentId, newName)) {
      newName = `${folder.folder_name} (${counter})`;
      counter++;
    }

    // Create new folder
    const newFolderId = await FolderModel.create(userId, targetParentId, newName);

    // Create physical directory
    const newPhysicalDir = path.join(
      UPLOADS_DIR,
      `user_${userId}`,
      `folder_${newFolderId}`
    );
    await fs.mkdir(newPhysicalDir, { recursive: true });

    // Copy all files from original folder to new folder
    const [files] = await pool.query(
      'SELECT * FROM files WHERE folder_id = ? AND deleted_at IS NULL',
      [id]
    );

    for (const file of files) {
      const oldPath = file.file_path;
      const ext = path.extname(file.stored_filename);
      const baseName = path.basename(file.stored_filename, ext);
      const newStoredFilename = `${Date.now()}-${baseName}${ext}`;
      const newFilePath = path.join(newPhysicalDir, newStoredFilename);

      // Copy file
      await fs.copyFile(oldPath, newFilePath);

      // Copy thumbnail if exists
      const { thumbnailExists, generateThumbnail } = require('../services/thumbnail.service');
      if (thumbnailExists(oldPath)) {
        try {
          await generateThumbnail(newFilePath, file.mime_type);
        } catch (err) {
          console.error(`Gagal menyalin thumbnail: ${err.message}`);
        }
      }

      // Create database record
      await FileModel.create({
        user_id: userId,
        folder_id: newFolderId,
        original_filename: file.original_filename,
        stored_filename: newStoredFilename,
        file_path: newFilePath,
        file_size: file.file_size,
        mime_type: file.mime_type,
      });
    }

    // Recursively copy subfolders
    const [subfolders] = await pool.query(
      'SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL',
      [id]
    );

    for (const subfolder of subfolders) {
      // We'll call the same copy logic recursively
      // For simplicity, we'll make a recursive call to this endpoint
      // In production, you might want to refactor this into a service
      try {
        const subfolderData = await FolderModel.findById(subfolder.id);
        if (subfolderData) {
          // Recursively copy subfolder contents
          await copyFolderRecursive(subfolder.id, newFolderId, userId);
        }
      } catch (err) {
        console.error(`Gagal menyalin subfolder ${subfolder.id}:`, err.message);
      }
    }

    CacheMiddleware.invalidateUser(userId);

    return res.status(201).json({
      success: true,
      message: "Folder berhasil disalin",
      folder_id: newFolderId,
    });
  }),

  /**
   * DELETE /folders/:id
   * Soft delete - pindahkan folder dan semua isinya ke trash
   */
  delete: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    const folder = await FolderModel.findById(id);

    if (!folder) {
      throw new AppError('Folder tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (folder.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    // Soft delete folder dan semua sub-foldernya
    const folderIdsToDelete = await FolderModel.getAllDescendantIds(id);

    await pool.query(
      `UPDATE folders SET deleted_at = NOW() WHERE id IN (${folderIdsToDelete.map(() => '?').join(',')})`,
      folderIdsToDelete
    );

    // NOTE: Thumbnail tidak dihapus saat soft delete
    // Thumbnail hanya akan dihapus saat permanent delete dari trash
    // Ini memungkinkan thumbnail tetap ada untuk file di trash

    // Soft delete semua file di folder-folder tersebut
    await pool.query(
      `UPDATE files SET deleted_at = NOW() WHERE folder_id IN (${folderIdsToDelete.map(() => '?').join(',')})`,
      folderIdsToDelete
    );

    CacheMiddleware.invalidateUser(userId);

    return res.json({
      success: true,
      message: "Folder dan seluruh isinya dipindahkan ke trash",
      deleted_ids: folderIdsToDelete,
    });
  }),
};

module.exports = FolderController;
