import { registerFacet } from '../../current';
import { is24Hour } from '../../../../shell/state/time';

/**
 * Implementation of the `useClockWrite` facet — see the `useClockWrite` hook doc for the
 * usage contract. Split out of `clock` (MICA-127): reading the time and changing how
 * every app on the phone renders it are not the same ask.
 */
export function clockWrite() {
  return {
    setIs24Hour: (value: boolean): void => {
      is24Hour.set(value);
    }
  };
}

registerFacet('clockWrite', clockWrite);
