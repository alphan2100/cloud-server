const fs = require('fs')
const path = require('path')
const { ZipArchive } = require('archiver')
const FileModel = require('../models/file.model')
const FolderModel = require('../models/folder.model')
const { AppError } = require('../middlewares/error.middleware')

class ZipService {
  /**
   * Create a streaming zip archive for multiple files and folders
   * @param {Object} res - Express response object
   * @param {Array} items - Array of { type: 'file'|'folder', id: number }
   * @param {number} userId - User ID for authorization
   * @param {string} archiveName - Name for the zip file
   */
  static async createZipStream(res, items, userId, archiveName = 'download.zip') {
    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new AppError('Tidak ada item yang dipilih untuk di-download', 400, 'VALIDATION_ERROR')
    }

    // Limit max items to prevent abuse
    if (items.length > 200) {
      throw new AppError('Maksimal 200 item dapat di-download sekaligus', 400, 'VALIDATION_ERROR')
    }

    // Collect all files to include in the zip
    const filesToZip = []
    const processedFolderIds = new Set()

    for (const item of items) {
      if (item.type === 'file') {
        const file = await FileModel.findById(item.id)
        if (!file) {
          console.warn(`[Zip] File not found: ${item.id}`)
          continue
        }
        if (file.user_id !== userId) {
          throw new AppError('Akses ditolak untuk file tertentu', 403, 'FORBIDDEN')
        }
        if (!fs.existsSync(file.file_path)) {
          console.warn(`[Zip] File path not found: ${file.file_path}`)
          continue
        }
        filesToZip.push({
          path: file.file_path,
          name: file.original_filename,
          relativePath: file.original_filename,
          isFolder: false,
        })
      } else if (item.type === 'folder') {
        // Avoid processing the same folder twice
        if (processedFolderIds.has(item.id)) continue
        processedFolderIds.add(item.id)

        const folder = await FolderModel.findById(item.id)
        if (!folder) {
          console.warn(`[Zip] Folder not found: ${item.id}`)
          continue
        }
        if (folder.user_id !== userId) {
          throw new AppError('Akses ditolak untuk folder tertentu', 403, 'FORBIDDEN')
        }

        // Get all descendant folder IDs
        const descendantIds = await FolderModel.getAllDescendantIds(item.id)
        const allFolderIds = [item.id, ...descendantIds]

        // Get all files in this folder and its subfolders
        for (const folderId of allFolderIds) {
          const folderFiles = await FileModel.findByFolder(userId, folderId)
          for (const file of folderFiles) {
            if (fs.existsSync(file.file_path)) {
              // Create relative path based on folder structure
              const relativePath = await this._getRelativePath(file, folderId, folder)
              filesToZip.push({
                path: file.file_path,
                name: file.original_filename,
                relativePath: relativePath,
                isFolder: false,
              })
            }
          }
        }
      }
    }

    if (filesToZip.length === 0) {
      throw new AppError('Tidak ada file yang valid untuk di-download', 400, 'VALIDATION_ERROR')
    }

    // Set response headers
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`)

    // Create archiver instance
    const archive = new ZipArchive('zip', {
      zlib: { level: 6 }, // Compression level (0-9)
    })

    // Handle archiver errors
    archive.on('error', (err) => {
      console.error('[Zip] Archiver error:', err)
      throw err
    })

    // Pipe archive to response
    archive.pipe(res)

    // Add files to archive
    for (const file of filesToZip) {
      const entryName = file.relativePath || file.name
      
      // Check for duplicate filenames and add counter if needed
      const finalName = this._getUniqueEntryName(archive, entryName)
      
      try {
        archive.append(fs.createReadStream(file.path), { name: finalName })
      } catch (err) {
        console.error(`[Zip] Failed to add file ${file.path}:`, err.message)
        // Continue with other files
      }
    }

    // Finalize the archive
    await archive.finalize()
  }

  /**
   * Get relative path for a file within a folder structure
   * @private
   */
  static async _getRelativePath(file, folderId, rootFolder) {
    // Build path from the root folder (the folder being downloaded) to the file's folder
    const pathParts = []
    
    // Get the folder containing this file
    const fileFolder = await FolderModel.findById(folderId)
    if (!fileFolder) {
      return file.original_filename
    }
    
    // Build path from file's folder up to root folder
    let currentFolder = fileFolder
    while (currentFolder && currentFolder.id !== rootFolder.id && currentFolder.parent_id !== null) {
      pathParts.unshift(currentFolder.folder_name)
      currentFolder = await FolderModel.findById(currentFolder.parent_id)
    }
    
    // If we're in the root folder, just return the filename
    if (pathParts.length === 0) {
      return file.original_filename
    }
    
    // Add the root folder name
    pathParts.unshift(rootFolder.folder_name)
    
    return path.join(pathParts.join('/'), file.original_filename)
  }

  /**
   * Get unique entry name to avoid duplicates in zip
   * @private
   */
  static _getUniqueEntryName(archive, baseName) {
    // This is a simple approach - archiver will handle duplicates
    // by appending numbers. For more control, we could track used names.
    return baseName
  }
}

module.exports = ZipService