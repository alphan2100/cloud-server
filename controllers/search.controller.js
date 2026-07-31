const pool = require('../config/db');
const { asyncHandler, AppError } = require('../middlewares/error.middleware');

const SearchController = {
  /**
   * GET /search?q=keyword&type=all|file|folder&folder_id=optional
   * Mencari file dan folder berdasarkan nama
   */
  search: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { q, type = 'all', folder_id } = req.query;

    if (!q || q.trim().length === 0) {
      throw new AppError('Parameter pencarian (q) wajib diisi', 400, 'VALIDATION_ERROR');
    }

    const searchTerm = `%${q.trim()}%`;
    const results = [];

    // Search files
    if (type === 'all' || type === 'file') {
      let fileSql = `
        SELECT id, original_filename as name, 'file' as type, file_size, mime_type, 
               folder_id, uploaded_at as created_at, updated_at
        FROM files
        WHERE user_id = ? AND original_filename LIKE ? AND deleted_at IS NULL
      `;
      const fileParams = [userId, searchTerm];

      if (folder_id) {
        fileSql += ` AND folder_id = ?`;
        fileParams.push(folder_id);
      }

      fileSql += ` ORDER BY uploaded_at DESC LIMIT 50`;

      const [files] = await pool.query(fileSql, fileParams);
      results.push(...files);
    }

    // Search folders
    if (type === 'all' || type === 'folder') {
      let folderSql = `
        SELECT id, folder_name as name, 'folder' as type, NULL as file_size, NULL as mime_type,
               parent_id as folder_id, created_at, updated_at
        FROM folders
        WHERE user_id = ? AND folder_name LIKE ? AND deleted_at IS NULL
      `;
      const folderParams = [userId, searchTerm];

      if (folder_id) {
        folderSql += ` AND parent_id = ?`;
        folderParams.push(folder_id);
      }

      folderSql += ` ORDER BY folder_name ASC LIMIT 50`;

      const [folders] = await pool.query(folderSql, folderParams);
      results.push(...folders);
    }

    // Sort by created_at descending
    results.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    return res.json({
      success: true,
      query: q.trim(),
      total: results.length,
      data: results,
    });
  }),
};

module.exports = SearchController;