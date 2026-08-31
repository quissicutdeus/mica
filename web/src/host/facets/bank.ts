import { registerFacet } from '../../../../sdk/host/current';
import { sendMoney } from '../../services/bank';

/**
 * OS Service Hook for sending money. Split from the `account` facet's read side — see
 * `services/bank.ts`'s own doc for why.
 */
export function bank() {
  return {
    sendMoney
  };
}

registerFacet('bank', bank);
