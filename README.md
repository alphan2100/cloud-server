# Cloud Storage API Documentation

API untuk layanan cloud storage yang menyediakan fitur upload, download, share, search, trash, dan manajemen file/folder.

## 📋 Table of Contents

- [Features](#features)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [Installation & Setup](#installation--setup)
- [Environment Variables](#environment-variables)
- [API Base URL](#api-base-url)
- [Authentication](#authentication)
- [API Endpoints](#api-endpoints)
  - [Health Check](#health-check)
  - [Authentication](#auth)
  - [Folders](#folders)
  - [Files](#files)
  - [Search](#search)
  - [Trash](#trash)
  - [Shares](#shares)
  - [Move](#move)
- [Response Format](#response-format)
- [Error Codes](#error-codes)
- [Rate Limiting](#rate-limiting)
- [Testing](#testing)

---

## ✨ Features

- 🔐 JWT-based Authentication
- 📁 Folder Management (CRUD)
- 📄 File Upload (Single & Multiple)
- 🔍 Search Files & Folders
- 🗑️ Trash Management (Soft Delete & Restore)
- 🔗 Share Files/Folders with Links
- 📦 Move Files & Folders
- ⬇️ Download & Preview Files
- 🚀 Rate Limiting & Security
- 📚 Swagger Documentation

---

## 🛠️ Technology Stack

- **Runtime**: Node.js
- **Framework**: Express.js 5.x
- **Database**: MySQL 2.x
- **Authentication**: JWT (jsonwebtoken)
- **File Upload**: Multer
- **Security**: Helmet, CORS, bcrypt
- **Documentation**: Swagger (swagger-ui-express)
- **Caching**: node-cache

---

## 📁 Project Structure

```
cloud-server/
├── config/
│   ├── db.js                 # Database connection
│   ├── db_init.js            # Database initialization
│   └── swagger.js            # Swagger configuration
├── controllers/
│   ├── auth.controller.js    # Login controller
│   ├── download.controller.js # Download & preview
│   ├── file.controller.js    # File CRUD operations
│   ├── folder.controller.js  # Folder CRUD operations
│   ├── move.controller.js    # Move file/folder
│   ├── search.controller.js  # Search functionality
│   ├── share.controller.js   # Share link management
│   └── trash.controller.js   # Trash operations
├── middlewares/
│   ├── auth.middleware.js    # JWT authentication
│   ├── cache.middleware.js   # Cache management
│   ├── error.middleware.js   # Error handling
│   └── upload.middleware.js  # File upload handling
├── migrations/
│   ├── 001_init.sql
│   ├── 002_users.sql
│   ├── 003_folders.sql
│   ├── 004_files.sql
│   ├── 005_trash.sql
│   ├── 006_shares.sql
│   └── init.js
├── models/
│   ├── file.model.js         # File database operations
│   ├── folder.model.js       # Folder database operations
│   ├── share.model.js        # Share database operations
│   └── user.model.js         # User database operations
├── routes/
│   ├── auth.routes.js        # Auth routes
│   ├── file.routes.js        # File routes
│   ├── folder.routes.js      # Folder routes
│   ├── move.routes.js        # Move routes
│   ├── search.routes.js      # Search routes
│   ├── share.routes.js       # Share routes
│   └── trash.routes.js       # Trash routes
├── seeds/
│   └── seed_user.js          # User seeding
├── uploads/                  # File storage directory
│   └── user_{id}/
│       └── folder_{id}/
├── utils/
├── .env                      # Environment variables
├── package.json
├── server.js                 # Main server file
└── README.md
```

---

## 🚀 Installation & Setup

### Prerequisites

- Node.js (v14+)
- MySQL Server
- npm or yarn

### Installation Steps

1. **Clone repository**
```bash
git clone <repository-url>
cd cloud-server
```

2. **Install dependencies**
```bash
npm install
```

3. **Setup environment variables**
```bash
cp .env.example .env
```

4. **Initialize database**
```bash
npm run db:init
```

5. **Seed user (optional)**
```bash
npm run db:seed
```

6. **Start server**
```bash
# Production
npm start

# Development (with nodemon)
npm run dev
```

Server akan berjalan di `http://localhost:3000`

---

## ⚙️ Environment Variables

Buat file `.env` di root directory:

```env
# Server
PORT=3000
NODE_ENV=development

# Database
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=cloud_storage

# JWT
JWT_SECRET=your_jwt_secret_key_here
JWT_EXPIRES_IN=7d

# File Upload
UPLOADS_DIR=./uploads
MAX_FILE_SIZE=10485760  # 10MB in bytes

# CORS
CORS_ORIGIN=*
```

---

## 🌐 API Base URL

```
Production: https://api.example.com
Development: http://localhost:3000
```

---

## 🔐 Authentication

API menggunakan JWT (JSON Web Token) untuk autentikasi.

### Login

**Endpoint**: `POST /auth/login`

**Headers**:
```
Content-Type: application/json
```

**Request Body**:
```json
{
  "username": "string (required)",
  "password": "string (required)"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "john_doe"
  }
}
```

**Error Response (400)**:
```json
{
  "success": false,
  "message": "Username dan password wajib diisi"
}
```

**Error Response (401)**:
```json
{
  "success": false,
  "message": "Username atau password salah"
}
```

### Using Token

Setelah login, tambahkan token di header untuk request yang memerlukan autentikasi:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## 📡 API Endpoints

### Health Check

#### GET /
Check API status

**Response (200)**:
```json
{
  "success": true,
  "message": "Cloud Storage API berjalan",
  "version": "1.0.0",
  "endpoints": {
    "docs": "/api-docs",
    "auth": "/auth",
    "folders": "/folders",
    "files": "/files",
    "search": "/search",
    "trash": "/trash",
    "shares": "/shares",
    "move": "/move"
  }
}
```

---

### 🔑 Auth

#### POST /auth/login
Login user dan mendapatkan JWT token

**Headers**: `Content-Type: application/json`

**Request Body**:
```json
{
  "username": "john_doe",
  "password": "password123"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "john_doe"
  }
}
```

---

### 📁 Folders

*Semua endpoint memerlukan authentication header*

#### GET /folders
Mendapatkan daftar folder

**Headers**: `Authorization: Bearer {token}`

**Query Parameters**:
- `parent_id` (optional): ID folder parent (default: null = root)

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "parent_id": null,
      "folder_name": "Documents",
      "created_at": "2025-01-15T10:30:00.000Z",
      "updated_at": "2025-01-15T10:30:00.000Z"
    }
  ]
}
```

---

#### POST /folders
Membuat folder baru

**Headers**: 
```
Authorization: Bearer {token}
Content-Type: application/json
```

**Request Body**:
```json
{
  "folder_name": "Documents",
  "parent_id": null
}
```

**Field Descriptions**:
- `folder_name` (required): Nama folder
- `parent_id` (optional): ID folder parent (default: null untuk root)

**Success Response (201)**:
```json
{
  "success": true,
  "message": "Folder berhasil dibuat",
  "folder_id": 5
}
```

**Error Response (409)**:
```json
{
  "success": false,
  "message": "Folder dengan nama tersebut sudah ada",
  "code": "CONFLICT"
}
```

---

#### PATCH /folders/:id
Rename folder

**Headers**: 
```
Authorization: Bearer {token}
Content-Type: application/json
```

**Request Body**:
```json
{
  "folder_name": "New Folder Name"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Folder berhasil diubah"
}
```

---

#### DELETE /folders/:id
Soft delete folder (pindah ke trash)

**Headers**: `Authorization: Bearer {token}`

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Folder dan seluruh isinya dipindahkan ke trash",
  "deleted_ids": [5, 6, 7]
}
```

**Note**: Akan menghapus semua sub-folder dan file di dalamnya secara rekursif

---

### 📄 Files

*Semua endpoint memerlukan authentication header*

#### POST /files/upload
Upload single file

**Headers**: 
```
Authorization: Bearer {token}
Content-Type: multipart/form-data
```

**Form Data**:
- `file` (required): File yang akan diupload
- `folder_id` (optional): ID folder tujuan (default: null = root)

**Success Response (201)**:
```json
{
  "success": true,
  "message": "File berhasil diupload",
  "file_id": 10,
  "file": {
    "original_name": "document.pdf",
    "stored_name": "1782178708848-document.pdf",
    "size": 1048576,
    "mime_type": "application/pdf"
  }
}
```

**Error Response (409)**:
```json
{
  "success": false,
  "message": "File dengan nama yang sama sudah ada di folder ini",
  "code": "CONFLICT"
}
```

---

#### POST /files/upload-multiple
Upload multiple files (max 10 files)

**Headers**: 
```
Authorization: Bearer {token}
Content-Type: multipart/form-data
```

**Form Data**:
- `files` (required): Array of files (max 10)
- `folder_id` (optional): ID folder tujuan

**Success Response (201)**:
```json
{
  "success": true,
  "message": "3 file berhasil diupload",
  "uploaded": [
    {
      "file_id": 11,
      "original_name": "image1.jpg",
      "stored_name": "1782178708849-image1.jpg",
      "size": 512000,
      "mime_type": "image/jpeg"
    }
  ],
  "errors": [
    {
      "file": "duplicate.pdf",
      "error": "Nama file sudah ada"
    }
  ]
}
```

---

#### GET /files
Mendapatkan daftar file

**Headers**: `Authorization: Bearer {token}`

**Query Parameters**:
- `folder_id` (optional): ID folder (default: null = root)

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "folder_id": null,
      "original_filename": "document.pdf",
      "stored_filename": "1782178708848-document.pdf",
      "file_path": "./uploads/user_1/folder_root/1782178708848-document.pdf",
      "file_size": 1048576,
      "mime_type": "application/pdf",
      "uploaded_at": "2025-01-15T10:30:00.000Z",
      "updated_at": "2025-01-15T10:30:00.000Z"
    }
  ]
}
```

---

#### GET /files/:id/download
Download file

**Headers**: `Authorization: Bearer {token}`

**Success Response (200)**: 
- Content-Type: sesuai mime_type file
- Content-Disposition: attachment; filename="{original_filename}"
- Body: Binary file content

---

#### GET /files/:id/view
Preview file (inline view)

**Headers**: `Authorization: Bearer {token}`

**Success Response (200)**:
- Content-Type: sesuai mime_type file
- Content-Disposition: inline
- Body: Binary file content

---

#### PUT /files/:id/rename
Rename file

**Headers**: 
```
Authorization: Bearer {token}
Content-Type: application/json
```

**Request Body**:
```json
{
  "new_name": "new_document.pdf"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "message": "File berhasil di-rename",
  "updated": true,
  "file": {
    "original_name": "new_document.pdf",
    "stored_name": "1782178708850-new_document.pdf"
  }
}
```

---

#### DELETE /files/:id
Soft delete file (pindah ke trash)

**Headers**: `Authorization: Bearer {token}`

**Success Response (200)**:
```json
{
  "success": true,
  "message": "File dipindahkan ke trash"
}
```

---

### 🔍 Search

#### GET /search
Mencari file dan folder

**Headers**: `Authorization: Bearer {token}`

**Query Parameters**:
- `q` (required): Keyword pencarian
- `type` (optional): `all`, `file`, atau `folder` (default: `all`)
- `folder_id` (optional): Filter berdasarkan folder

**Success Response (200)**:
```json
{
  "success": true,
  "query": "document",
  "total": 5,
  "data": [
    {
      "id": 1,
      "name": "document.pdf",
      "type": "file",
      "file_size": 1048576,
      "mime_type": "application/pdf",
      "folder_id": null,
      "created_at": "2025-01-15T10:30:00.000Z",
      "updated_at": "2025-01-15T10:30:00.000Z"
    },
    {
      "id": 2,
      "name": "Documents",
      "type": "folder",
      "file_size": null,
      "mime_type": null,
      "folder_id": null,
      "created_at": "2025-01-15T10:25:00.000Z",
      "updated_at": "2025-01-15T10:25:00.000Z"
    }
  ]
}
```

---

### 🗑️ Trash

*Semua endpoint memerlukan authentication header*

#### GET /trash
Mendapatkan semua item di trash

**Headers**: `Authorization: Bearer {token}`

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 5,
      "folder_name": "Old Folder",
      "type": "folder",
      "deleted_at": "2025-01-16T14:20:00.000Z"
    },
    {
      "id": 10,
      "name": "deleted_file.pdf",
      "type": "file",
      "file_size": 2048000,
      "mime_type": "application/pdf",
      "deleted_at": "2025-01-16T14:15:00.000Z"
    }
  ]
}
```

---

#### POST /trash/restore/:type/:id
Restore item dari trash

**Headers**: `Authorization: Bearer {token}`

**URL Parameters**:
- `type`: `file` atau `folder`
- `id`: ID item

**Success Response (200)**:
```json
{
  "success": true,
  "message": "File berhasil dipulihkan"
}
```

---

#### DELETE /trash/:type/:id
Hapus permanen item dari trash

**Headers**: `Authorization: Bearer {token}`

**URL Parameters**:
- `type`: `file` atau `folder`
- `id`: ID item

**Success Response (200)**:
```json
{
  "success": true,
  "message": "File berhasil dihapus permanen"
}
```

**Note**: Untuk folder, akan menghapus semua sub-folder dan file di dalamnya

---

#### DELETE /trash/empty
Kosongkan seluruh trash

**Headers**: `Authorization: Bearer {token}`

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Trash berhasil dikosongkan"
}
```

**Note**: Akan menghapus semua item di trash secara permanen (file fisik + database)

---

### 🔗 Shares

#### GET /shares/access/:token
Akses item melalui share link (PUBLIC - tanpa auth)

**URL Parameters**:
- `token`: Share token

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "share_info": {
      "permission": "view",
      "created_at": "2025-01-15T10:00:00.000Z",
      "expires_at": "2025-01-22T10:00:00.000Z"
    },
    "item": {
      "id": 1,
      "original_filename": "shared_document.pdf",
      "file_size": 1048576,
      "mime_type": "application/pdf",
      "uploaded_at": "2025-01-15T10:30:00.000Z"
    }
  }
}
```

**Error Response (404)**:
```json
{
  "success": false,
  "message": "Share link tidak valid",
  "code": "NOT_FOUND"
}
```

**Error Response (410)**:
```json
{
  "success": false,
  "message": "Share link telah kedaluwarsa",
  "code": "SHARE_EXPIRED"
}
```

---

#### GET /shares/access/:token/download
Download file melalui share link (PUBLIC - tanpa auth)

**Headers**: None

**URL Parameters**:
- `token`: Share token

**Success Response (200)**:
- Content-Type: sesuai mime_type file
- Content-Disposition: attachment; filename="{original_filename}"
- Body: Binary file content

**Error Response (403)**:
```json
{
  "success": false,
  "message": "Tidak memiliki izin download",
  "code": "FORBIDDEN"
}
```

---

#### GET /shares
Mendapatkan semua share link milik user

**Headers**: `Authorization: Bearer {token}`

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "item_type": "file",
      "item_id": 5,
      "share_token": "abc123xyz",
      "permission": "view",
      "expires_at": "2025-01-22T10:00:00.000Z",
      "created_at": "2025-01-15T10:00:00.000Z"
    }
  ]
}
```

---

#### POST /shares
Buat share link untuk file atau folder

**Headers**: 
```
Authorization: Bearer {token}
Content-Type: application/json
```

**Request Body**:
```json
{
  "item_type": "file",
  "item_id": 5,
  "permission": "view",
  "expires_in_hours": 168
}
```

**Field Descriptions**:
- `item_type` (required): `file` atau `folder`
- `item_id` (required): ID file atau folder
- `permission` (optional): `view`, `download`, atau `edit` (default: `view`)
- `expires_in_hours` (optional): Berapa jam link akan aktif (default: tidak expired)

**Success Response (201)**:
```json
{
  "success": true,
  "message": "Share link berhasil dibuat",
  "data": {
    "id": 1,
    "share_token": "abc123xyz",
    "share_url": "http://localhost:3000/shares/access/abc123xyz",
    "item_type": "file",
    "item_id": 5,
    "permission": "view",
    "expires_at": "2025-01-22T10:00:00.000Z"
  }
}
```

---

#### DELETE /shares/:id
Hapus share link

**Headers**: `Authorization: Bearer {token}`

**URL Parameters**:
- `id`: ID share link

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Share link berhasil dihapus"
}
```

---

### 📦 Move

*Semua endpoint memerlukan authentication header*

#### PUT /move/file/:id
Pindah file ke folder lain

**Headers**: 
```
Authorization: Bearer {token}
Content-Type: application/json
```

**URL Parameters**:
- `id`: ID file yang akan dipindah

**Request Body**:
```json
{
  "target_folder_id": 5
}
```

**Field Descriptions**:
- `target_folder_id`: ID folder tujuan (gunakan `null` untuk memindah ke root)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "File berhasil dipindahkan"
}
```

**Error Response (409)**:
```json
{
  "success": false,
  "message": "File dengan nama yang sama sudah ada di folder tujuan",
  "code": "CONFLICT"
}
```

---

#### PUT /move/folder/:id
Pindah folder ke folder lain

**Headers**: 
```
Authorization: Bearer {token}
Content-Type: application/json
```

**URL Parameters**:
- `id`: ID folder yang akan dipindah

**Request Body**:
```json
{
  "target_parent_id": 3
}
```

**Field Descriptions**:
- `target_parent_id`: ID folder parent tujuan (gunakan `null` untuk memindah ke root)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Folder berhasil dipindahkan"
}
```

**Error Response (400)**:
```json
{
  "success": false,
  "message": "Tidak dapat memindahkan folder ke dalam sub-foldernya sendiri",
  "code": "BAD_REQUEST"
}
```

---

## 📊 Response Format

### Success Response
```json
{
  "success": true,
  "message": "Operasi berhasil",
  "data": {},
  "total": 10
}
```

### Error Response
```json
{
  "success": false,
  "message": "Deskripsi error",
  "code": "ERROR_CODE"
}
```

---

## ⚠️ Error Codes

| Code | Description |
|------|-------------|
| `VALIDATION_ERROR` | Input tidak valid |
| `NOT_FOUND` | Resource tidak ditemukan |
| `FORBIDDEN` | Tidak memiliki akses |
| `CONFLICT` | Konflik (misal: duplikasi nama) |
| `BAD_REQUEST` | Request tidak valid |
| `TOKEN_EXPIRED` | Token JWT telah kedaluwarsa |
| `INVALID_TOKEN` | Token JWT tidak valid |
| `TOO_MANY_REQUESTS` | Rate limit exceeded |
| `SHARE_EXPIRED` | Share link telah kedaluwarsa |

---

## 🚦 Rate Limiting

API memiliki rate limiting untuk mencegah abuse:

- **Auth endpoints**: 20 requests per 15 menit
- **General API**: 200 requests per 15 menit

**Rate Limit Response (429)**:
```json
{
  "success": false,
  "code": "TOO_MANY_REQUESTS",
  "message": "Terlalu banyak permintaan. Silakan coba lagi nanti."
}
```

---

## 📚 Swagger Documentation

API documentation interaktif tersedia di:

```
http://localhost:3000/api-docs
```

JSON spec:
```
http://localhost:3000/api-docs.json
```

---

## 🧪 Testing

### Manual Testing dengan curl

**1. Login**
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "password": "password123"
  }'
```

**2. Create Folder**
```bash
curl -X POST http://localhost:3000/folders \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "folder_name": "Documents",
    "parent_id": null
  }'
```

**3. Upload File**
```bash
curl -X POST http://localhost:3000/files/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@/path/to/file.pdf" \
  -F "folder_id=1"
```

**4. Get Files**
```bash
curl http://localhost:3000/files?folder_id=1 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**5. Search**
```bash
curl "http://localhost:3000/search?q=document&type=all" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 🔒 Security Features

- **Helmet**: Security headers
- **CORS**: Cross-origin resource sharing
- **Rate Limiting**: Prevent brute force attacks
- **JWT**: Secure authentication
- **bcrypt**: Password hashing
- **Input Validation**: Request validation
- **SQL Injection Protection**: Parameterized queries

---

## 📝 Notes

1. **File Storage**: File disimpan di direktori `uploads/user_{id}/folder_{id}/`
2. **Soft Delete**: File dan folder yang dihapus masuk ke trash (bukan hapus permanen)
3. **Cache**: Menggunakan node-cache untuk performa
4. **Compression**: Response menggunakan gzip compression
5. **Max Upload**: 10MB per file, max 10 files sekaligus

---

## 🤝 Contributing

1. Fork repository
2. Create feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open Pull Request

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

---

## 👨‍💻 Author

**Your Name** - [@yourusername](https://github.com/yourusername)

---

## 📞 Support

For support, email your.email@example.com or create issue di repository.

---

## 🗺️ Roadmap

- [ ] User registration
- [ ] File versioning
- [ ] File sharing dengan password protection
- [ ] Thumbnail generation untuk images
- [ ] File preview untuk documents
- [ ] Bulk operations
- [ ] Storage quota management
- [ ] Activity logs

---

**Last Updated**: 2025
**Version**: 1.0.0