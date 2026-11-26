import { describe, expect, spyOn, test } from "bun:test";
import { InMemoryLibraryPort } from "./support/in-memory-port";
import { ImageStore } from "../src/images/store";
import { imageManifestPath, imageFilePath, imagesPath, trashPath } from "../src/library/paths";
import type { LibraryPath } from "../src/library/port";
import { imageManifestSchema, inspectImage, MAX_IMAGE_BYTES, MAX_IMAGE_PROMPT } from "../src/images/schema";
import {
  IMAGE_COST_USD,
  imageGenerationEndpoint,
  imageRequestBody,
  parseImageResponse
} from "../src/providers/images";

const BOOK = "book_image0001";

function png(): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==",
      "base64"
    )
  );
}

function setup() {
  const port = new InMemoryLibraryPort();
  const store = new ImageStore({ storage: port, runtime: port });
  return { port, store };
}

function addInput(overrides: Record<string, unknown> = {}) {
  return {
    bytes: png(),
    kind: "chapter" as const,
    prompt: "a lighthouse in a storm",
    provider: "meta",
    model: "muse-image-1.0",
    size: "1024x1024",
    costUsd: 0.01,
    ...overrides
  };
}

describe("image format", () => {  test("detects a real PNG and its dimensions", () => {
    expect(inspectImage(png())).toEqual({ format: "png", mimeType: "image/png", width: 1, height: 1 });
  });

  test("refuses bytes that are not a complete image", () => {
    expect(inspectImage(new TextEncoder().encode("not an image"))).toBeNull();
    expect(inspectImage(png().slice(0, 20))).toBeNull();
  });
});

describe("Meta image provider", () => {
  test("builds the documented generation request", () => {
    expect(imageGenerationEndpoint("https://api.meta.ai/v1")).toBe("https://api.meta.ai/v1/images/generations");
    expect(imageRequestBody({ prompt: "a lighthouse", size: "1536x1024" })).toEqual({
      model: "muse-image-1.0",
      prompt: "a lighthouse",
      n: 1,
      size: "1536x1024",
      response_format: "b64_json",
      output_format: "png",
      reasoning_strength: "low"
    });
  });

  test("preserves PNG bytes and usage with padded, unpadded and whitespace-formatted Base64", () => {
    const bytes = png();
    const padded = Buffer.from(bytes).toString("base64");
    const unpadded = padded.replace(/=+$/, "");
    const formatted = ` \t${padded.slice(0, 8)}\r\n${padded.slice(8, -1)}\f${padded.slice(-1)}`;
    // The last digit of this fixture is g. Changing it to h sets an unused padding bit.
    const withUnusedBit = `${unpadded.slice(0, -1)}h==`;
    for (const encoded of [padded, unpadded, formatted, withUnusedBit]) {
      const result = parseImageResponse(
        {
          data: [{ b64_json: encoded }],
          output_format: "png",
          usage: { input_tokens: 12, output_tokens: 34 }
        },
        "1024x1024"
      );
      expect(result.bytes).toEqual(bytes);
      expect(result.inspection).toMatchObject({ format: "png", width: 1, height: 1 });
      expect(result.costUsd).toBe(IMAGE_COST_USD);
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    }
  });

  test("admits the exact decoded-size limit with and without padding", () => {
    const unpadded = "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3));
    const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
    const decoder = spyOn(globalThis, "atob").mockReturnValue(Buffer.from(png()).toString("latin1"));
    try {
      // The decoder supplies a small PNG so this test exercises the boundary check without decoding 20 MiB.
      for (const encoded of [padded, unpadded, `\t${padded}\r\n`]) {
        const result = parseImageResponse({ data: [{ b64_json: encoded }] }, "1024x1024");
        expect(result.inspection.format).toBe("png");
      }
      expect(decoder.mock.calls.length).toBe(3);
    } finally {
      decoder.mockRestore();
    }
  });

  test("refuses one decoded byte over the limit before invoking atob", () => {
    const oversized = "A".repeat(Math.ceil(((MAX_IMAGE_BYTES + 1) * 4) / 3));
    const formatted = `${oversized.slice(0, 4)}\r\n${oversized.slice(4)}`;
    const decoder = spyOn(globalThis, "atob").mockReturnValue("");
    try {
      for (const encoded of [oversized, formatted]) {
        expect(() => parseImageResponse({ data: [{ b64_json: encoded }] }, "1024x1024")).toThrow(/not a complete image/);
      }
      expect(decoder.mock.calls.length).toBe(0);
    } finally {
      decoder.mockRestore();
    }
  });

  test("refuses missing and malformed Base64 before invoking atob", () => {
    const decoder = spyOn(globalThis, "atob").mockReturnValue("");
    try {
      expect(() => parseImageResponse({ data: [] }, "1024x1024")).toThrow(/no image data/);
      expect(() => parseImageResponse({ data: [{ b64_json: "\t\u00a0" }] }, "1024x1024")).toThrow(/no image data/);
      for (const encoded of ["%%%", "A", "Zg=", "Z=g=", "Zg===", "Zg-_", "Z\vg==", "Z\u00a0g=="]) {
        expect(() => parseImageResponse({ data: [{ b64_json: encoded }] }, "1024x1024")).toThrow(/could not be decoded/);
      }
      expect(decoder.mock.calls.length).toBe(0);
    } finally {
      decoder.mockRestore();
    }
  });

  test("refuses non-image bytes and a mismatched reported format", () => {
    expect(() =>
      parseImageResponse({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }, "1024x1024")
    ).toThrow(/not a complete image/);
    expect(() =>
      parseImageResponse({ data: [{ b64_json: Buffer.from(png()).toString("base64") }], output_format: "webp" }, "1024x1024")
    ).toThrow(/different format/);
  });
});

