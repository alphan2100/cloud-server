const http = require('http');
const https = require('https');
const url = require('url');
const { fetchAccurateFileInfo } = require('./utils');
const browserDetector = require('./browserDetector');

// Media detection result structure
class MediaItem {
  constructor(type, url, source, mimeType = null) {
    this.type = type; // 'video', 'audio', 'hls', 'dash', 'image', etc.
    this.url = url;
    this.source = source; // detector name
    this.mimeType = mimeType;
    this.quality = null;
    this.isMain = false;
    this.title = null;
    this.thumbnail = null;
  }
}

// HTML Fetcher
async function fetchHTML(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    };
    
    const request = protocol.request(options, (response) => {
      let data = '';
      
      response.on('data', (chunk) => {
        data += chunk;
      });
      
      response.on('end', () => {
        resolve({
          html: data,
          statusCode: response.statusCode,
          headers: response.headers
        });
      });
    });
    
    request.on('error', (error) => {
      reject(error);
    });
    
    request.setTimeout(15000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
    
    request.end();
  });
}

// Extract base URL for resolving relative URLs
function getBaseUrl(targetUrl) {
  const parsed = new URL(targetUrl);
  // Get the directory path of the current URL
  const pathParts = parsed.pathname.split('/');
  pathParts.pop(); // Remove the last part (filename)
  const basePath = pathParts.join('/');
  return `${parsed.protocol}//${parsed.hostname}${basePath}`;
}

// Resolve relative URL to absolute
function resolveUrl(baseUrl, relativeUrl) {
  try {
    if (!relativeUrl || relativeUrl.trim() === '') {
      return null;
    }
    
    if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
      return relativeUrl;
    }
    if (relativeUrl.startsWith('//')) {
      return 'https:' + relativeUrl;
    }
    if (relativeUrl.startsWith('/')) {
      // Absolute path from root
      const parsed = new URL(baseUrl);
      return `${parsed.protocol}//${parsed.hostname}${relativeUrl}`;
    }
    if (relativeUrl.startsWith('data:')) {
      // Data URI, skip
      return null;
    }
    // Relative path - append to base URL
    if (baseUrl.endsWith('/')) {
      return baseUrl + relativeUrl;
    } else {
      return baseUrl + '/' + relativeUrl;
    }
  } catch (e) {
    console.error('Error resolving URL:', e.message, 'base:', baseUrl, 'relative:', relativeUrl);
    return null;
  }
}

// Check if URL is media file
function isMediaUrl(urlStr) {
  const mediaExtensions = [
    'mp4', 'webm', 'ogg', 'avi', 'mov', 'wmv', 'flv', 'mkv',
    'mp3', 'wav', 'aac', 'flac', 'm4a', 'wma',
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp',
    'm3u8', 'mpd', 'm3u', 'pls'
  ];
  
  try {
    const pathname = new URL(urlStr).pathname.toLowerCase();
    const ext = pathname.split('.').pop();
    return mediaExtensions.includes(ext);
  } catch (e) {
    return false;
  }
}

// Check if URL is HLS manifest
function isHLS(urlStr) {
  return urlStr.includes('.m3u8') || urlStr.includes('application/x-mpegURL');
}

// Check if URL is DASH manifest
function isDASH(urlStr) {
  return urlStr.includes('.mpd') || urlStr.includes('application/dash+xml');
}

// ========== DETECTORS ==========

