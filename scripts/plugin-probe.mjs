#!/usr/bin/env node
/**
 * Proves the plugin loader works in the real app, not only in a test.
 *
 * It points the built desktop app at a throwaway library and a folder of TypeScript plugins,
 * then asks the app's own loopback backend for its tool catalog. The plugin's tool must be in it.
 *
 *   node scripts/plugin-probe.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headlessDesktopEnvironment, mockKeychainArgs } from "./headless-environment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = join(root, "apps", "desktop");
const { _electron } = await import("playwright");

const temp = await mkdtemp(join(tmpdir(), "studio-plugin-probe-"));
const profile = join(temp, "profile");
const libraryRoot = join(temp, "library");
const pluginFolder = join(temp, "plugins");
const backendFile = join(temp, "backend.json");

await mkdir(join(profile), { recursive: true });
await mkdir(join(libraryRoot, "books", "book_probe0001", "chapters"), { recursive: true });
await mkdir(pluginFolder, { recursive: true });

const now = "2026-10-26T12:00:00.000Z";
await writeFile(
  join(libraryRoot, "books", "book_probe0001", "book.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: "book_probe0001",
      title: "Probe Book",
      createdAt: now,
      updatedAt: now
    },
    null,
    2
  )}\n`
);
await writeFile(
  join(libraryRoot, "books", "book_probe0001", "chapters", "0001-one.md"),
  `The door was open.\n`
);
await writeFile(
  join(profile, "studio.json"),
  `${JSON.stringify({ libraryRoot, pluginFolder }, null, 2)}\n`
);
await writeFile(
  join(pluginFolder, "greeting.ts"),
  `export default {
  name: "greeting",
  tools: [
    {
      name: "say_hello",
      description: "Say hello to the author.",
      parameters: {
        type: "object",
        properties: { who: { type: "string" } },
        required: ["who"]
      },
      handler: async (input) => ({ message: "Hello " + input.who })
    }
  ]
};
`
);

const env = headlessDesktopEnvironment(process.env, profile);
env.STUDIO_BACKEND = "1";
env.STUDIO_BACKEND_FILE = backendFile;

const electronPath = createRequire(join(appDir, "package.json"))("electron");
const app = await _electron.launch({ executablePath: electronPath, args: [...mockKeychainArgs(), appDir], cwd: appDir, env });
await app.firstWindow();

let locator = null;
for (let attempt = 0; attempt < 40 && !locator; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    locator = JSON.parse(await readFile(backendFile, "utf8"));
  } catch {
    locator = null;
  }
}

let ok = false;
if (locator) {
  const response = await fetch(`${locator.url}/v1/tools`, {
    headers: { authorization: `Bearer ${locator.token}` }
  });
  const body = await response.json();
  const names = (body.tools ?? []).map((tool) => tool.name);
  ok = names.includes("say_hello");
  console.log(`[probe] the catalog has ${names.length} tools; the plugin's say_hello is ${ok ? "there" : "missing"}`);

  // The plugin's tool must actually run, not just be listed.
  const call = await fetch(`${locator.url}/v1/books/book_probe0001/tools/say_hello`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${locator.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ args: { who: "Author" } })
  });
  const called = await call.json();
  const ran = called?.result?.result?.message === "Hello Author";
  console.log(`[probe] the plugin's tool ran: ${ran ? "yes" : "no"} (${JSON.stringify(called).slice(0, 160)})`);
  ok = ok && ran;

  // A plugin that needs a package the app cannot give it must not break the others.
  await writeFile(
    join(pluginFolder, "needs-zod.ts"),
    `import { z } from "zod";\nexport default { name: "broken", tools: [] };\n`
  );
  const after = await fetch(`${locator.url}/v1/tools`, {
    headers: { authorization: `Bearer ${locator.token}` }
  });
  const afterBody = await after.json();
  const stillThere = (afterBody.tools ?? []).map((tool) => tool.name).includes("say_hello");
  console.log(`[probe] a plugin that cannot load did not take the others with it: ${stillThere ? "yes" : "no"}`);
  ok = ok && stillThere;
} else {
  console.log("[probe] the backend never wrote its locator file");
}

await app.close().catch(() => {});
await rm(temp, { recursive: true, force: true });
console.log(ok ? "[probe] ok" : "[probe] not ok");
process.exit(ok ? 0 : 1);
