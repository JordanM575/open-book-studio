import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import { BROWSER_CREDENTIAL_DISCLOSURE } from "@ai-book-studio/core/providers/credentials";
import type { StoredCredential } from "@ai-book-studio/core/providers/types";
import { BrowserCredentialVault } from "../../src/storage/credentials";

let counter = 1;

function credential(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    id: "conn_test000001",
    provider: "openrouter",
    label: "OpenRouter",
    kind: "openrouter-oauth",
    createdAt: "2026-10-25T12:00:00.000Z",
    secret: "sk-or-v1-browser-secret-1234567890",
    ...overrides
  };
}

describe("browser credential vault", () => {
  test("stores a connection without exposing the secret in summaries", async () => {
    const name = `test-credentials-${counter++}`;
    const vault = new BrowserCredentialVault(name);
    const id = "conn_browser000001";
    await vault.set(
      credential({
        id,
        secret: "sk-or-v1-browser-secret-1234567890"
      })
    );

    const listed = await vault.list();
    expect(listed).toEqual([
      {
        id,
        provider: "openrouter",
        label: "OpenRouter",
        kind: "openrouter-oauth",
        createdAt: "2026-10-25T12:00:00.000Z"
      }
    ]);
    expect(JSON.stringify(listed)).not.toContain("browser-secret");

    const stored = await vault.get(id);
    expect(stored?.secret).toBe("sk-or-v1-browser-secret-1234567890");
  });

  test("touch, remove and a reopened vault keep the origin-scoped record", async () => {
    const name = `test-credentials-${counter++}`;
    const first = new BrowserCredentialVault(name);
    const id = "conn_browser000002";
    await first.set(credential({ id }));
    await first.touch(id, "2026-10-25T13:00:00.000Z");

    const reopened = new BrowserCredentialVault(name);
    expect((await reopened.get(id))?.lastUsedAt).toBe("2026-10-25T13:00:00.000Z");

    await reopened.remove(id);
    expect(await reopened.list()).toEqual([]);
  });

  test("the disclosure is origin-scoped and makes no keychain claim", () => {
    expect(BROWSER_CREDENTIAL_DISCLOSURE).toContain("origin storage");
    expect(BROWSER_CREDENTIAL_DISCLOSURE).toContain("clearing site data removes them");
    expect(BROWSER_CREDENTIAL_DISCLOSURE).toContain("never written into the library");
    expect(BROWSER_CREDENTIAL_DISCLOSURE.toLowerCase()).not.toContain("keychain protects");
  });

  test("is available only when the origin offers IndexedDB", async () => {
    expect(await new BrowserCredentialVault(`test-credentials-${counter++}`).isAvailable()).toBe(true);
  });

  test("the explicit check round-trips and leaves no probe record", async () => {
    const vault = new BrowserCredentialVault(`test-credentials-${counter++}`);
    expect(await vault.check()).toEqual({ available: true, backend: "Browser origin storage", connections: 0, detail: "" });
    expect(await vault.list()).toEqual([]);
  });
});
