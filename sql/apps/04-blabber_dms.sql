-- Generated from the 'blabber_dms' defineService declaration.
-- Do not edit by hand; change the declaration and regenerate.

CREATE TABLE IF NOT EXISTS `gphone_blabber_dms` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `from_account` int(11) NOT NULL,
    `to_account` int(11) NOT NULL,
    `body` varchar(500) NOT NULL,
    `read_at` timestamp DEFAULT NULL,
    `status` ENUM('active', 'deleted', 'moderated') NOT NULL DEFAULT 'active',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `status` (`status`),
    KEY `citizenid_status` (`citizenid`, `status`),
    KEY `from_to` (`from_account`, `to_account`),
    KEY `to_from` (`to_account`, `from_account`),
    KEY `to_unread` (`to_account`, `read_at`),
    CONSTRAINT `fk_gphone_blabber_dms_from_account` FOREIGN KEY (`from_account`)
        REFERENCES `gphone_accounts` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_gphone_blabber_dms_to_account` FOREIGN KEY (`to_account`)
        REFERENCES `gphone_accounts` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_blabber_dms_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
