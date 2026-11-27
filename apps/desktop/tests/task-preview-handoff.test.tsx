/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import type { BookMeta } from "@ai-book-studio/core/schema";
import { bookSchema } from "@ai-book-studio/core/schema";
import type { Catalogue } from "@ai-book-studio/core/providers/models";
import type { ConnectionSummary, ModelInfo, ProviderId } from "@ai-book-studio/core/providers/types";
import { previewCatalogues } from "@ai-book-studio/app/lib/task-preview-cache";
import { mountDom, unmountDom } from "./support/dom";

const NOW = "2026-11-03T00:00:00.000Z";
const FRESH_AT = "2026-11-03T00:30:00.000Z";

let testing!: typeof import("@testing-library/react/pure");
let ModelPickerDialog!: typeof import("@ai-book-studio/app/components/ModelPickerDialog").ModelPickerDialog;
type TurnHandoff = import("@ai-book-studio/app/components/ModelPickerDialog").TurnHandoff;
type PreviewCatalogueCache = import("@ai-book-studio/app/lib/task-preview-cache").PreviewCatalogueCache;

beforeAll(async () => {
  testing = await mountDom();
  ({ ModelPickerDialog } = await import("@ai-book-studio/app/components/ModelPickerDialog"));
});
afterAll(async () => {
  await unmountDom();
});
afterEach(() => testing.cleanup());

const BOOK: BookMeta = bookSchema.parse({ id: "book_handoff001", title: "The Salt Road", createdAt: NOW, updatedAt: NOW });

const OPENROUTER_A: ConnectionSummary = { id: "conn_handoff01", provider: "openrouter", label: "OpenRouter key", kind: "api-key", createdAt: NOW };
const OPENROUTER_B: ConnectionSummary = { id: "conn_handoff02", provider: "openrouter", label: "OpenRouter backup", kind: "api-key", createdAt: NOW };
const META_CONTRIBUTOR: ConnectionSummary = { id: "conn_handoff03", provider: "meta", label: "Meta key", kind: "api-key", createdAt: NOW };
const PROVIDERS = [{ id: "openrouter", name: "OpenRouter" }, { id: "meta", name: "Meta" }];

function model(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    name: id,
    contextLength: 128000,
    supportsTools: true,
    supportsImages: false,
    inputPricePerMillion: 1,
    outputPricePerMillion: 2,
    ...overrides,
    id
  };
}

const ACME = model("acme/large");

function handoff(connectionId: string | null, modelId = ACME.id, provider: ProviderId = "openrouter"): TurnHandoff {
  return { provider, modelId, connectionId };
}

interface StudioOptions {
  connections: ConnectionSummary[];
  modelsFor: (connectionId: string) => Promise<Catalogue> | Catalogue;
  booksUpdate?: (bookId: string, changes: Record<string, unknown>) => Promise<{ ok: true; data: null }>;
  addModel?: (connectionId: string, modelId: string) => Promise<{ ok: true; data: ModelInfo }>;
}

function installStudio({ connections, modelsFor, booksUpdate, addModel }: StudioOptions) {
  const calls: string[] = [];
  const listProviders = mock(async () => {
    calls.push("providers.list");
    return { ok: true as const, data: PROVIDERS };
  });
  const listConnections = mock(async () => {
    calls.push("connections.list");
    return { ok: true as const, data: connections };
  });
  const booksUpdateMock = mock(
    booksUpdate ?? (async (_bookId: string, _changes: Record<string, unknown>) => ({ ok: true as const, data: null }))
  );
  const booksEditMock = mock(async () => ({ ok: true as const, data: { status: "saved", book: BOOK } }));
  const sendMock = mock(() => {
    throw new Error("Unexpected provider send");
  });
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: "darwin",
    providers: {
      list: listProviders,
      models: mock(async (connectionId: string) => {
        calls.push(`providers.models:${connectionId}`);
        return { ok: true as const, data: await modelsFor(connectionId) };
      }),
      addModel: addModel ?? sendMock
    },
    connections: { list: listConnections },
    books: { update: booksUpdateMock, edit: booksEditMock },
    agent: { start: sendMock }
  };
  return { calls, listProviders, listConnections, booksUpdateMock, booksEditMock, sendMock };
}

