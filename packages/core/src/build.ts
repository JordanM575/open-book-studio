import { SCHEMA_VERSION } from "./schema";

export type BuildTarget = "desktop" | "web";

export interface BuildCapability {
  id: string;
  label: string;
  available: boolean;
  /** Present when the capability is unavailable; never a stack trace. */
  reason?: string;
}

/**
 * How the artifact is signed. Every build is unsigned until D-115 is accepted;
 * the wider shape reserves the signed claim (which always names its identity)
 * so About and the release record share one vocabulary.
 */
export interface BuildSigning {
  status: "unsigned" | "signed";
  identity?: string;
}

/**
 * The observed host identity, injected at the platform edge. Desktop reports
 * the OS and CPU it runs on; the browser cannot reliably detect CPU
 * architecture, so web reports "unknown" there per the unknown-label rule.
 */
export interface BuildHost {
  platform: string;
  arch: string;
  webCapabilities?: WebBuildCapabilities;
}

/** Passive API observations. Selecting a library or checking permissions belongs to the action. */
export interface WebBuildCapabilities {
  folderAccess: boolean;
  browserStorage: boolean;
  connectionStorage: boolean;
}

export interface BuildMetadata {
  target: BuildTarget;
  version: string;
  commit: string;
  schemaVersion: number;
  capabilities: BuildCapability[];
  signing: BuildSigning;
  platform: string;
  arch: string;
}

type Availability = true | string;

interface BrowserRequirement {
  requires: keyof WebBuildCapabilities;
  reason: string;
}

interface CapabilityRow {
  id: string;
  label: string;
  desktop: Availability;
  web: Availability | BrowserRequirement;
}

/**
 * Shared target declarations. The web host supplies passive observations for the capabilities
 * that depend on an exposed browser API.
 */
const CAPABILITIES: CapabilityRow[] = [
  {
    id: "storage.folder",
    label: "Folder library",
    desktop: true,
    web: {
      requires: "folderAccess",
      reason: "Opening a folder here requires a secure page and a browser folder picker. You can open a folder in the desktop app."
    }
  },
  {
    id: "storage.browser",
    label: "Browser storage",
    desktop: "Browser storage belongs to the web build. Use a folder library in the desktop app.",
    web: {
      requires: "browserStorage",
      reason: "This browser needs site storage to keep a library here. Use a browser that offers it or open a folder in the desktop app."
    }
  },
  { id: "archive", label: "Portable archive", desktop: true, web: true },
  {
    id: "export.docx",
    label: "Word export",
    desktop: true,
    web: "Word export is available in the desktop app. Export an archive in the browser."
  },
  {
    id: "agent",
    label: "Writing agent",
    desktop: true,
    web: "Use the desktop app to run the writing agent."
  },
  {
    id: "providers.connections",
    label: "Provider connection storage",
    desktop: true,
    web: {
      requires: "connectionStorage",
      reason: "Saving provider connections here requires browser site storage. Allow site storage or use the desktop app."
    }
  },
  {
    id: "sync.review",
    label: "Manual sync drift review",
    desktop: true,
    web: true
  },
  {
    id: "sync.schedule",
    label: "Drift check interval",
    desktop: true,
    web: "Set the check interval in the desktop app. Use Check for changes to review drift here."
  }
];

// Vite replaces these identifiers at build time. `typeof` keeps the same module usable in
// Bun tests, where no build constants exist.
declare const __BUILD_VERSION__: string | undefined;
declare const __BUILD_COMMIT__: string | undefined;

const DEV_VERSION = "0.0.0-dev";
const UNKNOWN_COMMIT = "unknown";

/** Without host facts this lists what the target implements, for release records. */
export function capabilitiesFor(target: BuildTarget, webCapabilities?: WebBuildCapabilities): BuildCapability[] {
  return CAPABILITIES.map((row) => {
    const availability = row[target];
    let reason = typeof availability === "string" ? availability : undefined;
    if (typeof availability === "object" && webCapabilities && !webCapabilities[availability.requires]) {
      reason = availability.reason;
    }
    return {
      id: row.id,
      label: row.label,
      available: reason === undefined,
      ...(reason === undefined ? {} : { reason })
    };
  });
}

const UNOBSERVED_WEB_CAPABILITIES: WebBuildCapabilities = {
  folderAccess: false, browserStorage: false, connectionStorage: false
};

export function buildMetadata(target: BuildTarget, host: BuildHost = { platform: "unknown", arch: "unknown" }): BuildMetadata {
  return {
    target,
    version: typeof __BUILD_VERSION__ === "undefined" ? DEV_VERSION : __BUILD_VERSION__,
    commit: typeof __BUILD_COMMIT__ === "undefined" ? UNKNOWN_COMMIT : __BUILD_COMMIT__,
    schemaVersion: SCHEMA_VERSION,
    capabilities: capabilitiesFor(target, target === "web" ? host.webCapabilities ?? UNOBSERVED_WEB_CAPABILITIES : undefined),
    // Unsigned on every target until D-115 is accepted.
    signing: { status: "unsigned" },
    platform: host.platform,
    arch: host.arch
  };
}
