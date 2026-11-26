/** What the author is writing into, and how durable it is. */
export type StorageTier = "folder" | "browser";

export type StoragePermission = "granted" | "needs-action" | "read-only" | "unavailable";

export type StoragePersistence = "granted" | "not-granted" | "not-supported";

/**
 * The only storage information the interface receives. It never contains a directory handle,
 * a host path or a credential.
 */
export interface StorageSummary {
  tier: StorageTier;
  /** Author-readable destination, for example a folder name or “This browser”. */
  label: string;
  permission: StoragePermission;
  persistence: StoragePersistence;
  /** Null until this session has confirmed a write. */
  lastCommittedAt: string | null;
  /** Concise explanation when the guarantee is weaker than the desktop app's. */
  warning: string | null;
}

export function browserStorageWarning(persistence: StoragePersistence): string {
  if (persistence === "granted") {
    return "This library lives in this browser's storage. Clearing site data or losing the profile removes it, even when the browser has granted persistent storage.";
  }
  if (persistence === "not-granted") {
    return "This library lives in this browser's storage. The browser has not confirmed persistent storage, so it may remove it when space is low. Export an archive to keep a copy.";
  }
  return "This library lives in this browser's storage. This browser cannot promise to keep it; clearing site data removes it. Export an archive to keep a copy.";
}

export function folderPermissionWarning(permission: StoragePermission): string | null {
  if (permission === "granted") return null;
  if (permission === "read-only") return "The folder is read-only. Choose another folder or grant write access to save.";
  if (permission === "needs-action") return "The browser needs permission again before it can open this folder. Grant access to continue.";
  return "Folder access is unavailable in this browser. Use browser storage or export an archive to move the library.";
}
