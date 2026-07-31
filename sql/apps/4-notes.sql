-- Generated from the 'notes' defineServerApp declaration.
-- Do not edit by hand; change the declaration and regenerate.

CREATE TABLE IF NOT EXISTS `gphone_notes` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `title` varchar(255) DEFAULT NULL,
    `content` text DEFAULT NULL,
    `status` ENUM('active', 'archived', 'deleted', 'moderated') NOT NULL DEFAULT 'active',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `status` (`status`),
    KEY `citizenid_status` (`citizenid`, `status`),
    KEY `citizenid_status_updated` (`citizenid`, `status`, `updated_at`),
    CONSTRAINT `fk_notes_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
