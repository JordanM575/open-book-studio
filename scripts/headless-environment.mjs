import { isAbsolute } from "node:path";

/**
 * The environment a hidden Electron or browser check runs in: the host fields it needs to start and
 * nothing else, so a provider key, a runtime override or a leftover STUDIO_ flag from the caller's
 * shell never reaches the app. The check sets the STUDIO_ flags it wants on top.
 */
const HOST_FIELDS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "SHELL",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME"
];

/** @param {Record<string, string | undefined>} source */
export function headlessEnvironment(source) {
  /** @type {Record<string, string>} */
  const environment = {};
  for (const key of HOST_FIELDS) {
    const value = source[key];
    if (typeof value === "string") environment[key] = value;
  }
  return environment;
}

/**
 * @param {Record<string, string | undefined>} source
 * @param {string} profile
 * @param {"refuse" | "memory"} [vault]
 */
export function headlessDesktopEnvironment(source, profile, vault = "refuse") {
  if (!isAbsolute(profile)) throw new Error("A hidden desktop check needs an absolute fixture profile");
  const vaultFlag = vault === "memory" ? "STUDIO_TEST_MEMORY_VAULT" : "STUDIO_NO_KEYCHAIN";
  return {
    ...headlessEnvironment(source),
    STUDIO_TEST: "1",
    STUDIO_HEADLESS: "1",
    STUDIO_USER_DATA: profile,
    [vaultFlag]: "1"
  };
}

/** Chromium's mock keychain is independent of the desktop application's test vault. */
export function mockKeychainArgs(platform = process.platform) {
  return platform === "darwin" ? ["--use-mock-keychain"] : [];
}
