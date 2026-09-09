// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

export type { Transaction, BankHistory, BankHistorySource } from '@mica/shared/types';
// MICA-228: what `useJobs()` hands back. Declared in shared like `Transaction`.
export type { JobView, JobLine, JobActionOutcome } from '@mica/shared/types';
export type { UIConversation, UIMessage } from './vocabulary/messages';
export type { Contact, Mail, Note } from '@mica/shared/types';
