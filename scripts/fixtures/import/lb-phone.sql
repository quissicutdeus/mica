-- SPDX-FileCopyrightText: 2026 quissicutdeus
--
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- lb-phone's tables for `micaimport lb-phone` (MICA-233), loaded by scripts/test-schema.js.
--
-- lb-phone is paid and its SQL ships only with the resource, so these CREATE TABLEs are a
-- reconstruction, not upstream. Source: a public community dump of an older lb-phone
-- `phone.sql` (2023-era), cross-read against docs.lbscripts.com. Every table and column
-- name below is from that dump; what is GUESSED is marked inline. Known and likely drift
-- in current versions, which the importer should tolerate rather than require:
--   - GUESSED: current `phone_phones` adds `owner_id` (the player identifier) for unique,
--     item-metadata phones, where `id` is then a phone id. Not modelled: in this fixture
--     phones are not unique, so `id` is the player identifier, as the dump documents.
--   - GUESSED: current `phone_phone_contacts` adds `email`, `address` and `blocked`, which
--     match the ContactData fields in lb-phone's export docs. Not modelled.
--   - The owner of every row is a phone number, never an identifier: resolve it through
--     `phone_phones.phone_number` -> `id`.
--   - `attachments` columns are a JSON array of URL strings (per the dump's comment, and the
--     `attachments?: string[]` of the SendMessage export docs).
--
-- {{OWNER_A}} and {{OWNER_B}} are replaced by the harness with its two seeded characters
-- (qb: CIT_A / CIT_B; ESX: their `users.identifier`), numbers 555-0001 and 555-0002.
-- 555-0404 belongs to no phone and no character: every table has a row owned by it.

