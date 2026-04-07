import type { CompletionRequest } from "./types";

export interface PromptPayload {
  instructions: string;
  input: string;
}

export function buildPrompt(request: CompletionRequest): PromptPayload {
  return {
    instructions: [
      "You are an inline code completion engine.",
      "Continue the code exactly at the cursor.",
      "Return only the text to insert at the cursor.",
      "Do not use markdown, code fences, explanations, or surrounding quotes.",
      "Do not repeat already-typed prefix text.",
      "Use the suffix as a hard constraint and stop before text that is already present after the cursor.",
      "Prefer the smallest useful completion over speculative large rewrites.",
      "If no confident completion exists, return an empty string.",
    ].join(" "),
    input: [
      `Language: ${request.languageId || "plaintext"}`,
      `File: ${request.relativePath}`,
      `Cursor: line ${request.cursorLine}, column ${request.cursorCharacter}`,
      "",
      "Complete the code at <cursor/>.",
      "",
      "<<PREFIX>>",
      request.prefix,
      "<cursor/>",
      "<<SUFFIX>>",
      request.suffix,
      "",
      "Current line prefix:",
      request.linePrefix,
      "",
      "Current line suffix:",
      request.lineSuffix,
    ].join("\n"),
  };
}