function renderPicker(props: {
  handoff?: TurnHandoff | undefined;
  initial?: { connectionId: string; modelId: string } | null;
  book?: BookMeta;
  onCataloguesLoaded?: (snapshot: PreviewCatalogueCache) => void;
  onPick?: (choice: { connectionId: string; modelId: string }) => void;
  onClose?: () => void;
}) {
  const onPick = props.onPick ?? mock(() => {});
  const onClose = props.onClose ?? mock(() => {});
  let activeHandoff = props.handoff;
  const picker = (open: boolean) =>
    React.createElement(ModelPickerDialog, {
      open,
      book: props.book ?? BOOK,
      onClose,
      onPick,
      initial: props.initial ?? null,
      ...(activeHandoff !== undefined ? { handoff: activeHandoff } : {}),
      ...(props.onCataloguesLoaded ? { onCataloguesLoaded: props.onCataloguesLoaded } : {})
    });
  const view = testing.render(picker(true));
  return {
    view,
    onPick,
    onClose,
    setOpen: (open: boolean) => view.rerender(picker(open)),
    replaceHandoff: (next: TurnHandoff) => {
      activeHandoff = next;
      view.rerender(picker(true));
    }
  };
}

const okModels = (models: ModelInfo[]) => async (): Promise<Catalogue> => ({ models, fetchedAt: FRESH_AT });

function turnConfirm(view: ReturnType<typeof renderPicker>["view"]): HTMLButtonElement {
  return view.getByRole("button", { name: "Use for this turn" }) as HTMLButtonElement;
}

