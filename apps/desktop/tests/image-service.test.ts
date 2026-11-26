import { describe, expect, test } from "bun:test";
import { MemoryVault } from "@ai-book-studio/core/providers/credentials";
import type { StoredCredential } from "@ai-book-studio/core/providers/types";
import { ProviderService } from "../src/main/providers";
import { ImageService } from "../src/main/images";

const KEY = "meta-image-key-123456";

// Complete synthetic 1x1 PNG from docx-intake-validation.test.ts.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function credential(provider: StoredCredential["provider"] = "meta"): StoredCredential {
  return {
    id: "conn_meta0000001",
    provider,
    label: "Meta",
    kind: "api-key",
    createdAt: "2026-10-26T12:00:00.000Z",
    secret: KEY,
    ...(provider === "meta" ? { metadata: { baseUrl: "https://api.meta.ai/v1" } } : {})
  };
}

function service(fetchImpl: typeof fetch, stored: StoredCredential[] = [credential()]) {
  const vault = new MemoryVault();
  for (const entry of stored) void vault.set(entry);
  const providers = new ProviderService(vault, async () => {}, (async () => {
    throw new Error("catalogue must not be called");
  }) as unknown as typeof fetch);
  return new ImageService(providers, fetchImpl);
}

describe("ImageService", () => {
  test("posts one Muse Image request and returns the fixture bytes and usage", async () => {
    let calls = 0;
    const captured: { url?: string; init?: RequestInit | undefined } = {};
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls += 1;
      captured.url = String(url);
      captured.init = init;
      return Response.json({
        data: [{ b64_json: TINY_PNG_BASE64 }],
        output_format: "png",
        usage: { input_tokens: 10, output_tokens: 20 }
      });
    }) as typeof fetch;

    const result = await service(fetchImpl).generate({ prompt: "a lighthouse", size: "1536x1024" });

    expect(result).toMatchObject({
      model: "muse-image-1.0",
      size: "1536x1024",
      costUsd: 0.01,
      connectionLabel: "Meta"
    });
    expect(result.bytes).toEqual(new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")));
    expect(result.inspection).toMatchObject({ format: "png", width: 1, height: 1 });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(calls).toBe(1);
    expect(captured.url).toBe("https://api.meta.ai/v1/images/generations");
    const init = captured.init;
    if (!init) throw new Error("the provider was never called");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "muse-image-1.0",
      prompt: "a lighthouse",
      n: 1,
      size: "1536x1024",
      response_format: "b64_json",
      output_format: "png"
    });
  });

  test("refuses an empty prompt before any request", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({});
    }) as unknown as typeof fetch;
    await expect(service(fetchImpl).generate({ prompt: "   " })).rejects.toMatchObject({
      code: "invalid-request"
    });
    expect(calls).toBe(0);
  });

  test("normalizes provider auth and policy failures", async () => {
    const auth = (async () => new Response("invalid key", { status: 401 })) as unknown as typeof fetch;
    await expect(service(auth).generate({ prompt: "a lighthouse" })).rejects.toMatchObject({ code: "auth" });

    const policy = (async () =>
      new Response(JSON.stringify({ error: { message: "content policy violation" } }), {
        status: 400
      })) as unknown as typeof fetch;
    await expect(service(policy).generate({ prompt: "a lighthouse" })).rejects.toMatchObject({ code: "refusal" });
  });

  test("requires a Meta connection", async () => {
    await expect(
      service(
        (async () => {
          throw new Error("must not call");
        }) as unknown as typeof fetch,
        [credential("openai")]
      ).generate({ prompt: "a lighthouse" })
    ).rejects.toMatchObject({ code: "invalid-request", message: expect.stringMatching(/Connect Meta/i) });
  });

  test("refuses a malformed image payload", async () => {
    const fetchImpl = (async () =>
      Response.json({ data: [{ b64_json: "not-base64" }], output_format: "png" })) as unknown as typeof fetch;
    await expect(service(fetchImpl).generate({ prompt: "a lighthouse" })).rejects.toMatchObject({
      message: expect.stringMatching(/could not be decoded/i)
    });
  });
});
