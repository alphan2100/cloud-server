/**
 * Smart Filename Parser untuk ekstraksi metadata audio dari nama file.
 *
 * Mendukung banyak pola filename:
 *  - "Artist - Title.ext"
 *  - "Artist – Title.ext" (en-dash)
 *  - "Artist — Title.ext" (em-dash)
 *  - "01 - Artist - Title.ext" (track number)
 *  - "Artist_Title.ext" (underscore)
 *  - "Artist_-_Title.ext" (underscore + dash)
 *  - "Artist『Title』.ext" (Jepang)
 *  - "Artist「Title」.ext" (Jepang)
 *  - "Title - Artist.ext" (format terbalik)
 *  - "Artist - Title (feat. X).ext"
 *  - "Artist - Title [Official Video].ext"
 *  - dll.
 *
 * Algoritma:
 *  1. Hapus ekstensi
 *  2. Normalisasi separator (underscore → space, en-dash/em-dash → dash)
 *  3. Deteksi & ekstrak track number
 *  4. Deteksi separator utama
 *  5. Split artist & title
 *  6. Deteksi format terbalik (Title - Artist)
 *  7. Ekstrak feat./ft. artists
 *  8. Ekstrak year
 *  9. Bersihkan noise YouTube/download
 * 10. Trim & normalize whitespace
 */

const path = require('path');

/**
 * Daftar keyword noise yang harus dibersihkan dari title.
 * Dikelompokkan untuk kemudahan maintenance.
 */
const NOISE_KEYWORDS = [
  // YouTube umum
  'official music video',
  'official lyric video',
  'official visualizer',
  'official video',
  'official audio',
  'official mv',
  'official live',
  'official hd',
  'official 4k',
  'official',
  'lyric video',
  'lyrics video',
  'lyrics',
  'lyric',
  'music video',
  'mv',
  'm/v',
  'audio',
  'video',
  'hd',
  'hq',
  '4k',
  '1080p',
  '720p',
  '480p',
  '360p',
  'visualizer',
  'live session',
  'live',
  'acoustic',
  'remix',
  'radio edit',
  'extended mix',
  'instrumental',
  'karaoke',
  'cover',
  'demo',
  'studio version',
  'studio',
  // Download / converter
  'y2mate.com',
  'y2mate',
  'mp3juices',
  'savetube',
  'savefrom',
  'convert',
  'download',
  'free download',
  'download.com',
  // Bitrate
  '320kbps',
  '256kbps',
  '192kbps',
  '128kbps',
  '320 kbps',
  '256 kbps',
  '192 kbps',
  '128 kbps',
  '320',
  '256',
  '192',
  '128',
];

/**
 * Regex untuk ekstraksi feat./ft./featuring
 */
const FEAT_REGEXES = [
  /\(?\s*feat\.?\s+(.+?)\s*\)?$/i,
  /\(?\s*ft\.?\s+(.+?)\s*\)?$/i,
  /\(?\s*featuring\s+(.+?)\s*\)?$/i,
  /\(?\s*f\.?\s+(.+?)\s*\)?$/i,
];

/**
 * Regex untuk ekstraksi year (4 digit dalam kurung)
 */
const YEAR_REGEX = /\((\d{4})\)/;

/**
 * Regex untuk track number di awal filename
 * Cocok dengan: "01 - ", "01.", "01_", "1 - ", "12. "
 */
const TRACK_NUMBER_REGEX = /^(\d{1,3})\s*[-_.]\s+/;

/**
 * Karakter separator yang didukung (selain dash biasa)
 */
const JP_BRACKETS = [
  { open: '『', close: '』' },
  { open: '「', close: '」' },
  { open: '【', close: '】' },
];

/**
 * Bersihkan noise keywords dari string.
 * @param {string} str
 * @returns {string}
 */
