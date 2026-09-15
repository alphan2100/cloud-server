const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FolderModel = require('../models/folder.model');
const Aria2Client = require('./downloader/aria2Client');
const uploadService = require('./upload.service');
const { parseTorrentInfo, parseMagnetInfo, computeInfoHash, isDangerousFile, findDangerousFiles } = require('../utils/torrent-parser');
const { AppError } = require('../middlewares/error.middleware');

const ARIA2_RPC_URL = process.env.ARIA2_RPC_URL || 'http://localhost:6800/jsonrpc';
const ARIA2_RPC_SECRET = process.env.ARIA2_RPC_SECRET || '';
const aria2 = new Aria2Client({ url: ARIA2_RPC_URL, secret: ARIA2_RPC_SECRET });

/**
 * Wrapper untuk RPC "aria2.addTorrent". Aria2Client saat ini belum punya
 * method addTorrent bawaan (baru addUri) - dipanggil lewat _call generik
 * (method RPC yang sama dipakai findExistingDownloadByInfoHash untuk
 * tellActive/tellWaiting/tellStopped, jadi sudah terbukti berfungsi).
 * Signature RPC aria2.addTorrent: (torrent_base64, uris[], options).
 */
async function addTorrentRpc(torrentBase64, options) {
  return aria2._call('addTorrent', [torrentBase64, [], options]);
}

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
  ? path.resolve(process.env.DOWNLOAD_DIR)
  : path.resolve('./uploads/temp');

