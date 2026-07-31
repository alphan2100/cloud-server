/**
 * download.service.js
 *
 * Wrapper service for the downloader module (downloadManager.js).
 * Adds:
 *  - Aria2 connection check on startup
 *  - Integration with uploadService.processFile() after download completes
 *  - User/folder tracking
 *  - Graceful error handling when aria2 is not running
 */

const path = require('path');
const fs = require('fs');
const { AppError } = require('../middlewares/error.middleware');
const uploadService = require('./upload.service');
const downloadManager = require('./downloader/downloadManager');

class DownloadService {
  constructor() {
    this.aria2Connected = false;
    this._connectionChecked = false;
    this._checkAria2Connection();
  }

  /**
   * Check aria2 daemon connection on startup
   */
  async _checkAria2Connection() {
    try {
      const Aria2Client = require('./downloader/aria2Client');
      const ARIA2_RPC_URL = process.env.ARIA2_RPC_URL || 'http://localhost:6800/jsonrpc';
      const ARIA2_RPC_SECRET = process.env.ARIA2_RPC_SECRET || '';
      const client = new Aria2Client({ url: ARIA2_RPC_URL, secret: ARIA2_RPC_SECRET });
      const version = await client.getVersion();
      this.aria2Connected = true;
      this._connectionChecked = true;
      console.log(`✅ Aria2 connected: v${version.version}`);
    } catch (err) {
      this.aria2Connected = false;
      this._connectionChecked = true;
      console.warn('⚠️ Aria2 is not running. Direct download will not work.');
      console.warn('   Start aria2c with: aria2c --enable-rpc --rpc-listen-all --rpc-allow-origin-all --rpc-listen-port=6800');
    }
  }

  /**
   * Ensure aria2 is connected before proceeding
   */
  _ensureAria2Connected() {
    if (!this._connectionChecked) {
      throw new AppError('Download service is still initializing. Please try again.', 503, 'SERVICE_INITIALIZING');
    }
    if (!this.aria2Connected) {
      throw new AppError(
        'Aria2 download daemon is not running. Please start aria2c first:\n  aria2c --enable-rpc --rpc-listen-all --rpc-allow-origin-all --rpc-listen-port=6800',
        503,
        'ARIA2_NOT_CONNECTED'
      );
    }
  }

  /**
   * Check connection status
   */
  async checkConnection() {
    if (!this._connectionChecked) {
      await this._checkAria2Connection();
    }
    return {
      connected: this.aria2Connected,
      downloadDir: downloadManager.DOWNLOAD_DIR,
      rpcUrl: process.env.ARIA2_RPC_URL || 'http://localhost:6800/jsonrpc',
    };
  }

  /**
   * Start a direct download task
   * @param {string} url - URL to download
   * @param {number} userId - User ID
   * @param {string|null} folderId - Target folder ID
   * @param {Object} [options] - Additional options
   * @param {Object} [options.headers] - Custom headers (Referer, Cookie, etc.)
   * @param {string} [options.filename] - Custom filename
   * @param {string} [options.type] - Media type (hls, dash, etc.)
   * @param {string[]} [options.mergeUrls] - Array of URLs to merge [videoUrl, audioUrl]
   * @returns {Promise<Object>} task info
   */
  async startDownload(url, userId, folderId = null, options = {}) {
    this._ensureAria2Connected();

    // Validate URL
    try {
      new URL(url);
    } catch (err) {
      throw new AppError('URL tidak valid', 400, 'VALIDATION_ERROR');
    }

    let record;
    
    // Check if this is a merge download (video + audio)
    if (options.mergeUrls && Array.isArray(options.mergeUrls) && options.mergeUrls.length >= 2) {
      // Use ffmpeg to merge video + audio
      record = downloadManager.startFfmpegMergeDownload({
        urls: options.mergeUrls,
        headers: options.headers || {},
        filename: options.filename || 'merged_video.mp4',
      });
      
      // Attach user info
      record.userId = userId;
      record.folderId = folderId;
    } else {
      // Standard download (aria2 or single ffmpeg)
      record = await downloadManager.startDownload({
        url,
        headers: options.headers || {},
        filename: options.filename || null,
        type: options.type || null,
        userId,
        folderId,
      });
    }

    // If download failed to start, throw error
    if (record.status === 'error') {
      throw new AppError(`Gagal memulai download: ${record.errorMessage}`, 400, 'DOWNLOAD_ERROR');
    }

    // Start monitoring for completion (to trigger upload)
    this._monitorForUpload(record.id);

    return downloadManager.serialize ? downloadManager.serialize(record) : record;
  }

  /**
   * Monitor a download and trigger upload to cloud storage when complete
   */
  async _monitorForUpload(downloadId) {
    const checkStatus = async () => {
      try {
        const status = await downloadManager.getStatus(downloadId);
        if (!status) return;

        if (status.status === 'complete') {
          // Download complete, upload to cloud storage
          await this._processCompletedDownload(downloadId);
        } else if (status.status === 'error' || status.status === 'cancelled') {
          // Terminal state, nothing to do
          return;
        } else {
          // Still active, check again later
          setTimeout(checkStatus, 2000);
        }
      } catch (err) {
        console.error(`[DownloadService] Error monitoring download ${downloadId}:`, err.message);
        setTimeout(checkStatus, 5000);
      }
    };

    // Start checking after a short delay
    setTimeout(checkStatus, 2000);
  }

