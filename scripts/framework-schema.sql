-- SPDX-FileCopyrightText: 2025 quissicutdeus
--
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Central moderation and accountability ledger.
--
-- Every destructive or state-changing action a player takes on their own content is
-- recorded here by `server/lib/AuditLogger.ts`: deletions, archives, leaving or being
-- removed from a conversation, and moderation. It is append-only — nothing in micaOS
-- updates or deletes a row in this table — so it stays a trustworthy record after the
-- content it refers to has been soft-deleted.
--
-- One action, `viewed`, is not a player acting on their own content at all: it is an
-- admin reading content somebody else reported (MICA-70). It is the one exception to
-- "state-changing" above, and it exists for the same reason the rest of this table
-- does — a read otherwise leaves nothing behind for anyone to be held accountable to.
--
-- `target_table` + `target_id` point at the affected row rather than using a foreign
-- key, on purpose: the log must survive the row it describes, and it spans every app
-- table. That is also why there is no FK on those columns.
--
-- Nor on `citizenid` (MICA-300). It used to reference qb's `players` with ON DELETE CASCADE,
-- which deleted a character's rows inside MariaDB before any report hold could apply; the
-- character-deleted purge and the orphan sweep (`server/lib/orphanSweep.ts`) clean up now.
--
-- `citizenid` is written at qb's width, `players.citizenid`'s 50. `pnpm generate:sql` widens
-- it to 60, `users.identifier`'s, in mica.esx.sql (MICA-289), as it does every declared table.
CREATE TABLE IF NOT EXISTS `mica_audit_logs` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `citizenid` varchar(50) NOT NULL,
    `action` ENUM(
        'archived',
        'unarchived',
        'deleted',
        'left',
        'removed',
        'moderated',
        'unmoderated',
        'viewed'
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
    KEY `citizenid_created` (`citizenid`, `created_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
