#!/usr/bin/env node

/**
 * Cleanup Empty Thumbnail Directories
 *
 * Scans the thumbnails directory recursively and removes any
 * empty directories. This is safe because thumbnail directories
 * are auto-created by generateThumbnail() when needed.
 *
 * Usage:
 *   node scripts/cleanup-thumbnails.js
 *   npm run thumbnails:clean
 */

const fs = require('fs');
const path = require('path');

// Resolve thumbnails directory (sama logic dengan thumbnail.service.js)
const THUMBNAILS_DIR = process.env.THUMBNAILS_DIR
  ? path.resolve(process.env.THUMBNAILS_DIR)
  : path.join(__dirname, '..', 'thumbnails');

/**
 * Walk directory tree from leaves to root.
 * Returns array of all directory paths sorted deepest first.
 */
function walkDirsDeepFirst(dirPath) {
  const dirs = [];

  function walk(currentPath) {
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (e) {
      return; // skip inaccessible dirs
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(currentPath, entry.name);
        walk(fullPath);
        dirs.push(fullPath);
      }
    }
  }

  walk(dirPath);
  // Reverse so deepest dirs come first (leaf-to-root)
  return dirs.reverse();
}

function main() {
  console.log('');
  console.log('🧹 Cleanup thumbnail directories...');
  console.log(`   Target: ${THUMBNAILS_DIR}`);
  console.log('');

  if (!fs.existsSync(THUMBNAILS_DIR)) {
    console.log('   ✅ Thumbnails directory does not exist. Nothing to clean.');
    console.log('');
    return;
  }

  const allDirs = walkDirsDeepFirst(THUMBNAILS_DIR);
  let deletedCount = 0;
  let remainingFiles = 0;

  for (const dirPath of allDirs) {
    try {
      const entries = fs.readdirSync(dirPath);
      if (entries.length === 0) {
        fs.rmdirSync(dirPath);
        console.log(`   📁 ${path.relative(THUMBNAILS_DIR, dirPath)}/  →  kosong, HAPUS`);
        deletedCount++;
      } else {
        remainingFiles += entries.length;
      }
    } catch (e) {
      // Skip if error (e.g. permissions)
    }
  }

  console.log('');
  if (deletedCount === 0) {
    console.log('   ✅ Tidak ada folder kosong ditemukan.');
  } else {
    console.log(`   ✅ Selesai! ${deletedCount} folder dihapus, ${remainingFiles} file thumbnail tersisa.`);
  }
  console.log('');
}

main();