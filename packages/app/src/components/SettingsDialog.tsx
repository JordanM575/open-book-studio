import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Monitor, Moon, Sun, Trash2 } from "lucide-react";
import type { BuildMetadata } from "@ai-book-studio/core/build";
import { BROWSER_CREDENTIAL_DISCLOSURE } from "@ai-book-studio/core/providers/credentials";
import { OPENROUTER_KEYS_PAGE_URL } from "@ai-book-studio/core/providers/links";
import type { ConnectionSummary, CredentialStatus, ModelInfo, ProviderDescription, ProviderErrorCode, ProviderId } from "@ai-book-studio/core/providers/types";
import { providerStatus, type ProviderLastCheck } from "@ai-book-studio/core/providers/status";
import type { SyncSettings, VoicePreferences, VoiceSpeakers } from "@ai-book-studio/core/ipc";
import type { StorageSummary } from "@ai-book-studio/core/library/storage";
import { browserAvailabilityCopy } from "@ai-book-studio/core/providers/registry";
import { speechModels } from "@ai-book-studio/core/providers/speech";
import { ttsModels } from "@ai-book-studio/core/providers/tts";
import { Button } from "@ai-book-studio/ui/button";
import { Badge } from "@ai-book-studio/ui/components/badge";
import { NativeSelect, NativeSelectOption } from "@ai-book-studio/ui/components/native-select";
import { Dialog, DialogContent, DialogFooter } from "@ai-book-studio/ui/dialog";
import { SyncSection } from "./SyncSection";
import { OpenSourceLicenses } from "./LicensesDialog";
import { must } from "../lib/utils";
import type { ThemeChoice } from "../hooks/use-theme";

export type SettingsSection = "appearance" | "providers" | "library";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNotice: (error: unknown) => void;
  theme: { choice: ThemeChoice; set: (choice: ThemeChoice) => void };
  libraryRoot?: string;
  storage?: StorageSummary | undefined;
  deviceName?: string | null | undefined;
  /** Run a drift scan and report whether it found anything to review. */
  onCheckForChanges?: (() => Promise<{ dirty: boolean }>) | undefined;
  /** Open on a particular section; reconnect uses "providers". */
  section?: SettingsSection | undefined;
  /** Tell the workspace when a saved voice choice or connection may have changed. */
  onVoiceConfigurationChanged?: (() => void) | undefined;
}

const PROVIDER_ERROR_CODES: readonly ProviderErrorCode[] = [
  "auth",
  "permission",
  "rate-limit",
  "quota",
  "context",
  "refusal",
  "offline",
  "invalid-request",
  "not-found",
  "unsupported",
  "unknown"
];

/** Narrows a bridge error code to the provider vocabulary, without inventing a cause. */
function toProviderErrorCode(code: string): ProviderErrorCode {
  return PROVIDER_ERROR_CODES.includes(code as ProviderErrorCode) ? (code as ProviderErrorCode) : "unknown";
}

function checkedTime(checkedAt: string): string {
  return new Date(checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * One connection's health from the author's last explicit Test. The check time is volatile:
 * it exists only for this Settings session and Settings never probes on its own (D-161).
 */
function ConnectionStatusLine({ check }: { check: ProviderLastCheck | undefined }) {
  const status = providerStatus({ configured: true, lastCheck: check ?? null });
  return (
    <>
      <p className="mt-0.5 text-(length:--text-caption-size) text-muted-foreground" data-testid="connection-status">
        {/* No Test this session says nothing about the key, so it is not a warning (D-161). */}
        {check ? status.label : "Saved"}
        {status.checkedAt ? ` · checked ${checkedTime(status.checkedAt)}` : " · not checked yet"}
      </p>
      {check && status.state !== "connected" ? (
        <p className="mt-0.5 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground">
          {status.message}
        </p>
      ) : null}
    </>
  );
}

/**
 * Voice availability from configured capability only. Voice is never probed, so there is
 * no check time here — only whether dictation and read-aloud have a connection (D-161).
 */
function VoiceStatus({
  voice,
  preferences,
  connections
}: {
  voice: { speakers: VoiceSpeakers | null } | null;
  preferences: VoicePreferences | null;
  connections: ConnectionSummary[] | null;
}) {
  if (voice === null) {
    return (
      <p className="mt-2 text-(length:--text-subheadline-size) text-muted-foreground" data-testid="voice-status">
        Reading voice…
      </p>
    );
  }
  const output = voice.speakers?.available === true;
  const inputConnection = connections?.find((connection) => connection.id === preferences?.transcription.connectionId);
  const input = Boolean(inputConnection && speechModels(inputConnection.provider).some((choice) => choice.id === preferences?.transcription.model));
  const inputSelected = Boolean(preferences?.transcription.connectionId);
  return (
    <div data-testid="voice-status">
      <p className="mt-2 text-(length:--text-subheadline-size) text-muted-foreground">
        {voice.speakers?.unavailable
          ? "The selected speaking connection is unavailable or its model or voice is no longer supported."
          : output
          ? `Read-aloud is available${voice.speakers?.connectionLabel ? ` through ${voice.speakers.connectionLabel}` : ""}.`
          : "Read-aloud is not set up."}{" "}
        {input
          ? `Dictation is set to ${inputConnection?.label ?? "this connection"}.`
          : inputSelected
            ? "The selected transcription connection is unavailable or its model is no longer supported."
            : "Dictation is not set up."}
      </p>
      <p className="mt-1 text-(length:--text-caption-size) text-muted-foreground">
        Voice is never tested automatically, so there is no check time here.
      </p>
    </div>
  );
}

const THEMES: Array<{ id: ThemeChoice; label: string; icon: typeof Sun }> = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon }
];

