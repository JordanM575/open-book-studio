/**
 * Markdown folder destination names (spec 035 T016/T017, D-202/D-203).
 *
 * Pure: no filesystem, no Library and no schema. The renderer uses this for inline feedback;
 * the main process validates again and is authoritative. HTML `maxLength` is not relied on
 * because it counts UTF-16 code units rather than Unicode characters and UTF-8 bytes.
 */

export const MARKDOWN_FOLDER_NAME_MAX_CHARS = 60;
export const MARKDOWN_FOLDER_NAME_MAX_BYTES = 180;

/** The one suffix every suggested name ends with, reserved inside both limits. */
const SUGGESTION_SUFFIX = "-markdown";

const FORBIDDEN = /[/\\<>:"|?*]/u;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const encoder = new TextEncoder();

export function normalizeMarkdownFolderName(value: string): string {
  return value.normalize("NFC");
}

function refuse(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

/**
 * Validate one author-supplied folder name, in the recorded order. The accepted name is the
 * exact NFC form the destination is written under.
 */
export function validateMarkdownFolderName(
  value: string
): { ok: true; name: string } | { ok: false; message: string } {
  const name = normalizeMarkdownFolderName(value);
  if (name.trim() === "") return refuse("Enter a folder name.");
  if (name === "." || name === "..") return refuse("That folder name is not available. Choose another name.");
  if (FORBIDDEN.test(name)) return refuse('A folder name cannot contain / \\ < > : " | ? or *.');
  if (CONTROL_OR_FORMAT.test(name)) {
    return refuse("A folder name cannot contain control or invisible characters.");
  }
  if (name.startsWith(".")) return refuse("A folder name cannot start with a dot.");
  if (name.endsWith(" ") || name.endsWith(".")) {
    return refuse("A folder name cannot end with a space or a dot.");
  }
  const device = name.split(".")[0] ?? name;
  if (WINDOWS_DEVICE.test(device)) {
    return refuse("That folder name is reserved by the operating system. Choose another name.");
  }
  if (Array.from(name).length > MARKDOWN_FOLDER_NAME_MAX_CHARS) {
    return refuse(`Use ${MARKDOWN_FOLDER_NAME_MAX_CHARS} characters or fewer for the folder name.`);
  }
  if (encoder.encode(name).byteLength > MARKDOWN_FOLDER_NAME_MAX_BYTES) {
    return refuse(`Use ${MARKDOWN_FOLDER_NAME_MAX_BYTES} bytes or fewer for the folder name.`);
  }
  return { ok: true, name };
}

/**
 * Suggest a folder name from the book title. The `-markdown` suffix is reserved inside the
 * character and byte budgets, so the result always passes `validateMarkdownFolderName`.
 */
export function suggestMarkdownFolderName(title: string): string {
  const slug = normalizeMarkdownFolderName(title)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const characterBudget = MARKDOWN_FOLDER_NAME_MAX_CHARS - SUGGESTION_SUFFIX.length;
  const byteBudget = MARKDOWN_FOLDER_NAME_MAX_BYTES - encoder.encode(SUGGESTION_SUFFIX).byteLength;
  let kept = "";
  let bytes = 0;
  for (const character of Array.from(slug).slice(0, characterBudget)) {
    bytes += encoder.encode(character).byteLength;
    if (bytes > byteBudget) break;
    kept += character;
  }
  const base = kept.replace(/-+$/, "") || "untitled-book";
  return `${base}${SUGGESTION_SUFFIX}`;
}
