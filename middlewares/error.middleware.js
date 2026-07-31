/**
 * Centralized Error Handler Middleware
 * Menangani semua error dalam satu tempat, tidak perlu try-catch manual di tiap controller
 */

class AppError extends Error {
  constructor(message, statusCode, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Error types
const ErrorTypes = {
  BAD_REQUEST: { statusCode: 400, code: 'BAD_REQUEST' },
  UNAUTHORIZED: { statusCode: 401, code: 'UNAUTHORIZED' },
  FORBIDDEN: { statusCode: 403, code: 'FORBIDDEN' },
  NOT_FOUND: { statusCode: 404, code: 'NOT_FOUND' },
  CONFLICT: { statusCode: 409, code: 'CONFLICT' },
  VALIDATION_ERROR: { statusCode: 422, code: 'VALIDATION_ERROR' },
  TOO_MANY_REQUESTS: { statusCode: 429, code: 'TOO_MANY_REQUESTS' },
  INTERNAL: { statusCode: 500, code: 'INTERNAL_ERROR' },
  FILE_TOO_LARGE: { statusCode: 413, code: 'FILE_TOO_LARGE' },
};

// Wrapper untuk async route handlers agar tidak perlu try-catch manual
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Middleware error handler utama
const errorHandler = (err, req, res, next) => {
  // Default error
  let statusCode = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'Internal server error';
  let details = err.details || null;

  // Handle Multer errors (file upload)
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      statusCode = 413;
      code = 'FILE_TOO_LARGE';
      message = 'Ukuran file melebihi batas maksimum (5GB)';
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      statusCode = 400;
      code = 'BAD_REQUEST';
      message = 'Terlalu banyak file yang diupload dalam satu permintaan';
    } else {
      statusCode = 400;
      code = 'BAD_REQUEST';
      message = err.message;
    }
  }

  // Handle Multer file filter error
  if (err.message && err.message.includes('Tipe file')) {
    statusCode = 400;
    code = 'INVALID_FILE_TYPE';
    message = err.message;
  }

  // Handle Request Aborted (client disconnected during upload)
  if (err.message && err.message.toLowerCase().includes('request aborted')) {
    // Log as warning only, not error - this is expected during page reloads
    console.warn('⚠️ [CLIENT_DISCONNECT] Request aborted by client (page reload/close)');
    // Don't send response if headers already sent or request already destroyed
    if (!res.headersSent && req.destroyed === false) {
      return res.status(499).json({
        success: false,
        code: 'CLIENT_DISCONNECT',
        message: 'Koneksi terputus oleh klien',
      });
    }
    return;
  }

  // Handle JSON parsing error
  if (err.type === 'entity.parse.failed') {
    statusCode = 400;
    code = 'INVALID_JSON';
    message = 'Format JSON tidak valid';
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    code = 'INVALID_TOKEN';
    message = 'Token tidak valid';
  }
  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    code = 'TOKEN_EXPIRED';
    message = 'Token telah kedaluwarsa';
  }

  // Log error di server untuk debugging
  if (statusCode >= 500) {
    console.error('❌ [ERROR]', err);
  } else {
    console.warn('⚠️ [WARN]', message);
  }

  // Response JSON
  const response = {
    success: false,
    code,
    message,
  };

  if (details) {
    response.details = details;
  }

  // Jangan tampilkan stack trace di production
  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
  }

  return res.status(statusCode).json(response);
};

// 404 handler untuk route yang tidak dikenal
const notFoundHandler = (req, res, next) => {
  next(new AppError(`Route ${req.originalUrl} tidak ditemukan`, 404, 'NOT_FOUND'));
};

module.exports = {
  AppError,
  ErrorTypes,
  asyncHandler,
  errorHandler,
  notFoundHandler,
};