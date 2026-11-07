import { app, BrowserWindow, dialog, Menu, session, shell } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_EVENT_CHANNEL,
  LIBRARY_EVENT_CHANNEL,
  SECOND_INSTANCE_EVENT_CHANNEL,
  SYNC_EVENT_CHANNEL
} from "@ai-book-studio/core/ipc";
import type { DriftReport } from "@ai-book-studio/core/sync/types";
import { DEFAULT_VOICE_PREFERENCES } from "@ai-book-studio/core/providers/voice-preferences";
import { DraftBuffer } from "./drafts";
import { ExitGuard, type ExitQuestion } from "./exit-guard";
import { RecoveryStore } from "./recovery";
import { SyncService } from "./sync";
import { registerIpc } from "./ipc";
import { createDesktopVault } from "./credentials";
import { ProviderService } from "./providers";
import { AgentRuntime } from "./agent/runtime";
import { ToolBridge } from "./agent/tool-bridge";
import { BackgroundNotifier } from "./background";
import { launchMode } from "./launch-mode";
import { LocalBackend } from "./backend";
import { LocalBridge, localAddresses, type BridgeLocator } from "./bridge";
import { MetricsStore } from "./metrics";
import glassesPage from "./glasses/index.html?raw";
import glassesManifest from "./glasses/manifest.json?raw";
import { AmbientService } from "./agent/ambient";
import { ImageService } from "./images";
import { VoiceService } from "./voice";
import { SpeechService } from "./speech";
import { SettingsStore } from "./settings";
import { claimsSingleInstanceLock, sendWhenLoaded } from "./instance";
import { StudioWindows } from "./windows";
import { Studio } from "./studio";
import { runSmoke } from "./smoke";
import { runLiveCheckInApp, sampleLibraryPath } from "./live-check";

const isDev = !app.isPackaged;

/**
 * Test mode keeps a development run invisible and isolated.
 *
 * - `STUDIO_TEST=1` gives the run its own profile (`STUDIO_USER_DATA`) so it never reads or
 *   overwrites the author's real library, window bounds or settings.
 * - `STUDIO_HEADLESS=1` opens the window off-screen and never shows it. The renderer still paints
 *   and runs, so `executeJavaScript` can inspect it without stealing focus.
 * - `STUDIO_VISIBLE=1` with `STUDIO_TEST=1` keeps the throwaway profile but shows the window, for a
 *   manual keychain or credential pass. It is the only way to see a test profile on screen.
 * - `STUDIO_SMOKE=1` runs the built-in smoke checks once the renderer has loaded, prints them and
 *   exits with a status code.
 *
 * A hidden run logs its background notifications instead of posting them to the desktop.
 */
const { isTest, headless } = launchMode(process.env);
const smoke = process.env.STUDIO_SMOKE === "1";
const capturePath = process.env.STUDIO_CAPTURE;
const windowSize = parseWindowSize(process.env.STUDIO_WINDOW_SIZE);
const TEST_WINDOW_OFFSET = -16_000;

// Must happen before the single-instance lock and before any settings are read.
if (isTest && process.env.STUDIO_USER_DATA) {
  app.setPath("userData", process.env.STUDIO_USER_DATA);
} else if (isTest) {
  console.warn("[studio] STUDIO_TEST is set without STUDIO_USER_DATA; this run is using your real profile.");
}

let mainWindow: BrowserWindow | null = null;
let studio: Studio;
let providers: ProviderService;
let settingsStore: SettingsStore | null = null;
let agentRuntime: AgentRuntime;
let notifier: BackgroundNotifier;
let backend: LocalBackend | null = null;
let exitGuard: ExitGuard | undefined;
/** Set once a quit has saved or kept every draft and the author did not choose to stay. */
let quitting = false;
let quitCheck: Promise<void> | null = null;

/*
 * One writer per profile (spec 002 FR-069), and the first thing a run does once its userData folder
 * is chosen. A copy that loses the lock has handed its launch to the copy that holds the profile, so
 * it stops here: it reads no settings, opens no library, starts no control plane and never writes
 * the locator. Claiming the lock in a hidden test run is safe because Electron keeps it in userData:
 * a run with its own `STUDIO_USER_DATA` holds a lock in that throwaway folder, which can neither
 * refuse the author's open studio nor be refused by it. A hidden run on the real profile still
 * claims nothing, because it may sit beside the author's own window.
 */
