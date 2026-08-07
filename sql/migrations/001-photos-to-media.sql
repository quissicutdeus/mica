-- gPhone migration 001: gphone_photos -> gphone_media
--
-- RUN THIS INSTEAD OF `sql/apps/10-photos.sql` IF YOU ALREADY HAVE A gphone_photos TABLE.
-- BACK UP FIRST. This renames a table and a column in place; there is no undo.
--
-- Why: the old table had exactly one payload column, `image mediumtext` holding base64,
-- which can only ever be a photo. That is what blocked voice clips, video with a poster
-- frame, hotlinked GIFs, file transfer and link previews. The rename is a consequence of
-- needing more than one storage shape, not a tidying exercise.
--
-- The gPhone app and service are still called `photos`. Only the table moved.
--
-- ---------------------------------------------------------------------------------------
-- If you skip this file and run `sql/apps/10-photos.sql` instead, you get an EMPTY
-- `gphone_media` and your entire gallery stays stranded in `gphone_photos`. Nothing is
-- deleted, but every player's photos vanish from the phone. `SchemaMigrator` prints
-- "table does not exist - run the file in sql/apps/" when `gphone_media` is missing, which
-- is the right advice for a fresh install and the wrong advice for an upgrade. This file
-- is the upgrade.
--
-- Afterwards, run `gphoneschema` in the server console. It reports the difference between
-- what the code expects and what the database has, without changing anything, so it is the
-- safe way to confirm this landed before trusting it.
-- ---------------------------------------------------------------------------------------

RENAME TABLE `gphone_photos` TO `gphone_media`;

-- Nullable now, where `image` was NOT NULL: a hotlinked GIF or a link preview has a `url`
-- and no bytes at all. Existing rows are unaffected -- widening to NULL keeps every value.
ALTER TABLE `gphone_media` CHANGE `image` `data` mediumtext NULL DEFAULT NULL;

-- The enum is deliberately over-provisioned. gPhone's schema migrator is additive-only,
-- and widening an enum is a type change it will print for a human rather than apply -- so
-- every value left out now would cost another hand-written migration later.
ALTER TABLE `gphone_media`
    ADD COLUMN `kind` ENUM('photo', 'video', 'audio', 'gif', 'sticker', 'file', 'link')
        NOT NULL DEFAULT 'photo' AFTER `citizenid`,
    ADD COLUMN `url` varchar(512) DEFAULT NULL AFTER `data`,
    ADD COLUMN `thumbnail` mediumtext DEFAULT NULL AFTER `url`,
    ADD COLUMN `mime_type` varchar(64) DEFAULT NULL AFTER `thumbnail`,
    ADD COLUMN `width` int(11) DEFAULT NULL AFTER `mime_type`,
    ADD COLUMN `height` int(11) DEFAULT NULL AFTER `width`,
    ADD COLUMN `duration_ms` int(11) DEFAULT NULL AFTER `height`,
    ADD COLUMN `byte_size` int(11) DEFAULT NULL AFTER `duration_ms`,
    ADD COLUMN `alt_text` varchar(255) DEFAULT NULL AFTER `byte_size`;

-- Everything already in there is a camera capture, and the column default only applies to
-- rows inserted after it existed.
UPDATE `gphone_media` SET `kind` = 'photo' WHERE `kind` IS NULL;

-- ---------------------------------------------------------------------------------------
-- The two tables that store the table name as a STRING.
--
-- `gphone_reports.target_table` and `gphone_audit_logs.target_table` are deliberately not
-- foreign keys -- a report and an audit entry have to outlive the content they describe,
-- which is the entire point once that content has been moderated away. The cost is that a
-- rename does not reach them, and the moderation queue interpolates that value to build a
-- preview. Without these two statements every historical photo report points at a table
-- that no longer exists, and gPhone no longer accepts the old name, so those rows become
-- unreviewable rather than merely stale.
-- ---------------------------------------------------------------------------------------

UPDATE `gphone_reports`    SET `target_table` = 'gphone_media' WHERE `target_table` = 'gphone_photos';
UPDATE `gphone_audit_logs` SET `target_table` = 'gphone_media' WHERE `target_table` = 'gphone_photos';

-- The attachment foreign key follows the rename automatically -- MySQL rewrites a
-- constraint's target when the referenced table is renamed with RENAME TABLE, so
-- `gphone_messages_attachments.photo_id` still points at the right rows. Confirm with:
--
--   SELECT REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
--    WHERE TABLE_NAME = 'gphone_messages_attachments' AND COLUMN_NAME = 'photo_id';
--
-- It should say `gphone_media`. If your MySQL did not rewrite it, drop and re-add the
-- constraint against `gphone_media` before starting the resource.
