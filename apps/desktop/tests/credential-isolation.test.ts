import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronHooks, mockElectron } from "./support/mock-electron";

/*
 * An isolated test run (STUDIO_TEST=1 with STUDIO_NO_KEYCHAIN=1) refuses protected storage without
 * asking the operating system, so a hidden check never reaches the author's keychain. It is a
 * refusal and not a fallback: nothing is written. Either flag alone, or a packaged build, keeps the
 * real storage.
 */

type Storage = NonNullable<ElectronHooks["safeStorage"]>;

const cleanups: string[] = [];
const FLAGS = ["STUDIO_TEST", "STUDIO_NO_KEYCHAIN"] as const;
const saved = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

afterEach(async () => {
  for (const name of FLAGS) {
    const before = saved[name];
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

afterAll(() => {
  // Later files share the one Electron mock, so it goes back to its defaults.
  mockElectron(tmpdir());
});

/** Storage that is there and works, so a vault that still asks it shows as asked. */
const working: Storage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`, "utf8"),
  decryptString: (sealed) => sealed.toString("utf8").slice("sealed:".length)
};

function flags(testFlag: string | undefined, noKeychain: string | undefined): void {
  if (testFlag === undefined) delete process.env.STUDIO_TEST;
  else process.env.STUDIO_TEST = testFlag;
  if (noKeychain === undefined) delete process.env.STUDIO_NO_KEYCHAIN;
  else process.env.STUDIO_NO_KEYCHAIN = noKeychain;
}

async function vault(options: { isPackaged?: boolean } = {}) {
  const userData = await mkdtemp(join(tmpdir(), "abs-isolated-vault-"));
  cleanups.push(userData);
  const asked: string[] = [];
  mockElectron(userData, {
    safeStorage: working,
    safeStorageCalls: (method) => asked.push(method),
    ...(options.isPackaged === undefined ? {} : { isPackaged: options.isPackaged })
  });
  const { DesktopCredentialVault } = await import("../src/main/credentials");
  return { vault: new DesktopCredentialVault(), asked, file: join(userData, "credentials.json") };
}

const credential = {
  id: "conn_isolated0001",
  provider: "openrouter" as const,
  label: "OpenRouter",
  kind: "api-key" as const,
  createdAt: "2026-11-03T12:00:00.000Z",
  secret: ["synthetic", "secret", "for", "checks"].join("-")
};

describe("an isolated test run's vault", () => {
  test("never asks the operating system and reports protected storage as unavailable", async () => {
    flags("1", "1");
    const { vault: isolated, asked } = await vault();

    expect(await isolated.isAvailable()).toBe(false);
    expect(await isolated.status()).toMatchObject({ available: false });
    expect(await isolated.check()).toMatchObject({ available: false });
    expect(asked).toEqual([]);
  });

  test("refuses to save a key and writes nothing, rather than falling back to a plaintext file", async () => {
    flags("1", "1");
    const { vault: isolated, asked, file } = await vault();

    await expect(isolated.set(credential)).rejects.toThrow();
    await expect(stat(file)).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  test("neither flag alone, nor neither, switches protected storage off", async () => {
    for (const [testFlag, noKeychain] of [
      ["1", undefined],
      [undefined, "1"],
      [undefined, undefined],
      ["1", "0"]
    ] as const) {
      flags(testFlag, noKeychain);
      const { vault: normal, asked } = await vault();

      expect(await normal.status()).toMatchObject({ available: true });
      expect(asked).toContain("isAsyncEncryptionAvailable");
    }
  });

  test("a packaged build keeps protected storage whatever the environment says", async () => {
    flags("1", "1");
    const { vault: packaged, asked } = await vault({ isPackaged: true });

    expect(await packaged.status()).toMatchObject({ available: true });
    expect(asked).toContain("isAsyncEncryptionAvailable");
  });
});
