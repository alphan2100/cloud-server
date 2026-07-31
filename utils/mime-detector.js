/**
 * MIME Type Detector
 * 
 * Utility to detect MIME type from file extension.
 * This is needed because browsers/flutter-webview often send incorrect
 * MIME types for certain file formats (e.g., MKV files frequently come
 * as 'application/octet-stream' instead of 'video/x-matroska').
 * 
 * By detecting from extension, we ensure:
 * - Correct categorization in storage summary (video/image/audio/etc)
 * - Correct filtering in FileController.list() by type
 * - Video remux & thumbnail generation works for all video files
 * - Files appear in the correct category pages (VideoPage, ImagesPage, etc.)
 */

const path = require('path');

// Map of common extensions to their MIME types
// Focus is on getting the correct broad category (video/, image/, audio/, etc.)
// rather than being 100% precise on the exact subtype.
const EXTENSION_MIME_MAP = {
  // Video formats
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.ogv': 'video/ogg',
  '.divx': 'video/x-msvideo',

  // Image formats
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',

  // Audio formats
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.opus': 'audio/opus',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',

  // Document formats
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
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',

  // Code / text formats (commonly used as documents)
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.php': 'text/plain',
  '.py': 'text/x-python',
  '.java': 'text/x-java',
  '.go': 'text/x-go',
  '.rs': 'text/plain',
  '.sql': 'text/plain',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.md': 'text/markdown',
  '.vue': 'text/plain',

  // Archive formats
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  '.xz': 'application/x-xz',
  '.tgz': 'application/gzip',
};

// MIME type categories
const CATEGORY_MAP = {
  'video/': 'video',
  'image/': 'image',
  'audio/': 'audio',
  'text/': 'document',
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml': 'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml': 'document',
  'application/json': 'document',
  'application/xml': 'document',
  'application/zip': 'archive',
  'application/x-rar-compressed': 'archive',
  'application/x-7z-compressed': 'archive',
  'application/x-tar': 'archive',
  'application/gzip': 'archive',
  'application/x-bzip2': 'archive',
  'application/x-xz': 'archive',
};

// Common video extensions (for quick checks)
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v',
  '.mpeg', '.mpg', '.wmv', '.flv', '.3gp', '.ts',
  '.mts', '.m2ts', '.ogv', '.divx',
]);

// Common image extensions
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg',
  '.bmp', '.ico', '.tiff', '.tif', '.avif', '.heic', '.heif',
]);

// Common audio extensions
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg',
  '.wma', '.opus', '.mid', '.midi',
]);

/**
 * Detect MIME type from filename/extension.
 * Returns the detected MIME type, or null if unknown.
 * 
 * @param {string} filename - The original filename
 * @returns {string|null} Detected MIME type, or null
 */
function detectMimeFromExtension(filename) {
  if (!filename || typeof filename !== 'string') return null;
  
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_MIME_MAP[ext] || null;
}

/**
 * Normalize/validate a MIME type against the file's extension.
 * If the provided MIME type is reliable (starts with a known category),
 * it is returned as-is. Otherwise, we try to detect from extension.
 * 
 * This solves the problem where browsers/WebViews send incorrect MIME types
 * like 'application/octet-stream' for MKV files.
 * 
 * @param {string} mimeType - The MIME type from the upload (may be unreliable)
 * @param {string} filename - The original filename
 * @returns {string} The best-guess MIME type
 */
