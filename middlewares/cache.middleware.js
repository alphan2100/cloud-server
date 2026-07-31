/**
 * Caching Middleware menggunakan node-cache
 * Meng-cache query yang sering diakses seperti daftar folder root
 */
const NodeCache = require('node-cache');

// Cache dengan TTL default 60 detik, check period 120 detik
const cache = new NodeCache({
  stdTTL: 60,
  checkperiod: 120,
  useClones: false,
});

const CacheMiddleware = {
  /**
   * Middleware untuk mendapatkan data dari cache
   * @param {number} duration - TTL dalam detik
   */
  get(duration = 60) {
    return (req, res, next) => {
      const key = this._generateKey(req);
      const cachedData = cache.get(key);

      if (cachedData) {
        return res.json({
          success: true,
          data: cachedData,
          cached: true,
        });
      }

      // Simpan original res.json agar bisa di-intercept
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (body && body.success && body.data) {
          cache.set(key, body.data, duration);
        }
        return originalJson(body);
      };

      next();
    };
  },

  /**
   * Simpan data ke cache secara manual
   */
  set(key, data, duration = 60) {
    cache.set(key, data, duration);
  },

  /**
   * Hapus cache berdasarkan key pattern
   */
  invalidate(pattern) {
    const keys = cache.keys();
    const matchedKeys = keys.filter((key) => key.includes(pattern));
    cache.del(matchedKeys);
  },

  /**
   * Hapus semua cache untuk user tertentu
   */
  invalidateUser(userId) {
    const keys = cache.keys();
    const matchedKeys = keys.filter(
      (key) => key.includes(`user_${userId}`)
    );
    cache.del(matchedKeys);
  },

  /**
   * Generate key unik berdasarkan method, path, dan query params
   */
  _generateKey(req) {
    const base = `${req.method}:${req.originalUrl || req.url}`;
    if (req.user) {
      return `${base}:user_${req.user.id}`;
    }
    return base;
  },

  /**
   * Hapus semua cache
   */
  flushAll() {
    cache.flushAll();
  },

  /**
   * Dapatkan statistik cache
   */
  getStats() {
    return cache.getStats();
  },
};

module.exports = CacheMiddleware;
