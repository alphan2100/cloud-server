-- Add soft delete columns to folders and files
ALTER TABLE folders ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL;
ALTER TABLE files ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL;

-- Index for trash queries
ALTER TABLE folders ADD INDEX idx_trash_folders (user_id, deleted_at);
ALTER TABLE files ADD INDEX idx_trash_files (user_id, deleted_at);