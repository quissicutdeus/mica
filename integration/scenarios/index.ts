// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { addonServiceScenarios } from './addonService';
import { commandScenarios } from './commands';
import { cryptoScenarios } from './crypto';
import { esxScenarios } from './esx';
import { exportScenarios } from './exports';
import { httpScenarios } from './http';
import { importerScenarios } from './importer';
import { oxmysqlScenarios } from './oxmysql';
import { qbxScenarios } from './qbx';
import { retentionScenarios } from './retention';
import { schemaScenarios } from './schema';

/**
 * Every scenario, in the order they run. The order is for reading the console, not for
 * correctness: each arranges its own fixtures under ids no other scenario uses, so any order
 * passes or fails the same. The command premise runs first so that, if it is wrong, the first
 * FAIL says so before a command scenario fails for it.
 *
 * Every scenario names the run it belongs to (`mode`, MICA-304): the standalone groups run in
 * the standalone run and are skipped, with a printed SKIP line each, in the qbx and esx runs,
 * and `qbxScenarios` and `esxScenarios` the other way round. A new group is added here, and its
 * mode is its own to say.
 */
export const scenarios: readonly Scenario[] = [
  ...commandScenarios,
  ...schemaScenarios,
  ...cryptoScenarios,
  ...exportScenarios,
  ...addonServiceScenarios,
  ...retentionScenarios,
  ...oxmysqlScenarios,
  ...importerScenarios,
  ...httpScenarios,
  ...qbxScenarios,
  ...esxScenarios
];
