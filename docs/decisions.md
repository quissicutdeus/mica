# Decisions

Choices that were made deliberately and could reasonably have gone the other
way. Each one is here so that the state of the tree stops reading as an
oversight: a reader who wonders "why does the phone not do X" finds the answer
and the date, not a gap. A decision that is later reversed gets a new entry
naming the old one; the old entry stays.

This is not a backlog. Work that is still to be decided or built lives in the
Jira project `MICA` (AGENTS.md §2.11), and an entry here names the key it
closed.

## No add-on is preinstalled; every add-on comes from the Store

_2026-10-18, MICA-239._

Out of the box the home screen holds the core apps — Phone, Messages, Contacts,
Mail, Bank, Jobs, Media, Camera, Music, Places, Calculator, Marketplace,
Settings and the Store — and nothing else. Notes, Blabber, Glimpse, Dark Chat,
Spark, Hodlr and Snek are `core: false` add-ons that a player installs from the
Store, and that stays so.

The alternative was a `mica_preinstalled_addons` convar defaulting to a named
set, so an owner evaluating the phone saw a social app on first open. It was
turned down because the add-ons are the demonstration that the Store path works:
a player who installs Blabber has exercised the catalog, the sandbox, the
permission disclosure and the uninstall, which is exactly what an add-on author
outside this repo depends on. Preinstalling the in-tree ones would make them a
privileged class that never takes that path, and the first external add-on would
be the first one to find a bug in it. An owner who wants a social app on every
home screen can say so in the server's own onboarding; the phone does not decide
it for them.

## Holding gCoin stays flavour; it launders nothing

_2026-10-18, MICA-146._

Hodlr's tagline — "Trade gCoin. No questions asked." — frames it as part of a
gray-market economy, and the mechanic that would make the framing real was that
holding gCoin for a while turned dirty money clean. That mechanic is not built
and is not planned.

Nothing in this repo knows where a bank balance came from. There is no dirty
money, the Marketplace has no illicit proceeds to launder, and inventing a
provenance model inside a phone resource would duplicate what an economy script
owns. Hodlr is a market to gamble on; the framing is set dressing, and that is
the end of it. If a framework ever exposes a clean/dirty split through
`FrameworkBridge`, the question can be reopened under a new key.