const claimsLock = claimsSingleInstanceLock({ headless, isTest, userData: process.env.STUDIO_USER_DATA });
const refused = claimsLock && !app.requestSingleInstanceLock();
if (refused) {
  console.log("[studio] This profile is already open in another copy of the studio, so this copy is closing without opening the library.");
  app.quit();
} else if (claimsLock) {
  app.on("second-instance", () => {
    console.log("[studio] A second copy started with this profile and was refused.");
    // Startup may still be running, and the window it creates is the one that should say so.
    void started
      .then(() => {
        showStudioWindow();
        if (mainWindow) sendWhenLoaded(mainWindow.webContents, SECOND_INSTANCE_EVENT_CHANNEL);
      })
      .catch((error: unknown) => console.warn("[studio] Could not report the refused second copy:", error));
  });
}

function createWindow(): BrowserWindow {
  const settings = studio.settingsWindowBounds();
  const window = new BrowserWindow({
    width: windowSize?.width ?? settings?.width ?? 1440,
    height: windowSize?.height ?? settings?.height ?? 900,
    ...(headless
      ? { x: TEST_WINDOW_OFFSET, y: TEST_WINDOW_OFFSET }
      : settings?.x !== undefined && settings.y !== undefined
        ? { x: settings.x, y: settings.y }
        : {}),
    minWidth: windowSize ? 320 : 1024,
    minHeight: windowSize ? 480 : 700,
    show: false,
    skipTaskbar: headless,
    backgroundColor: "#eef0f6",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  // The capture harness can exercise responsive touch targets without a device.
  // This is test-only and does not change normal Electron pointer behavior.
  if (isTest && process.env.STUDIO_COARSE_POINTER === "1") {
    try {
      const debuggerSession = window.webContents.debugger;
      debuggerSession.attach("1.3");
      void debuggerSession
        .sendCommand("Emulation.setEmulatedMedia", {
          features: [
            { name: "pointer", value: "coarse" },
            { name: "hover", value: "none" }
          ]
        })
        .then(() => debuggerSession.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }))
        .catch((error: unknown) => console.error("[capture] Could not emulate a coarse pointer:", error));
      window.once("closed", () => {
        if (debuggerSession.isAttached()) debuggerSession.detach();
      });
    } catch (error) {
      console.error("[capture] Could not attach touch emulation:", error);
    }
  }

  // A hidden test window must never surface, even when it is ready.
  window.once("ready-to-show", () => {
    if (!headless) window.show();
  });

  if (!app.isPackaged) {
    window.webContents.on("console-message", (event) => {
      console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
      console.error(`[renderer] Failed to load ${url}: ${description} (${code})`);
    });
    window.webContents.on("preload-error", (_event, path, error) => {
      console.error(`[preload] ${path}:`, error);
    });
  }

  // Nothing in this app should open a second window or navigate away from the studio.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  const rememberBounds = (): void => {
    if (headless) return;
    const bounds = window.getNormalBounds();
    studio.rememberWindowBounds(bounds);
  };
  window.on("resized", rememberBounds);
  window.on("moved", rememberBounds);

  // Give the draft buffer one chance to reach the disk before the window goes away. The window is
  // asked for its newest text first: the draft it last sent can trail the last keystrokes. Words the
  // library refuses are kept for recovery, and the author chooses whether the window closes. A quit
  // already did all of this before it closes the window, so it is not asked twice.
  let allowClose = false;
  let closeCheck: Promise<void> | null = null;
  window.on("close", (event) => {
    if (allowClose || quitting || !exitGuard) return;
    event.preventDefault();
    if (closeCheck) return;
    closeCheck = exitGuard
      .check(window.webContents, "close")
      .catch((error: unknown) => {
        console.warn("[studio] Flush before close failed:", error);
        return "leave" as const;
      })
      .then((choice) => {
        if (choice === "stay") return;
        allowClose = true;
        window.close();
      })
      .finally(() => {
        closeCheck = null;
      });
  });

  window.on("closed", () => {
    mainWindow = null;
    // A background turn outlives its window: remember where it was, so the next window opens there.
    noteStudioWindowClosed();
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  if (smoke) {
    window.webContents.once("did-finish-load", () => {
      void runSmoke(window, studio).catch((error: unknown) => {
        console.error("[smoke] The run crashed:", error);
        app.exit(1);
      });
    });
  }

  /*
   * The live check runs here, in the app's own runtime, so it uses the Meta key from the
   * operating system's keychain through the app's own vault. The key is never on a command line,
   * where a shell history would keep it.
   */
  if (process.env.STUDIO_LIVE_CHECK === "1") {
    void (async () => {
      try {
        const results = await runLiveCheckInApp(
          providers,
          sampleLibraryPath(),
          settingsStore?.voicePreferences() ?? DEFAULT_VOICE_PREFERENCES
        );
        const failed = results.filter((result) => result.outcome === "failed").length;
        console.log(`[live] result ${JSON.stringify(results)}`);
        app.exit(failed === 0 ? 0 : 1);
      } catch (error) {
        console.error("[live] The run crashed:", error);
        app.exit(1);
      }
    })();
  }

  if (capturePath) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        void (async () => {
          const click = process.env.STUDIO_CAPTURE_CLICK;
              if (click) {
                for (const selector of click.split("||")) {
                  await window.webContents.executeJavaScript(
                    `document.querySelector(${JSON.stringify(selector)})?.click()`
                  );
                  await new Promise((resolve) => setTimeout(resolve, 900));
                }
              }
              if (process.env.STUDIO_COARSE_POINTER === "1") {
                const audit = (await window.webContents.executeJavaScript(`(() => {
                  const selectors = [
                    'button:not(:disabled)',
                    '[role="button"]',
                    '[role="tab"]',
                    '[role="menuitem"]',
                    '[role="option"]',
                    '[role="combobox"]',
                    'summary',
                    'select',
                    'textarea',
                    'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not(:disabled)',
                    'label:has(> input[type="checkbox"]:not(:disabled))',
                    'label:has(> input[type="radio"]:not(:disabled))'
                  ].join(',');
                  const failures = [...document.querySelectorAll(selectors)]
                    .filter((element) => {
                      const style = getComputedStyle(element);
                      const rect = element.getBoundingClientRect();
                      return style.display !== 'none' && style.visibility !== 'hidden' &&
                        rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
                    })
                    .map((element) => {
                      const rect = element.getBoundingClientRect();
                      return {
                        selector: element.getAttribute('data-testid') || element.getAttribute('aria-label') || element.tagName.toLowerCase(),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                      };
                    });
                  return {
                    coarse: matchMedia('(pointer: coarse)').matches,
                    failures,
                    scrollWidth: document.documentElement.scrollWidth,
                    innerWidth: window.innerWidth
                  };
                })()`)) as {
                  coarse: boolean;
                  failures: Array<{ selector: string; width: number; height: number }>;
                  scrollWidth: number;
                  innerWidth: number;
                };
                if (!audit.coarse || audit.failures.length > 0 || audit.scrollWidth > audit.innerWidth + 1) {
                  console.error("[capture] Coarse-pointer audit failed:", JSON.stringify(audit));
                  app.exit(1);
                  return;
                }
                console.log(`[capture] touch targets ok (${audit.failures.length} below 44px)`);
              }
              const image = await window.webContents.capturePage();
          await writeFile(capturePath, image.toPNG());
          app.exit(0);
        })().catch((error: unknown) => {
          console.error("[capture] The screenshot failed:", error);
          app.exit(1);
        });
      }, 1800);
    });
  }

  return window;
}

