-- Generated from the 'notifications' defineService declaration.
-- Do not edit by hand; change the declaration and regenerate.

CREATE TABLE IF NOT EXISTS `gphone_notifications` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `app` varchar(32) NOT NULL,
    `kind` varchar(32) NOT NULL,
    `title` varchar(80) NOT NULL,
    `body` varchar(255) NOT NULL,
    `avatar` varchar(255) DEFAULT NULL,
    `deep_link` text DEFAULT NULL,
    `read_at` varchar(32) DEFAULT NULL,
    `cleared_at` varchar(32) DEFAULT NULL,
    `status` ENUM('active', 'deleted', 'moderated') NOT NULL DEFAULT 'active',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `status` (`status`),
    KEY `citizenid_status` (`citizenid`, `status`),
    KEY `citizenid_cleared_id` (`citizenid`, `cleared_at`, `id`),
    KEY `citizenid_app_id` (`citizenid`, `app`, `id`),
    KEY `citizenid_read` (`citizenid`, `read_at`),
    CONSTRAINT `fk_notifications_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
