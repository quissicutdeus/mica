// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';

export const isTakingPhoto = writable(false);
export const isPreviewingPhoto = writable(false);
