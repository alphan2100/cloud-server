const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const downloadService = require('../services/download.service');
const mediaDetector = require('../services/downloader/mediaDetector');
const { fetchAccurateFileInfo } = require('../services/downloader/utils');
const ytdlpService = require('../services/ytdlp.service');

// Known media sites that yt-dlp handles
const MEDIA_SITES = [
  'youtube.com', 'youtu.be', 'instagram.com', 'facebook.com', 'fb.watch',
  'tiktok.com', 'twitter.com', 'x.com', 'vimeo.com', 'dailymotion.com',
  'twitch.tv', 'soundcloud.com', 'spotify.com', 'reddit.com',
  'bilibili.com', 'nicovideo.jp', 'tumblr.com', 'pinterest.com',
];

function isMediaSite(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return MEDIA_SITES.some(site => host.includes(site));
  } catch { return false; }
}

const DirectDownloadController = {
  // ===================== Connection =====================

  /**
   * GET /direct-download/connection
   * Check aria2 daemon connection status
   */
  connection: asyncHandler(async (req, res) => {
    const status = await downloadService.checkConnection();
    return res.json({
      success: true,
      data: status,
    });
  }),

  // ===================== File Info (PUBLIC) =====================

  /**
   * GET /direct-download/file-info?url=
   * Fetch accurate file info from a URL (public endpoint - no auth needed)
   * Mirrors /api/file-info from downloader
   */
  fileInfo: asyncHandler(async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
      throw new AppError('URL parameter is required', 400, 'VALIDATION_ERROR');
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (e) {
      throw new AppError('Invalid URL format', 400, 'VALIDATION_ERROR');
    }

    const host = parsedUrl.hostname.toLowerCase();
    const mediaHosts = [
      'youtube.com', 'youtu.be', 'instagram.com', 'facebook.com', 'fb.watch',
      'tiktok.com', 'twitter.com', 'x.com', 'vimeo.com', 'dailymotion.com',
    ];
    const isMedia = mediaHosts.some(item => host.includes(item));

    if (isMedia) {
      return res.json({
        success: true,
        data: {
          type: 'media',
          hostname: host,
          protocol: parsedUrl.protocol,
          path: parsedUrl.pathname,
          filename: 'N/A',
          size: 'N/A',
          mimeType: 'N/A',
          resumeCapable: false,
          message: 'Media URL detected. Direct file information not available.'
        }
      });
    }

    try {
      const info = await fetchAccurateFileInfo(targetUrl);
      return res.json({
        success: true,
        data: {
          type: 'direct',
          hostname: host,
          protocol: parsedUrl.protocol,
          path: parsedUrl.pathname,
          finalUrl: info.redirected ? info.finalUrl : undefined,
          filename: info.filename,
          size: info.size,
          sizeBytes: info.sizeBytes,
          mimeType: info.mimeType,
          resumeCapable: info.resumeCapable,
          statusCode: info.statusCode,
          isSizeReliable: info.isSizeReliable,
          isUnknownType: info.isUnknownType,
          message: info.isUnknownType ? 'File type could not be determined' : undefined
        }
      });
    } catch (error) {
      throw new AppError('Failed to fetch file information: ' + error.message, 500, 'FETCH_ERROR');
    }
  }),

  // ===================== URL Check (PUBLIC) =====================

  /**
   * GET /direct-download/check-url?url=
   * Check URL type (public endpoint)
   */
  checkUrl: asyncHandler(async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
      throw new AppError('URL parameter is required', 400, 'VALIDATION_ERROR');
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (e) {
      throw new AppError('Invalid URL format', 400, 'VALIDATION_ERROR');
    }

    const host = parsedUrl.hostname.toLowerCase();
    const mediaHosts = [
      'youtube.com', 'youtu.be', 'instagram.com', 'facebook.com', 'fb.watch',
      'tiktok.com', 'twitter.com', 'x.com', 'vimeo.com', 'dailymotion.com',
    ];
    const isMedia = mediaHosts.some(item => host.includes(item));

    const path = parsedUrl.pathname.toLowerCase();
    const ext = path.includes('.') ? path.split('.').pop() : '';

    const extensions = [
      'zip', 'rar', '7z', 'iso', 'apk', 'exe', 'pdf',
      'mp4', 'mp3', 'wav', 'avi', 'mkv', 'mov',
      'jpg', 'jpeg', 'png', 'gif', 'webp',
      'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'
    ];

    let type = 'Unknown';
    let source = 'Unknown';

    if (isMedia) {
      type = 'Media';
      source = host;
    } else if (extensions.includes(ext)) {
      type = 'Direct File';
      source = ext.toUpperCase() + ' File';
    }

    return res.json({
      success: true,
      data: {
        hostname: host,
        protocol: parsedUrl.protocol,
        path: parsedUrl.pathname || '/',
        type: type,
        source: source
      }
    });
  }),

  // ===================== Media Scan (PUBLIC) =====================

  /**
   * GET /direct-download/scan-media?url=&deep=true
   * Scan a webpage for media content.
   * For known media sites (YouTube, Twitter, etc.) uses yt-dlp for accurate extraction.
   * For other sites uses regex (fast) or headless browser (deep).
   */
  scanMedia: asyncHandler(async (req, res) => {
    const targetUrl = req.query.url;
    const deep = req.query.deep === 'true' || req.query.deep === '1';

    if (!targetUrl) {
      throw new AppError('URL parameter is required', 400, 'VALIDATION_ERROR');
    }

    try {
      // For known media sites, use yt-dlp for accurate extraction
      if (isMediaSite(targetUrl) && ytdlpService.isAvailable()) {
        const result = await ytdlpService.extractInfo(targetUrl);
        return res.json({ success: true, data: result });
      }

      // For other sites, use regex or headless browser
      const { detectMediaFull } = mediaDetector;
      const result = await detectMediaFull(targetUrl, { deep });
      return res.json({ success: true, data: result });
    } catch (error) {
      throw new AppError('Failed to scan media: ' + error.message, 500, 'SCAN_ERROR');
    }
  }),

  /**
   * GET /direct-download/scan-media-deep?url=
   * Deep scan with headless browser
   */
  scanMediaDeep: asyncHandler(async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
      throw new AppError('URL parameter is required', 400, 'VALIDATION_ERROR');
    }

    try {
      const result = await mediaDetector.detectMediaDeep(targetUrl);
      return res.json({ success: true, data: result });
    } catch (error) {
      throw new AppError('Failed to deep-scan media: ' + error.message, 500, 'SCAN_ERROR');
    }
  }),

  // ===================== Proxy Download (PUBLIC) =====================

  /**
   * GET /direct-download/proxy-download?url=&h=
   * Proxy download with custom headers (base64 encoded JSON in `h`)
   */
  proxyDownload: asyncHandler(async (req, res) => {
    const targetUrl = req.query.url;
    const headerBlob = req.query.h;

    if (!targetUrl) {
      throw new AppError('URL parameter is required', 400, 'VALIDATION_ERROR');
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (e) {
      throw new AppError('Invalid URL format', 400, 'VALIDATION_ERROR');
    }

    const https = require('https');
    const http = require('http');

    let forwardHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    if (headerBlob) {
      try {
        const decoded = JSON.parse(Buffer.from(headerBlob, 'base64').toString('utf8'));
        if (decoded.Referer) forwardHeaders['Referer'] = decoded.Referer;
        if (decoded.Origin) forwardHeaders['Origin'] = decoded.Origin;
        if (decoded.Cookie) forwardHeaders['Cookie'] = decoded.Cookie;
        if (decoded['User-Agent']) forwardHeaders['User-Agent'] = decoded['User-Agent'];
      } catch (e) {
        // ignore malformed header blob
      }
    }

    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const upstreamReq = protocol.request(
      {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: forwardHeaders
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, {
          'content-type': upstreamRes.headers['content-type'] || 'application/octet-stream',
          'content-length': upstreamRes.headers['content-length'],
          'content-disposition': upstreamRes.headers['content-disposition'] || 'attachment'
        });
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on('error', (error) => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Upstream fetch failed', details: error.message });
      }
    });

    upstreamReq.setTimeout(30000, () => {
      upstreamReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Upstream request timed out' });
      }
    });

    upstreamReq.end();
  }),

  // ===================== HEAD Proxy (AUTH) =====================

  /**
   * POST /direct-download/fetch-head
   * Proxy HEAD request to external URL to bypass CORS
   */
  fetchHead: asyncHandler(async (req, res) => {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      throw new AppError('URL wajib diisi', 400, 'VALIDATION_ERROR');
    }

    const headers = await downloadService.fetchHeadInfo(url);

    return res.json({
      success: true,
      data: headers,
    });
  }),

  // ===================== Download Management (AUTH) =====================

  /**
   * POST /direct-download/start
   * Start a direct download task
   */
  start: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { url, folder_id, headers, filename, type, merge_urls, quality } = req.body;

    if (!url || typeof url !== 'string') {
      throw new AppError('URL wajib diisi', 400, 'VALIDATION_ERROR');
    }

    let folderId = null;
    if (folder_id !== undefined && folder_id !== null && folder_id !== '' && folder_id !== 'null') {
      folderId = String(folder_id);
    }

    const task = await downloadService.startDownload(url, userId, folderId, {
      headers,
      filename,
      type,
      mergeUrls: merge_urls,
      quality,
    });

    return res.status(201).json({
      success: true,
      message: 'Download dimulai',
      data: task,
    });
  }),

  /**
   * GET /direct-download/list
   * List all download tasks
   */
  list: asyncHandler(async (req, res) => {
    const tasks = await downloadService.listStatuses();
    return res.json({
      success: true,
      data: tasks,
    });
  }),

  /**
   * GET /direct-download/:taskId/status
   * Get download task status
   */
  status: asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const task = await downloadService.getStatus(taskId);
    return res.json({
      success: true,
      data: task,
    });
  }),

  /**
   * POST /direct-download/:taskId/cancel
   */
  cancel: asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const task = await downloadService.cancel(taskId);
    return res.json({
      success: true,
      message: 'Download canceled',
      data: task,
    });
  }),

  /**
   * POST /direct-download/:taskId/pause
   */
  pause: asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const task = await downloadService.pause(taskId);
    return res.json({
      success: true,
      message: 'Download dijeda',
      data: task,
    });
  }),

  /**
   * POST /direct-download/:taskId/resume
   */
  resume: asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const task = await downloadService.resume(taskId);
    return res.json({
      success: true,
      message: 'Download dilanjutkan',
      data: task,
    });
  }),

  /**
   * POST /direct-download/:taskId/retry
   */
  retry: asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const userId = req.user.id;
    const { url, headers, filename, type, folder_id, quality } = req.body || {};

    const overrides = {};
    if (url) overrides.url = url;
    if (headers) overrides.headers = headers;
    if (filename) overrides.filename = filename;
    if (type) overrides.type = type;
    if (quality !== undefined) overrides.quality = quality;
    if (folder_id) overrides.folderId = String(folder_id);
    if (userId) overrides.userId = userId;

    const task = await downloadService.retry(taskId, overrides);
    return res.json({
      success: true,
      message: 'Download diulang',
      data: task,
    });
  }),

  /**
   * DELETE /direct-download/:taskId
   */
  remove: asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const result = downloadService.forget(taskId);
    return res.json({
      success: true,
      message: 'Download dihapus dari daftar',
      data: result,
    });
  }),

  /**
   * GET /direct-download/file/:taskId
   */
  serveFile: asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const file = downloadService.getFile(taskId);
    if (!file) {
      throw new AppError('File tidak tersedia atau download belum selesai', 404, 'NOT_FOUND');
    }
    res.download(file.path, file.filename);
  }),
};

module.exports = DirectDownloadController;
