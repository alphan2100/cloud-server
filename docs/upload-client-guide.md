# Client Guide: File Upload Implementation

Panduan ini menjelaskan cara mengimplementasikan file upload di client (frontend) menggunakan API yang tersedia di sistem ini.

---

## 📋 Daftar Isi

1. [Overview](#overview)
2. [Kapan Menggunakan Metode Upload](#kapan-menggunakan-metode-upload)
3. [Regular Upload (Single File)](#regular-upload-single-file)
4. [Regular Upload (Multiple Files)](#regular-upload-multiple-files)
5. [Chunked Upload (Large Files)](#chunked-upload-large-files)
6. [Error Handling](#error-handling)
7. [Best Practices](#best-practices)

---

## Overview

Sistem ini menyediakan **2 metode upload**:

| Metode | Endpoint | Use Case | Ukuran File |
|--------|----------|----------|-------------|
| **Regular Upload** | `POST /files/upload` | File kecil-menengah | < 5GB |
| **Chunked Upload** | `POST /files/upload-chunk` | File besar | > 5GB atau koneksi tidak stabil |

---

## Kapan Menggunakan Metode Upload

### Gunakan Regular Upload jika:
- ✅ File ukuran < 5GB
- ✅ Koneksi stabil
- ✅ Upload cepat
- ✅ Tidak butuh resume capability

### Gunakan Chunked Upload jika:
- ✅ File ukuran besar (> 5GB)
- ✅ Koneksi tidak stabil/sering putus
- ✅ Butuh resume jika upload gagal
- ✅ Ingin track progress dengan detail

---

## Regular Upload (Single File)

### Endpoint
```
POST /files/upload
```

### Headers
```javascript
{
  "Authorization": "Bearer {token}",
  "Content-Type": "multipart/form-data"
}
```

### Form Data
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | File yang akan diupload |
| `folder_id` | String/Number | No | ID folder tujuan (default: root) |

### Request Example (JavaScript/Fetch)

```javascript
async function uploadSingleFile(file, folderId, token) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('folder_id', folderId || '');

  const response = await fetch('/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
      // Jangan set Content-Type, browser akan set otomatis dengan boundary
    },
    body: formData
  });

  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(result.message || 'Upload failed');
  }

  return result;
}

// Usage
const fileInput = document.querySelector('#fileInput');
const file = fileInput.files[0];
const token = localStorage.getItem('token');
const folderId = '123'; // atau null untuk root

try {
  const result = await uploadSingleFile(file, folderId, token);
  console.log('Upload success:', result);
} catch (error) {
  console.error('Upload failed:', error.message);
}
```

### Response Success (201 Created)
```json
{
  "success": true,
  "message": "File berhasil diupload",
  "file_id": 123,
  "file": {
    "original_name": "document.pdf",
    "stored_name": "1699123456789-abc123xyz.pdf",
    "size": 1048576,
    "mime_type": "application/pdf"
  }
}
```

### Response Error (409 Conflict - File Already Exists)
```json
{
  "success": false,
  "message": "File already exist",
  "code": "CONFLICT"
}
```

---

## Regular Upload (Multiple Files)

### Endpoint
```
POST /files/upload-multiple
```

### Form Data
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `files` | File[] | Yes | Array of files (max 10 files) |
| `folder_id` | String/Number | No | ID folder tujuan (default: root) |

### Request Example (JavaScript/Fetch)

```javascript
async function uploadMultipleFiles(files, folderId, token) {
  const formData = new FormData();
  
  // Append each file
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i]);
  }
  
  formData.append('folder_id', folderId || '');

  const response = await fetch('/files/upload-multiple', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(result.message || 'Upload failed');
  }

  return result;
}

// Usage
const fileInput = document.querySelector('#fileInput');
const files = Array.from(fileInput.files); // Max 10 files
const token = localStorage.getItem('token');

try {
  const result = await uploadMultipleFiles(files, null, token);
  console.log('Upload success:', result);
} catch (error) {
  console.error('Upload failed:', error.message);
}
```

---

## Chunked Upload (Large Files)

### Overview
Chunked upload memecah file besar menjadi chunk-chunk kecil (5MB per chunk) dan menguploadnya satu per satu. Jika upload terputus, Anda bisa melanjutkan dari chunk terakhir yang berhasil.

### Endpoints
```
POST /files/upload-chunk          - Upload single chunk
GET  /files/upload-status/:hash   - Check upload status
DELETE /files/upload-cancel/:hash - Cancel upload
```

---

### Step 1: Helper Functions

```javascript
// Utility: Calculate file hash (MD5)
async function calculateFileHash(file) {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('MD5', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Utility: Format bytes to human readable
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
```

---

### Step 2: Upload Single Chunk

```javascript
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB (must match server)

async function uploadChunk(chunk, chunkIndex, totalChunks, fileHash, fileName, fileType, totalSize, folderId, token) {
  const formData = new FormData();
  formData.append('chunk', chunk);
  formData.append('chunk_index', chunkIndex);
  formData.append('total_chunks', totalChunks);
  formData.append('file_hash', fileHash);
  formData.append('file_name', fileName);
  formData.append('file_type', fileType);
  formData.append('total_size', totalSize);
  formData.append('folder_id', folderId || '');

  const response = await fetch('/files/upload-chunk', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(result.message || 'Chunk upload failed');
  }

  return result;
}
```

---

### Step 3: Complete Chunked Upload Flow

```javascript
class ChunkedUploader {
  constructor(file, folderId, token, onProgress) {
    this.file = file;
    this.folderId = folderId;
    this.token = token;
    this.onProgress = onProgress; // Callback for progress updates
    
    this.CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
    this.totalChunks = Math.ceil(file.size / this.CHUNK_SIZE);
    this.fileHash = null;
    this.uploadedChunks = new Set(); // Track uploaded chunks
  }

  async init() {
    // Calculate file hash
    this.fileHash = await calculateFileHash(this.file);
    
    // Check if there's existing upload progress
    await this.checkUploadStatus();
    
    return this;
  }

  async checkUploadStatus() {
    const response = await fetch(`/files/upload-status/${this.fileHash}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    const result = await response.json();
    
    if (result.exists && result.progress) {
      // Resume from existing upload
      console.log(`Resuming upload: ${result.progress.percentage}% complete`);
      // Note: Server doesn't return which chunks are uploaded, 
      // so we need to track this in localStorage/sessionStorage
      const savedProgress = localStorage.getItem(`upload_${this.fileHash}`);
      if (savedProgress) {
        this.uploadedChunks = new Set(JSON.parse(savedProgress));
      }
    }
  }

  async upload() {
    try {
      await this.init();

      // Upload each chunk
      for (let i = 0; i < this.totalChunks; i++) {
        // Skip if already uploaded
        if (this.uploadedChunks.has(i)) {
          console.log(`Chunk ${i + 1}/${this.totalChunks} already uploaded, skipping...`);
          continue;
        }

        // Get chunk blob
        const start = i * this.CHUNK_SIZE;
        const end = Math.min(start + this.CHUNK_SIZE, this.file.size);
        const chunk = this.file.slice(start, end);

        // Upload chunk with retry logic
        await this.uploadChunkWithRetry(chunk, i);

        // Mark as uploaded
        this.uploadedChunks.add(i);
        this.saveProgress();

        // Report progress
        const progress = {
          uploaded: this.uploadedChunks.size,
          total: this.totalChunks,
          percentage: Math.round((this.uploadedChunks.size * 100) / this.totalChunks)
        };
        
        if (this.onProgress) {
          this.onProgress(progress);
        }
      }

      // Cleanup progress
      this.clearProgress();

      return {
        success: true,
        message: 'File uploaded successfully',
        fileHash: this.fileHash
      };

    } catch (error) {
      console.error('Upload failed:', error);
      throw error;
    }
  }

  async uploadChunkWithRetry(chunk, chunkIndex, maxRetries = 3) {
    let lastError;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await uploadChunk(
          chunk,
          chunkIndex,
          this.totalChunks,
          this.fileHash,
          this.file.name,
          this.file.type,
          this.file.size,
          this.folderId,
          this.token
        );
        
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`Chunk ${chunkIndex} failed (attempt ${attempt + 1}/${maxRetries}):`, error.message);
        
        // Wait before retry (exponential backoff)
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }
    
    throw lastError;
  }

  saveProgress() {
    localStorage.setItem(`upload_${this.fileHash}`, JSON.stringify([...this.uploadedChunks]));
  }

  clearProgress() {
    localStorage.removeItem(`upload_${this.fileHash}`);
  }

  async cancel() {
    const response = await fetch(`/files/upload-cancel/${this.fileHash}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    const result = await response.json();
    this.clearProgress();
    
    return result;
  }
}
```

---

### Step 4: Usage Example

```javascript
// Usage Example
async function handleFileUpload(file, folderId) {
  const token = localStorage.getItem('token');
  
  // Create uploader instance
  const uploader = new ChunkedUploader(
    file,
    folderId,
    token,
    (progress) => {
      // Update UI with progress
      console.log(`Upload Progress: ${progress.percentage}%`);
      document.getElementById('progressBar').style.width = `${progress.percentage}%`;
      document.getElementById('progressText').textContent = 
        `${progress.uploaded}/${progress.total} chunks (${progress.percentage}%)`;
    }
  );

  try {
    const result = await uploader.upload();
    console.log('Upload complete:', result);
    alert('File uploaded successfully!');
  } catch (error) {
    console.error('Upload failed:', error);
    alert(`Upload failed: ${error.message}`);
  }
}

// Event listener for file input
document.querySelector('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  
  if (file.size > 100 * 1024 * 1024) { // > 100MB
    // Use chunked upload for large files
    await handleFileUpload(file, null);
  } else {
    // Use regular upload for small files
    await uploadSingleFile(file, null, localStorage.getItem('token'));
  }
});
```

---

### Step 5: React Component Example

```jsx
import React, { useState } from 'react';

function FileUploader({ folderId }) {
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState({ uploaded: 0, total: 0, percentage: 0 });
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  const handleFileSelect = (e) => {
    const selectedFile = e.target.files[0];
    setFile(selectedFile);
    setError(null);
  };

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    setError(null);

    const token = localStorage.getItem('token');

    try {
      if (file.size > 100 * 1024 * 1024) {
        // Chunked upload for large files
        const uploader = new ChunkedUploader(
          file,
          folderId,
          token,
          (progress) => setProgress(progress)
        );
        await uploader.upload();
      } else {
        // Regular upload for small files
        const result = await uploadSingleFile(file, folderId, token);
        setProgress({ uploaded: 1, total: 1, percentage: 100 });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <input
        type="file"
        onChange={handleFileSelect}
        disabled={uploading}
      />
      
      {file && (
        <div>
          <p>File: {file.name}</p>
          <p>Size: {formatBytes(file.size)}</p>
          
          <button onClick={handleUpload} disabled={uploading}>
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
        </div>
      )}

      {uploading && (
        <div>
          <div className="progress-bar">
            <div 
              className="progress-fill" 
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
          <p>{progress.percentage}% ({progress.uploaded}/{progress.total} chunks)</p>
        </div>
      )}

      {error && <div className="error">{error}</div>}
    </div>
  );
}

export default FileUploader;
```

---

## Error Handling

### Common Errors

| Error Code | Message | Action |
|------------|---------|--------|
| `VALIDATION_ERROR` | Parameter tidak valid | Check required fields |
| `CONFLICT` | File already exist | Rename file or delete existing |
| `FORBIDDEN` | Akses ditolak | Check folder ownership |
| `NOT_FOUND` | Folder tidak ditemukan | Check folder ID |

### Error Handling Example

```javascript
async function uploadWithErrorHandling(file, folderId, token) {
  try {
    const result = await uploadSingleFile(file, folderId, token);
    return { success: true, data: result };
  } catch (error) {
    console.error('Upload error:', error);
    
    let userMessage = 'Upload failed';
    
    if (error.message.includes('already exist')) {
      userMessage = 'File dengan nama yang sama sudah ada';
    } else if (error.message.includes('Akses ditolak')) {
      userMessage = 'Anda tidak memiliki akses ke folder ini';
    } else if (error.message.includes('tidak ditemukan')) {
      userMessage = 'Folder tidak ditemukan';
    }
    
    return { success: false, error: userMessage };
  }
}
```

---

## Best Practices

### 1. **Choose the Right Upload Method**
```javascript
// Threshold: 100MB
const CHUNKED_UPLOAD_THRESHOLD = 100 * 1024 * 1024;

function getUploadMethod(fileSize) {
  return fileSize > CHUNKED_UPLOAD_THRESHOLD ? 'chunked' : 'regular';
}
```

### 2. **Implement Retry Logic**
```javascript
async function uploadWithRetry(uploadFn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await uploadFn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
    }
  }
}
```

### 3. **Track Progress Locally**
```javascript
// Save progress to localStorage for resume capability
function saveUploadProgress(fileHash, uploadedChunks) {
  localStorage.setItem(`upload_${fileHash}`, JSON.stringify([...uploadedChunks]));
}

function loadUploadProgress(fileHash) {
  const saved = localStorage.getItem(`upload_${fileHash}`);
  return saved ? new Set(JSON.parse(saved)) : new Set();
}
```

### 4. **Validate File Before Upload**
```javascript
function validateFile(file, maxSize = 5 * 1024 * 1024 * 1024) { // 5GB
  if (file.size > maxSize) {
    throw new Error(`File terlalu besar. Maksimal ${formatBytes(maxSize)}`);
  }
  
  // Add more validation as needed
  return true;
}
```

### 5. **Cleanup on Cancel/Error**
```javascript
async function cancelUpload(fileHash, token) {
  const response = await fetch(`/files/upload-cancel/${fileHash}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  // Clear local progress
  localStorage.removeItem(`upload_${fileHash}`);
  
  return response.json();
}
```

---

## 📊 Comparison: Regular vs Chunked Upload

| Feature | Regular Upload | Chunked Upload |
|---------|---------------|----------------|
| **Complexity** | Simple | More complex |
| **File Size Limit** | 5GB | Unlimited (practically) |
| **Resume Capability** | No | Yes |
| **Progress Tracking** | Basic | Detailed (per chunk) |
| **Network Resilience** | Low | High |
| **Server Load** | Lower | Higher (multiple requests) |
| **Use Case** | Small files | Large files |

---

## 🔗 Related Documentation

- [API Documentation](/api-docs)
- [Backend Implementation](../controllers/chunked-upload.controller.js)
- [Upload Middleware](../middlewares/upload.middleware.js)

---

## ❓ FAQ

**Q: Berapa ukuran chunk yang digunakan?**
A: 5MB per chunk (didefinisikan di controller).

**Q: Berapa maksimal ukuran file?**
A: 5GB untuk regular upload, unlimited untuk chunked upload (tergantung storage).

**Q: Apakah upload bisa di-resume jika terputus?**
A: Ya, untuk chunked upload. Gunakan endpoint `GET /files/upload-status/:hash` untuk check progress.

**Q: Bagaimana cara cancel upload?**
A: Kirim request `DELETE /files/upload-cancel/:hash`.

**Q: Apakah ada retry otomatis?**
A: Tidak, retry harus diimplementasikan di client.

---

**Last Updated**: 2026-07-27
**API Version**: 1.0.0