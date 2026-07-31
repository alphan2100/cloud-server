const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/auth.middleware");
const { chunkUpload } = require("../middlewares/upload.middleware");
const ChunkedUploadController = require("../controllers/chunked-upload.controller");

// Upload single chunk
router.post(
  "/upload-chunk",
  authMiddleware,
  chunkUpload.single("chunk"),
  ChunkedUploadController.uploadChunk
);

// Check upload status
router.get(
  "/upload-status/:fileHash",
  authMiddleware,
  ChunkedUploadController.getUploadStatus
);

// Cancel upload
router.delete(
  "/upload-cancel/:fileHash",
  authMiddleware,
  ChunkedUploadController.cancelUpload
);

module.exports = router;