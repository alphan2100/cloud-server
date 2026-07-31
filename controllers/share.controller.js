const fs = require('fs');
const path = require('path');
const ShareModel = require('../models/share.model');
const FileModel = require('../models/file.model');
const FolderModel = require('../models/folder.model');
const FolderController = require('./folder.controller');
const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const { setContentDisposition } = require('../utils/header');

// ============================================
// Helper functions untuk share viewer page
// ============================================

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function getFileCategory(mimeType, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (mimeType && mimeType.startsWith('image/')) return 'image';
  if (mimeType && mimeType.startsWith('video/')) return 'video';
  if (mimeType && mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf' || ext === '.pdf') return 'pdf';
  if ((mimeType && mimeType.startsWith('text/')) ||
      ['.txt', '.md', '.json', '.xml', '.csv', '.log', '.js', '.ts', '.css', '.html', '.yml', '.yaml'].includes(ext)) {
    return 'text';
  }
  return 'other';
}

function getFileIcon(category) {
  const icons = {
    image: '🖼️',
    video: '🎬',
    audio: '🎵',
    pdf: '📄',
    text: '📝',
    other: '📦',
  };
  return icons[category] || '📦';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '\x26amp;')
    .replace(/</g, '\x26lt;')
    .replace(/>/g, '\x26gt;')
    .replace(/"/g, '\x26quot;')
    .replace(/'/g, '\x26#39;');
}

function getViewerContent(category, streamUrl, fileName) {
  const safeName = escapeHtml(fileName);
  switch (category) {
    case 'image':
      return `<img class="viewer-content" src="${streamUrl}" alt="${safeName}">`;
    case 'video':
      return `<video class="viewer-content" controls preload="metadata" src="${streamUrl}"></video>`;
    case 'audio':
      return `<audio class="viewer-content" controls preload="metadata" src="${streamUrl}"></audio>`;
    case 'pdf':
      return `<iframe class="viewer-content" src="${streamUrl}" title="${safeName}"></iframe>`;
    case 'text':
      return `<pre class="text-viewer" id="text-content">Loading…</pre>
<script>
  fetch("${streamUrl}")
    .then(r => r.text())
    .then(t => { document.getElementById("text-content").textContent = t; })
    .catch(() => { document.getElementById("text-content").textContent = "Gagal memuat isi file."; });
</script>`;
    default:
      return `<div class="fallback">
  <div class="fallback-icon">📦</div>
  <div class="fallback-text">Preview tidak tersedia untuk tipe file ini</div>
  <div class="fallback-hint">${safeName}</div>
</div>`;
  }
}

function renderViewerPage(file, share, token, req) {
  const streamUrl = `${req.baseUrl}/access/${token}/stream`;
  const category = getFileCategory(file.mime_type, file.original_filename);
  const fileName = file.original_filename || 'file';
  const fileSize = formatFileSize(file.file_size);
  const fileType = file.mime_type || 'unknown';
  const fileIcon = getFileIcon(category);
  const viewerContent = getViewerContent(category, streamUrl, fileName);

  let expiryInfo = '';
  if (share.expires_at) {
    const expDate = new Date(share.expires_at);
    expiryInfo = ` • Berakhir ${expDate.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }

  const templatePath = path.join(__dirname, '..', 'views', 'share-viewer.html');
  let html = fs.readFileSync(templatePath, 'utf8');

  html = html
    .replace(/\{\{FILE_NAME\}\}/g, escapeHtml(fileName))
    .replace(/\{\{FILE_SIZE\}\}/g, escapeHtml(fileSize))
    .replace(/\{\{FILE_TYPE\}\}/g, escapeHtml(fileType))
    .replace(/\{\{FILE_ICON\}\}/g, fileIcon)
    .replace(/\{\{EXPIRY_INFO\}\}/g, expiryInfo)
    .replace(/\{\{VIEWER_CONTENT\}\}/g, viewerContent);

  return html;
}

const ShareController = {
  /**
   * POST /shares
   * Membuat share link untuk file atau folder
   */
  create: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { item_type, item_id, permission = 'view', expires_in_hours = null } = req.body;

    if (!item_type || !item_id) {
      throw new AppError('item_type dan item_id wajib diisi', 400, 'VALIDATION_ERROR');
    }

    if (!['file', 'folder'].includes(item_type)) {
      throw new AppError('item_type harus "file" atau "folder"', 400, 'VALIDATION_ERROR');
    }

    if (!['view', 'download', 'edit'].includes(permission)) {
      throw new AppError('permission harus "view", "download", atau "edit"', 400, 'VALIDATION_ERROR');
    }

    // Verifikasi item milik user
    if (item_type === 'file') {
      const file = await FileModel.findById(item_id);
      if (!file) {
        throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
      }
      if (file.user_id !== userId) {
        throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
      }
    } else {
      const folder = await FolderModel.findById(item_id);
      if (!folder) {
        throw new AppError('Folder tidak ditemukan', 404, 'NOT_FOUND');
      }
      if (folder.user_id !== userId) {
        throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
      }
    }

    // Hitung expires_at
    let expiresAt = null;
    if (expires_in_hours) {
      expiresAt = new Date(Date.now() + expires_in_hours * 60 * 60 * 1000);
    }

    const share = await ShareModel.create(userId, item_type, item_id, permission, expiresAt);

    return res.status(201).json({
      success: true,
      message: 'Share link berhasil dibuat',
      data: {
        id: share.id,
        share_token: share.shareToken,
        share_url: `${req.protocol}://${req.get('host')}/shares/access/${share.shareToken}`,
        item_type,
        item_id,
        permission,
        expires_at: expiresAt,
      },
    });
  }),

  /**
   * GET /shares
   * Mendapatkan semua share link milik user
   */
  list: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const shares = await ShareModel.findByUser(userId);

    return res.json({
      success: true,
      data: shares,
    });
  }),

  /**
   * GET /shares/access/:token
   * Mengakses item melalui share token (public endpoint)
   */
  access: asyncHandler(async (req, res) => {
    const { token } = req.params;
    const share = await ShareModel.findByToken(token);

    if (!share) {
      throw new AppError('Share link tidak valid', 404, 'NOT_FOUND');
    }

    if (share.is_expired) {
      throw new AppError('Share link telah kedaluwarsa', 410, 'SHARE_EXPIRED');
    }

    // Jika permission download dan item adalah file, redirect ke download endpoint
    if (share.permission === 'download' && share.item_type === 'file') {
      return res.redirect(`${req.baseUrl}/access/${token}/download`);
    }

    // Jika permission view dan item adalah file, sajikan halaman HTML viewer
    if (share.permission === 'view' && share.item_type === 'file') {
      const file = await FileModel.findById(share.item_id);
      if (!file) {
        throw new AppError('File yang dibagikan tidak ditemukan', 404, 'NOT_FOUND');
      }
      if (!fs.existsSync(file.file_path)) {
        throw new AppError('File fisik tidak ditemukan di server', 404, 'NOT_FOUND');
      }
      const html = renderViewerPage(file, share, token, req);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    }

    let itemData = null;

    if (share.item_type === 'file') {
      const file = await FileModel.findById(share.item_id);
      if (!file) {
        throw new AppError('File yang dibagikan tidak ditemukan', 404, 'NOT_FOUND');
      }
      itemData = {
        id: file.id,
        original_filename: file.original_filename,
        file_size: file.file_size,
        mime_type: file.mime_type,
        uploaded_at: file.uploaded_at,
      };
    } else {
      const folder = await FolderModel.findById(share.item_id);
      if (!folder) {
        throw new AppError('Folder yang dibagikan tidak ditemukan', 404, 'NOT_FOUND');
      }
      itemData = {
        id: folder.id,
        folder_name: folder.folder_name,
        created_at: folder.created_at,
      };
    }

    return res.json({
      success: true,
      data: {
        share_info: {
          permission: share.permission,
          created_at: share.created_at,
          expires_at: share.expires_at,
        },
        item: itemData,
      },
    });
  }),

  /**
   * GET /shares/access/:token/download
   * Download file melalui share link
   */
  downloadSharedFile: asyncHandler(async (req, res) => {
    const { token } = req.params;
    const share = await ShareModel.findByToken(token);

    if (!share) {
      throw new AppError('Share link tidak valid', 404, 'NOT_FOUND');
    }

    if (share.is_expired) {
      throw new AppError('Share link telah kedaluwarsa', 410, 'SHARE_EXPIRED');
    }

    if (share.item_type !== 'file') {
      throw new AppError('Share link ini bukan untuk file', 400, 'BAD_REQUEST');
    }

    if (share.permission === 'view') {
      throw new AppError('Tidak memiliki izin download', 403, 'FORBIDDEN');
    }

    const fs = require('fs');
    const file = await FileModel.findById(share.item_id);

    if (!file || !fs.existsSync(file.file_path)) {
      throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
    }

    res.setHeader('Content-Type', file.mime_type);
    setContentDisposition(res, 'attachment', file.original_filename);
    res.setHeader('Content-Length', file.file_size);

    const stream = fs.createReadStream(file.file_path);
    stream.pipe(res);
  }),

  /**
   * GET /shares/access/:token/stream
   * Stream file content inline (untuk viewer page)
   * Mendukung Range requests untuk streaming video/audio
   */
  streamFile: asyncHandler(async (req, res) => {
    const { token } = req.params;
    const share = await ShareModel.findByToken(token);

    if (!share) {
      throw new AppError('Share link tidak valid', 404, 'NOT_FOUND');
    }

    if (share.is_expired) {
      throw new AppError('Share link telah kedaluwarsa', 410, 'SHARE_EXPIRED');
    }

    if (share.item_type !== 'file') {
      throw new AppError('Share link ini bukan untuk file', 400, 'BAD_REQUEST');
    }

    const file = await FileModel.findById(share.item_id);

    if (!file || !fs.existsSync(file.file_path)) {
      throw new AppError('File tidak ditemukan', 404, 'NOT_FOUND');
    }

    const stat = fs.statSync(file.file_path);
    const fileSize = stat.size;

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    setContentDisposition(res, 'inline', file.original_filename);

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
      res.setHeader('Content-Length', fileSize);
      const stream = fs.createReadStream(file.file_path);
      stream.pipe(res);
    }
  }),

  /**
   * DELETE /shares/:id
   * Menghapus share link
   */
  delete: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;

    const deleted = await ShareModel.delete(id, userId);

    if (!deleted) {
      throw new AppError('Share link tidak ditemukan', 404, 'NOT_FOUND');
    }

    return res.json({
      success: true,
      message: 'Share link berhasil dihapus',
    });
  }),
};

module.exports = ShareController;