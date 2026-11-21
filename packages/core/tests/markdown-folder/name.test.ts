import { describe, expect, test } from "bun:test";
import {
  MARKDOWN_FOLDER_NAME_MAX_BYTES,
  MARKDOWN_FOLDER_NAME_MAX_CHARS,
  normalizeMarkdownFolderName,
  suggestMarkdownFolderName,
  validateMarkdownFolderName
} from "../../src/markdown-folder/name";

/*
 * Spec 035 T016/T017: the pure folder-name contract. Synthetic strings only; no filesystem.
 */

const accepted = (value: string): string => {
  const result = validateMarkdownFolderName(value);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(value)} to pass: ${result.message}`);
  return result.name;
};

const refused = (value: string): string => {
  const result = validateMarkdownFolderName(value);
  if (result.ok) throw new Error(`expected ${JSON.stringify(value)} to be refused`);
  expect(result.message.length).toBeGreaterThan(0);
  return result.message;
};

describe("markdown folder name validation", () => {
  test("accepts an ordinary name and returns its NFC form", () => {
    expect(accepted("the-salt-road-markdown")).toBe("the-salt-road-markdown");
    expect(accepted("Cafe\u0301 notes")).toBe("Café notes");
    expect(normalizeMarkdownFolderName("Cafe\u0301")).toBe("Café");
  });

  test("refuses empty, whitespace-only, dot and dot-dot", () => {
    for (const value of ["", " ", "\t", "\n", ".", ".."]) refused(value);
  });

  test("refuses every separator and Windows-invalid character", () => {
    for (const value of ["a/b", "a\\b", "a<b", "a>b", "a:b", 'a"b', "a|b", "a?b", "a*b"]) refused(value);
  });

  test("refuses NUL, control, bidi override and zero-width characters", () => {
    refused("a\u0000b");
    refused("a\u0007b");
    refused("a\u202eb");
    refused("a\u200bb");
    refused("\u2066private");
  });

  test("refuses a leading dot and a trailing space or dot", () => {
    refused(".markdown");
    refused("notes ");
    refused("notes.");
    refused("notes. ");
  });

  test("refuses Windows device names with or without an extension", () => {
    for (const value of [
      "CON", "con", "Prn", "AUX", "nul",
      "COM1", "com9", "LPT1", "lpt9",
      "CON.txt", "com3.markdown", "LPT1.tar.gz"
    ]) refused(value);
    expect(accepted("console")).toBe("console");
    expect(accepted("com10")).toBe("com10");
  });

  test("enforces 60 Unicode characters and 180 UTF-8 bytes", () => {
    expect(accepted("a".repeat(MARKDOWN_FOLDER_NAME_MAX_CHARS)).length).toBe(MARKDOWN_FOLDER_NAME_MAX_CHARS);
    refused("a".repeat(MARKDOWN_FOLDER_NAME_MAX_CHARS + 1));
    const multibyte = "𐌰".repeat(45);
    expect(new TextEncoder().encode(multibyte).byteLength).toBe(180);
    expect(accepted(multibyte)).toBe(multibyte);
    refused(`${multibyte}𐌰`);
    refused("é".repeat(61));
  });
});

describe("markdown folder name suggestion", () => {
  test("keeps the recorded short-title result", () => {
    expect(suggestMarkdownFolderName("The Salt Road")).toBe("the-salt-road-markdown");
    expect(suggestMarkdownFolderName("  ")).toBe("untitled-book-markdown");
  });

  test("a 70-character title stays inside both limits and passes the validator", () => {
    const suggestion = suggestMarkdownFolderName("The ".repeat(25));
    expect(suggestion.endsWith("-markdown")).toBe(true);
    expect(Array.from(suggestion).length).toBeLessThanOrEqual(MARKDOWN_FOLDER_NAME_MAX_CHARS);
    expect(new TextEncoder().encode(suggestion).byteLength).toBeLessThanOrEqual(MARKDOWN_FOLDER_NAME_MAX_BYTES);
    expect(validateMarkdownFolderName(suggestion)).toEqual({ ok: true, name: suggestion });
  });

  test("a multibyte title stays inside both limits and passes the validator", () => {
    const suggestion = suggestMarkdownFolderName(`${"海".repeat(80)} road`);
    expect(suggestion.endsWith("-markdown")).toBe(true);
    expect(Array.from(suggestion).length).toBeLessThanOrEqual(MARKDOWN_FOLDER_NAME_MAX_CHARS);
    expect(new TextEncoder().encode(suggestion).byteLength).toBeLessThanOrEqual(MARKDOWN_FOLDER_NAME_MAX_BYTES);
    expect(validateMarkdownFolderName(suggestion)).toEqual({ ok: true, name: suggestion });
  });
});
