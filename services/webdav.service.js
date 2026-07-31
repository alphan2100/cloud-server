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

// ------------------------- Per-file processing lock -------------------------
// Setelah PUT selesai menulis+rename, thumbnail/remux dijalankan DI BACKGROUND
// (tidak lagi menahan response — lihat catatan panjang di putFile/_processFile
// soal kenapa "await sebelum respond" versi sebelumnya masih punya celah race
// DAN bikin client WebDAV timeout duluan untuk video besar). Supaya PUT lain
// untuk nama file yang SAMA (mis. client retry karena mengira request
// sebelumnya gagal/timeout) tidak menghapus atau menimpa file yang masih
// aktif dibaca ffmpeg, kita simpan promise proses yang sedang berjalan di
// sini, dikunci per (userId, parentId, fileName) — bukan per path fisik,
// karena path fisik selalu random tiap attempt.
const _fileProcessingLocks = new Map();
function _fileLockKey(userId, parentId, fileName) {
  return `${userId}:${parentId === null ? 'root' : parentId}:${fileName}`;
}

// ------------------------- Stale temp file cleanup -------------------------
// Kalau PUT WebDAV putus di tengah jalan (client disconnect, jaringan mati,
// dsb) dan client TIDAK retry, file "<nama>.tmp" yang sempat ditulis di
// uploads/temp/user_{id}/ akan tertinggal selamanya karena tidak pernah
// di-rename maupun dihapus. Job ini jalan berkala untuk membersihkan
// file .tmp yang usianya sudah melewati batas wajar (upload macet/ditinggal).
const STALE_TMP_MAX_AGE_MS = parseInt(process.env.WEBDAV_STALE_TMP_MAX_AGE_MS, 10) || 24 * 60 * 60 * 1000; // default 24 jam
const STALE_TMP_CLEANUP_INTERVAL_MS = parseInt(process.env.WEBDAV_STALE_TMP_CLEANUP_INTERVAL_MS, 10) || 60 * 60 * 1000; // default tiap 1 jam
// Batas idle-timeout socket selama streaming PUT. Besar (default 60 menit)
// supaya upload file besar di jaringan lambat tetap muat, tapi TERBATAS
// (bukan Infinity) supaya koneksi yang benar-benar mati diam-diam akhirnya
// dibersihkan, bukan menggantung selamanya.
const PUT_SOCKET_TIMEOUT_MS = parseInt(process.env.WEBDAV_PUT_SOCKET_TIMEOUT_MS, 10) || 60 * 60 * 1000; // default 60 menit

function cleanupStaleTempFilesOnce() {
  const tempRoot = path.join(UPLOADS_DIR, 'temp');
  if (!fs.existsSync(tempRoot)) return;

  let userDirs;
  try {
    userDirs = fs.readdirSync(tempRoot, { withFileTypes: true });
  } catch (e) {
    console.error(`[webdav-cleanup] Gagal membaca ${tempRoot}: ${e.message}`);
    return;
  }

  const now = Date.now();
  let removedCount = 0;

  for (const entry of userDirs) {
    if (!entry.isDirectory()) continue;
    const userTempDir = path.join(tempRoot, entry.name);

    let files;
    try {
      files = fs.readdirSync(userTempDir);
    } catch (e) {
      continue;
    }

    for (const file of files) {
      // Hanya sentuh file sisa PUT WebDAV (".tmp"), jangan sentuh chunk
      // upload biasa (chunked-upload) yang formatnya beda dan sudah
      // punya mekanisme cleanup sendiri (cancelUpload / assembly selesai).
      if (!file.endsWith('.tmp')) continue;

      const filePath = path.join(userTempDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > STALE_TMP_MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          removedCount++;
        }
      } catch (e) {
        // File mungkin sudah dihapus proses lain di antara readdir & stat, abaikan
      }
    }
  }

  if (removedCount > 0) {
    console.log(`[webdav-cleanup] Menghapus ${removedCount} temp file WebDAV yatim (usia > ${STALE_TMP_MAX_AGE_MS / 3600000} jam)`);
  }
}

