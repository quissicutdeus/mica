<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<!-- A widget that throws while rendering, for `WidgetHost.test.ts`. -->
<div data-throws>
  {(() => {
    throw new Error('widget render crash');
  })()}
</div>
