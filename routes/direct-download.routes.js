const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
const DirectDownloadController = require('../controllers/direct-download.controller');

// ===================== PUBLIC ENDPOINTS (no auth) =====================

// Check aria2 connection status
router.get('/connection', DirectDownloadController.connection);

// Fetch file info from URL (public)
router.get('/file-info', DirectDownloadController.fileInfo);

// Check URL type (public)
router.get('/check-url', DirectDownloadController.checkUrl);

// Scan webpage for media (public)
router.get('/scan-media', DirectDownloadController.scanMedia);

// Deep scan with headless browser (public)
router.get('/scan-media-deep', DirectDownloadController.scanMediaDeep);

// Proxy download with custom headers (public)
router.get('/proxy-download', DirectDownloadController.proxyDownload);

// ===================== AUTH ENDPOINTS (require login) =====================

// Proxy HEAD request to external URL (bypass CORS)
router.post('/fetch-head', authMiddleware, DirectDownloadController.fetchHead);

// Start a new direct download task
router.post('/start', authMiddleware, DirectDownloadController.start);

// List all download tasks
router.get('/list', authMiddleware, DirectDownloadController.list);

// Get task status
router.get('/:taskId/status', authMiddleware, DirectDownloadController.status);

// Cancel a download task
router.post('/:taskId/cancel', authMiddleware, DirectDownloadController.cancel);

// Pause a download task
router.post('/:taskId/pause', authMiddleware, DirectDownloadController.pause);

// Resume a paused download task
router.post('/:taskId/resume', authMiddleware, DirectDownloadController.resume);

// Retry a failed/cancelled download
router.post('/:taskId/retry', authMiddleware, DirectDownloadController.retry);

// Remove a finished/failed/cancelled download from the list
router.delete('/:taskId', authMiddleware, DirectDownloadController.remove);

// Serve the completed file for download
router.get('/file/:taskId', authMiddleware, DirectDownloadController.serveFile);

module.exports = router;