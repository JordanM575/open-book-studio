/**
 * The throwaway library and profile for one opted-in OpenRouter local pass.
 * Creates the profile directory before `studio.json`, so the write cannot fail
 * with a missing directory. It never launches Electron and never calls a provider.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LOCAL_PASS_BOOK = "book_localpass01";

export async function writeLocalPassFixture(temp) {
  const profile = join(temp, "profile");
  const libraryRoot = join(temp, "library");
  const backendFile = join(temp, "backend.json");
  const bookDir = join(libraryRoot, "books", LOCAL_PASS_BOOK);
  await mkdir(profile, { recursive: true });
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  const now = "2026-11-15T12:00:00.000Z";
  await writeFile(
    join(bookDir, "book.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: LOCAL_PASS_BOOK,
        title: "The Salt Road",
        description: "A synthetic fixture for the opted-in OpenRouter local pass.",
        stage: "drafting",
        createdAt: now,
        updatedAt: now
      },
      null,
      2
    )}\n`
  );
  await writeFile(join(profile, "studio.json"), `${JSON.stringify({ libraryRoot }, null, 2)}\n`);
  return { profile, libraryRoot, backendFile, bookDir };
}
