import { existsSync } from "node:fs";
import { join } from "node:path";
import { runLiveChecks, type LiveResult } from "./live-checks";
import { ProviderError, type ConnectionSummary, type StoredCredential } from "@ai-book-studio/core/providers/types";
import { endpointFor, parseProviderModels } from "@ai-book-studio/core/providers/keys";
import { applyModelPreset } from "@ai-book-studio/core/providers/compatibility";
import type { ProviderService } from "./providers";
import type { VoicePreferences } from "@ai-book-studio/core/providers/voice-preferences";

/**
 * The live check, run inside the app.
 *
 * The Meta key lives in the operating system's keychain, through the app's own vault, and it is
 * never on the command line where a shell history would keep it. So the check runs here, in the
 * app's own runtime, against the app's own stored connection.
 *
 * There is a second route, for a key that is only in the environment: `META_API_KEY` and
 * `META_BASE_URL` are used when the studio has no stored Meta connection. It is held in memory
 * for the length of the check and written nowhere, but a shell history may keep it, so the
 * stored connection is the better way.
 *
 * The library it writes to is a copy of the committed sample, in a temporary folder, deleted
 * afterwards. The author's own book is never touched.
 */
export async function runLiveCheckInApp(
  providers: ProviderService,
  sampleRoot: string,
  voicePreferences: VoicePreferences
): Promise<LiveResult[]> {
  const service = (await hasMetaConnection(providers))
    ? providers
    : (fromEnvironment() ?? providers);

  // While the check runs, any request the provider refuses is reported with the status the
  // provider gave and what it said, so a failure names the cause instead of guessing at it.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const response = await originalFetch(input, init);
    if (!response.ok && url.includes("meta")) {
      const body = await response.clone().text().catch(() => "");
      console.error(`[live] refused ${response.status} ${url} — ${body.slice(0, 400).replace(/\s+/g, " ")}`);
    }
    return response;
  }) as typeof fetch;

  const results = await runLiveChecks(service, { sampleRoot, voicePreferences }).finally(() => {
    globalThis.fetch = originalFetch;
  });
  for (const result of results) {
    const mark = result.outcome === "ok" ? "ok   " : result.outcome === "blocked" ? "block" : "FAIL ";
    console.log(`[live] ${mark} ${result.name} — ${result.detail}`);
  }
  const failed = results.filter((result) => result.outcome === "failed").length;
  const blocked = results.filter((result) => result.outcome === "blocked").length;
  const ok = results.filter((result) => result.outcome === "ok").length;
  console.log(`[live] ${ok} passed, ${blocked} blocked, ${failed} failed`);
  if (blocked) {
    console.log("[live] A blocked check is an account fact, not a defect: the model or the access is not on this key.");
  }
  return results;
}

async function hasMetaConnection(providers: ProviderService): Promise<boolean> {
  try {
    return (await providers.list()).some((entry) => entry.provider === "meta");
  } catch {
    return false;
  }
}

/**
 * A provider service for the keys that are only in the environment.
 *
 * The studio itself only reads its own vault, so this exists for a one-off run: the keys are held
 * in memory for the length of the check and written nowhere. A shell history may keep them, which
 * is why the stored connection is the better way.
 */
function fromEnvironment(): ProviderService | null {
  const credentials: StoredCredential[] = [];

  const metaKey = process.env.META_API_KEY?.trim();
  // `.env` names it META_API_BASE_URL; the shorter name is accepted too.
  const metaBase = process.env.META_API_BASE_URL?.trim() ?? process.env.META_BASE_URL?.trim();
  if (metaKey && metaBase) {
    credentials.push({
      id: "conn_livecheck01",
      provider: "meta",
      label: "Live check (Meta)",
      kind: "api-key",
      createdAt: new Date().toISOString(),
      secret: metaKey,
      metadata: { baseUrl: metaBase }
    });
  }

  // The cheap path first: OpenRouter's speech model costs a fraction of a cent a sentence, which
  // is what makes a check that runs often affordable. OpenAI stays the production voice.
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterKey) {
    credentials.push({
      id: "conn_livecheck03",
      provider: "openrouter",
      label: "Live check (OpenRouter)",
      kind: "api-key",
      createdAt: new Date().toISOString(),
      secret: openRouterKey
    });
  }

  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    credentials.push({
      id: "conn_livecheck02",
      provider: "openai",
      label: "Live check (OpenAI)",
      kind: "api-key",
      createdAt: new Date().toISOString(),
      secret: openaiKey,
      ...(process.env.OPENAI_API_BASE_URL?.trim()
        ? { metadata: { baseUrl: process.env.OPENAI_API_BASE_URL.trim() } }
        : {})
    });
  }

  if (credentials.length === 0) return null;
  console.log(
    `[live] using ${credentials.length} key${credentials.length === 1 ? "" : "s"} from the environment, for this run only.`
  );

  const summaries: ConnectionSummary[] = credentials.map((entry) => ({
    id: entry.id,
    provider: entry.provider,
    label: entry.label,
    kind: entry.kind,
    createdAt: entry.createdAt
  }));

  const byId = new Map(credentials.map((entry) => [entry.id, entry]));

  return {
    list: async () => summaries,
    credential: async (id: string) => {
      const entry = byId.get(id);
      if (!entry) throw new ProviderError("auth", "No such connection.");
      return entry;
    },
    models: async (id: string) => {
      const entry = byId.get(id);
      if (entry?.provider !== "meta") {
        // The checks that need a catalogue only need Meta's; another provider answers with an
        // empty list rather than a guess at an endpoint.
        return { models: [], fetchedAt: new Date().toISOString() };
      }
      const secret = entry.secret;
      const baseUrl = entry.metadata?.baseUrl ?? "";
      const endpoint = endpointFor("meta", secret, baseUrl);
      const response = await fetch(endpoint.url, { headers: endpoint.headers });
      if (!response.ok) {
        throw new ProviderError("auth", `Meta answered ${response.status} for the model list.`);
      }
      const models = parseProviderModels("meta", await response.json()).map((model) =>
        applyModelPreset("meta", model)
      );
      return { models, fetchedAt: new Date().toISOString() };
    }
  } as unknown as ProviderService;
}

/**
 * Where the committed sample library lives.
 *
 * The check copies it into a temporary folder and works there, so the author's own library is
 * never opened. The candidates cover a development run and a run from the repository root.
 */
export function sampleLibraryPath(): string {
  const candidates = [
    join(__dirname, "../../../../samples/the-salt-road"),
    join(process.cwd(), "samples", "the-salt-road"),
    join(__dirname, "../../../../../samples/the-salt-road")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const fallback = candidates[1];
  if (fallback === undefined) throw new Error("No sample library candidate exists.");
  return fallback;
}
