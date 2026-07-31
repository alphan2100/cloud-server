/**
 * downloadManager.js
 *
 * Owns all server-side downloads:
 *  - Plain/direct files (http/https, any regular URL) are handed to aria2
 *    over its RPC interface, so we get multi-connection, resumable,
 *    pause/resume-capable downloads for free.
 *  - HLS (.m3u8) / DASH (.mpd) streams can't just be "downloaded" as a
 *    single file - they need to be read/remuxed into one container. For
 *    those we spawn ffmpeg (`-c copy`, no re-encoding) and parse its
 *    `-progress` output to report progress/speed the same way as aria2.
 *
 * Every download gets our own short id (independent of aria2's gid /
 * ffmpeg's pid) so the frontend has one stable handle regardless of engine.
 *
 * All files land in DOWNLOAD_DIR (env: DOWNLOAD_DIR, default ./uploads/temp).
 * Cancelling or failing always cleans up the partial/temp file so nothing
 * accumulates in that folder.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Aria2Client = require('./aria2Client');

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
  ? path.resolve(process.env.DOWNLOAD_DIR)
  : path.resolve(process.env.UPLOADS_DIR || 'uploads', 'temp');

const ARIA2_RPC_URL = process.env.ARIA2_RPC_URL || 'http://localhost:6800/jsonrpc';
const ARIA2_RPC_SECRET = process.env.ARIA2_RPC_SECRET || '';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const aria2 = new Aria2Client({ url: ARIA2_RPC_URL, secret: ARIA2_RPC_SECRET });

// id -> record (in-memory; downloads don't survive a server restart, by design)
const downloads = new Map();

function genId() {
  return crypto.randomBytes(8).toString('hex');
}

function sanitizeFilename(name) {
  const cleaned = (name || 'download')
    .split(/[\\/]/)
    .pop()
    .replace(/[?#].*$/, '')
    .replace(/[\\/?%*:|"<>\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 180);
  return cleaned || 'download';
}

function isStreamingUrl(targetUrl, type) {
  if (type === 'hls' || type === 'dash') return true;
  return /\.m3u8(\?|#|$)/i.test(targetUrl) || /\.mpd(\?|#|$)/i.test(targetUrl);
}

function headersToAria2(headers = {}) {
  const list = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (!v) continue;
    list.push(`${k}: ${v}`);
  }
  return list;
}

function headersToFfmpegArgs(headers = {}) {
  const lines = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (!v) continue;
    lines.push(`${k}: ${v}`);
  }
  if (!lines.length) return [];
  return ['-headers', lines.join('\r\n') + '\r\n'];
}

function baseRecord({ id, url, headers, filename, engine, userId, folderId }) {
  return {
    id,
    engine, // 'aria2' | 'ffmpeg'
    url,
    headers: headers || {},
    filename, // display name
    userId,
    folderId,
    status: 'pending', // pending | active | paused | complete | error | cancelled
    totalBytes: null,
    downloadedBytes: 0,
    speed: 0,
    errorMessage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSampleAt: Date.now(),
    gid: null, // aria2 only
    process: null, // ffmpeg only
    pid: null, // ffmpeg only
    storedName: null, // actual filename on disk
    tempFilePath: null,
    finalFilePath: null,
    duration: null, // ffmpeg only, seconds (from ffmpeg's "Duration:" line)
    currentSeconds: null, // ffmpeg only, current position
    fileResult: null, // result from uploadService.processFile()
    fileId: null,
  };
}

function cleanupTemp(record) {
  const candidates = [record.tempFilePath];
  if (record.engine === 'aria2' && record.tempFilePath) {
    candidates.push(record.tempFilePath + '.aria2'); // aria2's control file
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (e) {
        /* best effort - file may be mid-write, ignore */
      }
    }
  }
}

// ---------------------------------------------------------------- aria2 ---

