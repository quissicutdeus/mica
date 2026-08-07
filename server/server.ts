import './services';
import { BankingBridge } from './lib/BankingBridge';
import { registerPublicApi } from './lib/publicApi';

/**
 * After `./services`, so every service has loaded before anything it exposes can be
 * called. Publishing from inside each service would put the surface back where it was —
 * spread across the files that implement it, where nothing can check it.
 */
registerPublicApi();

on('onResourceStart', (resName: string) => {
  if (resName === GetCurrentResourceName()) {
    console.log('gphone started!');

    // Surfaced at startup because a missing banking resource degrades silently to an
    // empty transaction list — which looks identical to "you have no transactions".
    const banking = BankingBridge.detect();
    console.log(
      banking
        ? `gphone: banking bridge -> ${banking}`
        : 'gphone: no supported banking resource detected; the Bank app will show no transactions'
    );
  }
});