function cleanNoise(str) {
  let result = str;

  // Hapus keyword dalam kurung siku: [Official Video], [y2mate], dll.
  result = result.replace(/\[[^\]]*\]/g, ' ');

  // Hapus keyword dalam kurung biasa: (Official Video), (Lyrics), dll.
  // Tapi pertahankan (feat. X) dan (year) - sudah diekstrak sebelumnya
  result = result.replace(/\((?:official|lyric|lyrics|audio|video|hd|hq|mv|download|free download)[^)]*\)/gi, ' ');

  // Hapus keyword yang berdiri sendiri atau dipisah separator
  for (const keyword of NOISE_KEYWORDS) {
    // Escape regex special chars
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Hapus keyword (case insensitive, dengan boundary)
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(regex, ' ');
  }

  // Hapus pola kombinasi: "Official HD 320kbps", dll.
  result = result.replace(/official\s+(hd|4k|1080p|720p|480p|mv|video|audio|lyric|lyrics|music|visualizer|live)/gi, ' ');
  result = result.replace(/(hd|4k|1080p|720p|480p)\s+(official|mv|video|audio)/gi, ' ');

  // Hapus sisa-sisa pola: "320kbps Official", "Official 320kbps"
  result = result.replace(/\d+\s*kbps/gi, ' ');

  // Normalize whitespace
  result = result.replace(/\s+/g, ' ').trim();

  // Hapus trailing punctuation
  result = result.replace(/[\s\-|_.,]+$/, '').trim();
  result = result.replace(/^[\s\-|_.,]+/, '').trim();

  return result;
}

/**
 * Ekstrak feat. artist dari string.
 * @param {string} str
 * @returns {{ cleaned: string, feat: string|null }}
 */
function extractFeat(str) {
  for (const regex of FEAT_REGEXES) {
    const match = str.match(regex);
    if (match) {
      const feat = match[1].trim().replace(/[)\]]$/, '').trim();
      const cleaned = str.replace(regex, ' ').trim();
      return { cleaned, feat };
    }
  }
  return { cleaned: str, feat: null };
}

/**
 * Ekstrak year dari string (dalam kurung).
 * @param {string} str
 * @returns {{ cleaned: string, year: number|null }}
 */
function extractYear(str) {
  const match = str.match(YEAR_REGEX);
  if (match) {
    const year = parseInt(match[1]);
    if (year >= 1900 && year <= 2100) {
      const cleaned = str.replace(YEAR_REGEX, ' ').trim();
      return { cleaned, year };
    }
  }
  return { cleaned: str, year: null };
}

/**
 * Ekstrak track number dari awal filename.
 * @param {string} str
 * @returns {{ cleaned: string, trackNumber: number|null }}
 */
function extractTrackNumber(str) {
  const match = str.match(TRACK_NUMBER_REGEX);
  if (match) {
    const trackNumber = parseInt(match[1]);
    if (trackNumber >= 1 && trackNumber <= 999) {
      const cleaned = str.replace(TRACK_NUMBER_REGEX, '');
      return { cleaned, trackNumber };
    }
  }
  return { cleaned: str, trackNumber: null };
}

/**
 * Deteksi apakah format kemungkinan "Title - Artist" (terbalik).
 * Heuristik KONSERVATIF: default format adalah "Artist - Title"
 * Hanya swap jika sangat yakin bahwa formatnya terbalik.
 *
 * @param {string} artist - bagian sebelum dash
 * @param {string} title - bagian setelah dash
 * @returns {boolean} - true jika kemungkinan terbalik
 */
function isLikelyReversed(artist, title) {
  const artistLower = artist.toLowerCase().trim();
  const titleLower = title.toLowerCase().trim();
  const titleWords = title.split(/\s+/).length;

  // Daftar kata yang umum di title (bukan nama artist)
  const titleKeywords = ['love', 'heart', 'night', 'dream', 'fire', 'light', 'dark', 'alone', 'forever', 'never', 'again', 'away', 'home', 'time', 'life', 'world', 'star', 'moon', 'sun', 'rain', 'storm', 'ocean', 'sky', 'fly', 'fall', 'run', 'stay', 'feel', 'need', 'want', 'cry', 'smile', 'dance', 'sing'];

  // Daftar kata yang mengindikasikan nama artist/band
  const artistKeywords = ['band', 'orchestra', 'choir', 'group', 'brothers', 'sisters', 'the', 'boys', 'girls'];

  // Cek apakah "artist" mengandung kata-kata title
  const artistHasTitleWords = titleKeywords.some((kw) => artistLower.includes(kw));
  // Cek apakah "title" mengandung kata-kata artist
  const titleHasArtistWords = artistKeywords.some((kw) => titleLower.includes(kw));
  // Cek apakah "title" terlihat seperti nama orang (2 kata, kapital di awal)
  const titleLooksLikeName = titleWords === 2 && /^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(title.trim());

  // Hanya swap jika:
  // 1. "artist" mengandung kata-kata title DAN "title" terlihat seperti nama artist
  // 2. ATAU "title" mengandung kata-kata artist (band, orchestra, dll.)
  if (artistHasTitleWords && titleLooksLikeName) {
    return true;
  }
  if (titleHasArtistWords && !artistHasTitleWords) {
    return true;
  }

  return false;
}

