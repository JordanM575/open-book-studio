import { connectionLabel, newConnectionId, type CredentialVault } from "@ai-book-studio/core/providers/credentials";
import { normalizeProviderError } from "@ai-book-studio/core/providers/errors";
import {
  authorizeUrl,
  challengeFor,
  createPkce,
  OPENROUTER_KEY_EXCHANGE_URL,
  parseKeyResponse,
  PKCE_TIMEOUT_MS,
  readCallback,
  type PkceState
} from "@ai-book-studio/core/providers/openrouter";
import { ProviderError, type ConnectionSummary } from "@ai-book-studio/core/providers/types";
import { BrowserCredentialVault } from "../storage/credentials";

export const OPENROUTER_PKCE_KEY = "ai-book-studio.openrouter.pkce";
const POPUP_NAME = "ai-book-studio-openrouter";
const EXCHANGE_TIMEOUT_MS = 15_000;
const ACTIVE_PREFIX = "ai-book-studio.openrouter.active.";

interface ActivePopup {
  cancel: () => void;
  refuseBeforeOpen: (error: ProviderError) => void;
}

let active: ActivePopup | null = null;

/**
 * Start OpenRouter sign-in in a same-origin popup.
 *
 * The popup inherits this tab's sessionStorage, so the PKCE verifier stays in the tab that started
 * the flow. The callback exchanges the single-use code, stores the key in the browser vault and
 * posts the connection summary back. No secret reaches the library, the parent page or a studio
 * server. A browser that blocks the popup gets a clear recovery message instead of a dead button.
 */
export function startOpenRouterFlow(): Promise<ConnectionSummary> {
  if (active) {
    return Promise.reject(new ProviderError("invalid-request", "A sign-in is already waiting in this browser. Finish it or cancel it first."));
  }

  return new Promise<ConnectionSummary>((resolve, reject) => {
    let settled = false;
    let cancelling = false;
    let pkce: PkceState | null = null;
    let popup: Window | null = null;
    let timer: number | undefined;
    let closedPoll: number | undefined;
    const finish = (error: Error | null, connection?: ConnectionSummary): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (closedPoll !== undefined) window.clearInterval(closedPoll);
      window.removeEventListener("message", onMessage);
      if (active === session) active = null;
      try {
        sessionStorage.removeItem(OPENROUTER_PKCE_KEY);
        if (pkce) localStorage.removeItem(`${ACTIVE_PREFIX}${pkce.state}`);
      } catch {
        // A browser that denies site storage can throw here too. Cleanup is best effort, so it can
        // never keep the sign-in promise from settling.
      }
      if (error) reject(error);
      else if (connection) resolve(connection);
    };

    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        state?: string;
        connection?: ConnectionSummary;
        message?: string;
      };
      if (!data || !pkce || data.state !== pkce.state) return;
      if (data.type === "openrouter" && data.connection) {
        try {
          popup?.close();
        } catch {
          // The popup may already be closing itself.
        }
        finish(null, data.connection);
      } else if (data.type === "openrouter-error") {
        finish(new ProviderError("auth", data.message || "OpenRouter sign-in failed."));
      }
    };

    const session: ActivePopup = {
      refuseBeforeOpen: (error) => {
        if (!popup) finish(error);
      },
      cancel: () => {
        if (cancelling) return;
        let status: string | null = null;
        try {
          status = pkce ? localStorage.getItem(`${ACTIVE_PREFIX}${pkce.state}`) : null;
        } catch {
          // Storage is unavailable, so no callback can have claimed this request; treat it as pending.
        }
        // Once the callback has committed, wait for its already-sent success message.
        if (status === "completed") return;
        if (status === "exchanging" && pkce) {
          // Wait for the popup's failure message after it has aborted or rolled back its write.
          cancelling = true;
          localStorage.removeItem(`${ACTIVE_PREFIX}${pkce.state}`);
          return;
        }
        try {
          popup?.close();
        } catch {
          // Closing is best effort; the rejection below is what matters.
        }
        finish(new ProviderError("auth", "Sign-in cancelled."));
      }
    };
    active = session;

    void (async () => {
      pkce = await createPkce();
      if (settled) return;
      const challenge = await challengeFor(pkce.verifier);
      if (settled) return;
      sessionStorage.setItem(OPENROUTER_PKCE_KEY, JSON.stringify(pkce));
      // The callback's sessionStorage is a copy. This non-secret marker is shared with its opener,
      // so cancellation is visible even while a provider response is in flight.
      localStorage.setItem(`${ACTIVE_PREFIX}${pkce.state}`, "pending");

      const callbackUrl = new URL(window.location.href);
      callbackUrl.search = "?openrouter=callback";
      callbackUrl.hash = "";
      const authUrl = authorizeUrl({ callbackUrl: callbackUrl.toString(), challenge, state: pkce.state });
      popup = window.open(authUrl, POPUP_NAME, "popup,width=520,height=720");
      if (!popup) {
        finish(new ProviderError("unknown", "The browser blocked the sign-in window. Allow pop-ups for this site and try again."));
        return;
      }
      timer = window.setTimeout(() => {
        finish(new ProviderError("auth", "Sign-in timed out. Start again when you are ready."));
      }, PKCE_TIMEOUT_MS);
      closedPoll = window.setInterval(() => {
        if (popup?.closed) finish(new ProviderError("auth", "Sign-in cancelled."));
      }, 500);
      window.addEventListener("message", onMessage);
    })().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

