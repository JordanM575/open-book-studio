import type { ConnectionSummary, ProviderId } from "@ai-book-studio/core/providers/types";
import type { Catalogue } from "@ai-book-studio/core/providers/models";
import type { ProviderCatalogue } from "@ai-book-studio/core/routing";

/** One catalogue the model picker successfully loaded, keyed to its connection. */
export interface CatalogueLoad {
  connectionId: string;
  catalogue: Catalogue;
}

/**
 * The renderer's in-memory snapshot of the catalogues an explicit picker action loaded. Session
 * memory only: nothing here is written to disk, and a reload loses it.
 */
export interface PreviewCatalogueCache {
  connections: ConnectionSummary[];
  loads: CatalogueLoad[];
}

/**
 * Map the loaded snapshot to one entry per provider, in first-seen provider order. When several
 * connections for one provider loaded, the last successful load wins — replaced in place, keeping
 * the provider's first-seen position — and each catalogue keeps its own `fetchedAt`. Loads whose
 * connection is not in the snapshot are skipped until the connection list arrives. Nothing is
 * fetched, merged, sorted or invented here.
 */
export function previewCatalogues(cache: PreviewCatalogueCache): ProviderCatalogue[] {
  if (!cache || !Array.isArray(cache.connections) || !Array.isArray(cache.loads)) return [];
  const providerByConnection = new Map<string, ProviderId>();
  for (const connection of cache.connections) {
    if (connection && typeof connection.id === "string" && typeof connection.provider === "string") {
      providerByConnection.set(connection.id, connection.provider);
    }
  }
  const byProvider = new Map<ProviderId, ProviderCatalogue>();
  for (const load of cache.loads) {
    if (!load || typeof load.connectionId !== "string") continue;
    const provider = providerByConnection.get(load.connectionId);
    if (provider === undefined) continue;
    const catalogue = load.catalogue;
    if (!catalogue || !Array.isArray(catalogue.models)) continue;
    // Map insertion order keeps the first-seen provider position; set() replaces the value in place.
    byProvider.set(provider, { provider, catalogue });
  }
  return [...byProvider.values()];
}

/** The connections for one provider that can be used right now, in the snapshot's order. */
export function usableConnectionsFor(connections: ConnectionSummary[], provider: ProviderId): ConnectionSummary[] {
  if (!Array.isArray(connections)) return [];
  return connections.filter(
    (connection) => connection && connection.provider === provider && connection.planUsable !== false
  );
}
