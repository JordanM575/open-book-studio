import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import type { BookMeta } from "@ai-book-studio/core/schema";
import type { ConnectionSummary, ModelInfo, ProviderDescription, ProviderId } from "@ai-book-studio/core/providers/types";
import { canRunAgent, unavailableReason, type Catalogue } from "@ai-book-studio/core/providers/models";
import { contributorWarning, isContributorModel } from "@ai-book-studio/core/providers/compatibility";
import { Button } from "@ai-book-studio/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@ai-book-studio/ui/dialog";
import { editBook, keptCopyText, must } from "../lib/utils";
import type { PreviewCatalogueCache } from "../lib/task-preview-cache";

/** An author-chosen candidate handed from the task preview to the one-turn picker. */
export interface TurnHandoff {
  provider: ProviderId;
  modelId: string;
  /** The sole usable connection, or null when the author must choose between several. */
  connectionId: string | null;
}

interface Props {
  open: boolean;
  book: BookMeta;
  onClose: () => void;
  /** Save the book default. Omit when choosing a one-off model. */
  onSaved?: ((book: BookMeta) => void) | undefined;
  /** Choose a model for the next turn only. Omit when saving the book default. */
  onPick?: ((choice: { connectionId: string; modelId: string }) => void) | undefined;
  /** The current one-off choice when the turn picker is reopened. */
  initial?: { connectionId: string; modelId: string } | null;
  /** Seed for an author-chosen candidate from the task preview. Only passed in turn mode. */
  handoff?: TurnHandoff | undefined;
  /** Emits the catalogues this picker loaded, after each explicit load, for the preview snapshot. */
  onCataloguesLoaded?: ((snapshot: PreviewCatalogueCache) => void) | undefined;
  /** Open Settings on the provider connections, so an author with no key is not stuck. */
  onOpenSettings?: (() => void) | undefined;
  /** A copy of the author's choice was kept, so the workspace lists the book's conflict copies again. */
  onConflictCopy?: (() => void) | undefined;
}