async function startAria2Download({ url, headers, filename }) {
  const id = genId();
  let baseName;
  try {
    baseName = sanitizeFilename(filename || path.basename(new URL(url).pathname) || 'file');
  } catch (e) {
    baseName = sanitizeFilename(filename || 'file');
  }
  const storedName = `${id}_${baseName}`;

  const record = baseRecord({ id, url, headers, filename: baseName, engine: 'aria2' });
  record.storedName = storedName;
  record.tempFilePath = path.join(DOWNLOAD_DIR, storedName);
  record.finalFilePath = record.tempFilePath;
  downloads.set(id, record);

  try {
    const options = {
      dir: DOWNLOAD_DIR,
      out: storedName,
      'max-connection-per-server': '4',
      'continue': 'true',
      'allow-overwrite': 'true',
    };
    const headerList = headersToAria2(headers);
    if (headerList.length) options.header = headerList;

    const gid = await aria2.addUri([url], options);
    record.gid = gid;
    record.status = 'active';
  } catch (e) {
    record.status = 'error';
    record.errorMessage = 'Failed to start aria2 download: ' + e.message;
  }
  return record;
}

// Some sites intentionally "poison" downloaders: they answer with
// HTTP 200 + a video/audio content-type, but the actual bytes are an
// HTML challenge/login/error page (so a naive downloader thinks it
// succeeded). This peeks the first few hundred bytes of a "complete"
// aria2 download and catches that trick before calling it a success.
function looksLikeHtml(buf) {
  if (!buf || !buf.length) return false;
  const head = buf.toString('utf8', 0, Math.min(400, buf.length)).trim().toLowerCase();
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    (head.includes('<html') && head.includes('<script'))
  );
}

async function validateCompletedAria2File(record) {
  if (record.validated) return;
  record.validated = true;
  try {
    const fd = await fs.promises.open(record.finalFilePath, 'r');
    const buf = Buffer.alloc(512);
    await fd.read(buf, 0, 512, 0);
    await fd.close();
    if (looksLikeHtml(buf)) {
      record.status = 'error';
      record.errorMessage =
        'The server returned an HTML page instead of the real file (expired link, anti-bot block, or login wall) - not an actual media file. Re-scan the page for a fresh link, or Retry.';
      cleanupTemp(record);
    }
  } catch (e) {
    // couldn't read the file to validate - leave it marked complete rather
    // than block on a validation failure
  }
}

async function refreshAria2Status(record) {
  try {
    const status = await aria2.tellStatus(record.gid, [
      'status',
      'totalLength',
      'completedLength',
      'downloadSpeed',
      'errorCode',
      'errorMessage',
    ]);
    record.totalBytes = status.totalLength ? parseInt(status.totalLength, 10) || null : null;
    record.downloadedBytes = status.completedLength ? parseInt(status.completedLength, 10) : 0;
    record.speed = status.downloadSpeed ? parseInt(status.downloadSpeed, 10) : 0;

    if (status.status === 'complete') {
      record.status = 'complete';
      await validateCompletedAria2File(record);
    } else if (status.status === 'error') {
      record.status = 'error';
      record.errorMessage = status.errorMessage || `aria2 error (code ${status.errorCode})`;
    } else if (status.status === 'paused') {
      record.status = 'paused';
    } else if (status.status === 'removed') {
      if (record.status !== 'cancelled') record.status = 'cancelled';
    } else if (record.status !== 'paused') {
      record.status = 'active';
    }
    record.updatedAt = Date.now();
  } catch (e) {
    // gid unknown to aria2 (e.g. after removeDownloadResult) - keep last known state
  }
}

// --------------------------------------------------------------- ffmpeg ---

function ffmpegOutName(baseName) {
  if (/\.(mp4|mkv|mov|ts|m4a|mp3|aac)$/i.test(baseName)) return baseName;
  return baseName.replace(/\.[^./]*$/, '') + '.mp4';
}

