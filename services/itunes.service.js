/**
 * iTunes Search API Service
 *
 * Search metadata lagu via iTunes Search API (gratis, tanpa auth).
 * API docs: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/
 *
 * Keunggulan:
 * - Gratis, tanpa API key
 * - No rate limit ketat (beberapa request/detik OK)
 * - Cover art HD (upgrade 100x100 → 600x600)
 * - Metadata akurat (dari Apple Music database)
 * - Duration, genre, release date, album name
 */

const { fetch } = require('undici');

const ITUNES_BASE = 'https://itunes.apple.com/search';

/**
 * Rate limiter sederhana: minimal 200ms antar request (sopan ke iTunes)
 */
let lastRequestTime = 0;
const MIN_INTERVAL_MS = 200;

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Upgrade artwork URL ke resolusi lebih tinggi.
 * iTunes return artworkUrl100 (100x100), bisa diupgrade ke 600x600.
 *
 * @param {string} url - URL artwork dari iTunes
 * @param {number} size - ukuran target (default 600)
 * @returns {string} - URL artwork HD
 */
function upgradeArtworkUrl(url, size = 600) {
  if (!url) return null;
  // Pattern: .../100x100bb.jpg → .../600x600bb.jpg
  return url.replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
}

const ITunesService = {
  /**
   * Search song by artist + title
   * @param {string} artist - nama artist
   * @param {string} title - judul lagu
   * @returns {Promise<Object|null>} - metadata atau null
   */
  async searchSong(artist, title) {
    if (!title) return null;

    // Build search term: "artist title" atau "title" saja
    let term;
    if (artist && artist !== 'Unknown Artist') {
      term = `${artist} ${title}`;
    } else {
      term = title;
    }

    const params = new URLSearchParams({
      term,
      entity: 'song',
      limit: '5', // ambil beberapa untuk matching terbaik
      media: 'music',
    });

    await rateLimit();

    try {
      const url = `${ITUNES_BASE}?${params.toString()}`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        console.warn(`[iTunes] HTTP ${res.status} for term "${term}"`);
        return null;
      }

      const data = await res.json();

      if (!data.results || data.results.length === 0) {
        // Fallback: search by title only
        if (artist && artist !== 'Unknown Artist') {
          return this.searchByTitleOnly(title);
        }
        return null;
      }

      // Pilih hasil terbaik (match artist name)
      const bestMatch = this._findBestMatch(data.results, artist, title);
      return this._parseResult(bestMatch);
    } catch (err) {
      console.error(`[iTunes] Search error: ${err.message}`);
      return null;
    }
  },

  /**
   * Search by title only (fallback)
   */
  async searchByTitleOnly(title) {
    const params = new URLSearchParams({
      term: title,
      entity: 'song',
      limit: '1',
      media: 'music',
    });

    await rateLimit();

    try {
      const url = `${ITUNES_BASE}?${params.toString()}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) return null;

      const data = await res.json();
      if (!data.results || data.results.length === 0) return null;

      return this._parseResult(data.results[0]);
    } catch (err) {
      console.error(`[iTunes] Fallback search error: ${err.message}`);
      return null;
    }
  },

  /**
   * Cari hasil terbaik dari multiple results.
   * Prioritas: exact artist match > partial artist match > first result
   */
  _findBestMatch(results, artist, title) {
    if (!artist || artist === 'Unknown Artist') {
      return results[0];
    }

    const artistLower = artist.toLowerCase();
    const titleLower = title.toLowerCase();

    // 1. Cari exact match: artistName == artist AND trackName == title
    const exactMatch = results.find(
      (r) =>
        r.artistName &&
        r.artistName.toLowerCase() === artistLower &&
        r.trackName &&
        r.trackName.toLowerCase() === titleLower
    );
    if (exactMatch) return exactMatch;

    // 2. Cari artist match (artistName contains artist atau sebaliknya)
    const artistMatch = results.find(
      (r) =>
        r.artistName &&
        (r.artistName.toLowerCase().includes(artistLower) ||
          artistLower.includes(r.artistName.toLowerCase()))
    );
    if (artistMatch) return artistMatch;

    // 3. Cari title match
    const titleMatch = results.find(
      (r) => r.trackName && r.trackName.toLowerCase().includes(titleLower)
    );
    if (titleMatch) return titleMatch;

    // 4. Fallback: first result
    return results[0];
  },

  /**
   * Parse hasil iTunes ke format standar
   */
  _parseResult(result) {
    if (!result) return null;

    // Parse release date: "2018-05-11T12:00:00Z" → "2018-05-11"
    let releaseDate = null;
    if (result.releaseDate) {
      releaseDate = result.releaseDate.split('T')[0];
    }

    // Parse year dari release date
    let year = null;
    if (releaseDate) {
      year = parseInt(releaseDate.split('-')[0]);
    }

    // Duration: trackTimeMillis → detik
    let duration = null;
    if (result.trackTimeMillis) {
      duration = Math.round(result.trackTimeMillis / 1000);
    }

    // Cover art HD (600x600)
    const coverArtUrl = upgradeArtworkUrl(result.artworkUrl100, 600);

    return {
      title: result.trackName || null,
      artist: {
        name: result.artistName || null,
        // iTunes tidak punya MBID, gunakan artistId sebagai identifier
        itunesId: result.artistId || null,
      },
      album: {
        title: result.collectionName || null,
        // iTunes collectionId sebagai identifier
        itunesId: result.collectionId || null,
        releaseDate,
        coverArtUrl,
      },
      genre: result.primaryGenreName || null,
      year,
      duration,
      // iTunes preview URL (30s sample)
      previewUrl: result.previewUrl || null,
      // Track number dari album
      trackNumber: result.trackNumber || null,
    };
  },

  /**
   * Search & enrich metadata lengkap
   * Wrapper untuk searchSong
   */
  async enrichMetadata(artist, title) {
    return await this.searchSong(artist, title);
  },
};

module.exports = ITunesService;