  /**
   * Process completed download - upload to cloud storage
   */
  async _processCompletedDownload(downloadId) {
    const record = downloadManager.getRecord(downloadId);
    if (!record) return;

    try {
      const fileInfo = downloadManager.getFinalFilePath(downloadId);
      if (!fileInfo) {
        throw new Error('File not found on disk after download');
      }

      const stats = fs.statSync(fileInfo.path);
      const ext = path.extname(fileInfo.filename);
      const storedName = `${Date.now()}-${Math.random().toString(36).substring(2)}${ext}`;

      // Guess MIME type
      const mimeType = this._guessMimeType(fileInfo.filename);

      // Upload to cloud storage
      const result = await uploadService.processFile({
        userId: record.userId,
        folderId: record.folderId,
        filePath: fileInfo.path,
        originalName: fileInfo.filename,
        storedName,
        fileSize: stats.size,
        mimeType,
        isTemp: true, // File is in temp dir, will be moved
      });

      // Update record with file info
      downloadManager.updateRecord(downloadId, {
        fileId: result.fileId,
        fileResult: result.file,
      });

      console.log(`[DownloadService] Download ${downloadId} uploaded to cloud: ${fileInfo.filename}`);
    } catch (err) {
      console.error(`[DownloadService] Error uploading download ${downloadId}:`, err.message);
      downloadManager.updateRecord(downloadId, {
        status: 'error',
        errorMessage: `Upload to cloud failed: ${err.message}`,
      });
    }
  }

  /**
   * Get task status
   */
  async getStatus(taskId) {
    const status = await downloadManager.getStatus(taskId);
    if (!status) {
      throw new AppError('Task tidak ditemukan', 404, 'NOT_FOUND');
    }
    return status;
  }

  /**
   * List all download tasks
   */
  async listStatuses() {
    return await downloadManager.listStatuses();
  }

  /**
   * Pause a download task
   */
  async pause(taskId) {
    this._ensureAria2Connected();
    try {
      return await downloadManager.pauseDownload(taskId);
    } catch (err) {
      throw new AppError(`Gagal pause download: ${err.message}`, 400, 'DOWNLOAD_ERROR');
    }
  }

  /**
   * Resume a paused download task
   */
  async resume(taskId) {
    this._ensureAria2Connected();
    try {
      return await downloadManager.resumeDownload(taskId);
    } catch (err) {
      throw new AppError(`Gagal resume download: ${err.message}`, 400, 'DOWNLOAD_ERROR');
    }
  }

  /**
   * Cancel a download task
   */
  async cancel(taskId) {
    try {
      return await downloadManager.cancelDownload(taskId);
    } catch (err) {
      throw new AppError(`Gagal membatalkan download: ${err.message}`, 400, 'DOWNLOAD_ERROR');
    }
  }

  /**
   * Retry a failed/cancelled download
   */
  async retry(taskId, overrides = {}) {
    this._ensureAria2Connected();
    try {
      const result = await downloadManager.retryDownload(taskId, overrides);
      // Start monitoring for upload
      if (result && result.id) {
        this._monitorForUpload(result.id);
      }
      return result;
    } catch (err) {
      throw new AppError(`Gagal mengulang download: ${err.message}`, 400, 'DOWNLOAD_ERROR');
    }
  }

  /**
   * Remove a download from the list
   */
  forget(taskId) {
    try {
      return downloadManager.forgetDownload(taskId);
    } catch (err) {
      throw new AppError(err.message, 400, 'BAD_REQUEST');
    }
  }

  /**
   * Get final file path for a completed download
   */
  getFile(taskId) {
    return downloadManager.getFinalFilePath(taskId);
  }

  /**
   * Fetch HEAD info from external URL (bypass CORS)
   */
  async fetchHeadInfo(url) {
    try {
      const { fetchAccurateFileInfo } = require('./downloader/utils');
      const info = await fetchAccurateFileInfo(url);
      return {
        contentLength: info.sizeBytes,
        contentType: info.mimeType,
        filename: info.filename,
        ok: info.statusCode >= 200 && info.statusCode < 400,
        status: info.statusCode,
        isSizeReliable: info.isSizeReliable,
      };
    } catch (err) {
      throw new AppError(`Failed to fetch HEAD info: ${err.message}`, 500, 'FETCH_ERROR');
    }
  }

  /**
   * Guess MIME type from filename
   */
  _guessMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.rar': 'application/x-rar-compressed',
      '.txt': 'text/plain',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.flac': 'audio/flac',
      '.m4a': 'audio/mp4',
      '.ogg': 'audio/ogg',
    };
    return mimeMap[ext] || 'application/octet-stream';
  }
}

module.exports = new DownloadService();