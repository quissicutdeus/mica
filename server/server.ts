import './services';
import { BankingBridge } from './lib/BankingBridge';

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
