function parseAttributeList(value = '') {
  const attrs = {};
  const regex = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
  let match;
  while ((match = regex.exec(value)) !== null) {
    let raw = match[2].trim();
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    attrs[match[1].toUpperCase()] = raw;
  }
  return attrs;
}

function parseResolution(resolution) {
  if (!resolution) return { width: 0, height: 0 };
  const [width, height] = resolution.split('x').map((n) => parseInt(n, 10) || 0);
  return { width, height };
}

function resolvePlaylistUrl(uri, baseUrl) {
  return new URL(uri, baseUrl).toString();
}

function parseIv(iv) {
  if (!iv) return null;
  const hex = iv.toLowerCase().startsWith('0x') ? iv.slice(2) : iv;
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const padded = hex.padStart(32, '0').slice(-32);
  return Buffer.from(padded, 'hex');
}

function sequenceIv(sequence) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(sequence >>> 0, 12);
  return iv;
}

function parseHlsManifest(text, manifestUrl) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.some((line) => line === '#EXTM3U')) {
    throw new Error('Not an HLS playlist');
  }

  const variants = [];
  const segments = [];
  let pendingVariant = null;
  let pendingDuration = null;
  let currentKey = null;
  let pendingByteRange = null;
  let mediaSequence = 0;
  let segmentIndex = 0;
  let initMap = null;
  let isEndList = false;
  let nextByteRangeOffset = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const raw = line.slice('#EXTINF:'.length).split(',')[0];
      pendingDuration = parseFloat(raw) || null;
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const raw = line.slice('#EXT-X-BYTERANGE:'.length);
      const [length, offset] = raw.split('@').map((n) => parseInt(n, 10));
      const resolvedOffset = Number.isFinite(offset) ? offset : nextByteRangeOffset;
      pendingByteRange = {
        length: Number.isFinite(length) ? length : null,
        offset: resolvedOffset,
      };
      if (Number.isFinite(length)) nextByteRangeOffset = resolvedOffset + length;
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        initMap = {
          uri: attrs.URI,
          url: resolvePlaylistUrl(attrs.URI, manifestUrl),
          byteRange: attrs.BYTERANGE || null,
        };
      }
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-KEY:'.length));
      const method = (attrs.METHOD || '').toUpperCase();
      if (!method || method === 'NONE') {
        currentKey = null;
      } else {
        currentKey = {
          method,
          uri: attrs.URI || null,
          url: attrs.URI ? resolvePlaylistUrl(attrs.URI, manifestUrl) : null,
          iv: parseIv(attrs.IV),
        };
      }
      continue;
    }

    if (line === '#EXT-X-ENDLIST') {
      isEndList = true;
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pendingVariant) {
      const { width, height } = parseResolution(pendingVariant.RESOLUTION);
      variants.push({
        url: resolvePlaylistUrl(line, manifestUrl),
        bandwidth: parseInt(pendingVariant.BANDWIDTH, 10) || null,
        averageBandwidth: parseInt(pendingVariant['AVERAGE-BANDWIDTH'], 10) || null,
        resolution: pendingVariant.RESOLUTION || null,
        width,
        height,
        codecs: pendingVariant.CODECS || null,
      });
      pendingVariant = null;
      continue;
    }

    const sequence = mediaSequence + segmentIndex;
    const usedByteRange = pendingByteRange;
    segments.push({
      url: resolvePlaylistUrl(line, manifestUrl),
      duration: pendingDuration,
      byteRange: usedByteRange,
      key: currentKey
        ? {
            ...currentKey,
            iv: currentKey.iv || sequenceIv(sequence),
          }
        : null,
      sequence,
      initMap: segmentIndex === 0 ? initMap : null,
    });
    pendingDuration = null;
    pendingByteRange = null;
    if (!usedByteRange) nextByteRangeOffset = 0;
    segmentIndex += 1;
  }

  variants.sort((a, b) => {
    return (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0);
  });

  return {
    type: variants.length ? 'master' : 'media',
    variants,
    segments,
    isEndList,
    duration: segments.reduce((sum, segment) => sum + (segment.duration || 0), 0),
  };
}

module.exports = {
  parseAttributeList,
  parseHlsManifest,
};
