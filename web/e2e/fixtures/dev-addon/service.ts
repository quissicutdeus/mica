import { addonOutput, defineAddonService } from '@mica/shared/addonService';

export interface Row {
  id: number;
  text: string;
}

/** Two actions: `list` is what the UI renders on open, `add` is what makes the mock push. */
export const probe = defineAddonService({
  id: 'devprobe',
  actions: {
    list: { input: {}, output: addonOutput<Row[]>() },
    add: { input: { text: { type: 'string', min: 1, max: 80 } }, output: addonOutput<Row>() }
  }
});

export const ROW_ADDED = 'row_added';
