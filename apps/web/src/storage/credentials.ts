import type { CredentialVault } from "@ai-book-studio/core/providers/credentials";
import type { ConnectionSummary, CredentialStatus, StoredCredential } from "@ai-book-studio/core/providers/types";

const DEFAULT_DB = "ai-book-studio-credentials";
const STORE = "connections";

/**
 * Origin-scoped browser credential vault (D-105).
 *
 * There is no OS keychain in a browser and no passphrase claim: the records live in this origin's
 * IndexedDB. Same-origin scripts can read them, and clearing site data removes them. The library,
 * logs, archives and URLs never receive the secret. The desktop vault remains the stronger store.
 */
export class BrowserCredentialVault implements CredentialVault {
  private database: Promise<IDBDatabase> | null = null;
  private checkRefused = false;

  constructor(private readonly name: string = DEFAULT_DB) {}

  async isAvailable(): Promise<boolean> {
    // Checking for the API leaves the database closed.
    try {
      return typeof globalThis.indexedDB?.open === "function";
    } catch {
      return false;
    }
  }

  async status(): Promise<CredentialStatus> {
    const backend = "Browser origin storage";
    try {
      if (await this.isAvailable()) {
        // A write-mode count opens the transaction required for sign-in without reading or
        // writing connection values. A latched probe failure requires a fresh explicit check.
        const connections = await this.request("readwrite", (store) => store.count());
        if (this.checkRefused) {
          return { available: false, backend, connections, detail: "Browser storage refused the check. Allow site data and run Check browser storage again." };
        }
        return { available: true, backend, connections, detail: "Clearing site data removes connections stored for this origin." };
      }
    } catch {
      return { available: false, backend, connections: 0, detail: "Browser storage refused access. Allow site data and reload this page." };
    }
    return { available: false, backend, connections: 0, detail: "This browser cannot store connections. Use a browser with site storage or the desktop app." };
  }

  /**
   * Explicit round-trip probe: write, read back and remove one probe record. Origin storage
   * never prompts, so unlike the desktop keychain this is safe to run, but it stays behind
   * the Check control to match the desktop contract.
   */
  async check(): Promise<CredentialStatus> {
    try {
      const probe = `credential-probe-${Date.now()}`;
      await this.request("readwrite", (store) => store.put({ id: probe }));
      try {
        const read = await this.request<unknown>("readonly", (store) => store.get(probe));
        if (!read) throw new Error("probe mismatch");
      } finally {
        await this.request("readwrite", (store) => store.delete(probe));
      }
      const connections = await this.request("readwrite", (store) => store.count());
      this.checkRefused = false;
      return { available: true, backend: "Browser origin storage", connections, detail: "" };
    } catch {
      this.checkRefused = true;
      return {
        available: false,
        backend: "Browser origin storage",
        connections: 0,
        detail: "Origin storage refused the check. The browser may be blocking site data."
      };
    }
  }

  async list(): Promise<ConnectionSummary[]> {
    const records = await this.all();
    return records
      .map(({ secret: _secret, refreshToken: _refresh, metadata: _metadata, ...summary }) => summary)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredCredential | null> {
    const record = await this.request<StoredCredential | undefined>("readonly", (store) => store.get(id));
    return record ? { ...record } : null;
  }

  async set(credential: StoredCredential): Promise<void> {
    await this.request("readwrite", (store) => store.put({ ...credential }));
  }

  async remove(id: string): Promise<void> {
    await this.request("readwrite", (store) => store.delete(id));
  }

  async touch(id: string, at: string = new Date().toISOString()): Promise<void> {
    const record = await this.get(id);
    if (!record) return;
    await this.set({ ...record, lastUsedAt: at });
  }

  /** Explicit author action; also used by tests to start from an empty origin. */
  async clear(): Promise<void> {
    await this.request("readwrite", (store) => store.clear());
  }

  private async all(): Promise<StoredCredential[]> {
    const records = await this.request<StoredCredential[]>("readonly", (store) => store.getAll());
    return Array.isArray(records) ? records : [];
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("This browser does not offer origin storage for credentials."));
        return;
      }
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("The credential vault could not be opened."));
      request.onblocked = () => reject(new Error("The credential vault is blocked by another tab."));
    });
    return this.database;
  }

  private async request<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("The credential request failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("The credential transaction was aborted."));
    });
  }
}
