/**
 * browserDetector.js
 *
 * "Option A" implementation: headless-browser based media detection.
 *
 * This is the piece that closes the gap with IDM / 1DM(P):
 * instead of only regex-scanning the raw HTML response (which misses
 * anything injected by JS - React/Vue/Next.js apps, players that build
 * their <video> tag at runtime, XHR/fetch-loaded manifests, etc.), we
 * actually load the page in a real Chromium instance and watch the
 * network traffic go by, exactly like a browser extension sniffer does.
 *
 * What this module adds on top of the old regex-only detector:
 *  1. Full JS execution -> SPA / dynamically injected players are visible.
 *  2. Network-level sniffing (CDP Network domain) -> catches ANY request
 *     with a media content-type or media-like extension, no matter which
 *     player library loaded it or how obfuscated the source JS is.
 *  3. Auto-play / auto-click nudging -> some players only fire the real
 *     media request once playback starts, so we try to nudge that along.
 *  4. Captures the exact request headers (Referer/Origin/User-Agent) and
 *     cookies used to load each resource, which the caller needs later to
 *     actually download the file without hitting a 403 from the CDN.
 *  5. HLS/DASH manifest expansion -> fetches the manifest text and parses
 *     out the actual quality variants (bitrate/resolution) instead of
 *     just returning the master playlist URL.
 *  6. Also hands back the fully-rendered HTML so the existing regex
 *     detectors in mediaDetector.js can run against POST-JS markup
 *     instead of the raw server response.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  puppeteer = null;
}

// Locates an already-installed Chrome/Chromium/Edge binary on the current
// machine so we don't need puppeteer to download its own ~200MB Chromium.
// Checked in order: CHROME_PATH env var -> common install locations per OS.
function findChromeExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const platform = os.platform();
  let candidates = [];

  if (platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';
    candidates = [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Chromium\\Application\\chrome.exe`
    ];
  } else if (platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
    ];
  } else {
    // linux and other unix-likes
    candidates = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium'
    ];
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const MEDIA_CONTENT_TYPE_PATTERNS = [
  /^video\//i,
  /^audio\//i,
  /application\/vnd\.apple\.mpegurl/i,
  /application\/x-mpegurl/i,
  /application\/dash\+xml/i,
  /application\/x-mpegts/i,
  /vnd\.dlna\.mpeg-tts/i,
];

const MEDIA_EXTENSION_REGEX =
  /\.(mp4|m4v|webm|mkv|avi|mov|flv|wmv|mp3|wav|aac|flac|m4a|ogg|opus|m3u8|m3u|mpd|ts)(\?|#|$)/i;

const SEGMENT_EXTENSION_REGEX = /\.(ts|m4s|aac)(\?|#|$)/i;

function classifyType(urlStr, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('mpegurl') || urlStr.match(/\.m3u8(\?|#|$)/i)) return 'hls';
  if (ct.includes('dash+xml') || urlStr.match(/\.mpd(\?|#|$)/i)) return 'dash';
  if (ct.startsWith('video/') || urlStr.match(/\.(mp4|m4v|webm|mkv|avi|mov|flv|wmv)(\?|#|$)/i)) return 'video';
  if (ct.startsWith('audio/') || urlStr.match(/\.(mp3|wav|aac|flac|m4a|ogg|opus)(\?|#|$)/i)) return 'audio';
  if (urlStr.match(SEGMENT_EXTENSION_REGEX)) return 'segment';
  return 'unknown';
}

function isMediaResponse(urlStr, contentType, resourceType) {
  if (urlStr.startsWith('data:') || urlStr.startsWith('blob:')) return false;

  const ct = (contentType || '').toLowerCase();
  if (MEDIA_CONTENT_TYPE_PATTERNS.some((re) => re.test(ct))) return true;
  if (MEDIA_EXTENSION_REGEX.test(urlStr)) return true;

  // Chrome/CDP labels media requests initiated by <video>/<audio> elements
  // as resourceType 'media' regardless of content-type header correctness.
  if (resourceType === 'Media') return true;

  return false;
}

function simpleGet(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(e);
    }
    const proto = parsed.protocol === 'https:' ? https : http;
    const req = proto.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ body: data, statusCode: res.statusCode, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

// Parses an HLS master playlist and returns per-quality variant streams.
async function parseHlsVariants(masterUrl, extraHeaders = {}) {
  try {
    const { body, statusCode } = await simpleGet(masterUrl, extraHeaders);
    if (statusCode >= 400 || !body.includes('#EXTM3U')) return [];

    const lines = body.split('\n').map((l) => l.trim());
    const variants = [];
    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const attrLine = lines[i];
        const uriLine = lines[i + 1];
        if (!uriLine || uriLine.startsWith('#')) continue;

        const bandwidthMatch = attrLine.match(/BANDWIDTH=(\d+)/);
        const resolutionMatch = attrLine.match(/RESOLUTION=(\d+x\d+)/);
        const codecsMatch = attrLine.match(/CODECS="([^"]+)"/);

        let variantUrl = uriLine;
        if (!/^https?:\/\//i.test(variantUrl)) {
          variantUrl = variantUrl.startsWith('/')
            ? new URL(variantUrl, masterUrl).toString()
            : baseUrl + variantUrl;
        }

        variants.push({
          url: variantUrl,
          bandwidth: bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : null,
          resolution: resolutionMatch ? resolutionMatch[1] : null,
          codecs: codecsMatch ? codecsMatch[1] : null,
        });
      }
    }

    // Sort best quality first (by resolution height, fallback to bandwidth)
    variants.sort((a, b) => {
      const heightOf = (v) => (v.resolution ? parseInt(v.resolution.split('x')[1], 10) : 0);
      return heightOf(b) - heightOf(a) || (b.bandwidth || 0) - (a.bandwidth || 0);
    });

    return variants;
  } catch (e) {
    return [];
  }
}

// Best-effort nudge to get players to actually fire their media request:
// mute + play any <video>/<audio>, and click common "play" button selectors.
async function nudgePlayback(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll('video, audio').forEach((el) => {
        try {
          el.muted = true;
          el.autoplay = true;
          const p = el.play();
          if (p && p.catch) p.catch(() => {});
        } catch (e) {}
      });

      const playSelectors = [
        '.vjs-big-play-button',
        '.jw-icon-playback',
        '.jw-display-icon-container',
        '.plyr__control--overlaid',
        '.play-button',
        '[class*="play-btn"]',
        '[aria-label="Play"]',
      ];
      playSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((btn) => {
          try {
            btn.click();
          } catch (e) {}
        });
      });
    });
  } catch (e) {
    /* page may have navigated away, ignore */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Loads targetUrl in headless Chromium, sniffs the network, and returns:
 *  - media: array of captured media network responses (deduped)
 *  - renderedHtml: page.content() after JS execution + nudge, for the
 *    existing regex detectors to re-scan
 *  - cookieHeader: cookie string to reuse for follow-up requests
 *  - pageHeaders: { referer, origin, userAgent } to reuse for downloads
 */
