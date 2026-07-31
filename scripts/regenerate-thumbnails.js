#!/usr/bin/env node

/**
 * Regenerate Thumbnails for Trashed Files
 *
 * Script ini akan:
 * 1. Mencari file yang ada di trash (deleted_at IS NOT NULL)
 * 2. Cek apakah thumbnail-nya hilang
 * 3. Regenerate thumbnail untuk file yang thumbnail-nya hilang
 *
 * Usage:
 *   node scripts/regenerate-thumbnails.js
 *   npm run thumbnails:regenerate
 */

require("dotenv").config();
const pool = require("../../config/db");
const { generateThumbnail } = require("../services/thumbnail.service");
const fs = require("fs");
const path = require("path");

const THUMBNAILS_DIR = process.env.THUMBNAILS_DIR
  ? path.resolve(process.env.THUMBNAILS_DIR)
  : path.join(__dirname, '..', 'thumbnails');

async function main() {
  console.log('');
  console.log('🔄 Regenerate thumbnails for trashed files...');
  console.log(`   Thumbnails dir: ${THUMBNAILS_DIR}`);
  console.log('');

  // Get all trashed files
  const [trashedFiles] = await pool.query(
    `SELECT id, user_id, original_filename, file_path, mime_type 
     FROM files 
     WHERE deleted_at IS NOT NULL`
  );

  console.log(`   Found ${trashedFiles.length} trashed files`);
  console.log('');

  let regenerated = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of trashedFiles) {
    const thumbPath = getThumbnailPath(file.file_path);
    const jpgPath = thumbPath.replace(/\.\w+$/, '.jpg');
    
    // Check if thumbnail exists
    const thumbExists = fs.existsSync(thumbPath) || fs.existsSync(jpgPath);
    
    if (thumbExists) {
      skipped++;
      continue; // Thumbnail already exists, skip
    }

    // Check if original file still exists
    if (!fs.existsSync(file.file_path)) {
      console.log(`   ⚠️  File not found: ${file.original_filename} (ID: ${file.id})`);
      failed++;
      continue;
    }

    // Regenerate thumbnail
    try {
      await generateThumbnail(file.file_path, file.mime_type);
      console.log(`   ✅ Regenerated: ${file.original_filename} (ID: ${file.id})`);
      regenerated++;
    } catch (err) {
      console.error(`   ❌ Failed: ${file.original_filename} - ${err.message}`);
      failed++;
    }
  }

  console.log('');
  console.log('📊 Summary:');
  console.log(`   ✅ Regenerated: ${regenerated}`);
  console.log(`   ⏭️  Skipped (already exists): ${skipped}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📁 Total trashed files: ${trashedFiles.length}`);
  console.log('');
}

// Helper function (same logic as thumbnail.service.js)
function getThumbnailPath(filePath) {
  let normalizedPath = filePath.replace(/\\/g, '/');
  
  let relativePath;
  if (normalizedPath.startsWith('uploads/')) {
    relativePath = normalizedPath.slice('uploads/'.length);
  } else if (normalizedPath.includes('/uploads/')) {
    const uploadsIndex = normalizedPath.indexOf('/uploads/');
    relativePath = normalizedPath.substring(uploadsIndex + '/uploads/'.length);
  } else {
    relativePath = normalizedPath;
  }
  
  const ext = path.extname(relativePath);
  const base = path.basename(relativePath, ext);
  const dir = path.dirname(relativePath);
  
  return path.join(THUMBNAILS_DIR, dir, `thumb_${base}${ext}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});