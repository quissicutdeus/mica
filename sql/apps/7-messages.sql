-- Generated from the 'messages' defineService declaration.
-- Do not edit by hand; change the declaration and regenerate.

CREATE TABLE IF NOT EXISTS `gphone_messages` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `conversation_id` int(11) NOT NULL,
    `message` text NOT NULL,
    `status` ENUM('active', 'deleted', 'moderated') NOT NULL DEFAULT 'active',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `status` (`status`),
    KEY `citizenid_status` (`citizenid`, `status`),
    KEY `citizenid` (`citizenid`),
    KEY `conversation_status_created` (`conversation_id`, `status`, `created_at`),
    CONSTRAINT `fk_gphone_messages_conversation_id` FOREIGN KEY (`conversation_id`)
        REFERENCES `gphone_messages_conversations` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_messages_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `gphone_messages_attachments` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `message_id` int(11) NOT NULL,
    `citizenid` varchar(50) NOT NULL,
    `photo_id` int(11) NOT NULL,
    PRIMARY KEY (`id`),
    KEY `message_id` (`message_id`),
    KEY `citizenid` (`citizenid`),
    KEY `photo_id` (`photo_id`),
    CONSTRAINT `fk_gphone_messages_attachments_message_id` FOREIGN KEY (`message_id`)
        REFERENCES `gphone_messages` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_gphone_messages_attachments_citizenid` FOREIGN KEY (`citizenid`)
        REFERENCES `players` (`citizenid`) ON DELETE CASCADE,
    CONSTRAINT `fk_gphone_messages_attachments_photo_id` FOREIGN KEY (`photo_id`)
        REFERENCES `gphone_photos` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
