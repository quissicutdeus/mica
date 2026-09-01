<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { useContacts } from '../useContacts';
  import type { AppProps } from '../../manifest';

  let {}: AppProps = $props();

  useContacts();
</script>

<div>uses contacts</div>
