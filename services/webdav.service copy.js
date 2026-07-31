// services/webdav.service.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../config/db');
const FolderModel = require('../models/folder.model');
const FileModel = require('../models/file.model');
const { AppError } = require('../middlewares/error.middleware');
const { generateThumbnail, deleteThumbnail, getThumbnailPath } = require('./thumbnail.service');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

// Set WEBDAV_ALLOW_HIDDEN=true di .env untuk mengizinkan upload file hidden
// seperti .env, .gitignore, .htaccess, .DS_Store (berguna untuk backup project)
const ALLOW_HIDDEN_FILES = process.env.WEBDAV_ALLOW_HIDDEN === 'true';

/**
 * Cek apakah sebuah nama (file ATAU folder) termasuk junk/metadata yang tidak
 * perlu disimpan: .DS_Store, ._AppleDouble, folder sistem macOS
 * (.Trashes, .Spotlight-V100, .TemporaryItems, .fseventsd, dst — semuanya
 * diawali titik jadi otomatis ke-cover), Thumbs.db, desktop.ini.
 *
 * PENTING: helper ini dipanggil bukan cuma di PUT, tapi juga di MOVE, COPY,
 * dan MKCOL — supaya client yang menulis lewat "PUT nama sementara lalu
 * MOVE/rename ke nama dot-file" (pola umum macOS Finder untuk metadata)
 * tetap ke-filter di titik akhir prosesnya, bukan cuma di titik PUT awal.
 */
// function isJunkName(name) {
//   return !ALLOW_HIDDEN_FILES && (
//     name.startsWith('.') ||
//     name.startsWith('._') ||
//     name === 'Thumbs.db' ||
//     name === 'desktop.ini'
//   );
// }
// File metadata OS (AppleDouble macOS, Windows) — SELALU difilter,
// terlepas dari WEBDAV_ALLOW_HIDDEN, karena ini bukan dotfile
// asli milik user, cuma sampah sistem yang dibuat otomatis oleh klien.
function isSystemJunk(name) {
  // Prefix AppleDouble selalu literal "._", jadi cukup cek apa adanya (case tidak relevan di sini)
  if (name.startsWith('._')) return true;

  // Case-insensitive untuk nama junk lain, karena beberapa klien
  // (terutama di Windows) bisa mengirim variasi huruf besar/kecil
  const lowerName = name.toLowerCase();
  return (
    lowerName === '.ds_store' ||
    lowerName === 'thumbs.db' ||
    lowerName === 'desktop.ini'
  );
}

function isJunkName(name) {
  if (isSystemJunk(name)) return true;
  // Dotfile asli (.env, .gitignore, dst) hanya dianggap junk
  // kalau fitur hidden-file belum diaktifkan.
  return !ALLOW_HIDDEN_FILES && name.startsWith('.');
}
/**
 * Generate a unique stored filename
 */
function generateStoredFilename(originalName) {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  // Sanitize: replace non-alphanumeric chars (except dot/hyphen/underscore)
  const safeBase = base.replace(/[^a-zA-Z0-9_-]/g, '_');
  const random = crypto.randomBytes(4).toString('hex');
  return `${safeBase}_${random}${ext}`;
}

/**
 * Detect MIME type from file extension.
 * Fallback ketika client (macOS Finder, dll) tidak mengirim Content-Type header.
 */
function detectMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    // Images
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.avif': 'image/avif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',

    // Video
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.m4v': 'video/x-m4v',
    '.3gp': 'video/3gpp',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',

    // Audio
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.wma': 'audio/x-ms-wma',

    // Documents
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.rtf': 'application/rtf',

    // Archives
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.bz2': 'application/x-bzip2',

    // Code / Data
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',

    // Others
    '.apk': 'application/vnd.android.package-archive',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * Get user's root directory path on filesystem
 */
function getUserDir(userId) {
  return path.join(UPLOADS_DIR, `user_${userId}`);
}

/**
 * Get folder's directory path on filesystem
 */
function getFolderDir(userId, folderId) {
  return path.join(UPLOADS_DIR, `user_${userId}`, `folder_${folderId}`);
}

/**
 * Navigate through the folder tree to resolve a path.
 * Returns the folder or file at the given path segments.
 *
 * @param {number} userId
 * @param {string[]} segments - Path segments (e.g. ['folder1', 'subfolder', 'file.txt'])
 * @returns {Promise<{type: 'folder'|'file'|'not_found', folder?: Object, file?: Object}>}
 */
