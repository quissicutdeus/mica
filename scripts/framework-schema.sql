-- Central moderation and accountability ledger.
--
-- Every destructive or state-changing action a player takes on their own content is
-- recorded here by `server/lib/AuditLogger.ts`: deletions, archives, leaving or being
-- removed from a conversation, and moderation. It is append-only — nothing in gPhone
-- updates or deletes a row in this table — so it stays a trustworthy record after the
-- content it refers to has been soft-deleted.
--
-- `target_table` + `target_id` point at the affected row rather than using a foreign
-- key, on purpose: the log must survive the row it describes, and it spans every app
-- table. That is also why there is no FK on those columns.
CREATE TABLE IF NOT EXISTS `gphone_audit_logs` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `action` ENUM(
        'archived',
        'unarchived',
        'deleted',
        'left',
        'removed',
        'moderated',
        'unmoderated'
    ) NOT NULL,
    `service` varchar(100) NOT NULL,
    `method` varchar(100) NOT NULL,
    `target_id` int(11) NOT NULL,
    `target_table` varchar(100) DEFAULT NULL,
    `details` text DEFAULT NULL,
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `citizenid` (`citizenid`),
    KEY `action` (`action`),
    KEY `service_method` (`service`, `method`),
    KEY `target` (`target_table`, `target_id`),
    -- Moderation review reads newest-first for one player.
    KEY `citizenid_created` (`citizenid`, `created_at`),
    CONSTRAINT `fk_audit_logs_citizenid` FOREIGN KEY (`citizenid`) REFERENCES `players` (`citizenid`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