function normalizeMimeType(mimeType, filename) {
  // If no MIME type provided at all, detect from extension
  if (!mimeType || mimeType === '' || mimeType === 'application/octet-stream') {
    const detected = detectMimeFromExtension(filename);
    return detected || mimeType || 'application/octet-stream';
  }

  // If MIME type starts with a known broad category, it's likely correct
  if (
    mimeType.startsWith('video/') ||
    mimeType.startsWith('image/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('text/')
  ) {
    return mimeType;
  }

  // For application/* types, verify against extension
  if (mimeType.startsWith('application/')) {
    const detected = detectMimeFromExtension(filename);
    if (detected) {
      // If extension detection gives a different category (e.g., video/),
      // prefer the extension-based detection
      if (
        detected.startsWith('video/') ||
        detected.startsWith('image/') ||
        detected.startsWith('audio/')
      ) {
        return detected;
      }
      // For application types, trust the detected one from extension
      return detected;
    }
  }

  // For unknown/unexpected MIME types, try extension detection
  const detected = detectMimeFromExtension(filename);
  if (detected) {
    return detected;
  }

  // If all else fails, return the original MIME type
  return mimeType;
}

/**
 * Check if a file is a video by MIME type or extension (as fallback).
 * 
 * @param {string} mimeType - The MIME type
 * @param {string} filename - The original filename (optional, for fallback)
 * @returns {boolean}
 */
function isVideoFile(mimeType, filename) {
  if (mimeType && mimeType.startsWith('video/')) return true;
  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  }
  return false;
}

/**
 * Check if a file is an image by MIME type or extension (as fallback).
 * 
 * @param {string} mimeType - The MIME type
 * @param {string} filename - The original filename (optional, for fallback)
 * @returns {boolean}
 */
function isImageFile(mimeType, filename) {
  if (mimeType && mimeType.startsWith('image/')) return true;
  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  }
  return false;
}

/**
 * Check if a file is audio by MIME type or extension (as fallback).
 * 
 * @param {string} mimeType - The MIME type
 * @param {string} filename - The original filename (optional, for fallback)
 * @returns {boolean}
 */
function isAudioFile(mimeType, filename) {
  if (mimeType && mimeType.startsWith('audio/')) return true;
  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    return AUDIO_EXTENSIONS.has(ext);
  }
  return false;
}

/**
 * Get category for a file based on MIME type (with extension fallback).
 * Matches the same categories used in FileController.list() and storageSummary().
 * 
 * @param {string} mimeType - The MIME type
 * @param {string} filename - The original filename (optional, for fallback)
 * @returns {string} One of: 'video', 'image', 'audio', 'document', 'archive', 'other'
 */
function getCategory(mimeType, filename) {
  if (!mimeType && !filename) return 'other';

  // Check by MIME type first
  if (mimeType) {
    // Video
    if (mimeType.startsWith('video/')) return 'video';
    // Image
    if (mimeType.startsWith('image/')) return 'image';
    // Audio
    if (mimeType.startsWith('audio/')) return 'audio';
    // Document (text/* or known application types)
    if (mimeType.startsWith('text/')) return 'document';
    if (mimeType.startsWith('application/pdf')) return 'document';
    if (mimeType.startsWith('application/msword')) return 'document';
    if (mimeType.startsWith('application/vnd.openxmlformats-officedocument.wordprocessingml')) return 'document';
    if (mimeType.startsWith('application/vnd.ms-excel')) return 'document';
    if (mimeType.startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml')) return 'document';
    if (mimeType.startsWith('application/vnd.ms-powerpoint')) return 'document';
    if (mimeType.startsWith('application/vnd.openxmlformats-officedocument.presentationml')) return 'document';
    if (mimeType.startsWith('application/json')) return 'document';
    if (mimeType.startsWith('application/xml')) return 'document';
    // Archive
    if (mimeType.startsWith('application/zip')) return 'archive';
    if (mimeType.startsWith('application/x-rar-compressed')) return 'archive';
    if (mimeType.startsWith('application/x-7z-compressed')) return 'archive';
    if (mimeType.startsWith('application/x-tar')) return 'archive';
    if (mimeType.startsWith('application/gzip')) return 'archive';
    if (mimeType.startsWith('application/x-bzip2')) return 'archive';
  }

  // Fallback: detect by extension
  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
    // Documents by extension
    if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.rtf', '.odt', '.ods'].includes(ext)) return 'document';
    if (['.json', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.php', '.py', '.java', '.go', '.rs', '.sql', '.yaml', '.yml', '.md', '.vue'].includes(ext)) return 'document';
    // Archives by extension
    if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz'].includes(ext)) return 'archive';
  }

  return 'other';
}

module.exports = {
  detectMimeFromExtension,
  normalizeMimeType,
  isVideoFile,
  isImageFile,
  isAudioFile,
  getCategory,
  EXTENSION_MIME_MAP,
};