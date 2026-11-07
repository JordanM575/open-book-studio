#!/usr/bin/env node
/**
 * Starts the built app in a hidden, throwaway profile and runs the smoke checks in
 * `src/main/smoke.ts`. Nothing appears on screen: the window is parked off-screen, never shown,
 * the Dock icon is hidden, and the run uses its own settings file so your real library is untouched.
 *
 *   bun run smoke          # build, then run hidden
 *   bun run smoke:run      # run against the existing out/ build
 *   SMOKE_KEEP=1 bun run smoke:run   # keep the temp library for inspection
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headlessEnvironment } from "./headless-environment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "desktop");
const builtMain = join(appDir, "out", "main", "index.cjs");
const packaged = process.env.SMOKE_PACKAGED === "1";

// Electron belongs to the desktop workspace, not the root package.
const appRequire = createRequire(join(appDir, "package.json"));
const electronPath = appRequire("electron");

function packagedBinary() {
  // T014: point the packaged run at any build (a wrapper script may pass its own app path).
  if (process.env.SMOKE_APP && existsSync(process.env.SMOKE_APP)) return process.env.SMOKE_APP;
  const release = join(root, "release");
  if (!existsSync(release)) return null;
  for (const entry of readdirSync(release)) {
    const candidate = join(release, entry, "AI Book Studio.app", "Contents", "MacOS", "AI Book Studio");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const packagedApp = packaged ? packagedBinary() : null;
if (!packaged && !existsSync(builtMain)) {
  console.error("[smoke] No build found. Run `bun run build` first, or use `bun run smoke`.");
  process.exit(1);
}
if (packaged && !packagedApp) {
  console.error("[smoke] No packaged app found. Run `bun run package:dir` first.");
  process.exit(1);
}

const temp = await mkdtemp(join(tmpdir(), "ai-book-studio-smoke-"));
const profile = join(temp, "profile");
const libraryRoot = join(temp, "library");
const bookId = "book_smoke0001";
const chapterId = "ch_smoke0001";
const now = new Date().toISOString();

const book = {
  schemaVersion: 1,
  id: bookId,
  title: "Smoke Test Book",
  description: "A fixture the hidden smoke run opens.",
  stage: "drafting",
  createdAt: now,
  updatedAt: now
};

const chapter = `---
id: ${chapterId}
title: The Light
order: 1
version: 1
createdAt: ${now}
updatedAt: ${now}
---

The lighthouse keeper counted the gulls and wrote the number in the margin.

By evening the count was wrong again, and the light was the only thing that still agreed with him.
`;

const chapterTwo = `---
id: ch_smoke0002
title: The Door
order: 2
version: 1
createdAt: ${now}
updatedAt: ${now}
---

The door opened onto a colder corridor.
`;

await mkdir(join(profile), { recursive: true });
await mkdir(join(temp, "exports"), { recursive: true });
await mkdir(join(libraryRoot, "books", bookId, "chapters"), { recursive: true });
await mkdir(join(libraryRoot, "books", bookId, "images"), { recursive: true });
await writeFile(join(profile, "studio.json"), `${JSON.stringify({ libraryRoot }, null, 2)}\n`);
await writeFile(join(libraryRoot, "books", bookId, "book.json"), `${JSON.stringify(book, null, 2)}\n`);
await writeFile(join(libraryRoot, "books", bookId, "chapters", "0001-the-light.md"), chapter);
await writeFile(join(libraryRoot, "books", bookId, "chapters", "0002-the-door.md"), chapterTwo);

/*
 * One illustration, so the export check has a picture to embed. The point of the check is the
 * whole path — the image store, the exporter and the DOCX a reader would open — so the fixture
 * carries a real image rather than the check trusting the writer.
 */
const image = pngSquare(96, [244, 214, 138]);
const imageId = "img_smoke000001";
const imageName = `${imageId}.png`;
await writeFile(join(libraryRoot, "books", bookId, "images", imageName), image);
await writeFile(
  join(libraryRoot, "books", bookId, "images.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      images: [
        {
          id: imageId,
          kind: "chapter",
          chapterId,
          characterId: null,
          fileName: imageName,
          mimeType: "image/png",
          width: 96,
          height: 96,
          bytes: image.length,
          sha256: createHash("sha256").update(image).digest("hex"),
          prompt: "A lamp in the dark",
          provider: "fixture",
          model: "smoke",
          size: "96x96",
          source: "imported",
          createdAt: now,
          cutoutOf: null,
          costUsd: null,
          revisedPrompt: null,
          confidence: null
        }
      ]
    },
    null,
    2
  )}\n`
);

/** A square PNG of one colour, so the fixture needs no binary file in the repository. */
function pngSquare(size, [r, g, b]) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(typed));
    return Buffer.concat([length, typed, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// Only the host fields the app needs to start, so nothing from this shell reaches it: not
// ELECTRON_RUN_AS_NODE (it would start Electron as plain Node), not NODE_OPTIONS or a fetch proxy
// installed for the coding agent itself (it authorises the agent's traffic, not the app's), and
// not a provider key.
const env = headlessEnvironment(process.env);
env.STUDIO_TEST = "1";
// The hidden run never asks the operating system for protected storage either.
env.STUDIO_NO_KEYCHAIN = "1";
env.STUDIO_HEADLESS = "1";
env.STUDIO_SMOKE = "1";
env.STUDIO_USER_DATA = profile;
env.STUDIO_EXPORT_PATH = join(temp, "exports");

/*
 * A synthetic manuscript for the import journey. The hidden run answers the native
 * picker with this file through STUDIO_IMPORT_PATH, then drives the real preview,
 * split, confirm and result UI. Nothing here resembles an author's manuscript.
 */
const manuscript = `The lighthouse keeper counted the gulls.

