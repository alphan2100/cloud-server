const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { fetch } = require('undici');

/**
 * Service untuk download & generate cover art album
 * - Download dari Cover Art Archive
 * - Fallback: generate placeholder via sharp (gradient + initial letter)
 */

const COVERS_DIR = process.env.MUSIC_COVERS_DIR
  ? path.resolve(process.env.MUSIC_COVERS_DIR)
  : path.join(__dirname, '..', 'music_covers');

function ensureCoversDir() {
  if (!fs.existsSync(COVERS_DIR)) {
    fs.mkdirSync(COVERS_DIR, { recursive: true });
  }
}

/**
 * Generate nama file cover berdasarkan MBID atau hash
 */
function getCoverPath(mbidOrId, ext = '.jpg') {
  ensureCoversDir();
  const safeName = String(mbidOrId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(COVERS_DIR, `cover_${safeName}${ext}`);
}

// Retry config untuk download cover
const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_RETRY_DELAY_MS = 2000;
const DOWNLOAD_TIMEOUT_MS = 15000; // 15 detik (download image lebih besar)

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Download cover dari URL dan simpan ke disk
 * Dengan retry 3x dan timeout 15s
 * @param {string} url - URL cover image
 * @param {string} mbidOrId - identifier untuk nama file
 * @returns {Promise<string|null>} - path lokal cover, atau null jika gagal
 */
async function downloadCover(url, mbidOrId) {
  if (!url || !mbidOrId) return null;

  for (let attempt = 1; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      // AbortController untuk timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) {
        if (attempt < DOWNLOAD_MAX_RETRIES) {
          await sleep(DOWNLOAD_RETRY_DELAY_MS);
          continue;
        }
        return null;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const coverPath = getCoverPath(mbidOrId, '.jpg');

      // Optimasi via sharp: resize ke max 500px, convert ke jpg
      await sharp(buffer)
        .resize(500, 500, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(coverPath);

      return coverPath;
    } catch (err) {
      if (attempt < DOWNLOAD_MAX_RETRIES) {
        // Silent retry, tidak spam log
        await sleep(DOWNLOAD_RETRY_DELAY_MS);
        continue;
      }
      // Log hanya pada attempt terakhir
      console.warn(`[CoverArt] Gagal download setelah ${DOWNLOAD_MAX_RETRIES}x retry: ${err.message}`);
      return null;
    }
  }

  return null;
}

/**
 * Generate placeholder cover (gradient + initial letter)
 * Digunakan ketika Cover Art Archive tidak punya cover
 * 
 * @param {string} mbidOrId - identifier untuk nama file
 * @param {string} text - text untuk initial (biasanya album/artist name)
 * @returns {Promise<string>} - path lokal placeholder
 */
async function generatePlaceholderCover(mbidOrId, text = '') {
  const coverPath = getCoverPath(mbidOrId, '.jpg');
  ensureCoversDir();

  // Ambil huruf pertama dari text, atau '?' jika kosong
  const initial = (text || '').trim().charAt(0).toUpperCase() || '?';

  // Pilih warna gradient berdasarkan hash text
  const hash = hashString(text || mbidOrId);
  const hue = hash % 360;
  const color1 = `hsl(${hue}, 65%, 45%)`;
  const color2 = `hsl(${(hue + 40) % 360}, 65%, 25%)`;

  // Buat SVG placeholder
  const svg = `
    <svg width="500" height="500" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:${color1}" />
          <stop offset="100%" style="stop-color:${color2}" />
        </linearGradient>
      </defs>
      <rect width="500" height="500" fill="url(#grad)" />
      <text x="50%" y="50%" 
            font-family="Arial, sans-serif" 
            font-size="240" 
            font-weight="bold"
            fill="rgba(255,255,255,0.85)" 
            text-anchor="middle" 
            dominant-baseline="central">${initial}</text>
    </svg>`;

  await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toFile(coverPath);

  return coverPath;
}

/**
 * Hash string sederhana untuk menentukan warna placeholder
 */
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Hapus cover dari disk
 */
function deleteCover(coverPath) {
  if (!coverPath) return;
  try {
    if (fs.existsSync(coverPath)) {
      fs.unlinkSync(coverPath);
    }
  } catch (err) {
    console.error(`[CoverArt] Gagal hapus cover: ${err.message}`);
  }
}

/**
 * Cek apakah cover ada di disk
 */
function coverExists(coverPath) {
  if (!coverPath) return false;
  return fs.existsSync(coverPath);
}

/**
 * Download cover dari URL iTunes dan simpan ke disk.
 * iTunes URL sudah HD (600x600), jadi tidak perlu upgrade.
 * Fungsi ini reuse logic downloadCover yang sama (retry, timeout, sharp).
 *
 * @param {string} url - URL cover image dari iTunes
 * @param {string} id - identifier untuk nama file (e.g., iTunes collectionId atau album title hash)
 * @returns {Promise<string|null>} - path lokal cover, atau null jika gagal
 */
async function downloadCoverFromItunes(url, id) {
  if (!url || !id) return null;
  // Gunakan logic yang sama dengan downloadCover
  return await downloadCover(url, `itunes_${id}`);
}

module.exports = {
  downloadCover,
  downloadCoverFromItunes,
  generatePlaceholderCover,
  deleteCover,
  coverExists,
  getCoverPath,
  COVERS_DIR,
};
