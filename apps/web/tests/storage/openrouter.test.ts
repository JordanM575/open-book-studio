/// <reference types="bun" />
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MemoryVault } from "@ai-book-studio/core/providers/credentials";
import type { ConnectionSummary, StoredCredential } from "@ai-book-studio/core/providers/types";
import { createPkce, PKCE_TIMEOUT_MS } from "@ai-book-studio/core/providers/openrouter";

const registered = typeof document === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost" });
await import("fake-indexeddb/auto");
const { BrowserCredentialVault } = await import("../../src/storage/credentials");
const { BrowserLibraries } = await import("../../src/runtime/browser-libraries");
const { createBrowserStudioApi } = await import("../../src/runtime/browser-api");
const { OPENROUTER_PKCE_KEY, cancelOpenRouterFlow, handleOpenRouterCallback, startOpenRouterFlow } = await import(
  "../../src/runtime/openrouter"
);

const original = {
  fetch: globalThis.fetch,
  open: window.open,
  close: window.close,
  opener: window.opener
};

const activePrefix = "ai-book-studio.openrouter.active.";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function connectSyntheticOpener() {
  window.close = mock(() => {});
  Object.defineProperty(window, "opener", {
    value: {
      closed: false,
      postMessage: (data: unknown, origin: string) => {
        window.dispatchEvent(new MessageEvent("message", { origin, data }));
      }
    },
    configurable: true
  });
}

/** Make both site-storage objects throw, as a browser that denies storage access does. Returns the restore. */
function denySiteStorage(error: Error): () => void {
  const denied = new Proxy({}, { get: () => () => { throw error; } });
  const targets: object[] = [globalThis, window];
  const saved: Array<[object, string, PropertyDescriptor | undefined]> = [];
  for (const target of targets) {
    for (const name of ["sessionStorage", "localStorage"]) {
      saved.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
      Object.defineProperty(target, name, { configurable: true, get: () => denied });
    }
  }
  return () => {
    for (const [target, name, descriptor] of saved.reverse()) {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    }
  };
}

async function callbackFixture(createdAt = 1_000) {
  const pkce = await createPkce(createdAt);
  sessionStorage.setItem(OPENROUTER_PKCE_KEY, JSON.stringify(pkce));
  localStorage.setItem(`${activePrefix}${pkce.state}`, "pending");
  return pkce;
}

beforeEach(async () => {
  globalThis.fetch = (async () => { throw new Error("unexpected network request"); }) as unknown as typeof fetch;
  await new BrowserCredentialVault().clear();
});

afterEach(() => {
  globalThis.fetch = original.fetch;
  window.open = original.open;
  window.close = original.close;
  Object.defineProperty(window, "opener", { value: original.opener, configurable: true });
  window.history.replaceState({}, "", "/");
  sessionStorage.clear();
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(activePrefix)) localStorage.removeItem(key);
  }
});

afterAll(() => {
  if (registered) GlobalRegistrator.unregister();
});

