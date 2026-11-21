/// <reference types="bun" />
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import type { BookMeta } from "@ai-book-studio/core/schema";
import { bookSchema } from "@ai-book-studio/core/schema";
import type { ConnectionSummary, ModelInfo, ProviderId } from "@ai-book-studio/core/providers/types";
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
  modelsFor: (connectionId: string) => Promise<{ models: ModelInfo[]; fetchedAt: string }> | { models: ModelInfo[]; fetchedAt: string };
  booksUpdate?: (bookId: string, changes: Record<string, unknown>) => Promise<{ ok: true; data: null }>;
}

function installStudio({ connections, modelsFor, booksUpdate }: StudioOptions) {
  const calls: string[] = [];
  const booksUpdateMock = mock(
    booksUpdate ?? (async (_bookId: string, _changes: Record<string, unknown>) => ({ ok: true as const, data: null }))
  );
  (globalThis as unknown as { window: { studio: unknown } }).window.studio = {
    platform: "darwin",
    providers: {
      list: mock(async () => {
        calls.push("providers.list");
        return {
          ok: true,
          data: [
            { id: "openrouter", name: "OpenRouter" },
            { id: "meta", name: "Meta" }
          ]
        };
      }),
      models: mock(async (connectionId: string) => {
        calls.push(`providers.models:${connectionId}`);
        return { ok: true as const, data: await modelsFor(connectionId) };
      })
    },
    connections: {
      list: mock(async () => {
        calls.push("connections.list");
        return { ok: true as const, data: connections };
      })
    },
    books: {
      update: booksUpdateMock,
      edit: mock(async () => ({ ok: true as const, data: { status: "saved", book: BOOK } }))
    }
  };
  return { calls, booksUpdateMock };
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
  const view = testing.render(
    React.createElement(ModelPickerDialog, {
      open: true,
      book: props.book ?? BOOK,
      onClose,
      onPick,
      initial: props.initial ?? null,
      ...(props.handoff !== undefined ? { handoff: props.handoff } : {}),
      ...(props.onCataloguesLoaded ? { onCataloguesLoaded: props.onCataloguesLoaded } : {})
    })
  );
  return { view, onPick, onClose };
}

const okModels = (models: ModelInfo[]) => async () => ({ models, fetchedAt: FRESH_AT });

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
});

