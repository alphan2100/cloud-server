/**
 * Minimal bencode decoder.
 * Cukup untuk membaca file .torrent (dict/list/int/byte-string).
 * Byte-string dikembalikan sebagai Buffer (biar caller yang memutuskan
 * apakah perlu di-decode sebagai utf8 atau dibiarkan raw/binary).
 */

function decodeInt(buf, pos) {
  pos.i++; // skip 'i'
  const end = buf.indexOf(0x65, pos.i); // 'e'
  if (end === -1) throw new Error('Bencode int tidak valid');
  const numStr = buf.toString('ascii', pos.i, end);
  pos.i = end + 1;
  const n = parseInt(numStr, 10);
  if (Number.isNaN(n)) throw new Error('Bencode int tidak valid');
  return n;
}

function decodeString(buf, pos) {
  const colon = buf.indexOf(0x3a, pos.i); // ':'
  if (colon === -1) throw new Error('Bencode string tidak valid');
  const lenStr = buf.toString('ascii', pos.i, colon);
  const len = parseInt(lenStr, 10);
  if (Number.isNaN(len) || len < 0) throw new Error('Bencode string tidak valid');
  const start = colon + 1;
  const end = start + len;
  if (end > buf.length) throw new Error('Bencode string melebihi panjang buffer');
  pos.i = end;
  return buf.slice(start, end);
}

function decodeList(buf, pos) {
  pos.i++; // skip 'l'
  const list = [];
  while (buf[pos.i] !== 0x65) {
    if (pos.i >= buf.length) throw new Error('Bencode list tidak lengkap');
    list.push(decodeValue(buf, pos));
  }
  pos.i++; // skip 'e'
  return list;
}

function decodeDict(buf, pos) {
  pos.i++; // skip 'd'
  const dict = {};
  while (buf[pos.i] !== 0x65) {
    if (pos.i >= buf.length) throw new Error('Bencode dict tidak lengkap');
    const key = decodeString(buf, pos).toString('utf8');
    dict[key] = decodeValue(buf, pos);
  }
  pos.i++; // skip 'e'
  return dict;
}

function decodeValue(buf, pos) {
  const c = buf[pos.i];
  if (c === 0x64) return decodeDict(buf, pos); // 'd'
  if (c === 0x6c) return decodeList(buf, pos); // 'l'
  if (c === 0x69) return decodeInt(buf, pos); // 'i'
  if (c >= 0x30 && c <= 0x39) return decodeString(buf, pos); // digit
  throw new Error(`Karakter bencode tidak dikenali pada posisi ${pos.i}`);
}

function decode(buffer) {
  return decodeValue(buffer, { i: 0 });
}

/**
 * Encoder bencode minimal - kebalikan dari decode().
 * Dipakai untuk menghitung infoHash: harus re-encode persis dict "info"
 * seperti aslinya lalu di-SHA1. Buffer/string/number/array/object didukung.
 * Urutan key object diasumsikan sudah sesuai urutan bencode asli - ini valid
 * karena decode() membaca key dict sesuai urutan byte aslinya, dan spec
 * bencode mewajibkan key dict terurut, jadi Object.keys() akan match.
 */
function encodeValue(value) {
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  }
  if (typeof value === 'string') {
    const buf = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from(`${buf.length}:`), buf]);
  }
  if (typeof value === 'number') {
    return Buffer.from(`i${Math.trunc(value)}e`);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from('l'), ...value.map(encodeValue), Buffer.from('e')]);
  }
  if (value && typeof value === 'object') {
    const parts = [];
    for (const key of Object.keys(value)) {
      parts.push(encodeValue(Buffer.from(key, 'utf8')));
      parts.push(encodeValue(value[key]));
    }
    return Buffer.concat([Buffer.from('d'), ...parts, Buffer.from('e')]);
  }
  throw new Error(`Tipe tidak didukung untuk bencode encode: ${typeof value}`);
}

function encode(value) {
  return encodeValue(value);
}

module.exports = { decode, encode };