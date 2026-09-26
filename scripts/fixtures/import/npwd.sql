-- SPDX-FileCopyrightText: 2026 quissicutdeus
--
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- NPWD's tables for `micaimport npwd` (MICA-233), loaded by scripts/test-schema.js.
--
-- The CREATE TABLEs are project-error/npwd `import.sql` on master, verbatim but for
-- whitespace, and only the tables the importer reads: contacts, the three message tables,
-- the gallery, and the twitter profiles and tweets (a tweet's owner is its profile's
-- `identifier`; `npwd_twitter_tweets.identifier` is the same value).
--
-- {{OWNER_A}} and {{OWNER_B}} are replaced by the harness with its two seeded characters
-- (qb: the citizenid, which is NPWD's identifier on qb; ESX: `users.identifier`, the
-- multichar shape `char1:<40-hex license>`), numbers 555-0001 and 555-0002. The same
-- string fills every identifier column. GHOST_ID is nobody: every table has a row it owns.
--
-- Best readings, not in the schema file: `conversation_list` is the participants' numbers
-- sorted and joined with '+' (NPWD's `createGroupHashID`); `npwd_messages.conversation_id`
-- holds the conversation's numeric id as a string; `author` is the sender's number and
-- `user_identifier` the sender's identifier.

CREATE TABLE IF NOT EXISTS `npwd_twitter_profiles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `profile_name` varchar(90) NOT NULL,
  `identifier` varchar(48) NOT NULL COLLATE 'utf8mb4_general_ci',
  `avatar_url` varchar(255) DEFAULT 'https://i.fivemanage.com/images/3ClWwmpwkFhL.png',
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `profile_name_UNIQUE` (`profile_name`),
  INDEX `identifier` (`identifier`)
);

CREATE TABLE IF NOT EXISTS `npwd_phone_contacts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `identifier` varchar(48) DEFAULT NULL COLLATE 'utf8mb4_general_ci',
  `avatar` varchar(255) DEFAULT NULL,
  `number` varchar(20) DEFAULT NULL,
  `display` varchar(255) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  INDEX `identifier` (`identifier`)
);

CREATE TABLE `npwd_twitter_tweets` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `message` VARCHAR(1000) NOT NULL COLLATE 'utf8mb4_general_ci',
  `createdAt` TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  `updatedAt` TIMESTAMP NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `likes` INT(11) NOT NULL DEFAULT '0',
  `identifier` VARCHAR(48) NOT NULL COLLATE 'utf8mb4_general_ci',
  `visible` TINYINT(4) NOT NULL DEFAULT '1',
  `images` VARCHAR(1000) NULL DEFAULT '' COLLATE 'utf8mb4_general_ci',
  `retweet` INT(11) NULL DEFAULT NULL,
  `profile_id` INT(11) NOT NULL,
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `npwd_twitter_tweets_npwd_twitter_profiles_id_fk` (`profile_id`) USING BTREE,
  CONSTRAINT `npwd_twitter_tweets_npwd_twitter_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `npwd_twitter_profiles` (`id`) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS `npwd_messages` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `message` varchar(512) NOT NULL COLLATE 'utf8mb4_general_ci',
  `user_identifier` varchar(48) NOT NULL COLLATE 'utf8mb4_general_ci',
  `conversation_id` varchar(512) NOT NULL,
  `isRead` tinyint(4) NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP() ON UPDATE CURRENT_TIMESTAMP,
  `visible` tinyint(4) NOT NULL DEFAULT 1,
  `author` varchar(255) NOT NULL,
  `is_embed` tinyint(4) NOT NULL default 0,
  `embed` varchar(512) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  INDEX `user_identifier` (`user_identifier`)
);

CREATE TABLE `npwd_messages_conversations` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `conversation_list` VARCHAR(225) NOT NULL COLLATE 'utf8mb4_general_ci',
  `label` VARCHAR(60) NULL DEFAULT '' COLLATE 'utf8mb4_general_ci',
  `createdAt` TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  `updatedAt` TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  `last_message_id` INT(11) NULL DEFAULT NULL,
  `is_group_chat` TINYINT(4) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`) USING BTREE
);

