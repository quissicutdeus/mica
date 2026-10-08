// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MockHandler } from '../registry';

export const mocks: Record<string, MockHandler> = {
  // The browser has no ace list; the panel is unconditional there anyway.
  'admin:check': () => ({ isAdmin: true })
};
