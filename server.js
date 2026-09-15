require("dotenv").config();

const express = require("express");
const pool = require("./config/db");
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');
const webdavRoutes = require('./routes/webdav.routes');

// Routes
const authRoutes = require("./routes/auth.routes");
const folderRoutes = require('./routes/folder.routes');
const fileRoutes = require("./routes/file.routes");
const chunkedUploadRoutes = require("./routes/chunked-upload.routes");
const searchRoutes = require('./routes/search.routes');
const trashRoutes = require('./routes/trash.routes');
const shareRoutes = require('./routes/share.routes');
const moveRoutes = require('./routes/move.routes');
const directDownloadRoutes = require('./routes/direct-download.routes');
const torrentRoutes = require('./routes/torrent.routes');
const musicRoutes = require('./routes/music.routes');
const playlistRoutes = require('./routes/playlist.routes');
const favoriteRoutes = require('./routes/favorite.routes.js');

// Music DB (SQLite)
const { testConnection: testMusicDbConnection } = require('./config/musicDb');

// Error Handler
const { errorHandler, notFoundHandler } = require('./middlewares/error.middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// Middleware Global
// ============================================
// ============================================
// WebDAV — HARUS sebelum body parser agar bisa
// membaca raw request body (binary) untuk PUT
// ============================================
// Timeout khusus WebDAV untuk accommodate large file uploads
// Default 2 jam (7,200,000 ms) untuk speed 500 kbps (~450MB)
// Bisa dikonfigurasi via WEBDAV_TIMEOUT di .env
const WEBDAV_TIMEOUT = parseInt(process.env.WEBDAV_TIMEOUT) || 7200000; // 2 hours default

app.use('/webdav', (req, res, next) => {
  req.setTimeout(WEBDAV_TIMEOUT);
  res.setTimeout(WEBDAV_TIMEOUT);
  next();
}, webdavRoutes);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
}));

// CORS
const corsOrigins = process.env.CORS_ORIGIN 
  ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim())
  : '*';

app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
}));

// Response compression (gzip)
app.use(compression());

// Increase server timeout for large file uploads (5 minutes)
app.use((req, res, next) => {
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000); // 5 minutes
  next();
});


// Body parser with increased limits for large uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting untuk endpoint auth (mencegah brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 20, // max 20 request per window
  message: {
    success: false,
    code: 'TOO_MANY_REQUESTS',
    message: 'Terlalu banyak percobaan login. Silakan coba lagi dalam 15 menit.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting umum untuk API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 99999999, // max 1000 request per window (ditingkatkan dari 200)
  message: {
    success: false,
    code: 'TOO_MANY_REQUESTS',
    message: 'Terlalu banyak permintaan. Silakan coba lagi nanti.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting yang lebih longgar untuk endpoints yang sering di-access
const lenientLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 9999999, // max 2000 request per window
  message: {
    success: false,
    code: 'TOO_MANY_REQUESTS',
    message: 'Terlalu banyak permintaan. Silakan coba lagi nanti.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// Routes
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Cloud Storage API berjalan',
    version: '1.0.0',
    endpoints: {
      docs: '/api-docs',
      auth: '/auth',
      folders: '/folders',
      files: '/files',
      search: '/search',
      trash: '/trash',
      shares: '/shares',
      move: '/move',
    }
  });
});

// API Documentation (Swagger)
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Cloud Storage API Docs',
}));

// Swagger JSON
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// API Routes
app.use('/auth', authLimiter, authRoutes);
app.use('/folders', lenientLimiter, folderRoutes); // Lebih longgar karena sering di-load
app.use('/files', lenientLimiter, fileRoutes); // Lebih longgar karena sering di-load
app.use('/files', apiLimiter, chunkedUploadRoutes); // Chunked upload routes
app.use('/search', lenientLimiter, searchRoutes); // Lebih longgar
app.use('/trash', lenientLimiter, trashRoutes); // Lebih longgar
app.use('/shares', shareRoutes); // share routes punya public endpoint, rate limit di dalam
app.use('/move', apiLimiter, moveRoutes);
app.use('/direct-download', apiLimiter, directDownloadRoutes);
app.use('/torrents', apiLimiter, torrentRoutes);
app.use('/music', lenientLimiter, musicRoutes); // Music player & metadata
app.use('/playlists', lenientLimiter, playlistRoutes); // Playlist management
app.use('/favorites', lenientLimiter, favoriteRoutes); // Favorite tracks


// 404 handler
app.use(notFoundHandler);

// Centralized error handler
app.use(errorHandler);

// ============================================
// Server Startup
// ============================================

async function startServer() {
  try {
    await pool.query("SELECT 1");
    console.log("✅ Database connected");

    // Test music DB (SQLite) connection
    testMusicDbConnection();

    const HOST = process.env.HOST || '0.0.0.0';
    
    app.listen(PORT, HOST, () => {
      console.log(`🚀 Server running on http://${HOST}:${PORT}`);
      console.log(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
      
      if (HOST === '0.0.0.0') {
        console.log(`🌐 Server accessible from network`);
        const networkInterfaces = require('os').networkInterfaces();
        Object.keys(networkInterfaces).forEach((interfaceName) => {
          networkInterfaces[interfaceName].forEach((iface) => {
            if (iface.family === 'IPv4' && !iface.internal) {
              console.log(`   → http://${iface.address}:${PORT}`);
            }
          });
        });
      }
    });
  } catch (error) {
    console.error("❌ Database connection failed");
    console.error(error.message);
    process.exit(1);
  }
}

startServer();