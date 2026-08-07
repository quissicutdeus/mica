-- Generated from the 'photos' defineService declaration.
-- Do not edit by hand; change the declaration and regenerate.

CREATE TABLE IF NOT EXISTS `gphone_media` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `kind` ENUM('photo', 'video', 'audio', 'gif', 'sticker', 'file', 'link') NOT NULL DEFAULT 'photo',
    `data` mediumtext DEFAULT NULL,
    `url` varchar(512) DEFAULT NULL,
    `thumbnail` mediumtext DEFAULT NULL,
    `mime_type` varchar(64) DEFAULT NULL,
    `width` int(11) DEFAULT NULL,
    `height` int(11) DEFAULT NULL,
    `duration_ms` int(11) DEFAULT NULL,
    `byte_size` int(11) DEFAULT NULL,
    `alt_text` varchar(255) DEFAULT NULL,
    `status` ENUM('active', 'deleted', 'moderated') NOT NULL DEFAULT 'active',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `status` (`status`),
    KEY `citizenid_status` (`citizenid`, `status`),
    KEY `citizenid_status_created` (`citizenid`, `status`, `created_at`),
    CONSTRAINT `fk_photos_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
