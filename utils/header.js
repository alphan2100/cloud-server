/**
 * Utility functions for HTTP headers
 */

/**
 * Encode filename for Content-Disposition header
 * Supports both RFC 5987 (UTF-8) and fallback to ASCII
 * 
 * @param {string} filename - Original filename
 * @returns {string} Encoded filename for Content-Disposition header
 */
function encodeFilename(filename) {
  // Check if filename contains only ASCII characters (safe for headers)
  const isASCII = /^[\x20-\x7E]*$/.test(filename);
  
  if (isASCII) {
    // Simple ASCII filename - escape quotes if present
    const escaped = filename.replace(/"/g, '\\"');
    return `filename="${escaped}"`;
  }
  
  // Non-ASCII filename - use RFC 5987 encoding
  // First, generate ASCII fallback by removing/replacing non-ASCII chars
  const asciiFilename = filename
    .replace(/[^\x20-\x7E]/g, '_') // Replace non-ASCII with underscore
    .replace(/"/g, '\\"');
  
  // Encode the original filename using UTF-8 percent encoding
  const encoded = Buffer.from(filename, 'utf8')
    .toString('binary')
    .split('')
    .map(c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
    .join('');
  
  // Return both ASCII fallback and RFC 5987 encoded version
  return `filename="${asciiFilename}"; filename*=UTF-8''${encoded}`;
}

/**
 * Set Content-Disposition header with proper encoding
 * 
 * @param {Object} res - Express response object
 * @param {string} disposition - 'inline' or 'attachment'
 * @param {string} filename - Original filename
 */
function setContentDisposition(res, disposition, filename) {
  const encodedFilename = encodeFilename(filename);
  res.setHeader('Content-Disposition', `${disposition}; ${encodedFilename}`);
}

module.exports = {
  encodeFilename,
  setContentDisposition,
};