function startFfmpegDownload({ url, headers, filename }) {
  const id = genId();
  const rawName = sanitizeFilename(filename || 'stream');
  const outName = ffmpegOutName(rawName);
  const storedName = `${id}_${outName}`;
  const tempPath = path.join(DOWNLOAD_DIR, `.part_${storedName}`);
  const finalPath = path.join(DOWNLOAD_DIR, storedName);

  const record = baseRecord({ id, url, headers, filename: outName, engine: 'ffmpeg' });
  record.storedName = storedName;
  record.tempFilePath = tempPath;
  record.finalFilePath = finalPath;
  downloads.set(id, record);

  const args = [
    '-y',
    ...headersToFfmpegArgs(headers),
    '-i',
    url,
    '-c',
    'copy',
    '-progress',
    'pipe:1',
    '-nostats',
    '-loglevel',
    'error',
    tempPath,
  ];

  let child;
  try {
    child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    record.status = 'error';
    record.errorMessage =
      'Failed to launch ffmpeg: ' + e.message + ' (is ffmpeg installed and on PATH? set FFMPEG_PATH env var otherwise)';
    return record;
  }

  record.process = child;
  record.pid = child.pid;
  record.status = 'active';

  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    if (!record.duration) {
      const durMatch = stderrBuf.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (durMatch) {
        record.duration = (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + parseFloat(durMatch[3]);
      }
    }
    // Keep the buffer from growing unbounded on long-running streams
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
  });

  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // keep the (possibly partial) last line for next chunk

    let outTimeSec = null;
    let sizeBytes = null;

    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();

      if (k === 'out_time_ms' || k === 'out_time_us') {
        const n = parseInt(v, 10);
        if (!isNaN(n)) outTimeSec = n / 1000000;
      } else if (k === 'out_time') {
        const m = v.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) outTimeSec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      } else if (k === 'total_size') {
        const n = parseInt(v, 10);
        if (!isNaN(n)) sizeBytes = n;
      }
    }

    if (sizeBytes !== null) {
      const now = Date.now();
      const dtSec = (now - record.lastSampleAt) / 1000;
      if (dtSec > 0) {
        record.speed = Math.max(0, (sizeBytes - record.downloadedBytes) / dtSec);
      }
      record.downloadedBytes = sizeBytes;
      record.lastSampleAt = now;
    }
    if (outTimeSec !== null) record.currentSeconds = outTimeSec;

    // Estimate total size from (bytes so far / seconds so far) * total duration,
    // so the UI can show a real progress bar instead of just "processing...".
    if (record.duration && record.currentSeconds && record.currentSeconds > 0.5 && record.downloadedBytes) {
      record.totalBytes = Math.round(record.downloadedBytes * (record.duration / record.currentSeconds));
    }

    record.updatedAt = Date.now();
  });

  child.on('close', (code, signal) => {
    record.updatedAt = Date.now();
    if (record.status === 'cancelled') {
      cleanupTemp(record);
      return;
    }
    if (code === 0) {
      try {
        if (fs.existsSync(record.tempFilePath)) {
          fs.renameSync(record.tempFilePath, record.finalFilePath);
        }
        record.status = 'complete';
        if (record.totalBytes) record.downloadedBytes = record.totalBytes;
      } catch (e) {
        record.status = 'error';
        record.errorMessage = 'ffmpeg finished but the output file could not be finalized: ' + e.message;
        cleanupTemp(record);
      }
    } else if (record.status !== 'paused') {
      record.status = 'error';
      record.errorMessage = `ffmpeg exited with code ${code}${signal ? ' (signal ' + signal + ')' : ''}`;
      cleanupTemp(record);
    }
  });

  child.on('error', (e) => {
    record.status = 'error';
    record.errorMessage = 'ffmpeg process error: ' + e.message;
    cleanupTemp(record);
  });

  return record;
}

/**
 * Start ffmpeg download with multiple input URLs (for merging video+audio)
 * @param {Object} params
 * @param {string[]} params.urls - Array of URLs to merge [videoUrl, audioUrl]
 * @param {Object} [params.headers] - HTTP headers
 * @param {string} params.filename - Output filename
 * @returns {Object} download record
 */
