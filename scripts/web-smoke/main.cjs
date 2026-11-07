const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { version } = require("../../package.json");

const url = process.env.WEB_SMOKE_URL;
const resultPath = process.env.WEB_SMOKE_RESULT;
const profile = process.env.WEB_SMOKE_PROFILE;
const checks = [];
const consoleErrors = [];
let saveArtifacts = async () => {};

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
}

async function finish() {
  const ok = checks.length > 0 && checks.every((check) => check.ok) && consoleErrors.length === 0;
  if (!ok) await saveArtifacts();
  writeFileSync(
    resultPath,
    JSON.stringify({ ok, checks, consoleErrors }, null, 2)
  );
  app.exit(ok ? 0 : 1);
}

app.setPath("userData", profile);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 393,
    height: 852,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // The page draws after the load event, and on a slow runner that can take longer than any fixed wait,
  // so every wait for the page polls (up to ten seconds) instead of sleeping once and checking once.
  const inPage = (script) =>
    window.webContents.executeJavaScript(`(() => { try { return Boolean(${script}); } catch { return false; } })()`);
  const pollPage = async (script) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await inPage(script)) return true;
      await sleep(250);
    }
    return false;
  };
  // What an author would see, for a failure message: the first words on screen and the page error count.
  const describePage = async () => {
    try {
      const text = await window.webContents.executeJavaScript(
        `(document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 160)`
      );
      return `the page says "${text}" with ${consoleErrors.length} page error(s)`;
    } catch (error) {
      return `the page could not be read (${error.message})`;
    }
  };
  const waitPage = async (script, what) => {
    if (await pollPage(script)) return true;
    throw new Error(`the ${what} never appeared: ${await describePage()}`);
  };
  const WELCOME = `document.querySelector('[data-testid="web-welcome"]')`;
  const LIBRARY = `document.querySelector('[data-testid="library-view"]')`;
  // The library draws at once and its book cards when the listing comes back, so a script that is
  // about to click the book waits for its card instead of assuming the listing has finished.
  const BOOK_CARD = `[...document.querySelectorAll('[data-testid="book-card"]')].some((entry) => (entry.textContent ?? "").includes("Web Smoke Book"))`;
  // Load the page again as a returning author would: wait for whichever first screen it draws, choose
  // browser storage if that screen is the welcome, then wait for the smoke book's card (every reload in
  // this script comes after the book was created).
  const reloadPage = async () => {
    await window.loadURL(url);
    await waitPage(`${WELCOME} || ${LIBRARY}`, "welcome or library screen");
    if (await inPage(WELCOME)) {
      await window.webContents.executeJavaScript(
        `document.querySelector('[data-testid="use-browser-storage"]')?.click()`
      );
    }
    await waitPage(BOOK_CARD, "Web Smoke Book card");
  };

  const { createRunDir, redactLine } = await import(
    pathToFileURL(path.join(__dirname, "..", "failure-artifacts.mjs")).href
  );
  const runDir = await createRunDir("web-smoke");
  saveArtifacts = async () => {
    try {
      const png = path.join(runDir, "web-smoke-failure.png");
      writeFileSync(png, (await window.webContents.capturePage()).toPNG());
      const log = path.join(runDir, "web-smoke-console.log");
      writeFileSync(log, `${consoleErrors.join("\n")}\n`);
      console.error(`[web-smoke] artifacts: ${png} ${log}`);
    } catch (error) {
      console.error(`[web-smoke] artifact capture failed: ${error.message}`);
    }
  };

  window.webContents.on("console-message", (event) => {
    const level = event?.level ?? "info";
    if (level === "error") consoleErrors.push(redactLine(event.message ?? "unknown page error"));
  });

  try {
    await window.loadURL(url);
    const welcome = await pollPage(WELCOME);
    record(
      "the web welcome offers a storage choice",
      welcome,
      welcome ? "welcome rendered" : `welcome missing: ${await describePage()}`
    );
    if (!welcome) return finish();

    await window.webContents.executeJavaScript(
      "document.querySelector('[data-testid=\"use-browser-storage\"]')?.click()"
    );
    let library = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      library = await window.webContents.executeJavaScript(
        "Boolean(document.querySelector('[data-testid=\"library-view\"]'))"
      );
      if (library) break;
      await sleep(250);
    }
    record("browser storage opens the library", library, library ? "library view rendered" : "library view missing");
    if (!library) return finish();

    const result = await window.webContents.executeJavaScript(`(async () => {
      const out = {
        book: null,
        chapter: null,
        saved: null,
        reopened: null,
        root: null,
        buildTarget: null,
        buildVersion: null,
        buildAgent: null,
        staleStatus: null,
        conflictCount: null,
        archiveEntries: null,
        archiveName: null,
        archiveBytes: null,
        archiveMagic: null,
        error: null
      };
      try {
        const created = await window.studio.books.create({
          title: "Web Smoke Book",
          description: "Created by the browser smoke run."
        });
        if (!created.ok) throw new Error(created.error.message);
        out.book = created.data.id;

        const chapter = await window.studio.chapters.create(created.data.id, { title: "One" });
        if (!chapter.ok) throw new Error(chapter.error.message);
        out.chapter = chapter.data.id;

        const saved = await window.studio.chapters.save({
          bookId: created.data.id,
          chapterId: chapter.data.id,
          content: "Browser smoke prose.\\n",
          baseVersion: chapter.data.version,
          baseHash: chapter.data.hash
        });
        if (!saved.ok || saved.data.status !== "saved") throw new Error("save did not commit");
        out.saved = saved.data.chapter.version;

        const reopened = await window.studio.books.open(created.data.id);
        if (!reopened.ok) throw new Error(reopened.error.message);
        out.reopened = reopened.data.chapters[0]?.content ?? null;

        const root = await window.studio.library.current();
        out.root = root.ok ? root.data.root : null;
        out.storageTier = root.ok ? (root.data.storage?.tier ?? null) : null;
        out.lastCommittedAt = root.ok ? (root.data.storage?.lastCommittedAt ?? null) : null;

        /*
         * The minimal mode in a browser: the ambient status is a pure function over the book, so
         * this build computes it itself even though the writing agent needs the desktop.
         */
        const ambient = await window.studio.agent.ambient(created.data.id);
        out.ambientOk = ambient.ok;
        out.ambientSay = ambient.ok ? ambient.data.say : null;
        out.ambientActions = ambient.ok ? ambient.data.actions.length : -1;

        const build = await window.studio.app.info();
        out.buildTarget = build.ok ? build.data.target : null;
        out.buildVersion = build.ok ? build.data.version : null;
        out.buildAgent = build.ok ? (build.data.capabilities.find((entry) => entry.id === "agent")?.available ?? null) : null;

        const stale = await window.studio.chapters.save({
          bookId: created.data.id,
          chapterId: chapter.data.id,
          content: "Stale browser smoke prose.\\n",
          baseVersion: chapter.data.version,
          baseHash: chapter.data.hash
        });
        out.staleStatus = stale.ok ? stale.data.status : null;
        const conflicts = await window.studio.conflicts.list(created.data.id);
        out.conflictCount = conflicts.ok ? conflicts.data.length : -1;

        const chunks = [];
        Object.defineProperty(window, "showSaveFilePicker", {
          configurable: true,
          value: async () => ({
            name: "smoke-archive.zip",
            async createWritable() {
              return {
                async write(chunk) {
                  chunks.push(chunk);
                },
                async close() {},
                async abort() {}
              };
            }
          })
        });
        const archive = await window.studio.library.exportArchive();
        out.archiveEntries = archive.ok ? archive.data.entryCount : -1;
        out.archiveName = archive.ok ? archive.data.path : null;
        out.archiveBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        out.archiveMagic =
          chunks[0] instanceof Uint8Array && chunks[0][0] === 0x50 && chunks[0][1] === 0x4b;
      } catch (error) {
        out.error = error.message;
      }
      return out;
    })()`);

    record("a book and chapter can be created", Boolean(result.book && result.chapter), result.error ?? result.book ?? "failed");
    record("a save commits a new version", result.saved === 2, `version ${result.saved}`);
    record("the saved prose reopens", result.reopened === "Browser smoke prose.\n", JSON.stringify(result.reopened));
    record("the library identifies itself as browser storage", String(result.root ?? "").startsWith("browser://"), result.root ?? "no root");
    record(
      "the library reports browser storage durability",
      result.storageTier === "browser" && Boolean(result.lastCommittedAt),
      `${result.storageTier ?? "no tier"} · ${result.lastCommittedAt ?? "no confirmed save"}`
    );
    record(
      "the minimal mode knows where the author is, in a browser",
      result.ambientOk === true &&
        typeof result.ambientSay === "string" &&
        /Smoke/i.test(result.ambientSay) &&
        result.ambientSay.length > 20,
      String(result.ambientSay ?? "no status").slice(0, 74)
    );
    record(
      "the minimal mode offers the studio's verbs in a browser",
      result.ambientActions >= 4,
      `${result.ambientActions ?? "no"} actions`
    );

    record(
      "the web build reports its own metadata",
      result.buildTarget === "web" && result.buildVersion === version && result.buildAgent === false,
      `${result.buildTarget ?? "no target"} ${result.buildVersion ?? "no version"}`
    );
    record(
      "a stale browser save keeps a conflict copy",
      result.staleStatus === "conflict" && result.conflictCount >= 1,
      `${result.staleStatus ?? "no status"} · ${result.conflictCount ?? "no count"} conflict(s)`
    );
    record(
      "the library exports a portable archive",
      result.archiveEntries > 0 && result.archiveMagic === true && result.archiveBytes > 0,
      `${result.archiveEntries ?? "no"} entries · ${result.archiveName ?? "no file"}`
    );

    /*
     * The interface journey, through the real controls: open the created book, write with
     * keystrokes in the manuscript editor, reload the page and prove the prose survived, then
     * force a two-writer conflict through the UI save path and export through the UI button.
     */
    const ui = {
      opened: false,
      typed: false,
      saved: false,
      reloaded: false,
      kept: false,
      conflict: false,
      conflictListed: false,
      exported: false,
      error: null
    };
    try {
      // The books above were created through the bridge, bypassing the page's list state.
      // Reload so the library view fetches the committed books like a returning author would.
      await reloadPage();
      await waitPage(`document.querySelector('[data-testid="library-view"]')`, "library for the interface journey");
      const openBook = await window.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll('[data-testid="book-card"]')];
        const card = cards.find((entry) => (entry.textContent ?? "").includes("Web Smoke Book"));
        if (!card) return false;
        card.click();
        return true;
      })()`);
      if (!openBook) throw new Error("the created book has no card");
      await waitPage(
        `document.querySelector('[data-testid="workspace-view"]') && document.querySelector('[data-testid="chapter-item"]')`,
        "workspace with its chapter"
      );
      ui.opened = true;

      const openChapter = await window.webContents.executeJavaScript(`(() => {
        const item = document.querySelector('[data-testid="chapter-item"]');
        if (!item) return false;
        item.click();
        return true;
      })()`);
      if (!openChapter) throw new Error("the chapter has no row");
      await waitPage(`document.querySelector('[data-testid="manuscript-text"]')`, "manuscript editor");
      const readVersion = await window.webContents.executeJavaScript(`(async () => {
        const opened = await window.studio.books.open(${JSON.stringify(result.book)});
        const chapter = opened.ok ? opened.data.chapters.find((entry) => entry.id === ${JSON.stringify(result.chapter)}) : null;
        return chapter ? chapter.version : null;
      })()`);
      if (readVersion === null) throw new Error("the chapter is unreadable before typing");
      await window.webContents.executeJavaScript(
        `document.querySelector('[data-testid="manuscript-text"]').focus()`
      );
      const sentence = "the keeper lit the lamp and the stairs went quiet.";
      for (const char of sentence) window.webContents.sendInputEvent({ type: "char", keyCode: char });
      ui.typed = true;
      // The save status can already read Saved when nothing changed, so a bare wait for it
      // proves nothing. Prove the keystrokes landed in the editor first.
      await waitPage(
        `document.querySelector('[data-testid="manuscript-text"]').value.includes("the keeper lit the lamp")`,
        "typed prose in the editor"
      );
      await waitPage(
        `(document.querySelector('[data-testid="save-status"]')?.textContent ?? "").startsWith("Saved")`,
        "saved status after typing"
      );
      const written = await window.webContents.executeJavaScript(`(async () => {
        const opened = await window.studio.books.open(${JSON.stringify(result.book)});
        const chapter = opened.ok ? opened.data.chapters.find((entry) => entry.id === ${JSON.stringify(result.chapter)}) : null;
        return chapter ? chapter.version : null;
      })()`);
      if (written === null || written <= readVersion) {
        throw new Error(`the UI save did not commit a new version (was ${readVersion}, now ${written})`);
      }
      ui.saved = true;

      await reloadPage();
      await waitPage(`document.querySelector('[data-testid="library-view"]')`, "library after reload");
      const reopenBook = await window.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll('[data-testid="book-card"]')];
        const card = cards.find((entry) => (entry.textContent ?? "").includes("Web Smoke Book"));
        if (!card) return false;
        card.click();
        return true;
      })()`);
      if (!reopenBook) throw new Error("the book is gone after reload");
      await waitPage(`document.querySelector('[data-testid="manuscript-text"]')`, "manuscript editor after reload");
      const kept = await window.webContents.executeJavaScript(
        `document.querySelector('[data-testid="manuscript-text"]').value.includes(${JSON.stringify(sentence)})`
      );
      if (!kept) throw new Error("the typed prose did not survive the reload");
      ui.reloaded = true;
      ui.kept = true;

      const before = await window.webContents.executeJavaScript(`(async () => {
        const opened = await window.studio.books.open(${JSON.stringify(result.book)});
        const chapter = opened.ok ? opened.data.chapters.find((entry) => entry.id === ${JSON.stringify(result.chapter)}) : null;
        return chapter ? { version: chapter.version, hash: chapter.hash } : null;
      })()`);
      if (!before) throw new Error("the chapter is unreadable before the conflict");
      const other = await window.webContents.executeJavaScript(`(async () => {
        const saved = await window.studio.chapters.save({
          bookId: ${JSON.stringify(result.book)},
          chapterId: ${JSON.stringify(result.chapter)},
          content: "Browser smoke prose.\\nOther writer line.\\n",
          baseVersion: ${JSON.stringify(before.version)},
          baseHash: ${JSON.stringify(before.hash)}
        });
        return saved.ok ? saved.data.status : null;
      })()`);
      if (other !== "saved") throw new Error("the other writer could not save");
      await window.webContents.executeJavaScript(
        `document.querySelector('[data-testid="manuscript-text"]').focus()`
      );
      const second = "the gulls went quiet too.";
      for (const char of second) window.webContents.sendInputEvent({ type: "char", keyCode: char });
      await window.webContents.executeJavaScript(
        `document.querySelector('[data-testid="manuscript-text"]').blur()`
      );
      await waitPage(
        `(document.querySelector('[data-testid="save-status"]')?.textContent ?? "") === "Not saved"`,
        "conflict status after the stale save"
      );
      ui.conflict = true;
      await reloadPage();
      await waitPage(`document.querySelector('[data-testid="library-view"]')`, "library after the conflict");
      const reopenConflicted = await window.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll('[data-testid="book-card"]')];
        const card = cards.find((entry) => (entry.textContent ?? "").includes("Web Smoke Book"));
        if (!card) return false;
        card.click();
        return true;
      })()`);
      if (!reopenConflicted) throw new Error("the book is gone after the conflict");
      const listed = await waitPage(
        `/saved cop(y|ies) from earlier sync conflicts/.test(document.body.innerText ?? "")`,
        "named conflict copy"
      );
      if (!listed) throw new Error("the conflict copy is not named in the workspace");
      ui.conflictListed = true;

      await reloadPage();
      await waitPage(`document.querySelector('[data-testid="library-view"]')`, "library before export");
      await window.webContents.executeJavaScript(`(() => {
        window.__smokeChunks = [];
        Object.defineProperty(window, "showSaveFilePicker", {
          configurable: true,
          value: async () => ({
            name: "smoke-ui-archive.zip",
            async createWritable() {
              return {
                async write(chunk) {
                  window.__smokeChunks.push(chunk);
                },
                async close() {},
                async abort() {}
              };
            }
          })
        });
        document.querySelector('[data-testid="export-archive"]')?.click();
      })()`);
      await waitPage(`(window.__smokeChunks ?? []).length > 0`, "archive bytes from the export button");
      ui.exported = true;
    } catch (error) {
      ui.error = error.message;
    }
    record("the book opens through the library card", ui.opened, ui.error ?? "workspace and chapter rendered");
    record("keystrokes in the editor save through the UI", ui.saved, ui.error ?? "save status reads Saved");
    record("a reload keeps the typed prose", ui.kept, ui.error ?? "prose present after reload");
    record(
      "a stale UI save surfaces the conflict instead of overwriting",
      ui.conflict && ui.conflictListed,
      ui.error ?? "Not saved, and the copy is named"
    );
    record(
      "the export button produces a portable archive",
      ui.exported,
      ui.error ?? "archive bytes flowed from the button"
    );

    try {
      const debug = window.webContents.debugger;
      debug.attach("1.3");
      try {
        await debug.sendCommand("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-reduced-motion", value: "reduce" },
            { name: "prefers-reduced-transparency", value: "reduce" }
          ]
        });
        const styles = await window.webContents.executeJavaScript(`(() => {
          const root = getComputedStyle(document.documentElement);
          const glass = document.querySelector(".glass, .glass-strong, .glass-dialog");
          return {
            duration: root.getPropertyValue("--duration-fast").trim(),
            backdrop: glass ? getComputedStyle(glass).backdropFilter : "no-glass"
          };
        })()`);
        record(
          "reduced motion and transparency are honored",
          (styles.duration === "0s" || styles.duration === "0ms") &&
            (styles.backdrop === "none" || styles.backdrop === "no-glass"),
          JSON.stringify(styles)
        );
      } finally {
        debug.detach();
      }
    } catch (error) {
      record("reduced motion and transparency are honored", false, error.message);
    }
  } catch (error) {
    record("the web shell loaded", false, error.message);
  } finally {
    await finish();
  }
});
