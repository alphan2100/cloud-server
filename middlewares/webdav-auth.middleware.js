const bcrypt = require('bcrypt');
const UserModel = require('../models/user.model');

/**
 * WebDAV Basic Auth Middleware
 *
 * WebDAV clients bawaan OS (Windows Explorer "Map Network Drive", macOS Finder
 * "Connect to Server", rclone, davfs2, Cyberduck, dll) hanya mendukung skema
 * HTTP Basic/Digest auth per-request — tidak bisa mengirim Bearer JWT seperti
 * REST API web app. Karena itu WebDAV butuh middleware auth terpisah.
 *
 * Skema validasi password TETAP SAMA dengan auth.controller.js (bcrypt.compare
 * terhadap password_hash di tabel users) — jadi username/password yang dipakai
 * user untuk login ke web app juga otomatis berlaku untuk mount WebDAV.
 *
 * Tidak ada perubahan ke auth.controller.js / auth.middleware.js yang sudah ada.
 */
async function webdavAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Cloud Storage WebDAV"');
    return res.status(401).send('Authentication required');
  }

  let username, password;
  try {
    const base64Credentials = authHeader.slice('Basic '.length);
    const decoded = Buffer.from(base64Credentials, 'base64').toString('utf8');
    const sepIndex = decoded.indexOf(':');
    if (sepIndex === -1) throw new Error('Invalid credentials format');
    username = decoded.slice(0, sepIndex);
    password = decoded.slice(sepIndex + 1);
  } catch (e) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Cloud Storage WebDAV"');
    return res.status(401).send('Invalid Authorization header');
  }

  try {
    const user = await UserModel.findByUsername(username);
    if (!user) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Cloud Storage WebDAV"');
      return res.status(401).send('Invalid username or password');
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Cloud Storage WebDAV"');
      return res.status(401).send('Invalid username or password');
    }

    // Samakan shape req.user dengan authMiddleware JWT yang sudah ada
    // (controller lain pakai req.user.id, req.user.username)
    req.user = { id: user.id, username: user.username };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = webdavAuthMiddleware;
