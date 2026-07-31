CREATE TABLE shares (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    item_type ENUM('file', 'folder') NOT NULL,
    item_id BIGINT UNSIGNED NOT NULL,
    share_token VARCHAR(64) NOT NULL UNIQUE,
    permission ENUM('view', 'download', 'edit') NOT NULL DEFAULT 'view',
    expires_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_shares_token (share_token),
    INDEX idx_shares_user (user_id)
);