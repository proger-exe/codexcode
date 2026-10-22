import type { LspPosition, LspTextEdit } from "../types";

type NormalizedEdit = {
  start: number;
  end: number;
  newText: string;
};

const splitLines = (text: string): string[] => text.split("\n");

const lineCharacterToOffset = (text: string, position: LspPosition): number => {
  const lines = splitLines(text);
  let offset = 0;

  for (let lineIndex = 0; lineIndex < position.line; lineIndex += 1) {
    offset += (lines[lineIndex] ?? "").length + 1;
  }

  const line = lines[position.line] ?? "";
  const targetUtf16 = Math.max(position.character, 0);
  let utf16Count = 0;
  let stringIndex = 0;

  while (stringIndex < line.length && utf16Count < targetUtf16) {
    const codePoint = line.codePointAt(stringIndex);
    if (codePoint === undefined) {
      break;
    }
    const consumed = codePoint > 0xffff ? 2 : 1;
    utf16Count += consumed;
    stringIndex += codePoint > 0xffff ? 2 : 1;
  }

  return offset + stringIndex;
};

const normalizeEdit = (text: string, edit: LspTextEdit): NormalizedEdit => {
  if (!edit.range) {
    return {
      start: 0,
      end: text.length,
      newText: edit.newText
    };
  }

  return {
    start: lineCharacterToOffset(text, edit.range.start),
    end: lineCharacterToOffset(text, edit.range.end),
    newText: edit.newText
  };
};

export const applyTextEdits = (text: string, edits: LspTextEdit[]): string => {
  const normalized = edits
    .map((edit) => normalizeEdit(text, edit))
    .sort((left, right) => right.start - left.start || right.end - left.end);

  let nextText = text;

  for (const edit of normalized) {
    nextText = `${nextText.slice(0, edit.start)}${edit.newText}${nextText.slice(edit.end)}`;
  }

  return nextText;
};