function startFfmpegMergeDownload({ urls, headers, filename }) {
  if (!urls || !Array.isArray(urls) || urls.length < 2) {
    throw new Error('startFfmpegMergeDownload requires at least 2 URLs (video + audio)');
  }

  const id = genId();
  const rawName = sanitizeFilename(filename || 'merged_stream');
  const outName = ffmpegOutName(rawName);
  const storedName = `${id}_${outName}`;
  const tempPath = path.join(DOWNLOAD_DIR, `.part_${storedName}`);
  const finalPath = path.join(DOWNLOAD_DIR, storedName);

  const record = baseRecord({ id, url: urls[0], headers, filename: outName, engine: 'ffmpeg' });
  record.storedName = storedName;
  record.tempFilePath = tempPath;
  record.finalFilePath = finalPath;
  record.mergedUrls = urls; // Store all URLs for reference
  downloads.set(id, record);

  // Build ffmpeg args with multiple -i inputs
  const args = [
    '-y',
    ...headersToFfmpegArgs(headers),
  ];

  // Add each URL as a separate input
  for (const url of urls) {
    args.push('-i', url);
  }

  // Merge all inputs with stream copy (no re-encoding)
  args.push(
    '-c', 'copy',
    '-progress', 'pipe:1',
    '-nostats',
    '-loglevel', 'error',
    tempPath
  );

  let child;
  try {
    child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    record.status = 'error';
    record.errorMessage =
      'Failed to launch ffmpeg: ' + e.message + ' (is ffmpeg installed and on PATH? set FFMPEG_PATH env var otherwise)';
    return record;
  }

  record.process = child;
  record.pid = child.pid;
  record.status = 'active';

  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    if (!record.duration) {
      const durMatch = stderrBuf.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (durMatch) {
        record.duration = (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + parseFloat(durMatch[3]);
      }
    }
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
  });

  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();

    let outTimeSec = null;
    let sizeBytes = null;

    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();

      if (k === 'out_time_ms' || k === 'out_time_us') {
        const n = parseInt(v, 10);
        if (!isNaN(n)) outTimeSec = n / 1000000;
      } else if (k === 'out_time') {
        const m = v.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) outTimeSec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      } else if (k === 'total_size') {
        const n = parseInt(v, 10);
        if (!isNaN(n)) sizeBytes = n;
      }
    }

    if (sizeBytes !== null) {
      const now = Date.now();
      const dtSec = (now - record.lastSampleAt) / 1000;
      if (dtSec > 0) {
        record.speed = Math.max(0, (sizeBytes - record.downloadedBytes) / dtSec);
      }
      record.downloadedBytes = sizeBytes;
      record.lastSampleAt = now;
    }
    if (outTimeSec !== null) record.currentSeconds = outTimeSec;

    if (record.duration && record.currentSeconds && record.currentSeconds > 0.5 && record.downloadedBytes) {
      record.totalBytes = Math.round(record.downloadedBytes * (record.duration / record.currentSeconds));
    }

    record.updatedAt = Date.now();
  });

  child.on('close', (code, signal) => {
    record.updatedAt = Date.now();
    if (record.status === 'cancelled') {
      cleanupTemp(record);
      return;
    }
    if (code === 0) {
      try {
        if (fs.existsSync(record.tempFilePath)) {
          fs.renameSync(record.tempFilePath, record.finalFilePath);
        }
        record.status = 'complete';
        if (record.totalBytes) record.downloadedBytes = record.totalBytes;
      } catch (e) {
        record.status = 'error';
        record.errorMessage = 'ffmpeg finished but the output file could not be finalized: ' + e.message;
        cleanupTemp(record);
      }
    } else if (record.status !== 'paused') {
      record.status = 'error';
      record.errorMessage = `ffmpeg exited with code ${code}${signal ? ' (signal ' + signal + ')' : ''}`;
      cleanupTemp(record);
    }
  });

  child.on('error', (e) => {
    record.status = 'error';
    record.errorMessage = 'ffmpeg process error: ' + e.message;
    cleanupTemp(record);
  });

  return record;
}

// -------------------------------------------------------------- shared ---

async function startDownload({ url, headers, filename, type, userId, folderId }) {
  if (!url) throw new Error('url is required');
  
  let record;
  if (isStreamingUrl(url, type)) {
    record = startFfmpegDownload({ url, headers, filename });
  } else {
    record = await startAria2Download({ url, headers, filename });
  }
  
  // Attach user info
  record.userId = userId;
  record.folderId = folderId;
  
  return record;
}

function serialize(record) {
  return {
    id: record.id,
    engine: record.engine,
    url: record.url,
    filename: record.filename,
    status: record.status,
    totalBytes: record.totalBytes,
    downloadedBytes: record.downloadedBytes,
    speed: record.speed,
    errorMessage: record.errorMessage,
    canPause: record.engine === 'aria2',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    userId: record.userId,
    folderId: record.folderId,
    fileId: record.fileId,
    fileResult: record.fileResult,
  };
}

async function getStatus(id) {
  const record = downloads.get(id);
  if (!record) return null;
  if (record.engine === 'aria2' && record.gid && !['complete', 'cancelled'].includes(record.status)) {
    await refreshAria2Status(record);
  }
  return serialize(record);
}

