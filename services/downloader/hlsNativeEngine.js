const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { fetch } = require('undici');
const { parseHlsManifest } = require('./hlsParser');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: '*/*',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHeaders(headers = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries({ ...DEFAULT_HEADERS, ...headers })) {
    if (value === undefined || value === null || value === '') continue;
    cleaned[key] = String(value);
  }
  return cleaned;
}

function withRange(headers, byteRange) {
  if (!byteRange || !byteRange.length) return headers;
  const start = byteRange.offset || 0;
  const end = start + byteRange.length - 1;
  return { ...headers, Range: `bytes=${start}-${end}` };
}

async function fetchBuffer(url, headers, signal, byteRange = null) {
  const response = await fetch(url, {
    headers: withRange(headers, byteRange),
    redirect: 'follow',
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchText(url, headers, signal) {
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching manifest`);
  }
  return response.text();
}

async function fetchWithRetry(fn, retries, onRetry) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      if (onRetry) onRetry(error, attempt + 1);
      await sleep(500 + attempt * 500);
    }
  }
  throw lastError;
}

function decryptAes128(buffer, keyBuffer, iv) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuffer, iv);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

function chooseVariant(variants, quality) {
  if (!variants.length) return null;
  if (quality === 'lowest') return variants[variants.length - 1];
  const index = Number.isInteger(quality) ? quality : parseInt(quality, 10);
  if (!Number.isNaN(index) && variants[index]) return variants[index];
  return variants[0];
}

async function resolveMediaPlaylist(url, headers, signal, quality) {
  let currentUrl = url;
  let manifestText = await fetchText(currentUrl, headers, signal);
  let manifest = parseHlsManifest(manifestText, currentUrl);

  if (manifest.type === 'master') {
    const variant = chooseVariant(manifest.variants, quality);
    if (!variant) throw new Error('No playable HLS variant found');
    currentUrl = variant.url;
    manifestText = await fetchText(currentUrl, headers, signal);
    manifest = parseHlsManifest(manifestText, currentUrl);
    manifest.selectedVariant = variant;
  }

  if (!manifest.segments.length) {
    throw new Error('No HLS segments found');
  }

  return { manifest, mediaUrl: currentUrl };
}

function remuxWithFfmpeg({ inputPath, outputPath, ffmpegPath, signal, record }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i',
      inputPath,
      '-c',
      'copy',
      '-map',
      '0',
      '-ignore_unknown',
      '-loglevel',
      'error',
      outputPath,
    ];

    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    record.process = child;
    record.pid = child.pid;

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });

    const abort = () => {
      try {
        child.kill('SIGKILL');
      } catch (e) {
        /* ignore */
      }
    };
    signal.addEventListener('abort', abort, { once: true });

    child.on('error', (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });

    child.on('close', (code, signalName) => {
      signal.removeEventListener('abort', abort);
      if (record.status === 'cancelled') return resolve();
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg remux failed with code ${code}${signalName ? ` (${signalName})` : ''}: ${stderr.trim()}`));
    });
  });
}

async function appendFile(handle, buffer) {
  await handle.write(buffer);
}