// 1. HTML5 Video Tag Detector
function detectVideoTag(html, baseUrl) {
  const mediaItems = [];
  const videoRegex = /<video[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let match;
  
  while ((match = videoRegex.exec(html)) !== null) {
    const videoUrl = resolveUrl(baseUrl, match[1]);
    if (videoUrl) {
      const item = new MediaItem('video', videoUrl, 'HTML5 Video');
      // Extract attributes
      const videoTag = match[0];
      if (videoTag.includes('type="video/mp4"')) item.mimeType = 'video/mp4';
      if (videoTag.includes('type="video/webm"')) item.mimeType = 'video/webm';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 2. HTML5 Audio Tag Detector
function detectAudioTag(html, baseUrl) {
  const mediaItems = [];
  const audioRegex = /<audio[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let match;
  
  while ((match = audioRegex.exec(html)) !== null) {
    const audioUrl = resolveUrl(baseUrl, match[1]);
    if (audioUrl) {
      const item = new MediaItem('audio', audioUrl, 'HTML5 Audio');
      const audioTag = match[0];
      if (audioTag.includes('type="audio/mp3"')) item.mimeType = 'audio/mpeg';
      if (audioTag.includes('type="audio/wav"')) item.mimeType = 'audio/wav';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 3. Source Tag Detector (within video/audio)
function detectSourceTag(html, baseUrl) {
  const mediaItems = [];
  const sourceRegex = /<source[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let match;
  
  while ((match = sourceRegex.exec(html)) !== null) {
    const sourceUrl = resolveUrl(baseUrl, match[1]);
    if (sourceUrl) {
      const item = new MediaItem('unknown', sourceUrl, 'Source Tag');
      const sourceTag = match[0];
      
      // Detect type from attributes
      if (sourceTag.includes('type="video/')) {
        item.type = 'video';
        item.mimeType = sourceTag.match(/type="([^"]+)"/)?.[1];
      } else if (sourceTag.includes('type="audio/')) {
        item.type = 'audio';
        item.mimeType = sourceTag.match(/type="([^"]+)"/)?.[1];
      } else if (isHLS(sourceUrl)) {
        item.type = 'hls';
      } else if (isDASH(sourceUrl)) {
        item.type = 'dash';
      }
      
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 4. HLS Detector (.m3u8)
function detectHLS(html, baseUrl) {
  const mediaItems = [];
  const hlsRegex = /["']([^"']+\.m3u8[^"']*)["']/gi;
  let match;
  
  while ((match = hlsRegex.exec(html)) !== null) {
    const hlsUrl = resolveUrl(baseUrl, match[1]);
    if (hlsUrl) {
      const item = new MediaItem('hls', hlsUrl, 'HLS Manifest');
      item.mimeType = 'application/x-mpegURL';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 5. DASH Detector (.mpd)
function detectDASH(html, baseUrl) {
  const mediaItems = [];
  const dashRegex = /["']([^"']+\.mpd[^"']*)["']/gi;
  let match;
  
  while ((match = dashRegex.exec(html)) !== null) {
    const dashUrl = resolveUrl(baseUrl, match[1]);
    if (dashUrl) {
      const item = new MediaItem('dash', dashUrl, 'DASH Manifest');
      item.mimeType = 'application/dash+xml';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 6. JWPlayer Detector
function detectJWPlayer(html, baseUrl) {
  const mediaItems = [];
  
  // JWPlayer setup
  const jwRegex = /jwplayer\(["'][^"']+["']\)\.setup\s*\(\s*\{[^}]*file:\s*["']([^"']+)["']/gi;
  let match;
  
  while ((match = jwRegex.exec(html)) !== null) {
    const mediaUrl = resolveUrl(baseUrl, match[1]);
    if (mediaUrl) {
      const item = new MediaItem('unknown', mediaUrl, 'JWPlayer');
      if (isHLS(mediaUrl)) item.type = 'hls';
      else if (isDASH(mediaUrl)) item.type = 'dash';
      else item.type = 'video';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 7. VideoJS Detector
function detectVideoJS(html, baseUrl) {
  const mediaItems = [];
  
  // VideoJS data-setup
  const videojsRegex = /data-setup="\{[^}]*sources:\s*\[?\{[^}]*src:\s*["']([^"']+)["']/gi;
  let match;
  
  while ((match = videojsRegex.exec(html)) !== null) {
    const mediaUrl = resolveUrl(baseUrl, match[1]);
    if (mediaUrl) {
      const item = new MediaItem('unknown', mediaUrl, 'VideoJS');
      if (isHLS(mediaUrl)) item.type = 'hls';
      else if (isDASH(mediaUrl)) item.type = 'dash';
      else item.type = 'video';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 8. Plyr Detector
function detectPlyr(html, baseUrl) {
  const mediaItems = [];
  
  // Plyr uses standard HTML5 video/audio tags, but with specific class
  const plyrRegex = /class="plyr[^"]*"[\s\S]*?<video[^>]*src=["']([^"']+)["']/gi;
  let match;
  
  while ((match = plyrRegex.exec(html)) !== null) {
    const mediaUrl = resolveUrl(baseUrl, match[1]);
    if (mediaUrl) {
      const item = new MediaItem('video', mediaUrl, 'Plyr');
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 9. Clappr Detector
function detectClappr(html, baseUrl) {
  const mediaItems = [];
  
  const clapprRegex = /new\s+Clappr\.Player\s*\(\s*\{[^}]*source:\s*["']([^"']+)["']/gi;
  let match;
  
  while ((match = clapprRegex.exec(html)) !== null) {
    const mediaUrl = resolveUrl(baseUrl, match[1]);
    if (mediaUrl) {
      const item = new MediaItem('unknown', mediaUrl, 'Clappr');
      if (isHLS(mediaUrl)) item.type = 'hls';
      else if (isDASH(mediaUrl)) item.type = 'dash';
      else item.type = 'video';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 13. Flowplayer Detector
function detectFlowplayer(html, baseUrl) {
  const mediaItems = [];
  
  // Flowplayer 7+
  const flowRegex = /flowplayer\([^)]*\)\.setup\s*\(\s*\{[^}]*file:\s*["']([^"']+)["']/gi;
  let match;
  
  while ((match = flowRegex.exec(html)) !== null) {
    const mediaUrl = resolveUrl(baseUrl, match[1]);
    if (mediaUrl) {
      const item = new MediaItem('unknown', mediaUrl, 'Flowplayer');
      if (isHLS(mediaUrl)) item.type = 'hls';
      else if (isDASH(mediaUrl)) item.type = 'dash';
      else item.type = 'video';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 14. Kaltura Detector
function detectKaltura(html, baseUrl) {
  const mediaItems = [];
  
  // Kaltura embed
  const kalturaRegex = /kWidget\.(?:embed|setup)\s*\(\s*\{[^}]*entryId:\s*["']([^"']+)["']/gi;
  let match;
  
  while ((match = kalturaRegex.exec(html)) !== null) {
    // Kaltura requires API call, just mark it
    mediaItems.push(new MediaItem('video', 'kaltura://' + match[1], 'Kaltura'));
  }
  
  return mediaItems;
}

// 15. Brightcove Detector
function detectBrightcove(html, baseUrl) {
  const mediaItems = [];
  
  // Brightcove player
  const bcRegex = /videojs\s*\(\s*["'][^"']+["'][^}]*\)\.ready\s*\(\s*function\s*\([^)]*\)\s*\{[^}]*src:\s*["']([^"']+)["']/gi;
  let match;
  
  while ((match = bcRegex.exec(html)) !== null) {
    const mediaUrl = resolveUrl(baseUrl, match[1]);
    if (mediaUrl) {
      const item = new MediaItem('unknown', mediaUrl, 'Brightcove');
      if (isHLS(mediaUrl)) item.type = 'hls';
      else if (isDASH(mediaUrl)) item.type = 'dash';
      else item.type = 'video';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 16. MediaElement.js Detector
function detectMediaElement(html, baseUrl) {
  const mediaItems = [];
  
  const meRegex = /new\s+MediaElement\s*\(\s*["']([^"']+)["'][^}]*\)/gi;
  let match;
  
  while ((match = meRegex.exec(html)) !== null) {
    const mediaUrl = resolveUrl(baseUrl, match[1]);
    if (mediaUrl) {
      const item = new MediaItem('unknown', mediaUrl, 'MediaElement.js');
      if (isHLS(mediaUrl)) item.type = 'hls';
      else if (isDASH(mediaUrl)) item.type = 'dash';
      else item.type = 'video';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 17. jPlayer Detector
function detectJPlayer(html, baseUrl) {
  const mediaItems = [];
  
  const jpRegex = /jPlayer\s*\(\s*\{[^}]*supplied:\s*["']([^"']+)["'][^}]*\)/gi;
  let match;
  
  while ((match = jpRegex.exec(html)) !== null) {
    const mediaUrl = resolveUrl(baseUrl, match[1]);
    if (mediaUrl) {
      const item = new MediaItem('unknown', mediaUrl, 'jPlayer');
      if (mediaUrl.includes('.mp3')) item.type = 'audio';
      else item.type = 'video';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// 18. YouTube Iframe Detector
function detectYouTubeIframe(html, baseUrl) {
  const mediaItems = [];
  
  // YouTube iframe embed
  const ytRegex = /<iframe[^>]*src=["']([^"']*youtube\.com\/embed\/[^"']+)["']/gi;
  let match;
  
  while ((match = ytRegex.exec(html)) !== null) {
    const videoUrl = match[1];
    mediaItems.push(new MediaItem('video', videoUrl, 'YouTube Iframe'));
  }
  
  return mediaItems;
}

// 19. Vimeo Detector
function detectVimeo(html, baseUrl) {
  const mediaItems = [];
  
  // Vimeo iframe
  const vimeoRegex = /<iframe[^>]*src=["']([^"']*vimeo\.com\/[^"']+)["']/gi;
  let match;
  
  while ((match = vimeoRegex.exec(html)) !== null) {
    const videoUrl = match[1];
    mediaItems.push(new MediaItem('video', videoUrl, 'Vimeo'));
  }
  
  return mediaItems;
}

// 20. Dailymotion Detector
function detectDailymotion(html, baseUrl) {
  const mediaItems = [];
  
  // Dailymotion iframe
  const dmRegex = /<iframe[^>]*src=["']([^"']*dailymotion\.com\/embed\/[^"']+)["']/gi;
  let match;
  
  while ((match = dmRegex.exec(html)) !== null) {
    const videoUrl = match[1];
    mediaItems.push(new MediaItem('video', videoUrl, 'Dailymotion'));
  }
  
  return mediaItems;
}

// 21. Facebook Video Detector
function detectFacebookVideo(html, baseUrl) {
  const mediaItems = [];
  
  // Facebook video embed
  const fbRegex = /<iframe[^>]*src=["']([^"']*facebook\.com\/[^"']+)["']/gi;
  let match;
  
  while ((match = fbRegex.exec(html)) !== null) {
    const videoUrl = match[1];
    mediaItems.push(new MediaItem('video', videoUrl, 'Facebook'));
  }
  
  return mediaItems;
}

// 22. Instagram Embed Detector
function detectInstagram(html, baseUrl) {
  const mediaItems = [];
  
  // Instagram embed
  const igRegex = /<iframe[^>]*src=["']([^"']*instagram\.com\/[^"']+)["']/gi;
  let match;
  
  while ((match = igRegex.exec(html)) !== null) {
    const mediaUrl = match[1];
    mediaItems.push(new MediaItem('video', mediaUrl, 'Instagram'));
  }
  
  return mediaItems;
}

// 10. JSON Detector (find JSON with media URLs)
function detectJSON(html, baseUrl) {
  const mediaItems = [];
  
  // Look for JSON patterns with media URLs
  const jsonRegex = /["'](https?:\/\/[^"']+\.(?:mp4|webm|m3u8|mpd|mp3))["']/gi;
  let match;
  
  while ((match = jsonRegex.exec(html)) !== null) {
    const mediaUrl = match[1];
    const item = new MediaItem('unknown', mediaUrl, 'JSON');
    if (isHLS(mediaUrl)) item.type = 'hls';
    else if (isDASH(mediaUrl)) item.type = 'dash';
    else if (mediaUrl.includes('.mp3')) item.type = 'audio';
    else item.type = 'video';
    mediaItems.push(item);
  }
  
  return mediaItems;
}

// 11. Meta Tag Detector (Open Graph, Twitter Cards)
function detectMetaTags(html, baseUrl) {
  const mediaItems = [];
  
  // Open Graph video
  const ogVideoRegex = /<meta[^>]*property=["']og:video["'][^>]*content=["']([^"']+)["']/gi;
  let match = ogVideoRegex.exec(html);
  if (match) {
    const videoUrl = resolveUrl(baseUrl, match[1]);
    if (videoUrl) {
      mediaItems.push(new MediaItem('video', videoUrl, 'Open Graph'));
    }
  }
  
  // Twitter video
  const twitterVideoRegex = /<meta[^>]*name=["']twitter:player["'][^>]*content=["']([^"']+)["']/gi;
  match = twitterVideoRegex.exec(html);
  if (match) {
    const videoUrl = resolveUrl(baseUrl, match[1]);
    if (videoUrl) {
      mediaItems.push(new MediaItem('video', videoUrl, 'Twitter Card'));
    }
  }
  
  return mediaItems;
}

// 12. Direct Link Detector
function detectDirectLinks(html, baseUrl) {
  const mediaItems = [];
  
  // Find all links with media extensions
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;
  
  while ((match = linkRegex.exec(html)) !== null) {
    const linkUrl = resolveUrl(baseUrl, match[1]);
    if (linkUrl && isMediaUrl(linkUrl)) {
      const item = new MediaItem('unknown', linkUrl, 'Direct Link');
      if (linkUrl.includes('.m3u8')) item.type = 'hls';
      else if (linkUrl.includes('.mpd')) item.type = 'dash';
      else if (linkUrl.match(/\.(mp4|webm|avi|mov)$/)) item.type = 'video';
      else if (linkUrl.match(/\.(mp3|wav|aac)$/)) item.type = 'audio';
      else if (linkUrl.match(/\.(jpg|jpeg|png|gif|webp)$/)) item.type = 'image';
      mediaItems.push(item);
    }
  }
  
  return mediaItems;
}

// Fetch file info for a media URL. headerOverrides (Referer/Origin/Cookie/
// User-Agent captured from the headless-browser session) are forwarded so
// CDNs that check those headers don't reject the probe with a 403.
async function fetchMediaInfo(mediaUrl, headerOverrides = {}) {
  try {
    const extraHeaders = {};
    if (headerOverrides.Referer) extraHeaders['Referer'] = headerOverrides.Referer;
    if (headerOverrides.Origin) extraHeaders['Origin'] = headerOverrides.Origin;
    if (headerOverrides.Cookie) extraHeaders['Cookie'] = headerOverrides.Cookie;
    if (headerOverrides['User-Agent']) extraHeaders['User-Agent'] = headerOverrides['User-Agent'];

    // Uses the same redirect-following, HEAD-with-ranged-GET-fallback logic
    // as /api/file-info (see utils.js) - previously this function only did
    // a bare HEAD request with no redirect handling and no fallback, which
    // is why size/mime/resume info here was often wrong for CDN-hosted
    // media (redirects, HEAD-unsupported hosts, partial-range confusion).
    const info = await fetchAccurateFileInfo(mediaUrl, extraHeaders);
    return {
      filename: info.filename,
      size: info.size,
      sizeBytes: info.sizeBytes,
      mimeType: info.mimeType,
      resumeCapable: info.resumeCapable,
      statusCode: info.statusCode,
      isSizeReliable: info.isSizeReliable
    };
  } catch (error) {
    return {
      filename: 'Unknown',
      size: 'Unknown',
      sizeBytes: null,
      mimeType: 'application/octet-stream',
      resumeCapable: false,
      statusCode: 0,
      isSizeReliable: false
    };
  }
}

// All static-HTML regex detectors, run against whatever HTML string is
// handed in - could be the raw server response, or the fully JS-rendered
// HTML captured by the headless browser.
const REGEX_DETECTORS = [
  { name: 'Video Tag', fn: detectVideoTag },
  { name: 'Audio Tag', fn: detectAudioTag },
  { name: 'Source Tag', fn: detectSourceTag },
  { name: 'HLS', fn: detectHLS },
  { name: 'DASH', fn: detectDASH },
  { name: 'JWPlayer', fn: detectJWPlayer },
  { name: 'VideoJS', fn: detectVideoJS },
  { name: 'Plyr', fn: detectPlyr },
  { name: 'Clappr', fn: detectClappr },
  { name: 'Flowplayer', fn: detectFlowplayer },
  { name: 'Kaltura', fn: detectKaltura },
  { name: 'Brightcove', fn: detectBrightcove },
  { name: 'MediaElement', fn: detectMediaElement },
  { name: 'jPlayer', fn: detectJPlayer },
  { name: 'YouTube', fn: detectYouTubeIframe },
  { name: 'Vimeo', fn: detectVimeo },
  { name: 'Dailymotion', fn: detectDailymotion },
  { name: 'Facebook', fn: detectFacebookVideo },
  { name: 'Instagram', fn: detectInstagram },
  { name: 'JSON', fn: detectJSON },
  { name: 'Meta Tags', fn: detectMetaTags },
  { name: 'Direct Links', fn: detectDirectLinks }
];

function runRegexDetectors(html, baseUrl) {
  const allMedia = [];
  for (const detector of REGEX_DETECTORS) {
    try {
      const items = detector.fn(html, baseUrl);
      allMedia.push(...items);
    } catch (e) {
      console.error(`Error in ${detector.name}:`, e.message);
    }
  }
  return allMedia;
}

function markMain(uniqueMedia) {
  if (uniqueMedia.length > 0 && !uniqueMedia.some(m => m.isMain)) {
    const videos = uniqueMedia.filter(m => m.type === 'video');
    const mainMedia = videos.length > 0 ? videos[0] : uniqueMedia[0];
    mainMedia.isMain = true;
  }
  return uniqueMedia;
}

async function enrichWithFileInfo(uniqueMedia, headerOverrides) {
  return Promise.all(
    uniqueMedia.map(async (item) => {
      // Skip special URLs (Kaltura, embeds) - nothing to HEAD-request
      if (item.url.startsWith('kaltura://') || item.url.includes('embed')) {
        return {
          type: item.type,
          url: item.url,
          source: item.source,
          mimeType: item.mimeType || 'video/mp4',
          isMain: item.isMain,
          filename: 'Embedded Player',
          size: 'N/A',
          sizeBytes: null,
          resumeCapable: false,
          statusCode: 200,
          isSizeReliable: false,
          qualities: item.qualities || null,
          downloadHeaders: item.downloadHeaders || null
        };
      }

      // HLS/DASH manifests aren't downloadable files themselves - report
      // the manifest as found, but skip the HEAD probe (it's not meaningful
      // for a playlist) and surface quality variants instead if we have them.
      if (item.type === 'hls' || item.type === 'dash') {
        return {
          type: item.type,
          url: item.url,
          source: item.source,
          mimeType: item.mimeType || (item.type === 'hls' ? 'application/x-mpegURL' : 'application/dash+xml'),
          isMain: item.isMain,
          filename: item.type === 'hls' ? 'playlist.m3u8' : 'manifest.mpd',
          size: 'N/A (streaming manifest)',
          sizeBytes: null,
          resumeCapable: false,
          statusCode: item.status || 200,
          isSizeReliable: false,
          qualities: item.qualities || null,
          downloadHeaders: item.downloadHeaders || null
        };
      }

      const info = await fetchMediaInfo(item.url, headerOverrides);
      return {
        type: item.type,
        url: item.url,
        source: item.source,
        mimeType: info.mimeType || item.mimeType,
        isMain: item.isMain,
        filename: info.filename,
        size: info.size,
        sizeBytes: info.sizeBytes,
        resumeCapable: info.resumeCapable,
        statusCode: info.statusCode,
        isSizeReliable: info.isSizeReliable,
        qualities: item.qualities || null,
        downloadHeaders: item.downloadHeaders || null
      };
    })
  );
}

// Main Media Detector (fast path - static HTML only, no JS execution).
// Good for simple pages; will miss anything injected client-side.
async function detectMedia(targetUrl) {
  try {
    // Fetch HTML
    const { html, statusCode, headers } = await fetchHTML(targetUrl);
    
    if (statusCode !== 200) {
      return {
        success: false,
        error: `HTTP ${statusCode}`,
        url: targetUrl
      };
    }
    
    const baseUrl = getBaseUrl(targetUrl);
    const allMedia = runRegexDetectors(html, baseUrl);
    const uniqueMedia = markMain(removeDuplicates(allMedia));
    const mediaWithInfo = await enrichWithFileInfo(uniqueMedia);
    
    return {
      success: true,
      url: targetUrl,
      statusCode: statusCode,
      mode: 'fast',
      media: mediaWithInfo
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      url: targetUrl
    };
  }
}

// Deep Media Detector ("Option A"): loads the page in headless Chromium,
// sniffs the network for media responses (catches JS-injected players,
// XHR/fetch-loaded sources, obfuscated player JS - all the stuff the
// regex-only pass above can't see), AND re-runs the regex detectors
// against the fully JS-rendered HTML for extra coverage. Slower, but this
// is the mode that closes the gap with IDM/1DM-style detection.
async function detectMediaDeep(targetUrl, options = {}) {
  if (!browserDetector.isPuppeteerAvailable()) {
    return {
      success: false,
      error:
        "Deep scan requires puppeteer-core. Run 'npm install puppeteer-core' in the project folder, then restart the server.",
      url: targetUrl
    };
  }

  if (!browserDetector.isChromeAvailable()) {
    return {
      success: false,
      error:
        'Deep scan needs an installed Chrome/Chromium/Edge browser. Install Google Chrome, or set the CHROME_PATH environment variable to your browser executable, then restart the server.',
      url: targetUrl
    };
  }

  try {
    const baseUrl = getBaseUrl(targetUrl);

    const { media: sniffedMedia, renderedHtml, cookieHeader, pageHeaders } =
      await browserDetector.sniffWithBrowser(targetUrl, options);

    // Re-run the regex detectors against the POST-JS HTML so SPA-injected
    // <video>/<source> tags, meta tags, etc. are caught too.
    const regexMedia = renderedHtml ? runRegexDetectors(renderedHtml, baseUrl) : [];

    // Tag network-sniffed items with the headers/cookies needed to
    // actually download them later without hitting a 403.
    const downloadHeaders = {
      Referer: pageHeaders.referer,
      Origin: pageHeaders.origin,
      'User-Agent': pageHeaders.userAgent,
      Cookie: cookieHeader || undefined
    };

    const normalizedSniffed = sniffedMedia.map((item) => ({
      type: item.type === 'segment' ? 'unknown' : item.type,
      url: item.url,
      source: item.source, // 'Network Sniffing'
      mimeType: item.mimeType,
      isMain: false,
      qualities: item.qualities || null,
      downloadHeaders: {
        Referer: item.referer || downloadHeaders.Referer,
        Origin: item.origin || downloadHeaders.Origin,
        'User-Agent': item.userAgent || downloadHeaders['User-Agent'],
        Cookie: cookieHeader || undefined
      }
    }));

    const regexMediaWithHeaders = regexMedia.map((item) => {
      item.downloadHeaders = downloadHeaders;
      return item;
    });

    const allMedia = [...normalizedSniffed, ...regexMediaWithHeaders];
    const uniqueMedia = markMain(removeDuplicates(allMedia));
    const mediaWithInfo = await enrichWithFileInfo(uniqueMedia, downloadHeaders);

    return {
      success: true,
      url: targetUrl,
      mode: 'deep',
      sniffedCount: sniffedMedia.length,
      regexCount: regexMedia.length,
      media: mediaWithInfo
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      url: targetUrl
    };
  }
}

// Combined entry point: try the fast path first; if it comes back empty
// (or the caller explicitly asks for it), fall back to / layer on the deep
// headless-browser scan. This is what the frontend should call by default
// so it gets "all the data" without always paying the headless-browser cost.
async function detectMediaFull(targetUrl, options = {}) {
  const forceDeep = !!options.deep;
  const fast = await detectMedia(targetUrl);

  if (!forceDeep && fast.success && fast.media.length > 0) {
    return fast;
  }

  const deep = await detectMediaDeep(targetUrl, options);

  if (!deep.success) {
    // Deep scan failed (e.g. puppeteer missing) - return whatever the fast
    // path found rather than erroring out completely.
    return fast.success ? fast : deep;
  }

  if (!forceDeep) return deep;

  // forceDeep: merge fast + deep results for maximum coverage
  const merged = markMain(removeDuplicates([...(fast.media || []), ...deep.media]));
  return {
    success: true,
    url: targetUrl,
    mode: 'deep+fast',
    media: merged
  };
}

// Remove duplicate media items
function removeDuplicates(mediaItems) {
  const seen = new Set();
  return mediaItems.filter(item => {
    if (seen.has(item.url)) {
      return false;
    }
    seen.add(item.url);
    return true;
  });
}

module.exports = { detectMedia, detectMediaDeep, detectMediaFull };