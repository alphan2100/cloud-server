const fs = require('fs');
const path = require('path');
const { asyncHandler, AppError } = require('../middlewares/error.middleware');
const WebDAVService = require('../services/webdav.service');

const MOUNT_PREFIX = '/webdav';

// ------------------------- Helpers -------------------------

function getSegments(req) {
  // Express 5 (path-to-regexp v8+): wildcard '/*splat' mengisi req.params.splat,
  // yang formatnya array segmen path (bukan string tunggal seperti req.params[0]
  // di Express 4). Route '/' (root /webdav) tidak punya req.params.splat sama sekali.
  const raw = req.params.splat;

  let parts;
  if (Array.isArray(raw)) {
    parts = raw;
  } else if (typeof raw === 'string') {
    parts = raw.split('/');
  } else {
    parts = [];
  }

  return parts.filter(Boolean).map((seg) => decodeURIComponent(seg));
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toHref(segments, isCollection) {
  const p = MOUNT_PREFIX + '/' + segments.map(encodeURIComponent).join('/');
  if (isCollection) {
    return p.endsWith('/') ? p : p + '/';
  }
  return p;
}

function buildFolderResponse(segments, folder) {
  const href = toHref(segments, true);
  const name = folder ? folder.folder_name : '';
  const lastModified = folder ? new Date(folder.updated_at || folder.created_at) : new Date();

  return `  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:displayname>${xmlEscape(name)}</D:displayname>
        <D:getlastmodified>${lastModified.toUTCString()}</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

function buildFileResponse(segments, file) {
  const href = toHref(segments, false);
  const lastModified = new Date(file.updated_at || file.uploaded_at);

  return `  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:displayname>${xmlEscape(file.original_filename)}</D:displayname>
        <D:getcontentlength>${file.file_size}</D:getcontentlength>
        <D:getcontenttype>${xmlEscape(file.mime_type || 'application/octet-stream')}</D:getcontenttype>
        <D:getlastmodified>${lastModified.toUTCString()}</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

/**
 * Parse header Destination (MOVE/COPY) jadi array segmen relatif terhadap /webdav.
 * Destination bisa berupa URL absolut (http://host/webdav/...) atau path saja.
 */
function parseDestination(destinationHeader) {
  if (!destinationHeader) return null;
  let pathname;
  try {
    // Coba parse sebagai URL absolut dulu
    const url = new URL(destinationHeader);
    pathname = url.pathname;
  } catch (e) {
    // Bukan URL absolut, anggap sebagai path saja
    pathname = destinationHeader;
  }

  if (!pathname.startsWith(MOUNT_PREFIX)) {
    return null;
  }

  const rest = pathname.slice(MOUNT_PREFIX.length);
  return rest
    .split('/')
    .filter(Boolean)
    .map((seg) => decodeURIComponent(seg));
}

// ------------------------- Handlers -------------------------

const WebDAVController = {
  /**
   * OPTIONS - wajib untuk deteksi WebDAV support oleh client (Windows dsb)
   */
  options: asyncHandler(async (req, res) => {
    res.setHeader('DAV', '1, 2');
    res.setHeader(
      'Allow',
      'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE, LOCK, UNLOCK'
    );
    res.setHeader('MS-Author-Via', 'DAV');
    res.status(200).end();
  }),

  /**
   * PROPFIND - listing folder / info resource
   * Depth: 0 (resource itu sendiri) atau 1 (+ isi langsung).
   * Depth: infinity diperlakukan sama seperti 1 (demi performa & keamanan,
   * tidak ada kebutuhan listing rekursif penuh untuk kasus penggunaan ini).
   */
  propfind: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const segments = getSegments(req);
    const depth = req.headers.depth === '0' ? '0' : '1';

    const resolved = await WebDAVService.resolvePath(userId, segments);
    if (resolved.type === 'not_found') {
      return res.status(404).send('Not Found');
    }

    const responses = [];

    if (resolved.type === 'folder') {
      responses.push(buildFolderResponse(segments, resolved.folder));

      if (depth === '1') {
        const folderId = resolved.folder ? resolved.folder.id : null;
        const { folders, files } = await WebDAVService.listChildren(userId, folderId);

        for (const f of folders) {
          responses.push(buildFolderResponse([...segments, f.folder_name], f));
        }
        for (const file of files) {
          responses.push(buildFileResponse([...segments, file.original_filename], file));
        }
      }
    } else {
      responses.push(buildFileResponse(segments, resolved.file));
    }

    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${responses.join(
      '\n'
    )}\n</D:multistatus>`;

    res.status(207);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  }),

  /**
   * GET - stream isi file langsung (untuk akses/preview/stream tanpa "download"
   * eksplisit, mis. mount sebagai drive lalu dibuka langsung / video di-stream).
   * Support Range request untuk streaming video besar.
   */
  get: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const segments = getSegments(req);
    const resolved = await WebDAVService.resolvePath(userId, segments);

    if (resolved.type === 'not_found') {
      return res.status(404).send('Not Found');
    }

    if (resolved.type === 'folder') {
      // Sebagian besar client WebDAV pakai PROPFIND untuk listing, tapi
      // beberapa (atau browser biasa) bisa GET folder -> tampilkan listing simpel.
      const folderId = resolved.folder ? resolved.folder.id : null;
      const { folders, files } = await WebDAVService.listChildren(userId, folderId);
      const items = [
        ...folders.map((f) => `<li>📁 <a href="${xmlEscape(encodeURIComponent(f.folder_name))}/">${xmlEscape(f.folder_name)}/</a></li>`),
        ...files.map((f) => `<li>📄 <a href="${xmlEscape(encodeURIComponent(f.original_filename))}">${xmlEscape(f.original_filename)}</a></li>`),
      ].join('\n');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<html><body><ul>${items}</ul></body></html>`);
    }

    const file = resolved.file;
    if (!fs.existsSync(file.file_path)) {
      throw new AppError('File fisik tidak ditemukan di server', 404, 'NOT_FOUND');
    }

    const stat = fs.statSync(file.file_path);
    const fileSize = stat.size;

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Last-Modified', new Date(file.updated_at || file.uploaded_at).toUTCString());

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);
      fs.createReadStream(file.file_path, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(file.file_path).pipe(res);
    }
  }),

  /**
   * HEAD - sama seperti GET tapi tanpa body (dipakai client cek keberadaan/size file)
   */
  head: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const segments = getSegments(req);
    const resolved = await WebDAVService.resolvePath(userId, segments);

    if (resolved.type === 'not_found') {
      return res.status(404).end();
    }

    if (resolved.type === 'folder') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end();
    }

    const file = resolved.file;
    if (!fs.existsSync(file.file_path)) {
      return res.status(404).end();
    }
    const stat = fs.statSync(file.file_path);

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Last-Modified', new Date(file.updated_at || file.uploaded_at).toUTCString());
    res.status(200).end();
  }),

  /**
   * PUT - upload/overwrite file. Tetap lewat UploadService.processFile yang sama
   * dengan endpoint REST /files/upload -> thumbnail + video remux otomatis jalan.
   */
  put: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const segments = getSegments(req);

    // PENTING: PUT WebDAV adalah SATU request HTTP tunggal yang men-stream
    // seluruh isi file (bisa GB) dari client ke server. Kalau jaringan client
    // lambat/tersendat, default idle-timeout socket Node (mengikuti
    // server.requestTimeout, default 5 menit di Node 18+) bisa memutus koneksi
    // di tengah transfer walau koneksinya masih hidup, cuma lambat.
    // Nonaktifkan timeout socket khusus untuk request PUT ini saja supaya
    // upload file besar di jaringan lambat tidak diputus paksa oleh server.
    // (Kalau ada reverse proxy di depan seperti Nginx, proxy_read_timeout/
    // proxy_send_timeout di sana JUGA harus dinaikkan — lihat catatan di README/ops.)
    req.socket.setTimeout(0);
    res.setTimeout(0);

    if (segments.length === 0) {
      throw new AppError('Tidak bisa menulis langsung ke root', 400, 'BAD_REQUEST');
    }

    const fileName = segments[segments.length - 1];
    const parentSegments = segments.slice(0, -1);

    const parent = await WebDAVService.resolveParent(userId, parentSegments);
    if (parent === null) {
      // Parent folder tidak ada -> WebDAV spec: 409 Conflict
      throw new AppError('Folder tujuan tidak ditemukan', 409, 'CONFLICT');
    }

    // Kalau target path ternyata sudah dipakai oleh sebuah FOLDER, tolak
    const existingAtPath = await WebDAVService.resolvePath(userId, segments);
    if (existingAtPath.type === 'folder') {
      throw new AppError('Path tersebut adalah folder', 409, 'CONFLICT');
    }

    const mimeType = req.headers['content-type'];
    const result = await WebDAVService.putFile(req, userId, parent.parentId, fileName, mimeType);

    // Hidden file (seperti .DS_Store) — skip tanpa error
    if (result.skipped) {
      return res.status(204).end();
    }

    res.status(result.overwritten ? 204 : 201).end();
  }),

  /**
   * DELETE - file: soft-delete ke trash (sama seperti web app).
   * folder: soft-delete rekursif folder + seluruh isinya (reuse getAllDescendantIds).
   */
  delete: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const segments = getSegments(req);

    if (segments.length === 0) {
      throw new AppError('Tidak bisa menghapus root', 400, 'BAD_REQUEST');
    }

    const resolved = await WebDAVService.resolvePath(userId, segments);
    if (resolved.type === 'not_found') {
      return res.status(404).send('Not Found');
    }

    if (resolved.type === 'folder') {
      await WebDAVService.deleteFolderRecursive(userId, resolved.folder.id);
    } else {
      await WebDAVService.deleteFile(userId, resolved.file);
    }

    res.status(204).end();
  }),

  /**
   * MKCOL - buat folder baru
   */
  mkcol: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const segments = getSegments(req);

    if (segments.length === 0) {
      throw new AppError('Root sudah ada', 405, 'METHOD_NOT_ALLOWED');
    }

    const folderName = segments[segments.length - 1];

    // Folder sistem macOS (.Trashes, .Spotlight-V100, .TemporaryItems, dst)
    // — pura-pura sukses tanpa benar-benar membuatnya di DB/disk.
    if (WebDAVService.isJunkName(folderName)) {
      return res.status(201).end();
    }

    const parentSegments = segments.slice(0, -1);

    const parent = await WebDAVService.resolveParent(userId, parentSegments);
    if (parent === null) {
      throw new AppError('Parent folder tidak ditemukan', 409, 'CONFLICT');
    }

    await WebDAVService.createFolder(userId, parent.parentId, folderName);
    res.status(201).end();
  }),

  /**
   * MOVE - pindah/rename file atau folder (rekursif otomatis untuk folder
   * karena physical path folder dikunci oleh ID, bukan nama/parent)
   */
  move: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const segments = getSegments(req);
    const destSegments = parseDestination(req.headers.destination);
    const overwrite = (req.headers.overwrite || 'T').toUpperCase() !== 'F';

    if (!destSegments || destSegments.length === 0) {
      throw new AppError('Header Destination tidak valid', 400, 'BAD_REQUEST');
    }

    const resolved = await WebDAVService.resolvePath(userId, segments);
    if (resolved.type === 'not_found') {
      return res.status(404).send('Not Found');
    }

    const newName = destSegments[destSegments.length - 1];

    // Klien (macOS Finder dkk) sering PUT ke nama sementara dulu lalu
    // MOVE/rename ke nama junk (.DS_Store, ._foo, dst). Nama sementara itu
    // lolos filter PUT karena bukan dot-file — jadi harus dicek lagi di
    // sini, di titik akhir prosesnya (nama TUJUAN), bukan cuma nama sumber.
    if (WebDAVService.isJunkName(newName)) {
      // Bersihkan sisa resource sumber (biasanya cuma file sementara berisi
      // metadata) supaya tidak numpuk sebagai file "aneh" yang tak terpakai.
      if (resolved.type === 'folder') {
        await WebDAVService.deleteFolderRecursive(userId, resolved.folder.id);
      } else {
        await WebDAVService.deleteFile(userId, resolved.file);
      }
      return res.status(204).end();
    }

    const destParentSegments = destSegments.slice(0, -1);
    const destParent = await WebDAVService.resolveParent(userId, destParentSegments);
    if (destParent === null) {
      throw new AppError('Folder tujuan tidak ditemukan', 409, 'CONFLICT');
    }

    const destResolved = await WebDAVService.resolvePath(userId, destSegments);
    if (destResolved.type !== 'not_found') {
      if (!overwrite) {
        return res.status(412).send('Precondition Failed');
      }
      // Overwrite: hapus dulu resource tujuan yang ada (tipe harus sama)
      if (destResolved.type !== resolved.type) {
        throw new AppError('Tipe resource tujuan berbeda', 409, 'CONFLICT');
      }
      if (destResolved.type === 'folder') {
        await WebDAVService.deleteFolderRecursive(userId, destResolved.folder.id);
      } else {
        await WebDAVService.deleteFile(userId, destResolved.file);
      }
    }

    if (resolved.type === 'folder') {
      await WebDAVService.moveFolder(userId, resolved.folder, destParent.parentId, newName);
    } else {
      await WebDAVService.moveFile(userId, resolved.file, destParent.parentId, newName);
    }

    res.status(destResolved.type === 'not_found' ? 201 : 204).end();
  }),

  /**
   * COPY - salin file atau folder (rekursif untuk folder)
   */
  copy: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const segments = getSegments(req);
    const destSegments = parseDestination(req.headers.destination);
    const overwrite = (req.headers.overwrite || 'T').toUpperCase() !== 'F';

    if (!destSegments || destSegments.length === 0) {
      throw new AppError('Header Destination tidak valid', 400, 'BAD_REQUEST');
    }

    const resolved = await WebDAVService.resolvePath(userId, segments);
    if (resolved.type === 'not_found') {
      return res.status(404).send('Not Found');
    }

    const newName = destSegments[destSegments.length - 1];

    // Sama seperti MOVE: cek nama TUJUAN, bukan cuma nama sumber.
    // COPY tidak menyentuh sumbernya sama sekali, jadi cukup no-op.
    if (WebDAVService.isJunkName(newName)) {
      return res.status(204).end();
    }

    const destParentSegments = destSegments.slice(0, -1);
    const destParent = await WebDAVService.resolveParent(userId, destParentSegments);
    if (destParent === null) {
      throw new AppError('Folder tujuan tidak ditemukan', 409, 'CONFLICT');
    }

    const destResolved = await WebDAVService.resolvePath(userId, destSegments);
    if (destResolved.type !== 'not_found') {
      if (!overwrite) {
        return res.status(412).send('Precondition Failed');
      }
      if (destResolved.type !== resolved.type) {
        throw new AppError('Tipe resource tujuan berbeda', 409, 'CONFLICT');
      }
      if (destResolved.type === 'folder') {
        await WebDAVService.deleteFolderRecursive(userId, destResolved.folder.id);
      } else {
        await WebDAVService.deleteFile(userId, destResolved.file);
      }
    }

    if (resolved.type === 'folder') {
      await WebDAVService.copyFolderRecursive(userId, resolved.folder.id, destParent.parentId);
    } else {
      await WebDAVService.copyFile(userId, resolved.file, destParent.parentId, newName);
    }

    res.status(destResolved.type === 'not_found' ? 201 : 204).end();
  }),

  /**
   * LOCK / UNLOCK - implementasi minimal (fake lock, tanpa state management).
   * Beberapa client (terutama Windows) mengharuskan LOCK sukses sebelum mau
   * membuka file untuk edit, walau tidak ada enforcement lock sungguhan.
   * Tidak perlu fitur locking penuh untuk kebutuhan extended storage single-user.
   */
  lock: asyncHandler(async (req, res) => {
    const fakeToken = `opaquelocktoken:${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>0</D:depth>
      <D:timeout>Second-600</D:timeout>
      <D:locktoken><D:href>${fakeToken}</D:href></D:locktoken>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Lock-Token', `<${fakeToken}>`);
    res.status(200).send(xml);
  }),

  unlock: asyncHandler(async (req, res) => {
    res.status(204).end();
  }),
};

module.exports = WebDAVController;