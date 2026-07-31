const http = require('http');
const https = require('https');

function formatFileSize(bytes) {
  if (!bytes) return 'Unknown';
  
  const size = parseInt(bytes);
  
  if (isNaN(size)) return 'Unknown';
  
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  let sizeNum = size;
  let unitIndex = 0;
  
  while (sizeNum >= 1024 && unitIndex < units.length - 1) {
    sizeNum /= 1024;
    unitIndex++;
  }
  
  return `${sizeNum.toFixed(2)} ${units[unitIndex]}`;
}

function getFilenameFromHeaders(headers, pathname) {
  const contentDisposition = headers['content-disposition'];
  
  if (contentDisposition) {
    const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (filenameMatch && filenameMatch[1]) {
      return filenameMatch[1].replace(/['"]/g, '');
    }
  }
  
  const pathParts = pathname.split('/');
  const filename = pathParts[pathParts.length - 1];
  return filename || 'unknown';
}

function getMimeType(headers) {
  return headers['content-type'] || 'application/octet-stream';
}

// Strips "; charset=..." etc so comparisons like `=== 'text/html'` actually
// work against real-world headers such as "text/html; charset=utf-8".
function baseMimeType(mimeType) {
  return (mimeType || '').split(';')[0].trim().toLowerCase();
}

function checkResumeCapability(headers) {
  const acceptRanges = headers['accept-ranges'];
  return !!(acceptRanges && acceptRanges.toLowerCase() === 'bytes');
}

function getMimeTypeFromExtension(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const mimeTypes = {
    'zip': 'application/zip',
    'rar': 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    'iso': 'application/x-iso9660-image',
    'apk': 'application/vnd.android.package-archive',
    'exe': 'application/x-msdownload',
    'pdf': 'application/pdf',
    'mp4': 'video/mp4',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'avi': 'video/x-msvideo',
    'mkv': 'video/x-matroska',
    'mov': 'video/quicktime',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function parseContentRange(headers) {
  const cr = headers && (headers['content-range'] || headers['Content-Range']);
  if (!cr) return null;
  const m = String(cr).match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!m) return null;
  return {
    start: parseInt(m[1], 10),
    end: parseInt(m[2], 10),
    total: m[3] === '*' ? null : parseInt(m[3], 10)
  };
}

function requestOnce(targetUrl, method, extraHeaders, useRange) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(e);
    }
    const protocol = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...extraHeaders
    };
    if (useRange) headers['Range'] = 'bytes=0-4095';

    const request = protocol.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method,
        headers
      },
      (response) => resolve(response)
    );

    request.on('error', reject);
    request.setTimeout(20000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
    request.end();
  });
}

async function requestWithRedirects(targetUrl, method, extraHeaders, useRange, maxRedirects = 6) {
  let currentUrl = targetUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    const response = await requestOnce(currentUrl, method, extraHeaders, useRange);
    const status = response.statusCode;
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      const nextUrl = new URL(response.headers.location, currentUrl).toString();
      response.resume();
      currentUrl = nextUrl;
      continue;
    }
    return { response, finalUrl: currentUrl };
  }
  throw new Error('Too many redirects');
}

function peekBody(response, maxBytes = 4096) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { response.destroy(); } catch (e) { /* already closed */ }
      resolve(Buffer.concat(chunks));
    };
    response.on('data', (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) finish();
    });
    response.on('end', finish);
    response.on('error', finish);
  });
}

function looksLikeHtmlBuffer(buf) {
  if (!buf || !buf.length) return false;
  const head = buf.toString('utf8', 0, Math.min(300, buf.length)).trim().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') || (head.startsWith('<?xml') && head.includes('<html'));
}

async function fetchAccurateFileInfo(targetUrl, extraHeaders = {}) {
  let headResponse = null;
  let headFinalUrl = targetUrl;
  try {
    const { response, finalUrl } = await requestWithRedirects(targetUrl, 'HEAD', extraHeaders, false);
    response.resume();
    headResponse = response;
    headFinalUrl = finalUrl;
  } catch (e) {
    headResponse = null;
  }

  const headMimeBase = headResponse ? baseMimeType(getMimeType(headResponse.headers)) : null;
  const headHasLength = !!(headResponse && headResponse.headers['content-length'] !== undefined);
  const headTrustworthy =
    !!headResponse &&
    headResponse.statusCode >= 200 && headResponse.statusCode < 300 &&
    headMimeBase !== 'text/html' &&
    headHasLength;

  let finalStatus = 0;
  let finalHeaders = {};
  let finalUrlUsed = targetUrl;
  let bodyPeek = null;
  let sizeBytes = null;
  let resumeCapable = false;
  let isSizeReliable = false;

  if (headTrustworthy) {
    finalStatus = headResponse.statusCode;
    finalHeaders = headResponse.headers;
    finalUrlUsed = headFinalUrl;
    sizeBytes = parseInt(headResponse.headers['content-length'], 10);
    resumeCapable = checkResumeCapability(headResponse.headers);
    isSizeReliable = true;
  } else {
    try {
      const { response, finalUrl } = await requestWithRedirects(targetUrl, 'GET', extraHeaders, true);
      bodyPeek = await peekBody(response, 4096);
      finalStatus = response.statusCode;
      finalHeaders = response.headers;
      finalUrlUsed = finalUrl;

      if (finalStatus === 206) {
        const range = parseContentRange(finalHeaders);
        if (range && range.total) {
          sizeBytes = range.total;
          isSizeReliable = true;
        }
        resumeCapable = true;
      } else if (finalStatus >= 200 && finalStatus < 300) {
        if (finalHeaders['content-length'] !== undefined) {
          sizeBytes = parseInt(finalHeaders['content-length'], 10);
          isSizeReliable = true;
        }
        resumeCapable = checkResumeCapability(finalHeaders);
      }
    } catch (getError) {
      if (headResponse) {
        finalStatus = headResponse.statusCode;
        finalHeaders = headResponse.headers;
        finalUrlUsed = headFinalUrl;
      }
    }
  }

  let parsedFinalUrl;
  try {
    parsedFinalUrl = new URL(finalUrlUsed);
  } catch (e) {
    parsedFinalUrl = new URL(targetUrl);
  }

  const filename = getFilenameFromHeaders(finalHeaders || {}, parsedFinalUrl.pathname);
  let mimeType = getMimeType(finalHeaders || {});

  const isErrorish =
    !finalStatus ||
    finalStatus >= 400 ||
    baseMimeType(mimeType) === 'text/html' ||
    looksLikeHtmlBuffer(bodyPeek);

  if (isErrorish) {
    const inferred = getMimeTypeFromExtension(filename);
    if (inferred !== 'application/octet-stream') {
      mimeType = inferred;
    }
    isSizeReliable = false;
    resumeCapable = false;
  }

  const isUnknownType = baseMimeType(mimeType) === 'application/octet-stream' || !mimeType;

  return {
    finalUrl: finalUrlUsed,
    redirected: finalUrlUsed !== targetUrl,
    filename,
    size: isSizeReliable ? formatFileSize(sizeBytes) : 'Unknown (unreliable)',
    sizeBytes: isSizeReliable ? sizeBytes : null,
    mimeType,
    resumeCapable: isSizeReliable ? resumeCapable : false,
    statusCode: finalStatus,
    isSizeReliable,
    isUnknownType
  };
}

module.exports = {
  formatFileSize,
  getFilenameFromHeaders,
  getMimeType,
  baseMimeType,
  checkResumeCapability,
  getMimeTypeFromExtension,
  parseContentRange,
  fetchAccurateFileInfo
};