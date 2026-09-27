// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readable } from 'svelte/store';
import { registerFacet } from '../../../../sdk/host/current';
import type { ControlCenterToggle } from '../../../../sdk/host/facets';
import * as icons from '../../../../sdk/icons';
import {
  registerContributedToggle,
  setContributedToggleActive
} from '../../shell/state/controlCenter';

/**
 * Implementation of the `controlCenter` facet (MICA-247) — see `useControlCenter` for the
 * usage contract, and `shell/state/controlCenter.ts` for how the shell draws what lands
 * here.
 *
 * **Every check lives here, not in the hook.** A sandboxed add-on reaches this object over
 * `postMessage` with whatever arguments its script chose, so the hook's side of the seam
 * decides nothing. The app id is a factory argument that `IframeHostServer.ts` pins
 * (`APP_SCOPED_FACETS`), so a frame can neither register under another app's name nor
 * reach another app's switches through `unregisterToggle`/`setToggleActive`.
 */

/** Switches one app may hold at once. A fourth is refused, not rotated in. */
export const MAX_TOGGLES_PER_APP = 3;
const MAX_ID_LENGTH = 32;
const MAX_LABEL_LENGTH = 32;
const ID_SHAPE = /^[a-z0-9][a-z0-9_-]*$/i;

/** One live switch: how to take it down, and which facet instance put it up. */
interface Held {
  off: () => void;
  owner: object;
}

/** Every contributed switch the shell is showing, by app and then by the app's own id. */
const held = new Map<string, Map<string, Held>>();

function refuse(appId: string, why: string): never {
  throw new Error(`[micaOS] '${appId}' control center toggle refused: ${why}`);
}

/** `name` is an icon `@mica/sdk` exports — not an arbitrary export, and not inherited. */
function isIconName(name: string): boolean {
  return name.endsWith('Icon') && Object.prototype.hasOwnProperty.call(icons, name);
}

/**
 * Checked field by field rather than trusted by type: off the wire, `toggle` is whatever a
 * frame's script sent, and only `onToggle` has been touched on the way in (a callback ref
 * decoded into a function that posts back to the frame).
 */
function checked(appId: string, toggle: unknown): ControlCenterToggle {
  if (!toggle || typeof toggle !== 'object') refuse(appId, 'not an object');
  const { id, label, icon, active, onToggle } = toggle as Record<string, unknown>;
  if (typeof id !== 'string' || id.length > MAX_ID_LENGTH || !ID_SHAPE.test(id)) {
    refuse(appId, `id must be 1-${MAX_ID_LENGTH} letters, digits, '-' or '_'`);
  }
  const text = typeof label === 'string' ? label.trim() : '';
  if (!text || text.length > MAX_LABEL_LENGTH) {
    refuse(appId, `label must be 1-${MAX_LABEL_LENGTH} characters`);
  }
  if (typeof icon !== 'string' || !isIconName(icon)) {
    refuse(appId, `'${String(icon)}' is not an icon @mica/sdk exports`);
  }
  if (typeof active !== 'boolean') refuse(appId, 'active must be a boolean');
  if (typeof onToggle !== 'function') refuse(appId, 'onToggle must be a function');
  const handler = onToggle as () => void;
  return {
    id,
    label: text,
    icon,
    active,
    // The control center must not break because one app's handler did.
    onToggle: () => {
      try {
        handler();
      } catch (error) {
        console.warn(`[micaOS] '${appId}' control center toggle '${id}' threw`, error);
      }
    }
  };
}

export function controlCenter(appId: string) {
  const app = appId.toLowerCase();
  /** Identity for "registered through this instance", which is what a lease releases. */
  const owner = {};
  let leased = false;

  const release = (id: string, onlyOwn: boolean) => {
    const byApp = held.get(app);
    const entry = byApp?.get(id);
    if (!byApp || !entry || (onlyOwn && entry.owner !== owner)) return;
    byApp.delete(id);
    if (byApp.size === 0) held.delete(app);
    entry.off();
  };

  return {
    lease: readable(true, () => {
      leased = true;
      return () => {
        leased = false;
        for (const [id, entry] of held.get(app) ?? []) {
          if (entry.owner === owner) release(id, true);
        }
      };
    }),

    registerToggle(toggle: ControlCenterToggle): void {
      // Without a lease nothing would ever take this switch down again, so it is not put up.
      if (!leased) refuse(app, 'no lease is held');
      const valid = checked(app, toggle);
      const byApp = held.get(app) ?? new Map<string, Held>();
      if (!byApp.has(valid.id) && byApp.size >= MAX_TOGGLES_PER_APP) {
        refuse(app, `an app may contribute at most ${MAX_TOGGLES_PER_APP}`);
      }
      // Same id replaces: a reloaded frame re-registers what it had rather than doubling up.
      byApp.get(valid.id)?.off();
      byApp.set(valid.id, { off: registerContributedToggle(app, valid), owner });
      held.set(app, byApp);
    },

    unregisterToggle(id: string): void {
      if (typeof id === 'string') release(id, false);
    },

    setToggleActive(id: string, active: boolean): void {
      if (typeof id !== 'string' || typeof active !== 'boolean') return;
      if (held.get(app)?.has(id)) setContributedToggleActive(app, id, active);
    }
  };
}

registerFacet('controlCenter', controlCenter);
