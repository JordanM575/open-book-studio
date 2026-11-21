import { z } from "zod";

/**
 * What one writing task needs from a model, as data. Profiles are author-selected; the studio
 * never infers a task from prompts, manuscript text, history or tool output.
 */
export const taskRequirementsSchema = z.object({
  requiresTools: z.boolean(),
  /**
   * The writing agent needs a context size it can trust. Optional at the schema so a profile
   * without the flag parses; false means the profile makes no context demand. The shipped
   * version-1 profiles all set it.
   */
  requiresKnownContext: z.boolean().optional(),
  requiresImages: z.boolean().optional(),
  minContextLength: z.number().int().positive().nullable().optional()
});
export type TaskRequirements = z.infer<typeof taskRequirementsSchema>;

export const taskProfileSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  purpose: z.string().min(1).max(2000),
  version: z.number().int().positive(),
  requirements: taskRequirementsSchema
});
export type TaskProfile = z.infer<typeof taskProfileSchema>;

/**
 * The accepted version-1 taxonomy (D-204). All three profiles require the writing agent's tool
 * support and a known catalogue context size; none requires images, an output-size target or a
 * numeric context minimum, and none is a tier or a quality claim. The three share the same
 * requirements in this version, so the preview may show the same matches and must say so.
 */
export const WRITING_TASK_PROFILES: readonly TaskProfile[] = Object.freeze([
  Object.freeze({
    id: "discuss-book",
    name: "Discuss the book",
    purpose: "Ask questions, check continuity and plan the next change without editing the manuscript.",
    version: 1,
    requirements: Object.freeze({ requiresTools: true, requiresKnownContext: true })
  }),
  Object.freeze({
    id: "draft-prose",
    name: "Draft new prose",
    purpose: "Write a new scene or passage through the writing agent's editing tools.",
    version: 1,
    requirements: Object.freeze({ requiresTools: true, requiresKnownContext: true })
  }),
  Object.freeze({
    id: "revise-prose",
    name: "Revise existing prose",
    purpose: "Rewrite, tighten or restructure existing text through the writing agent's editing tools.",
    version: 1,
    requirements: Object.freeze({ requiresTools: true, requiresKnownContext: true })
  })
]);