By evening the count was wrong again.

The light was the only thing that still agreed with him.
Dawn came grey and gull-less.
`;
await writeFile(join(temp, "manuscript.txt"), manuscript);
env.STUDIO_IMPORT_PATH = join(temp, "manuscript.txt");

/*
 * A synthetic Word document for the DOCX journey (D-183), built with the desktop's own
 * `docx` dependency: a Title, two Heading 1 chapters, emphasis, a list, a table, a picture
 * and a footnote, so the hidden run sees heading chapters and a loss report.
 */
const docx = appRequire("docx");
const smokePicture = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const wordDocument = new docx.Document({
  footnotes: { 1: { children: [new docx.Paragraph("A synthetic note.")] } },
  sections: [
    {
      children: [
        new docx.Paragraph({ text: "Smoke Voyage", heading: docx.HeadingLevel.TITLE }),
        new docx.Paragraph({ text: "The Harbour", heading: docx.HeadingLevel.HEADING_1 }),
        new docx.Paragraph({
          children: [
            new docx.TextRun("The keeper "),
            new docx.TextRun({ text: "counted", bold: true }),
            new docx.TextRun(" the boats."),
            new docx.FootnoteReferenceRun(1)
          ]
        }),
        new docx.Paragraph({ text: "Rope", bullet: { level: 0 } }),
        new docx.Paragraph({ text: "Lamp oil", bullet: { level: 0 } }),
        new docx.Paragraph({ text: "The Storm", heading: docx.HeadingLevel.HEADING_1 }),
        new docx.Paragraph({
          children: [new docx.TextRun("Rain came "), new docx.TextRun({ text: "sideways", italics: true }), new docx.TextRun(".")]
        }),
        new docx.Table({
          width: { size: 100, type: docx.WidthType.PERCENTAGE },
          rows: [
            new docx.TableRow({
              children: [
                new docx.TableCell({ children: [new docx.Paragraph("north")] }),
                new docx.TableCell({ children: [new docx.Paragraph("south")] })
              ]
            })
          ]
        }),
        new docx.Paragraph({
          children: [
            new docx.TextRun("A picture follows."),
            new docx.ImageRun({
              type: "png",
              data: smokePicture,
              transformation: { width: 10, height: 10 },
              altText: { name: "dot", description: "A smoke dot", title: "dot" }
            })
          ]
        })
      ]
    }
  ]
});
await writeFile(join(temp, "manuscript.docx"), await docx.Packer.toBuffer(wordDocument));
env.STUDIO_IMPORT_DOCX_PATH = join(temp, "manuscript.docx");

console.log(`[smoke] ${packaged ? "packaged" : "hidden"} run · profile ${profile}`);
// stdout is piped so the runner can see the machine-readable result even when Electron's
// shutdown path stalls; every line is still echoed unchanged.
const child = packaged
  ? spawn(packagedApp, [], { cwd: root, env, stdio: ["inherit", "pipe", "inherit"] })
  : spawn(electronPath, [appDir], { cwd: appDir, env, stdio: ["inherit", "pipe", "inherit"] });

let reported = null;
let grace = null;
let buffered = "";

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  buffered += chunk.toString("utf8");
  let newline = buffered.indexOf("\n");
  while (newline !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    newline = buffered.indexOf("\n");
    if (line.startsWith("[smoke] result ")) {
      try {
        reported = JSON.parse(line.slice("[smoke] result ".length));
      } catch {
        reported = null;
      }
      if (reported && !grace) {
        grace = setTimeout(() => {
          console.error("[smoke] The app reported a result but did not exit; stopping it.");
          child.kill("SIGKILL");
        }, 3_000);
      }
    }
  }
});

// The stress checks (a 3M-word chapter) can need past a minute on a slow machine,
// so the hang guard budgets three. It still kills a genuinely wedged run.
const timer = setTimeout(() => {
  if (reported) console.error("[smoke] The app reported a result but did not exit; stopping it.");
  else console.error("[smoke] Timed out after 180s; stopping the run.");
  child.kill("SIGKILL");
}, 180_000);

child.on("exit", async (code, signal) => {
  clearTimeout(timer);
  if (grace) clearTimeout(grace);
  if (!process.env.SMOKE_KEEP) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  } else {
    console.log(`[smoke] kept ${temp}`);
  }
  if (signal) {
    if (reported?.ok) {
      console.log("[smoke] reported checks passed; the app did not exit on its own.");
      process.exit(0);
    }
    console.error(`[smoke] Stopped by ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? (reported?.ok ? 0 : 1));
});
