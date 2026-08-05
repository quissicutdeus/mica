-- Generated from the 'accounts' defineService declaration.
-- Do not edit by hand; change the declaration and regenerate.

CREATE TABLE IF NOT EXISTS `gphone_accounts` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `app` varchar(32) NOT NULL,
    `handle` varchar(32) NOT NULL,
    `display_name` varchar(50) DEFAULT NULL,
    `avatar` varchar(255) DEFAULT NULL,
    `bio` varchar(160) DEFAULT NULL,
    `status` ENUM('active', 'deleted', 'moderated') NOT NULL DEFAULT 'active',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `status` (`status`),
    KEY `citizenid_status` (`citizenid`, `status`),
    UNIQUE KEY `app_handle` (`app`, `handle`),
    KEY `citizenid_app` (`citizenid`, `app`),
    CONSTRAINT `fk_accounts_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `gphone_account_follows` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `follower_account_id` int(11) NOT NULL,
    `followee_account_id` int(11) NOT NULL,
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `follower_followee` (`follower_account_id`, `followee_account_id`),
    KEY `followee_account_id` (`followee_account_id`),
    KEY `follower_recent` (`follower_account_id`, `id`),
    CONSTRAINT `fk_gphone_account_follows_follower_account_id` FOREIGN KEY (`follower_account_id`)
        REFERENCES `gphone_accounts` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_gphone_account_follows_followee_account_id` FOREIGN KEY (`followee_account_id`)
        REFERENCES `gphone_accounts` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