/*
 * The notification's click, a second copy and the dock all bring back the one window, or make it
 * again. A window made after a background turn's window closed opens on its conversation.
 */
const windows = new StudioWindows({
  current: () => mainWindow,
  create: () => (mainWindow = createWindow()),
  headless
});

/** Bring back the existing window, or recreate it after a background notification or a second copy. */
function showStudioWindow(): void {
  windows.show();
}

/** The window closed: a background turn still running is remembered for the next window. */
function noteStudioWindowClosed(): void {
  windows.noteWindowClosed(agentRuntime?.activeBackgroundTurns() ?? []);
}

function parseWindowSize(value: string | undefined): { width: number; height: number } | null {  if (!value) return null;
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(value);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height };
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open library…",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            mainWindow?.webContents.send("menu:open-library");
          }
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" }
      ]
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }]
    },
    { role: "windowMenu" }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const started = app.whenReady().then(async () => {
  // A refused copy goes no further, even when `ready` arrives before its quit completes.
  if (refused) return;
  if (headless && process.platform === "darwin") {
    app.dock?.hide();
  }

  const settings = new SettingsStore();
  settingsStore = settings;
  await settings.load();
  studio = new Studio(settings, new DraftBuffer(), new RecoveryStore(join(app.getPath("userData"), "recovery")));
  exitGuard = new ExitGuard(studio, { headless, ask: askBeforeExit });
  studio.onExternalChange = (event) => {
    mainWindow?.webContents.send(LIBRARY_EVENT_CHANNEL, event);
  };
  const sync = new SyncService(studio, settings);
  const pushDrift = (report: DriftReport | null): void => {
    if (report && !report.clean) {
      mainWindow?.webContents.send(SYNC_EVENT_CHANNEL, { report });
    }
  };
  studio.onLibraryOpened = () => {
    void sync.check().then(pushDrift);
  };
  await studio.restore();

  // The control plane is for the standalone CLI and MCP server. A hidden test run can start it too,
  // with its own locator file, so the toolkit can be exercised end to end without a window.
  const toolsBridge = new ToolBridge(
    () => studio.library,
    () => settings.get().pluginFolder ?? null
  );
  if (!headless || process.env.STUDIO_BACKEND === "1") {
    backend = new LocalBackend(studio, {
      tools: toolsBridge,
      ambient: new AmbientService(() => studio.library, (bookId) => agentRuntime.isWorking(bookId)),
      agent: {
        run: (input) => agentRuntime.runToCompletion(input),
        undo: (bookId, turnId) => agentRuntime.undoLast(bookId, turnId),
        stop: async (bookId) => ({ stopped: await agentRuntime.stopBook(bookId) })
      },
      glassesPage,
      glassesManifest
    });
    void backend.start().catch((error: unknown) => {
      console.warn("[backend] Could not start the agent toolkit service:", error);
      backend = null;
    });
  }

  /*
   * The bridge to the phone.
   *
   * It is off until the author turns it on, and it listens on one named local address rather than
   * on every interface, so the studio is not exposed to whatever network the machine happens to
   * be on. It serves the ambient status, a turn and a tool call, and nothing else.
   */
  const bridgeControl = {
    bridge: null as LocalBridge | null,
    status: null as BridgeLocator | null,
    async start(address: string): Promise<BridgeLocator> {
      if (bridgeControl.bridge) {
        if (!bridgeControl.status) throw new Error("The control plane started without a locator.");
        return bridgeControl.status;
      }
      const token = backend?.token_value;
      if (!token) throw new Error("The control plane is not running, so there is no token to share.");
      const bridge = new LocalBridge({
        address,
        token,
        studio: {
          ambient: (bookId) =>
            new AmbientService(() => studio.library, (id) => agentRuntime.isWorking(id)).status(bookId),
          turn: (input) => agentRuntime.runToCompletion({ ...input, mode: "edit" }),
          tool: (input) => toolsBridge.run(input),
          undo: (bookId) => agentRuntime.undoLast(bookId),
          stop: async (bookId) => ({ stopped: await agentRuntime.stopBook(bookId) })
        }
      });
      bridgeControl.bridge = bridge;
      const started = await bridge.start();
      bridgeControl.status = started;
      console.log(`[bridge] the phone can reach the studio at ${started.url}`);
      return started;
    },
    async stop(): Promise<void> {
      await bridgeControl.bridge?.stop();
      bridgeControl.bridge = null;
      bridgeControl.status = null;
    }
  };

  const vault = createDesktopVault();
  providers = new ProviderService(vault, (url) => shell.openExternal(url));
  const voice = new VoiceService(providers, fetch, () => settings.voicePreferences());
  const speech = new SpeechService(providers, fetch, () => settings.voicePreferences());
  const images = new ImageService(providers);
  void vault.repairPermissions().then((permissions) => {
    if (permissions === "corrected") {
      console.log("[credentials] Corrected the credential file to owner-only permissions.");
    } else if (permissions === "unavailable") {
      console.warn("[credentials] Could not confirm owner-only permissions on the credential file.");
    }
  }).catch(() => {});
  void providers.available().then((available) => {
    if (!available) {
      console.warn("[credentials] Protected storage is unavailable; model connections cannot be saved on this computer.");
    }
  });
  notifier = new BackgroundNotifier(() => mainWindow, showStudioWindow, headless);
  const metrics = new MetricsStore(() => studio.library?.root ?? null);
  agentRuntime = new AgentRuntime(
    studio,
    providers,
    (event) => {
      mainWindow?.webContents.send(AGENT_EVENT_CHANNEL, event);
    },
    undefined,
    (outcome) => {
      windows.noteOutcome(outcome);
      notifier.handle(outcome);
    },
    () => settings.get().pluginFolder ?? null,
    metrics
  );

  // The studio only needs the microphone. Camera, geolocation, notifications and every other
  // permission stay denied; there is no remote content that could ask for them.
  session.defaultSession.setPermissionCheckHandler((_contents, permission, _origin, details) => {
    return permission === "media" && details.mediaType === "audio";
  });
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission !== "media" || !("mediaTypes" in details)) {
      callback(false);
      return;
    }
    const types = details.mediaTypes ?? [];
    callback(types.length > 0 && types.every((type) => type === "audio"));
  });
  app.on("browser-window-focus", () => {
    notifier.clearBadge();
    void sync.maybeCheckOnFocus().then(pushDrift);
  });

  registerIpc(
    studio,
    () => mainWindow,
    providers,
    agentRuntime,
    voice,
    images,
    toolsBridge,
    settings,
    speech,
    () => backend,
    bridgeControl,
    (bookId) => agentRuntime.isWorking(bookId)
  );

  /*
   * A headless run can turn the bridge on at launch, the way `STUDIO_BACKEND=1` starts the control
   * plane. It is how the phone's half is proved from a separate process before there is a phone:
   * the run prints where it is listening, and a client outside this process speaks to it.
   */
  if (process.env.STUDIO_BRIDGE === "1") {
    const address = localAddresses()[0];
    if (!address) {
      console.error("[bridge] This computer has no local network address, so nothing can reach it.");
    } else {
      void bridgeControl
        .start(address)
        .then((started) => {
          console.log(`[bridge] result ${JSON.stringify({ url: started.url, address: started.address })}`);
        })
        .catch((error: unknown) => {
          console.error("[bridge] Could not start:", error);
        });
    }
  }
  buildMenu();
  mainWindow = createWindow();

  app.on("activate", () => {
    notifier?.clearBadge();
    // The studio's own window, not any window: a hidden PDF export window is not one to come back to.
    windows.activate();
  });
});

