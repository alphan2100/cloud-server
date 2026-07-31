const FileModel = require("../models/file.model");
const FolderModel = require("../models/folder.model");
const fs = require("fs");
const path = require("path");
const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const CacheMiddleware = require('../middlewares/cache.middleware');
const { remuxVideo, isVideoFile } = require('../services/video-remux.service');
const { generateThumbnail } = require('../services/thumbnail.service');
const { normalizeMimeType } = require('../utils/mime-detector');

// Store for temporary chunk data (in production, use Redis or similar)
const chunkStore = new Map();

// Chunk size must match frontend (5MB)
const CHUNK_SIZE = 5 * 1024 * 1024

function normalizeFolderId(rawFolderId) {
  if (rawFolderId === 'null' || rawFolderId === '' || rawFolderId === undefined || rawFolderId === null) {
    return null;
  }
  return String(rawFolderId);
}

function cleanupChunkFiles(chunkData) {
  if (!chunkData) return;
  chunkData.chunks.forEach(chunkPath => {
    if (chunkPath && fs.existsSync(chunkPath)) {
      try { fs.unlinkSync(chunkPath); } catch (e) {}
    }
  });
}

const ChunkedUploadController = {
  /**
   * POST /files/upload-chunk
   * Upload a single chunk of a large file
   */
  uploadChunk: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const folderId = normalizeFolderId(req.body.folder_id ?? req.query.folder_id);
    const chunk = req.file;
    const chunkIndex = parseInt(req.body.chunk_index);
    const totalChunks = parseInt(req.body.total_chunks);
    const fileHash = req.body.file_hash;
    const fileName = req.body.file_name;
    const fileType = req.body.file_type;
    const totalSize = parseInt(req.body.total_size);

    if (!chunk) {
      throw new AppError('Chunk tidak ditemukan', 400, 'VALIDATION_ERROR');
    }

    if (isNaN(chunkIndex) || isNaN(totalChunks) || chunkIndex < 0 || totalChunks <= 0) {
      throw new AppError('Parameter chunk tidak valid', 400, 'VALIDATION_ERROR');
    }

    // Create temporary directory for chunks if not exists
    const tempDir = path.join(process.env.UPLOADS_DIR, 'temp', `user_${userId}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Store chunk temporarily
    const chunkKey = `${userId}-${fileHash}`;
    if (!chunkStore.has(chunkKey)) {
      chunkStore.set(chunkKey, {
        chunks: [],
        fileName,
        fileType,
        totalSize,
        folderId,
        totalChunks,
      });
    }

    const chunkData = chunkStore.get(chunkKey);
    chunkData.chunks[chunkIndex] = chunk.path;

    // Verify all chunks are present (check for gaps)
    // CRITICAL: Must check each index explicitly because .every() skips holes in sparse arrays
    let allChunksPresent = true
    for (let i = 0; i < totalChunks; i++) {
      if (!chunkData.chunks[i]) {
        allChunksPresent = false
        break
      }
    }

    // If this is the last chunk and all chunks are present, assemble the file
    if (allChunksPresent && chunkData.chunks.length >= totalChunks) {
      let finalPath = null;
      let fd = null;

      try {
        // Verify folder ownership
        if (folderId !== null) {
          const folder = await FolderModel.findById(folderId);
          if (!folder) {
            throw new AppError('Folder tidak ditemukan', 404, 'NOT_FOUND');
          }
          if (folder.user_id !== userId) {
            throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
          }
        }

        // Check for duplicate filename
        const exists = await FileModel.existsByName(userId, folderId, fileName);
        if (exists) {
          cleanupChunkFiles(chunkData);
          chunkStore.delete(chunkKey);
          throw new AppError('File already exist', 409, 'CONFLICT');
        }

        // Create final upload directory
        const uploadDir = path.join(
          process.env.UPLOADS_DIR,
          `user_${userId}`,
          `folder_${folderId || 'root'}`
        );
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        // Generate final filename
        const ext = path.extname(fileName);
        const finalFilename = `${Date.now()}-${Math.random().toString(36).substring(2)}${ext}`;
        finalPath = path.join(uploadDir, finalFilename);

        // Assemble chunks into final file in correct order.
        //
        // NOTE: fs.createWriteStream().write() in a tight synchronous loop was
        // used before, but for very large files (many hundreds of chunks) it
        // triggers a Node.js bug: unflushed writes get batched into a single
        // writev() syscall, which fails once the buffer count exceeds the OS
        // IOV_MAX limit (~1024 on Linux). Node then throws a confusing
        // "SystemError: writev failed" with undefined errno/syscall, and the
        // partially-written file is left behind (looks "there but corrupt").
        //
        // Fix: write each chunk synchronously to a raw file descriptor with
        // fs.writeSync. Each call fully flushes before the next one starts,
        // so there is no internal buffering/batching that can overflow.
        fd = fs.openSync(finalPath, 'w');
        let assembledSize = 0
        const chunkSizes = []

        for (let i = 0; i < totalChunks; i++) {
          const chunkPath = chunkData.chunks[i];

          // FAIL FAST: If any chunk is missing, abort immediately
          if (!chunkPath || !fs.existsSync(chunkPath)) {
            throw new AppError(`Chunk ${i} hilang atau rusak: ${chunkPath || 'undefined'}`, 500, 'INTERNAL_ERROR');
          }

          const chunkBuffer = fs.readFileSync(chunkPath);
          const chunkSize = chunkBuffer.length
          chunkSizes.push(chunkSize)

          // Validate chunk is not empty
          if (chunkSize === 0) {
            throw new AppError(`Chunk ${i} kosong (0 bytes)`, 500, 'INTERNAL_ERROR');
          }

          // Validate chunk size (allow 10% tolerance for last chunk only)
          if (i < totalChunks - 1) {
            // Non-last chunks must be exactly CHUNK_SIZE
            if (chunkSize !== CHUNK_SIZE) {
              throw new AppError(`Chunk ${i} ukuran salah: expected ${CHUNK_SIZE}, got ${chunkSize}`, 500, 'INTERNAL_ERROR');
            }
          } else {
            // Last chunk: should be remaining bytes
            const expectedLastSize = totalSize - assembledSize
            const tolerance = Math.max(1000, expectedLastSize * 0.1) // 10% or 1KB tolerance
            if (Math.abs(chunkSize - expectedLastSize) > tolerance) {
              throw new AppError(`Chunk ${i} (last) ukuran salah: expected ~${expectedLastSize}, got ${chunkSize}`, 500, 'INTERNAL_ERROR');
            }
          }

          // Write fully before moving to the next chunk - handles partial
          // writes too (writeSync can, in rare cases, write less than the
          // full buffer in one call, so loop until everything is flushed).
          let written = 0
          while (written < chunkBuffer.length) {
            written += fs.writeSync(fd, chunkBuffer, written, chunkBuffer.length - written, assembledSize + written)
          }
          assembledSize += chunkSize
        }

        fs.closeSync(fd);
        fd = null;

        // Get final file size
        const finalSize = fs.statSync(finalPath).size;

        // Verify assembled file size matches expected total size
        if (finalSize !== totalSize) {
          throw new AppError(`File assembly failed: size mismatch (expected ${totalSize}, got ${finalSize})`, 500, 'INTERNAL_ERROR');
        }

        // Normalize MIME type: detect from extension if browser sent incorrect type
        // (e.g., MKV files often come as 'application/octet-stream' instead of 'video/x-matroska')
        const normalizedMimeType = normalizeMimeType(fileType, fileName);

        // Auto-remux video untuk streaming support
        if (isVideoFile(normalizedMimeType)) {
          try {
            await remuxVideo(finalPath, finalPath);
            console.log(`Video remux selesai: ${fileName}`);
          } catch (err) {
            console.error(`Gagal remux video ${fileName}: ${err.message}`);
          }
        }

        // Generate thumbnail untuk gambar dan video
        try {
          await generateThumbnail(finalPath, normalizedMimeType);
        } catch (err) {
          console.error(`Gagal membuat thumbnail ${fileName}: ${err.message}`);
        }

        // Save to database
        const fileId = await FileModel.create({
          user_id: userId,
          folder_id: folderId,
          original_filename: fileName,
          stored_filename: finalFilename,
          file_path: finalPath,
          file_size: finalSize,
          mime_type: normalizedMimeType,
        });

        // Cleanup temporary chunks
        cleanupChunkFiles(chunkData);
        chunkStore.delete(chunkKey);

        CacheMiddleware.invalidateUser(userId);

        return res.status(201).json({
          success: true,
          message: "File berhasil diupload",
          file_id: fileId,
          file: {
            original_name: fileName,
            stored_name: finalFilename,
            size: finalSize,
            mime_type: normalizedMimeType,
          },
        });
      } catch (error) {
        // Cleanup on error - close fd if still open, remove partial file,
        // remove temp chunks, so no corrupt leftovers stay on disk.
        if (fd !== null) {
          try { fs.closeSync(fd); } catch (e) {}
        }
        if (finalPath && fs.existsSync(finalPath)) {
          try { fs.unlinkSync(finalPath); } catch (e) {}
        }
        cleanupChunkFiles(chunkData);
        chunkStore.delete(chunkKey);
        throw error;
      }
    }

    // Return progress for intermediate chunks
    const uploadedChunks = chunkData.chunks.filter(Boolean).length;
    return res.json({
      success: true,
      message: `Chunk ${chunkIndex + 1} diterima`,
      progress: {
        uploaded: uploadedChunks,
        total: totalChunks,
        percentage: Math.round((uploadedChunks * 100) / totalChunks),
      },
    });
  }),

  /**
   * GET /files/upload-status/:fileHash
   * Check upload status for resuming failed uploads
   */
  getUploadStatus: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { fileHash } = req.params;
    const chunkKey = `${userId}-${fileHash}`;

    if (!chunkStore.has(chunkKey)) {
      return res.json({
        success: true,
        exists: false,
        message: 'Upload tidak ditemukan',
      });
    }

    const chunkData = chunkStore.get(chunkKey);
    const uploadedChunks = chunkData.chunks.filter(Boolean).length;

    return res.json({
      success: true,
      exists: true,
      progress: {
        uploaded: uploadedChunks,
        total: chunkData.totalChunks,
        percentage: Math.round((uploadedChunks * 100) / chunkData.totalChunks),
        fileName: chunkData.fileName,
        fileSize: chunkData.totalSize,
      },
    });
  }),

  /**
   * DELETE /files/upload-cancel/:fileHash
   * Cancel and cleanup failed upload
   */
  cancelUpload: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { fileHash } = req.params;
    const chunkKey = `${userId}-${fileHash}`;

    if (chunkStore.has(chunkKey)) {
      const chunkData = chunkStore.get(chunkKey);
      cleanupChunkFiles(chunkData);
      chunkStore.delete(chunkKey);
    }

    return res.json({
      success: true,
      message: 'Upload canceled',
    });
  }),
};

module.exports = ChunkedUploadController;