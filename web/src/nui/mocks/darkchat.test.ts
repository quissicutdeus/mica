// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-254: Dark Chat's mocks keep the server's rules — non-members get nothing, the code and
 * member actions are the owner's alone, a code is eight of the unambiguous alphabet — and a
 * report on a message files with the reporter's alias. Fresh modules per case, since every
 * table here is module scope.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MockHandler } from './registry';

let channels: Record<string, MockHandler>;
let messages: Record<string, MockHandler>;
let reports: Record<string, MockHandler>;
let SEED_CODE: string;
let HANDLES: { vandal: string; nightowl: string; ghost: string };

beforeEach(async () => {
  vi.resetModules();
  channels = (await import('./services/darkchat')).mocks;
  messages = (await import('./services/darkchat_messages')).mocks;
  reports = (await import('./services/reports')).mocks;
  ({ SEED_CODE, SEED_HANDLES: HANDLES } = await import('./darkchat'));
});

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const HANDLE = /^[A-Za-z0-9]{16}$/;

describe('darkchat mocks', () => {
  it('seeds one channel the player is in, with a bot line, never a citizenid', async () => {
    const list = await channels['darkchat:list']({});
    expect(list).toEqual([
      {
        id: 1,
        name: 'Night Market',
        my_member_id: HANDLES.ghost,
        my_alias: 'ghost',
        is_owner: false
      }
    ]);
    expect(SEED_CODE).toMatch(CODE);

    const page = await messages['darkchat_messages:list']({ channel_id: 1 });
    expect(page.rows.map((m: { id: number }) => m.id)).toEqual([4, 3, 2, 1]);
    expect(page.rows.find((m: { bot: boolean }) => m.bot)).toMatchObject({
      alias: 'Lookout',
      member_id: null,
      mine: false
    });
    expect(page.rows.find((m: { id: number }) => m.id === 4).mine).toBe(true);
    for (const row of page.rows.filter((m: { bot: boolean }) => !m.bot)) {
      expect(row.member_id).toMatch(HANDLE);
    }

    const members = await channels['darkchat:members']({ channel_id: 1 });
    // By alias, and only alias and handle: nothing that ranks members or marks the owner.
    expect(members.map((m: { alias: string }) => m.alias)).toEqual(['ghost', 'nightowl', 'vandal']);
    for (const member of members) {
      expect(Object.keys(member).sort()).toEqual(['alias', 'id']);
      expect(member.id).toMatch(HANDLE);
    }
  });

  it('refuses owner actions to a member who is not the owner', async () => {
    expect(() => channels['darkchat:code']({ channel_id: 1 })).toThrow(/owner/);
    expect(() => channels['darkchat:rotateCode']({ channel_id: 1 })).toThrow(/owner/);
    expect(() =>
      channels['darkchat:removeMember']({ channel_id: 1, member_id: HANDLES.nightowl })
    ).toThrow(/owner/);
  });

  it('creates an owned channel with a code, and lets its owner run it', async () => {
    const joined = await channels['darkchat:create']({ name: ' Den ', alias: 'boss' });
    expect(joined.code).toMatch(CODE);
    expect(joined.channel).toMatchObject({ name: 'Den', my_alias: 'boss', is_owner: true });
    expect(joined.channel.my_member_id).toMatch(HANDLE);
    expect(Object.values(HANDLES)).not.toContain(joined.channel.my_member_id);

    const id = joined.channel.id;
    expect(channels['darkchat:code']({ channel_id: id })).toEqual({ code: joined.code });
    const rotated = channels['darkchat:rotateCode']({ channel_id: id });
    expect(rotated.code).toMatch(CODE);
    expect(rotated.code).not.toBe(joined.code);
    expect(
      channels['darkchat:removeMember']({ channel_id: id, member_id: joined.channel.my_member_id })
    ).toBe(false);
  });

  it('joins by code, case-insensitively, and refuses a bad one or a taken alias', async () => {
    await channels['darkchat:leave']({ channel_id: 1 });
    expect(() => messages['darkchat_messages:list']({ channel_id: 1 })).toThrow(/not in/);

    expect(() => channels['darkchat:join']({ code: 'O0I1L000', alias: 'x' })).toThrow(
      /did not work/
    );
    expect(() => channels['darkchat:join']({ code: SEED_CODE, alias: 'Vandal' })).toThrow(/alias/);
    const joined = channels['darkchat:join']({ code: SEED_CODE.toLowerCase(), alias: 'shade' });
    expect(joined.channel).toMatchObject({ id: 1, my_alias: 'shade', is_owner: false });
    expect(joined.code).toBeUndefined();
  });

  it('sends under my alias and refuses a non-member', async () => {
    const sent = await messages['darkchat_messages:send']({ channel_id: 1, body: ' hi ' });
    expect(sent).toMatchObject({ alias: 'ghost', mine: true, bot: false, body: 'hi' });
    expect(() => messages['darkchat_messages:send']({ channel_id: 42, body: 'hi' })).toThrow(
      /not in/
    );
  });

  it("files a report on someone's message with my alias as reporter_label", async () => {
    await reports['reports:create']({
      targetTable: 'mica_darkchat_messages',
      targetId: 3,
      category: 'threats'
    });
    const queue = await reports['reports:queue']({});
    expect(
      queue.find((r: { target_table: string }) => r.target_table === 'mica_darkchat_messages')
    ).toMatchObject({
      target_preview: 'Bring the van, not the bike.',
      target_author: 'DARK0002',
      reporter_label: 'ghost',
      resolution: 'pending'
    });

    // Not my own line, and not a script's.
    await expect(
      reports['reports:create']({ targetTable: 'mica_darkchat_messages', targetId: 4 })
    ).rejects.toThrow();
    await expect(
      reports['reports:create']({ targetTable: 'mica_darkchat_messages', targetId: 2 })
    ).rejects.toThrow();
  });
});
