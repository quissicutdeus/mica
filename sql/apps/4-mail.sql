-- Generated from the 'mail' defineService declaration.
-- Do not edit by hand; change the declaration and regenerate.

CREATE TABLE IF NOT EXISTS `gphone_mail` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `sender` varchar(100) NOT NULL,
    `sender_address` varchar(100) DEFAULT NULL,
    `subject` varchar(255) NOT NULL,
    `content` text NOT NULL,
    `read` tinyint(1) NOT NULL DEFAULT 0,
    `status` ENUM('active', 'archived', 'deleted', 'moderated') NOT NULL DEFAULT 'active',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `status` (`status`),
    KEY `citizenid_status` (`citizenid`, `status`),
    KEY `citizenid_status_created` (`citizenid`, `status`, `created_at`),
    KEY `citizenid_read_status` (`citizenid`, `read`, `status`),
    CONSTRAINT `fk_mail_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
