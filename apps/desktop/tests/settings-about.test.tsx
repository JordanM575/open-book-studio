/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { mountDom, unmountDom } from "./support/dom";
import { buildMetadata } from "@ai-book-studio/core/build";
import type { BuildMetadata } from "@ai-book-studio/core/build";
import type { Result } from "@ai-book-studio/core/ipc";
import type { ConnectionSummary, CredentialStatus } from "@ai-book-studio/core/providers/types";
import type { StorageSummary } from "@ai-book-studio/core/library/storage";

let testing!: typeof import("@testing-library/react/pure");
let SettingsDialog!: typeof import("@ai-book-studio/app/components/SettingsDialog").SettingsDialog;

beforeAll(async () => {
  testing = await mountDom();
  ({ SettingsDialog } = await import("@ai-book-studio/app/components/SettingsDialog"));
});
afterAll(async () => {
  await unmountDom();
});

afterEach(() => testing.cleanup());

/**
 * Spec 009 T002: the unsigned path identifies itself in About. The dialog reads
 * the real build metadata shape, so the row the tester sees is the status the
 * app reports — not a hard-coded label.
 */
function mockStudio(info: Result<BuildMetadata>, connectionStorageAvailable = false) {
  const platform = info.ok ? info.data.platform : "web";
  const studio = {
    platform,
    providers: { list: mock(async () => ({ ok: true, data: [] })) },
    connections: {
      list: mock(async (): Promise<Result<ConnectionSummary[]>> => ({ ok: true, data: [] })),
      status: mock(async (): Promise<Result<CredentialStatus>> => ({
        ok: true,
        data: {
          available: connectionStorageAvailable,
          backend: platform === "web" ? "Browser origin storage" : "Protected storage",
          detail: "",
          connections: 0
        }
      })),
      startOpenRouter: mock(async () => ({ ok: true, data: null })),
      test: mock(async () => ({ ok: true, data: { message: "Synthetic." } }))
    },
    library: { current: mock(async () => ({ ok: true, data: null })) },
    app: { info: mock(async () => info) },
    voice: {
      connections: mock(async () => ({ ok: true, data: [] })),
      speakers: mock(async () => ({
        ok: true,
        data: { available: false, connectionLabel: null, endpoint: null, model: null, voices: [] }
      }))
    }
  };
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = studio;
  return studio;
}

function renderSettings(libraryRoot?: string, storage?: StorageSummary) {
  testing.render(
    React.createElement(SettingsDialog, {
      open: true,
      onOpenChange: () => {},
      onNotice: () => {},
      theme: { choice: "light" as const, set: () => {} },
      ...(libraryRoot ? { libraryRoot } : {}),
      storage
    })
  );
}

