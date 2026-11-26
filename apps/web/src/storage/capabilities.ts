export interface StorageCapabilities {
  secureContext: boolean;
  folderAccess: boolean;
  browserStorage: boolean;
  persistence: boolean;
  locks: boolean;
}

/**
 * Feature detection, never browser-name sniffing.
 *
 * A missing folder picker does not mean the browser cannot store a library; it means the author
 * uses origin storage and the archive as the way out.
 */
export function detectStorageCapabilities(): StorageCapabilities {
  const secureContext = globalThis.isSecureContext === true;
  const browser = typeof window === "undefined" ? undefined : (window as Window & { showDirectoryPicker?: unknown });
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  return {
    secureContext,
    folderAccess: secureContext && typeof browser?.showDirectoryPicker === "function",
    browserStorage: typeof storage?.getDirectory === "function",
    persistence: typeof storage?.persist === "function",
    locks: typeof navigator !== "undefined" && Boolean(navigator.locks)
  };
}
