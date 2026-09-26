<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { WidgetSize } from '../../manifest';

  let { size }: { size: WidgetSize } = $props();
</script>

<div>widget {size}</div>