async function resolvePath(userId, segments) {
  if (!segments || segments.length === 0) {
    // Root folder: return virtual root
    return { type: 'folder', folder: null };
  }

  let currentParentId = null; // null = root
  const lastSegment = segments[segments.length - 1];
  const parentSegments = segments.slice(0, -1);

  // Navigate through parent segments to find the parent folder
  for (const seg of parentSegments) {
    const [folders] = await pool.query(
      `SELECT id FROM folders
       WHERE user_id = ? AND parent_id <=> ? AND folder_name = ? AND deleted_at IS NULL
       LIMIT 1`,
      [userId, currentParentId, seg]
    );
    if (folders.length === 0) {
      return { type: 'not_found' };
    }
    currentParentId = folders[0].id;
  }

  // Try to find as a folder first
  const [folders] = await pool.query(
    `SELECT * FROM folders
     WHERE user_id = ? AND parent_id <=> ? AND folder_name = ? AND deleted_at IS NULL
     LIMIT 1`,
    [userId, currentParentId, lastSegment]
  );

  if (folders.length > 0) {
    return { type: 'folder', folder: folders[0] };
  }

  // Try to find as a file
  const [files] = await pool.query(
    `SELECT * FROM files
     WHERE user_id = ? AND folder_id <=> ? AND original_filename = ? AND deleted_at IS NULL
     LIMIT 1`,
    [userId, currentParentId, lastSegment]
  );

  if (files.length > 0) {
    return { type: 'file', file: files[0] };
  }

  return { type: 'not_found' };
}

/**
 * Resolve the parent folder for a given path.
 * Used by PUT, MKCOL, MOVE, COPY to find the destination parent.
 *
 * @param {number} userId
 * @param {string[]} segments - Path segments (may be empty for root)
 * @returns {Promise<{parentId: number|null}|null>} - Returns null if parent not found
 */
async function resolveParent(userId, segments) {
  let currentParentId = null; // null = root

  for (const seg of segments) {
    const [folders] = await pool.query(
      `SELECT id FROM folders
       WHERE user_id = ? AND parent_id <=> ? AND folder_name = ? AND deleted_at IS NULL
       LIMIT 1`,
      [userId, currentParentId, seg]
    );
    if (folders.length === 0) {
      return null;
    }
    currentParentId = folders[0].id;
  }

  return { parentId: currentParentId };
}

