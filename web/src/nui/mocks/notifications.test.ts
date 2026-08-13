import { describe, it, expect } from 'vitest';
import { parseDeepLink } from '@shared/deepLink';
import { MockRegistry } from './registry';
import { mockConversations, mockEmails } from './data';
import type { NotificationItem } from '@shared/types';

/**
 * Every fixture notification points at a fixture that exists.
 *
 * This is the test that was missing when the deep-link plumbing was fixed. The plumbing
 * was right and `pnpm dev` still opened the wrong screen, because the fixtures named
 * people who were not in any conversation — tapping "Sarah Connor" landed on Ursula, and
 * two mail notifications named `mailId` 5 and 6 against a fixture set with three rows.
 *
 * A dangling id is worse than a missing mock. §8's warning is that a mock hides a missing
 * layer; this is the inverse and it costs more to debug — the layer works, the fixture is
 * lying, and the only symptom is a screen that looks like a routing bug.
 *
 * Asserting the *title* against the target's own name is the part that matters. An id
 * that merely resolves is not enough: `conversationId=1` resolved perfectly the whole
 * time it was pointing at the wrong person.
 */
describe('mock notification fixtures', () => {
  // Through `handle`, which is the registry's only public door — and the same one the
  // browser transport goes through, so this checks what `pnpm dev` actually serves rather
  // than a fixture array the registry might filter before answering with.
  const shade = async () =>
    (await MockRegistry.handle('getShadeNotifications')) as NotificationItem[];

  it('serves fixtures to check', async () => {
    expect((await shade()).length).toBeGreaterThan(0);
  });

  it('every deep link parses', async () => {
    for (const n of await shade()) {
      if (!n.deep_link) continue;
      expect(parseDeepLink(n.deep_link), `${n.title}: ${n.deep_link}`).not.toBeNull();
    }
  });

  it('a link agrees with the app it is filed under', async () => {
    // The shade groups on `app` and navigates on `deep_link`. When they disagree, the
    // group header and the destination are two different apps.
    for (const n of await shade()) {
      if (!n.deep_link) continue;
      expect(parseDeepLink(n.deep_link)?.app, n.title).toBe(n.app);
    }
  });

  it('names a conversation that exists, and names it correctly', async () => {
    for (const n of (await shade()).filter((x) => x.app === 'messages')) {
      const id = parseDeepLink(n.deep_link!)?.props.conversationId;
      const conv = mockConversations.find((c) => c.id === id);
      expect(conv, `${n.title} -> conversation ${id}`).toBeDefined();
      expect(n.title).toBe(conv!.name);
    }
  });

  it('names mail that exists, and names its sender correctly', async () => {
    for (const n of (await shade()).filter((x) => x.app === 'mail')) {
      const id = parseDeepLink(n.deep_link!)?.props.mailId;
      const mail = mockEmails.find((m) => m.id === id);
      expect(mail, `${n.title} -> mail ${id}`).toBeDefined();
      // `Email from <sender>` with the subject as the body is what
      // `server/services/Mail.ts` pushes. A mock that disagrees with the server is a bug
      // you cannot see in the browser.
      expect(n.title).toBe(`Email from ${mail!.sender}`);
      expect(n.body).toBe(mail!.subject);
    }
  });

  /**
   * The title-only check above would have passed the whole time `body` was an invented
   * paraphrase of the thread ("GET DOWN HERE. NOW." for a Trevor conversation that never
   * says it) — the conversation resolved, and the name over it was even right. Only the
   * preview text disagreed with what tapping through actually shows.
   */
  it('previews the conversation it links to, not an invented line', async () => {
    for (const n of (await shade()).filter((x) => x.app === 'messages')) {
      const id = parseDeepLink(n.deep_link!)?.props.conversationId;
      const conv = mockConversations.find((c) => c.id === id);
      expect(conv, `${n.title} -> conversation ${id}`).toBeDefined();
      expect(n.body).toBe(conv!.last_message?.message);
    }
  });

  it('a mention notification points at a Blab that actually mentions the player', async () => {
    for (const n of (await shade()).filter((x) => x.app === 'blabber' && x.kind === 'mention')) {
      const id = parseDeepLink(n.deep_link!)?.props.blabId;
      const { root } = (await MockRegistry.handle('blabber:view', { id })) as {
        root: { handle: string; body: string } | null;
      };
      expect(root, `${n.title} -> blab ${id}`).not.toBeNull();
      expect(n.title).toBe(`@${root!.handle} mentioned you`);
      expect(n.body).toBe(root!.body);
      // A "mentioned you" notification whose Blab doesn't actually @-mention anyone is the
      // same class of lie as a conversation notification quoting a line nobody sent.
      expect(root!.body).toMatch(/@\w+/);
    }
  });
});
