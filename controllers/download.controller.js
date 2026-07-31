const fs = require('fs');
const path = require('path');
const FileModel = require('../models/file.model');
const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const { getThumbnailPath } = require('../services/thumbnail.service');
const { setContentDisposition } = require('../utils/header');
const ZipService = require('../services/zip.service');

const DownloadController = {
  /**
   * GET /files/:id/thumbnail
   * Serve thumbnail for a file (image or video).
   * Thumbnail path is derived from file_path without needing a DB field.
   */
  serveThumbnail: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;

    const file = await FileModel.findById(id);

    if (!file) {
      throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (file.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    // Derive thumbnail path from file's stored path
    let thumbPath = getThumbnailPath(file.file_path);
    
    // For video thumbnails, they're stored as .jpg
    if (!fs.existsSync(thumbPath)) {
      const jpgPath = thumbPath.replace(/\.\w+$/, '.jpg');
      if (fs.existsSync(jpgPath)) {
        thumbPath = jpgPath;
      }
    }

    if (!fs.existsSync(thumbPath)) {
      throw new AppError('Thumbnail tidak ditemukan', 404, 'NOT_FOUND');
    }

    // Determine content type
    const ext = path.extname(thumbPath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    };
    const contentType = mimeTypes[ext] || 'image/jpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 24 hours

    const stream = fs.createReadStream(thumbPath);
    stream.pipe(res);
  }),

  /**
   * GET /files/:id/download
   * Download file berdasarkan ID
   * Support range requests untuk streaming file besar
   */
  download: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;

    const file = await FileModel.findById(id);

    if (!file) {
      throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (file.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    if (!fs.existsSync(file.file_path)) {
      throw new AppError('File fisik tidak ditemukan di server', 404, 'NOT_FOUND');
    }

    const stat = fs.statSync(file.file_path);
    const fileSize = stat.size;

    // Set headers dasar
    res.setHeader('Content-Type', file.mime_type);
    setContentDisposition(res, 'attachment', file.original_filename);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Handle Range requests (untuk resume download / streaming video)
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);

      const stream = fs.createReadStream(file.file_path, { start, end });
      stream.pipe(res);
    } else {
      // Full file download - gunakan streaming untuk file besar
      res.setHeader('Content-Length', fileSize);

      const stream = fs.createReadStream(file.file_path);
      stream.pipe(res);
    }
  }),

  /**
   * GET /files/:id/view
   * Preview file (inline di browser, bukan download)
   */
  preview: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;

    const file = await FileModel.findById(id);

    if (!file) {
      throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
    }

    if (file.user_id !== userId) {
      throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
    }

    if (!fs.existsSync(file.file_path)) {
      throw new AppError('File fisik tidak ditemukan di server', 404, 'NOT_FOUND');
    }

    const fileSize = fs.statSync(file.file_path).size;
    const mimeType = file.mime_type;

    // Set header dasar
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Tentukan Content-Disposition berdasarkan tipe
    const isViewable = [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'application/pdf',
      'text/plain',
      // Office documents
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ].includes(mimeType);

    if (isViewable) {
      setContentDisposition(res, 'inline', file.original_filename);
    } else {
      setContentDisposition(res, 'attachment', file.original_filename);
    }

    // Handle Range requests (untuk video streaming / audio streaming)
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);

      const stream = fs.createReadStream(file.file_path, { start, end });
      stream.pipe(res);
    } else {
      // Full file stream
      res.setHeader('Content-Length', fileSize);

      const stream = fs.createReadStream(file.file_path);
      stream.pipe(res);
    }
  }),

  /**
   * POST /files/download-multiple
   * Download multiple files and folders as a zip archive
   * Streams files directly into zip without creating temp files
   * Supports both JSON and form-urlencoded body
   */
  downloadMultiple: asyncHandler(async (req, res) => {
    const userId = req.user.id
    
    // Handle both JSON and form-urlencoded body
    let items = req.body.items
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items)
      } catch (e) {
        throw new AppError('Format items tidak valid', 400, 'VALIDATION_ERROR')
      }
    }

    // Generate archive name with timestamp
    const date = new Date()
    const dateStr = date.toISOString().split('T')[0] // YYYY-MM-DD
    const archiveName = `files_${dateStr}.zip`

    try {
      // Use ZipService to stream the zip
      await ZipService.createZipStream(res, items, userId, archiveName)
    } catch (err) {
      console.error('[Download] Error creating zip stream:', err)
      // If headers already sent, we can't send error response
      if (!res.headersSent) {
        throw new AppError('Gagal membuat file zip', 500, 'ZIP_ERROR')
      }
    }
  }),
};

module.exports = DownloadController;