async function sniffWithBrowser(targetUrl, options = {}) {
  if (!puppeteer) {
    throw new Error(
      "puppeteer-core is not installed. Run 'npm install puppeteer-core' in the project folder to enable Option A (headless browser detection)."
    );
  }

  const executablePath = options.executablePath || findChromeExecutable();
  if (!executablePath) {
    throw new Error(
      'Could not find an installed Chrome/Chromium/Edge on this machine. Install Google Chrome, or set the CHROME_PATH environment variable to your browser executable path.'
    );
  }

  const timeoutMs = options.timeoutMs || 25000;
  const settleMs = options.settleMs || 3500;

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const capturedMedia = new Map(); // url -> item
  const requestMeta = new Map(); // url -> {referer, origin, userAgent}
  let pageHeaders = { referer: targetUrl, origin: null, userAgent: null };
  let cookieHeader = '';
  let renderedHtml = '';

  try {
    const page = await browser.newPage();
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
    await page.setUserAgent(ua);
    await page.setViewport({ width: 1366, height: 800 });
    await page.setRequestInterception(false);

    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    client.on('Network.requestWillBeSent', (event) => {
      const req = event.request;
      requestMeta.set(req.url, {
        referer: (req.headers && (req.headers['Referer'] || req.headers['referer'])) || targetUrl,
        origin: (req.headers && (req.headers['Origin'] || req.headers['origin'])) || null,
        userAgent: ua,
      });
    });

    client.on('Network.responseReceived', (event) => {
      try {
        const { response, type } = event;
        const respUrl = response.url;
        const contentType =
          response.headers['content-type'] || response.headers['Content-Type'] || '';

        if (isMediaResponse(respUrl, contentType, type)) {
          if (!capturedMedia.has(respUrl)) {
            const meta = requestMeta.get(respUrl) || {};
            capturedMedia.set(respUrl, {
              url: respUrl,
              mimeType: contentType || null,
              type: classifyType(respUrl, contentType),
              status: response.status,
              source: 'Network Sniffing',
              referer: meta.referer || targetUrl,
              origin: meta.origin || null,
              userAgent: ua,
            });
          }
        }
      } catch (e) {
        /* ignore malformed events */
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: timeoutMs });
    } catch (navErr) {
      // Some pages never go fully idle (live streams, ads, analytics beacons).
      // We still proceed with whatever loaded so far.
    }

    await nudgePlayback(page);
    await sleep(settleMs);
    // second nudge in case the first click revealed a nested player/iframe
    await nudgePlayback(page);
    await sleep(1200);

    renderedHtml = await page.content();

    const cookies = await page.cookies();
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    pageHeaders = {
      referer: targetUrl,
      origin: (() => {
        try {
          const u = new URL(targetUrl);
          return `${u.protocol}//${u.hostname}`;
        } catch (e) {
          return null;
        }
      })(),
      userAgent: ua,
    };

    // Also sniff inside same-origin iframes (common for embedded players)
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameHtml = await frame.content();
        renderedHtml += '\n<!-- IFRAME:' + frame.url() + ' -->\n' + frameHtml;
      } catch (e) {
        /* cross-origin frame content is inaccessible, that's fine - the
           network sniffer above still captures its requests */
      }
    }
  } finally {
    await browser.close();
  }

  // Expand HLS master playlists into their real quality variants.
  const media = Array.from(capturedMedia.values());
  for (const item of media) {
    if (item.type === 'hls') {
      const extraHeaders = {};
      if (item.referer) extraHeaders['Referer'] = item.referer;
      if (cookieHeader) extraHeaders['Cookie'] = cookieHeader;
      const variants = await parseHlsVariants(item.url, extraHeaders);
      if (variants.length) item.qualities = variants;
    }
  }

  // Drop raw segment chunks (.ts/.m4s) - they're not something a user
  // wants to "download" individually, they're noise from HLS/DASH playback.
  const filteredMedia = media.filter((m) => m.type !== 'segment');

  return {
    media: filteredMedia,
    renderedHtml,
    cookieHeader,
    pageHeaders,
  };
}

module.exports = {
  sniffWithBrowser,
  parseHlsVariants,
  isMediaResponse,
  classifyType,
  findChromeExecutable,
  isPuppeteerAvailable: () => !!puppeteer,
  isChromeAvailable: () => !!findChromeExecutable(),
};
