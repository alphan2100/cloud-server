# Music Player API — Dokumentasi Lengkap

> Backend API untuk music player dengan metadata scraping dari MusicBrainz + Cover Art Archive.
> Database: SQLite (`music.db`) untuk metadata audio, playlist, favorite, play history.

## Daftar Isi

- [Setup](#setup)
- [Autentikasi](#autentikasi)
- [Endpoint Music](#endpoint-music)
- [Endpoint Playlist](#endpoint-playlist)
- [Endpoint Favorite](#endpoint-favorite)
- [Alur Scan Media](#alur-scan-media)
- [Integrasi Delete](#integrasi-delete)
- [Environment Variables](#environment-variables)
- [Struktur Database](#struktur-database)
- [Penamaan File Audio](#penamaan-file-audio)

---

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

Server berjalan di `http://localhost:3000`.

---

## Autentikasi

**Semua endpoint music player memerlukan autentikasi JWT.**

Tambahkan header berikut di setiap request:

```
Authorization: Bearer <token>
```

Token didapat dari endpoint `POST /auth/login`.

---

## Endpoint Music

Base URL: `/music`

### 1. Scan Media

Trigger scan metadata audio. Scan berjalan di background, return `job_id` untuk cek status.

```http
POST /music/scan
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**

```json
// Opsi 1: Scan file tertentu
{
  "file_ids": [1, 2, 3]
}

// Opsi 2: Scan semua audio file (incremental — skip yang sudah ter-scan)
{
  "scan_all": true
}
```

**Response (202 Accepted):**

```json
{
  "success": true,
  "message": "Scan dimulai",
  "job_id": 5
}
```

---

### 2. Cek Status Scan

Cek progress scan job (untuk progress bar di client).

```http
GET /music/scan/:jobId/status
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 5,
    "user_id": 1,
    "status": "running",
    "total": 10,
    "processed": 5,
    "failed": 0,
    "error": null,
    "started_at": "2026-01-08 00:50:03",
    "completed_at": null,
    "created_at": "2026-01-08 00:50:03",
    "progress": 50
  }
}
```

| Status | Deskripsi |
|--------|-----------|
| `pending` | Job baru dibuat, belum mulai |
| `running` | Sedang memproses |
| `completed` | Selesai (sukses) |
| `failed` | Selesai dengan error |

---

### 3. List Tracks

List semua track milik user dengan pagination & filter.

```http
GET /music/tracks?page=1&limit=50&artist_id=1&album_id=2&search=love
Authorization: Bearer <token>
```

**Query Params:**

| Param | Tipe | Default | Deskripsi |
|-------|------|---------|-----------|
| `page` | number | 1 | Halaman |
| `limit` | number | 50 | Item per halaman (max 200) |
| `artist_id` | number | - | Filter by artist |
| `album_id` | number | - | Filter by album |
| `search` | string | - | Search di title/artist/album |

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "file_id": 4932,
      "mbid": null,
      "title": "Solo",
      "artist_id": 1,
      "album_id": 1,
      "duration": 223,
      "track_number": null,
      "genre": null,
      "year": null,
      "bitrate": null,
      "file_path": "/path/to/file.mp3",
      "scanned_at": "2026-01-08 00:57:06",
      "deleted_at": null,
      "created_at": "2026-01-08 00:57:06",
      "artist_name": "Clean Bandit",
      "album_title": "Unknown Album",
      "album_cover_path": "/path/to/cover.jpg",
      "is_favorite": 0
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 7,
    "totalPages": 1,
    "hasMore": false
  }
}
```

---

### 4. Get Track Detail

Detail satu track dengan info artist & album.

```http
GET /music/tracks/:id
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "user_id": 1,
    "file_id": 4932,
    "mbid": null,
    "title": "Solo",
    "artist_id": 1,
    "album_id": 1,
    "duration": 223,
    "artist_name": "Clean Bandit",
    "artist_mbid": null,
    "album_title": "Unknown Album",
    "album_mbid": null,
    "album_cover_path": "/path/to/cover.jpg",
    "album_release_date": null
  }
}
```

---

### 5. Re-scan Track

Re-fetch metadata untuk satu track (jika nama file sudah diperbaiki).

```http
POST /music/tracks/:id/rescan
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "message": "Track berhasil di-rescan",
  "data": {
    "success": true,
    "trackId": 1,
    "updated": true
  }
}
```

---

### 6. Get Cover Art

Serve cover image untuk track (album cover).

```http
GET /music/tracks/:id/cover
Authorization: Bearer <token>
```

**Response:** `image/jpeg` (binary)

```http
Content-Type: image/jpeg
Cache-Control: public, max-age=86400
```

---

### 7. Record Play

Catat play history (dipanggil saat user memutar lagu di client).

```http
POST /music/tracks/:id/play
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "message": "Play recorded"
}
```

---

### 8. Search

Search track/artist/album.

```http
GET /music/search?q=bohemian&page=1&limit=20
Authorization: Bearer <token>
```

**Query Params:**

| Param | Tipe | Default | Deskripsi |
|-------|------|---------|-----------|
| `q` | string | **wajib** | Query search (min 1 karakter) |
| `page` | number | 1 | Halaman |
| `limit` | number | 20 | Item per halaman (max 100) |

**Response:** Same format as List Tracks.

---

### 9. List Albums

List semua album milik user.

```http
GET /music/albums?page=1&limit=50
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 4,
      "mbid": "dafabb82-d84f-43a9-9682-369cccc0a471",
      "title": "Kausalnexus",
      "release_date": null,
      "cover_path": "/path/to/cover.jpg",
      "artist_name": "Pharmakustik",
      "track_count": 1
    }
  ]
}
```

---

### 10. Get Album Detail

Detail album + semua tracks di dalamnya.

```http
GET /music/albums/:id
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 4,
    "mbid": "dafabb82-d84f-43a9-9682-369cccc0a471",
    "title": "Kausalnexus",
    "artist_id": 4,
    "artist_name": "Pharmakustik",
    "cover_path": "/path/to/cover.jpg",
    "tracks": [...]
  }
}
```

---

### 11. List Artists

List semua artist milik user.

```http
GET /music/artists?page=1&limit=50
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 4,
      "mbid": "436c4cbc-2035-4091-9d43-451357c97652",
      "name": "Pharmakustik",
      "track_count": 1
    }
  ]
}
```

---

### 12. Get Artist Detail

Detail artist + semua tracks miliknya.

```http
GET /music/artists/:id
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 4,
    "mbid": "436c4cbc-2035-4091-9d43-451357c97652",
    "name": "Pharmakustik",
    "tracks": [...]
  }
}
```

---

### 13. Recently Played

List track yang baru saja diputar.

```http
GET /music/recent?limit=20
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Solo",
      "artist_name": "Clean Bandit",
      "album_title": "Unknown Album",
      "album_cover_path": "/path/to/cover.jpg",
      "played_at": "2026-01-08 01:00:00"
    }
  ]
}
```

---

### 14. Most Played

List track yang paling sering diputar.

```http
GET /music/most-played?limit=20
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Solo",
      "artist_name": "Clean Bandit",
      "album_title": "Unknown Album",
      "album_cover_path": "/path/to/cover.jpg",
      "play_count": 15
    }
  ]
}
```

---

## Endpoint Playlist

Base URL: `/playlists`

### 1. List Playlists

List semua playlist milik user.

```http
GET /playlists
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "name": "My Favorites",
      "description": "Lagu favorit saya",
      "cover_path": null,
      "created_at": "2026-01-08 01:00:00",
      "updated_at": "2026-01-08 01:00:00",
      "track_count": 5
    }
  ]
}
```

---

### 2. Create Playlist

Buat playlist baru (opsional: langsung tambah tracks).

```http
POST /playlists
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**

```json
{
  "name": "My Playlist",
  "description": "Deskripsi playlist (opsional)",
  "track_ids": [1, 2, 3]
}
```

**Response (201 Created):**

```json
{
  "success": true,
  "message": "Playlist berhasil dibuat",
  "data": {
    "id": 2,
    "user_id": 1,
    "name": "My Playlist",
    "description": "Deskripsi playlist (opsional)"
  },
  "added_tracks": 3
}
```

---

### 3. Get Playlist Detail

Detail playlist + semua tracks di dalamnya (urut by position).

```http
GET /playlists/:id
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "My Favorites",
    "description": "Lagu favorit saya",
    "tracks": [
      {
        "id": 1,
        "title": "Solo",
        "artist_name": "Clean Bandit",
        "album_title": "Unknown Album",
        "album_cover_path": "/path/to/cover.jpg",
        "duration": 223,
        "position": 1,
        "added_at": "2026-01-08 01:00:00",
        "is_favorite": 1
      }
    ]
  }
}
```

---

### 4. Update Playlist

Update nama atau deskripsi playlist.

```http
PUT /playlists/:id
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**

```json
{
  "name": "New Name",
  "description": "New description"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Playlist berhasil diupdate",
  "updated": true
}
```

---

### 5. Delete Playlist

Hapus playlist (CASCADE: semua track di dalamnya ikut terhapus).

```http
DELETE /playlists/:id
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "message": "Playlist berhasil dihapus"
}
```

---

### 6. Add Tracks to Playlist

Tambah satu atau multiple tracks ke playlist.

```http
POST /playlists/:id/tracks
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**

```json
// Multiple tracks
{
  "track_ids": [4, 5, 6]
}

// Single track
{
  "track_id": 4
}
```

**Response:**

```json
{
  "success": true,
  "message": "3 track berhasil ditambahkan ke playlist",
  "added": 3
}
```

> **Note:** Jika track sudah ada di playlist, akan di-skip (unique constraint).

---

### 7. Remove Track from Playlist

Hapus track dari playlist. Position akan otomatis di-reorder.

```http
DELETE /playlists/:id/tracks/:trackId
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "message": "Track berhasil dihapus dari playlist"
}
```

---

### 8. Reorder Tracks

Ubah urutan tracks di playlist.

```http
PUT /playlists/:id/reorder
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**

```json
{
  "track_ids": [3, 1, 2, 5, 4]
}
```

> Array berisi track_id dalam urutan baru.

**Response:**

```json
{
  "success": true,
  "message": "Urutan track berhasil diupdate"
}
```

---

## Endpoint Favorite

Base URL: `/favorites`

### 1. List Favorites

List semua track favorit milik user.

```http
GET /favorites?page=1&limit=50
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Solo",
      "artist_name": "Clean Bandit",
      "album_title": "Unknown Album",
      "album_cover_path": "/path/to/cover.jpg",
      "duration": 223,
      "favorited_at": "2026-01-08 01:00:00"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 5,
    "totalPages": 1,
    "hasMore": false
  }
}
```

---

### 2. Toggle Favorite

Tambah atau hapus favorite (toggle).

```http
POST /favorites/:trackId
Authorization: Bearer <token>
```

**Response:**

```json
// Jika baru ditambahkan
{
  "success": true,
  "message": "Track ditambahkan ke favorite",
  "is_favorite": true
}

// Jika dihapus
{
  "success": true,
  "message": "Track dihapus dari favorite",
  "is_favorite": false
}
```

---

### 3. Remove Favorite

Hapus track dari favorite.

```http
DELETE /favorites/:trackId
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "message": "Favorite dihapus",
  "removed": true
}
```

---

### 4. Check Favorite

Cek apakah track sudah difavoritkan.

```http
GET /favorites/check/:trackId
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "is_favorite": true
}
```

---

## Alur Scan Media

### Cara Kerja Scan

```
1. Client: POST /music/scan { scan_all: true }
   ↓
2. Backend: Buat scan_job (status: running)
   ↓
3. Return job_id ke client (client bisa poll status)
   ↓
4. Background process per file:
   a. Parse filename → "Artist - Title.ext" → artist, title
   b. Query MusicBrainz API (search by artist + title)
      → Jika ketemu: ambil metadata lengkap (MBID, album, genre, duration)
      → Jika tidak ketemu: coba search by title only
      → Jika masih tidak ketemu: simpan filename as title, Unknown Artist/Album
   c. Download cover dari Cover Art Archive (jika ada album MBID)
      → Jika tidak ada: generate placeholder cover
   d. Upsert artist, album, track di music.db
   e. Update scan_job progress
   ↓
5. Client: GET /music/scan/:jobId/status → { progress: 50% }
   ↓
6. Selesai → Client refresh track list
```

### Contoh Kode Client (JavaScript)

```javascript
const API_BASE = 'http://localhost:3000';
const token = localStorage.getItem('token');

const api = axios.create({
  baseURL: API_BASE,
  headers: { Authorization: `Bearer ${token}` },
});

// 1. Trigger scan
async function startScan() {
  const { data } = await api.post('/music/scan', { scan_all: true });
  const jobId = data.job_id;
  console.log('Scan started, job_id:', jobId);

  // 2. Poll status
  pollScanStatus(jobId);
}

// 2. Poll status sampai selesai
async function pollScanStatus(jobId) {
  const { data } = await api.get(`/music/scan/${jobId}/status`);
  const job = data.data;

  console.log(`Progress: ${job.progress}% (${job.processed}/${job.total})`);

  if (job.status === 'running') {
    setTimeout(() => pollScanStatus(jobId), 2000); // poll tiap 2 detik
  } else {
    console.log('Scan selesai!', job);
    await loadTracks(); // refresh track list
  }
}

// 3. Load tracks
async function loadTracks() {
  const { data } = await api.get('/music/tracks?limit=50');
  console.log('Tracks:', data.data);
}

// 4. Play track (record play history)
async function playTrack(trackId) {
  await api.post(`/music/tracks/${trackId}/play`);
  // Stream audio via existing endpoint
  window.open(`${API_BASE}/files/${fileId}/view?token=${token}`);
}

// 5. Toggle favorite
async function toggleFavorite(trackId) {
  const { data } = await api.post(`/favorites/${trackId}`);
  console.log('Favorite:', data.is_favorite);
}

// 6. Create playlist
async function createPlaylist(name, trackIds) {
  const { data } = await api.post('/playlists', {
    name,
    track_ids: trackIds,
  });
  console.log('Playlist created:', data.data);
}
```

---

## Integrasi Delete

Saat file audio dihapus, `music.db` otomatis sync:

| Aksi | MySQL (`files`) | SQLite (`music.db`) |
|------|-----------------|---------------------|
| **Soft delete** (pindah ke trash) | `deleted_at = NOW()` | `tracks.deleted_at = datetime('now')` |
| **Restore** dari trash | `deleted_at = NULL` | `tracks.deleted_at = NULL` |
| **Permanent delete** (single file) | `DELETE FROM files` | `DELETE FROM tracks` (CASCADE: playlist_tracks, favorites, play_history) |
| **Permanent delete** (folder) | `DELETE FROM folders` | `DELETE FROM tracks` untuk semua file di folder |
| **Empty trash** | Delete all trashed files | `DELETE FROM tracks` untuk semua file yang di-empty |

> **Note:** Track yang di-soft-delete tidak akan muncul di list tracks, playlist, favorite, atau play history. Tapi data tetap ada di DB (bisa di-restore).

---

## Environment Variables

Tambahkan di `.env`:

```env
# Music DB (SQLite) - untuk metadata audio, playlist, favorite
MUSIC_DB_PATH=./music.db
MUSIC_COVERS_DIR=./music_covers
MUSICBRAINZ_USER_AGENT=CloudStorage/1.0 (cloud-storage-app)
```

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `MUSIC_DB_PATH` | `./music.db` | Path ke file SQLite music DB |
| `MUSIC_COVERS_DIR` | `./music_covers` | Directory untuk menyimpan album cover art |
| `MUSICBRAINZ_USER_AGENT` | `CloudStorage/1.0 (cloud-storage-app)` | User-Agent untuk MusicBrainz API (wajib) |

---

## Struktur Database

### Tabel di `music.db` (SQLite)

| Tabel | Fungsi |
|-------|--------|
| `artists` | Data artist (dengan MusicBrainz MBID) |
| `albums` | Data album + path cover art |
| `tracks` | Metadata audio (relasi ke MySQL `files.id` via `file_id`) |
| `playlists` | Playlist user |
| `playlist_tracks` | Junction table playlist ↔ tracks (dengan position) |
| `favorites` | Favorite tracks user (unique: user_id + track_id) |
| `play_history` | Riwayat play untuk "Recently Played" & "Most Played" |
| `scan_jobs` | Tracking progress scan media |

### Relasi

```
users (MySQL) ──┐
                ├── tracks ──┬── artists
files (MySQL) ──┘            └── albums ──┬── cover_path (disk)
                                          └── cover_url (Cover Art Archive)

playlists ──┬── playlist_tracks ── tracks
            └── user_id (MySQL users)

favorites ──┬── track_id ── tracks
            └── user_id (MySQL users)

play_history ──┬── track_id ── tracks
               └── user_id (MySQL users)

scan_jobs ── user_id (MySQL users)
```

---

## Penamaan File Audio

Karena metadata hanya diambil dari **MusicBrainz API** (tidak lagi baca ID3 tag dari file), penamaan file sangat penting.

### Format yang Disarankan

```
Artist - Title.ext
```

**Contoh:**

| Nama File | Hasil Parse |
|-----------|-------------|
| `Clean Bandit - Solo.mp3` | artist="Clean Bandit", title="Solo" |
| `Melanie Martinez - Play Date.mp3` | artist="Melanie Martinez", title="Play Date" |
| `Lewis Capaldi - Someone You Loved.mp3` | artist="Lewis Capaldi", title="Someone You Loved" |
| `Kangen Band - Terbang Bersamaku.mp3` | artist="Kangen Band", title="Terbang Bersamaku" |

### Keyword yang Otomatis Dihapus

Sistem otomatis membersihkan keyword YouTube umum dari title:

- `official lyric video`, `official audio`, `official video`, `official music video`
- `lyric video`, `lyrics video`, `lyrics`
- `audio`, `mv`, `m/v`
- `ft.`, `feat.`, `feat`
- `hd`, `hq`, `4k`
- `ftujiy`

**Contoh:**

| Nama File | Hasil Parse |
|-----------|-------------|
| `Clean Bandit - Solo (Lyrics) Ft. Demi Lovato.mp3` | artist="Clean Bandit", title="Solo" |
| `Lewis Capaldi - Someone You Loved (Lyrics).mp3` | artist="Lewis Capaldi", title="Someone You Loved" |

### Jika Tidak Ada " - " di Filename

Jika filename tidak mengandung " - ", maka seluruh filename menjadi title dan artist = "Unknown Artist".

| Nama File | Hasil Parse |
|-----------|-------------|
| `Solo.mp3` | artist=null, title="Solo" |
| `melanie-martinez-play-date.mp3` | artist=null, title="melanie-martinez-play-date" |

> **Tip:** Untuk hasil terbaik, rename file dengan format `Artist - Title.ext` sebelum scan.

### Re-scan Setelah Rename

Jika user sudah rename file, jalankan re-scan:

```http
POST /music/scan { scan_all: true }
```

Atau re-scan single track:

```http
POST /music/tracks/:id/rescan
```

---

## Rate Limiting

- **MusicBrainz API**: 1 request per detik (sesuai aturan MusicBrainz)
- **Server API**: 2000 request per 15 menit (lenient limiter untuk `/music`, `/playlists`, `/favorites`)

> **Note:** Scan 100 file = ~2 menit (karena rate limit MusicBrainz). Progress bisa di-track via scan job.

---

## Error Response

Semua endpoint mengembalikan error dengan format:

```json
{
  "success": false,
  "code": "NOT_FOUND",
  "message": "Track tidak ditemukan"
}
```

| Code | Status | Deskripsi |
|------|--------|-----------|
| `VALIDATION_ERROR` | 422 | Input tidak valid |
| `NOT_FOUND` | 404 | Resource tidak ditemukan |
| `FORBIDDEN` | 403 | Akses ditolak (bukan milik user) |
| `BAD_REQUEST` | 400 | Request tidak valid |
| `UNAUTHORIZED` | 401 | Token tidak valid/expired |