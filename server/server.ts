// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import './services';
import './lib/phoneItem';
import './lib/qbPhoneCompat';
// Local framework listeners that push `jobs:changed` (MICA-227). Side-effect import, like
// the two above: registering the listeners is the whole effect.
import './lib/jobEvents';
import { BankingBridge } from './lib/BankingBridge';
import { FrameworkBridge } from './lib/FrameworkBridge';
import { registerPublicApi } from './lib/publicApi';

/**
 * After `./services`, so every service has loaded before anything it exposes can be
 * called. Publishing from inside each service would put the surface back where it was —
 * spread across the files that implement it, where nothing can check it.
 */
registerPublicApi();

on('onResourceStart', (resName: string) => {
  if (resName === GetCurrentResourceName()) {
    console.log('mica started!');

    // Surfaced at startup because a missing banking resource degrades silently to an
    // empty transaction list — which looks identical to "you have no transactions".
    const banking = BankingBridge.detect();
    console.log(
      banking
        ? `mica: banking bridge -> ${banking}`
        : 'mica: no supported banking resource detected; the Bank app will show no transactions'
    );

    // Same reason as the banking line (MICA-227): a framework whose multi-job list this
    // cannot read degrades to one job per player, which looks exactly like a player who
    // holds one job. Said once at start so an owner can tell the two apart.
    const jobs = FrameworkBridge.jobSupport();
    console.log(`mica: jobs -> ${jobs.via}`);
  }
});
