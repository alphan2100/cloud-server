const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/auth.middleware");
const { upload } = require("../middlewares/upload.middleware");
const FileController = require("../controllers/file.controller");
const DownloadController = require("../controllers/download.controller");

// Upload single file
router.post(
  "/upload",
  authMiddleware,
  upload.single("file"),
  FileController.upload
);

// Upload multiple files
router.post(
  "/upload-multiple",
  authMiddleware,
  upload.array("files", 10), // max 10 files sekaligus
  FileController.uploadMultiple
);

// Storage summary (must be before /:id to avoid conflict)
router.get("/storage-summary", authMiddleware, FileController.storageSummary);

// List files by folder
router.get('/', authMiddleware, FileController.list);

// Get single file by ID
router.get('/:id', authMiddleware, FileController.getById);

// Download file
router.get("/:id/download", authMiddleware, DownloadController.download);

// Preview file (inline view)
router.get("/:id/view", authMiddleware, DownloadController.preview);

// Soft delete (pindah ke trash)
router.delete("/:id", authMiddleware, FileController.delete);

// Rename file
router.put("/:id/rename", authMiddleware, FileController.rename);

// Copy file
router.post("/:id/copy", authMiddleware, FileController.copy);

// Serve thumbnail for image/video
router.get("/:id/thumbnail", authMiddleware, DownloadController.serveThumbnail);

// Download multiple files/folders as zip
router.post("/download-multiple", authMiddleware, DownloadController.downloadMultiple);

module.exports = router;
