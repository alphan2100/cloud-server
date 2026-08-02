const FileModel = require("../models/file.model");
const FolderModel = require("../models/folder.model");
const pool = require("../config/db");
const fs = require("fs");
const path = require("path");
const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const CacheMiddleware = require('../middlewares/cache.middleware');
const { remuxVideo, isVideoFile } = require('../services/video-remux.service');
const { generateThumbnail, deleteThumbnail, getThumbnailPath } = require('../services/thumbnail.service');
const uploadService = require('../services/upload.service');
const MusicModel = require('../models/music.model');
const MusicScanService = require('../services/music-scan.service.js');

function normalizeFolderId(rawFolderId) {
  if (rawFolderId === 'null' || rawFolderId === '' || rawFolderId === undefined || rawFolderId === null) {
    return null;
  }

  return String(rawFolderId);
}

const FileController = {
  /**
   * POST /files/upload
   * Upload single file
   */
  upload: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const folder_id = normalizeFolderId(req.body.folder_id ?? req.query.folder_id);

    if (!req.file) {
      throw new AppError('File tidak ditemukan', 400, 'VALIDATION_ERROR');
    }

    const result = await uploadService.processFile({
      userId,
      folderId: folder_id,
      filePath: req.file.path,
      originalName: req.file.originalname,
      storedName: req.file.filename,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      isTemp: false,
    });

    return res.status(201).json({
      success: true,
      message: "File berhasil diupload",
      file_id: result.fileId,
      file: result.file,
    });
  }),

  /**
   * POST /files/upload-multiple
   * Upload multiple files sekaligus
   */
  uploadMultiple: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const folder_id = normalizeFolderId(req.body.folder_id ?? req.query.folder_id);

    if (!req.files || req.files.length === 0) {
      throw new AppError('Tidak ada file yang diupload', 400, 'VALIDATION_ERROR');
    }

    const uploadedFiles = [];
    const errors = [];

    for (const file of req.files) {
      try {
        const result = await uploadService.processFile({
          userId,
          folderId: folder_id,
          filePath: file.path,
          originalName: file.originalname,
          storedName: file.filename,
          fileSize: file.size,
          mimeType: file.mimetype,
          isTemp: false,
        });

        uploadedFiles.push({
          file_id: result.fileId,
          ...result.file,
        });
      } catch (err) {
        console.error('Gagal mengupload file:', file.originalname, err.message);
        errors.push({ file: file.originalname, error: err.message });
      }
    }

    return res.status(201).json({
      success: true,
      message: `${uploadedFiles.length} file berhasil diupload`,
      uploaded: uploadedFiles,
      errors: errors.length > 0 ? errors : undefined,
    });
  }),

  /**
   * DELETE /files/:id
   * Soft delete (pindahkan ke trash)
   */
  delete: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;

    const file = await FileModel.findById(id);

    if (!file) {
      throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (file.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    // Soft delete: set deleted_at alih-alih hapus fisik
    await pool.query(
      'UPDATE files SET deleted_at = NOW() WHERE id = ?',
      [id]
    );

    // Sync soft delete ke music.db (jika file adalah audio)
    try {
      MusicModel.softDeleteByFileId(id);
    } catch (err) {
      console.error('Gagal sync soft delete ke music.db:', err.message);
    }

    // NOTE: Thumbnail tidak dihapus saat soft delete
    // Thumbnail hanya akan dihapus saat permanent delete dari trash
    // Ini memungkinkan thumbnail tetap ada untuk file di trash

    CacheMiddleware.invalidateUser(userId);

    return res.json({
      success: true,
      message: "File dipindahkan ke trash",
    });
  }),

  /**
   * POST /files/:id/copy
   * Copy file to another folder (or same folder with new name)
   */
  copy: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;
    const { target_folder_id, new_name } = req.body;

    const file = await FileModel.findById(id);

    if (!file) {
      throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (file.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    // Determine target folder
    let targetFolderId = null;
    if (target_folder_id !== undefined && target_folder_id !== null && target_folder_id !== '') {
      targetFolderId = String(target_folder_id);
      // Verify target folder exists and belongs to user
      const targetFolder = await FolderModel.findById(targetFolderId);
      if (!targetFolder) {
        throw new AppError('Folder tujuan tidak ditemukan', 404, 'NOT_FOUND');
      }
      if (targetFolder.user_id !== userId) {
        throw new AppError('Akses ditolak ke folder tujuan', 403, 'FORBIDDEN');
      }
    }

    // Use provided name or original name
    const fileName = new_name || file.original_filename;
    const ext = path.extname(fileName);
    const baseName = path.basename(fileName, ext);

    // Handle duplicate names by adding suffix
    let finalName = fileName;
    let counter = 1;
    while (await FileModel.existsByName(userId, targetFolderId, finalName)) {
      finalName = `${baseName} (${counter})${ext}`;
      counter++;
    }

    // Generate new stored filename
    const newStoredFilename = `${Date.now()}-${finalName}`;
    const targetDir = path.join(
      process.env.UPLOADS_DIR,
      `user_${userId}`,
      targetFolderId === null ? 'folder_root' : `folder_${targetFolderId}`
    );
    const newFilePath = path.join(targetDir, newStoredFilename);

    // Create target directory if it doesn't exist
    await fs.promises.mkdir(targetDir, { recursive: true });

    // Copy file on disk
    await fs.promises.copyFile(file.file_path, newFilePath);

    // If original has thumbnail, copy it too
    const { thumbnailExists } = require('../services/thumbnail.service');
    if (thumbnailExists(file.file_path)) {
      try {
        const { generateThumbnail } = require('../services/thumbnail.service');
        await generateThumbnail(newFilePath, file.mime_type);
      } catch (err) {
        console.error(`Gagal menyalin thumbnail: ${err.message}`);
      }
    }

    // Create database record
    const newFileId = await FileModel.create({
      user_id: userId,
      folder_id: targetFolderId,
      original_filename: finalName,
      stored_filename: newStoredFilename,
      file_path: newFilePath,
      file_size: file.file_size,
      mime_type: file.mime_type,
    });

    CacheMiddleware.invalidateUser(userId);

    return res.status(201).json({
      success: true,
      message: "File berhasil disalin",
      file_id: newFileId,
      file: {
        original_name: finalName,
        stored_name: newStoredFilename,
        size: file.file_size,
        mime_type: file.mime_type,
      },
    });
  }),

  /**
   * PUT /files/:id/rename
   * Rename file
   */
  rename: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;
    const { new_name } = req.body;

    if (!new_name || typeof new_name !== "string") {
      throw new AppError('Nama baru tidak valid', 400, 'VALIDATION_ERROR');
    }

    const file = await FileModel.findById(id);

    if (!file) {
      throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (file.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    const dir = path.dirname(file.file_path);
    const currentExt = path.extname(file.stored_filename) || path.extname(file.original_filename) || "";

    const providedExt = path.extname(new_name);
    const baseName = providedExt ? path.basename(new_name, providedExt) : new_name;
    const finalExt = providedExt || currentExt;

    const originalFilename = providedExt ? new_name : `${new_name}${finalExt}`;

    // Cek duplikasi
    const duplicate = await FileModel.existsByName(userId, file.folder_id, originalFilename, id);
    if (duplicate) {
      throw new AppError('Sudah ada file dengan nama yang sama di folder ini', 409, 'CONFLICT');
    }

    const newStored = `${Date.now()}-${baseName}${finalExt}`;
    const newPath = path.join(dir, newStored);

    // Rename on disk
    await fs.promises.rename(file.file_path, newPath);

    // Rename thumbnail if exists
    const oldThumbPath = getThumbnailPath(file.file_path);
    if (fs.existsSync(oldThumbPath)) {
      const newThumbPath = getThumbnailPath(newPath);
      try {
        await fs.promises.rename(oldThumbPath, newThumbPath);
      } catch (err) {
        // Jika rename gagal, copy lalu hapus
        await fs.promises.copyFile(oldThumbPath, newThumbPath);
        await fs.promises.unlink(oldThumbPath);
      }
    }

    // Juga cek variant .jpg untuk video thumbnail
    const oldThumbJpg = oldThumbPath.replace(/\.\w+$/, '.jpg');
    if (oldThumbJpg !== oldThumbPath && fs.existsSync(oldThumbJpg)) {
      const newThumbJpg = getThumbnailPath(newPath).replace(/\.\w+$/, '.jpg');
      try {
        await fs.promises.rename(oldThumbJpg, newThumbJpg);
      } catch (err) {
        await fs.promises.copyFile(oldThumbJpg, newThumbJpg);
        await fs.promises.unlink(oldThumbJpg);
      }
    }

    const updated = await FileModel.updateFilename(id, originalFilename, newStored, newPath);

    CacheMiddleware.invalidateUser(userId);

    return res.json({
      success: true,
      message: "File berhasil di-rename",
      updated: !!updated,
      file: { original_name: originalFilename, stored_name: newStored },
    });
  }),

  /**
   * GET /files/:id
   * Get single file by ID
   */
  getById: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;

    const file = await FileModel.findById(id);

    if (!file) {
      throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (file.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    return res.json({ 
      success: true, 
      data: file 
    });
  }),

  /**
   * GET /files?folder_id=...
   * List files by folder with pagination
   * 
   * Query params:
   *   folder_id  - ID folder (null = root, default: null)
   *   recursive  - Jika 'true', ambil semua file user (abaikan folder_id)
   *   type       - Filter by mime_type prefix
   *   page       - Halaman (default: 1)
   *   limit      - Item per halaman (default: 50, max: 200)
   *   sort       - Kolom sorting (default: 'uploaded_at')
   *   order      - ASC atau DESC (default: 'DESC')
   */
  list: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const isRecursive = req.query.recursive === 'true';
    const typeFilter = req.query.type;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const sortCol = ['uploaded_at', 'original_filename', 'file_size', 'mime_type'].includes(req.query.sort) ? req.query.sort : 'uploaded_at';
    const sortOrder = req.query.order === 'ASC' ? 'ASC' : 'DESC';

    // Build WHERE clause
    const conditions = ['user_id = ? AND deleted_at IS NULL'];
    const params = [userId];

    if (!isRecursive) {
      let folderId = req.query.folder_id;
      if (folderId === undefined || folderId === 'null' || folderId === '') folderId = null;
      conditions.push('folder_id <=> ?');
      params.push(folderId);
    }

    // Type filter
    if (typeFilter) {
      if (typeFilter === 'archive') {
        conditions.push(`(
          mime_type LIKE 'application/zip' OR mime_type LIKE 'application/x-rar-compressed'
          OR mime_type LIKE 'application/x-7z-compressed' OR mime_type LIKE 'application/x-tar'
          OR mime_type LIKE 'application/gzip' OR mime_type LIKE 'application/x-bzip2'
          OR original_filename LIKE '%.zip' OR original_filename LIKE '%.rar'
          OR original_filename LIKE '%.7z' OR original_filename LIKE '%.tar'
          OR original_filename LIKE '%.gz' OR original_filename LIKE '%.bz2'
        )`);
      } else if (typeFilter === 'other') {
        conditions.push(`NOT (
          mime_type LIKE 'video/%' OR mime_type LIKE 'image/%' OR mime_type LIKE 'audio/%'
          OR mime_type LIKE 'text/%' OR mime_type LIKE 'application/pdf'
          OR mime_type LIKE 'application/msword'
          OR mime_type LIKE 'application/vnd.openxmlformats-officedocument.wordprocessingml%'
          OR mime_type LIKE 'application/vnd.ms-excel'
          OR mime_type LIKE 'application/vnd.openxmlformats-officedocument.spreadsheetml%'
          OR mime_type LIKE 'application/vnd.ms-powerpoint'
          OR mime_type LIKE 'application/vnd.openxmlformats-officedocument.presentationml%'
          OR mime_type LIKE 'application/zip' OR mime_type LIKE 'application/x-rar-compressed'
          OR mime_type LIKE 'application/x-7z-compressed' OR mime_type LIKE 'application/x-tar'
          OR mime_type LIKE 'application/gzip' OR mime_type LIKE 'application/x-bzip2'
          OR original_filename LIKE '%.zip' OR original_filename LIKE '%.rar'
          OR original_filename LIKE '%.7z' OR original_filename LIKE '%.tar'
          OR original_filename LIKE '%.gz' OR original_filename LIKE '%.bz2'
          OR mime_type LIKE 'application/json' OR mime_type LIKE 'application/xml'
          -- Also exclude files whose extension indicates a known category
          OR LOWER(original_filename) LIKE '%.mp4' OR LOWER(original_filename) LIKE '%.mkv'
          OR LOWER(original_filename) LIKE '%.avi' OR LOWER(original_filename) LIKE '%.mov'
          OR LOWER(original_filename) LIKE '%.webm' OR LOWER(original_filename) LIKE '%.m4v'
          OR LOWER(original_filename) LIKE '%.mpeg' OR LOWER(original_filename) LIKE '%.mpg'
          OR LOWER(original_filename) LIKE '%.wmv' OR LOWER(original_filename) LIKE '%.flv'
          OR LOWER(original_filename) LIKE '%.3gp' OR LOWER(original_filename) LIKE '%.ogv'
          OR LOWER(original_filename) LIKE '%.jpg' OR LOWER(original_filename) LIKE '%.jpeg'
          OR LOWER(original_filename) LIKE '%.png' OR LOWER(original_filename) LIKE '%.webp'
          OR LOWER(original_filename) LIKE '%.gif' OR LOWER(original_filename) LIKE '%.svg'
          OR LOWER(original_filename) LIKE '%.bmp' OR LOWER(original_filename) LIKE '%.ico'
          OR LOWER(original_filename) LIKE '%.mp3' OR LOWER(original_filename) LIKE '%.wav'
          OR LOWER(original_filename) LIKE '%.flac' OR LOWER(original_filename) LIKE '%.m4a'
          OR LOWER(original_filename) LIKE '%.aac' OR LOWER(original_filename) LIKE '%.ogg'
          OR LOWER(original_filename) LIKE '%.wma' OR LOWER(original_filename) LIKE '%.opus'
        )`);
      } else if (typeFilter === 'document') {
        conditions.push(`(
          mime_type LIKE 'text/%' OR mime_type LIKE 'application/pdf'
          OR mime_type LIKE 'application/msword'
          OR mime_type LIKE 'application/vnd.openxmlformats-officedocument.wordprocessingml%'
          OR mime_type LIKE 'application/vnd.ms-excel'
          OR mime_type LIKE 'application/vnd.openxmlformats-officedocument.spreadsheetml%'
          OR mime_type LIKE 'application/vnd.ms-powerpoint'
          OR mime_type LIKE 'application/vnd.openxmlformats-officedocument.presentationml%'
          OR mime_type LIKE 'application/json' OR mime_type LIKE 'application/xml'
        )`);
      } else if (typeFilter === 'video') {
        conditions.push(`(
          mime_type LIKE 'video/%'
          OR LOWER(original_filename) LIKE '%.mp4'
          OR LOWER(original_filename) LIKE '%.mkv'
          OR LOWER(original_filename) LIKE '%.avi'
          OR LOWER(original_filename) LIKE '%.mov'
          OR LOWER(original_filename) LIKE '%.webm'
          OR LOWER(original_filename) LIKE '%.m4v'
          OR LOWER(original_filename) LIKE '%.mpeg'
          OR LOWER(original_filename) LIKE '%.mpg'
          OR LOWER(original_filename) LIKE '%.wmv'
          OR LOWER(original_filename) LIKE '%.flv'
          OR LOWER(original_filename) LIKE '%.3gp'
          OR LOWER(original_filename) LIKE '%.ogv'
        )`);
      } else if (typeFilter === 'image') {
        conditions.push(`(
          mime_type LIKE 'image/%'
          OR LOWER(original_filename) LIKE '%.jpg'
          OR LOWER(original_filename) LIKE '%.jpeg'
          OR LOWER(original_filename) LIKE '%.png'
          OR LOWER(original_filename) LIKE '%.webp'
          OR LOWER(original_filename) LIKE '%.gif'
          OR LOWER(original_filename) LIKE '%.svg'
          OR LOWER(original_filename) LIKE '%.bmp'
          OR LOWER(original_filename) LIKE '%.ico'
        )`);
      } else if (typeFilter === 'audio') {
        conditions.push(`(
          mime_type LIKE 'audio/%'
          OR LOWER(original_filename) LIKE '%.mp3'
          OR LOWER(original_filename) LIKE '%.wav'
          OR LOWER(original_filename) LIKE '%.flac'
          OR LOWER(original_filename) LIKE '%.m4a'
          OR LOWER(original_filename) LIKE '%.aac'
          OR LOWER(original_filename) LIKE '%.ogg'
          OR LOWER(original_filename) LIKE '%.wma'
          OR LOWER(original_filename) LIKE '%.opus'
        )`);
      } else {
        conditions.push('mime_type LIKE ?');
        params.push(`${typeFilter}%`);
      }
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM files WHERE ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Get paginated data
    const [files] = await pool.query(
      `SELECT * FROM files WHERE ${whereClause} ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return res.json({
      success: true,
      data: files,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      }
    });
  }),
  /**
   * GET /files/storage-summary
   * Get total storage usage per category (for HomePage)
   * Returns aggregated data without listing all files
   */
  storageSummary: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const [rows] = await pool.query(
      `SELECT 
        SUM(file_size) as total,
        SUM(CASE WHEN mime_type LIKE 'video/%' THEN file_size ELSE 0 END) as videos,
        SUM(CASE WHEN mime_type LIKE 'image/%' THEN file_size ELSE 0 END) as images,
        SUM(CASE WHEN mime_type LIKE 'audio/%' THEN file_size ELSE 0 END) as music,
        SUM(CASE WHEN (
          mime_type LIKE 'text/%' OR mime_type LIKE 'application/pdf'
          OR mime_type LIKE 'application/msword'
          OR mime_type LIKE 'application/vnd.openxmlformats-officedocument.wordprocessingml%'
          OR mime_type LIKE 'application/vnd.ms-excel'
          OR mime_type LIKE 'application/vnd.openxmlformats-officedocument.spreadsheetml%'
          OR mime_type LIKE 'application/vnd.ms-powerpoint'
          OR mime_type LIKE 'application/vnd.openxmlformats-officedocument.presentationml%'
          OR mime_type LIKE 'application/json' OR mime_type LIKE 'application/xml'
        ) THEN file_size ELSE 0 END) as documents,
        SUM(CASE WHEN (
          mime_type LIKE 'application/zip' OR mime_type LIKE 'application/x-rar-compressed'
          OR mime_type LIKE 'application/x-7z-compressed' OR mime_type LIKE 'application/x-tar'
          OR mime_type LIKE 'application/gzip' OR mime_type LIKE 'application/x-bzip2'
          OR original_filename LIKE '%.zip' OR original_filename LIKE '%.rar'
          OR original_filename LIKE '%.7z' OR original_filename LIKE '%.tar'
          OR original_filename LIKE '%.gz' OR original_filename LIKE '%.bz2'
        ) THEN file_size ELSE 0 END) as archives,
        SUM(CASE WHEN (
          mime_type NOT LIKE 'video/%' AND mime_type NOT LIKE 'image/%'
          AND mime_type NOT LIKE 'audio/%' AND mime_type NOT LIKE 'text/%'
          AND mime_type NOT LIKE 'application/pdf'
          AND mime_type NOT LIKE 'application/msword'
          AND mime_type NOT LIKE 'application/vnd.openxmlformats-officedocument.wordprocessingml%'
          AND mime_type NOT LIKE 'application/vnd.ms-excel'
          AND mime_type NOT LIKE 'application/vnd.openxmlformats-officedocument.spreadsheetml%'
          AND mime_type NOT LIKE 'application/vnd.ms-powerpoint'
          AND mime_type NOT LIKE 'application/vnd.openxmlformats-officedocument.presentationml%'
          AND mime_type NOT LIKE 'application/zip' AND mime_type NOT LIKE 'application/x-rar-compressed'
          AND mime_type NOT LIKE 'application/x-7z-compressed' AND mime_type NOT LIKE 'application/x-tar'
          AND mime_type NOT LIKE 'application/gzip' AND mime_type NOT LIKE 'application/x-bzip2'
          AND original_filename NOT LIKE '%.zip' AND original_filename NOT LIKE '%.rar'
          AND original_filename NOT LIKE '%.7z' AND original_filename NOT LIKE '%.tar'
          AND original_filename NOT LIKE '%.gz' AND original_filename NOT LIKE '%.bz2'
          AND mime_type NOT LIKE 'application/json' AND mime_type NOT LIKE 'application/xml'
          -- Also exclude files whose extension indicates a known category
          AND LOWER(original_filename) NOT LIKE '%.mp4' AND LOWER(original_filename) NOT LIKE '%.mkv'
          AND LOWER(original_filename) NOT LIKE '%.avi' AND LOWER(original_filename) NOT LIKE '%.mov'
          AND LOWER(original_filename) NOT LIKE '%.webm' AND LOWER(original_filename) NOT LIKE '%.m4v'
          AND LOWER(original_filename) NOT LIKE '%.mpeg' AND LOWER(original_filename) NOT LIKE '%.mpg'
          AND LOWER(original_filename) NOT LIKE '%.wmv' AND LOWER(original_filename) NOT LIKE '%.flv'
          AND LOWER(original_filename) NOT LIKE '%.3gp' AND LOWER(original_filename) NOT LIKE '%.ogv'
          AND LOWER(original_filename) NOT LIKE '%.jpg' AND LOWER(original_filename) NOT LIKE '%.jpeg'
          AND LOWER(original_filename) NOT LIKE '%.png' AND LOWER(original_filename) NOT LIKE '%.webp'
          AND LOWER(original_filename) NOT LIKE '%.gif' AND LOWER(original_filename) NOT LIKE '%.svg'
          AND LOWER(original_filename) NOT LIKE '%.bmp' AND LOWER(original_filename) NOT LIKE '%.ico'
          AND LOWER(original_filename) NOT LIKE '%.mp3' AND LOWER(original_filename) NOT LIKE '%.wav'
          AND LOWER(original_filename) NOT LIKE '%.flac' AND LOWER(original_filename) NOT LIKE '%.m4a'
          AND LOWER(original_filename) NOT LIKE '%.aac' AND LOWER(original_filename) NOT LIKE '%.ogg'
          AND LOWER(original_filename) NOT LIKE '%.wma' AND LOWER(original_filename) NOT LIKE '%.opus'
        ) THEN file_size ELSE 0 END) as others
       FROM files
       WHERE user_id = ? AND deleted_at IS NULL`,
      [userId]
    );

    const row = rows[0];
    const totalStorage = row?.total || 0;

    const categories = {};
    const catMap = {
      videos: row?.videos || 0,
      images: row?.images || 0,
      music: row?.music || 0,
      documents: row?.documents || 0,
      archives: row?.archives || 0,
      others: row?.others || 0,
    };

    for (const [key, size] of Object.entries(catMap)) {
      categories[key] = {
        size: size,
        percentage: totalStorage > 0 ? (size / totalStorage) * 100 : 0,
      };
    }

    return res.json({
      success: true,
      data: {
        totalStorage,
        categories,
      }
    });
  }),
};

module.exports = FileController;