describe("ImageStore", () => {
  test("writes the file and manifest together and reads them back", async () => {
    const { port, store } = setup();
    const record = await store.add(BOOK, addInput());
    expect(record).toMatchObject({
      kind: "chapter",
      width: 1,
      height: 1,
      mimeType: "image/png",
      prompt: "a lighthouse in a storm",
      source: "generated",
      costUsd: 0.01
    });
    expect(await port.readFile(imageFilePath(BOOK, record.fileName))).not.toBeNull();
    const manifest = imageManifestSchema.parse(
      JSON.parse(new TextDecoder().decode((await port.readFile(imageManifestPath(BOOK)))!.bytes))
    );
    expect(manifest.images).toHaveLength(1);
    const stored = await store.read(BOOK, record.id);
    expect(stored?.record.id).toBe(record.id);
    expect(stored?.bytes).toEqual(png());
  });

  test("attaches one image per chapter and detaches the previous one", async () => {
    const { store } = setup();
    const first = await store.add(BOOK, addInput());
    const second = await store.add(BOOK, addInput({ prompt: "a second image" }));
    await store.attach(BOOK, first.id, "ch_image0001");
    await store.attach(BOOK, second.id, "ch_image0001");
    const listed = await store.list(BOOK);
    expect(listed.manifest.images.find((image) => image.id === first.id)?.chapterId).toBeNull();
    expect(listed.manifest.images.find((image) => image.id === second.id)?.chapterId).toBe("ch_image0001");
  });

  test("refuses to add over a corrupt manifest without touching the files", async () => {
    const { port, store } = setup();
    await port.ensureDirectory(imagesPath(BOOK));
    await port.commitFile(imageManifestPath(BOOK), new TextEncoder().encode("{bad"), { kind: "absent" });
    await expect(store.add(BOOK, addInput())).rejects.toMatchObject({ code: "format" });
    expect((await store.list(BOOK)).warning).toMatch(/not valid JSON/);
  });

  test("reports a newer manifest without rewriting it", async () => {
    const { port, store } = setup();
    await port.commitFile(
      imageManifestPath(BOOK),
      new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, images: [] })),
      { kind: "absent" }
    );
    await expect(store.list(BOOK)).rejects.toMatchObject({ code: "newer-schema" });
  });

  test("refuses oversized and malformed images", async () => {
    const { store } = setup();
    await expect(store.add(BOOK, addInput({ bytes: new Uint8Array(0) }))).rejects.toMatchObject({ code: "invalid" });
    await expect(store.add(BOOK, addInput({ bytes: new TextEncoder().encode("nope") }))).rejects.toMatchObject({
      code: "format"
    });
    await expect(store.add(BOOK, addInput({ prompt: "x".repeat(MAX_IMAGE_PROMPT + 1) }))).rejects.toMatchObject({
      code: "invalid"
    });
  });

  test("moves a removed image to the library trash", async () => {
    const { port, store } = setup();
    const record = await store.add(BOOK, addInput());
    await store.remove(BOOK, record.id);
    expect(await store.read(BOOK, record.id)).toBeNull();
    expect(await port.readFile(imageFilePath(BOOK, record.fileName))).toBeNull();
    const trash = await port.listDirectory([...trashPath(BOOK), "images"] as LibraryPath);
    expect(trash.some((entry) => entry.name.endsWith(record.fileName))).toBe(true);
  });

  test("attaches a character image to a cast member and refuses chapter images", async () => {
    const { store } = setup();
    const portrait = await store.add(BOOK, addInput({ kind: "character", source: "imported", prompt: "the keeper" }));
    const attached = await store.attachCharacter(BOOK, portrait.id, "char_image001");
    expect(attached.characterId).toBe("char_image001");

    const chapterImage = await store.add(BOOK, addInput());
    await expect(store.attachCharacter(BOOK, chapterImage.id, "char_image001")).rejects.toMatchObject({
      code: "invalid"
    });
  });

  test("an older library's SAM cutout record still lists, reads and attaches (D-158)", async () => {
    const { port, store } = setup();
    const source = await store.add(BOOK, addInput());
    const figure = await store.add(BOOK, addInput({ kind: "character", source: "imported", prompt: "the keeper" }));
    // Rewrite the second record the way an earlier build saved a SAM cutout.
    const before = (await port.readFile(imageManifestPath(BOOK)))!;
    const legacy = JSON.parse(new TextDecoder().decode(before.bytes));
    legacy.images[1] = { ...legacy.images[1], source: "cutout", cutoutOf: source.id, model: "sam-3.1", confidence: 0.82 };
    await port.commitFile(imageManifestPath(BOOK), new TextEncoder().encode(JSON.stringify(legacy)), {
      kind: "sha256",
      value: before.sha256
    });

    const listed = await store.list(BOOK);
    expect(listed.warning).toBeNull();
    expect(listed.manifest.images[1]).toMatchObject({ id: figure.id, source: "cutout", cutoutOf: source.id, confidence: 0.82 });
    expect((await store.read(BOOK, figure.id))?.bytes).toEqual(png());
    expect((await store.attachCharacter(BOOK, figure.id, "char_image001")).characterId).toBe("char_image001");
    // A new image is never written as a cutout.
    const added = await store.add(BOOK, addInput({ kind: "character" }));
    expect(added).toMatchObject({ source: "generated", cutoutOf: null });
  });
});
