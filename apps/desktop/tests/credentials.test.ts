import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Library } from "../src/main/library/store";
import { FileCredentialVault, newConnectionId, selectTestCipher, type Cipher } from "../src/main/credential-file";
import { ProviderService } from "../src/main/providers";

const cipher: Cipher = {
  available: () => true,
  encrypt: (value) => `enc:${Buffer.from(value, "utf8").toString("base64")}`,
  decrypt: (value) => {
    if (!value.startsWith("enc:")) throw new Error("tampered");
    return Buffer.from(value.slice(4), "base64").toString("utf8");
  }
};

async function workspace(): Promise<{ dir: string; path: string; vault: FileCredentialVault }> {
  const dir = await mkdtemp(join(tmpdir(), "abs-credentials-"));
  const path = join(dir, "credentials.json");
  return { dir, path, vault: new FileCredentialVault(path, cipher) };
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(path);
  }
  return files;
}

describe("credential vault", () => {
  test("the explicit isolated test mode never calls the protected-storage cipher", async () => {
    let calls = 0;
    const protectedCipher: Cipher = {
      available: () => {
        calls += 1;
        return true;
      },
      encrypt: () => {
        calls += 1;
        return "unused";
      },
      decrypt: () => {
        calls += 1;
        return "unused";
      }
    };
    const isolated = selectTestCipher(protectedCipher, { STUDIO_TEST: "1", STUDIO_NO_KEYCHAIN: "1" });
    expect(await isolated.available()).toBe(false);
    expect(() => isolated.encrypt("synthetic")).toThrow();
    expect(() => isolated.decrypt("synthetic")).toThrow();
    expect(calls).toBe(0);
    // Either flag alone leaves the cipher it was given.
    expect(selectTestCipher(protectedCipher, { STUDIO_NO_KEYCHAIN: "1" })).toBe(protectedCipher);
    expect(selectTestCipher(protectedCipher, { STUDIO_TEST: "1" })).toBe(protectedCipher);
    expect(selectTestCipher(protectedCipher, {})).toBe(protectedCipher);
  });

  test("reports protected storage status without a secret", async () => {
    const { vault } = await workspace();
    expect(await vault.status()).toEqual({ available: true, backend: "Protected storage", detail: "" });
  });

  test("the open-path status never touches the cipher", async () => {
    const { path } = await workspace();
    const hostile: Cipher = {
      available: () => true,
      encrypt: () => {
        throw new Error("must not encrypt on open");
      },
      decrypt: () => {
        throw new Error("must not decrypt on open");
      }
    };
    const vault = new FileCredentialVault(path, hostile);
    expect(await vault.status()).toEqual({ available: true, backend: "Protected storage", detail: "" });
  });

  test("the explicit check round-trips one probe value", async () => {
    const { vault } = await workspace();
    expect(await vault.check()).toEqual({ available: true, backend: "Protected storage", detail: "" });
  });

  test("the explicit check reports a refused cipher instead of throwing", async () => {
    const { path } = await workspace();
    const refusing: Cipher = {
      available: () => true,
      encrypt: (value) => `enc:${value}`,
      decrypt: () => {
        throw new Error("locked");
      }
    };
    const vault = new FileCredentialVault(path, refusing);
    const state = await vault.check();
    expect(state.available).toBe(false);
    expect(state.detail).toContain("keyring");
  });

  test("the explicit check reports unavailable storage without probing", async () => {
    const { path } = await workspace();
    const absent: Cipher = {
      available: () => false,
      encrypt: () => {
        throw new Error("must not encrypt when unavailable");
      },
      decrypt: () => {
        throw new Error("must not decrypt when unavailable");
      }
    };
    const vault = new FileCredentialVault(path, absent);
    expect(await vault.check()).toEqual({
      available: false,
      backend: "Protected storage",
      detail: "Protected storage is unavailable."
    });
  });

  test("repairs a vault file that others can read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abs-credentials-mode-"));
    const path = join(dir, "credentials.json");
    try {
      await writeFile(path, '{"version":1,"records":[]}\n');
      await chmod(path, 0o644);
      const vault = new FileCredentialVault(path, cipher);

      expect(await vault.repairPermissions()).toBe("corrected");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await vault.repairPermissions()).toBe("owner-only");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stored connection leaves no secret in settings or the library", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abs-secret-scan-"));
    try {
      const vault = new FileCredentialVault(join(dir, "credentials.json"), cipher);
      const secret = "sk-or-v1-scan-secret-1234567890";
      const id = newConnectionId();
      await vault.set({
        id,
        provider: "openrouter",
        label: "OpenRouter",
        kind: "openrouter-oauth",
        createdAt: "2026-10-25T12:00:00.000Z",
        secret
      });
      await vault.touch(id);
      expect(JSON.stringify(await vault.list())).not.toContain(secret);

      await writeFile(join(dir, "studio.json"), `${JSON.stringify({ libraryRoot: join(dir, "library") }, null, 2)}\n`);
      const library = await Library.open(join(dir, "library"));
      const book = await library.createBook({ title: "Scan" });
      await library.createChapter(book.id, { title: "One", content: "Plain prose.\n" });

      for (const file of await filesUnder(dir)) {
        expect((await readFile(file)).includes(Buffer.from(secret))).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("round-trips a secret without writing it in plaintext", async () => {
    const { dir, path, vault } = await workspace();
    try {
      const id = newConnectionId();
      await vault.set({
        id,
        provider: "openrouter",
        label: "OpenRouter",
        kind: "openrouter-oauth",
        createdAt: "2026-10-24T10:00:00.000Z",
        secret: "sk-or-v1-super-secret-value"
      });

      const stored = await vault.get(id);
      expect(stored?.secret).toBe("sk-or-v1-super-secret-value");

      const raw = await readFile(path, "utf8");
      expect(raw).not.toContain("super-secret-value");

      const summaries = await vault.list();
      expect(summaries).toHaveLength(1);
      expect(JSON.stringify(summaries)).not.toContain("secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("touch updates last use without changing the secret", async () => {
    const { dir, vault } = await workspace();
    try {
      const id = newConnectionId();
      await vault.set({
        id,
        provider: "openai",
        label: "OpenAI",
        kind: "api-key",
        createdAt: "2026-10-24T10:00:00.000Z",
        secret: "sk-test-1234567890"
      });
      await vault.touch(id, "2026-10-25T10:00:00.000Z");
      expect((await vault.list())[0]?.lastUsedAt).toBe("2026-10-25T10:00:00.000Z");
      expect((await vault.get(id))?.secret).toBe("sk-test-1234567890");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("remove deletes the record", async () => {
    const { dir, vault } = await workspace();
    try {
      const id = newConnectionId();
      await vault.set({
        id,
        provider: "openrouter",
        label: "OpenRouter",
        kind: "openrouter-oauth",
        createdAt: "2026-10-24T10:00:00.000Z",
        secret: "sk-or-v1-abc"
      });
      await vault.remove(id);
      expect(await vault.list()).toEqual([]);
      expect(await vault.get(id)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a removed connection makes no later provider requests", async () => {
    const { dir, vault } = await workspace();
    try {
      const id = newConnectionId();
      await vault.set({
        id,
        provider: "openai",
        label: "OpenAI",
        kind: "api-key",
        createdAt: "2026-10-24T10:00:00.000Z",
        secret: "sk-test"
      });
      let fetches = 0;
      const service = new ProviderService(
        vault,
        async () => {},
        (async () => {
          fetches += 1;
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
        }) as unknown as typeof fetch
      );
      await service.models(id);
      expect(fetches).toBe(1);

      await service.remove(id);
      await expect(service.models(id)).rejects.toThrow(/no longer exists/);
      expect(fetches).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removing a connection clears its cached models", async () => {
    const { dir, vault } = await workspace();
    try {
      const id = newConnectionId();
      const record = {
        id,
        provider: "openai",
        label: "OpenAI",
        kind: "api-key",
        createdAt: "2026-10-24T10:00:00.000Z",
        secret: "sk-test"
      } as Parameters<FileCredentialVault["set"]>[0];
      await vault.set(record);
      let fetches = 0;
      const service = new ProviderService(
        vault,
        async () => {},
        (async () => {
          fetches += 1;
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
        }) as unknown as typeof fetch
      );
      await service.models(id);
      await service.models(id);
      expect(fetches).toBe(1);

      await service.remove(id);
      expect(await vault.list()).toEqual([]);

      // The same account connects again. A kept cache would answer without asking.
      await vault.set(record);
      await service.models(id);
      expect(fetches).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removing a connection keeps the manuscript and its history", async () => {
    const { dir, vault } = await workspace();
    const root = await mkdtemp(join(tmpdir(), "abs-keep-manuscript-"));
    try {
      const id = newConnectionId();
      await vault.set({
        id,
        provider: "openai",
        label: "OpenAI",
        kind: "api-key",
        createdAt: "2026-10-24T10:00:00.000Z",
        secret: "sk-test"
      });
      const service = new ProviderService(vault, async () => {}, (async () => {
        throw new Error("no provider requests while proving removal keeps the manuscript");
      }) as unknown as typeof fetch);

      const library = await Library.open(root);
      const book = await library.createBook({ title: "Kept" });
      const chapter = await library.createChapter(book.id, { title: "One", content: "The storm stayed." });
      const thread = await library.threads.create(book.id, "First talk", [
        {
          id: "msg_kept000001",
          role: "user",
          parts: [{ type: "text", text: "Keep this." }],
          createdAt: "2026-10-24T10:00:00.000Z"
        }
      ]);
      const chapterBefore = await library.readChapter(book.id, chapter.id);
      const threadBefore = await library.threads.read(book.id, thread.id);
      const filesBefore = await filesUnder(root);

      await service.remove(id);

      expect(await library.readChapter(book.id, chapter.id)).toEqual(chapterBefore);
      expect(await library.threads.read(book.id, thread.id)).toEqual(threadBefore);
      expect(await filesUnder(root)).toEqual(filesBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a tampered record fails with a reconnect message", async () => {
    const { dir, path } = await workspace();
    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          records: [
            {
              id: "conn_tampered0001",
              provider: "openrouter",
              label: "OpenRouter",
              kind: "openrouter-oauth",
              createdAt: "2026-10-24T10:00:00.000Z",
              secretCipher: "not-encrypted"
            }
          ]
        }),
        "utf8"
      );
      const fresh = new FileCredentialVault(path, cipher);
      await expect(fresh.get("conn_tampered0001")).rejects.toThrow(/could not be read/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses to save when protected storage is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abs-credentials-"));
    try {
      const vault = new FileCredentialVault(join(dir, "credentials.json"), { ...cipher, available: () => false });
      await expect(
        vault.set({
          id: newConnectionId(),
          provider: "openrouter",
          label: "OpenRouter",
          kind: "openrouter-oauth",
          createdAt: "2026-10-24T10:00:00.000Z",
          secret: "sk-or-v1-abc"
        })
      ).rejects.toThrow(/protected storage/);
      expect(await vault.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