// Jadwalkan pembersihan otomatis selama proses server hidup.
// module require() di-cache oleh Node, jadi interval ini cuma dibuat sekali
// walau service ini di-require dari banyak file (controller, dsb).
let _cleanupIntervalHandle = null;
function startStaleTempFileCleanup() {
  if (_cleanupIntervalHandle) return; // sudah jalan, jangan dobel
  // Jalankan sekali di awal (misal sisa dari sebelum server restart),
  // lalu ulangi tiap STALE_TMP_CLEANUP_INTERVAL_MS.
  cleanupStaleTempFilesOnce();
  _cleanupIntervalHandle = setInterval(cleanupStaleTempFilesOnce, STALE_TMP_CLEANUP_INTERVAL_MS);
  // unref supaya interval ini tidak mencegah proses Node exit (mis. saat testing/CLI script)
  _cleanupIntervalHandle.unref();
}

startStaleTempFileCleanup();

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
 * Parse header Content-Range dari REQUEST (bukan response) PUT.
 *
 * KENAPA INI PERLU: sebagian client WebDAV -- terutama Windows WebClient/
 * Mini-Redirector yang dipakai Explorer "Add a network location" -- TIDAK
 * selalu mengirim file besar dalam SATU PUT utuh. Untuk file di atas ukuran
 * tertentu, Windows memecahnya jadi BEBERAPA request PUT terpisah ke URL yang
 * SAMA, masing-masing membawa header:
 *   Content-Range: bytes <start>-<end>/<total>
 * dan body request itu HANYA berisi potongan byte <start>..<end> saja, BUKAN
 * seluruh file. Ini bukan bagian dari RFC 4918 (WebDAV standar tidak kenal
 * "chunked PUT"), tapi ini konvensi de-facto yang dipakai beberapa WebDAV
 * client termasuk Windows -- dan kalau server tidak menanganinya secara
 * eksplisit, tiap potongan akan diperlakukan seolah itu FILE LENGKAP (karena
 * dari sudut pandang HTTP polos, itu cuma "PUT dengan body sekian byte").
 * Ini persis penyebab thumbnail/remux gagal dengan "Invalid data found" pada
 * upload yang PADA AKHIRNYA berhasil: potongan pertama (mis. 5MB) sempat
 * ditulis sebagai "file lengkap" dan langsung diproses ffmpeg sebelum
 * potongan berikutnya datang.
 *
 * Return null kalau header tidak ada / formatnya tidak valid -> caller harus
 * anggap ini PUT utuh biasa (jalur lama, tidak berubah).
 */
function parseContentRange(header) {
  if (!header) return null;
  // Format standar HTTP Content-Range: "bytes <start>-<end>/<total>"
  // Total bisa "*" kalau client tidak tahu ukuran akhir -- kita TIDAK
  // mendukung kasus ini (lihat pengecekan di _putFileChunk) karena tanpa
  // total kita tidak bisa memastikan kapan file benar-benar lengkap.
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return null;

  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  const total = match[3] === '*' ? null : parseInt(match[3], 10);

  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return { start, end, total };
}
/**
 * Generate a unique stored filename.
 * Pola disamakan dengan chunked-upload.controller.js & upload biasa (multer)
 * supaya stored_filename konsisten di semua jalur upload: "<timestamp>-<random>.ext"
 */