export function SettingsDialog({ open, onOpenChange, onNotice, theme, libraryRoot, storage, deviceName, onCheckForChanges, section, onVoiceConfigurationChanged }: Props) {
  const [syncSettings, setSyncSettings] = useState<SyncSettings | null>(null);
  const [syncUnsupported, setSyncUnsupported] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSyncSettings(null);
    setSyncUnsupported(false);
    void (async () => {
      try {
        setSyncSettings(await must(window.studio.sync.settings()));
      } catch {
        // Shells without a scan interval (the browser build) hide the editor, not the section.
        setSyncUnsupported(true);
      }
    })();
  }, [open]);

  const saveSyncInterval = useCallback(
    async (minutes: number) => {
      setSyncBusy(true);
      try {
        setSyncSettings(await must(window.studio.sync.updateSettings({ checkIntervalMinutes: minutes })));
      } finally {
        setSyncBusy(false);
      }
    },
    []
  );

  const checkForChanges = useCallback(async () => {
    if (!onCheckForChanges) return { dirty: false };
    return onCheckForChanges();
  }, [onCheckForChanges]);
  const providersRef = useRef<HTMLElement>(null);
  const [liveStorage, setLiveStorage] = useState<StorageSummary | undefined>(storage);
  const [build, setBuild] = useState<BuildMetadata | null>(null);

  // The summary is a snapshot on LibraryInfo; ask the live library when the dialog opens so a
  // just-confirmed save shows its new time instead of the value from page load.
  useEffect(() => {
    if (!open) return;
    setLiveStorage(storage);
    void (async () => {
      try {
        const info = await window.studio.library.current();
        if (info.ok && info.data?.storage) setLiveStorage(info.data.storage);
      } catch {
        // Keep the passed summary; this only sharpens the displayed time.
      }
    })();
  }, [open, storage]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        setBuild(await must(window.studio.app.info()));
      } catch {
        setBuild(null);
      }
    })();
  }, [open]);

  useEffect(() => {
    if (!open || section !== "providers") return;
    // Radix mounts the content on open; wait one frame before scrolling inside it.
    const timer = window.setTimeout(() => {
      providersRef.current?.scrollIntoView({ block: "start" });
      providersRef.current?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [open, section]);
  const [providers, setProviders] = useState<ProviderDescription[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({});
  /** The author's last explicit Test per connection. Volatile: cleared whenever Settings opens. */
  const [checks, setChecks] = useState<Record<string, ProviderLastCheck>>({});
  const [voice, setVoice] = useState<{ speakers: VoiceSpeakers | null } | null>(null);
  const [voicePreferences, setVoicePreferences] = useState<VoicePreferences | null>(null);
  const [voicePreferencesSupported, setVoicePreferencesSupported] = useState(false);
  const [savingVoicePreferences, setSavingVoicePreferences] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState<boolean | null>(null);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [checkingKeychain, setCheckingKeychain] = useState(false);
  const [keyProvider, setKeyProvider] = useState<ProviderId>("openai");
  const [keySecret, setKeySecret] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [keyBaseUrl, setKeyBaseUrl] = useState("");
  const [addingKey, setAddingKey] = useState(false);
  const [keyResult, setKeyResult] = useState<string | null>(null);
  const transcriptionConnections = (connections ?? []).filter((connection) => speechModels(connection.provider).length > 0);
  const speakingConnections = (connections ?? []).filter((connection) => ttsModels(connection.provider).length > 0);
  const selectedTranscriptionConnection = connections?.find(
    (connection) => connection.id === voicePreferences?.transcription.connectionId
  );
  const selectedSpeakingConnection = connections?.find(
    (connection) => connection.id === voicePreferences?.speaking.connectionId
  );
  const transcriptionChoices = selectedTranscriptionConnection
    ? speechModels(selectedTranscriptionConnection.provider)
    : [];
  const speakingChoices = selectedSpeakingConnection
    ? ttsModels(selectedSpeakingConnection.provider)
    : [];
  const selectedSpeakingModel = speakingChoices.find((choice) => choice.id === voicePreferences?.speaking.model);

  const refresh = useCallback(async () => {
    // Check times are volatile: a fresh open forgets every previous explicit Test.
      setChecks({});
      setVoice(null);
      setVoicePreferences(null);
      setVoicePreferencesSupported(false);
    try {
      const [providerList, connectionList, status] = await Promise.all([
        must(window.studio.providers.list()),
        must(window.studio.connections.list()),
        must(window.studio.connections.status())
      ]);
      setProviders(providerList);
      setConnections(connectionList);
      setCredentialStatus(status);
      setStorageAvailable(status.available);
      // Voice availability is read, never probed: these calls inspect configured
      // capability and credential metadata, and carry no check time.
      try {
        if (window.studio.voice) {
          const speakers = await window.studio.voice.speakers();
          const settings = await window.studio.voice.settings();
          if (speakers.ok && settings.ok) {
            setVoice({ speakers: speakers.data });
            setVoicePreferences(settings.data);
            setVoicePreferencesSupported(true);
            return;
          }
        }
      } catch {
        // Voice stays "not set up" below when it cannot be read.
      }
      setVoice({ speakers: null });
    } catch (error) {
      onNotice(error);
      setConnections([]);
    }
  }, [onNotice]);

  const saveVoicePreferences = useCallback(async (preferences: VoicePreferences): Promise<void> => {
    setSavingVoicePreferences(true);
    try {
      setVoicePreferences(await must(window.studio.voice.updateSettings(preferences)));
      onVoiceConfigurationChanged?.();
      const currentSpeakers = await window.studio.voice.speakers();
      if (currentSpeakers.ok) {
        setVoice((current) => current ? { ...current, speakers: currentSpeakers.data } : current);
      }
    } catch (error) {
      onNotice(error);
    } finally {
      setSavingVoicePreferences(false);
    }
  }, [onNotice, onVoiceConfigurationChanged]);

  const checkKeychain = async (): Promise<void> => {
    setCheckingKeychain(true);
    try {
      const status = await must(window.studio.connections.check());
      setCredentialStatus(status);
      setStorageAvailable(status.available);
    } catch (error) {
      onNotice(error);
    } finally {
      setCheckingKeychain(false);
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const connect = async (): Promise<void> => {
    setWaiting(true);
    setResult((current) => ({ ...current, openrouter: "" }));
    try {
      await must(window.studio.connections.startOpenRouter());
      onVoiceConfigurationChanged?.();
      await refresh();
      setResult((current) => ({
        ...current,
        openrouter:
          build?.target === "web"
            ? "Connected. Your key is in this browser's origin storage."
            : "Connected. Your key is in this computer's protected storage."
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/cancel/i.test(message)) onNotice(error);
    } finally {
      setWaiting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    try {
      await must(window.studio.connections.cancelOpenRouter());
    } catch (error) {
      onNotice(error);
    } finally {
      setWaiting(false);
    }
  };

  const test = async (connection: ConnectionSummary): Promise<void> => {
    setBusy(connection.id);
    try {
      // Read the envelope directly so a failure keeps its structured provider code;
      // must() would discard it and leave only the message.
      const response = await window.studio.connections.test(connection.id);
      const checkedAt = new Date().toISOString();
      if (response.ok) {
        setChecks((current) => ({ ...current, [connection.id]: { status: "success", checkedAt } }));
        setResult((current) => ({ ...current, [connection.id]: response.data.message }));
      } else {
        setChecks((current) => ({
          ...current,
          [connection.id]: {
            status: "failure",
            checkedAt,
            error: { code: toProviderErrorCode(response.error.code), message: response.error.message }
          }
        }));
        setResult((current) => {
          const next = { ...current };
          delete next[connection.id];
          return next;
        });
      }
    } catch (error) {
      onNotice(error);
    } finally {
      setBusy(null);
    }
  };

  const loadModels = async (connection: ConnectionSummary): Promise<void> => {
    setBusy(connection.id);
    try {
      const catalogue = await must(window.studio.providers.models(connection.id));
      setModels((current) => ({ ...current, [connection.id]: catalogue.models }));
      setResult((current) => ({
        ...current,
        [connection.id]: `${catalogue.models.length} models available${catalogue.fetchedAt ? "" : ""}.`
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult((current) => ({ ...current, [connection.id]: message }));
    } finally {
      setBusy(null);
    }
  };

  const addKey = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const secret = keySecret.trim();
    if (secret.length < 8) return;
    setAddingKey(true);
    setKeyResult(null);
    try {
      const connection = await must(
        window.studio.connections.addKey({
          provider: keyProvider,
          secret,
          ...(keyLabel.trim() ? { label: keyLabel.trim() } : {}),
          ...(keyProvider === "meta" && keyBaseUrl.trim() ? { baseUrl: keyBaseUrl.trim() } : {})
        })
      );
      onVoiceConfigurationChanged?.();
      setKeySecret("");
      setKeyLabel("");
      setKeyBaseUrl("");
      setKeyResult(`${connection.label} added. The key was accepted and stored in protected storage.`);
      await refresh();
    } catch (error) {
      setKeyResult(error instanceof Error ? error.message : String(error));
    } finally {
      setAddingKey(false);
    }
  };

  /** FR-013: removing deletes the key here, but OpenRouter keeps its copy until the author revokes it. */
  const openOpenRouterKeys = async (): Promise<void> => {
    try {
      await must(window.studio.app.openLink(OPENROUTER_KEYS_PAGE_URL));
    } catch (error) {
      onNotice(error);
    }
  };

  const remove = async (connection: ConnectionSummary): Promise<void> => {    setBusy(connection.id);
    try {
      await must(window.studio.connections.remove(connection.id));
      onVoiceConfigurationChanged?.();
      setRemoving(null);
      await refresh();
    } catch (error) {
      onNotice(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!waiting) onOpenChange(next);
      }}
    >
      <DialogContent
        title="Settings"
        description="Appearance, provider connections, and where this library lives."
        className="w-[calc(100vw-48px)] max-w-[640px]"
        footer={
          <DialogFooter className="mt-0">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={waiting}>
              Done
            </Button>
          </DialogFooter>
        }
        onInteractOutside={(event) => {
          if (waiting) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (waiting) event.preventDefault();
        }}
      >
        <section>
          <h3 className="text-(length:--text-callout-size) font-medium">Appearance</h3>
          {/* biome-ignore lint/a11y/useSemanticElements: role="group" is the correct ARIA pattern here; a fieldset would inherit min-inline-size and border styles that change the picker layout */}
          <div className="mt-2 grid grid-cols-3 gap-2" role="group" aria-label="Theme">
            {THEMES.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                variant={theme.choice === id ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={theme.choice === id}
                onClick={() => theme.set(id)}
                data-testid={`theme-${id}`}
              >
                <Icon size={14} />
                {label}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground">
            System follows this computer's light or dark setting.
          </p>
        </section>

        <section ref={providersRef} tabIndex={-1} className="mt-6 outline-none">
          <h3 className="text-(length:--text-callout-size) font-medium">Provider connections</h3>
          <p className="mt-1 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground">
            {build?.target === "web"
              ? "Bring your own account. Keys are kept in this browser's origin storage, never in your book folder."
              : "Bring your own account. Keys are kept on this computer, never in your book folder."}
          </p>
          {credentialStatus ? (
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3 rounded-[var(--corner-lg)] border border-border bg-card/60 p-3">
              <div className="min-w-0">
                <p className="text-(length:--text-subheadline-size) font-medium">
                  {credentialStatus.available ? "Unlocked" : "Locked or unavailable"} · {credentialStatus.backend}
                </p>
                <p className="mt-0.5 text-(length:--text-caption-size) text-muted-foreground">
                  {credentialStatus.connections} {credentialStatus.connections === 1 ? "connection" : "connections"} · secrets are
                  encrypted before they reach the credential file.
                </p>
                {credentialStatus.detail ? (
                  <p className="mt-1 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-destructive-text">
                    {credentialStatus.detail}
                  </p>
                ) : null}
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => void checkKeychain()}
                disabled={checkingKeychain}
                data-testid="check-keychain"
              >
                {checkingKeychain ? <Loader2 size={13} className="animate-spin" /> : null}
                Check keychain
              </Button>
            </div>
          ) : null}
          <div className="mt-3 flex items-start justify-between gap-4 rounded-[var(--corner-lg)] border border-border bg-card/60 p-4">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-(length:--text-headline-size) font-semibold">
                <KeyRound size={16} />
                OpenRouter
              </h3>
              <p className="mt-1 text-(length:--text-subheadline-size) leading-[var(--text-subheadline-leading)] text-muted-foreground">
                One sign-in reaches models from many companies. You approve the key in your browser and can revoke it at
                OpenRouter at any time.
              </p>
              {result.openrouter ? (
                <p className="mt-2 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-success-text">
                  {result.openrouter}
                </p>
              ) : null}
              {storageAvailable === false ? (
                <p className="mt-2 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-destructive-text">
                  {build?.target === "web"
                    ? "Provider connections are not enabled in the browser build yet. When they are, credentials will live in this browser's origin storage, not the operating system keychain."
                    : "This computer's protected storage is locked, so a key cannot be saved. Unlock your keychain or keyring, then reopen this window."}
                </p>
              ) : null}
            </div>
            {waiting ? (
              <Button variant="secondary" size="sm" onClick={() => void cancel()}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                className="shrink-0"
                disabled={storageAvailable === false}
                onClick={() => void connect()}
              >
                Connect
              </Button>
            )}
          </div>
          {waiting ? (
            <p className="mt-2 flex items-center gap-2 text-(length:--text-subheadline-size) text-muted-foreground" aria-live="polite">
              <Loader2 size={14} className="animate-spin" />
              Finish signing in in your browser. This window will update on its own.
            </p>
          ) : null}
        </section>

        <section className="mt-6">
          <h3 className="text-(length:--text-callout-size) font-medium">Your connections</h3>
          {connections === null ? (
            <p className="mt-2 text-(length:--text-subheadline-size) text-muted-foreground">Reading connections…</p>
          ) : connections.length === 0 ? (
            <p className="mt-2 text-(length:--text-subheadline-size) leading-[var(--text-subheadline-leading)] text-muted-foreground">
              No connections yet. Connect OpenRouter above to use the writing agent.
            </p>
          ) : (
            <ul className="mt-2 space-y-3">
              {connections.map((connection) => (
                <li
                  key={connection.id}
                  className="rounded-[var(--corner-lg)] border border-border p-3.5"
                  data-testid="connection-card"
                  data-connection-id={connection.id}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-(length:--text-body-size) font-medium">{connection.label}</p>
                      <p className="mt-0.5 text-(length:--text-caption-size) text-muted-foreground">
                        {connection.kind === "openrouter-oauth" ? "Signed in with OpenRouter" : "API key"}
                        {connection.lastUsedAt ? ` · last used ${new Date(connection.lastUsedAt).toLocaleDateString()}` : ""}
                      </p>
                      <ConnectionStatusLine check={checks[connection.id]} />
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === connection.id}
                        onClick={() => void test(connection)}
                        data-testid="connection-test"
                      >
                        {busy === connection.id ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                        Test
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === connection.id}
                        onClick={() => void loadModels(connection)}
                        data-testid="connection-models"
                      >
                        Models
                      </Button>
                      {removing === connection.id ? (
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={busy === connection.id}
                          onClick={() => void remove(connection)}
                          aria-describedby={connection.provider === "openrouter" ? `revoke-${connection.id}` : undefined}
                          data-testid="connection-remove-confirm"
                        >
                          Remove
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${connection.label}`}
                          onClick={() => setRemoving(connection.id)}
                          data-testid="connection-remove"
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                  </div>
                  {removing === connection.id && connection.provider === "openrouter" ? (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2" data-testid="openrouter-revoke-note">
                      <p
                        id={`revoke-${connection.id}`}
                        className="min-w-0 flex-1 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground"
                      >
                        Remove deletes the key from {build?.target === "web" ? "this browser" : "this computer"}. The key also
                        exists in your OpenRouter account, where you can revoke it.
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={() => void openOpenRouterKeys()}
                        data-testid="openrouter-keys-link"
                      >
                        <ExternalLink size={13} />
                        Open OpenRouter keys
                      </Button>
                    </div>
                  ) : null}
                  {result[connection.id] ? (
                    <p className="mt-2 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground">
                      {result[connection.id]}
                    </p>
                  ) : null}
                  {models[connection.id]?.length ? (
                    <div className="thin-scroll mt-2 max-h-40 overflow-y-auto rounded-[var(--corner-md)] bg-muted/50 p-2">
                      {models[connection.id]!.slice(0, 30).map((model) => (
                        <p key={model.id} className="flex items-center justify-between gap-3 py-1 text-(length:--text-caption-size)">
                          <span className="truncate">{model.name}</span>
                          <span className="tabular shrink-0 text-muted-foreground">
                            {model.contextLength ? `${Math.round(model.contextLength / 1000)}k` : "—"}
                          </span>
                        </p>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-6" aria-label="Voice">
          <h3 className="text-(length:--text-callout-size) font-medium">Voice</h3>
          <VoiceStatus voice={voice} preferences={voicePreferences} connections={connections} />
          {build?.target === "web" ? (
            <p className="mt-2 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground">
              Provider transcription and speaking choices are available in the desktop app only. This build does not send voice requests to a provider.
            </p>
          ) : voicePreferencesSupported && voicePreferences ? (
            <div className="mt-3 space-y-4" data-testid="voice-preferences">
              <div className="space-y-2">
                <h4 className="text-(length:--text-subheadline-size) font-medium">Dictation</h4>
                <NativeSelect
                  aria-label="Transcription connection"
                  value={voicePreferences.transcription.connectionId ?? ""}
                  disabled={savingVoicePreferences}
                  onChange={(event) => {
                    const connectionId = event.currentTarget.value || null;
                    const selected = transcriptionConnections.find((connection) => connection.id === connectionId);
                    const model = selected ? speechModels(selected.provider)[0]?.id ?? null : null;
                    void saveVoicePreferences({
                      ...voicePreferences,
                      transcription: { connectionId, model }
                    });
                  }}
                >
                  <NativeSelectOption value="">Choose a connection</NativeSelectOption>
                  {voicePreferences.transcription.connectionId &&
                  !transcriptionConnections.some((connection) => connection.id === voicePreferences.transcription.connectionId) ? (
                    <NativeSelectOption value={voicePreferences.transcription.connectionId}>Saved connection unavailable</NativeSelectOption>
                  ) : null}
                  {transcriptionConnections.map((connection) => (
                    <NativeSelectOption key={connection.id} value={connection.id}>
                      {connection.label} · {connection.provider === "meta" ? "Meta" : "OpenRouter"}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label="Transcription model"
                  value={voicePreferences.transcription.model ?? ""}
                  disabled={savingVoicePreferences || !selectedTranscriptionConnection}
                  onChange={(event) => {
                    if (!selectedTranscriptionConnection) return;
                    void saveVoicePreferences({
                      ...voicePreferences,
                      transcription: { ...voicePreferences.transcription, model: event.currentTarget.value || null }
                    });
                  }}
                >
                  <NativeSelectOption value="">Choose a model</NativeSelectOption>
                  {voicePreferences.transcription.model && !transcriptionChoices.some((choice) => choice.id === voicePreferences.transcription.model) ? (
                    <NativeSelectOption value={voicePreferences.transcription.model}>Saved model unavailable</NativeSelectOption>
                  ) : null}
                  {transcriptionChoices.map((choice) => (
                    <NativeSelectOption key={choice.id} value={choice.id}>{choice.label}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>

              <div className="space-y-2">
                <h4 className="text-(length:--text-subheadline-size) font-medium">Read-aloud and agent replies</h4>
                <NativeSelect
                  aria-label="Speaking connection"
                  value={voicePreferences.speaking.connectionId ?? ""}
                  disabled={savingVoicePreferences}
                  onChange={(event) => {
                    const connectionId = event.currentTarget.value || null;
                    const selected = speakingConnections.find((connection) => connection.id === connectionId);
                    const model = selected ? ttsModels(selected.provider)[0] : undefined;
                    void saveVoicePreferences({
                      ...voicePreferences,
                      speaking: {
                        connectionId,
                        model: model?.id ?? null,
                        voice: model?.voices[0] ?? null
                      }
                    });
                  }}
                >
                  <NativeSelectOption value="">Choose a connection</NativeSelectOption>
                  {voicePreferences.speaking.connectionId &&
                  !speakingConnections.some((connection) => connection.id === voicePreferences.speaking.connectionId) ? (
                    <NativeSelectOption value={voicePreferences.speaking.connectionId}>Saved connection unavailable</NativeSelectOption>
                  ) : null}
                  {speakingConnections.map((connection) => (
                    <NativeSelectOption key={connection.id} value={connection.id}>
                      {connection.label} · {connection.provider === "openrouter" ? "OpenRouter" : "OpenAI"}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label="Speaking model"
                  value={voicePreferences.speaking.model ?? ""}
                  disabled={savingVoicePreferences || !selectedSpeakingConnection}
                  onChange={(event) => {
                    const model = speakingChoices.find((choice) => choice.id === event.currentTarget.value);
                    if (!model) return;
                    void saveVoicePreferences({
                      ...voicePreferences,
                      speaking: { ...voicePreferences.speaking, model: model.id, voice: model.voices[0] ?? null }
                    });
                  }}
                >
                  <NativeSelectOption value="">Choose a model</NativeSelectOption>
                  {voicePreferences.speaking.model && !speakingChoices.some((choice) => choice.id === voicePreferences.speaking.model) ? (
                    <NativeSelectOption value={voicePreferences.speaking.model}>Saved model unavailable</NativeSelectOption>
                  ) : null}
                  {speakingChoices.map((choice) => (
                    <NativeSelectOption key={choice.id} value={choice.id}>{choice.label}</NativeSelectOption>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label="Speaking voice"
                  value={voicePreferences.speaking.voice ?? ""}
                  disabled={savingVoicePreferences || !selectedSpeakingModel}
                  onChange={(event) => {
                    void saveVoicePreferences({
                      ...voicePreferences,
                      speaking: { ...voicePreferences.speaking, voice: event.currentTarget.value || null }
                    });
                  }}
                >
                  <NativeSelectOption value="">Choose a voice</NativeSelectOption>
                  {voicePreferences.speaking.voice && !selectedSpeakingModel?.voices.includes(voicePreferences.speaking.voice) ? (
                    <NativeSelectOption value={voicePreferences.speaking.voice}>Saved voice unavailable</NativeSelectOption>
                  ) : null}
                  {selectedSpeakingModel?.voices.map((choice) => (
                    <NativeSelectOption key={choice} value={choice}>{choice}</NativeSelectOption>
                  ))}
                </NativeSelect>
                <p className="text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground">
                  Choices are saved on this computer. Settings does not test a provider or send audio or text.
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-(length:--text-caption-size) text-muted-foreground">
              Voice choices are unavailable in this build.
            </p>
          )}
        </section>

        <section className="mt-6">
          <h3 className="text-(length:--text-callout-size) font-medium">Other providers</h3>
          <ul className="mt-2 divide-y divide-border rounded-[var(--corner-lg)] border border-border">
            {providers
              .filter((provider) => provider.id !== "openrouter")
              .map((provider) => (
                <li
                  key={provider.id}
                  className="flex flex-col items-start gap-2 p-3 min-[520px]:flex-row min-[520px]:justify-between min-[520px]:gap-4"
                >
                  <div className="min-w-0 min-[520px]:flex-1">
                    <p className="text-(length:--text-body-size) font-medium">{provider.name}</p>
                    <p className="mt-0.5 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground">
                      {provider.note}
                    </p>
                  </div>
                  <Badge
                    variant="muted"
                    className="h-auto max-w-full self-start px-2 py-1 text-left font-normal whitespace-normal min-[520px]:shrink-0"
                  >
                    {browserAvailabilityCopy(provider.browserAccess)}
                  </Badge>
                </li>
              ))}
          </ul>
          <p className="mt-2 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground">
            A key is checked once with the provider, then stored only on this computer. A rejected key is never saved.
          </p>
        </section>

        <section className="mt-6">
          <h3 className="text-(length:--text-callout-size) font-medium">Add a key</h3>
          <form className="mt-2 space-y-2" onSubmit={(event) => void addKey(event)}>
            <div className="flex flex-wrap gap-2">
              <NativeSelect
                aria-label="Provider"
                value={keyProvider}
                onChange={(event) => {
                  setKeyProvider(event.target.value as ProviderId);
                  setKeyResult(null);
                }}
              >
                {providers
                  .filter((provider) => provider.id !== "openrouter")
                  .map((provider) => (
                    <NativeSelectOption key={provider.id} value={provider.id}>
                      {provider.name}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
              <input
                aria-label="Connection label"
                value={keyLabel}
                onChange={(event) => setKeyLabel(event.target.value)}
                placeholder="Label (optional)"
                maxLength={80}
                className="h-9 min-w-0 flex-1 rounded-[var(--corner-md)] bg-card px-3 text-(length:--text-body-size) shadow-[inset_0_0_0_1px_var(--input-border),var(--elevation-1)] outline-none placeholder:text-muted-foreground focus:shadow-[inset_0_0_0_2px_var(--input-focus)]"
              />
            </div>
            {keyProvider === "meta" ? (
              <input
                aria-label="Meta base URL"
                value={keyBaseUrl}
                onChange={(event) => setKeyBaseUrl(event.target.value)}
                placeholder="Base URL from Meta's developer console"
                maxLength={500}
                className="h-9 w-full rounded-[var(--corner-md)] bg-card px-3 text-(length:--text-body-size) shadow-[inset_0_0_0_1px_var(--input-border),var(--elevation-1)] outline-none placeholder:text-muted-foreground focus:shadow-[inset_0_0_0_2px_var(--input-focus)]"
              />
            ) : null}
            <div className="flex gap-2">
              <input
                aria-label="API key"
                type="password"
                value={keySecret}
                onChange={(event) => setKeySecret(event.target.value)}
                placeholder="Paste the API key"
                autoComplete="off"
                spellCheck={false}
                className="h-9 min-w-0 flex-1 rounded-[var(--corner-md)] bg-card px-3 font-(family-name:--font-code) text-(length:--text-caption-size) shadow-[inset_0_0_0_1px_var(--input-border),var(--elevation-1)] outline-none placeholder:font-(family-name:--font-ui) placeholder:text-muted-foreground focus:shadow-[inset_0_0_0_2px_var(--input-focus)]"
              />
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={
                  addingKey ||
                  storageAvailable === false ||
                  keySecret.trim().length < 8 ||
                  (keyProvider === "meta" && !keyBaseUrl.trim())
                }
              >
                {addingKey ? <Loader2 size={13} className="animate-spin" /> : null}
                Add connection
              </Button>
            </div>
          </form>
          {keyResult ? (
            <p className="mt-2 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground" aria-live="polite">
              {keyResult}
            </p>
          ) : null}
        </section>

        <section className="mt-6">
          <h3 className="text-(length:--text-callout-size) font-medium">Library</h3>
          <p className="mt-1 text-(length:--text-subheadline-size) leading-[var(--text-subheadline-leading)] text-muted-foreground">
            Each book is a folder: <span className="font-mono">book.json</span> for the idea and cast,{" "}
            <span className="font-mono">chapters/*.md</span> for the prose. Open them in any editor.
          </p>
          {libraryRoot ? (
            <p className="mt-2 truncate rounded-[var(--corner-md)] bg-[var(--secondary)] px-3 py-2 font-mono text-[11px] text-muted-foreground" title={libraryRoot}>
              {libraryRoot}
            </p>
          ) : null}
          {liveStorage ? (
            <>
              <dl className="mt-3 space-y-1 text-(length:--text-caption-size)" data-testid="storage-summary">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Storage</dt>
                  <dd>{liveStorage.tier === "browser" ? "This browser" : liveStorage.label}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Last confirmed save</dt>
                  <dd>{liveStorage.lastCommittedAt ? new Date(liveStorage.lastCommittedAt).toLocaleString() : "None yet"}</dd>
                </div>
                {liveStorage.permission !== "granted" ? (
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="text-muted-foreground">Permission</dt>
                    <dd>{liveStorage.permission}</dd>
                  </div>
                ) : null}
              </dl>
              {liveStorage.warning ? (
                <p className="mt-2 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-[var(--destructive-text)]">
                  {liveStorage.warning}
                </p>
              ) : null}
            </>
          ) : null}
          <SyncSection
            deviceName={deviceName}
            settings={syncSettings}
            unsupported={syncUnsupported}
            busy={syncBusy}
            onSaveInterval={saveSyncInterval}
            onCheck={checkForChanges}
            onCloseSettings={() => onOpenChange(false)}
            onNotice={onNotice}
          />
        </section>

        <section className="mt-6" data-testid="about">
          <h3 className="text-(length:--text-callout-size) font-medium">About</h3>
          <p className="mt-1 text-(length:--text-subheadline-size) leading-[var(--text-subheadline-leading)] text-muted-foreground">
            Private preview. The manuscript stays a folder of ordinary files; this build never uploads it.
          </p>
          {build ? (
            <>
              <dl className="mt-3 space-y-1 text-(length:--text-caption-size)">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Build</dt>
                  <dd>{build.target === "desktop" ? "Desktop" : "Web"}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Signing</dt>
                  <dd>{build.signing.status === "signed" ? `Signed — ${build.signing.identity ?? "unknown identity"}` : "Unsigned"}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Version</dt>
                  <dd>{build.version}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Commit</dt>
                  <dd className="font-mono">{build.commit}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Format</dt>
                  <dd>{build.schemaVersion}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Platform</dt>
                  <dd>{window.studio.platform}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Architecture</dt>
                  <dd>{build.arch === "unknown" ? "Unknown" : build.arch}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Storage</dt>
                  <dd>
                    {liveStorage
                      ? liveStorage.tier === "browser"
                        ? "Browser storage"
                        : liveStorage.label
                      : libraryRoot
                        ? "A folder on this computer"
                        : "No library open"}
                  </dd>
                </div>
              </dl>
              {build.target === "web" ? (
                <p
                  className="mt-3 rounded-[var(--corner-md)] bg-[var(--secondary)] px-3 py-2 text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground"
                  data-testid="browser-credential-disclosure"
                >
                  {BROWSER_CREDENTIAL_DISCLOSURE}
                </p>
              ) : null}
              <ul className="mt-3 space-y-1.5 text-(length:--text-caption-size)" aria-label="Capabilities">
                {build.capabilities.map((capability) => (
                  <li key={capability.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className={capability.available ? "text-success-text" : "text-muted-foreground"}>
                      {capability.available ? "Available" : "Not available"}
                    </span>
                    <span>{capability.label}</span>
                    {!capability.available && capability.reason ? (
                      <span className="text-muted-foreground">— {capability.reason}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-2 text-(length:--text-caption-size) text-muted-foreground">
              Build information is not available.
            </p>
          )}
          <div className="mt-3">
            <OpenSourceLicenses />
          </div>
        </section>

      </DialogContent>
    </Dialog>
  );
}
