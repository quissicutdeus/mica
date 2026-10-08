// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `bridge-table.js`, a plain JS build module, covering what the tests import. */

export interface BridgeEntry {
  name: string;
  side: 'server' | 'client';
  uses: string[];
  note: string;
  fallback: unknown;
  run?: Function;
}

export interface BridgeTable {
  resource: string;
  entries: BridgeEntry[];
}

export declare const BRIDGES: readonly string[];
export declare const startMarker: (bridge: string) => string;
export declare const endMarker: (bridge: string) => string;
export declare function loadBridge(root: string, bridge: string): BridgeTable;
export declare function renderTable(bridge: string, table: BridgeTable): string;
export declare function rewriteReadme(root: string, readme: string): Promise<string>;
