<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { Screen, type AppManifest, type AppUpdate } from '@mica/sdk';
  import AppDetailsBody from './AppDetailsBody.svelte';

  let {
    app,
    installed,
    update = null,
    onback,
    oninstall,
    onupdate,
    onuninstall,
    onopen,
    unavailable = null
  }: {
    app: AppManifest;
    installed: boolean;
    /** The pending update for this app, or `null` when it is current (or not a catalog install). */
    update?: AppUpdate | null;
    onback: () => void;
    oninstall: (app: AppManifest) => void;
    onupdate: (app: AppManifest) => void;
    onuninstall: (app: AppManifest) => void;
    onopen: (id: string) => void;
    /** Why this server cannot install the app, or `null` (MICA-169). */
    unavailable?: string | null;
  } = $props();
</script>

<!--
  `Screen`, like every other page in the phone, rather than a header of its own.

  This one hand-rolled its back button and title, so it was the one screen in the Store that
  did not match the Store — a different back affordance, a different type scale, and its own
  safe-area handling to keep in step. The title was the literal words "App Details", which
  names the template rather than what is on it: the player tapped an app and the header
  should say which one.
-->
<Screen title={app.name} onback={() => onback()}>
  <AppDetailsBody
    {app}
    {installed}
    {update}
    {oninstall}
    {onupdate}
    {onuninstall}
    {onopen}
    {unavailable}
  />
</Screen>