// Simple mime-type guesser (tanpa dependency tambahan)
const MIME_MAP = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  '.txt': 'text/plain', '.srt': 'text/plain', '.nfo': 'text/plain',
  '.iso': 'application/x-iso9660-image', '.epub': 'application/epub+zip',
};
function guessMimeType(filePath) {
  return MIME_MAP[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function sanitizeFolderName(name) {
  return String(name || '')
    .trim()
    .replace(/[<>:"\\|?*\x00-\x1F]/g, '_')
    .replace(/\.+$/g, '')
    .slice(0, 255);
}

function getRelativeTorrentPath(filePath, saveDir) {
  const resolvedFile = path.resolve(filePath);
  const resolvedSaveDir = path.resolve(saveDir);
  const relativePath = path.relative(resolvedSaveDir, resolvedFile);

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return path.basename(filePath);
  }

  return relativePath;
}

async function ensureCloudFolderPath(userId, parentFolderId, folderParts) {
  let currentParentId = parentFolderId;

  for (const part of folderParts) {
    const folderName = sanitizeFolderName(part);
    if (!folderName || folderName === '.' || folderName === '..') continue;

    const existing = await FolderModel.findByName(userId, currentParentId, folderName);
    if (existing) {
      currentParentId = existing.id;
      continue;
    }

    const folderId = await FolderModel.create(userId, currentParentId, folderName);
    const physicalDir = path.join(
      process.env.UPLOADS_DIR,
      `user_${userId}`,
      `folder_${folderId}`
    );
    await fs.promises.mkdir(physicalDir, { recursive: true });
    currentParentId = folderId;
  }

  return currentParentId;
}

/**
 * In-memory registry semua task torrent yang sedang berjalan/baru selesai.
 * Key = gid aria2 (bisa berubah untuk magnet setelah metadata selesai, lihat getStatus).
 * Ini SENGAJA tidak persist ke database — kalau server restart, task yang belum
 * selesai akan hilang dari sini (walau proses aria2-nya sendiri mungkin masih
 * jalan di background aria2c). Frontend akan menerima 404 dan menandai task error.
 */
const tasks = new Map();

function assertFolderOwnership(userId, folderId) {
  if (folderId === null || folderId === undefined) return Promise.resolve();
  return FolderModel.findById(folderId).then((folder) => {
    if (!folder) throw new AppError('Folder tujuan tidak ditemukan', 404, 'NOT_FOUND');
    if (folder.user_id !== userId) throw new AppError('Akses ditolak ke folder tujuan', 403, 'FORBIDDEN');
  });
}

function makeSaveDir(userId) {
  return path.join(DOWNLOAD_DIR, `user_${userId}`, `torrent_${crypto.randomUUID()}`);
}

async function cleanupDir(dir) {
  if (!dir) return;
  try {
    if (fs.existsSync(dir)) {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Gagal menghapus direktori torrent ${dir}: ${err.message}`);
  }
}

function snapshot(task) {
  return {
    gid: task.gid,
    name: task.name,
    status: task.status,
    totalBytes: task.totalLength || 0,
    downloadedBytes: task.completedLength || 0,
    speed: task.downloadSpeed || 0,
    errorMessage: task.errorMessage || null,
    uploadedFiles: task.uploadedFiles || [],
  };
}

function getOwnedTask(userId, gid) {
  // Coba lookup langsung
  let task = tasks.get(gid);
  // Jika tidak ditemukan, coba cari di tasks yang punya previousGid === gid
  // (kasus frontend masih pakai GID lama saat GID switch)
  if (!task) {
    for (const [, t] of tasks.entries()) {
      if (t.previousGid === gid && t.userId === userId) {
        task = t;
        break;
      }
    }
  }
  if (!task) {
    throw new AppError('Task tidak ditemukan (mungkin server baru saja restart)', 404, 'NOT_FOUND');
  }
  if (task.userId !== userId) {
    throw new AppError('Akses ditolak', 403, 'FORBIDDEN');
  }
  return task;
}

/**
 * Ekstrak daftar file dari struktur `bittorrent.info` yang dikembalikan aria2
 * lewat tellStatus (sudah berupa JSON biasa, bukan bencode mentah seperti di
 * torrent-parser.js). Dipakai untuk memeriksa file berbahaya begitu metadata
 * magnet selesai diambil, SEBELUM konten sebenarnya mulai didownload.
 */
function filesFromBtInfo(btInfo, fallbackName) {
  if (!btInfo) return [];
  if (Array.isArray(btInfo.files)) {
    return btInfo.files.map((f) => ({
      path: Array.isArray(f.path) ? f.path.join('/') : String(f.path || ''),
      length: typeof f.length === 'number' ? f.length : parseInt(f.length || '0', 10) || 0,
    }));
  }
  if (btInfo.name || fallbackName) {
    return [{ path: btInfo.name || fallbackName, length: 0 }];
  }
  return [];
}

function isMagnetMetadataStatus(task, result) {
  if (!task.isMagnet || task.previousGid) return false;

  const files = Array.isArray(result.files) ? result.files : [];
  return files.some((file) => String(file.path || '').includes('[METADATA]'));
}

/**
 * Cari GID download yang sedang aktif/berjalan di aria2 berdasarkan infoHash.
 * Dipakai saat aria2 menolak dengan "already registered".
 */
async function findExistingDownloadByInfoHash(infoHash) {
  try {
    const active = await aria2._call('tellActive', []);
    for (const d of active) {
      if (d.infoHash === infoHash) return d.gid;
    }
    const waiting = await aria2._call('tellWaiting', [0, 1000]);
    for (const d of waiting) {
      if (d.infoHash === infoHash) return d.gid;
    }
    // offset negatif = ambil dari BELAKANG antrian (entri PALING BARU).
    // Antrian stopped-result aria2 bersifat FIFO (entri lama dibuang dari
    // depan saat penuh, entri baru didorong ke belakang) - kalau pakai
    // offset 0 kita cuma dapat entri TERLAMA, sehingga duplikat yang baru
    // saja gagal (justru yang paling relevan di sini) bisa tidak ketemu
    // kalau jumlah stopped result sudah > num. num 1000 disesuaikan dengan
    // default aria2 --max-download-result=1000.
    const stopped = await aria2._call('tellStopped', [-1000, 1000]);
    for (const d of stopped) {
      if (d.infoHash === infoHash) return d.gid;
    }
  } catch (e) { /* abaikan */ }
  return null;
}

// ============================================================
// PREVIEW - baca info sebelum download dimulai (tidak menyentuh aria2)
// ============================================================

function previewFromTorrentBuffer(buffer) {
  const info = parseTorrentInfo(buffer);
  const dangerous = findDangerousFiles(info.files);
  if (dangerous.length > 0) {
    throw new AppError(
      `Torrent ditolak: berisi file berpotensi berbahaya (${dangerous.map((f) => f.path).join(', ')}). ` +
        `File .exe/.scr/.bat/.js/dll dsb. tidak diizinkan.`,
      400,
      'DANGEROUS_FILE'
    );
  }
  return {
    source: 'file',
    name: info.name,
    totalLength: info.totalLength,
    files: info.files,
    filesKnown: true,
  };
}

function previewFromMagnet(magnetUri) {
  if (!magnetUri || !magnetUri.trim().toLowerCase().startsWith('magnet:')) {
    throw new AppError('Magnet URI tidak valid', 400, 'VALIDATION_ERROR');
  }
  const info = parseMagnetInfo(magnetUri.trim());
  return {
    source: 'magnet',
    name: info.name,
    totalLength: info.totalLength,
    files: [],
    filesKnown: false,
    infoHash: info.infoHash,
    // Heuristik saja (dari parameter "dn", bisa dipalsukan/tidak ada) - daftar
    // file sebenarnya baru diketahui setelah metadata diambil saat download
    // dimulai, itu yang benar-benar diblokir di getStatus().
    dangerousHint: info.name ? isDangerousFile(info.name) : false,
  };
}

// ============================================================
// START DOWNLOAD
// ============================================================

async function startFromMagnet(userId, folderId, magnetUri, displayName) {
  if (!magnetUri || !magnetUri.trim().toLowerCase().startsWith('magnet:')) {
    throw new AppError('Magnet URI tidak valid', 400, 'VALIDATION_ERROR');
  }
  await assertFolderOwnership(userId, folderId);

  // Heuristik cepat dari parameter "dn" (bisa dipalsukan/kosong) - lapisan
  // pertahanan pertama saja. Pemeriksaan definitif berdasarkan daftar file
  // sebenarnya dilakukan di getStatus() begitu metadata torrent diketahui.
  const magnetInfo = parseMagnetInfo(magnetUri.trim());
  if (magnetInfo.name && isDangerousFile(magnetInfo.name)) {
    throw new AppError(
      `Magnet ditolak: nama file menunjukkan tipe berpotensi berbahaya (${magnetInfo.name}).`,
      400,
      'DANGEROUS_FILE'
    );
  }

  const saveDir = makeSaveDir(userId);
  await fs.promises.mkdir(saveDir, { recursive: true });

  let gid;
  try {
    gid = await aria2.addUri([magnetUri.trim()], {
      dir: saveDir,
      seedTime: 0, // Stop seeding segera setelah download selesai
    });
  } catch (err) {
    // Jika aria2 bilang "already registered", cari download yang sudah ada
    // dengan infoHash yang sama, remove dulu, lalu retry.
    if (err.message && err.message.toLowerCase().includes('already registered')) {
      try {
        const info = parseMagnetInfo(magnetUri.trim());
        const existingGid = await findExistingDownloadByInfoHash(info.infoHash);
        if (existingGid) {
          console.log(`[torrent] Menghapus download duplikat ${existingGid} untuk infoHash ${info.infoHash}`);
          await aria2.forceRemove(existingGid);
          await aria2.removeDownloadResult(existingGid);
        }
      } catch (e2) { /* abaikan error saat cleanup */ }
      // Retry sekali lagi
      try {
        gid = await aria2.addUri([magnetUri.trim()], {
          dir: saveDir,
          seedTime: 0,
        });
      } catch (err2) {
        await cleanupDir(saveDir);
        throw new AppError(`Gagal memulai download: ${err2.message}`, 502, 'ARIA2_ERROR');
      }
    } else {
      await cleanupDir(saveDir);
      throw new AppError(`Gagal memulai download: ${err.message}`, 502, 'ARIA2_ERROR');
    }
  }

  const task = {
    gid,
    userId,
    folderId,
    saveDir,
    name: displayName || null,
    status: 'downloading',
    totalLength: 0,
    completedLength: 0,
    downloadSpeed: 0,
    errorMessage: null,
    uploadedFiles: [],
    createdAt: Date.now(),
    isMagnet: true,
  };
  tasks.set(gid, task);
  return snapshot(task);
}

async function startFromTorrentBuffer(userId, folderId, buffer, originalName) {
  await assertFolderOwnership(userId, folderId);

  const info = parseTorrentInfo(buffer);
  const dangerous = findDangerousFiles(info.files);
  if (dangerous.length > 0) {
    throw new AppError(
      `Torrent ditolak: berisi file berpotensi berbahaya (${dangerous.map((f) => f.path).join(', ')}).`,
      400,
      'DANGEROUS_FILE'
    );
  }

  const saveDir = makeSaveDir(userId);
  await fs.promises.mkdir(saveDir, { recursive: true });

  let gid;
  try {
    gid = await addTorrentRpc(buffer.toString('base64'), {
      dir: saveDir,
      seedTime: 0, // Stop seeding segera setelah download selesai
    });
  } catch (err) {
    // Jika aria2 bilang "already registered", cari download yang sudah ada
    // dengan infoHash yang sama, remove dulu, lalu retry.
    if (err.message && err.message.toLowerCase().includes('already registered')) {
      try {
        const infoHash = computeInfoHash(buffer);
        const existingGid = await findExistingDownloadByInfoHash(infoHash);
        if (existingGid) {
          console.log(`[torrent] Menghapus download duplikat ${existingGid} untuk infoHash ${infoHash}`);
          await aria2.forceRemove(existingGid);
          await aria2.removeDownloadResult(existingGid);
        }
      } catch (e2) { /* abaikan error saat cleanup */ }
      // Retry sekali lagi
      try {
        gid = await addTorrentRpc(buffer.toString('base64'), {
          dir: saveDir,
          seedTime: 0,
        });
      } catch (err2) {
        await cleanupDir(saveDir);
        throw new AppError(`Gagal memulai download: ${err2.message}`, 502, 'ARIA2_ERROR');
      }
    } else {
      await cleanupDir(saveDir);
      throw new AppError(`Gagal memulai download: ${err.message}`, 502, 'ARIA2_ERROR');
    }
  }

  const task = {
    gid,
    userId,
    folderId,
    saveDir,
    name: info.name && info.name !== 'unknown' ? info.name : (originalName ? originalName.replace(/\.torrent$/i, '') : null),
    status: 'downloading',
    totalLength: 0,
    completedLength: 0,
    downloadSpeed: 0,
    errorMessage: null,
    uploadedFiles: [],
    createdAt: Date.now(),
    isMagnet: false,
  };
  tasks.set(gid, task);
  return snapshot(task);
}

// ============================================================
// STATUS / POLLING (dipanggil berkala oleh frontend)
// ============================================================

async function getStatus(userId, gid) {
  const task = getOwnedTask(userId, gid);

  // Status final atau sedang diproses -> tidak perlu tanya aria2 lagi
  if (['done', 'error', 'cancelled', 'processing'].includes(task.status)) {
    return snapshot(task);
  }

  // Jika request untuk GID lama (magnet metadata GID yang sudah di-switch
  // ke GID konten setelah metadata selesai), jangan query aria2 lagi.
  // Query ke GID lama bisa memicu processCompletion() prematur karena
  // aria2 sudah tidak memiliki followedBy untuk GID tersebut.
  if (task.gid !== gid) {
    return snapshot(task);
  }

  let result;
  try {
    result = await aria2.tellStatus(task.gid, [
      'status', 'totalLength', 'completedLength', 'downloadSpeed', 'uploadSpeed',
      'errorMessage', 'files', 'bittorrent', 'followedBy',
    ]);
  } catch (err) {
    task.status = 'error';
    task.errorMessage = `Gagal mengambil status dari aria2: ${err.message}`;
    return snapshot(task);
  }

  // Untuk magnet: begitu metadata torrent selesai diunduh, aria2 otomatis
  // membuat gid BARU untuk konten sebenarnya (followedBy). Pindahkan task
  // kita ke gid baru itu supaya polling berikutnya melacak yang benar.
  // Simpan previousGid agar cancel/remove dengan GID lama tetap bisa di-handle.
  if (result.status === 'complete' && result.followedBy && result.followedBy.length > 0) {
    const newGid = result.followedBy[0];
    const oldGid = task.gid;

    // Metadata torrent baru selesai diambil - ini titik pertama kita benar-benar
    // tahu daftar file di dalamnya. Cek file berbahaya SEBELUM lanjut mendownload
    // kontennya (yang sudah otomatis dimulai aria2 di gid baru).
    const btInfo = result.bittorrent && result.bittorrent.info;
    const files = filesFromBtInfo(btInfo, task.name);
    const dangerous = findDangerousFiles(files);
    if (dangerous.length > 0) {
      try { await aria2.forceRemove(newGid); } catch (e) { /* mungkin sudah selesai/tidak aktif */ }
      try { await aria2.removeDownloadResult(newGid); } catch (e) { /* abaikan */ }
      try { await aria2.forceRemove(oldGid); } catch (e) { /* abaikan */ }
      try { await aria2.removeDownloadResult(oldGid); } catch (e) { /* abaikan */ }
      await cleanupDir(task.saveDir);
      task.status = 'error';
      task.errorMessage = `Torrent diblokir: berisi file berpotensi berbahaya (${dangerous.map((f) => f.path).join(', ')}).`;
      return snapshot(task);
    }

    task.previousGid = oldGid;
    task.gid = newGid;
    // JANGAN delete oldGid dari Map — biarkan sebagai alias supaya
    // request yang masih pakai GID lama (misal cancel) tetap bisa di-lookup.
    tasks.set(newGid, task);
    return getStatus(userId, newGid);
  }

  if (!task.name && result.bittorrent && result.bittorrent.info && result.bittorrent.info.name) {
    task.name = result.bittorrent.info.name;
  }

  task.totalLength = parseInt(result.totalLength || '0', 10);
  task.completedLength = parseInt(result.completedLength || '0', 10);
  task.downloadSpeed = parseInt(result.downloadSpeed || '0', 10);

  // Magnet punya fase metadata kecil ([MEMORY][METADATA]...) sebelum aria2
  // membuat GID baru untuk konten sebenarnya. Jangan proses upload saat yang
  // selesai baru metadata; tunggu followedBy lalu switch ke GID konten.
  if (isMagnetMetadataStatus(task, result)) {
    task.status = 'downloading';
    return snapshot(task);
  }

  if (result.status === 'active' || result.status === 'waiting') {
    // Fallback: jika aria2 masih report 'active' (misal seeding) tapi
    // semua data sudah terdownload, trigger processCompletion langsung.
    const total = task.totalLength;
    const completed = task.completedLength;
    if (total > 0 && completed >= total) {
      console.log(`[torrent] Download selesai (${completed}/${total} bytes), trigger processCompletion untuk ${task.gid}`);
      task.status = 'processing';
      processCompletion(task, result).catch((err) => {
        console.error(`Gagal memproses torrent selesai (${task.gid}): ${err.message}`);
        task.status = 'error';
        task.errorMessage = err.message;
      });
    } else {
      task.status = 'downloading';
    }
  } else if (result.status === 'paused') {
    task.status = 'paused';
  } else if (result.status === 'error') {
    task.status = 'error';
    task.errorMessage = result.errorMessage || 'Download gagal';
    // Deregister dari aria2 SEKARANG juga, jangan tunggu user klik hapus -
    // supaya infoHash-nya langsung bebas dipakai lagi kalau user retry.
    // Aman dilakukan di sini karena getStatus() sudah early-return untuk
    // status 'error' (tidak akan tanya ke aria2 lagi setelah ini), jadi
    // GID ini memang sudah tidak dibutuhkan lagi di sisi aria2.
    try { await aria2.forceRemove(task.gid); } catch (e) { /* mungkin sudah tidak aktif di aria2 */ }
    try { await aria2.removeDownloadResult(task.gid); } catch (e) { /* abaikan */ }
  } else if (result.status === 'removed') {
    task.status = 'cancelled';
  } else if (result.status === 'complete') {
    // Tandai 'processing' SEKARANG (sinkron, sebelum await apa pun) supaya
    // request polling yang datang bersamaan tidak memicu proses upload dua kali.
    task.status = 'processing';
    processCompletion(task, result).catch((err) => {
      console.error(`Gagal memproses torrent selesai (${task.gid}): ${err.message}`);
      task.status = 'error';
      task.errorMessage = err.message;
    });
  }

  return snapshot(task);
}

// ============================================================
// PROCESSING SETELAH DOWNLOAD SELESAI
// Upload tiap file ke sistem file yang sudah ada (otomatis kena remux
// video & generate thumbnail lewat uploadService), lalu hapus folder
// temp torrent (file asli + metadata .torrent).
// ============================================================

async function processCompletion(task, ariaResult) {
  const files = Array.isArray(ariaResult.files) ? ariaResult.files : [];
  const uploaded = [];
  const failures = [];

  for (const f of files) {
    if (f.selected === 'false') continue;
    const filePath = f.path;
    if (!filePath || !fs.existsSync(filePath)) continue;

    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) continue;

    const relativePath = getRelativeTorrentPath(filePath, task.saveDir);
    const relativeParts = relativePath.split(path.sep).filter(Boolean);
    const originalName = relativeParts.pop() || path.basename(filePath);
    const targetFolderId = await ensureCloudFolderPath(task.userId, task.folderId, relativeParts);

    // Safety-net terakhir sebelum upload ke storage user - jangan pernah
    // loloskan file berekstensi berbahaya walau entah bagaimana sampai di sini
    // (mis. race condition, atau torrent multi-file dengan file berbahaya yang
    // tidak ikut dicek di jalur followedBy karena bukan single-file torrent).
    if (isDangerousFile(originalName)) {
      failures.push({ file: originalName, error: 'Ditolak: tipe file berpotensi berbahaya' });
      continue;
    }

    let finalName = originalName;
    let attempt = 0;

    // Retry dengan suffix kalau nama sudah ada di folder tujuan user
    // (mengikuti pola yang sama seperti FileController.copy)
    while (attempt < 5) {
      const ext = path.extname(finalName);
      const storedName = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      try {
        const result = await uploadService.processFile({
          userId: task.userId,
          folderId: targetFolderId,
          filePath,
          originalName: finalName,
          storedName,
          fileSize: stat.size,
          mimeType: guessMimeType(filePath),
          isTemp: true,
        });
        uploaded.push(result.file);
        break;
      } catch (err) {
        if (err.code === 'CONFLICT') {
          attempt++;
          const ext2 = path.extname(originalName);
          const base = path.basename(originalName, ext2);
          finalName = `${base} (${attempt})${ext2}`;
          continue;
        }
        failures.push({ file: originalName, error: err.message });
        break;
      }
    }
  }

  // Bersihkan folder temp torrent (file yang sudah dipindah + sisa metadata .torrent)
  await cleanupDir(task.saveDir);

  try {
    await aria2.forceRemove(task.gid);
  } catch (e) { /* mungkin sudah tidak aktif */ }
  try {
    await aria2.removeDownloadResult(task.gid);
  } catch (e) { /* abaikan */ }

  try {
    const CacheMiddleware = require('../middlewares/cache.middleware');
    CacheMiddleware.invalidateUser(task.userId);
  } catch (e) { /* opsional */ }

  task.uploadedFiles = uploaded;
  if (uploaded.length === 0 && failures.length > 0) {
    task.status = 'error';
    task.errorMessage = `Gagal mengupload semua file: ${failures.map((f) => f.error).join('; ')}`;
  } else {
    task.status = 'done';
    if (failures.length > 0) {
      task.errorMessage = `Sebagian file gagal diupload: ${failures.map((f) => f.file).join(', ')}`;
    }
  }
}

// ============================================================
// CONTROL: pause / resume / cancel / cleanup gagal / remove dari daftar
// ============================================================

async function pauseTask(userId, gid) {
  const task = getOwnedTask(userId, gid);
  if (task.status !== 'downloading') {
    throw new AppError('Task tidak bisa dipause pada status ini', 400, 'INVALID_STATE');
  }
  try {
    await aria2.pause(task.gid);
  } catch (err) {
    throw new AppError(`Gagal pause: ${err.message}`, 502, 'ARIA2_ERROR');
  }
  task.status = 'paused';
  return snapshot(task);
}

async function resumeTask(userId, gid) {
  const task = getOwnedTask(userId, gid);
  if (task.status !== 'paused') {
    throw new AppError('Task tidak bisa diresume pada status ini', 400, 'INVALID_STATE');
  }
  try {
    await aria2.unpause(task.gid);
  } catch (err) {
    throw new AppError(`Gagal resume: ${err.message}`, 502, 'ARIA2_ERROR');
  }
  task.status = 'downloading';
  return snapshot(task);
}

/**
 * Satu handler untuk semua kasus "buang task":
 * - Aktif/paused -> cancel: paksa hentikan aria2 + hapus semua file temp.
 * - Error (gagal, tidak bisa resume) -> cleanup: hapus temp yang mungkin
 *   masih tersisa, lalu buang dari daftar.
 * - Done/cancelled -> tidak ada file tersisa (sudah dibersihkan), tinggal
 *   dibuang dari daftar.
 */
async function removeTask(userId, gid) {
  const task = getOwnedTask(userId, gid);

  // Selalu bersihkan dari aria2 apapun statusnya, supaya tidak ada
  // download result yang tertinggal dan menyebabkan "already registered"
  // saat user mencoba download torrent yang sama.
  try {
    await aria2.forceRemove(task.gid);
  } catch (e) { /* mungkin sudah tidak aktif di aria2 */ }
  try {
    await aria2.removeDownloadResult(task.gid);
  } catch (e) { /* abaikan */ }

  // Cek juga apakah task ini hasil GID switch (magnet metadata -> konten).
  // Jika ada, bersihkan juga GID lamanya dari aria2.
  if (task.previousGid) {
    try {
      await aria2.removeDownloadResult(task.previousGid);
    } catch (e) { /* abaikan */ }
  }

  await cleanupDir(task.saveDir);

  // Hapus dari Map: GID sekarang + GID lama supaya lookup tidak tembus
  if (task.previousGid) tasks.delete(task.previousGid);
  tasks.delete(task.gid);
  return { removed: true };
}

// Sapu bersih task lama berstatus final yang tidak pernah di-remove oleh
// frontend (misal tab ditutup begitu saja), supaya Map tidak bocor memori.
const STALE_MS = 2 * 60 * 60 * 1000; // 2 jam
setInterval(() => {
  const now = Date.now();
  for (const [gid, task] of tasks.entries()) {
    if (['done', 'error', 'cancelled'].includes(task.status) && now - task.createdAt > STALE_MS) {
      tasks.delete(gid);
    }
  }
}, 15 * 60 * 1000).unref();

module.exports = {
  previewFromTorrentBuffer,
  previewFromMagnet,
  startFromMagnet,
  startFromTorrentBuffer,
  getStatus,
  pauseTask,
  resumeTask,
  removeTask,
};
