const pool = require("../config/db");

const FileModel = {
  async create(data) {
    const [result] = await pool.query(
      `
      INSERT INTO files (
        user_id,
        folder_id,
        original_filename,
        stored_filename,
        file_path,
        file_size,
        mime_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        data.user_id,
        data.folder_id,
        data.original_filename,
        data.stored_filename,
        data.file_path,
        data.file_size,
        data.mime_type,
      ]
    );

    return result.insertId;
  },

  async findById(id) {
    const [rows] = await pool.query(
      `
      SELECT *
      FROM files
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    return rows[0] || null;
  },

  async findByStoredFilename(storedFilename) {
    const [rows] = await pool.query(
      `
      SELECT *
      FROM files
      WHERE stored_filename = ?
      LIMIT 1
      `,
      [storedFilename]
    );

    return rows[0] || null;
  },

  async existsByName(userId, folderId, originalFilename, excludeId = null) {
    let sql = `
      SELECT id
      FROM files
      WHERE user_id = ?
      AND folder_id <=> ?
      AND original_filename = ?
    `;
    const params = [userId, folderId, originalFilename];

    if (excludeId) {
      sql += `\n      AND id <> ?\n    `;
      params.push(excludeId);
    }

    sql += `\n      LIMIT 1\n    `;

    const [rows] = await pool.query(sql, params);
    return rows.length > 0;
  },

  async findByFolder(userId, folderId = null) {
    const [rows] = await pool.query(
      `
      SELECT *
      FROM files
      WHERE user_id = ?
      AND folder_id <=> ?
      ORDER BY uploaded_at DESC
      `,
      [userId, folderId]
    );

    return rows;
  },

  async findAllByUser(userId) {
    const [rows] = await pool.query(
      `
      SELECT *
      FROM files
      WHERE user_id = ?
      ORDER BY uploaded_at DESC
      `,
      [userId]
    );

    return rows;
  },

  async delete(id) {
    const [result] = await pool.query(
      `
      DELETE FROM files
      WHERE id = ?
      `,
      [id]
    );

    return result.affectedRows;
  },
  async updateFilename(id, originalFilename, storedFilename, filePath) {
    const [result] = await pool.query(
      `
      UPDATE files
      SET original_filename = ?,
          stored_filename = ?,
          file_path = ?
      WHERE id = ?
      `,
      [originalFilename, storedFilename, filePath, id]
    );

    return result.affectedRows;
  },

  // Get all files in a folder and its subfolders recursively
  async findByFolderIdRecursive(folderId) {
    const [rows] = await pool.query(
      `
      WITH RECURSIVE folder_tree AS (
          -- Start with the target folder
          SELECT id FROM folders WHERE id = ?
          
          UNION ALL
          
          -- Get all subfolders recursively
          SELECT f.id 
          FROM folders f
          INNER JOIN folder_tree ft ON f.parent_id = ft.id
      )
      SELECT files.* 
      FROM files
      WHERE files.folder_id IN (SELECT id FROM folder_tree)
      AND files.deleted_at IS NULL
      `,
      [folderId]
    );

    return rows;
  },
};

module.exports = FileModel;