CREATE TABLE IF NOT EXISTS `phone_phones` (
  `id` VARCHAR(100) NOT NULL, -- unique phone id with metadata phones, else the player identifier
  `phone_number` VARCHAR(15) NOT NULL,
  `name` VARCHAR(50),
  `pin` VARCHAR(4) DEFAULT NULL,
  `face_id` VARCHAR(100) DEFAULT NULL,
  `settings` LONGTEXT,
  `is_setup` BOOLEAN DEFAULT FALSE,
  `assigned` BOOLEAN DEFAULT FALSE,
  `battery` INT NOT NULL DEFAULT 100,
  PRIMARY KEY (`id`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `phone_photos` (
  `phone_number` VARCHAR(15) NOT NULL,
  `link` VARCHAR(200) NOT NULL,
  `is_video` BOOLEAN DEFAULT FALSE,
  `size` FLOAT NOT NULL DEFAULT 0,
  `timestamp` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`phone_number`, `link`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `phone_twitter_accounts` (
  `display_name` VARCHAR(30) NOT NULL,
  `username` VARCHAR(20) NOT NULL,
  `password` VARCHAR(100) NOT NULL,
  `phone_number` VARCHAR(15) NOT NULL,
  `bio` VARCHAR(100) DEFAULT NULL,
  `profile_image` VARCHAR(200) DEFAULT NULL,
  `profile_header` VARCHAR(200) DEFAULT NULL,
  `pinned_tweet` VARCHAR(50) DEFAULT NULL,
  `verified` BOOLEAN DEFAULT FALSE,
  `follower_count` INT(11) NOT NULL DEFAULT 0,
  `following_count` INT(11) NOT NULL DEFAULT 0,
  `date_joined` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`username`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `phone_twitter_tweets` (
  `id` VARCHAR(50) NOT NULL,
  `username` VARCHAR(20) NOT NULL, -- matches `phone_twitter_accounts.username`
  `content` VARCHAR(280),
  `attachments` TEXT, -- JSON array of URLs
  `reply_to` VARCHAR(50) DEFAULT NULL,
  `like_count` INT(11) DEFAULT 0,
  `reply_count` INT(11) DEFAULT 0,
  `retweet_count` INT(11) DEFAULT 0,
  `timestamp` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `phone_phone_contacts` (
  `contact_phone_number` VARCHAR(15) NOT NULL,
  `firstname` VARCHAR(50) NOT NULL DEFAULT "",
  `lastname` VARCHAR(50) NOT NULL DEFAULT "",
  `profile_image` VARCHAR(200) DEFAULT NULL,
  `favourite` BOOLEAN DEFAULT FALSE,
  `phone_number` VARCHAR(15) NOT NULL, -- the owner: whoever added the contact
  PRIMARY KEY (`contact_phone_number`, `phone_number`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `phone_message_channels` (
  `channel_id` VARCHAR(50) NOT NULL,
  `is_group` BOOLEAN NOT NULL DEFAULT FALSE,
  `name` VARCHAR(50) DEFAULT NULL,
  `last_message` VARCHAR(50) NOT NULL DEFAULT "",
  `last_message_timestamp` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`channel_id`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `phone_message_members` (
  `channel_id` VARCHAR(50) NOT NULL,
  `phone_number` VARCHAR(15) NOT NULL,
  `is_owner` BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (`channel_id`, `phone_number`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `phone_message_messages` (
  `id` VARCHAR(50) NOT NULL,
  `channel_id` VARCHAR(50) NOT NULL,
  `sender` VARCHAR(15) NOT NULL, -- a phone number
  `content` VARCHAR(1000),
  `attachments` TEXT, -- JSON array of URLs
  `timestamp` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `phone_phones` (`id`, `phone_number`, `name`, `is_setup`, `battery`) VALUES
  ('{{OWNER_A}}', '555-0001', 'Alice''s iPhone', TRUE, 88),
  ('{{OWNER_B}}', '555-0002', 'Bob''s iPhone', TRUE, 41);

-- Contacts: the primary key forbids an exact duplicate, so the duplicate-looking row is the
-- same person saved with a differently spaced number. 4 resolvable, 1 unresolvable.
INSERT INTO `phone_phone_contacts`
  (`contact_phone_number`, `firstname`, `lastname`, `profile_image`, `favourite`, `phone_number`) VALUES
  ('555-0002', 'Bob', 'Test', NULL, TRUE, '555-0001'),
  ('5550002', 'Bob', 'Test', NULL, FALSE, '555-0001'),
  ('555-0199', 'Downtown', 'Cab', 'https://cdn.example.com/lb/cab.png', FALSE, '555-0001'),
  ('555-0001', 'Alice', 'Test', NULL, FALSE, '555-0002'),
  ('555-0003', 'No', 'Body', NULL, FALSE, '555-0404');

-- Channel 1: A <-> B, 3 messages, one with an image attachment. Channel 2: A <-> the ghost
-- number, one message the ghost sent.
INSERT INTO `phone_message_channels` (`channel_id`, `is_group`, `name`, `last_message`, `last_message_timestamp`) VALUES
  ('lbchan-1', FALSE, NULL, 'Meet at Legion', '2026-09-25 09:12:00'),
  ('lbchan-2', FALSE, NULL, 'hello?', '2026-09-25 11:00:00');

INSERT INTO `phone_message_members` (`channel_id`, `phone_number`, `is_owner`) VALUES
  ('lbchan-1', '555-0001', TRUE),
  ('lbchan-1', '555-0002', FALSE),
  ('lbchan-2', '555-0404', TRUE),
  ('lbchan-2', '555-0001', FALSE);

INSERT INTO `phone_message_messages` (`id`, `channel_id`, `sender`, `content`, `attachments`, `timestamp`) VALUES
  ('lbmsg-1', 'lbchan-1', '555-0001', 'You up?', '[]', '2026-09-24 21:04:00'),
  ('lbmsg-2', 'lbchan-1', '555-0002', 'Yeah, what''s up', '["https://cdn.example.com/lb/meme.png"]', '2026-09-24 21:05:00'),
  ('lbmsg-3', 'lbchan-1', '555-0001', 'Meet at Legion', NULL, '2026-09-25 09:12:00'),
  ('lbmsg-4', 'lbchan-2', '555-0404', 'hello?', NULL, '2026-09-25 11:00:00');

-- Photos: 3 resolvable (one video), 1 ghost. The primary key forbids an exact duplicate;
-- the duplicate-looking row is the same URL in B's library, which is two rows, not one.
INSERT INTO `phone_photos` (`phone_number`, `link`, `is_video`, `size`, `timestamp`) VALUES
  ('555-0001', 'https://cdn.example.com/lb/sunset.png', FALSE, 1.2, '2026-09-20 18:00:00'),
  ('555-0001', 'https://cdn.example.com/lb/drift.mp4', TRUE, 14.5, '2026-09-21 18:00:00'),
  ('555-0002', 'https://cdn.example.com/lb/sunset.png', FALSE, 1.2, '2026-09-20 18:05:00'),
  ('555-0404', 'https://cdn.example.com/lb/ghost.png', FALSE, 0.3, '2026-09-22 08:00:00');

-- Tweets: 2 resolvable (one with an image), 1 ghost.
INSERT INTO `phone_twitter_accounts` (`display_name`, `username`, `password`, `phone_number`) VALUES
  ('Alice', 'alice_ls', 'x', '555-0001'),
  ('Bob', 'bobby', 'x', '555-0002'),
  ('Ghost', 'ghost', 'x', '555-0404');

INSERT INTO `phone_twitter_tweets` (`id`, `username`, `content`, `attachments`, `like_count`, `timestamp`) VALUES
  ('lbtw-1', 'alice_ls', 'First day in Los Santos', '[]', 2, '2026-09-20 10:00:00'),
  ('lbtw-2', 'bobby', 'Anyone selling a Sultan?', '["https://cdn.example.com/lb/sultan.jpg"]', 0, '2026-09-21 11:00:00'),
  ('lbtw-3', 'ghost', 'boo', NULL, 0, '2026-09-22 12:00:00');
