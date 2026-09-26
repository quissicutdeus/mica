-- SPDX-FileCopyrightText: 2026 quissicutdeus
--
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- qb-phone's tables for `micaimport qb-phone` (MICA-233), loaded by scripts/test-schema.js.
--
-- The CREATE TABLEs are qbcore-framework/qb-phone `qb-phone.sql` on main, verbatim but for
-- whitespace, and only the four tables the importer reads. Nothing here is guessed.
--
-- {{OWNER_A}} and {{OWNER_B}} are replaced by the harness with its two seeded characters
-- (qb: CIT_A / CIT_B; ESX: their `users.identifier`), numbers 555-0001 and 555-0002.
-- GHOST_CID is nobody: every table has one row owned by it, which must be skipped.
--
-- `phone_messages.messages` is qb-phone's JSON: an array of days, each
-- `{ date: 'D-M-YYYY', messages: [{ message, time: 'HH:MM', sender: <citizenid>, type,
-- data }] }`, with one row per side of a thread keyed by the *other* party's `number`.

CREATE TABLE IF NOT EXISTS `player_contacts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `citizenid` varchar(50) DEFAULT NULL,
  `name` varchar(50) DEFAULT NULL,
  `number` varchar(50) DEFAULT NULL,
  `iban` varchar(50) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `citizenid` (`citizenid`)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `phone_messages` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `citizenid` varchar(50) DEFAULT NULL,
  `number` varchar(50) DEFAULT NULL,
  `messages` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `citizenid` (`citizenid`),
  KEY `number` (`number`)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `phone_gallery` (
  `citizenid` VARCHAR(255) NOT NULL,
  `image` VARCHAR(255) NOT NULL,
  `date` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `phone_tweets` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `citizenid` varchar(50) DEFAULT NULL,
  `firstName` varchar(25) DEFAULT NULL,
  `lastName` varchar(25) DEFAULT NULL,
  `message` text DEFAULT NULL,
  `date` datetime DEFAULT current_timestamp(),
  `url` text DEFAULT NULL,
  `picture` text DEFAULT './img/default.png',
  `tweetId` varchar(25) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `citizenid` (`citizenid`)
) ENGINE=InnoDB AUTO_INCREMENT=1;

-- Contacts: 4 resolvable, of which one is an exact duplicate of another; 1 unresolvable.
INSERT INTO `player_contacts` (`citizenid`, `name`, `number`, `iban`) VALUES
  ('{{OWNER_A}}', 'Bob Test', '555-0002', '0'),
  ('{{OWNER_A}}', 'Bob Test', '555-0002', '0'),
  ('{{OWNER_A}}', 'Downtown Cab', '555-0199', '0'),
  ('{{OWNER_B}}', 'Alice Test', '555-0001', 'US01QBCORE0000000001'),
  ('GHOST_CID', 'Nobody', '555-0003', '0');

-- One A<->B thread stored twice (once per side, as qb-phone does): 3 messages, not 6.
-- A second thread from A to the cab line, which has no micaOS player behind it.
INSERT INTO `phone_messages` (`citizenid`, `number`, `messages`) VALUES
  ('{{OWNER_A}}', '555-0002', '[{"date":"24-9-2026","messages":[{"message":"You up?","time":"21:04","sender":"{{OWNER_A}}","type":"message","data":[]},{"message":"Yeah, what''s up","time":"21:05","sender":"{{OWNER_B}}","type":"message","data":[]}]},{"date":"25-9-2026","messages":[{"message":"Meet at Legion","time":"09:12","sender":"{{OWNER_A}}","type":"message","data":[]}]}]'),
  ('{{OWNER_B}}', '555-0001', '[{"date":"24-9-2026","messages":[{"message":"You up?","time":"21:04","sender":"{{OWNER_A}}","type":"message","data":[]},{"message":"Yeah, what''s up","time":"21:05","sender":"{{OWNER_B}}","type":"message","data":[]}]},{"date":"25-9-2026","messages":[{"message":"Meet at Legion","time":"09:12","sender":"{{OWNER_A}}","type":"message","data":[]}]}]'),
  ('{{OWNER_A}}', '555-0199', '[{"date":"25-9-2026","messages":[{"message":"Pickup at Pillbox please","time":"10:30","sender":"{{OWNER_A}}","type":"message","data":[]}]}]'),
  ('GHOST_CID', '555-0001', '[{"date":"25-9-2026","messages":[{"message":"hello?","time":"11:00","sender":"GHOST_CID","type":"message","data":[]}]}]');

-- Gallery: 3 resolvable rows, one a duplicate of another (same owner, same URL); 1 ghost.
INSERT INTO `phone_gallery` (`citizenid`, `image`, `date`) VALUES
  ('{{OWNER_A}}', 'https://cdn.example.com/qb/sunset.png', '2026-09-20 18:00:00'),
  ('{{OWNER_A}}', 'https://cdn.example.com/qb/sunset.png', '2026-09-20 18:00:00'),
  ('{{OWNER_B}}', 'https://cdn.example.com/qb/garage.jpg', '2026-09-21 12:30:00'),
  ('GHOST_CID', 'https://cdn.example.com/qb/ghost.png', '2026-09-22 08:00:00');

-- Tweets: 2 resolvable (one with an image), 1 ghost.
INSERT INTO `phone_tweets`
  (`citizenid`, `firstName`, `lastName`, `message`, `date`, `url`, `picture`, `tweetId`) VALUES
  ('{{OWNER_A}}', 'Alice', 'Test', 'First day in Los Santos', '2026-09-20 10:00:00', '', './img/default.png', 'TWEET-A1'),
  ('{{OWNER_B}}', 'Bob', 'Test', 'Anyone selling a Sultan?', '2026-09-21 11:00:00', 'https://cdn.example.com/qb/sultan.jpg', './img/default.png', 'TWEET-B1'),
  ('GHOST_CID', 'No', 'Body', 'boo', '2026-09-22 12:00:00', '', './img/default.png', 'TWEET-G1');
