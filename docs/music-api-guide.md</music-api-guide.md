# Music Player API Guide

Backend API untuk music player dengan metadata scraping dari MusicBrainz + Cover Art Archive.

## Setup

### 1. Install dependency
```bash
npm install
```

### 2. Build native module (jika error better-sqlite3)
```bash
cd node_modules/better-sqlite3 && npx node-gyp rebuild
```

### 3. Run migrasi music DB (SQLite)
```bash
npm run db:music
```

### 4. Start server
```bash
npm start
```

## Database

- **MySQL**: data utama (users, files, folders)
- **SQLite** (`music.db`): metadata audio, playlist, favorite, play history, scan jobs

### Tabel music.db
| Tabel | Fungsi |
|-------|--------|
| `artists` | Data artist (dengan MusicBrainz MBID) |
| `albums` | Data album + cover art path |
| `tracks` | Metadata audio (relasi ke MySQL `files.id`) |
| `playlists` | Playlist user |
| `playlist_tracks` | Junction table playlist ↔ tracks |
| `favorites` | Favorite tracks user |
| `play_history` | Riwayat play untuk "Recently Played" & "Most Played" |
| `scan_jobs` | Tracking progress scan media |

## API Endpoints

### Music — `/music`

#### Scan Media
```http
POST /music/scan
Authorization: Bearer <token>
Content-Type: application/json

# Scan specific files
{ "file_ids": [1, 2, 3] }

# Scan semua audio file (incremental: skip yang sudah ter-scan)
{ "scan_all": true }
```

Response:
```json
{
  "success": true,
  "message": "Scan dimulai",
  "job_id": 1
}
```

#### Cek Status Scan
```http
GET /music/scan/:jobId/status
Authorization: Bearer <token>
```

Response:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "status": "running",
    "total": 10,
    "processed": 5,
    "failed": 0,
    "progress": 50
  }
}
```

#### List Tracks
```http
GET /music/tracks?page=1&limit=50&artist_id=1&album_id=2&search=love
Authorization: Bearer <token>
```

#### Get Track Detail
```http
GET /music/tracks/:id
Authorization: Bearer <token>
```

#### Re-scan Track
```http
POST /music/tracks/:id/rescan
Authorization: Bearer <token>
```

#### Get Cover Art
```http
GET /music/tracks/:id/cover
Authorization: Bearer <token>
```
Returns: `image/jpeg`

#### Search
```http
GET /music/search?q=bohemian&page=1&limit=20
Authorization: Bearer <token>
```

#### Albums
```http
GET /music/albums
GET /music/albums/:id
Authorization: Bearer <token>
```

#### Artists
```http
GET /music/artists
GET /music/artists/:id
Authorization: Bearer <token>
```

#### Play History
```http
# Record play
POST /music/tracks/:id/play
Authorization: Bearer <token>

# Recently played
GET /music/recent?limit=20

# Most played
GET /music/most-played?limit=20
Authorization: Bearer <token>
```

### Playlists — `/playlists`

```http
# List playlist
GET /playlists

# Buat playlist
POST /playlists
{ "name": "My Playlist", "description": "Desc", "track_ids": [1,2,3] }

# Detail playlist + tracks
GET /playlists/:id

# Update playlist
PUT /playlists/:id
{ "name": "New Name" }

# Hapus playlist
DELETE /playlists/:id

# Tambah track ke playlist
POST /playlists/:id/tracks
{ "track_ids": [4, 5] }
# atau
{ "track_id": 4 }

# Hapus track dari playlist
DELETE /playlists/:id/tracks/:trackId

# Reorder tracks
PUT /playlists/:id/reorder
{ "track_ids": [3, 1, 2] }

Authorization: Bearer <token>
```

### Favorites — `/favorites`

```http
# List favorite
GET /favorites?page=1&limit=50

# Toggle favorite
POST /favorites/:trackId

# Hapus favorite
DELETE /favorites/:trackId

# Cek favorite
GET /favorites/check/:trackId

Authorization: Bearer <token>
```

## Alur Scan Media (Client Side)

```javascript
// 1. Client trigger scan
const { data } = await api.post('/music/scan', { scan_all: true });
const jobId = data.job_id;

// 2. Poll status sampai selesai
const pollStatus = async () => {
  const { data } = await api.get(`/music/scan/${jobId}/status`);
  
  if (data.data.status === 'running') {
    console.log(`Progress: ${data.data.progress}%`);
    setTimeout(pollStatus, 2000); // poll tiap 2 detik
  } else {
    console.log('Scan selesai!', data.data);
    // Refresh track list
    await loadTracks();
  }
};
pollStatus();
```

## Integrasi Delete

Saat file audio dihapus, music.db otomatis sync:

| Aksi | MySQL | music.db |
|------|-------|----------|
| Soft delete (trash) | `files.deleted_at = NOW()` | `tracks.deleted_at = datetime('now')` |
| Restore dari trash | `files.deleted_at = NULL` | `tracks.deleted_at = NULL` |
| Permanent delete | `DELETE FROM files` | `DELETE FROM tracks` (CASCADE: playlist_tracks, favorites, play_history) |
| Empty trash | Delete all trashed files | Delete all trashed tracks |

## Environment Variables

```env
# Music DB (SQLite)
MUSIC_DB_PATH=./music.db
MUSIC_COVERS_DIR=./music_covers
MUSICBRAINZ_USER_AGENT=CloudStorage/1.0 (cloud-storage-app)
```

## Fitur

- ✅ Metadata scraping dari MusicBrainz API + Cover Art Archive
- ✅ Fallback metadata (filename as title, Unknown Artist/Album)
- ✅ Cover art fallback (generate placeholder via sharp)
- ✅ Incremental scan (skip file yang sudah ter-scan)
- ✅ Scan job tracking (progress bar)
- ✅ Re-scan / update metadata single track
- ✅ Playlist CRUD + reorder
- ✅ Favorite toggle
- ✅ Play history (Recently Played, Most Played)
- ✅ Auto-sync delete (soft delete, restore, permanent delete)
- ✅ Rate limit MusicBrainz (1 req/detik)
- ✅ Background processing (scan tidak block request)