describe("browser OpenRouter sign-in", () => {
  test("the callback exchanges the code, stores the key and messages the opener", async () => {
    const pkce = await callbackFixture(Date.now());
    window.history.replaceState({}, "", `/?openrouter=callback&code=code123&state=${pkce.state}`);

    const posted: Array<{ data: unknown; origin: string }> = [];
    const opener = {
      closed: false,
      postMessage: (data: unknown, origin: string) => posted.push({ data, origin })
    };
    Object.defineProperty(window, "opener", { value: opener, configurable: true });
    window.close = mock(() => {});

    const fetchMock = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ key: "sk-or-v1-browser-test-key" }),
      text: async () => ""
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const connection = await handleOpenRouterCallback();

    expect(connection?.provider).toBe("openrouter");
    expect(connection?.kind).toBe("openrouter-oauth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await new BrowserCredentialVault().get(connection!.id))?.secret === "sk-or-v1-browser-test-key").toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.data).toMatchObject({ type: "openrouter", connection });
    expect(posted[0]?.origin).toBe(window.location.origin);
    expect(sessionStorage.getItem(OPENROUTER_PKCE_KEY) === null).toBe(true);
    expect(window.location.search).toBe("");
  });

  test("the popup flow resolves from a same-origin message", async () => {
    const popup = { closed: false, close: mock(() => {}) };
    let opened = "";
    window.open = ((url: string) => {
      opened = String(url);
      return popup as unknown as Window;
    }) as typeof window.open;

    const flow = startOpenRouterFlow();
    for (let attempt = 0; attempt < 100 && !opened; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(opened).not.toBe("");
    const state = new URL(opened).searchParams.get("state");
    expect(state).toBeTruthy();

    const connection: ConnectionSummary = {
      id: "conn_browser000099",
      provider: "openrouter",
      label: "OpenRouter",
      kind: "openrouter-oauth",
      createdAt: "2026-10-25T12:00:00.000Z"
    };
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { type: "openrouter", state, connection }
      })
    );

    await expect(flow).resolves.toEqual(connection);
  });

  test("a browser that denies site storage rejects the sign-in instead of leaving it waiting", async () => {
    const denied = Object.assign(new Error("The operation is insecure."), { name: "SecurityError" });
    const restoreStorage = denySiteStorage(denied);
    let opened = 0;
    window.open = (() => { opened += 1; return null; }) as typeof window.open;
    try {
      const outcome = await Promise.race([
        startOpenRouterFlow().then(() => "resolved", (error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000))
      ]);
      expect(outcome).toBe(denied);
      expect(opened).toBe(0);
    } finally {
      restoreStorage();
    }

    // The failed start released its slot: the next sign-in is not told one is already waiting.
    const popup = { closed: false, close: mock(() => { popup.closed = true; }) };
    window.open = (() => popup as unknown as Window) as typeof window.open;
    const next = startOpenRouterFlow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelOpenRouterFlow();
    await expect(next).rejects.toMatchObject({ message: "Sign-in cancelled." });
  });

  test("cancelling the popup rejects the pending flow", async () => {
    const popup = { closed: false, close: mock(() => { popup.closed = true; }) };
    window.open = (() => popup as unknown as Window) as typeof window.open;

    const flow = startOpenRouterFlow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelOpenRouterFlow();

    await expect(flow).rejects.toMatchObject({ message: "Sign-in cancelled." });
  });

  test("a storage check refusal stops sign-in before the preparing popup opens", async () => {
    const studio = createBrowserStudioApi(new BrowserLibraries());
    const digestStarted = deferred<void>();
    const digestResult = deferred<ArrayBuffer>();
    const digest = spyOn(crypto.subtle, "digest").mockImplementationOnce(async () => {
      digestStarted.resolve();
      return digestResult.promise;
    });
    const put = spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("Denied", "QuotaExceededError");
    });
    const open = spyOn(window, "open").mockReturnValue(null);
    try {
      const attempt = studio.connections.startOpenRouter();
      await digestStarted.promise;
      expect(open).not.toHaveBeenCalled();

      expect(await studio.connections.check()).toMatchObject({ ok: true, data: { available: false } });
      expect(await studio.connections.check()).toMatchObject({ ok: true, data: { available: true } });
      digestResult.resolve(new ArrayBuffer(32));
      const refused = await attempt;
      expect(open).not.toHaveBeenCalled();
      expect(refused).toMatchObject({
        ok: false,
        error: { code: "unsupported", message: expect.stringContaining("Origin storage refused the check") }
      });
      expect(sessionStorage.getItem(OPENROUTER_PKCE_KEY)).toBeNull();

      expect(await studio.connections.startOpenRouter()).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("browser blocked") }
      });
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      digestResult.resolve(new ArrayBuffer(32));
      cancelOpenRouterFlow();
      digest.mockRestore();
      put.mockRestore();
      open.mockRestore();
    }
  });

  test("a state mismatch consumes the request, scrubs the callback and writes nothing", async () => {
    const pkce = await callbackFixture(Date.now());
    window.history.replaceState({}, "", "/?openrouter=callback&code=synthetic-code&state=wrong");
    const fetchMock = mock(async () => Response.json({ key: "synthetic-key" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const posted: unknown[] = [];
    Object.defineProperty(window, "opener", {
      value: { closed: false, postMessage: (data: unknown) => posted.push(data) }, configurable: true
    });

    await expect(handleOpenRouterCallback()).rejects.toThrow(/did not match/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(sessionStorage.getItem(OPENROUTER_PKCE_KEY) === null).toBe(true);
    expect(window.location.search).toBe("");
    expect(await new BrowserCredentialVault().list()).toEqual([]);
    expect(posted).toEqual([{ type: "openrouter-error", state: pkce.state, message: expect.stringMatching(/did not match/) }]);
    expect(localStorage.getItem(`${activePrefix}${pkce.state}`)).toBeNull();
  });

  test("an expired callback cannot exchange or persist a credential", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000 + PKCE_TIMEOUT_MS + 1);
    try {
      const pkce = await callbackFixture();
      window.history.replaceState({}, "", `/?openrouter=callback&code=synthetic-code&state=${pkce.state}`);
      const fetchMock = mock(async () => Response.json({ key: "synthetic-key" }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(handleOpenRouterCallback()).rejects.toThrow(/expired/);
      expect(fetchMock).toHaveBeenCalledTimes(0);
      expect(sessionStorage.getItem(OPENROUTER_PKCE_KEY) === null).toBe(true);
      expect(window.location.search).toBe("");
      expect(await new BrowserCredentialVault().list()).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  test("a duplicate callback cannot exchange the same code while the first exchange is pending", async () => {
    const pkce = await callbackFixture(Date.now());
    const copiedRequest = sessionStorage.getItem(OPENROUTER_PKCE_KEY);
    expect(copiedRequest !== null).toBe(true);
    const url = `/?openrouter=callback&code=synthetic-code&state=${pkce.state}`;
    window.history.replaceState({}, "", url);
    const exchange = deferred<Response>();
    const fetchMock = mock(() => exchange.promise);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = handleOpenRouterCallback();
    // Another popup may have inherited a copy of the original tab's sessionStorage.
    sessionStorage.setItem(OPENROUTER_PKCE_KEY, copiedRequest!);
    window.history.replaceState({}, "", url);
    const duplicate = handleOpenRouterCallback();
    void duplicate.catch(() => {});
    exchange.resolve(Response.json({ key: "synthetic-key" }));

    await first;
    await expect(duplicate).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await new BrowserCredentialVault().list()).toHaveLength(1);
  });

  test("a failed exchange cannot be replayed and leaves no credential", async () => {
    const pkce = await callbackFixture(Date.now());
    const url = `/?openrouter=callback&code=synthetic-code&state=${pkce.state}`;
    window.history.replaceState({}, "", url);
    const fetchMock = mock(async () => new Response("error", { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(handleOpenRouterCallback()).rejects.toThrow();
    window.history.replaceState({}, "", url);
    await expect(handleOpenRouterCallback()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await new BrowserCredentialVault().list()).toEqual([]);
  });

  test("an exchange response arriving after expiry cannot write a credential", async () => {
    let now = 1_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const pkce = await callbackFixture(now);
      window.history.replaceState({}, "", `/?openrouter=callback&code=synthetic-code&state=${pkce.state}`);
      const exchange = deferred<Response>();
      globalThis.fetch = (() => exchange.promise) as unknown as typeof fetch;

      const callback = handleOpenRouterCallback();
      void callback.catch(() => {});
      now += PKCE_TIMEOUT_MS + 1;
      exchange.resolve(Response.json({ key: "synthetic-key" }));

      await expect(callback).rejects.toThrow(/expired/);
      expect(await new BrowserCredentialVault().list()).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  test("cancelling the popup discards an exchange response that arrives later", async () => {
    const opened = deferred<string>();
    const popup = { closed: false, close: mock(() => { popup.closed = true; }) };
    window.open = ((url: string) => {
      opened.resolve(String(url));
      return popup as unknown as Window;
    }) as typeof window.open;
    connectSyntheticOpener();
    const exchange = deferred<Response>();
    const started = deferred<void>();
    globalThis.fetch = (async () => { started.resolve(); return exchange.promise; }) as unknown as typeof fetch;

    const flow = startOpenRouterFlow();
    void flow.catch(() => {});
    const authUrl = await opened.promise;
    const state = new URL(authUrl).searchParams.get("state");
    window.history.replaceState({}, "", `/?openrouter=callback&code=synthetic-code&state=${state}`);
    const callback = handleOpenRouterCallback();
    void callback.catch(() => {});
    await started.promise;
    cancelOpenRouterFlow();
    exchange.resolve(Response.json({ key: "synthetic-key" }));

    await expect(flow).rejects.toThrow(/cancelled/);
    await expect(callback).rejects.toThrow(/cancelled/);
    expect(await new BrowserCredentialVault().list()).toEqual([]);
  });

  test("cancellation signals an in-flight popup exchange without closing it before cleanup", async () => {
    const opened = deferred<string>();
    const started = deferred<void>();
    const popup = { closed: false, close: mock(() => { popup.closed = true; }) };
    window.open = ((url: string) => {
      opened.resolve(String(url));
      return popup as unknown as Window;
    }) as typeof window.open;
    connectSyntheticOpener();
    let aborted = false;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("synthetic abort")); });
      started.resolve();
    })) as unknown as typeof fetch;

    const flow = startOpenRouterFlow();
    void flow.catch(() => {});
    const authUrl = await opened.promise;
    const state = new URL(authUrl).searchParams.get("state");
    window.history.replaceState({}, "", `/?openrouter=callback&code=synthetic-code&state=${state}`);
    const callback = handleOpenRouterCallback();
    void callback.catch(() => {});
    await started.promise;
    cancelOpenRouterFlow();
    expect(popup.closed).toBe(false);
    window.dispatchEvent(new StorageEvent("storage", { key: `${activePrefix}${state}`, newValue: null }));

    await expect(flow).rejects.toThrow(/cancelled/);
    await expect(callback).rejects.toThrow(/cancelled/);
    expect(aborted).toBe(true);
    expect(await new BrowserCredentialVault().list()).toEqual([]);
  });

  test("cancellation during setup prevents a popup and rejects a simultaneous start", async () => {
    let opened = 0;
    window.open = (() => { opened += 1; return null; }) as typeof window.open;
    const flow = startOpenRouterFlow();
    void flow.catch(() => {});
    const duplicate = startOpenRouterFlow();
    void duplicate.catch(() => {});
    cancelOpenRouterFlow();

    await expect(flow).rejects.toThrow(/cancelled/);
    await expect(duplicate).rejects.toMatchObject({ code: "invalid-request" });
    expect(opened).toBe(0);
    expect(await new BrowserCredentialVault().list()).toEqual([]);
  });

  test("cancellation during a vault write removes the new credential before the callback fails", async () => {
    const opened = deferred<string>();
    const writing = deferred<void>();
    const resume = deferred<void>();
    class DelayedVault extends MemoryVault {
      override async set(value: StoredCredential): Promise<void> {
        writing.resolve();
        await resume.promise;
        await super.set(value);
      }
    }
    const vault = new DelayedVault();
    const popup = { closed: false, close: mock(() => { popup.closed = true; }) };
    connectSyntheticOpener();
    window.open = ((url: string) => {
      opened.resolve(String(url));
      return popup as unknown as Window;
    }) as typeof window.open;
    globalThis.fetch = (async () => Response.json({ key: "synthetic-key" })) as unknown as typeof fetch;

    const flow = startOpenRouterFlow();
    void flow.catch(() => {});
    let flowSettled = false;
    void flow.then(() => { flowSettled = true; }, () => { flowSettled = true; });
    const authUrl = await opened.promise;
    const state = new URL(authUrl).searchParams.get("state");
    window.history.replaceState({}, "", `/?openrouter=callback&code=synthetic-code&state=${state}`);
    const callback = handleOpenRouterCallback(vault);
    void callback.catch(() => {});
    await writing.promise;
    cancelOpenRouterFlow();
    expect(popup.closed).toBe(false);
    await Promise.resolve();
    expect(flowSettled).toBe(false);
    resume.resolve();

    await expect(flow).rejects.toThrow(/cancelled/);
    await expect(callback).rejects.toThrow(/cancelled/);
    expect(await vault.list()).toEqual([]);
  });

  test("a completed credential write succeeds when cancellation races the success message", async () => {
    const opened = deferred<string>();
    const posted: unknown[] = [];
    const popup = { closed: false, close: mock(() => { popup.closed = true; }) };
    window.open = ((url: string) => {
      opened.resolve(String(url));
      return popup as unknown as Window;
    }) as typeof window.open;
    window.close = mock(() => {});
    Object.defineProperty(window, "opener", {
      value: { closed: false, postMessage: (data: unknown) => posted.push(data) }, configurable: true
    });
    globalThis.fetch = (async () => Response.json({ key: "synthetic-key" })) as unknown as typeof fetch;

    const flow = startOpenRouterFlow();
    void flow.catch(() => {});
    const authUrl = await opened.promise;
    const state = new URL(authUrl).searchParams.get("state");
    window.history.replaceState({}, "", `/?openrouter=callback&code=synthetic-code&state=${state}`);
    const connection = await handleOpenRouterCallback();
    if (!connection) throw new Error("The synthetic callback did not finish sign-in");
    cancelOpenRouterFlow();
    window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, data: posted[0] }));

    await expect(flow).resolves.toEqual(connection);
    expect(await new BrowserCredentialVault().list()).toHaveLength(1);
  });

  test("a vault write that fails after storing is rolled back", async () => {
    class FailingVault extends MemoryVault {
      override async set(value: StoredCredential): Promise<void> {
        await super.set(value);
        throw new Error("synthetic vault failure");
      }
    }
    const vault = new FailingVault();
    const pkce = await callbackFixture(Date.now());
    window.history.replaceState({}, "", `/?openrouter=callback&code=synthetic-code&state=${pkce.state}`);
    globalThis.fetch = (async () => Response.json({ key: "synthetic-key" })) as unknown as typeof fetch;

    await expect(handleOpenRouterCallback(vault)).rejects.toThrow(/vault failure/);
    expect(await vault.list()).toEqual([]);
  });
});
