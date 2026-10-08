import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { gotoDevice, settledFrameBox } from '../support/device';
import { switchTo } from '../support/deviceStore';

/**
 * A phone-only toast shows on the tablet without its actions, and has them the moment the
 * phone is up (MICA-264, `ToastHost.svelte`). An incoming call is the clearest case: Accept
 * and Decline place the call through the phone's service, which the server refuses from the
 * tablet, so the banner tells the player and leaves the answering to the phone.
 *
 * The actions are decided as the toast is drawn, not when it was shown, so the same toast —
 * never re-sent — must grow its buttons when the phone comes up. That is the second half of
 * the assertion; without it, "no buttons" would also pass for a toast that never has any.
 */
test('an incoming call on the tablet has no Accept or Decline until the phone is up', async ({
  page
}) => {
  await seedHomeGrid(page, ['settings'], 'tablet');
  await gotoDevice(page, 'tablet');
  await settledFrameBox(page, 'tablet');

  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          action: 'callStatus',
          data: { status: 'incoming', name: 'Lester Crest', number: '555-0155' }
        }
      })
    );
  });

  await expect(page.getByText('Incoming Call')).toBeVisible();
  await expect(page.getByText('Lester Crest (555-0155)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Decline' })).toHaveCount(0);

  await switchTo(page, 'phone');
  await expect(page.getByText('Lester Crest (555-0155)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Decline' })).toBeVisible();
});
