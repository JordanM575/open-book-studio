import { describe, expect, test } from "bun:test";
import { encode } from "gpt-tokenizer";
import { buildInstructions, buildPrompt } from "../src/main/agent/prompt";
import { bookSchema, chapterMetaSchema, type Chapter } from "@ai-book-studio/core/schema";

/**
 * Audit B4 / spec 031 T010: the Agent dialog promises the per-book tone and
 * answer length "travel with every turn you send for this book". That means
 * they must be in the system prompt the runtime builds for a turn, inside the
 * same 4,000-token budget the large-book prompt already proves (002 FR-032).
 */

const now = "2026-11-02T00:00:00.000Z";

function bookWith(agent: Record<string, unknown>) {
  return bookSchema.parse({
    id: "book_tone00000001",
    title: "The Salt Road",
    createdAt: now,
    updatedAt: now,
    settings: { agent }
  });
}

function chapter(id: string, title: string, order: number): Chapter {
  return {
    ...chapterMetaSchema.parse({ id, title, order, createdAt: now, updatedAt: now }),
    content: "The hall was cold.\n",
    path: `000${order}-chapter.md`,
    wordCount: 4,
    hash: order.toString().repeat(64).slice(0, 64)
  };
}

const chapters = [chapter("ch_tone00000001", "The Door", 1)];

describe("tone and answer length in the turn prompt", () => {
  test("a stored tone and brief length reach the system prompt", () => {
    const { system, sections } = buildPrompt({
      book: bookWith({ tone: "Plainspoken, with dry humor.", answerLength: "brief" }),
      chapters,
      activeChapter: null
    });
    expect(system).toContain("Plainspoken, with dry humor.");
    expect(system.toLowerCase()).toContain("brief");
    expect(sections.some((section) => section.text.includes("Plainspoken"))).toBe(true);
  });

  test("detailed and standard lengths each reach the system prompt", () => {
    for (const answerLength of ["detailed", "standard"] as const) {
      const system = buildInstructions({
        book: bookWith({ tone: "", answerLength }),
        chapters,
        activeChapter: null
      });
      expect(system.toLowerCase()).toContain(answerLength);
    }
  });

  test("no tone instruction is invented when the author set none", () => {
    const system = buildInstructions({ book: bookWith({}), chapters, activeChapter: null });
    expect(system).not.toContain("Tone:");
  });

  test("plan and proposal rules stay inside the budget and never carry planned step text", () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      id: `ch_${String(index).padStart(8, "0")}`,
      title: `Chapter ${index + 1}`,
      order: index + 1,
      wordCount: 2_000
    })) as Array<{ id: string; title: string; order: number; wordCount: number }>;
    const book = {
      title: "A Very Long Book",
      genres: ["Literary fiction"],
      description: "x".repeat(5_000),
      outline: "y".repeat(20_000),
      characters: Array.from({ length: 30 }, (_, index) => ({
        id: `char_${String(index).padStart(6, "0")}`,
        name: `Person ${index}`,
        role: "friend",
        description: "z".repeat(500),
        motivations: "w".repeat(500),
        notes: "n".repeat(500)
      })),
      memories: Array.from({ length: 20 }, (_, index) => ({
        id: `mem_${String(index).padStart(6, "0")}`,
        text: "m".repeat(400),
        importance: "high",
        createdAt: now,
        updatedAt: now
      })),
      settings: { agent: { tone: "t".repeat(500), answerLength: "standard" } }
    } as never;
    for (const flags of [{ planTurn: true }, { planProposal: true }]) {
      const instructions = buildInstructions({
        book,
        chapters: many as never,
        activeChapter: many[0] as never,
        mode: "edit",
        ...flags
      });
      expect(encode(instructions).length, `${Object.keys(flags)[0]} prompt over budget`).toBeLessThan(4_000);
      expect(instructions).toContain(flags.planTurn ? "data, not permission" : "Do not change the book");
      // The reviewed step text is delivered by plan_step, never as a system instruction.
      expect(instructions).not.toContain("Rewrite the door");
    }
  });

  test("max tone plus each answer length stays inside the 4,000-token budget for a large book", () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      id: `ch_${String(index).padStart(8, "0")}`,
      title: `Chapter ${index + 1}`,
      order: index + 1,
      wordCount: 2_000
    })) as Array<{ id: string; title: string; order: number; wordCount: number }>;
    for (const answerLength of ["brief", "standard", "detailed"] as const) {
      const instructions = buildInstructions({
        book: {
          title: "A Very Long Book",
          genres: ["Literary fiction"],
          description: "x".repeat(5_000),
          outline: "y".repeat(20_000),
          characters: Array.from({ length: 30 }, (_, index) => ({
            id: `char_${String(index).padStart(6, "0")}`,
            name: `Person ${index}`,
            role: "friend",
            description: "z".repeat(500),
            motivations: "w".repeat(500),
            notes: "n".repeat(500)
          })),
          memories: Array.from({ length: 20 }, (_, index) => ({
            id: `mem_${String(index).padStart(6, "0")}`,
            text: "m".repeat(400),
            importance: "high",
            createdAt: now,
            updatedAt: now
          })),
          settings: { agent: { tone: "t".repeat(500), answerLength } }
        } as never,
        chapters: many as never,
        activeChapter: many[0] as never,
        mode: "discuss"
      });
      expect(encode(instructions).length, `${answerLength} prompt over budget`).toBeLessThan(4_000);
      expect(instructions).toContain("t".repeat(500));
    }
  });
});
