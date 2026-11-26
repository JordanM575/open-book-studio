import { afterEach, describe, expect, test } from "bun:test";
import { toLibraryPath } from "@ai-book-studio/core/library/path";
import {
  newBrowserLibraryId,
  openBrowserLibrary,
  removeBrowserLibrary,
  requestPersistence,
  storageEstimate
} from "../../src/storage/opfs";
import { FakeDirectory } from "./support/fake-directory";

/**
 * Origin storage, opened and closed for real.
 *
 * The two failure tests next door prove that a browser which hangs or refuses is reported in a
 * sentence an author can act on. These prove the other half: that a working browser gets a port
 * over a real directory tree, that the persistence promise is asked for rather than assumed, and
 * that deleting a library deletes it.
 */

type Global = { navigator?: unknown; isSecureContext?: boolean };
const globals = globalThis as Global;
const originalNavigator = globals.navigator;
const originalSecure = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");

afterEach(() => {
  if (originalNavigator === undefined) delete globals.navigator;
  else globals.navigator = originalNavigator;
  if (originalSecure) Object.defineProperty(globalThis, "isSecureContext", originalSecure);
});

/** A navigator whose origin storage is a real fake tree. */
function secureNavigator(options: { persist?: () => Promise<boolean>; estimate?: () => Promise<{ usage?: number; quota?: number }> } = {}) {
  const root = new FakeDirectory("root");
  Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
  globals.navigator = {
    storage: {
      getDirectory: async () => root,
      ...(options.persist ? { persist: options.persist } : {}),
      ...(options.estimate ? { estimate: options.estimate } : {})
    }
  };
  return root;
}

describe("opening a library in the browser", () => {
  test("creates the tree under libraries/ and returns a port and a summary", async () => {
    const root = secureNavigator({ persist: async () => true });
    const library = await openBrowserLibrary("library_one");

    expect(library.libraryId).toBe("library_one");
    expect(library.summary.tier).toBe("browser");
    expect(library.summary.label).toBe("This browser");
    expect(library.summary.permission).toBe("granted");
    expect(library.summary.persistence).toBe("granted");
    expect(library.summary.lastCommittedAt).toBeNull();
    // The folder exists before anything is written into it.
    expect(root.directories.get("libraries")?.directories.has("library_one")).toBe(true);
  });

  test("warns when the browser will not promise to keep the data", async () => {
    secureNavigator({ persist: async () => false });
    const library = await openBrowserLibrary("library_two");
    expect(library.summary.persistence).toBe("not-granted");
    // The author is told the difference, because a browser may evict an unpromised origin.
    expect(library.summary.warning ?? "").not.toBe("");
  });

  test("opens the library when the browser leaves persistence pending", async () => {
    const persistence = Promise.withResolvers<boolean>();
    const root = secureNavigator({ persist: () => persistence.promise });
    const library = await openBrowserLibrary("library_pending", { timeoutMs: 10 });

    expect(root.directories.get("libraries")?.directories.has("library_pending")).toBe(true);
    expect(await library.port.listDirectory(toLibraryPath([]))).toEqual([]);
    expect(library.summary).toMatchObject({ tier: "browser", permission: "granted", persistence: "not-granted" });
    expect(library.summary.warning).toContain("has not confirmed persistent storage");

    persistence.resolve(true);
    await persistence.promise;
    expect(library.summary.persistence).toBe("not-granted");
  });

  test("says plainly when the browser has no origin storage at all", async () => {
    Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
    globals.navigator = { storage: {} };
    await expect(openBrowserLibrary("library_three")).rejects.toMatchObject({ code: "unsupported" });
  });

  test("reports a failure to create the library folder with the recovery sentence", async () => {
    secureNavigator();
    // A folder that exists in name but refuses to be created is what a full disk looks like.
    const root = new FakeDirectory("root");
    root.getDirectoryHandle = async () => {
      throw new Error("QuotaExceededError");
    };
    (globals.navigator as { storage: { getDirectory: () => Promise<FakeDirectory> } }).storage.getDirectory = async () => root;
    await expect(openBrowserLibrary("library_four", { timeoutMs: 50 })).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("origin storage")
    });
  });
});

describe("persistence", () => {
  test("is not-supported when the browser has no promise to make", async () => {
    globals.navigator = { storage: {} };
    expect(await requestPersistence()).toBe("not-supported");
  });

  test("is granted when the browser says yes, and not-granted when it says no", async () => {
    globals.navigator = { storage: { persist: async () => true } };
    expect(await requestPersistence()).toBe("granted");
    globals.navigator = { storage: { persist: async () => false } };
    expect(await requestPersistence()).toBe("not-granted");
  });

  test("a refused promise is treated as no promise, not as an error", async () => {
    globals.navigator = {
      storage: {
        persist: async () => {
          throw new Error("the user agent said no");
        }
      }
    };
    expect(await requestPersistence()).toBe("not-granted");
  });
});

describe("deleting a library", () => {
  test("removes the folder and everything in it", async () => {
    const root = secureNavigator();
    const libraries = await root.getDirectoryHandle("libraries", { create: true });
    const doomed = await libraries.getDirectoryHandle("library_five", { create: true });
    await doomed.getFileHandle("book.json", { create: true });

    await removeBrowserLibrary("library_five");
    expect(libraries.directories.has("library_five")).toBe(false);
  });

  test("treats an already-deleted library as done", async () => {
    secureNavigator();
    await expect(removeBrowserLibrary("library_never_existed")).resolves.toBeUndefined();
  });

  test("does not swallow a real failure", async () => {
    const root = secureNavigator();
    const libraries = await root.getDirectoryHandle("libraries", { create: true });
    libraries.removeEntry = async () => {
      throw Object.assign(new Error("permission"), { name: "NotAllowedError" });
    };
    await expect(removeBrowserLibrary("library_six")).rejects.toThrow("permission");
  });
});

describe("how much room there is", () => {
  test("reports what the browser estimates", async () => {
    secureNavigator({ estimate: async () => ({ usage: 1024, quota: 10_485_760 }) });
    expect(await storageEstimate()).toEqual({ usage: 1024, quota: 10_485_760 });
  });

  test("fills in a zero rather than showing a blank", async () => {
    secureNavigator({ estimate: async () => ({}) });
    expect(await storageEstimate()).toEqual({ usage: 0, quota: 0 });
  });

  test("says it does not know when the browser cannot estimate", async () => {
    globals.navigator = { storage: {} };
    expect(await storageEstimate()).toBeNull();
  });
});

describe("the id a library gets", () => {
  test("is a library id, and two of them differ", () => {
    const first = newBrowserLibraryId();
    const second = newBrowserLibraryId();
    expect(first).toMatch(/^library_[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
  });

  test("falls back to random bytes where randomUUID is missing", () => {
    const real = globalThis.crypto.randomUUID;
    // A non-secure context has getRandomValues but no randomUUID.
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      expect(newBrowserLibraryId()).toMatch(/^library_[0-9a-f]{16}$/);
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", { value: real, configurable: true });
    }
  });
});