const WebDAVService = {
  // Dipakai controller untuk validasi nama tujuan di MOVE/COPY/MKCOL,
  // bukan cuma nama file yang lagi di-PUT.
  isJunkName,

  /**
   * Resolve a path to a resource (folder or file)
   */
  async resolvePath(userId, segments) {
    return resolvePath(userId, segments);
  },

  /**
   * List children (subfolders and files) within a folder.
   * @param {number} userId
   * @param {number|null} folderId - null for root
   */
  async listChildren(userId, folderId) {
    const folders = await FolderModel.findChildren(userId, folderId);
    const files = await FileModel.findByFolder(userId, folderId);

    // Filter out soft-deleted items (they shouldn't be returned)
    const activeFolders = folders.filter(f => !f.deleted_at);
    const activeFiles = files.filter(f => !f.deleted_at);

    return { folders: activeFolders, files: activeFiles };
  },

  /**
   * Resolve the parent folder for a path
   */
  async resolveParent(userId, segments) {
    return resolveParent(userId, segments);
  },

  /**
   * Handle PUT (file upload/overwrite) via WebDAV.
   * Reads raw request body and stores the file.
   *
   * @param {Object} req - Express request object (raw body is the file content)
   * @param {number} userId
   * @param {number|null} parentId
   * @param {string} fileName
   * @param {string} mimeType
   * @returns {Promise<{overwritten: boolean}>}
   */
  async putFile(req, userId, parentId, fileName, mimeType) {
    // Skip hidden/system files (macOS .DS_Store, ._ Apple Double, Windows Thumbs.db, desktop.ini)
    // Kecuali jika WEBDAV_ALLOW_HIDDEN=true di .env (untuk backup project)
    if (isJunkName(fileName)) {
      // Body request tetap harus di-drain walau kita gak simpan apa-apa,
      // supaya koneksi keep-alive gak ninggalin sisa bytes yang bikin
      // request berikutnya di socket yang sama jadi korup/nyangkut.
      for await (const _chunk of req) {
        // discard
      }
      return { overwritten: false, skipped: true };
    }

    // Check if file already exists (for overwrite detection)
    const existingFile = await this._findFileByParentAndName(userId, parentId, fileName);
    let overwritten = false;

    // Beberapa client WebDAV (macOS Finder, dll) tidak kirim Content-Type header
    // Fallback: deteksi dari ekstensi file
    const safeMimeType = mimeType || detectMimeType(fileName);

    // Collect the raw body chunks from the request stream
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const fileSize = buffer.length;

    if (existingFile) {
      // Overwrite: update existing file
      overwritten = true;

      // Delete old physical file if exists
      if (existingFile.file_path && fs.existsSync(existingFile.file_path)) {
        try {
          fs.unlinkSync(existingFile.file_path);
        } catch (e) {
          console.error(`Failed to delete old file: ${e.message}`);
        }
      }

      // Generate new stored filename and save
      const storedFilename = generateStoredFilename(fileName);
      const targetDir = parentId === null
        ? path.join(getUserDir(userId), 'folder_root')
        : getFolderDir(userId, parentId);

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const targetPath = path.join(targetDir, storedFilename);
      fs.writeFileSync(targetPath, buffer);

      // Update database record
      await pool.query(
        `UPDATE files SET stored_filename = ?, file_path = ?, file_size = ?, mime_type = ?, updated_at = NOW()
         WHERE id = ?`,
        [storedFilename, targetPath, fileSize, safeMimeType, existingFile.id]
      );

      // Process thumbnail/remux asynchronously
      this._processFileAsync(targetPath, safeMimeType, fileName);

      return { overwritten: true };
    }

    // New file
    const storedFilename = generateStoredFilename(fileName);
    const targetDir = parentId === null
      ? path.join(getUserDir(userId), 'folder_root')
      : getFolderDir(userId, parentId);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetPath = path.join(targetDir, storedFilename);
    fs.writeFileSync(targetPath, buffer);

    // Save to database
    await FileModel.create({
      user_id: userId,
      folder_id: parentId,
      original_filename: fileName,
      stored_filename: storedFilename,
      file_path: targetPath,
      file_size: fileSize,
      mime_type: safeMimeType,
    });

    // Process thumbnail/remux asynchronously
    this._processFileAsync(targetPath, safeMimeType, fileName);

    return { overwritten: false };
  },

  /**
   * Find a file by parent folder and original filename
   */
  async _findFileByParentAndName(userId, parentId, fileName) {
    const [rows] = await pool.query(
      `SELECT * FROM files
       WHERE user_id = ? AND folder_id <=> ? AND original_filename = ? AND deleted_at IS NULL
       LIMIT 1`,
      [userId, parentId, fileName]
    );
    return rows[0] || null;
  },

  /**
   * Async post-processing: thumbnail generation and video remux
   */
  async _processFileAsync(filePath, mimeType, fileName) {
    try {
      const { generateThumbnail } = require('./thumbnail.service');
      await generateThumbnail(filePath, mimeType);
    } catch (err) {
      console.error(`Thumbnail generation failed for ${fileName}: ${err.message}`);
    }

    try {
      const { remuxVideo, isVideoFile } = require('./video-remux.service');
      if (isVideoFile(mimeType)) {
        await remuxVideo(filePath, filePath);
      }
    } catch (err) {
      console.error(`Video remux failed for ${fileName}: ${err.message}`);
    }
  },

  /**
   * Soft-delete a folder and all its contents recursively + hapus fisik + thumbnail
   */
  async deleteFolderRecursive(userId, folderId) {
    const descendantIds = await FolderModel.getAllDescendantIds(folderId);

    // Hapus fisik semua file di folder tree (termasuk thumbnail)
    for (const id of descendantIds) {
      const [files] = await pool.query(
        `SELECT * FROM files WHERE folder_id = ? AND deleted_at IS NULL`,
        [id]
      );
      for (const file of files) {
        try {
          deleteThumbnail(file.file_path);
        } catch (e) {
          console.error(`Gagal hapus thumbnail ${file.original_filename}: ${e.message}`);
        }
        if (file.file_path && fs.existsSync(file.file_path)) {
          try {
            fs.unlinkSync(file.file_path);
          } catch (e) {
            console.error(`Gagal hapus file fisik ${file.original_filename}: ${e.message}`);
          }
        }
      }
    }

    // Hapus direktori fisik folder (termasuk subfolder)
    for (const id of descendantIds) {
      const folderDir = getFolderDir(userId, id);
      if (fs.existsSync(folderDir)) {
        try {
          fs.rmSync(folderDir, { recursive: true, force: true });
        } catch (e) {
          console.error(`Gagal hapus direktori folder ${id}: ${e.message}`);
        }
      }
    }

    // Hapus direktori thumbnail folder (struktur mirror uploads)
    for (const id of descendantIds) {
      const folderDir = getFolderDir(userId, id);
      // Convert uploads path to thumbnails path
      // folderDir: /path/to/uploads/user_1/folder_5
      // thumbDir:  /path/to/thumbnails/user_1/folder_5
      const thumbDir = folderDir.replace(
        path.sep + 'uploads' + path.sep,
        path.sep + 'thumbnails' + path.sep
      );
      if (fs.existsSync(thumbDir)) {
        try {
          fs.rmSync(thumbDir, { recursive: true, force: true });
        } catch (e) {
          console.error(`Gagal hapus direktori thumbnail folder ${id}: ${e.message}`);
        }
      }
    }

    // Hard delete database (CASCADE akan hapus file & sub-folder otomatis)
    // Hapus mulai dari anak terdalam agar tidak conflict FK
    const reversedIds = [...descendantIds].reverse();
    for (const id of reversedIds) {
      await pool.query(`DELETE FROM folders WHERE id = ?`, [id]);
    }
  },

  /**
   * Soft-delete a file + hapus fisik + thumbnail
   */
  async deleteFile(userId, file) {
    // Hapus thumbnail dulu
    try {
      deleteThumbnail(file.file_path);
    } catch (e) {
      console.error(`Gagal hapus thumbnail ${file.original_filename}: ${e.message}`);
    }

    // Hapus folder thumbnail jika kosong
    try {
      const thumbDir = path.dirname(getThumbnailPath(file.file_path));
      if (fs.existsSync(thumbDir)) {
        const remaining = fs.readdirSync(thumbDir);
        if (remaining.length === 0) {
          fs.rmdirSync(thumbDir);
        }
      }
    } catch (e) { /* ignore */ }

    // Hapus file fisik
    if (file.file_path && fs.existsSync(file.file_path)) {
      try {
        fs.unlinkSync(file.file_path);
      } catch (e) {
        console.error(`Gagal hapus file fisik ${file.original_filename}: ${e.message}`);
      }
    }

    // Hard delete database (permanent, tidak masuk trash)
    await pool.query(
      `DELETE FROM files WHERE id = ? AND user_id = ?`,
      [file.id, userId]
    );
  },

  /**
   * Create a new folder
   */
  async createFolder(userId, parentId, folderName) {
    // Check for duplicate
    const exists = await FolderModel.existsByName(userId, parentId, folderName);
    if (exists) {
      throw new AppError('Folder already exists', 405, 'METHOD_NOT_ALLOWED');
    }

    return FolderModel.create(userId, parentId, folderName);
  },

  /**
   * Move/rename a folder
   */
  async moveFolder(userId, folder, newParentId, newName) {
    // If name changed or parent changed, update
    const updates = [];
    const params = [];

    if (newName && newName !== folder.folder_name) {
      // Check for duplicate in new parent
      const exists = await FolderModel.existsByName(userId, newParentId, newName, folder.id);
      if (exists) {
        throw new AppError('Folder with that name already exists', 405, 'METHOD_NOT_ALLOWED');
      }
      updates.push('folder_name = ?');
      params.push(newName);
    }

    if (newParentId !== folder.parent_id) {
      updates.push('parent_id = ?');
      params.push(newParentId);
    }

    if (updates.length > 0) {
      params.push(folder.id);
      await pool.query(
        `UPDATE folders SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
        params
      );
    }

    // Move physical files if parent changed and folder has files
    if (newParentId !== folder.parent_id) {
      await this._moveFolderFilesystem(userId, folder.id, newParentId);
    }
  },

  /**
   * Move physical directory + thumbnail when a folder is moved
   */
  async _moveFolderFilesystem(userId, folderId, newParentId) {
    const oldDir = getFolderDir(userId, folderId);
    const newDir = newParentId === null
      ? path.join(getUserDir(userId), 'folder_root')
      : getFolderDir(userId, newParentId);

    // Update file_paths in database for all files in this folder
    const files = await FileModel.findByFolderIdRecursive(folderId);
    for (const file of files) {
      const relativePath = path.relative(oldDir, file.file_path);
      // Rebuild path relative to new parent
      // For simplicity, the stored file_path uses absolute paths so we update
      // the folder-specific prefix
      if (file.file_path.startsWith(oldDir)) {
        const newPath = file.file_path.replace(oldDir, newDir);
        const subDir = path.dirname(relativePath);
        const fullNewDir = subDir === '.' ? newDir : path.join(newDir, subDir);

        if (!fs.existsSync(fullNewDir)) {
          fs.mkdirSync(fullNewDir, { recursive: true });
        }

        try {
          if (fs.existsSync(file.file_path)) {
            fs.renameSync(file.file_path, newPath);
          }
        } catch (e) {
          console.error(`Failed to move file ${file.original_filename}: ${e.message}`);
        }

        // Pindahkan thumbnail
        const oldThumbPath = getThumbnailPath(file.file_path);
        const newThumbPath = getThumbnailPath(newPath);
        if (fs.existsSync(oldThumbPath)) {
          try {
            const thumbDir = path.dirname(newThumbPath);
            if (!fs.existsSync(thumbDir)) {
              fs.mkdirSync(thumbDir, { recursive: true });
            }
            fs.renameSync(oldThumbPath, newThumbPath);
          } catch (e) {
            console.error(`Gagal pindahkan thumbnail untuk ${file.original_filename}: ${e.message}`);
          }
        }

        await pool.query(
          `UPDATE files SET file_path = ? WHERE id = ?`,
          [newPath, file.id]
        );
      }
    }

    // Hapus direktori uploads lama
    if (fs.existsSync(oldDir)) {
      try {
        fs.rmSync(oldDir, { recursive: true, force: true });
      } catch (e) {
        console.error(`Gagal hapus direktori uploads lama: ${e.message}`);
      }
    }

    // Hapus direktori thumbnails lama (mirror structure)
    const oldThumbDir = oldDir.replace(
      path.sep + 'uploads' + path.sep,
      path.sep + 'thumbnails' + path.sep
    );
    if (fs.existsSync(oldThumbDir)) {
      try {
        fs.rmSync(oldThumbDir, { recursive: true, force: true });
      } catch (e) {
        console.error(`Gagal hapus direktori thumbnails lama: ${e.message}`);
      }
    }
  },

  /**
   * Move/rename a file + pindahkan thumbnail
   */
  async moveFile(userId, file, newParentId, newName) {
    // Check target path doesn't already have a file with same name
    const targetName = newName || file.original_filename;
    const exists = await this._findFileByParentAndName(userId, newParentId, targetName);
    if (exists && exists.id !== file.id) {
      throw new AppError('File with that name already exists', 405, 'METHOD_NOT_ALLOWED');
    }

    const updates = [];
    const params = [];

    if (newName && newName !== file.original_filename) {
      updates.push('original_filename = ?');
      params.push(newName);
    }

    if (newParentId !== file.folder_id) {
      updates.push('folder_id = ?');
      params.push(newParentId);
    }

    if (updates.length > 0) {
      params.push(file.id);
      await pool.query(
        `UPDATE files SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
        params
      );
    }

    // If parent changed, move physical file + thumbnail
    if (newParentId !== file.folder_id) {
      const newDir = newParentId === null
        ? path.join(getUserDir(userId), 'folder_root')
        : getFolderDir(userId, newParentId);

      if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true });
      }

      const newFilePath = path.join(newDir, file.stored_filename);

      if (fs.existsSync(file.file_path)) {
        try {
          fs.renameSync(file.file_path, newFilePath);
        } catch (e) {
          console.error(`Failed to move file ${file.original_filename}: ${e.message}`);
        }
      }

      // Pindahkan thumbnail
      const oldThumbPath = getThumbnailPath(file.file_path);
      const newThumbPath = getThumbnailPath(newFilePath);
      if (fs.existsSync(oldThumbPath)) {
        try {
          const thumbDir = path.dirname(newThumbPath);
          if (!fs.existsSync(thumbDir)) {
            fs.mkdirSync(thumbDir, { recursive: true });
          }
          fs.renameSync(oldThumbPath, newThumbPath);
        } catch (e) {
          console.error(`Gagal pindahkan thumbnail ${file.original_filename}: ${e.message}`);
        }
      }

      await pool.query(
        `UPDATE files SET file_path = ? WHERE id = ?`,
        [newFilePath, file.id]
      );

      // Hapus folder upload sumber jika kosong
      const oldDir = path.dirname(file.file_path);
      if (fs.existsSync(oldDir)) {
        try {
          const remaining = fs.readdirSync(oldDir);
          if (remaining.length === 0) {
            fs.rmdirSync(oldDir);
          }
        } catch (e) { /* ignore */ }
      }

      // Hapus folder thumbnail sumber jika kosong
      const oldThumbDir = path.dirname(oldThumbPath);
      if (fs.existsSync(oldThumbDir)) {
        try {
          const remaining = fs.readdirSync(oldThumbDir);
          if (remaining.length === 0) {
            fs.rmdirSync(oldThumbDir);
          }
        } catch (e) { /* ignore */ }
      }
    }
  },

  /**
   * Copy a folder and all its contents to a new parent
   */
  async copyFolderRecursive(userId, folderId, newParentId) {
    const originalFolder = await FolderModel.findById(folderId);
    if (!originalFolder || originalFolder.user_id !== userId) {
      throw new AppError('Folder not found', 404, 'NOT_FOUND');
    }

    // Create a new folder with the same name under newParentId
    let copySuffix = '';
    let newFolderName = originalFolder.folder_name;
    let newFolderId;

    // Handle name conflicts
    while (await FolderModel.existsByName(userId, newParentId, newFolderName)) {
      copySuffix++;
      newFolderName = `${originalFolder.folder_name} (${copySuffix})`;
    }

    newFolderId = await FolderModel.create(userId, newParentId, newFolderName);

    // Copy all files from the original folder
    const files = await FileModel.findByFolder(userId, folderId);
    for (const file of files) {
      if (file.deleted_at) continue;
      await this._copyFileRecord(userId, file, newFolderId, file.original_filename);
    }

    // Recursively copy subfolders
    const subFolders = await FolderModel.findChildren(userId, folderId);
    for (const subFolder of subFolders) {
      if (subFolder.deleted_at) continue;
      await this.copyFolderRecursive(userId, subFolder.id, newFolderId);
    }
  },

  /**
   * Copy a file to a new location with optional rename
   */
  async copyFile(userId, file, newParentId, newName) {
    await this._copyFileRecord(userId, file, newParentId, newName || file.original_filename);
  },

  /**
   * Internal: copy a file record, physical file, and generate thumbnail
   */
  async _copyFileRecord(userId, sourceFile, newParentId, newName) {
    // Handle name conflicts
    let targetName = newName;
    let copySuffix = '';
    while (await this._findFileByParentAndName(userId, newParentId, targetName)) {
      copySuffix++;
      const ext = path.extname(newName);
      const base = path.basename(newName, ext);
      targetName = `${base} (${copySuffix})${ext}`;
    }

    // Copy physical file
    const storedFilename = generateStoredFilename(targetName);
    const targetDir = newParentId === null
      ? path.join(getUserDir(userId), 'folder_root')
      : getFolderDir(userId, newParentId);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetPath = path.join(targetDir, storedFilename);

    if (sourceFile.file_path && fs.existsSync(sourceFile.file_path)) {
      fs.copyFileSync(sourceFile.file_path, targetPath);
    }

    // Generate thumbnail untuk file hasil copy
    try {
      await generateThumbnail(targetPath, sourceFile.mime_type);
    } catch (e) {
      console.error(`Gagal generate thumbnail untuk file copy ${targetName}: ${e.message}`);
    }

    // Create database record
    return FileModel.create({
      user_id: userId,
      folder_id: newParentId,
      original_filename: targetName,
      stored_filename: storedFilename,
      file_path: targetPath,
      file_size: sourceFile.file_size,
      mime_type: sourceFile.mime_type,
    });
  },
};

module.exports = WebDAVService;