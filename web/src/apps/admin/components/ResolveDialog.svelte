<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { ConfirmDialog, useLocale } from '@mica/sdk';
  import type { Report } from '@mica/shared/types';
  import type { ResolveAction } from './labels';

  interface Props {
    /** The report being decided, and which way. */
    pending: { report: Report; action: ResolveAction };
    /** Runs the decision; the caller is what closes this. */
    onconfirm: (report: Report, action: ResolveAction, success: string) => void;
    oncancel: () => void;
  }

  let { pending, onconfirm, oncancel }: Props = $props();

  const { t } = useLocale();
  const removing = $derived(pending.action === 'moderate');
  // The toast the decision earns, chosen here so both roots say the same thing.
  const success = $derived(removing ? $t('admin.contentRemoved') : $t('admin.reportClosed'));
</script>

<ConfirmDialog
  title={removing ? $t('admin.removeTitle') : $t('admin.allowTitle')}
  message={removing ? $t('admin.removeMessage') : $t('admin.allowMessage')}
  confirmText={removing ? $t('admin.confirmRemove') : $t('admin.confirmAllow')}
  confirmVariant={removing ? 'danger' : 'primary'}
  onconfirm={() => onconfirm(pending.report, pending.action, success)}
  {oncancel}
/>