/**
 * Deteksi separator utama dalam string.
 * @param {string} str
 * @returns {{ separator: string, index: number } | null}
 */
function detectSeparator(str) {
  // Cek kurung Jepang dulu: Artist『Title』
  for (const bracket of JP_BRACKETS) {
    const idx = str.indexOf(bracket.open);
    if (idx > 0) {
      const closeIdx = str.indexOf(bracket.close, idx + 1);
      if (closeIdx > idx) {
        return { separator: bracket.open, index: idx, jp: true, close: bracket.close };
      }
    }
  }

  // Cek dash dengan spasi: " - "
  const dashPatterns = [' - ', ' – ', ' — '];
  for (const dash of dashPatterns) {
    const idx = str.indexOf(dash);
    if (idx > 0) {
      return { separator: dash, index: idx };
    }
  }

  // Cek dash tanpa spasi: "-" (tapi pastikan bukan hyphen dalam kata)
  const dashIdx = str.search(/(?<!\w)-(?!\w)/);
  if (dashIdx > 0) {
    return { separator: '-', index: dashIdx };
  }

  return null;
}

/**
 * Smart parse filename untuk ekstrak artist, title, feat, track number, year.
 *
 * @param {string} originalFilename - nama file asli (e.g., "Clean_Bandit_-_Solo_320kbps.mp3")
 * @returns {{ artist: string|null, title: string, feat: string|null, trackNumber: number|null, year: number|null }}
 */
function smartParseFilename(originalFilename) {
  if (!originalFilename) {
    return { artist: null, title: 'Unknown', feat: null, trackNumber: null, year: null };
  }

  // 1. Hapus ekstensi
  const basename = path.basename(originalFilename, path.extname(originalFilename));

  // 2. Normalisasi underscore:
  //    - "_-_" → " - " (separator dengan underscore)
  //    - "_" di antara kata → " " (space)
  let normalized = basename;

  // Pertahankan "_-_" sebagai " - " (separator)
  normalized = normalized.replace(/_-_/g, ' - ');
  normalized = normalized.replace(/_–_/g, ' – ');
  normalized = normalized.replace(/_—_/g, ' — ');

  // Ganti underscore dengan space
  normalized = normalized.replace(/_/g, ' ');

  // Normalisasi en-dash dan em-dash ke dash biasa
  normalized = normalized.replace(/[–—]/g, '-');

  // 3. Ekstrak track number
  let trackNumber = null;
  ({ cleaned: normalized, trackNumber } = extractTrackNumber(normalized));

  // 4. Ekstrak year
  let year = null;
  ({ cleaned: normalized, year } = extractYear(normalized));

  // 5. Ekstrak feat. artist
  let feat = null;
  ({ cleaned: normalized, feat } = extractFeat(normalized));

  // 6. Deteksi separator & split
  const sep = detectSeparator(normalized);

  let artist = null;
  let title = normalized;

  if (sep) {
    if (sep.jp) {
      // Format Jepang: Artist『Title』
      artist = normalized.substring(0, sep.index).trim();
      const titleStart = sep.index + 1;
      const titleEnd = normalized.indexOf(sep.close, titleStart);
      title = normalized.substring(titleStart, titleEnd > 0 ? titleEnd : normalized.length).trim();
    } else {
      // Format dash: "Artist - Title"
      artist = normalized.substring(0, sep.index).trim();
      title = normalized.substring(sep.index + sep.separator.length).trim();
    }

    // 7. Deteksi format terbalik (Title - Artist)
    if (artist && title && isLikelyReversed(artist, title)) {
      [artist, title] = [title, artist];
    }
  }

  // 8. Bersihkan noise dari artist & title
  artist = artist ? cleanNoise(artist) : null;
  title = cleanNoise(title);

  // 9. Fallback: jika title kosong, gunakan basename asli (tanpa noise)
  if (!title || title.length === 0) {
    title = cleanNoise(basename.replace(/_/g, ' ')) || basename;
  }

  // 10. Jika artist kosong setelah cleaning, set null
  if (!artist || artist.length === 0) {
    artist = null;
  }

  // 11. Bersihkan feat
  if (feat) {
    feat = cleanNoise(feat);
    if (!feat || feat.length === 0) {
      feat = null;
    }
  }

  return {
    artist,
    title,
    feat,
    trackNumber,
    year,
  };
}

module.exports = {
  smartParseFilename,
  cleanNoise,
  extractFeat,
  extractYear,
  extractTrackNumber,
  isLikelyReversed,
  detectSeparator,
  NOISE_KEYWORDS,
};