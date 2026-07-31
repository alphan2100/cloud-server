/**
 * ytdlp.service.js
 *
 * Wrapper for yt-dlp to extract media information and direct download URLs
 * from 1000+ sites (YouTube, Twitter/X, Instagram, TikTok, Vimeo, etc.).
 *
 * Flow:
 * 1. yt-dlp --dump-json "URL" → get title, formats, direct URLs
 * 2. Return structured data for frontend display
 * 3. Download via aria2 (direct URLs) or ffmpeg (HLS/DASH)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';

class YtdlpService {
  constructor() {
    this.available = false;
    this._checkAvailability();
  }

  async _checkAvailability() {
    try {
      const { stdout } = await this._exec([ '--version' ]);
      this.available = true;
      console.log(`✅ yt-dlp available: v${stdout.trim()}`);
    } catch (err) {
      this.available = false;
      console.warn('⚠️ yt-dlp is not available. Media site extraction (YouTube, Twitter, etc.) will not work.');
      console.warn('   Install with: brew install yt-dlp');
    }
  }

  _exec(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const child = spawn(YTDLP_PATH, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      });
      child.on('error', (e) => reject(new Error(`Failed to launch yt-dlp: ${e.message}`)));
    });
  }

  /**
   * Check if yt-dlp is available
   */
  isAvailable() {
    return this.available;
  }

  /**
   * Extract media info from a URL using yt-dlp --dump-json
   * Returns structured data similar to media scan results
   */
  async extractInfo(url) {
    if (!this.available) {
      throw new Error('yt-dlp is not installed. Install with: brew install yt-dlp');
    }

    try {
      const { stdout } = await this._exec([
        '--dump-json',
        '--no-download',
        '--no-warnings',
        '--no-playlist',
        '--flat-playlist',
        url,
      ], 30000);

      const data = JSON.parse(stdout.trim().split('\n')[0]);
      return this._formatResult(data, url);
    } catch (err) {
      // If --dump-json fails, try with -g to at least get direct URL
      try {
        const { stdout } = await this._exec([
          '-g',
          '--format', 'best[ext=mp4]/best',
          '--no-warnings',
          '--no-playlist',
          url,
        ], 30000);

        const urls = stdout.trim().split('\n').filter(Boolean);
        return {
          success: true,
          url,
          title: path.basename(new URL(url).pathname) || 'Media',
          extractor: 'unknown',
          formats: [{
            url: urls[0],
            ext: 'mp4',
            format: 'best',
            filesize: null,
          }],
          media: [{
            type: 'video',
            url: urls[0],
            source: 'yt-dlp (fallback)',
            mimeType: 'video/mp4',
            isMain: true,
            filename: 'media.mp4',
            size: 'Unknown',
            sizeBytes: null,
            resumeCapable: true,
            statusCode: 200,
            isSizeReliable: false,
            downloadHeaders: {},
          }],
        };
      } catch (fallbackErr) {
        throw new Error(`yt-dlp extraction failed: ${err.message}`);
      }
    }
  }

  /**
   * Get direct download URL(s) for a media URL
   * Returns array of { url, ext, format } for aria2/ffmpeg
   */
  async getDirectUrls(url, format = 'bestvideo+bestaudio/best') {
    if (!this.available) {
      throw new Error('yt-dlp is not installed');
    }

    const { stdout } = await this._exec([
      '-g',
      '--format', format,
      '--no-warnings',
      '--no-playlist',
      url,
    ], 30000);

    return stdout.trim().split('\n').filter(Boolean);
  }

  /**
   * Get merged video+audio URLs for a specific quality
   */
  async _getMergedUrls(url, quality) {
    const formatString = quality === 'best' 
      ? 'bestvideo+bestaudio/best'
      : `bestvideo[height=${quality}]+bestaudio[height<=${quality}]/best[height<=${quality}]`;
    
    try {
      const { stdout } = await this._exec([
        '-g',
        '--format', formatString,
        '--no-warnings',
        '--no-playlist',
        url,
      ], 30000);

      const urls = stdout.trim().split('\n').filter(Boolean);
      if (urls.length >= 2) {
        return { videoUrl: urls[0], audioUrl: urls[1] };
      } else if (urls.length === 1) {
        return { videoUrl: urls[0], audioUrl: null };
      }
    } catch (err) {
      console.warn(`Failed to get merged URLs for quality ${quality}:`, err.message);
    }
    return null;
  }

  /**
   * Format yt-dlp JSON output into our media scan result structure
   * Now returns merged video+audio options for each quality
   */
  async _formatResult(data, originalUrl) {
    const mediaItems = [];
    const formats = data.formats || [];
    const requestedFormats = data.requested_formats || [];
    const title = data.title || data.fulltitle || path.basename(new URL(originalUrl).pathname) || 'Media';
    const extractor = data.extractor || data.extractor_key || 'unknown';

    // Extract unique video heights from formats
    const videoFormats = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height);
    const heights = [...new Set(videoFormats.map(f => f.height))].sort((a, b) => b - a);

    // Create merged quality options (bestvideo + bestaudio for each resolution)
    const mergedQualities = [];
    for (const height of heights) {
      const heightStr = String(height);
      const matchingFormats = videoFormats.filter(f => f.height === height);
      const bestVideo = matchingFormats[0]; // Already sorted by quality
      
      // Find matching audio for this height
      // Audio-only formats have vcodec === 'none' (not undefined/null)
      const audioFormats = formats.filter(f => f.acodec && f.acodec !== 'none' && f.vcodec === 'none');
      const bestAudio = audioFormats[0]; // Best audio available

      // Check if video already has audio (no need to merge)
      const videoHasAudio = bestVideo.acodec && bestVideo.acodec !== 'none';
      
      if (bestVideo && bestVideo.url) {
        const qualityLabel = height >= 2160 ? '4K' : height >= 1440 ? '1440p' : height >= 1080 ? '1080p' : height >= 720 ? '720p' : height >= 480 ? '480p' : height >= 360 ? '360p' : `${height}p`;
        
        mergedQualities.push({
          quality: qualityLabel,
          height: height,
          videoUrl: bestVideo.url,
          audioUrl: bestAudio ? bestAudio.url : null,
          videoFormatId: bestVideo.format_id,
          audioFormatId: bestAudio ? bestAudio.format_id : null,
          ext: bestVideo.ext || 'mp4',
          filesize: bestVideo.filesize || (bestVideo.filesize_approx || null),
          vcodec: bestVideo.vcodec,
          acodec: bestVideo.acodec || (bestAudio ? bestAudio.acodec : 'none'),
          resolution: bestVideo.resolution || `${bestVideo.width}x${height}`,
          fps: bestVideo.fps || null,
          tbr: bestVideo.tbr || null,
          needsMerge: !videoHasAudio && !!bestAudio, // Only merge if video lacks audio AND audio exists
        });
      }
    }

    // Add best single format if available (already merged by yt-dlp)
    if (data.url && mergedQualities.length === 0) {
      mediaItems.push({
        type: 'video',
        url: data.url,
        source: `yt-dlp (${extractor})`,
        mimeType: `video/${data.ext || 'mp4'}`,
        isMain: true,
        filename: `${title}.${data.ext || 'mp4'}`,
        size: data.filesize ? this._formatSize(data.filesize) : 'Unknown',
        sizeBytes: data.filesize || null,
        resumeCapable: true,
        statusCode: 200,
        isSizeReliable: !!data.filesize,
        downloadHeaders: {},
        quality: data.format_note || 'best',
        resolution: data.resolution || null,
        vcodec: data.vcodec,
        acodec: data.acodec,
      });
    }

    // Create main media item with all merged qualities
    if (mergedQualities.length > 0) {
      const mainQuality = mergedQualities[0];
      mediaItems.push({
        type: 'video',
        url: mainQuality.videoUrl,
        source: `yt-dlp (${extractor})`,
        mimeType: `video/${mainQuality.ext}`,
        isMain: true,
        filename: `${title}_${mainQuality.quality}.${mainQuality.ext}`,
        size: mainQuality.filesize ? this._formatSize(mainQuality.filesize) : 'Unknown',
        sizeBytes: mainQuality.filesize || null,
        resumeCapable: true,
        statusCode: 200,
        isSizeReliable: !!mainQuality.filesize,
        downloadHeaders: {},
        quality: mainQuality.quality,
        resolution: mainQuality.resolution,
        vcodec: mainQuality.vcodec,
        acodec: mainQuality.acodec,
        qualities: mergedQualities.map(q => ({
          quality: q.quality,
          resolution: q.resolution,
          height: q.height,
          videoUrl: q.videoUrl,
          audioUrl: q.audioUrl,
          ext: q.ext,
          filesize: q.filesize,
          vcodec: q.vcodec,
          acodec: q.acodec,
          fps: q.fps,
          tbr: q.tbr,
          needsMerge: q.needsMerge, // Use the calculated needsMerge flag
        })),
      });
    }

    return {
      success: true,
      url: originalUrl,
      mode: 'yt-dlp',
      title,
      extractor,
      thumbnail: data.thumbnail || null,
      duration: data.duration || null,
      viewCount: data.view_count || null,
      uploader: data.uploader || data.channel || null,
      uploadDate: data.upload_date || null,
      media: mediaItems,
    };
  }

  _formatSize(bytes) {
    if (!bytes) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return `${size.toFixed(i > 0 ? 2 : 0)} ${units[i]}`;
  }
}

module.exports = new YtdlpService();