describe("model picker handoff", () => {
  test("one usable connection preselects it and the candidate, and confirm passes both through", async () => {
    const { calls } = installStudio({ connections: [OPENROUTER_A], modelsFor: okModels([ACME]) });
    const { view, onPick } = renderPicker({ handoff: handoff(OPENROUTER_A.id) });
    await testing.within(document.body).findByText("Model for this turn");
    await testing.waitFor(() => expect((view.getByRole("button", { name: "Use for this turn" }) as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Use for this turn" }));
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith({ connectionId: OPENROUTER_A.id, modelId: ACME.id });
    expect(calls).toContain(`providers.models:${OPENROUTER_A.id}`);
  });

  test("two usable connections wait for the author and never preselect the first", async () => {
    const { calls } = installStudio({
      connections: [OPENROUTER_A, OPENROUTER_B],
      modelsFor: okModels([ACME])
    });
    const { view, onPick } = renderPicker({ handoff: handoff(null) });
    await testing.within(document.body).findByText("Model for this turn");
    // The author must choose: no catalogue load and a disabled confirm until they do.
    await testing.act(async () => {});
    expect(calls.filter((call) => call.startsWith("providers.models"))).toEqual([]);
    const confirm = view.getByRole("button", { name: "Use for this turn" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("OpenRouter backup"));
    });
    await testing.waitFor(() => expect((view.getByRole("button", { name: "Use for this turn" }) as HTMLButtonElement).disabled).toBe(false));
    expect(calls).toContain(`providers.models:${OPENROUTER_B.id}`);
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Use for this turn" }));
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith({ connectionId: OPENROUTER_B.id, modelId: ACME.id });
  });

  test("zero usable connections shows the refusal and never loads a catalogue", async () => {
    const refused: ConnectionSummary = { ...OPENROUTER_A, planUsable: false };
    const { calls } = installStudio({ connections: [refused], modelsFor: okModels([ACME]) });
    const { view, onPick, onClose } = renderPicker({ handoff: handoff(null) });
    await testing.within(document.body).findByText("No usable connection is available for this model. Nothing has changed.");
    expect(calls.filter((call) => call.startsWith("providers.models"))).toEqual([]);
    expect((view.getByRole("button", { name: "Use for this turn" }) as HTMLButtonElement).disabled).toBe(true);
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a candidate that vanished on open is refused with the exact reason", async () => {
    installStudio({ connections: [OPENROUTER_A], modelsFor: okModels([]) });
    const { view, onPick, onClose } = renderPicker({ handoff: handoff(OPENROUTER_A.id) });
    await testing.within(document.body).findByText("This model is no longer in the provider's list. Nothing has changed.");
    expect((view.getByRole("button", { name: "Use for this turn" }) as HTMLButtonElement).disabled).toBe(true);
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a candidate that is no longer usable is refused with the provider's reason", async () => {
    const mystery = model(ACME.id, { supportsTools: null, contextLength: null });
    installStudio({ connections: [OPENROUTER_A], modelsFor: okModels([mystery]) });
    const { view, onPick } = renderPicker({ handoff: handoff(OPENROUTER_A.id) });
    await testing.within(document.body).findByText("This provider does not say whether the model supports tools. Nothing has changed.");
    expect((view.getByRole("button", { name: "Use for this turn" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
  });

  test("a Contributor candidate keeps the spec 022 gate; the handoff writes no consent itself", async () => {
    const contributor = model("muse-spark-1.3-contributor", { trainingOnData: true });
    const { booksUpdateMock } = installStudio({ connections: [META_CONTRIBUTOR], modelsFor: okModels([contributor]) });
    const { view, onPick } = renderPicker({ handoff: handoff(META_CONTRIBUTOR.id, contributor.id, "meta") });
    await testing.within(document.body).findByText("Contributor mode");
    expect(booksUpdateMock).not.toHaveBeenCalled();
    // Unchecked: confirm stays disabled and nothing is written.
    expect((view.getByRole("button", { name: "Use for this turn" }) as HTMLButtonElement).disabled).toBe(true);
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("checkbox"));
    });
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Use for this turn" }));
    });
    // Checking the box routes through the existing spec 022 consent write, not a new handoff path.
    expect(booksUpdateMock).toHaveBeenCalledTimes(1);
    expect(booksUpdateMock).toHaveBeenCalledWith(BOOK.id, { allowContributorTraining: true });
    expect(onPick).toHaveBeenCalledWith({ connectionId: META_CONTRIBUTOR.id, modelId: contributor.id });
  });

  test("cancelling a handoff never picks and never touches the book", async () => {
    const { calls, booksUpdateMock } = installStudio({ connections: [OPENROUTER_A], modelsFor: okModels([ACME]) });
    const { view, onPick, onClose } = renderPicker({ handoff: handoff(OPENROUTER_A.id) });
    await testing.within(document.body).findByText("Model for this turn");
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(booksUpdateMock).not.toHaveBeenCalled();
    expect(calls).not.toContain("books.update");
  });

  test("a reopened handoff withholds earlier choices until fresh lookups settle", async () => {
    const { calls, listProviders, listConnections, booksUpdateMock, booksEditMock, sendMock } = installStudio({
      connections: [OPENROUTER_A],
      modelsFor: okModels([ACME])
    });
    const { view, onPick, onClose, setOpen } = renderPicker({ handoff: handoff(null) });
    await testing.waitFor(() => expect(turnConfirm(view).disabled).toBe(false));
    testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    setOpen(false);

    const providers = Promise.withResolvers<Awaited<ReturnType<typeof listProviders>>>();
    const connections = Promise.withResolvers<Awaited<ReturnType<typeof listConnections>>>();
    listProviders.mockImplementationOnce(() => providers.promise);
    listConnections.mockImplementationOnce(() => connections.promise);
    setOpen(true);
    await testing.act(async () => {
      connections.resolve({ ok: true, data: [{ ...OPENROUTER_A, label: "OpenRouter renamed" }, OPENROUTER_B] });
    });
    expect(view.queryByText(OPENROUTER_A.label)?.textContent).toBeUndefined();
    expect(view.queryByText(OPENROUTER_B.label)?.textContent).toBeUndefined();
    expect(view.queryByText(ACME.id)?.textContent).toBeUndefined();
    expect(view.getByRole("status").textContent).toContain("Loading connections…");
    expect(view.queryByTestId("enter-model-id")?.textContent).toBeUndefined();
    expect(turnConfirm(view).disabled).toBe(true);

    await testing.act(async () => {
      providers.resolve({ ok: true, data: PROVIDERS });
    });
    expect(view.getByText("OpenRouter renamed")).toBeTruthy();
    expect(view.queryByText(ACME.id)?.textContent).toBeUndefined();
    expect(turnConfirm(view).disabled).toBe(true);
    expect(calls.filter((call) => call.startsWith("providers.models:"))).toEqual([`providers.models:${OPENROUTER_A.id}`]);

    testing.fireEvent.click(view.getByText(OPENROUTER_B.label));
    await testing.waitFor(() => expect(turnConfirm(view).disabled).toBe(false));
    expect(onPick).not.toHaveBeenCalled();
    testing.fireEvent.click(turnConfirm(view));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith({ connectionId: OPENROUTER_B.id, modelId: ACME.id });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(booksEditMock).not.toHaveBeenCalled();
    expect(booksUpdateMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("a reopened handoff ignores a connection reply from the closed visit", async () => {
    const { calls, listConnections, sendMock } = installStudio({ connections: [], modelsFor: okModels([ACME]) });
    const abandoned = Promise.withResolvers<Awaited<ReturnType<typeof listConnections>>>();
    const fresh = Promise.withResolvers<Awaited<ReturnType<typeof listConnections>>>();
    listConnections.mockImplementationOnce(() => abandoned.promise).mockImplementationOnce(() => fresh.promise);
    const onCataloguesLoaded = mock(() => {});
    const { view, onPick, setOpen } = renderPicker({ handoff: handoff(null), onCataloguesLoaded });
    expect(view.getByText("Loading connections…")).toBeTruthy();
    testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    setOpen(false);
    setOpen(true);
    expect(listConnections).toHaveBeenCalledTimes(2);

    await testing.act(async () => {
      abandoned.resolve({ ok: true, data: [OPENROUTER_A] });
    });
    expect(view.queryByText(OPENROUTER_A.label)?.textContent).toBeUndefined();
    expect(view.getByText("Loading connections…")).toBeTruthy();
    expect(turnConfirm(view).disabled).toBe(true);
    expect(onCataloguesLoaded).not.toHaveBeenCalled();

    await testing.act(async () => {
      fresh.resolve({ ok: true, data: [] });
    });
    expect(view.getByText("No usable connection is available for this model. Nothing has changed.")).toBeTruthy();
    expect(view.queryByText("Loading connections…")?.textContent).toBeUndefined();
    expect(turnConfirm(view).disabled).toBe(true);
    expect(calls.filter((call) => call.startsWith("providers.models:"))).toEqual([]);
    expect(onPick).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("a reopened handoff ignores a model catalogue reply from the closed visit", async () => {
    const abandoned = Promise.withResolvers<Awaited<ReturnType<StudioOptions["modelsFor"]>>>();
    const fresh = Promise.withResolvers<Awaited<ReturnType<StudioOptions["modelsFor"]>>>();
    const modelsFor = mock(okModels([])).mockImplementationOnce(() => abandoned.promise).mockImplementationOnce(() => fresh.promise);
    const { sendMock } = installStudio({ connections: [OPENROUTER_A], modelsFor });
    const onCataloguesLoaded = mock(() => {});
    const { view, onPick, setOpen } = renderPicker({ handoff: handoff(OPENROUTER_A.id), onCataloguesLoaded });
    await view.findByText("Loading models…");
    testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    setOpen(false);
    setOpen(true);
    await testing.waitFor(() => expect(modelsFor).toHaveBeenCalledTimes(2));
    expect(view.getByText("Loading models…")).toBeTruthy();

    await testing.act(async () => {
      abandoned.resolve({ models: [ACME], fetchedAt: FRESH_AT });
    });
    expect(view.queryByText(ACME.id)?.textContent).toBeUndefined();
    expect(view.getByText("Loading models…")).toBeTruthy();
    expect(turnConfirm(view).disabled).toBe(true);
    expect(onCataloguesLoaded).toHaveBeenCalledTimes(2);

    await testing.act(async () => {
      fresh.resolve({ models: [], fetchedAt: FRESH_AT });
    });
    expect(view.getByText("This model is no longer in the provider's list. Nothing has changed.")).toBeTruthy();
    expect(turnConfirm(view).disabled).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("replacing an open handoff requires fresh verification for the replacement", async () => {
    const replacement = model("acme/replacement");
    const { listConnections, sendMock } = installStudio({
      connections: [OPENROUTER_A],
      modelsFor: okModels([ACME, replacement])
    });
    const { view, onPick, replaceHandoff } = renderPicker({ handoff: handoff(OPENROUTER_A.id) });
    await testing.waitFor(() => expect(turnConfirm(view).disabled).toBe(false));

    const fresh = Promise.withResolvers<Awaited<ReturnType<typeof listConnections>>>();
    listConnections.mockImplementationOnce(() => fresh.promise);
    replaceHandoff(handoff(OPENROUTER_A.id, replacement.id));
    expect(listConnections).toHaveBeenCalledTimes(2);
    expect(view.queryByText(ACME.id)).toBeNull();
    expect(view.getByRole("status").textContent).toContain("Loading connections…");
    const descriptionId = view.getByRole("dialog").getAttribute("aria-describedby");
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain("Loading connections…");
    expect(turnConfirm(view).disabled).toBe(true);
    expect(onPick).not.toHaveBeenCalled();

    await testing.act(async () => {
      fresh.resolve({ ok: true, data: [OPENROUTER_A] });
    });
    await testing.waitFor(() => expect(turnConfirm(view).disabled).toBe(false));
    testing.fireEvent.click(turnConfirm(view));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith({ connectionId: OPENROUTER_A.id, modelId: replacement.id });
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("a cancelled visit's manual model check cannot enable the replacement", async () => {
    const meta = model("muse/original");
    const manual = model("muse/manual");
    const response = Promise.withResolvers<{ ok: true; data: ModelInfo }>();
    const addModel = mock((_connectionId: string, _modelId: string) => response.promise);
    const { sendMock } = installStudio({
      connections: [META_CONTRIBUTOR, OPENROUTER_A],
      modelsFor: (id) => ({ models: id === META_CONTRIBUTOR.id ? [meta] : [], fetchedAt: FRESH_AT }),
      addModel
    });
    const { view, onPick, setOpen, replaceHandoff } = renderPicker({ handoff: handoff(META_CONTRIBUTOR.id, meta.id, "meta") });
    await testing.waitFor(() => expect(turnConfirm(view).disabled).toBe(false));
    testing.fireEvent.click(view.getByRole("button", { name: "Enter a model id" }));
    testing.fireEvent.change(view.getByRole("textbox", { name: "Model id" }), { target: { value: manual.id } });
    testing.fireEvent.click(view.getByRole("button", { name: "Add model" }));
    expect(addModel).toHaveBeenCalledWith(META_CONTRIBUTOR.id, manual.id);

    testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    setOpen(false);
    replaceHandoff(handoff(OPENROUTER_A.id));
    await view.findByText("This model is no longer in the provider's list. Nothing has changed.");
    await testing.act(async () => {
      response.resolve({ ok: true, data: manual });
    });
    expect(view.queryByText(manual.id)).toBeNull();
    expect(view.queryByTestId("manual-model-result")).toBeNull();
    expect(turnConfirm(view).disabled).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("a manual model result cannot carry over after switching connections", async () => {
    const manual = model("acme/manual");
    const response = Promise.withResolvers<{ ok: true; data: ModelInfo }>();
    const addModel = mock((_connectionId: string, _modelId: string) => response.promise);
    const { sendMock } = installStudio({
      connections: [OPENROUTER_A, OPENROUTER_B],
      modelsFor: (id) => ({ models: id === OPENROUTER_A.id ? [ACME] : [], fetchedAt: FRESH_AT }),
      addModel
    });
    const { view, onPick } = renderPicker({ handoff: handoff(null) });
    testing.fireEvent.click(await view.findByText(OPENROUTER_A.label));
    await testing.waitFor(() => expect(turnConfirm(view).disabled).toBe(false));
    testing.fireEvent.click(view.getByRole("button", { name: "Enter a model id" }));
    testing.fireEvent.change(view.getByRole("textbox", { name: "Model id" }), { target: { value: manual.id } });
    testing.fireEvent.click(view.getByRole("button", { name: "Add model" }));
    expect(addModel).toHaveBeenCalledWith(OPENROUTER_A.id, manual.id);
    testing.fireEvent.click(view.getByText(OPENROUTER_B.label));
    await view.findByText("This model is no longer in the provider's list. Nothing has changed.");
    await testing.act(async () => {
      response.resolve({ ok: true, data: manual });
    });
    expect(view.queryByText(manual.id)).toBeNull();
    expect(view.queryByTestId("manual-model-result")).toBeNull();
    expect(turnConfirm(view).disabled).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("late Contributor consent does not apply the old choice or close a replacement", async () => {
    const contributor = model("muse-spark-1.3-contributor", { trainingOnData: true });
    const consent = Promise.withResolvers<{ ok: true; data: null }>();
    const { booksUpdateMock, sendMock } = installStudio({
      connections: [META_CONTRIBUTOR, OPENROUTER_A],
      modelsFor: (id) => ({ models: [id === META_CONTRIBUTOR.id ? contributor : ACME], fetchedAt: FRESH_AT }),
      booksUpdate: () => consent.promise
    });
    const {
      view, onPick, onClose, setOpen, replaceHandoff
    } = renderPicker({ handoff: handoff(META_CONTRIBUTOR.id, contributor.id, "meta") });
    await view.findByText("Contributor mode");
    testing.fireEvent.click(view.getByRole("checkbox"));
    testing.fireEvent.click(turnConfirm(view));
    expect(booksUpdateMock).toHaveBeenCalledTimes(1);
    expect(booksUpdateMock).toHaveBeenCalledWith(BOOK.id, { allowContributorTraining: true });

    testing.fireEvent.click(view.getByRole("button", { name: "Close" }));
    setOpen(false);
    replaceHandoff(handoff(OPENROUTER_A.id));
    await testing.waitFor(() => expect(turnConfirm(view).disabled).toBe(false));
    await testing.act(async () => {
      consent.resolve({ ok: true, data: null });
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    testing.fireEvent.click(turnConfirm(view));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith({ connectionId: OPENROUTER_A.id, modelId: ACME.id });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("book mode without a handoff keeps the existing save path and adds no handoff state", async () => {
    const edit = mock(async (_bookId: string, _changes: Record<string, unknown>) => ({
      ok: true as const,
      data: {
        status: "saved",
        book: { ...BOOK, defaultConnectionId: OPENROUTER_A.id, defaultModelId: ACME.id }
      }
    }));
    const onSaved = mock(() => {});
    (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
      platform: "darwin",
      providers: {
        list: mock(async () => ({ ok: true, data: [{ id: "openrouter", name: "OpenRouter" }] })),
        models: mock(async () => ({ ok: true as const, data: { models: [ACME], fetchedAt: FRESH_AT } }))
      },
      connections: {
        list: mock(async () => ({ ok: true, data: [OPENROUTER_A] }))
      },
      books: { update: mock(async () => ({ ok: true as const, data: null })), edit }
    };
    testing.render(
      React.createElement(ModelPickerDialog, {
        open: true,
        book: BOOK,
        onClose: () => {},
        onSaved,
        onPick: undefined
      })
    );
    const doc = testing.within(document.body);
    await doc.findByText("Model for this book");
    // No model is preselected for a book with no saved default; the author picks one.
    await testing.waitFor(() => expect(doc.getByText("acme/large")).toBeTruthy());
    await testing.act(async () => {
      await testing.fireEvent.click(doc.getByText("acme/large"));
    });
    await testing.waitFor(() =>
      expect((doc.getByRole("button", { name: "Use this model" }) as HTMLButtonElement).disabled).toBe(false)
    );
    await testing.act(async () => {
      await testing.fireEvent.click(doc.getByRole("button", { name: "Use this model" }));
    });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[1]).toEqual({
      defaultProvider: { from: null, to: "openrouter" },
      defaultConnectionId: { from: null, to: OPENROUTER_A.id },
      defaultModelId: { from: null, to: ACME.id }
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test("turn mode without a handoff keeps the existing book-default behaviour", async () => {
    const book = bookSchema.parse({ ...JSON.parse(JSON.stringify(BOOK)), defaultConnectionId: OPENROUTER_A.id, defaultModelId: ACME.id });
    installStudio({ connections: [OPENROUTER_A], modelsFor: okModels([ACME]) });
    const { view, onPick } = renderPicker({ book, initial: null });
    await testing.within(document.body).findByText("Model for this turn");
    await testing.waitFor(() => expect((view.getByRole("button", { name: "Use for this turn" }) as HTMLButtonElement).disabled).toBe(false));
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByRole("button", { name: "Use for this turn" }));
    });
    expect(onPick).toHaveBeenCalledWith({ connectionId: OPENROUTER_A.id, modelId: ACME.id });
  });

  test("the picker emits its loaded catalogues for the preview snapshot", async () => {
    const loaded: PreviewCatalogueCache[] = [];
    installStudio({ connections: [OPENROUTER_A], modelsFor: okModels([ACME]) });
    renderPicker({
      handoff: handoff(OPENROUTER_A.id),
      onCataloguesLoaded: (snapshot) => loaded.push(snapshot)
    });
    await testing.within(document.body).findByText("Model for this turn");
    await testing.waitFor(() => expect(loaded.some((snapshot) => snapshot.loads.length === 1)).toBe(true));
    const last = loaded[loaded.length - 1];
    expect(last?.connections.map((connection) => connection.id)).toEqual([OPENROUTER_A.id]);
    expect(last?.loads[0]?.connectionId).toBe(OPENROUTER_A.id);
    expect(last?.loads[0]?.catalogue.models.map((model) => model.id)).toEqual([ACME.id]);
  });

  test("a failed reload keeps the previous catalogue in the snapshot", async () => {
    let fail = false;
    const modelsFor = async (_connectionId: string) => {
      if (fail) throw new Error("synthetic catalogue failure");
      return { models: [ACME], fetchedAt: FRESH_AT };
    };
    const loaded: PreviewCatalogueCache[] = [];
    installStudio({ connections: [OPENROUTER_A, OPENROUTER_B], modelsFor });
    const { view } = renderPicker({
      handoff: handoff(null),
      onCataloguesLoaded: (snapshot) => loaded.push(snapshot)
    });
    await testing.within(document.body).findByText("Model for this turn");
    // Author picks the first connection: loads succeed and emit a one-entry snapshot.
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("OpenRouter key"));
    });
    await testing.waitFor(() => expect(loaded.some((snapshot) => snapshot.loads.length === 1 && snapshot.loads[0]?.connectionId === OPENROUTER_A.id)).toBe(true));
    // The next load fails; the snapshot must keep the previous catalogue.
    fail = true;
    await testing.act(async () => {
      await testing.fireEvent.click(view.getByText("OpenRouter backup"));
    });
    await testing.waitFor(() => expect(loaded.length).toBeGreaterThan(0));
    const last = loaded[loaded.length - 1];
    expect(last?.loads.map((load) => load.connectionId)).toEqual([OPENROUTER_A.id]);
  });

  test("reopening preserves the preview catalogue while the picker requires a fresh lookup", async () => {
    const catalogue = { models: [ACME], fetchedAt: FRESH_AT };
    const refresh = Promise.withResolvers<typeof catalogue>();
    const modelsFor = mock(okModels([ACME]))
      .mockImplementationOnce(okModels([ACME]))
      .mockImplementationOnce(() => refresh.promise);
    const { listConnections, sendMock } = installStudio({ connections: [OPENROUTER_A], modelsFor });
    const renamed = { ...OPENROUTER_A, label: "Renamed connection" };
    listConnections
      .mockResolvedValueOnce({ ok: true, data: [OPENROUTER_A] })
      .mockResolvedValueOnce({ ok: true, data: [renamed] });
    let snapshot: PreviewCatalogueCache = { connections: [], loads: [] };
    const { view, onPick, setOpen } = renderPicker({
      handoff: handoff(OPENROUTER_A.id),
      onCataloguesLoaded: (loaded) => {
        snapshot = loaded;
      }
    });
    const expected = [{ provider: OPENROUTER_A.provider, catalogue }];
    await testing.waitFor(() => expect(turnConfirm(view).disabled).toBe(false));
    expect(previewCatalogues(snapshot)).toEqual(expected);

    testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    setOpen(false);
    setOpen(true);
    await view.findByText("Loading models…");
    expect(modelsFor).toHaveBeenCalledTimes(2);
    expect(snapshot.connections).toEqual([renamed]);
    expect(previewCatalogues(snapshot)).toEqual(expected);
    expect(view.queryByRole("button", { name: /acme\/large/i })).toBeNull();
    expect(turnConfirm(view).disabled).toBe(true);

    await testing.act(async () => {
      refresh.reject(new Error("Synthetic catalogue refresh failure"));
    });
    expect(view.getByText("Synthetic catalogue refresh failure")).toBeTruthy();
    expect(previewCatalogues(snapshot)).toEqual(expected);
    expect(view.queryByRole("button", { name: /acme\/large/i })).toBeNull();
    expect(turnConfirm(view).disabled).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("only a successful refresh replaces a provider's previous preview catalogue", async () => {
    const first = { models: [ACME], fetchedAt: NOW };
    const backup = { models: [model("acme/backup")], fetchedAt: FRESH_AT };
    const meta = { models: [model("muse-spark-1.3")], fetchedAt: FRESH_AT };
    const refreshed = { models: [model("acme/refreshed")], fetchedAt: "2026-11-03T00:45:00.000Z" };
    const listError = "Synthetic OpenRouter list unreadable";
    const unreadable = { models: [], fetchedAt: "2026-11-03T00:35:00.000Z", listError };
    const manualOnly = { models: [model("acme/manual", { manual: true })], fetchedAt: null, listError };
    let primary: Catalogue = first;
    const { calls, sendMock } = installStudio({
      connections: [OPENROUTER_A, OPENROUTER_B, META_CONTRIBUTOR],
      modelsFor: (id) => {
        if (id === OPENROUTER_A.id) return primary;
        if (id === OPENROUTER_B.id) return backup;
        return meta;
      }
    });
    let snapshot: PreviewCatalogueCache = { connections: [], loads: [] };
    const { view, onPick, setOpen } = renderPicker({
      onCataloguesLoaded: (loaded) => {
        snapshot = loaded;
      }
    });
    const metaEntry = { provider: META_CONTRIBUTOR.provider, catalogue: meta };
    await testing.waitFor(() => expect(previewCatalogues(snapshot)).toEqual([
      { provider: OPENROUTER_A.provider, catalogue: first }
    ]));

    testing.fireEvent.click(view.getByText(META_CONTRIBUTOR.label));
    await testing.waitFor(() => expect(previewCatalogues(snapshot)).toEqual([
      { provider: OPENROUTER_A.provider, catalogue: first }, metaEntry
    ]));
    testing.fireEvent.click(view.getByText(OPENROUTER_B.label));
    await testing.waitFor(() => expect(previewCatalogues(snapshot)).toEqual([
      { provider: OPENROUTER_B.provider, catalogue: backup }, metaEntry
    ]));

    const reopenWith = (catalogue: Catalogue) => {
      testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
      setOpen(false);
      primary = catalogue;
      setOpen(true);
    };
    reopenWith(unreadable);
    await view.findByText(listError);
    expect(view.getByLabelText("Model id")).toBeTruthy();
    expect(turnConfirm(view).disabled).toBe(true);
    expect(previewCatalogues(snapshot)).toEqual([
      { provider: OPENROUTER_B.provider, catalogue: backup }, metaEntry
    ]);

    reopenWith(refreshed);
    await view.findByRole("button", { name: /acme\/refreshed/i });
    expect(previewCatalogues(snapshot)).toEqual([
      { provider: OPENROUTER_A.provider, catalogue: refreshed }, metaEntry
    ]);

    reopenWith(manualOnly);
    await view.findByRole("button", { name: /acme\/manual/i });
    expect(view.getByText(listError)).toBeTruthy();
    expect(previewCatalogues(snapshot)).toEqual([
      { provider: OPENROUTER_A.provider, catalogue: refreshed }, metaEntry
    ]);
    expect(calls.filter((call) => call.startsWith("providers.models:"))).toEqual(
      [OPENROUTER_A, META_CONTRIBUTOR, OPENROUTER_B, OPENROUTER_A, OPENROUTER_A, OPENROUTER_A]
        .map(({ id }) => `providers.models:${id}`)
    );
    expect(onPick).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("manual-only models are a preview fallback while the complete catalogue is unavailable", async () => {
    const manual = model("acme/manual", { manual: true });
    const fallback = { models: [manual], fetchedAt: null, listError: "Synthetic list unreadable" };
    const backup = { models: [model("acme/backup")], fetchedAt: FRESH_AT };
    const { listConnections } = installStudio({
      connections: [OPENROUTER_A, OPENROUTER_B],
      modelsFor: (id) => id === OPENROUTER_A.id ? fallback : backup
    });
    let snapshot: PreviewCatalogueCache = { connections: [], loads: [] };
    const { view, setOpen } = renderPicker({
      onCataloguesLoaded: (loaded) => {
        snapshot = loaded;
      }
    });
    await view.findByRole("button", { name: /acme\/manual/i });
    expect(view.getByText(fallback.listError)).toBeTruthy();
    const expectedFallback = [{ provider: OPENROUTER_A.provider, catalogue: fallback }];
    const expectedBackup = [{ provider: OPENROUTER_B.provider, catalogue: backup }];
    expect(previewCatalogues(snapshot)).toEqual(expectedFallback);

    testing.fireEvent.click(view.getByText(OPENROUTER_B.label));
    await view.findByRole("button", { name: /acme\/backup/i });
    expect(previewCatalogues(snapshot)).toEqual(expectedBackup);
    testing.fireEvent.click(view.getByText(OPENROUTER_A.label));
    await view.findByRole("button", { name: /acme\/manual/i });
    expect(previewCatalogues(snapshot)).toEqual(expectedBackup);

    testing.fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    setOpen(false);
    listConnections.mockResolvedValueOnce({ ok: true, data: [OPENROUTER_A] });
    setOpen(true);
    await view.findByRole("button", { name: /acme\/manual/i });
    expect(previewCatalogues(snapshot)).toEqual(expectedFallback);
  });
});

