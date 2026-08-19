import { isTrustedRemoteUrl } from './remoteAppSecurity';

/** One installable app as an operator's catalog server describes it. */
export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  bundleUrl: string;
  /** Lowercase hex SHA-256 of the exact bytes at `bundleUrl`. Required — `installFromCatalog` refuses to import a bundle without one. */
  sha256: string;
  color: string;
  icon?: string;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Whether `value` has every field `CatalogEntry` requires, with the right primitive types. */
function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.name) &&
    isNonEmptyString(v.version) &&
    isNonEmptyString(v.description) &&
    isNonEmptyString(v.bundleUrl) &&
    isNonEmptyString(v.sha256) &&
    isNonEmptyString(v.color) &&
    (v.icon === undefined || typeof v.icon === 'string')
  );
}

/**
 * Fetch and validate a catalog. `catalogUrl` must itself be on the trusted-host allowlist —
 * the same gate `installFromCatalog` applies to each entry's `bundleUrl` — so an operator
 * configures one allowlist, not two.
 *
 * An entry that fails validation is dropped and logged rather than failing the whole
 * catalog: one malformed row should not take down every other app on offer.
 */
export async function fetchCatalog(catalogUrl: string): Promise<CatalogEntry[]> {
  if (!isTrustedRemoteUrl(catalogUrl)) {
    throw new Error(`gPhone Catalog error: '${catalogUrl}' is not on the trusted host allowlist.`);
  }

  const response = await fetch(catalogUrl);
  if (!response.ok) {
    throw new Error(`gPhone Catalog error: HTTP ${response.status} fetching '${catalogUrl}'.`);
  }

  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error(`gPhone Catalog error: '${catalogUrl}' did not return a JSON array.`);
  }

  const entries: CatalogEntry[] = [];
  for (const row of body) {
    if (isCatalogEntry(row)) {
      entries.push(row);
    } else {
      console.warn(`gPhone Catalog: dropped a malformed entry from '${catalogUrl}'.`, row);
    }
  }
  return entries;
}