async function downloadHlsNative({
  url,
  headers = {},
  tempTsPath,
  finalPath,
  keepTsPath = null,
  ffmpegPath,
  record,
  quality = null,
  retries = 8,
}) {
  const controller = new AbortController();
  record.abortController = controller;

  const requestHeaders = normalizeHeaders(headers);
  let fileHandle = null;
  const keyCache = new Map();
  const startedAt = Date.now();

  try {
    record.status = 'active';
    record.phase = 'parsing';
    record.updatedAt = Date.now();

    const { manifest, mediaUrl } = await resolveMediaPlaylist(url, requestHeaders, controller.signal, quality);
    record.mediaUrl = mediaUrl;
    record.totalSegments = manifest.segments.length;
    record.completedSegments = 0;
    record.duration = manifest.duration || null;
    record.totalBytes = manifest.segments.length;
    record.downloadedBytes = 0;
    record.selectedVariant = manifest.selectedVariant || null;
    record.phase = 'downloading';
    record.updatedAt = Date.now();

    fileHandle = await fs.promises.open(tempTsPath, 'w');

    let wroteInitMap = false;
    for (let i = 0; i < manifest.segments.length; i += 1) {
      if (record.status === 'cancelled' || controller.signal.aborted) {
        throw new Error('Download cancelled');
      }

      const segment = manifest.segments[i];
      if (segment.initMap && !wroteInitMap) {
        const initBuffer = await fetchWithRetry(
          () => fetchBuffer(segment.initMap.url, requestHeaders, controller.signal),
          retries,
          (error, attempt) => {
            record.errorMessage = `Retrying init segment (${attempt}/${retries}): ${error.message}`;
            record.updatedAt = Date.now();
          }
        );
        await appendFile(fileHandle, initBuffer);
        record.fetchedBytes = (record.fetchedBytes || 0) + initBuffer.length;
        wroteInitMap = true;
      }

      let segmentBuffer = await fetchWithRetry(
        () => fetchBuffer(segment.url, requestHeaders, controller.signal, segment.byteRange),
        retries,
        (error, attempt) => {
          record.errorMessage = `Retrying segment ${i + 1}/${manifest.segments.length} (${attempt}/${retries}): ${error.message}`;
          record.updatedAt = Date.now();
        }
      );

      if (segment.key) {
        if (segment.key.method !== 'AES-128') {
          throw new Error(`Unsupported HLS encryption method: ${segment.key.method}`);
        }
        if (!segment.key.url) {
          throw new Error('Encrypted HLS segment is missing key URI');
        }
        let keyBuffer = keyCache.get(segment.key.url);
        if (!keyBuffer) {
          keyBuffer = await fetchWithRetry(
            () => fetchBuffer(segment.key.url, requestHeaders, controller.signal),
            retries,
            (error, attempt) => {
              record.errorMessage = `Retrying key fetch (${attempt}/${retries}): ${error.message}`;
              record.updatedAt = Date.now();
            }
          );
          keyCache.set(segment.key.url, keyBuffer);
        }
        segmentBuffer = decryptAes128(segmentBuffer, keyBuffer, segment.key.iv);
      }

      await appendFile(fileHandle, segmentBuffer);

      const now = Date.now();
      const previousBytes = record.fetchedBytes || 0;
      record.fetchedBytes = previousBytes + segmentBuffer.length;
      record.completedSegments = i + 1;
      record.downloadedBytes = i + 1;
      record.totalBytes = manifest.segments.length;
      const elapsed = Math.max(0.001, (now - startedAt) / 1000);
      record.speed = Math.round(record.fetchedBytes / elapsed);
      record.errorMessage = null;
      record.updatedAt = now;
    }

    await fileHandle.close();
    fileHandle = null;

    if (keepTsPath) {
      await fs.promises.rename(tempTsPath, finalPath);
    } else {
      record.phase = 'remuxing';
      record.updatedAt = Date.now();
      await remuxWithFfmpeg({
        inputPath: tempTsPath,
        outputPath: finalPath,
        ffmpegPath,
        signal: controller.signal,
        record,
      });
      try {
        await fs.promises.unlink(tempTsPath);
      } catch (e) {
        /* best effort */
      }
    }

    if (record.status !== 'cancelled') {
      const stats = await fs.promises.stat(finalPath);
      record.status = 'complete';
      record.phase = 'complete';
      record.totalBytes = manifest.segments.length;
      record.downloadedBytes = manifest.segments.length;
      record.fileSize = stats.size;
      record.speed = 0;
      record.updatedAt = Date.now();
    }
  } catch (error) {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch (e) {
        /* ignore */
      }
    }
    if (record.status === 'cancelled' || controller.signal.aborted) {
      record.status = 'cancelled';
    } else {
      record.status = 'error';
      record.errorMessage = error.message;
    }
    record.updatedAt = Date.now();
    for (const candidate of [tempTsPath, finalPath]) {
      try {
        if (candidate && fs.existsSync(candidate)) await fs.promises.unlink(candidate);
      } catch (e) {
        /* best effort */
      }
    }
  } finally {
    record.abortController = null;
    record.process = null;
    record.pid = null;
  }
}

module.exports = {
  downloadHlsNative,
};
