-- Generated from the 'conversations' defineServerApp declaration.
-- Do not edit by hand; change the declaration and regenerate.

CREATE TABLE IF NOT EXISTS `gphone_messages_conversations` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `is_group` tinyint(1) NOT NULL DEFAULT 0,
    `name` varchar(50) DEFAULT NULL,
    `status` ENUM('active', 'archived', 'deleted', 'moderated') NOT NULL DEFAULT 'active',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `status` (`status`),
    KEY `citizenid_status` (`citizenid`, `status`),
    KEY `citizenid_status_updated` (`citizenid`, `status`, `updated_at`),
    KEY `updated_at` (`updated_at`),
    CONSTRAINT `fk_conversations_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `gphone_messages_participants` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `conversation_id` int(11) NOT NULL,
    `citizenid` varchar(50) NOT NULL,
    `role` varchar(20) NOT NULL DEFAULT 'member',
    `status` ENUM('active', 'left', 'removed', 'moderated') NOT NULL DEFAULT 'active',
    `last_read` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `left_at` timestamp DEFAULT NULL,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `status` (`status`),
    KEY `conversation_participant` (`conversation_id`, `citizenid`),
    KEY `citizenid_status` (`citizenid`, `status`),
    KEY `conversation_status` (`conversation_id`, `status`),
    KEY `participant_last_read` (`citizenid`, `last_read`),
    CONSTRAINT `fk_gphone_messages_participants_conversation_id` FOREIGN KEY (`conversation_id`)
        REFERENCES `gphone_messages_conversations` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_gphone_messages_participants_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