async function listStatuses() {
  const ids = Array.from(downloads.keys());
  const results = await Promise.all(ids.map((id) => getStatus(id)));
  return results.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

async function pauseDownload(id) {
  const record = downloads.get(id);
  if (!record) throw new Error('Download not found');

  if (record.engine === 'aria2') {
    if (!record.gid) throw new Error('This download has no active aria2 task to pause');
    await aria2.pause(record.gid);
    record.status = 'paused';
    return serialize(record);
  }

  // ffmpeg: best-effort pause via SIGSTOP (Unix only)
  if (!record.pid) throw new Error('No running ffmpeg process to pause');
  try {
    process.kill(record.pid, 'SIGSTOP');
    record.status = 'paused';
  } catch (e) {
    throw new Error('Pause is not supported on this platform for streaming (ffmpeg) downloads: ' + e.message);
  }
  return serialize(record);
}

async function resumeDownload(id) {
  const record = downloads.get(id);
  if (!record) throw new Error('Download not found');

  if (record.engine === 'aria2') {
    if (!record.gid) throw new Error('This download has no active aria2 task to resume');
    await aria2.unpause(record.gid);
    record.status = 'active';
    return serialize(record);
  }

  if (!record.pid) throw new Error('No running ffmpeg process to resume');
  try {
    process.kill(record.pid, 'SIGCONT');
    record.status = 'active';
  } catch (e) {
    throw new Error('Resume is not supported on this platform for streaming (ffmpeg) downloads: ' + e.message);
  }
  return serialize(record);
}

async function cancelDownload(id) {
  const record = downloads.get(id);
  if (!record) throw new Error('Download not found');

  record.status = 'cancelled';

  if (record.engine === 'aria2' && record.gid) {
    try {
      await aria2.forceRemove(record.gid);
    } catch (e) {
      /* already gone / not active - fine */
    }
    try {
      await aria2.removeDownloadResult(record.gid);
    } catch (e) {
      /* ignore */
    }
    cleanupTemp(record);
  }

  if (record.engine === 'ffmpeg' && record.process) {
    try {
      // in case it was SIGSTOP-paused, un-stick it before killing so it
      // actually exits instead of sitting there stopped forever
      if (record.pid) {
        try {
          process.kill(record.pid, 'SIGCONT');
        } catch (e) {}
      }
      record.process.kill('SIGKILL');
    } catch (e) {
      /* ignore */
    }
    cleanupTemp(record);
  }

  return serialize(record);
}

async function retryDownload(id, overrides = {}) {
  const old = downloads.get(id);
  if (!old) throw new Error('Download not found');
  if (!['error', 'cancelled'].includes(old.status)) {
    throw new Error('Only failed or cancelled downloads can be retried');
  }

  cleanupTemp(old);
  downloads.delete(id);

  const fresh = await startDownload({
    url: overrides.url || old.url,
    headers: overrides.headers || old.headers,
    filename: overrides.filename || old.filename,
    type: overrides.type || (old.engine === 'ffmpeg' ? 'hls' : undefined),
    userId: overrides.userId || old.userId,
    folderId: overrides.folderId || old.folderId,
  });
  return serialize(fresh);
}

function forgetDownload(id) {
  const record = downloads.get(id);
  if (!record) return { removed: false };
  if (record.status === 'active' || record.status === 'paused') {
    throw new Error('Cancel this download before removing it from the list');
  }
  // Cleanup temp file if it still exists (for safety)
  cleanupTemp(record);
  downloads.delete(id);
  return { removed: true };
}

function getFinalFilePath(id) {
  const record = downloads.get(id);
  if (!record || record.status !== 'complete') return null;
  if (!fs.existsSync(record.finalFilePath)) return null;
  return { path: record.finalFilePath, filename: record.filename };
}

function getRecord(id) {
  return downloads.get(id);
}

function updateRecord(id, updates) {
  const record = downloads.get(id);
  if (!record) return;
  Object.assign(record, updates);
}

module.exports = {
  DOWNLOAD_DIR,
  startDownload,
  startFfmpegMergeDownload,
  getStatus,
  listStatuses,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  retryDownload,
  forgetDownload,
  getFinalFilePath,
  getRecord,
  updateRecord,
};
