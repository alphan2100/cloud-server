const path = require('path');
const crypto = require('crypto');
const { decode, encode } = require('./bencode');

/**
 * Ekstensi file yang berpotensi berbahaya (executable/script) - torrent yang
 * mengklaim berisi film/musik/dsb tapi isinya file jenis ini adalah pola
 * umum trojan/dropper yang menyamar sebagai rilis bajakan.
 */
const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.scr', '.com', '.pif', '.bat', '.cmd', '.msi', '.msp',
  '.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.ps1', '.psm1',
  '.hta', '.lnk', '.reg', '.cpl', '.gadget', '.jar', '.apk',
]);

/** @param {string} filePath */
function isDangerousFile(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return DANGEROUS_EXTENSIONS.has(ext);
}

/**
 * @param {{path: string, length: number}[]} files
 * @returns {{path: string, length: number}[]} subset file yang berpotensi berbahaya
 */
function findDangerousFiles(files) {
  return (files || []).filter((f) => isDangerousFile(f.path));
}

/**
 * Parse buffer file .torrent -> info dasar untuk ditampilkan ke user
 * SEBELUM download dimulai (nama, ukuran total, daftar file).
 *
 * @param {Buffer} buffer - isi file .torrent
 * @returns {{ name: string, totalLength: number, files: {path: string, length: number}[] }}
 */
function parseTorrentInfo(buffer) {
  let root;
  try {
    root = decode(buffer);
  } catch (err) {
    throw new Error(`File .torrent tidak valid: ${err.message}`);
  }

  const info = root && root.info;
  if (!info) {
    throw new Error('File .torrent tidak valid (info dict tidak ditemukan)');
  }

  const name = info.name ? info.name.toString('utf8') : 'unknown';
  let totalLength = 0;
  let files = [];

  if (Array.isArray(info.files)) {
    // Multi-file torrent
    files = info.files.map((f) => {
      const pathParts = (f.path || []).map((p) => p.toString('utf8'));
      const length = typeof f.length === 'number' ? f.length : 0;
      totalLength += length;
      return { path: pathParts.join('/'), length };
    });
  } else if (typeof info.length === 'number') {
    // Single-file torrent
    totalLength = info.length;
    files = [{ path: name, length: info.length }];
  }

  return { name, totalLength, files };
}

/**
 * Parse magnet URI -> info seadanya (nama & ukuran hanya tersedia jika
 * disertakan di parameter magnet-nya sendiri; kalau tidak, baru akan
 * diketahui setelah metadata torrent diambil dari DHT/tracker saat
 * download dimulai).
 *
 * @param {string} magnetUri
 * @returns {{ name: string|null, totalLength: number|null, infoHash: string|null }}
 */
function parseMagnetInfo(magnetUri) {
  const qIndex = magnetUri.indexOf('?');
  const query = qIndex >= 0 ? magnetUri.slice(qIndex + 1) : '';
  const params = new URLSearchParams(query);

  const dn = params.get('dn'); // display name (sudah otomatis di-decode)
  const xl = params.get('xl'); // exact length (bytes), opsional
  const xt = params.get('xt'); // urn:btih:<hash>

  let infoHash = null;
  if (xt) {
    const m = xt.match(/btih:([a-zA-Z0-9]+)/i);
    if (m) infoHash = m[1].toLowerCase();
  }

  return {
    name: dn || null,
    totalLength: xl ? parseInt(xl, 10) : null,
    infoHash,
  };
}

/**
 * Hitung infoHash (SHA1 hex, 40 karakter) dari buffer file .torrent.
 * Ini nilai yang sama dipakai aria2/klien BitTorrent lain untuk identifikasi
 * torrent secara unik - dibutuhkan supaya findExistingDownloadByInfoHash bisa
 * mencocokkan download file .torrent yang sama walau di-upload ulang.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function computeInfoHash(buffer) {
  const root = decode(buffer);
  const info = root && root.info;
  if (!info) {
    throw new Error('File .torrent tidak valid (info dict tidak ditemukan)');
  }
  return crypto.createHash('sha1').update(encode(info)).digest('hex');
}

module.exports = {
  parseTorrentInfo,
  parseMagnetInfo,
  computeInfoHash,
  DANGEROUS_EXTENSIONS,
  isDangerousFile,
  findDangerousFiles,
};