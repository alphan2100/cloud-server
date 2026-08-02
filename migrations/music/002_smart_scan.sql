-- Migration: Smart Scan - tambah kolom metadata_source, user_corrected, feat_artist
-- Tanggal: 2026-08-08

-- Tambah kolom ke tracks table
ALTER TABLE tracks ADD COLUMN metadata_source TEXT DEFAULT 'filename';
-- Nilai: 'filename', 'itunes', 'musicbrainz', 'user_corrected'

ALTER TABLE tracks ADD COLUMN user_corrected INTEGER DEFAULT 0;
-- 0 = belum dikoreksi user, 1 = sudah dikoreksi (skip auto-rescan)

ALTER TABLE tracks ADD COLUMN feat_artist TEXT;
-- Featured artist (jika ada, e.g., "Demi Lovato")

ALTER TABLE tracks ADD COLUMN preview_url TEXT;
-- iTunes preview URL (30s sample)

-- Tambah index untuk query yang lebih cepat
CREATE INDEX IF NOT EXISTS idx_tracks_metadata_source ON tracks(metadata_source);
CREATE INDEX IF NOT EXISTS idx_tracks_user_corrected ON tracks(user_corrected);