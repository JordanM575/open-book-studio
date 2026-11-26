import { afterEach, describe, expect, test } from "bun:test";
import { detectStorageCapabilities } from "../../src/storage/capabilities";
import { requestPersistence } from "../../src/storage/opfs";

const original = {
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  isSecureContext: Object.getOwnPropertyDescriptor(globalThis, "isSecureContext")
};

function restore(key: keyof typeof original): void {
  const descriptor = original[key];
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}

function setGlobal(key: keyof typeof original, value: unknown): void {
  Object.defineProperty(globalThis, key, { configurable: true, enumerable: true, writable: true, value });
}

afterEach(() => {
  restore("window");
  restore("navigator");
  restore("isSecureContext");
});

describe("browser storage capabilities", () => {
  test("detects each feature without browser-name sniffing", () => {
    setGlobal("window", { showDirectoryPicker: () => {} });
    setGlobal("navigator", { storage: { getDirectory: () => {}, persist: () => {} }, locks: {} });
    setGlobal("isSecureContext", true);

    expect(detectStorageCapabilities()).toEqual({
      secureContext: true,
      folderAccess: true,
      browserStorage: true,
      persistence: true,
      locks: true
    });

    setGlobal("isSecureContext", false);
    expect(detectStorageCapabilities().folderAccess).toBe(false);

    setGlobal("window", {});
    setGlobal("isSecureContext", true);
    const noPicker = detectStorageCapabilities();
    expect(noPicker.folderAccess).toBe(false);
    expect(noPicker.browserStorage).toBe(true);
  });

  test("ignores noncallable folder, storage and persistence properties", () => {
    setGlobal("isSecureContext", true);
    setGlobal("window", { showDirectoryPicker: undefined });
    setGlobal("navigator", { storage: { getDirectory: {}, persist: true } });
    expect(detectStorageCapabilities()).toMatchObject({ folderAccess: false, browserStorage: false, persistence: false });
  });

  test("reports persistence denial, unsupported and failure honestly", async () => {
    setGlobal("navigator", {});
    expect(await requestPersistence()).toBe("not-supported");

    setGlobal("navigator", { storage: { persist: async () => true } });
    expect(await requestPersistence()).toBe("granted");

    setGlobal("navigator", { storage: { persist: async () => false } });
    expect(await requestPersistence()).toBe("not-granted");

    setGlobal("navigator", {
      storage: {
        persist: async () => {
          throw new Error("denied");
        }
      }
    });
    expect(await requestPersistence()).toBe("not-granted");
  });
});