export function ModelPickerDialog({ open, book, onClose, onSaved, onPick, initial, handoff, onCataloguesLoaded, onOpenSettings, onConflictCopy }: Props) {
  const turnMode = Boolean(onPick);
  const initialConnectionId = initial?.connectionId ?? book.defaultConnectionId;
  const initialModelId = initial?.modelId ?? book.defaultModelId;
  const [providers, setProviders] = useState<ProviderDescription[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(initialConnectionId);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<string | null>(initialModelId);
  const [allowContributor, setAllowContributor] = useState(book.allowContributorTraining);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The connection's own list could not be read, so the hand-entry path opens by itself (FR-007). */
  const [listFailed, setListFailed] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualId, setManualId] = useState("");
  const [checking, setChecking] = useState(false);
  const [manualResult, setManualResult] = useState<{ error: boolean; text: string } | null>(null);
  const manualInput = useRef<HTMLInputElement>(null);
  const manualInputId = useId();
  // Handoff seed for the provider filter and the post-load candidate check. A ref so the load
  // callbacks read the current seed without being re-created on every render.
  const handoffRef = useRef(handoff);
  handoffRef.current = handoff;
  // While a handoff is re-resolving its connection, the catalogue load waits for that list.
  const handoffPendingRef = useRef(false);
  const connectionsRef = useRef<ConnectionSummary[]>([]);
  const cataloguesRef = useRef(new Map<string, Catalogue>());
  const onCataloguesLoadedRef = useRef(onCataloguesLoaded);
  onCataloguesLoadedRef.current = onCataloguesLoaded;
  // Handoff mode needs to know when the connection list has settled before it can say "no usable connection".
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  // A model id only matters to the writing agent, which the browser build does not run.
  const manualAllowed = window.studio.platform !== "web";

  const emitCatalogues = useCallback((list: ConnectionSummary[]) => {
    onCataloguesLoadedRef.current?.({
      connections: list,
      loads: [...cataloguesRef.current].map(([connectionId, catalogue]) => ({ connectionId, catalogue }))
    });
  }, []);

  const loadConnections = useCallback(async () => {
    setError(null);
    try {
      const [providerList, connectionList] = await Promise.all([
        must(window.studio.providers.list()),
        must(window.studio.connections.list())
      ]);
      setProviders(providerList);
      setConnections(connectionList);
      connectionsRef.current = connectionList;
      setConnectionsLoaded(true);
      handoffPendingRef.current = false;
      setConnectionId((current) => {
        const seed = handoffRef.current;
        if (seed) {
          const usable = connectionList.filter((connection) => connection.provider === seed.provider && connection.planUsable !== false);
          if (current && usable.some((connection) => connection.id === current)) return current;
          return usable.length === 1 && usable[0] ? usable[0].id : null;
        }
        if (current && connectionList.some((connection) => connection.id === current)) return current;
        const saved = connectionList.find((connection) => connection.id === initialConnectionId);
        return saved?.id ?? connectionList[0]?.id ?? null;
      });
      emitCatalogues(connectionList);
    } catch (cause) {
      setConnectionsLoaded(true);
      handoffPendingRef.current = false;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [initialConnectionId, emitCatalogues]);

  useEffect(() => {
    if (!open) return;
    // A handoff starts with no selection until the connection and the candidate are verified.
    const seed = handoffRef.current;
    handoffPendingRef.current = Boolean(seed);
    setConnectionId(seed ? null : initialConnectionId);
    setChosen(seed ? null : initialModelId);
    setAllowContributor(book.allowContributorTraining);
    setSearch("");
    setManualOpen(false);
    setManualId("");
    setManualResult(null);
    void loadConnections();
  }, [open, initialConnectionId, initialModelId, book.allowContributorTraining, loadConnections]);

  const loadModels = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setListFailed(false);
    setModels([]);
    try {
      const catalogue = await must(window.studio.providers.models(id));
      setModels(catalogue.models);
      cataloguesRef.current.set(id, catalogue);
      emitCatalogues(connectionsRef.current);
      if (catalogue.listError) {
        setError(catalogue.listError);
        setListFailed(true);
      }
      const seed = handoffRef.current;
      if (seed) {
        const found = catalogue.models.find((model) => model.id === seed.modelId) ?? null;
        if (found && canRunAgent(found)) {
          setChosen(found.id);
        } else {
          setChosen(null);
          const reason = unavailableReason(found) ?? "This model is no longer in the provider's list.";
          setError(`${reason} Nothing has changed.`);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setListFailed(true);
    } finally {
      setLoading(false);
    }
  }, [emitCatalogues]);

  useEffect(() => {
    if (!open || !connectionId || handoffPendingRef.current) return;
    void loadModels(connectionId);
  }, [open, connectionId, loadModels]);

  const savedModelMissing =
    !handoff &&
    !loading &&
    models.length > 0 &&
    connectionId === initialConnectionId &&
    initialModelId !== null &&
    !models.some((model) => model.id === initialModelId);

  useEffect(() => {
    if (savedModelMissing) setChosen(null);
  }, [savedModelMissing]);

  // Handoff mode lists only the provider's usable connections, in their existing order.
  const handoffConnections = handoff
    ? connections.filter((item) => item.provider === handoff.provider && item.planUsable !== false)
    : null;
  const visibleConnections = handoffConnections ?? connections;
  const providerName = (id: ConnectionSummary["provider"]) => providers.find((provider) => provider.id === id)?.name ?? id;
  const connection = connections.find((item) => item.id === connectionId) ?? null;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const sorted = [...models].sort((a, b) => Number(canRunAgent(b)) - Number(canRunAgent(a)) || a.name.localeCompare(b.name));
    return query ? sorted.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query)) : sorted;
  }, [models, search]);
  const chosenModel = models.find((model) => model.id === chosen) ?? null;
  const contributor = isContributorModel(chosenModel);
  const warning = contributorWarning(chosenModel);
  const manualVisible = manualAllowed && connection !== null && (manualOpen || listFailed);

  useEffect(() => {
    if (manualOpen) manualInput.current?.focus();
  }, [manualOpen]);

  const addManual = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const id = manualId.trim();
    if (!connection || !id || checking) return;
    setManualResult(null);
    const listed = models.find((model) => model.id === id);
    if (listed) {
      if (canRunAgent(listed)) setChosen(listed.id);
      setManualResult({ error: false, text: "This connection already lists that model, so nothing was sent." });
      return;
    }
    setChecking(true);
    try {
      const model = await must(window.studio.providers.addModel(connection.id, id));
      setModels((current) => [...current.filter((item) => item.id !== model.id), model]);
      setManualId("");
      setSearch("");
      const reason = unavailableReason(model);
      if (canRunAgent(model)) setChosen(model.id);
      setManualResult({
        error: false,
        text: `${model.name} answered, so it is saved on ${connection.label}.${
          canRunAgent(model) || !reason ? "" : ` The writing agent cannot use it yet. ${reason}`
        }`
      });
    } catch (cause) {
      setManualResult({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setChecking(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!connection || !chosen || saving) return;
    if (handoff) {
      // Revalidation on confirmation: the connection must still be present and usable, and the
      // chosen model still listed and able to run the agent. Otherwise nothing is picked.
      const current = connections.find((item) => item.id === connection.id) ?? null;
      const usable = current !== null && current.provider === handoff.provider && current.planUsable !== false;
      if (!usable) {
        const forProvider = connections.filter((item) => item.provider === handoff.provider);
        const base =
          forProvider.length > 0 && forProvider.every((item) => item.planUsable === false)
            ? "The saved plan cannot be used right now."
            : `No connection for ${providerName(handoff.provider)} yet.`;
        setError(`${base} Nothing has changed.`);
        return;
      }
      const chosenModel = models.find((model) => model.id === chosen) ?? null;
      if (!chosenModel || !canRunAgent(chosenModel)) {
        setError(`${unavailableReason(chosenModel) ?? "This model is no longer in the provider's list."} Nothing has changed.`);
        return;
      }
    }
    if (contributor && !allowContributor) return;
    if (onPick) {
      if (contributor && !book.allowContributorTraining) {
        setSaving(true);
        setError(null);
        try {
          await must(window.studio.books.update(book.id, { allowContributorTraining: true }));
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setSaving(false);
          return;
        }
        setSaving(false);
      }
      onPick({ connectionId: connection.id, modelId: chosen });
      onClose();
      return;
    }
    if (!onSaved) return;
    setSaving(true);
    setError(null);
    try {
      // Only the choices that changed are sent, so a consent changed elsewhere is never put back.
      const result = await editBook(book, {
        defaultProvider: connection.provider,
        defaultConnectionId: connection.id,
        defaultModelId: chosen,
        allowContributorTraining: contributor ? allowContributor : book.allowContributorTraining
      });
      onSaved(result.book);
      if (result.status === "conflict") {
        onConflictCopy?.();
        return setError(keptCopyText());
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={turnMode ? "Model for this turn" : "Model for this book"}
        description={
          turnMode
            ? "Use this model for the next message only. The book default stays the same."
            : "The writing agent uses this model until you change it."
        }
        className="w-[calc(100vw-48px)] max-w-[600px]"
      >
        {handoff && !connectionsLoaded ? (
          <p className="flex items-center gap-2 py-6 text-(length:--text-subheadline-size) text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Loading connections…
          </p>
        ) : handoff && (handoffConnections?.length ?? 0) === 0 ? (
          <div className="py-6">
            <p className="text-(length:--text-subheadline-size) leading-[var(--text-subheadline-leading)] text-muted-foreground">
              No usable connection is available for this model. Nothing has changed.
            </p>
          </div>
        ) : connections.length === 0 ? (
          <div className="py-6">
            <p className="text-(length:--text-subheadline-size) leading-[var(--text-subheadline-leading)] text-muted-foreground">
              No provider is connected yet. Add a key in Settings to choose a model.
            </p>
            {onOpenSettings ? (
              <Button variant="secondary" className="mt-4" onClick={onOpenSettings} data-testid="open-provider-settings">
                Open Settings
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-(length:--text-caption-size) font-medium text-muted-foreground">Connection</p>
              <div className="flex flex-wrap gap-2">
                {visibleConnections.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setConnectionId(item.id);
                      setChosen(null);
                      setManualOpen(false);
                      setManualId("");
                      setManualResult(null);
                    }}
                    className={`rounded-[var(--corner-md)] border px-3 py-2 text-left text-(length:--text-subheadline-size) transition-colors ${
                      item.id === connectionId
                        ? "border-[var(--ring)] bg-[var(--accent)]"
                        : "border-[var(--border)] hover:bg-[var(--accent)]"
                    }`}
                  >
                    <span className="block font-medium">{item.label}</span>
                    <span className="block text-(length:--text-caption-size) text-muted-foreground">{providerName(item.provider)}</span>
                    {item.id === book.defaultConnectionId || (turnMode && initial && item.id === initial.connectionId) ? (
                      <span className="block text-(length:--text-caption-size) text-muted-foreground" data-testid="connection-active">
                        {item.id === book.defaultConnectionId ? "Book default" : "This turn"}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>

            {savedModelMissing ? (
              <p className="rounded-[var(--corner-md)] border border-[var(--border)] bg-[var(--accent)] px-3 py-2 text-(length:--text-subheadline-size) text-muted-foreground">
                The {turnMode ? "chosen" : "saved"} model is no longer offered on this connection. Choose
                another before you write.
              </p>
            ) : null}

            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search models"
                aria-label="Search models"
                className="w-full rounded-[var(--corner-md)] border border-[var(--input)] bg-[var(--card)] py-2 pl-9 pr-3 text-(length:--text-subheadline-size) outline-none focus-visible:border-[var(--ring)]"
              />
            </div>

            <div className="thin-scroll max-h-[320px] space-y-1 overflow-y-auto rounded-[var(--corner-lg)] border border-[var(--border)] p-1">
              {loading ? (
                <p className="flex items-center gap-2 p-4 text-(length:--text-subheadline-size) text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> Loading models…
                </p>
              ) : filtered.length === 0 ? (
                <p className="p-4 text-(length:--text-subheadline-size) text-muted-foreground">No models match that search.</p>
              ) : (
                filtered.map((model) => {
                  const usable = canRunAgent(model);
                  const reason = unavailableReason(model);
                  return (
                    <button
                      key={model.id}
                      type="button"
                      disabled={!usable}
                      onClick={() => setChosen(model.id)}
                      className={`flex w-full items-start justify-between gap-3 rounded-[var(--corner-sm)] px-3 py-2 text-left transition-colors ${
                        model.id === chosen ? "bg-[var(--accent)]" : usable ? "hover:bg-[var(--accent)]" : "opacity-60"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-(length:--text-subheadline-size) font-medium">{model.name}</span>
                        {model.manual ? (
                          <span className="block text-(length:--text-caption-size) text-muted-foreground" data-testid="model-manual">
                            Entered by hand
                          </span>
                        ) : null}
                        <span className="tabular block text-(length:--text-caption-size) text-muted-foreground">
                          {model.contextLength ? `${Math.round(model.contextLength / 1000)}k context` : "Context not reported"}
                          {" · "}
                          {model.inputPricePerMillion === null
                            ? "Price not reported"
                            : `$${model.inputPricePerMillion.toFixed(2)} in · $${(model.outputPricePerMillion ?? 0).toFixed(2)} out per million`}
                        </span>
                        <span className="block text-(length:--text-caption-size) text-muted-foreground">
                          {model.supportsTools === null
                            ? "Tools not reported"
                            : model.supportsTools
                              ? "Uses tools"
                              : "No tools"}
                          {" · "}
                          {model.supportsImages === null
                            ? "Pictures not reported"
                            : model.supportsImages
                              ? "Reads pictures"
                              : "No pictures"}
                        </span>
                        {model.trainingOnData ? (
                          <span className="block text-(length:--text-caption-size) text-muted-foreground">
                            Contributor · Meta may train on this content
                          </span>
                        ) : null}
                        {!usable && reason ? (
                          <span className="block text-(length:--text-caption-size) text-destructive-text">{reason}</span>
                        ) : null}
                      </span>
                      {model.id === chosen ? <Check size={16} className="mt-0.5 shrink-0 text-[var(--primary)]" aria-hidden /> : null}
                    </button>
                  );
                })
              )}
            </div>

            {error ? (
              <p className="text-(length:--text-subheadline-size) text-destructive-text" role="alert">
                {error}
              </p>
            ) : null}

            {manualVisible ? (
              <form
                className="space-y-2 rounded-[var(--corner-lg)] border border-[var(--border)] p-3"
                onSubmit={(event) => void addManual(event)}
                data-testid="manual-model"
              >
                <label htmlFor={manualInputId} className="block text-(length:--text-caption-size) font-medium text-muted-foreground">
                  Model id
                </label>
                <p className="text-(length:--text-caption-size) leading-[var(--text-caption-leading)] text-muted-foreground">
                  {listFailed
                    ? "This connection's model list could not be read, so enter the model id by hand."
                    : "For a model this connection does not list."}{" "}
                  The studio sends the model one short request with no book text and saves the id only if it answers.
                  Your provider may bill that request.
                </p>
                <div className="flex gap-2">
                  <input
                    ref={manualInput}
                    id={manualInputId}
                    value={manualId}
                    onChange={(event) => setManualId(event.target.value)}
                    placeholder="vendor/model-name"
                    maxLength={200}
                    autoComplete="off"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-[var(--corner-md)] border border-[var(--input)] bg-[var(--card)] px-3 py-1.5 font-(family-name:--font-code) text-(length:--text-caption-size) outline-none placeholder:font-(family-name:--font-ui) placeholder:text-muted-foreground focus-visible:border-[var(--ring)]"
                  />
                  <Button type="submit" size="sm" variant="secondary" disabled={checking || !manualId.trim()} data-testid="manual-model-add">
                    {checking ? <Loader2 size={13} className="animate-spin" /> : null}
                    Add model
                  </Button>
                </div>
                {manualResult ? (
                  <p
                    className={`text-(length:--text-caption-size) leading-[var(--text-caption-leading)] ${
                      manualResult.error ? "text-destructive-text" : "text-muted-foreground"
                    }`}
                    role={manualResult.error ? "alert" : "status"}
                    data-testid="manual-model-result"
                  >
                    {manualResult.text}
                  </p>
                ) : null}
              </form>
            ) : null}

            {contributor && warning ? (
              <div className="rounded-[var(--corner-lg)] border border-[var(--warning)] bg-[var(--secondary)] p-3">
                <p className="text-(length:--text-subheadline-size) font-medium">Contributor mode</p>
                {/* The heading already says Contributor mode, so the warning starts after it (QA E9). */}
                <p className="mt-1 text-(length:--text-caption-size) text-muted-foreground">{warning.replace(/^Contributor mode:\s*/, "")}</p>
                <label className="mt-2 flex items-start gap-2 text-(length:--text-caption-size)">
                  <input
                    type="checkbox"
                    checked={allowContributor}
                    onChange={(event) => setAllowContributor(event.target.checked)}
                    className="mt-0.5 size-4 accent-[var(--primary)]"
                    data-testid="allow-contributor"
                  />
                  <span>
                    I understand and allow this book’s content to be used to train Meta’s models.
                  </span>
                </label>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {manualAllowed && connection !== null && !manualVisible ? (
            <Button variant="ghost" className="mr-auto" onClick={() => setManualOpen(true)} data-testid="enter-model-id">
              Enter a model id
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!connection || !chosen || saving || connections.length === 0 || (contributor && !allowContributor) || (handoff !== undefined && loading)}
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : null}
            {turnMode ? "Use for this turn" : "Use this model"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
