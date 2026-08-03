-- Generated from the 'blabber' defineService declaration.
-- Do not edit by hand; change the declaration and regenerate.

CREATE TABLE IF NOT EXISTS `gphone_blabber` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `account_id` int(11) NOT NULL,
    `body` varchar(280) NOT NULL,
    `reply_to` int(11) DEFAULT NULL,
    `status` ENUM('active', 'deleted', 'moderated') NOT NULL DEFAULT 'active',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `status` (`status`),
    KEY `citizenid_status` (`citizenid`, `status`),
    KEY `account_id` (`account_id`),
    KEY `reply_to` (`reply_to`),
    CONSTRAINT `fk_gphone_blabber_account_id` FOREIGN KEY (`account_id`)
        REFERENCES `gphone_accounts` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_gphone_blabber_reply_to` FOREIGN KEY (`reply_to`)
        REFERENCES `gphone_blabber` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_blabber_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
