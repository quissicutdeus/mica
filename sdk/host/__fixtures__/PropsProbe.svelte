<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { AppProps } from '../../manifest';

  let { label }: AppProps & { label?: string } = $props();
</script>

<div>{label ?? 'none'}</div>