function generateStoredFilename(originalName) {
  const ext = path.extname(originalName);
  return `${Date.now()}-${Math.random().toString(36).substring(2)}${ext}`;
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
   * Streams directly to disk without buffering entire file in memory.
   *
   * @param {Object} req - Express request object (raw body is the file content)
   * @param {number} userId
   * @param {number|null} parentId
   * @param {string} fileName
   * @param {string} mimeType
   * @returns {Promise<{overwritten: boolean}>}
   */
  async putFile(req, userId, parentId, fileName, mimeType) {
    // Lapisan kedua (selain di controller): pastikan idle-timeout socket
    // dilonggarkan (bukan dimatikan total) selama streaming PUT berlangsung.
    // INI SATU-SATUNYA tempat socket timeout diatur untuk PUT (jangan
    // ditambahkan lagi di controller) — koneksi WebDAV biasanya keep-alive
    // dan dipakai berulang untuk banyak file, jadi kalau ada dua tempat yang
    // sama-sama memanggil setTimeout(ms, callback) untuk request yang sama,
    // listener 'timeout' menumpuk terus tiap request baru di socket yang
    // sama (leak) — lihat MaxListenersExceededWarning yang sempat muncul.
    // Listener ini SELALU dilepas lagi di blok `finally` di bawah begitu
    // request ini selesai, apapun hasilnya.
    //
    // SEBELUMNYA (setTimeout(0), nonaktif total) — niatnya supaya upload file
    // besar di jaringan lambat tidak diputus paksa. Tapi timeout 0 berarti
    // kalau koneksi mati DIAM-DIAM (paket berhenti sampai tanpa RST/FIN),
    // loop "for await" di bawah bisa nunggu SELAMANYA. Pakai timeout yang
    // besar tapi TERBATAS, dan kalau tercapai, betulan putuskan socket-nya.
    const onSocketTimeout = () => {
      req.socket.destroy(new Error(`Socket timeout setelah ${PUT_SOCKET_TIMEOUT_MS}ms tanpa aktivitas saat upload "${fileName}"`));
    };
    if (req.socket && typeof req.socket.setTimeout === 'function') {
      req.socket.setTimeout(PUT_SOCKET_TIMEOUT_MS, onSocketTimeout);
    }

    // KRITIS: pasang listener 'error'/'aborted' di `req` SEKARANG, sebelum apa pun
    // lain terjadi. Cukup untuk menutupi fase penulisan body (write loop di
    // bawah) — thumbnail/remux sekarang jalan di BACKGROUND setelah response
    // dikirim (lihat catatan di bagian _processFile), jadi `req` sudah tidak
    // relevan lagi di fase itu.
    //
    // Kenapa listener ini tetap wajib ada: kalau koneksi client putus
    // (jaringan mati, dsb) SELAMA fase penulisan body, atau bahkan SESAAT
    // sebelum response dikirim, Node akan memanggil abortIncoming() secara
    // internal dan men-destroy `req` dengan sebuah Error. Kalau di saat itu
    // TIDAK ADA listener 'error' terpasang di `req` (mis. karena listener
    // dari for-await-of di bawah sudah "lepas" setelah loop-nya selesai),
    // EventEmitter Node akan melempar error itu sebagai UNCAUGHT EXCEPTION —
    // yang berarti MENJATUHKAN SELURUH PROSES NODE, bukan cuma gagalin satu
    // request. Ini persis pola di log sebelumnya: "Error: aborted ... at
    // abortIncoming (node:_http_server:796:17) ... code: 'ECONNRESET'".
    // Crash proses di tengah jalan itulah yang tadinya ikut merusak
    // upload/remux LAIN yang sedang berjalan bersamaan di request berbeda.
    let clientAborted = false;
    const onReqAborted = () => { clientAborted = true; };
    const onReqError = (err) => {
      clientAborted = true;
      console.error(`[webdav-put] Koneksi client terputus saat upload "${fileName}": ${err.message}`);
    };
    req.on('aborted', onReqAborted);
    req.on('error', onReqError);

    try {
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

    // ------------------------- Segmented PUT (Content-Range) -------------------------
    // Cek dulu sebelum jalur PUT utuh biasa di bawah. Lihat komentar panjang di
    // parseContentRange() soal kenapa ini WAJIB ada (Windows WebClient dkk).
    const contentRange = parseContentRange(req.headers['content-range']);
    if (contentRange) {
      // Log diagnostik ringan -- berguna untuk konfirmasi apakah client
      // (mis. Windows WebClient) memang mengirim PUT bertahap untuk file
      // tertentu, dan untuk memantau di potongan keberapa proses sedang
      // berjalan kalau ada masalah.
      console.log(`[webdav-put] Potongan Content-Range diterima untuk "${fileName}": bytes ${contentRange.start}-${contentRange.end}/${contentRange.total}`);
      const lockKeyForRange = _fileLockKey(userId, parentId, fileName);
      // Tunggu proses background (thumbnail/remux) dari upload SEBELUMNYA untuk
      // nama file yang sama, sama seperti jalur PUT utuh -- supaya potongan baru
      // tidak menimpa file yang masih aktif dibaca ffmpeg dari upload lain.
      const priorLockForRange = _fileProcessingLocks.get(lockKeyForRange);
      if (priorLockForRange) {
        await priorLockForRange.catch(() => {});
      }
      return await this._putFileChunk(req, userId, parentId, fileName, mimeType, contentRange, lockKeyForRange);
    }

    // Kunci proses per identitas LOGIS file (user + folder tujuan + nama),
    // BUKAN path fisik (yang selalu random tiap attempt). Kalau PUT ini
    // adalah retry/duplikat untuk nama file yang SAMA yang PUT sebelumnya
    // masih sedang diproses (thumbnail/remux) di background, tunggu dulu
    // proses itu selesai sebelum kita lanjut cari/replace "existingFile" —
    // supaya kita tidak menghapus atau menimpa file yang sedang aktif
    // dibaca ffmpeg dari request lain. Lihat catatan detail di bagian
    // penjadwalan _processFile di bawah soal kenapa ini perlu.
    const lockKey = _fileLockKey(userId, parentId, fileName);
    const priorLock = _fileProcessingLocks.get(lockKey);
    if (priorLock) {
      await priorLock.catch(() => {}); // errornya sendiri sudah di-log di tempat asalnya
    }

    // Check if file already exists (for overwrite detection)
    const existingFile = await this._findFileByParentAndName(userId, parentId, fileName);

    // Beberapa client WebDAV (macOS Finder, dll) tidak kirim Content-Type header
    // Fallback: deteksi dari ekstensi file
    const safeMimeType = mimeType || detectMimeType(fileName);

    // Generate new stored filename
    const storedFilename = generateStoredFilename(fileName);
    const targetDir = parentId === null
      ? path.join(getUserDir(userId), 'folder_root')
      : getFolderDir(userId, parentId);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetPath = path.join(targetDir, storedFilename);

    // Use centralized temp directory (same as chunked upload)
    // Path: uploads/temp/user_{userId}/
    const tempDir = path.join(process.env.UPLOADS_DIR, 'temp', `user_${userId}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Temp file path in centralized temp directory
    const tempPath = path.join(tempDir, `${storedFilename}.tmp`);

    // If overwriting, delete old file AFTER new file is successfully written
    // (deletion moved to after stream completes)
    let fileSize = 0;
    let writeStream = null;

    try {
      // Create write stream to temp file
      writeStream = fs.createWriteStream(tempPath);

      // Handle backpressure properly - wait for drain if buffer is full
      for await (const chunk of req) {
        fileSize += chunk.length;
        
        // Wait for stream to be ready if buffer is full (backpressure)
        await new Promise((resolve, reject) => {
          const canWrite = writeStream.write(chunk, (err) => {
            if (err) reject(err);
            else resolve();
          });
          
          if (!canWrite) {
            // Buffer is full, wait for drain event
            writeStream.once('drain', resolve);
          }
        });
      }
      
      // End the stream
      writeStream.end();
      
      // Wait for stream to finish writing
      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    } catch (err) {
      // Cleanup temp file on error
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch (e) { /* ignore cleanup error */ }
      }
      throw err;
    }

    // Lapisan pertahanan ketiga: kalau `req` sempat memberi tahu kita (lewat
    // listener yang dipasang di awal fungsi) bahwa koneksi client putus,
    // JANGAN lanjutkan — walaupun for-await di atas selesai tanpa melempar
    // error dan walaupun client TIDAK mengirim header Content-Length (jadi
    // pengecekan declaredLength di bawah tidak berlaku/tidak bisa mendeteksi
    // apa-apa). Ini menutup celah untuk client yang upload pakai
    // Transfer-Encoding: chunked tanpa Content-Length.
    if (clientAborted) {
      try {
        fs.unlinkSync(tempPath);
      } catch (e) { /* ignore cleanup error */ }
      throw new AppError(
        `Upload dibatalkan: koneksi client terputus di tengah transfer file "${fileName}"`,
        400,
        'BAD_REQUEST'
      );
    }

    // Lapisan pertahanan tambahan: req.complete adalah properti bawaan Node
    // (bukan event custom seperti 'aborted'/'error' yang urutannya bisa
    // meleset relatif terhadap kapan loop for-await selesai) yang secara
    // andal menandakan apakah SELURUH body benar-benar diterima utuh, baik
    // untuk request ber-Content-Length maupun Transfer-Encoding: chunked.
    // Ini menutup celah kalau 'aborted'/'error' entah kenapa belum sempat
    // ter-set ke `clientAborted` di titik pengecekan ini.
    if (req.complete !== true) {
      try {
        fs.unlinkSync(tempPath);
      } catch (e) { /* ignore cleanup error */ }
      throw new AppError(
        `Upload tidak lengkap: koneksi client terputus sebelum body selesai diterima untuk "${fileName}"`,
        400,
        'BAD_REQUEST'
      );
    }

    // Lapisan pertahanan kedua: pada koneksi yang lambat/tidak stabil, ADA
    // kemungkinan (walau jarang) socket ditutup di tengah transfer tanpa
    // Node melempar error ke loop "for await" di atas — hasilnya body
    // dianggap "selesai" padahal isinya cuma sepotong. Kalau client mengirim
    // header Content-Length, kita bisa verifikasi jumlah byte yang benar-benar
    // diterima cocok dengan yang dijanjikan SEBELUM file ini dipakai untuk
    // menimpa file lama atau diproses thumbnail/remux.
    const declaredLength = req.headers['content-length'] != null
      ? parseInt(req.headers['content-length'], 10)
      : null;
    if (declaredLength !== null && !Number.isNaN(declaredLength) && fileSize !== declaredLength) {
      try {
        fs.unlinkSync(tempPath);
      } catch (e) { /* ignore cleanup error */ }
      throw new AppError(
        `Upload tidak lengkap: menerima ${fileSize} byte, seharusnya ${declaredLength} byte (koneksi kemungkinan terputus di tengah transfer)`,
        400,
        'BAD_REQUEST'
      );
    }

    // Overwrite + atomic rename + simpan DB + jalankan thumbnail/remux di
    // background -- logic ini di-share dengan jalur PUT bertahap (Content-Range)
    // lewat _finalizePutFile, lihat definisinya di bawah untuk detail lengkap.
    const result = await this._finalizePutFile({
      userId, parentId, fileName, mimeType: safeMimeType,
      tempPath, targetDir, storedFilename, targetPath, fileSize,
      existingFile, lockKey,
    });

    return result;
    } finally {
      // Selalu lepas listener ini di akhir, apapun jalur keluarnya (return
      // normal, skip junk file, atau throw) — supaya tidak menumpuk listener
      // di `req`/socket kalau koneksi ini dipakai lagi (keep-alive) untuk
      // request WebDAV berikutnya.
      req.removeListener('aborted', onReqAborted);
      req.removeListener('error', onReqError);
      if (req.socket && typeof req.socket.removeListener === 'function') {
        req.socket.removeListener('timeout', onSocketTimeout);
      }
    }
  },

  /**
   * Finalisasi PUT: hapus file lama (kalau overwrite), rename atomic temp ->
   * final, simpan/update record DB, lalu jalankan thumbnail/remux di
   * BACKGROUND (tidak menahan response -- lihat catatan panjang soal ini di
   * bagian bawah fungsi, dipertahankan dari versi sebelumnya).
   *
   * Dipakai bersama oleh:
   *  - PUT utuh biasa (single-shot, lewat putFile langsung)
   *  - PUT bertahap Content-Range setelah potongan TERAKHIR diterima
   *    (lewat _putFileChunk)
   * supaya kedua jalur punya jaminan konsistensi yang SAMA persis (tidak ada
   * logic overwrite/rename/DB yang tercecer beda antara dua jalur).
   */
  async _finalizePutFile({ userId, parentId, fileName, mimeType, tempPath, targetDir, storedFilename, targetPath, fileSize, existingFile, lockKey }) {
    // If overwriting, delete old file AFTER new file is successfully written
    if (existingFile) {
      if (existingFile.file_path && fs.existsSync(existingFile.file_path)) {
        try {
          fs.unlinkSync(existingFile.file_path);
        } catch (e) {
          console.error(`Failed to delete old file: ${e.message}`);
        }
      }
    }

    // Atomic rename: temp file → final filename
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (err) {
      // Cleanup temp file if rename fails
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch (e) { /* ignore */ }
      }
      throw err;
    }

    if (existingFile) {
      // Update database record for overwrite
      await pool.query(
        `UPDATE files SET stored_filename = ?, file_path = ?, file_size = ?, mime_type = ?, updated_at = NOW()
         WHERE id = ?`,
        [storedFilename, targetPath, fileSize, mimeType, existingFile.id]
      );
    } else {
      // Save to database for new file
      await FileModel.create({
        user_id: userId,
        folder_id: parentId,
        original_filename: fileName,
        stored_filename: storedFilename,
        file_path: targetPath,
        file_size: fileSize,
        mime_type: mimeType,
      });
    }

    // Proses thumbnail/remux dijalankan DI BACKGROUND (tidak di-await sebelum
    // respond) — TAPI diregistrasikan ke _fileProcessingLocks supaya PUT lain
    // untuk nama file yang sama menunggu proses ini selesai sebelum boleh
    // menghapus/menimpanya (lihat pengecekan `priorLock` di awal putFile/
    // _putFileChunk).
    //
    // SEBELUMNYA (dua iterasi lalu) ini di-await penuh sebelum respond, dengan
    // niat mencegah race "request retry menghapus file yang masih diproses
    // request sebelumnya". Itu TIDAK benar-benar menutup celahnya: baris
    // `UPDATE`/`INSERT` ke tabel `files` di atas terjadi SEBELUM await
    // tersebut, jadi request KEDUA yang jalan bersamaan (bukan setelahnya)
    // tetap bisa menemukan row ini lewat _findFileByParentAndName dan
    // menghapus file yang sedang dibaca ffmpeg oleh request pertama — persis
    // sumber "Invalid data found when processing input" yang masih muncul.
    //
    // Yang lebih parah, meng-await ffmpeg (bisa berpuluh detik untuk video
    // besar) sebelum kirim response PUT membuat client WebDAV (Finder, dkk)
    // dengan timeout sendiri di sisi client MENYERAH duluan sebelum response
    // sampai ("kode kesalahan 100060" / operasi tidak selesai) — lalu banyak
    // client otomatis RETRY PUT untuk nama yang sama, yang justru MEMICU
    // race di atas. Jadi versi "await sebelum respond" itu sendiri yang
    // menciptakan kondisi pemicunya.
    //
    // Solusi yang benar: respond SEGERA setelah file aman di disk (rename
    // atomic sudah selesai), dan pakai lock eksplisit (bukan latensi
    // response) untuk menyerialkan proses replace/hapus terhadap proses
    // background yang masih berjalan.
    const processingPromise = this._processFile(targetPath, mimeType, fileName)
      .finally(() => {
        // Hanya hapus entri lock kalau masih menunjuk ke promise INI —
        // supaya tidak salah hapus lock milik request yang lebih baru.
        if (_fileProcessingLocks.get(lockKey) === processingPromise) {
          _fileProcessingLocks.delete(lockKey);
        }
      });
    processingPromise.catch(() => {}); // cegah unhandled rejection; error aslinya sudah di-log di _processFile
    _fileProcessingLocks.set(lockKey, processingPromise);

    return { overwritten: !!existingFile };
  },

  /**
   * Tangani satu potongan PUT bertahap (Content-Range). Lihat komentar di
   * parseContentRange() untuk latar belakang lengkap soal kenapa ini perlu.
   *
   * Strategi:
   *  - File sementara memakai nama DETERMINISTIK (hash dari lockKey), BUKAN
   *    random seperti PUT biasa -- supaya potongan ke-2, ke-3, dst menulis ke
   *    file fisik yang SAMA dengan potongan pertama.
   *  - Tiap potongan ditulis pada OFFSET byte yang tepat (fs.write dengan
   *    posisi eksplisit), bukan di-append -- karena HTTP/WebDAV tidak
   *    menjamin potongan datang berurutan.
   *  - Thumbnail/remux/DB HANYA dijalankan setelah potongan TERAKHIR
   *    (end + 1 === total) diterima dan ukuran file di disk sudah cocok
   *    dengan total yang dijanjikan.
   */
  async _putFileChunk(req, userId, parentId, fileName, mimeType, range, lockKey) {
    const { start, end, total } = range;

    if (total === null) {
      // Tidak tahu ukuran total ("bytes */*") -> tidak bisa memastikan kapan
      // file benar-benar lengkap. Tolak eksplisit daripada diam-diam
      // memproses file yang mungkin masih parsial.
      for await (const _chunk of req) { /* drain supaya koneksi keep-alive tidak nyangkut */ }
      throw new AppError(
        `Content-Range tanpa total ukuran tidak didukung untuk "${fileName}"`,
        400,
        'BAD_REQUEST'
      );
    }

    const tempDir = path.join(process.env.UPLOADS_DIR, 'temp', `user_${userId}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Nama file sementara deterministik per (user, parent, fileName) --
    // dihash supaya tidak kepanjangan/karakter aneh kalau fileName unik.
    const rangeHash = crypto.createHash('md5').update(lockKey).digest('hex');
    const partialPath = path.join(tempDir, `webdav-range-${rangeHash}.tmp`);

    // Potongan pertama (start === 0): (re)inisialisasi file sementara dari
    // nol -- ini juga otomatis membersihkan sisa upload lama yang gagal
    // untuk nama file yang sama.
    // Potongan lanjutan (start > 0): file sementara WAJIB sudah ada dari
    // potongan sebelumnya. Kalau tidak ada (mis. proses server sempat
    // restart di tengah, atau potongan awal entah kenapa hilang), JANGAN
    // menulis ke offset acak (bisa menghasilkan file dengan lubang byte
    // kosong di awal) -- tolak dengan jelas supaya client mengulang upload
    // dari awal, bukan diam-diam menghasilkan file korup.
    if (start === 0) {
      fs.closeSync(fs.openSync(partialPath, 'w'));
    } else if (!fs.existsSync(partialPath)) {
      for await (const _chunk of req) { /* drain */ }
      throw new AppError(
        `Potongan awal file "${fileName}" tidak ditemukan di server (sesi upload sebelumnya terputus) -- ulangi upload dari awal`,
        410,
        'GONE'
      );
    }

    // Tulis potongan ini pada posisi byte yang benar.
    let bytesWritten = 0;
    const fd = fs.openSync(partialPath, 'r+');
    try {
      let position = start;
      for await (const chunk of req) {
        fs.writeSync(fd, chunk, 0, chunk.length, position);
        position += chunk.length;
        bytesWritten += chunk.length;
      }
    } catch (err) {
      // Beda dengan PUT utuh: kita TIDAK hapus partialPath di sini, karena
      // potongan lain yang sudah berhasil ditulis sebelumnya masih berguna
      // untuk percobaan ulang (client biasanya cuma resend potongan yang
      // gagal, bukan dari awal lagi). Cleanup rutin (STALE_TMP) yang akan
      // membersihkan kalau memang ditinggal permanen.
      throw err;
    } finally {
      fs.closeSync(fd);
    }

    // req.complete adalah properti bawaan Node (bukan event custom) yang
    // secara andal menandakan apakah SELURUH body request ini benar-benar
    // diterima utuh -- ini valid baik untuk request dengan Content-Length
    // maupun Transfer-Encoding: chunked, dan tidak bergantung pada urutan
    // event 'aborted'/'error' yang bisa saja belum sempat terpasang/terpicu
    // di titik yang tepat. Kalau false, koneksi terputus sebelum body ini
    // (potongan ini) selesai dikirim -- walau for-await di atas sempat
    // "selesai" tanpa melempar error.
    if (req.complete !== true) {
      throw new AppError(
        `Upload dibatalkan: koneksi client terputus di tengah potongan file "${fileName}"`,
        400,
        'BAD_REQUEST'
      );
    }

    const expectedBytes = end - start + 1;
    if (bytesWritten !== expectedBytes) {
      throw new AppError(
        `Potongan file "${fileName}" tidak lengkap: menerima ${bytesWritten} byte, seharusnya ${expectedBytes} byte`,
        400,
        'BAD_REQUEST'
      );
    }

    // Bukan potongan terakhir -> cukup akui penerimaannya. JANGAN proses
    // thumbnail/remux/DB dulu karena file secara keseluruhan belum lengkap.
    if (end + 1 < total) {
      return { overwritten: false, partial: true };
    }

    // Potongan TERAKHIR -- validasi ukuran file utuh di disk sudah sesuai
    // total yang dijanjikan SEBELUM lanjut ke overwrite/rename/DB/processing.
    const finalStat = fs.statSync(partialPath);
    if (finalStat.size !== total) {
      throw new AppError(
        `Assembly file "${fileName}" gagal: ukuran akhir ${finalStat.size} byte, seharusnya ${total} byte (kemungkinan ada potongan yang hilang/terlewat)`,
        400,
        'BAD_REQUEST'
      );
    }

    // Lanjutkan proses yang identik dengan PUT utuh: cek existing file,
    // generate stored filename baru, tentukan target dir, lalu finalisasi
    // lewat method yang sama (_finalizePutFile) supaya tidak ada
    // duplikasi/inkonsistensi logic overwrite+rename+DB.
    const existingFile = await this._findFileByParentAndName(userId, parentId, fileName);
    const safeMimeType = mimeType || detectMimeType(fileName);
    const storedFilename = generateStoredFilename(fileName);
    const targetDir = parentId === null
      ? path.join(getUserDir(userId), 'folder_root')
      : getFolderDir(userId, parentId);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const targetPath = path.join(targetDir, storedFilename);

    return await this._finalizePutFile({
      userId, parentId, fileName, mimeType: safeMimeType,
      tempPath: partialPath, targetDir, storedFilename, targetPath,
      fileSize: total, existingFile, lockKey,
    });
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
   * Post-processing: thumbnail generation and video remux.
   * Sengaja di-await oleh pemanggil (putFile) — lihat catatan di atas soal race condition.
   */
  async _processFile(filePath, mimeType, fileName) {
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

// Diekspor terpisah supaya bisa dipanggil manual (mis. dari admin endpoint,
// script maintenance, atau test) tanpa perlu menunggu interval jalan.
WebDAVService.cleanupStaleTempFiles = cleanupStaleTempFilesOnce;

module.exports = WebDAVService;