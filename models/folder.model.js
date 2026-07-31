const pool = require('../config/db');

const FolderModel = {
  // Ambil ID folder beserta seluruh ID sub-folder di dalamnya secara rekursif
  async getAllDescendantIds(folderId) {
    const [rows] = await pool.query(
      `
      WITH RECURSIVE descendant_folders AS (
          -- Ambil folder target pertama (Parent)
          SELECT id FROM folders WHERE id = ?
          
          UNION ALL
          
          -- Ambil semua anak/sub-folder secara berulang (Recursive)
          SELECT f.id 
          FROM folders f
          INNER JOIN descendant_folders df ON f.parent_id = df.id
      )
      SELECT id FROM descendant_folders;
      `,
      [folderId]
    );

    // Ubah hasil array of object [{id: 1}, {id: 2}] menjadi array biasa [1, 2]
    return rows.map(row => row.id);
  },
  // Membuat folder baru
  async create(userId, parentId, folderName) {
    const [result] = await pool.query(
      `
      INSERT INTO folders (
        user_id,
        parent_id,
        folder_name
      )
      VALUES (?, ?, ?)
      `,
      [userId, parentId, folderName]
    );

    return result.insertId;
  },

  // Cari folder berdasarkan id
  async findById(id) {
    const [rows] = await pool.query(
      `
      SELECT *
      FROM folders
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    return rows[0] || null;
  },

  // Ambil folder dalam parent tertentu
  async findChildren(userId, parentId = null) {
    const [rows] = await pool.query(
      `
      SELECT *
      FROM folders
      WHERE user_id = ?
      AND parent_id <=> ?
      ORDER BY folder_name ASC
      `,
      [userId, parentId]
    );

    return rows;
  },

  // Rename folder
  async updateName(id, folderName) {
    const [result] = await pool.query(
      `
      UPDATE folders
      SET folder_name = ?
      WHERE id = ?
      `,
      [folderName, id]
    );

    return result.affectedRows > 0;
  },

  // Hapus folder
  async delete(id) {
    const [result] = await pool.query(
      `
      DELETE FROM folders
      WHERE id = ?
      `,
      [id]
    );

    return result.affectedRows > 0;
  },
  // Cek apakah folder dengan nama yang sama sudah ada dalam parent yang sama
  async existsByName(userId, parentId, folderName, excludeId = null) {
    let sql = `
    SELECT id
    FROM folders
    WHERE user_id = ?
    AND parent_id <=> ?
    AND folder_name = ?
    `;

    const params = [userId, parentId, folderName];

    if (excludeId) {
      sql += `\n    AND id <> ?\n    `;
      params.push(excludeId);
    }

    sql += `\n    LIMIT 1\n    `;

    const [rows] = await pool.query(sql, params);

    return rows.length > 0;
  },

  // Get all direct subfolders of a folder
  async findSubFolders(parentId) {
    const [rows] = await pool.query(
      `
      SELECT *
      FROM folders
      WHERE parent_id = ?
      AND deleted_at IS NULL
      ORDER BY folder_name ASC
      `,
      [parentId]
    );

    return rows;
  },
};

module.exports = FolderModel;