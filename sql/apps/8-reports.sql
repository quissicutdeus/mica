-- Generated from the 'reports' defineServerApp declaration.
-- Do not edit by hand; change the declaration and regenerate.

CREATE TABLE IF NOT EXISTS `gphone_reports` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `target_table` varchar(64) NOT NULL,
    `target_id` int(11) NOT NULL,
    `category` ENUM('spam', 'harassment', 'threats', 'sexual', 'impersonation', 'other') NOT NULL DEFAULT 'other',
    `note` varchar(500) DEFAULT NULL,
    `resolution` ENUM('pending', 'actioned', 'dismissed') NOT NULL DEFAULT 'pending',
    `target_preview` varchar(300) DEFAULT NULL,
    `target_author` varchar(50) DEFAULT NULL,
    `status` ENUM('active', 'deleted') NOT NULL DEFAULT 'active',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `status` (`status`),
    KEY `citizenid_status` (`citizenid`, `status`),
    KEY `resolution_created` (`resolution`, `created_at`),
    KEY `target` (`target_table`, `target_id`),
    CONSTRAINT `fk_reports_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
