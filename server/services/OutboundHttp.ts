// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  TEST_EMBED_TITLE,
  WEBHOOK_CONVAR,
  sendWebhookTest,
  type WebhookTestResult
} from '../lib/DiscordWebhook';
import { notifyPlayer } from '../lib/shell';
import {
  CATALOG_FAILURE_TTL_MS,
  CATALOG_TTL_MS,
  refreshCatalog,
  type CatalogRefresh
} from './Store';

/**
 * `micahttp` (MICA-322): the console's way to exercise micaOS's two outbound HTTP callers that
 * otherwise only a connected player's net event reaches — the Discord webhook (MICA-242) and the
 * add-on catalog relay (MICA-237). Without it a server owner setting either up has no way to
 * see it work short of moderating something or opening the Store, and the in-server suite,
 * which connects no player, had no way at all.
 *
 * Each subcommand goes through the real path, not a copy of it: `webhook` posts one test embed
 * through `DiscordWebhook`'s own request and rate limit, and `catalog` refetches through the
 * Store's own checks, request and cache. Each prints what was sent or fetched, or why not.
 *
 * **Console only, the gate `micaimport` and `micacrypt` carry.** Both subcommands make the
 * server reach a third party on demand; `webhook` posts into a staff channel. Nothing here is
 * a net event or a NUI route, so a player has no way to it but this command, and the command
 * refuses every `source` but 0.
 *
 * **It never prints the webhook URL.** A Discord webhook URL is its own secret — the token is
 * the path — so a line names only its scheme and host. The catalog URL is printed with
 * userinfo, query and fragment removed, as the Store's own warning does.
 */

export const USAGE = [
  '[micahttp] usage:',
  `[micahttp]   micahttp webhook   post one test embed to ${WEBHOOK_CONVAR}`,
  '[micahttp]   micahttp catalog   fetch mica_addon_catalog now, past the cache'
];

/** How long `webhook` waits for an answer. The post itself has no timeout of its own. */
export const WEBHOOK_TEST_TIMEOUT_MS = 10_000;

/** How many catalog ids a line names before it only counts. */
const IDS_SHOWN = 10;

const say = (line: string): void => console.log(line);
const complain = (line: string): void => console.error(line);

const minutes = (ms: number): string =>
  ms >= 60_000 && ms % 60_000 === 0
    ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`
    : `${Math.round(ms / 1000)} s`;

const report = (result: WebhookTestResult | 'timeout'): void => {
  if (result === 'timeout') {
    complain(
      `[micahttp] webhook: no answer within ${WEBHOOK_TEST_TIMEOUT_MS / 1000} s; ` +
        'the post may still land.'
    );
    return;
  }
  switch (result.outcome) {
    case 'unset':
      say(`[micahttp] webhook: ${WEBHOOK_CONVAR} is not set, so the webhook is off; nothing sent.`);
      return;
    case 'not-https':
      complain(
        `[micahttp] webhook: ${WEBHOOK_CONVAR} is set but is not an https:// URL, which micaOS ` +
          'never posts to; nothing sent.'
      );
      return;
    case 'answered': {
      const line =
        `[micahttp] webhook: posted the embed "${TEST_EMBED_TITLE}" to ${result.origin}; ` +
        `the host answered ${result.status}`;
      if (result.ok) say(`${line}.`);
      else complain(`${line}, so the post was refused.`);
      return;
    }
    case 'failed':
      complain(`[micahttp] webhook: the post to ${result.origin} failed: ${result.reason}`);
      return;
  }
};

/** The ids a line names: short, plain ones only, since the body is a third party's. */
const listedIds = (entries: unknown[]): string[] =>
  entries
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id));

const reportCatalog = (result: CatalogRefresh): void => {
  switch (result.status) {
    case 'off':
      say(
        '[micahttp] catalog: mica_addon_catalog is off, so the Store lists no remote add-ons; nothing fetched.'
      );
      return;
    case 'refused':
      complain(
        `[micahttp] catalog: ${result.url} (${result.state}) was not fetched: ${result.reason}.`
      );
      return;
    case 'unavailable':
      complain(
        `[micahttp] catalog: ${result.url} (${result.state}) is unavailable: ${result.reason}. ` +
          `Phones are told so for the next ${minutes(CATALOG_FAILURE_TTL_MS)}.`
      );
      return;
    case 'ok': {
      const ids = listedIds(result.entries);
      const shown = ids.slice(0, IDS_SHOWN).join(', ');
      const more = ids.length > IDS_SHOWN ? `, and ${ids.length - IDS_SHOWN} more` : '';
      say(
        `[micahttp] catalog: fetched ${result.url} (${result.state}): ` +
          `${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'}` +
          (shown ? ` (${shown}${more})` : '') +
          `. Phones get this copy for the next ${minutes(CATALOG_TTL_MS)}.`
      );
      return;
    }
  }
};

const withDeadline = <T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};

/** `micahttp <webhook | catalog>`. Never throws: every outcome is a console line. */
export const runOutboundHttpCommand = async (source: number, args: string[]): Promise<void> => {
  if (source !== 0) {
    notifyPlayer(source, {
      type: 'error',
      message: 'You do not have permission to use that.',
      key: 'server.schema.noPermission'
    });
    return;
  }

  const words = (args ?? []).map((arg) => String(arg));
  const sub = (words[0] ?? '').toLowerCase();
  if (words.length !== 1 || (sub !== 'webhook' && sub !== 'catalog')) {
    for (const line of USAGE) say(line);
    return;
  }

  try {
    if (sub === 'webhook') report(await withDeadline(sendWebhookTest(), WEBHOOK_TEST_TIMEOUT_MS));
    else reportCatalog(await refreshCatalog());
  } catch (error) {
    // Nothing above throws by design; this is for a bug, and a bug's message could quote a URL.
    const why = (error instanceof Error ? error.message : String(error)).replace(
      /[a-z][a-z0-9+.-]*:\/\/\S+/gi,
      '<url>'
    );
    complain(`[micahttp] ${sub} failed: ${why}`);
  }
};

RegisterCommand(
  'micahttp',
  (source: number, args: string[]) => {
    void runOutboundHttpCommand(source, args);
  },
  false
);
