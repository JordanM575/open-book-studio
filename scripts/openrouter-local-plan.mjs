/**
 * Whether the opt-in OpenRouter local pass may call a provider.
 *
 * The decision is pure. It never reads the process environment, never fetches, and never
 * launches Electron. A missing flag or a missing key is a skip, not a failure: the ordinary
 * suite must stay free of a paid call. An opted-in key that is too short, or a model id the
 * studio would refuse, fails before any request so a bad setup is not billed as a turn.
 */

export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";

/** The same token shape a hand-entered model id must have before the studio keeps it. */
const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._:/@+~-]{0,199}$/;

export function isLocalPassModelId(value) {
  return (
    typeof value === "string" &&
    MODEL_ID.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/**
 * @param {{ flag?: string, apiKey?: string, model?: string }} input
 * @returns {{ action: "skip", reason: string } | { action: "run", model: string } | { action: "fail", reason: string }}
 */
export function planOpenRouterLocalPass(input) {
  const flag = typeof input?.flag === "string" ? input.flag.trim() : "";
  const apiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
  const requested = typeof input?.model === "string" ? input.model.trim() : "";
  if (flag !== "1" || apiKey.length === 0) {
    return {
      action: "skip",
      reason:
        "Skipped the OpenRouter local pass. Set OPENROUTER_LOCAL_PASS=1 and OPENROUTER_API_KEY to run one paid writing turn."
    };
  }
  if (apiKey.length < 8) {
    return { action: "fail", reason: "OPENROUTER_API_KEY is set, but it is too short to be a key. Nothing was called." };
  }
  const model = requested || DEFAULT_OPENROUTER_MODEL;
  if (!isLocalPassModelId(model)) {
    return {
      action: "fail",
      reason: "OPENROUTER_MODEL is not a model id this studio can store. Nothing was called."
    };
  }
  return { action: "run", model };
}
