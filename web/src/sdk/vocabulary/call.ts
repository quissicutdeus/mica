/**
 * The call state `Facets['call']` reports. MICA-172 — see `./accounts.ts`.
 *
 * Not on the published surface: no `use*` hook re-exports either name, and MICA-172
 * deliberately did not add one. Moving a type into the package is not the same as
 * publishing it, and widening the contract is a one-way door.
 */

export type CallStatus = 'idle' | 'dialing' | 'connected' | 'incoming';

export interface CallState {
  status: CallStatus;
  number: string;
  name?: string;
  duration: number; // in seconds
  speaker: boolean;
  muted: boolean;
}