export function cancelOpenRouterFlow(): void {
  active?.cancel();
}

/** Invalidate a preparing sign-in when the explicit storage check refuses it. */
export function refuseOpenRouterBeforePopup(error: ProviderError): void {
  active?.refuseBeforeOpen(error);
}

/**
 * Finish the popup's callback. Returns null when the page is not an OpenRouter callback. The popup
 * closes after posting to the opener; a full-page callback still shows a readable result.
 */
export async function handleOpenRouterCallback(vault: CredentialVault = new BrowserCredentialVault()): Promise<ConnectionSummary | null> {
  const params = new URLSearchParams(window.location.search);
  if (params.get("openrouter") !== "callback") return null;
  const callbackUrl = window.location.href;
  const raw = sessionStorage.getItem(OPENROUTER_PKCE_KEY);
  // Consume the verifier and remove the authorization code from history before any async work.
  sessionStorage.removeItem(OPENROUTER_PKCE_KEY);
  window.history.replaceState({}, "", window.location.pathname);

  let state = params.get("state") ?? "";
  let marker = `${ACTIVE_PREFIX}${state}`;
  let claimed = false;
  let keepCompleted = false;
  let onStorage: ((event: StorageEvent) => void) | null = null;
  try {
    if (!raw) {
      throw new ProviderError("auth", "The sign-in request was not found in this tab. Start again from Settings.");
    }
    let pkce: PkceState;
    try {
      pkce = JSON.parse(raw) as PkceState;
      if (typeof pkce.state !== "string" || typeof pkce.verifier !== "string" || typeof pkce.createdAt !== "number") {
        throw new Error("Invalid sign-in request");
      }
    } catch {
      throw new ProviderError("auth", "The sign-in request was damaged. Start again from Settings.");
    }
    state = pkce.state;
    marker = `${ACTIVE_PREFIX}${state}`;
    if (localStorage.getItem(marker) !== "pending") {
      throw new ProviderError("auth", "Sign-in was cancelled or this callback was already used.");
    }
    localStorage.setItem(marker, "exchanging");
    claimed = true;
    const abort = new AbortController();
    onStorage = (event: StorageEvent): void => {
      if (event.key === marker && event.newValue !== "exchanging") abort.abort();
    };
    window.addEventListener("storage", onStorage);
    const ensureActive = (): void => {
      if (Date.now() - pkce.createdAt > PKCE_TIMEOUT_MS) {
        throw new ProviderError("auth", "The sign-in request expired. Start again.");
      }
      if (localStorage.getItem(marker) !== "exchanging") {
        throw new ProviderError("auth", "Sign-in cancelled.");
      }
    };
    const { code } = readCallback(callbackUrl, pkce.state, Date.now(), pkce.createdAt);
    const key = await exchangeCode(code, pkce.verifier, abort.signal);
    ensureActive();
    const existing = (await vault.list()).filter((connection) => connection.provider === "openrouter");
    ensureActive();
    const connection: ConnectionSummary = {
      id: newConnectionId(),
      provider: "openrouter",
      label: connectionLabel("openrouter", existing.length),
      kind: "openrouter-oauth",
      createdAt: new Date().toISOString()
    };
    try {
      await vault.set({ ...connection, secret: key });
      ensureActive();
      const opener = window.opener as Window | null;
      if (opener && !opener.closed) {
        localStorage.setItem(marker, "completed");
        opener.postMessage({ type: "openrouter", state: pkce.state, connection }, window.location.origin);
        window.setTimeout(() => window.close(), 50);
        keepCompleted = true;
      }
    } catch (error) {
      await vault.remove(connection.id);
      throw error;
    }
    return connection;
  } catch (error) {
    const opener = window.opener as Window | null;
    const unclaimedRequest = !claimed && localStorage.getItem(marker) === "pending";
    if (unclaimedRequest) localStorage.removeItem(marker);
    const cancelled = claimed && localStorage.getItem(marker) === null;
    const failure = cancelled ? new ProviderError("auth", "Sign-in cancelled.") : error;
    if ((claimed || unclaimedRequest) && opener && !opener.closed) {
      const message = failure instanceof Error ? failure.message : "OpenRouter sign-in failed.";
      try {
        opener.postMessage({ type: "openrouter-error", state, message }, window.location.origin);
      } catch {
        // The opener may have closed; the callback still reports the original error.
      }
    }
    if (cancelled && opener) window.setTimeout(() => window.close(), 50);
    throw failure;
  } finally {
    if (onStorage) window.removeEventListener("storage", onStorage);
    if (claimed && !keepCompleted) localStorage.removeItem(marker);
  }
}

async function exchangeCode(code: string, verifier: string, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(OPENROUTER_KEY_EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)])
    });
  } catch (error) {
    if (signal.aborted) throw new ProviderError("auth", "Sign-in cancelled.");
    throw new ProviderError("offline", "Could not reach OpenRouter to finish sign-in. Check your connection and try again.", {
      provider: "openrouter",
      cause: error
    });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw normalizeProviderError({ provider: "openrouter", status: response.status, body });
  }
  return parseKeyResponse(await response.json().catch(() => null));
}