describe("About signing status", () => {
  test("an unsigned build says Unsigned in About", async () => {
    mockStudio({ ok: true, data: buildMetadata("desktop", { platform: "darwin", arch: "arm64" }) });
    renderSettings();
    const view = testing.within(document.body);
    await testing.waitFor(
      () => {
        expect(view.getByTestId("about")).toBeTruthy();
      },
      { timeout: 2000 }
    );
    const about = view.getByTestId("about");
    expect(about.textContent).toContain("Signing");
    expect(about.textContent).toContain("Unsigned");
    expect(about.textContent).toContain("0.0.0-dev");
    expect(about.textContent).toContain("Architecture");
    expect(about.textContent).toContain("arm64");
  });

  test("with a library open but no storage summary yet, About does not say no library is open", async () => {
    mockStudio({ ok: true, data: buildMetadata("desktop", { platform: "darwin", arch: "arm64" }) });
    renderSettings("/tmp/studio-library");
    const view = testing.within(document.body);
    await testing.waitFor(() => expect(view.getByTestId("about").textContent).toContain("Storage"), { timeout: 2000 });
    expect(view.getByTestId("about").textContent).toContain("A folder on this computer");
    expect(view.getByTestId("about").textContent).not.toContain("No library open");
  });

  test("an undetectable architecture is labelled Unknown, never verified", async () => {
    mockStudio({ ok: true, data: buildMetadata("web", { platform: "web", arch: "unknown" }) });
    renderSettings();
    const view = testing.within(document.body);
    await testing.waitFor(
      () => {
        expect(view.getByTestId("about").textContent ?? "").toContain("Architecture");
      },
      { timeout: 2000 }
    );
    const about = view.getByTestId("about");
    expect(about.textContent).toContain("Unknown");
    expect(about.textContent).not.toContain("arm64");
  });

  test("shows the active browser tier and distinguishes browser capabilities from the desktop check interval", async () => {
    mockStudio({ ok: true, data: buildMetadata("web", {
      platform: "web",
      arch: "unknown",
      webCapabilities: { folderAccess: false, browserStorage: true, connectionStorage: true }
    }) }, true);
    renderSettings("browser://library_synthetic", {
      tier: "browser", label: "This browser", permission: "granted", persistence: "not-granted",
      warning: null, lastCommittedAt: null
    });
    const view = testing.within(document.body);
    await testing.waitFor(() => expect(view.getByTestId("about")).toBeTruthy());
    const about = testing.within(view.getByTestId("about"));
    const capabilityList = testing.within(about.getByRole("list", { name: "Capabilities" }));
    const row = (label: string) => capabilityList.getByText(label, { exact: true }).closest("li")?.textContent;
    expect(row("Folder library")).toContain("Not available");
    expect(row("Folder library")).toContain("browser folder picker");
    expect(row("Provider connection storage")).toContain("Available");
    expect(row("Manual sync drift review")).toContain("Available");
    expect(row("Drift check interval")).toContain("Not available");
    expect(about.getAllByText("Browser storage", { exact: true })).toHaveLength(2);
    expect(view.getByRole("button", { name: "Check browser storage" })).toBeTruthy();
    expect(view.queryByText(/encrypted before they reach/)).toBeNull();
  });

  test("disables the browser connection action when the host lacks connection storage", async () => {
    mockStudio({ ok: true, data: buildMetadata("web", { platform: "web", arch: "unknown" }) });
    renderSettings();
    const view = testing.within(document.body);
    await testing.waitFor(() => expect(view.getByTestId("about")).toBeTruthy());
    const connect = view.getByRole("button", { name: /^Connect$/ }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    expect(view.getAllByText(/Allow site storage or use the desktop app/)).toHaveLength(2);
  });

  test("keeps browser sign-in disabled while live storage is pending or refused", async () => {
    const studio = mockStudio({ ok: true, data: buildMetadata("web", {
      platform: "web", arch: "unknown", webCapabilities: { folderAccess: true, browserStorage: true, connectionStorage: true }
    }) });
    const status = Promise.withResolvers<Result<CredentialStatus>>();
    studio.connections.status.mockImplementation(() => status.promise);
    studio.connections.list.mockImplementation(async () => ({ ok: false, error: { code: "io", message: "Denied" } }));
    renderSettings();
    const view = testing.within(document.body);
    const connect = view.getByRole("button", { name: /^Connect$/ }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    testing.fireEvent.click(connect);
    status.resolve({ ok: true, data: { available: false, backend: "Browser origin storage", detail: "Allow site data and reload.", connections: 0 } });
    await testing.waitFor(() => expect(view.getByText("Allow site data and reload.")).toBeTruthy());
    expect(connect.disabled).toBe(true);
    testing.fireEvent.click(connect);
    expect(studio.connections.startOpenRouter).not.toHaveBeenCalled();
  });

  test("uses the browser storage confirmation when About metadata cannot load", async () => {
    const studio = mockStudio({ ok: false, error: { code: "io", message: "Unavailable metadata" } }, true);
    renderSettings();
    const view = testing.within(document.body);
    const connect = view.getByRole("button", { name: /^Connect$/ }) as HTMLButtonElement;
    await testing.waitFor(() => expect(connect.disabled).toBe(false));
    expect(view.getByTestId("browser-credential-disclosure").textContent).toContain("Same-origin");
    expect(view.getByTestId("browser-credential-disclosure").textContent).toContain("keychain");
    testing.fireEvent.click(connect);
    await testing.waitFor(() => expect(view.getByText("Connected. Your key is in this browser's origin storage.")).toBeTruthy());
    expect(studio.connections.startOpenRouter).toHaveBeenCalledTimes(1);
  });

  test("keeps Connect disabled for a new visit while its own storage read is pending", async () => {
    const studio = mockStudio({ ok: false, error: { code: "io", message: "Unavailable metadata" } });
    const oldRead = Promise.withResolvers<Result<CredentialStatus>>();
    const currentRead = Promise.withResolvers<Result<CredentialStatus>>();
    studio.connections.status.mockImplementationOnce(() => oldRead.promise).mockImplementationOnce(() => currentRead.promise);
    const props = { onOpenChange: () => {}, onNotice: () => {}, theme: { choice: "light" as const, set: () => {} } };
    const dialog = testing.render(React.createElement(SettingsDialog, { open: true, ...props }));
    await testing.waitFor(() => expect(studio.connections.status).toHaveBeenCalledTimes(1));
    dialog.rerender(React.createElement(SettingsDialog, { open: false, ...props }));
    oldRead.resolve({ ok: true, data: { available: true, backend: "Browser origin storage", detail: "", connections: 0 } });
    await oldRead.promise;
    dialog.rerender(React.createElement(SettingsDialog, { open: true, ...props }));
    await testing.waitFor(() => expect(studio.connections.status).toHaveBeenCalledTimes(2));
    const view = testing.within(document.body);
    const connect = view.getByRole("button", { name: /^Connect$/ }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    currentRead.resolve({ ok: true, data: { available: false, backend: "Browser origin storage", detail: "Write refused", connections: 0 } });
    await testing.waitFor(() => expect(view.getByText("Write refused")).toBeTruthy());
    expect(connect.disabled).toBe(true);
    expect(studio.connections.startOpenRouter).not.toHaveBeenCalled();
  });

  test("a signed build would name its identity instead", async () => {
    const signed: BuildMetadata = { ...buildMetadata("desktop"), signing: { status: "signed", identity: "Developer ID Application: Example" } };
    mockStudio({ ok: true, data: signed });
    renderSettings();
    const view = testing.within(document.body);
    await testing.waitFor(
      () => {
        expect(view.getByTestId("about").textContent ?? "").toContain("Signing");
      },
      { timeout: 2000 }
    );
    expect(view.getByTestId("about").textContent).toContain("Signed — Developer ID Application: Example");
  });
});
