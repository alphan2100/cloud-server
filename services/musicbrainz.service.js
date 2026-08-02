const { fetch } = require('undici');

/**
 * Service untuk scraping metadata dari MusicBrainz API + Cover Art Archive
 * 
 * MusicBrainz API docs: https://musicbrainz.org/doc/MusicBrainz_API
 * Cover Art Archive: https://coverartarchive.org/
 * 
 * Rate limit: 1 request per detik (wajib, sesuai aturan MusicBrainz)
 */

const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2';
const COVER_ART_BASE = 'https://coverartarchive.org';

// User-Agent wajib untuk MusicBrainz (identifikasi aplikasi)
const USER_AGENT = process.env.MUSICBRAINZ_USER_AGENT || 'CloudStorage/1.0 (cloud-storage-app)';

// Rate limiter sederhana: pastikan minimal 1 detik antar request
let lastRequestTime = 0;
const MIN_INTERVAL_MS = 1100; // sedikit > 1 detik untuk safety

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    const wait = MIN_INTERVAL_MS - elapsed;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestTime = Date.now();
}

async function mbFetch(url) {
  await rateLimit();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[MusicBrainz] HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[MusicBrainz] Fetch error: ${err.message}`);
    return null;
  }
}

const MusicBrainzService = {
  /**
   * Search recording by artist + title
   * Return best match atau null
   */
  async searchRecording(artist, title) {
    if (!artist || !title) return null;
    if (artist === 'Unknown Artist' || title === 'Unknown') return null;

    const query = `recording:"${title}" AND artist:"${artist}"`;
    const url = `${MUSICBRAINZ_BASE}/recording?query=${encodeURIComponent(query)}&limit=1&fmt=json`;
    const data = await mbFetch(url);

    if (!data || !data.recordings || data.recordings.length === 0) {
      // Fallback: search by title only
      const fallbackUrl = `${MUSICBRAINZ_BASE}/recording?query=${encodeURIComponent(`recording:"${title}"`)}&limit=1&fmt=json`;
      const fallbackData = await mbFetch(fallbackUrl);
      if (!fallbackData || !fallbackData.recordings || fallbackData.recordings.length === 0) {
        return null;
      }
      return this._parseRecording(fallbackData.recordings[0]);
    }

    return this._parseRecording(data.recordings[0]);
  },

  /**
   * Parse recording dari MusicBrainz response
   */
  _parseRecording(rec) {
    if (!rec) return null;

    const artist = rec['artist-credit']?.[0]?.artist || rec['artist-credit']?.[0]?.name;
    const release = rec.releases?.[0];

    return {
      mbid: rec.id,
      title: rec.title,
      length: rec.length ? Math.round(rec.length / 1000) : null, // ms → detik
      artist: {
        mbid: artist?.id,
        name: artist?.name || artist,
      },
      album: release
        ? {
            mbid: release.id,
            title: release.title,
            releaseDate: release.date,
            releaseGroupId: release['release-group']?.id,
          }
        : null,
      genre: rec.tags?.[0]?.name,
    };
  },

  /**
   * Get release group info (untuk dapat genre, type, dll)
   */
  async getReleaseGroup(releaseGroupId) {
    if (!releaseGroupId) return null;
    const url = `${MUSICBRAINZ_BASE}/release-group/${releaseGroupId}?inc=tags&fmt=json`;
    return await mbFetch(url);
  },

  /**
   * Get cover art URL dari Cover Art Archive
   * Return { frontUrl, backUrl } atau null
   */
  async getCoverArt(releaseMbid) {
    if (!releaseMbid) return null;

    await rateLimit();
    try {
      const url = `${COVER_ART_BASE}/release/${releaseMbid}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
      });

      if (res.status === 404) return null;
      if (!res.ok) {
        console.warn(`[CoverArt] HTTP ${res.status} for release ${releaseMbid}`);
        return null;
      }

      const data = await res.json();
      const front = data.images?.find((img) => img.front);
      const back = data.images?.find((img) => img.back);

      return {
        frontUrl: front?.image || data.images?.[0]?.image || null,
        backUrl: back?.image || null,
        allImages: data.images?.map((img) => img.image) || [],
      };
    } catch (err) {
      console.error(`[CoverArt] Error for ${releaseMbid}: ${err.message}`);
      return null;
    }
  },

  /**
   * Get cover art URL by release group MBID
   */
  async getCoverArtByReleaseGroup(releaseGroupMbid) {
    if (!releaseGroupMbid) return null;

    await rateLimit();
    try {
      const url = `${COVER_ART_BASE}/release-group/${releaseGroupMbid}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
      });

      if (res.status === 404) return null;
      if (!res.ok) return null;

      const data = await res.json();
      const front = data.images?.find((img) => img.front);

      return {
        frontUrl: front?.image || data.images?.[0]?.image || null,
        allImages: data.images?.map((img) => img.image) || [],
      };
    } catch (err) {
      console.error(`[CoverArt] Error for release-group ${releaseGroupMbid}: ${err.message}`);
      return null;
    }
  },

  /**
   * Search & enrich metadata lengkap
   * Alur: search recording → get cover art
   * Return enriched metadata atau null
   */
  async enrichMetadata(artist, title) {
    const recording = await this.searchRecording(artist, title);
    if (!recording) return null;

    let coverArt = null;
    if (recording.album?.mbid) {
      coverArt = await this.getCoverArt(recording.album.mbid);
    }
    if (!coverArt && recording.album?.releaseGroupId) {
      coverArt = await this.getCoverArtByReleaseGroup(recording.album.releaseGroupId);
    }

    return {
      mbid: recording.mbid,
      title: recording.title,
      duration: recording.length,
      artist: recording.artist,
      album: recording.album,
      genre: recording.genre,
      coverArt,
    };
  },
};

module.exports = MusicBrainzService;