/** The native question before a close or quit with unsaved words, on the window when there is one. */
async function askBeforeExit(question: ExitQuestion): Promise<number> {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const { response } = window ? await dialog.showMessageBox(window, question) : await dialog.showMessageBox(question);
  return response;
}

/*
 * The quit decides before it stops anything: an author who keeps the studio open keeps the control
 * plane too. A second quit while the question is open waits for the first, and a quit during the
 * close question shares its answer (`ExitGuard.check`).
 */
app.on("before-quit", (event) => {
  if (quitting || !studio || !exitGuard) return;
  event.preventDefault();
  if (quitCheck) return;
  const guard = exitGuard;
  quitCheck = (async () => {
    const choice = await guard.check(mainWindow?.webContents ?? null, "quit").catch((error: unknown) => {
      console.warn("[studio] Flush before quit failed:", error);
      return "leave" as const;
    });
    if (choice === "stay") return;
    await (backend?.stop() ?? Promise.resolve()).catch((error: unknown) =>
      console.warn("[backend] Could not stop the agent toolkit service:", error)
    );
    quitting = true;
    app.quit();
  })().finally(() => {
    quitCheck = null;
  });
});

app.on("window-all-closed", () => {
  if (headless) {
    app.quit();
    return;
  }
  if (process.platform !== "darwin" && !agentRuntime?.hasActiveBackgroundTurns()) app.quit();
});
