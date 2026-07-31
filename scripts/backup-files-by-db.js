#!/usr/bin/env node
/*
  Backup file fisik berdasarkan DB records (tabel `files`).

  Tujuan:
  - ambil `file_path` dari DB sebagai sumber file fisik
  - salin ke folder backup
  - nama output bisa pakai `original_filename` (lebih nyaman untuk backup)

  Cara pakai:
    node scripts/backup-files-by-db.js --out ./backup
    node scripts/backup-files-by-db.js --out ./backup --userId 1
    node scripts/backup-files-by-db.js --out ./backup --nameMode stored

  Opsi:
    --out <path>        (wajib)
    --userId <number>  (opsional, filter user)
    --folderId <number> (opsional, filter folder)
    --recursive        (opsional, include subfolders)
    --nameMode <original|stored> (default: original)
  */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (key) => {
    const i = args.indexOf(key);
    if (i === -1) return undefined;
    return args[i + 1];
  };

  return {
    out: get('--out'),
    userId: get('--userId') ? Number(get('--userId')) : undefined,
    folderId: get('--folderId') ? Number(get('--folderId')) : undefined,
    recursive: args.includes('--recursive'),
    nameMode: (get('--nameMode') || 'original').toLowerCase(),
  };
}

function sanitizeForFs(name) {
  // Hilangkan karakter path separator dan control chars.
  // (Masih ada edge cases, tapi ini cukup untuk backup umum.)
  return String(name)
    .replace(/[\\/\u0000-\u001F\u007F]/g, '_')
    .trim();
}

async function main() {
  const { out, userId, folderId, recursive, nameMode } = parseArgs();

  if (!out) {
    console.error('Missing --out <path>');
    process.exit(1);
  }

  if (!['original', 'stored'].includes(nameMode)) {
    console.error('--nameMode must be original|stored');
    process.exit(1);
  }

  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });

  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
  });

  const where = ['deleted_at IS NULL'];
  const params = [];
  
  if (typeof userId === 'number' && !Number.isNaN(userId)) {
    where.push('user_id = ?');
    params.push(userId);
  }

  // Handle folder filter
  let folderIds = [];
  if (typeof folderId === 'number' && !Number.isNaN(folderId)) {
    folderIds.push(folderId);
    
    // If recursive, get all subfolder IDs
    if (recursive) {
      const [subfolders] = await pool.query(
        `SELECT id FROM folders WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL`,
        [userId, folderId]
      );
      
      // Recursively get all nested subfolders
      const getAllSubfolderIds = async (parentId) => {
        const [children] = await pool.query(
          `SELECT id FROM folders WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL`,
          [userId, parentId]
        );
        
        let ids = [];
        for (const child of children) {
          ids.push(child.id);
          ids = ids.concat(await getAllSubfolderIds(child.id));
        }
        return ids;
      };
      
      for (const subfolder of subfolders) {
        folderIds.push(subfolder.id);
        const nestedIds = await getAllSubfolderIds(subfolder.id);
        folderIds = folderIds.concat(nestedIds);
      }
    }
  }

  // Add folder filter to WHERE clause
  if (folderIds.length > 0) {
    const placeholders = folderIds.map(() => '?').join(', ');
    where.push(`folder_id IN (${placeholders})`);
    params.push(...folderIds);
  }

  const sql = `
    SELECT id, user_id, original_filename, stored_filename, file_path, folder_id
    FROM files
    WHERE ${where.join(' AND ')}
  `;

  console.log('Querying:', { 
    userId: userId ?? 'ALL', 
    folderId: folderId ?? 'ALL',
    recursive: recursive || false,
    nameMode 
  });
  const [rows] = await pool.query(sql, params);

  let ok = 0;
  let missing = 0;
  let skipped = 0;

  for (const row of rows) {
    const src = row.file_path;
    if (!src || !fs.existsSync(src)) {
      missing++;
      continue;
    }

    const baseName = nameMode === 'stored' ? row.stored_filename : row.original_filename;
    const safeName = sanitizeForFs(baseName || path.basename(src));

    // folder per user untuk memudahkan restore
    const userDir = path.join(outAbs, `user_${row.user_id}`);
    fs.mkdirSync(userDir, { recursive: true });

    let dest = path.join(userDir, safeName);

    // Jika file dengan nama yang sama sudah ada di backup, buat suffix supaya tidak timpa.
    if (fs.existsSync(dest)) {
      const ext = path.extname(safeName);
      const base = ext ? safeName.slice(0, -ext.length) : safeName;
      let n = 1;
      while (fs.existsSync(dest)) {
        const candidate = `${base} (${n})${ext}`;
        dest = path.join(userDir, candidate);
        n++;
      }
      skipped++;
    }

    await fs.promises.copyFile(src, dest);
    ok++;
  }

  await pool.end();

  console.log('Done.');
  console.log({ 
    total: rows.length, 
    ok, 
    missing, 
    skipped,
    folderId: folderId ?? 'ALL',
    recursive: recursive || false
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

