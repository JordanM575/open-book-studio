import { describe, expect, test } from "bun:test";
import { insertTranscript, replaceTranscript } from "../src/lib/voice-text";

describe("transcript insertion", () => {
  test("adds spaces only where the surrounding text needs them", () => {
    expect(insertTranscript("One two.", "three four", 8, 8)).toEqual({
      text: "One two. three four",
      caret: 19
    });
  });

  test("does not double an existing space", () => {
    expect(insertTranscript("One two. ", "three", 9, 9)).toEqual({
      text: "One two. three",
      caret: 14
    });
  });

  test("inserts between words and before punctuation", () => {
    expect(insertTranscript("Hello world.", "there ", 6, 6)).toEqual({
      text: "Hello there world.",
      caret: 12
    });
    expect(insertTranscript("Wait.", "a moment", 4, 4)).toEqual({
      text: "Wait a moment.",
      caret: 13
    });
  });

  test("keeps a selection and inserts at its start", () => {
    expect(insertTranscript("One old two", "new", 4, 7)).toEqual({
      text: "One new old two",
      caret: 8
    });
  });

  test("replaces a selection only when asked", () => {
    expect(replaceTranscript("One old two", "new", 4, 7)).toEqual({
      text: "One new two",
      caret: 7
    });
  });

  test("an empty selection inserts the same way on either path", () => {
    expect(replaceTranscript("One two.", "three four", 8, 8)).toEqual(insertTranscript("One two.", "three four", 8, 8));
  });

  test("keeps line breaks and trims only outer horizontal space", () => {
    expect(insertTranscript('"Verse"', "  spoken\nwords ", 0, 0)).toEqual({
      text: 'spoken\nwords "Verse"',
      caret: 13
    });
    expect(insertTranscript("Hi", "a\r\nb", 2, 2)).toEqual({
      text: "Hi a\nb",
      caret: 6
    });
    expect(insertTranscript("Hi", "\nthere", 2, 2)).toEqual({
      text: "Hi\nthere",
      caret: 8
    });
    expect(insertTranscript("Hi", "there\n", 0, 0)).toEqual({
      text: "there\nHi",
      caret: 6
    });
    expect(insertTranscript("", "  a \n b  ", 0, 0)).toEqual({
      text: "a \n b",
      caret: 5
    });
  });

  test("a newline is not silence", () => {
    expect(insertTranscript("Hello", "\n", 0, 0)).toEqual({
      text: "\nHello",
      caret: 1
    });
    expect(replaceTranscript("Hello", "\r\n", 5, 5)).toEqual({
      text: "Hello\n",
      caret: 6
    });
  });

  test("leaves the chapter untouched for silence", () => {
    expect(insertTranscript("Text", "   ", 0, 0)).toBeNull();
    expect(replaceTranscript("Text", " \t ", 1, 3)).toBeNull();
  });
});
