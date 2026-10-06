import { defineAddonMock } from '@mica/sdk/dev';
import { ROW_ADDED, probe, type Row } from './service';

/**
 * The server half, mocked inside the frame. `list` answers a recognisable seed, so a spec can
 * tell the mocked answer from the UI's own default (an empty list); `add` pushes, so a spec can
 * tell a push from the answer to the call that caused it.
 */
const rows: Row[] = [{ id: 1, text: 'seeded by the mock' }];

export default defineAddonMock(probe, ({ push }) => ({
  list: () => rows,
  add: (_citizenid, { text }) => {
    const row: Row = { id: rows.length + 1, text };
    rows.push(row);
    push(ROW_ADDED, { ...row });
    return row;
  }
}));