CREATE TABLE `npwd_messages_participants` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `conversation_id` INT(11) NOT NULL,
  `participant` VARCHAR(225) NOT NULL COLLATE 'utf8mb4_general_ci',
  `unread_count` INT(11) NULL DEFAULT '0',
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `message_participants_npwd_messages_conversations_id_fk` (`conversation_id`) USING BTREE,
  CONSTRAINT `message_participants_npwd_messages_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `npwd_messages_conversations` (`id`) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS `npwd_phone_gallery` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `identifier` varchar(48) DEFAULT NULL COLLATE 'utf8mb4_general_ci',
  `image` varchar(255) NOT NULL,
  PRIMARY KEY (id),
  INDEX `identifier` (`identifier`)
);

-- Contacts: 4 resolvable, one an exact duplicate of another; 1 unresolvable.
INSERT INTO `npwd_phone_contacts` (`identifier`, `avatar`, `number`, `display`) VALUES
  ('{{OWNER_A}}', NULL, '555-0002', 'Bob Test'),
  ('{{OWNER_A}}', NULL, '555-0002', 'Bob Test'),
  ('{{OWNER_A}}', 'https://cdn.example.com/npwd/cab.png', '555-0199', 'Downtown Cab'),
  ('{{OWNER_B}}', NULL, '555-0001', 'Alice Test'),
  ('GHOST_ID', NULL, '555-0003', 'Nobody');

-- Conversation 1: A <-> B, 3 messages. Conversation 2: the ghost's number <-> A, 1 message
-- whose sender cannot be resolved.
INSERT INTO `npwd_messages_conversations`
  (`id`, `conversation_list`, `label`, `createdAt`, `updatedAt`, `last_message_id`, `is_group_chat`) VALUES
  (1, '555-0001+555-0002', '', '2026-09-24 21:04:00', '2026-09-25 09:12:00', 3, 0),
  (2, '555-0001+555-0404', '', '2026-09-25 11:00:00', '2026-09-25 11:00:00', 4, 0);

INSERT INTO `npwd_messages_participants` (`conversation_id`, `participant`, `unread_count`) VALUES
  (1, '555-0001', 0),
  (1, '555-0002', 1),
  (2, '555-0001', 1),
  (2, '555-0404', 0);

INSERT INTO `npwd_messages`
  (`id`, `message`, `user_identifier`, `conversation_id`, `isRead`, `createdAt`, `visible`, `author`) VALUES
  (1, 'You up?', '{{OWNER_A}}', '1', 1, '2026-09-24 21:04:00', 1, '555-0001'),
  (2, 'Yeah, what''s up', '{{OWNER_B}}', '1', 1, '2026-09-24 21:05:00', 1, '555-0002'),
  (3, 'Meet at Legion', '{{OWNER_A}}', '1', 0, '2026-09-25 09:12:00', 1, '555-0001'),
  (4, 'hello?', 'GHOST_ID', '2', 0, '2026-09-25 11:00:00', 1, '555-0404');

-- Gallery: 3 resolvable rows, one a duplicate of another; 1 ghost.
INSERT INTO `npwd_phone_gallery` (`identifier`, `image`) VALUES
  ('{{OWNER_A}}', 'https://cdn.example.com/npwd/sunset.png'),
  ('{{OWNER_A}}', 'https://cdn.example.com/npwd/sunset.png'),
  ('{{OWNER_B}}', 'https://cdn.example.com/npwd/garage.jpg'),
  ('GHOST_ID', 'https://cdn.example.com/npwd/ghost.png');

-- Tweets: 2 resolvable (one with an image), 1 ghost.
INSERT INTO `npwd_twitter_profiles` (`id`, `profile_name`, `identifier`) VALUES
  (1, 'alice_ls', '{{OWNER_A}}'),
  (2, 'bobby', '{{OWNER_B}}'),
  (3, 'ghost', 'GHOST_ID');

INSERT INTO `npwd_twitter_tweets`
  (`message`, `createdAt`, `likes`, `identifier`, `visible`, `images`, `retweet`, `profile_id`) VALUES
  ('First day in Los Santos', '2026-09-20 10:00:00', 2, '{{OWNER_A}}', 1, '', NULL, 1),
  ('Anyone selling a Sultan?', '2026-09-21 11:00:00', 0, '{{OWNER_B}}', 1, 'https://cdn.example.com/npwd/sultan.jpg', NULL, 2),
  ('boo', '2026-09-22 12:00:00', 0, 'GHOST_ID', 1, '', NULL, 3);
