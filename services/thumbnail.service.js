const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

/**
 * Thumbnails directory path (configurable via environment variable)
 */
const THUMBNAILS_DIR = process.env.THUMBNAILS_DIR 
  ? path.resolve(process.env.THUMBNAILS_DIR)
  : path.join(__dirname, '..', 'thumbnails');

/**
 * Ensure thumbnails directory exists
 */
function ensureThumbnailsDir() {
  if (!fs.existsSync(THUMBNAILS_DIR)) {
    fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
  }
}

/**
 * Generate thumbnail path from original file path.
 * Thumbnail is stored in a dedicated thumbnails/ directory
 * with the same relative structure as the original file.
 * 
 * Example:
 *   file_path: "uploads/user_1/folder_root/abc.jpg"
 *   thumb_path: "thumbnails/user_1/folder_root/thumb_abc.jpg"
 */
function getThumbnailPath(filePath) {
  ensureThumbnailsDir();
  
  // Normalize path and handle both absolute and relative paths
  let normalizedPath = filePath.replace(/\\/g, '/');
  
  // Get the relative path from uploads directory
  let relativePath;
  if (normalizedPath.startsWith('uploads/')) {
    relativePath = normalizedPath.slice('uploads/'.length);
  } else if (normalizedPath.includes('/uploads/')) {
    // Handle absolute paths like /path/to/cloud-server/uploads/user_1/...
    const uploadsIndex = normalizedPath.indexOf('/uploads/');
    relativePath = normalizedPath.substring(uploadsIndex + '/uploads/'.length);
  } else {
    relativePath = normalizedPath;
  }
  
  const ext = path.extname(relativePath);
  const base = path.basename(relativePath, ext);
  const dir = path.dirname(relativePath);
  
  return path.join(THUMBNAILS_DIR, dir, `thumb_${base}${ext}`);
}

/**
 * Check if a file is an image based on mime type
 */
function isImageFile(mimeType) {
  if (!mimeType) return false;
  return mimeType.startsWith('image/');
}

/**
 * Check if a file is a video based on mime type
 */
function isVideoFile(mimeType) {
  if (!mimeType) return false;
  return mimeType.startsWith('video/');
}

/**
 * Generate thumbnail for an image using sharp.
 * Creates a very small thumbnail (max 200px width, quality 60).
 * 
 * @param {string} inputPath - Path to original image
 * @param {string} outputPath - Path to save thumbnail
 * @returns {Promise<string>} - Path to thumbnail
 */
async function generateImageThumbnail(inputPath, outputPath) {
  try {
    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    await sharp(inputPath)
      .resize(400, 400, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toFile(outputPath);
    
    return outputPath;
  } catch (err) {
    throw new Error(`Gagal membuat thumbnail gambar: ${err.message}`);
  }
}

/**
 * Generate thumbnail for a video using fluent-ffmpeg.
 * Extracts a frame at 1 second, resizes to small size.
 * 
 * @param {string} inputPath - Path to original video
 * @param {string} outputPath - Path to save thumbnail (must be .jpg)
 * @returns {Promise<string>} - Path to thumbnail
 */
function generateVideoThumbnail(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Ensure output path has .jpg extension for consistency
    const thumbPath = outputPath.replace(/\.\w+$/, '.jpg');
    
    ffmpeg(inputPath)
      .on('end', () => {
        resolve(thumbPath);
      })
      .on('error', (err) => {
        reject(new Error(`Gagal membuat thumbnail video: ${err.message}`));
      })
      .screenshots({
        count: 1,
        timemarks: ['1'], // 1 second into the video
        size: '400x?', // 400px width, auto height
        filename: path.basename(thumbPath),
        folder: path.dirname(thumbPath),
      });
  });
}

/**
 * Generate thumbnail based on file type.
 * 
 * @param {string} inputPath - Path to original file
 * @param {string} mimeType - MIME type of the file
 * @returns {Promise<string|null>} - Path to generated thumbnail, or null if type not supported
 */
async function generateThumbnail(inputPath, mimeType) {
  if (!fs.existsSync(inputPath)) {
    return null;
  }

  const thumbPath = getThumbnailPath(inputPath);

  try {
    if (isImageFile(mimeType)) {
      return await generateImageThumbnail(inputPath, thumbPath);
    } else if (isVideoFile(mimeType)) {
      // For video, use .jpg extension for thumbnail
      return await generateVideoThumbnail(inputPath, thumbPath);
    }
  } catch (err) {
    console.error(`Thumbnail generation failed: ${err.message}`);
    // Clean up partial thumbnail if exists
    try {
      if (fs.existsSync(thumbPath)) {
        fs.unlinkSync(thumbPath);
      }
      // Also try jpg variant for video
      const jpgPath = thumbPath.replace(/\.\w+$/, '.jpg');
      if (fs.existsSync(jpgPath)) {
        fs.unlinkSync(jpgPath);
      }
    } catch (e) { /* ignore */ }
  }

  return null;
}

/**
 * Delete thumbnail for a file.
 * 
 * @param {string} filePath - Path to original file
 */
function deleteThumbnail(filePath) {
  const thumbPath = getThumbnailPath(filePath);
  try {
    if (fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
    }
    // Also try .jpg variant (for video thumbnails converted to jpg)
    const jpgPath = getThumbnailPath(filePath).replace(/\.\w+$/, '.jpg');
    if (fs.existsSync(jpgPath)) {
      fs.unlinkSync(jpgPath);
    }
  } catch (err) {
    console.error(`Gagal menghapus thumbnail: ${err.message}`);
  }
}

/**
 * Check if a thumbnail exists for the given file path.
 * 
 * @param {string} filePath - Path to original file
 * @returns {boolean}
 */
function thumbnailExists(filePath) {
  // Check both possible thumbnail paths (original ext and .jpg for videos)
  const thumbPath = getThumbnailPath(filePath);
  if (fs.existsSync(thumbPath)) return true;
  
  const jpgPath = getThumbnailPath(filePath).replace(/\.\w+$/, '.jpg');
  return fs.existsSync(jpgPath);
}

module.exports = {
  generateThumbnail,
  generateImageThumbnail,
  generateVideoThumbnail,
  getThumbnailPath,
  deleteThumbnail,
  thumbnailExists,
  isImageFile,
  isVideoFile,
};