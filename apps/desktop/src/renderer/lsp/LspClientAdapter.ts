import type { editor as MonacoEditor, IDisposable, IRange, languages, MarkerSeverity } from "monaco-editor";
import {
  type DesktopApi,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspEvent,
  type LspFormatRequest,
  type LspHover,
  type LspPosition,
  type LspTextEdit,
  type ProjectSettings
} from "@codex-code/core";

type ManagedDocument = {
  text: string;
  version: number;
  changeTimer: number | null;
  inflightSync: Promise<void> | null;
  lastSyncedVersion: number;
  workspaceRoot: string;
};

type MonacoModule = typeof import("monaco-editor");

const diagnosticsOwner = "codex-lsp";

const pathToFileUri = (filePath: string): string => `file://${encodeURI(filePath)}`;

const fileUriToPath = (uri: string): string => decodeURIComponent(new URL(uri).pathname);

const lineCharacterToOffset = (text: string, position: LspPosition): number => {
  const lines = text.split("\n");
  let offset = 0;

  for (let lineIndex = 0; lineIndex < position.line; lineIndex += 1) {
    offset += (lines[lineIndex] ?? "").length + 1;
  }

  const line = lines[position.line] ?? "";
  let utf16Count = 0;
  let stringIndex = 0;

  while (stringIndex < line.length && utf16Count < position.character) {
    const codePoint = line.codePointAt(stringIndex);
    if (codePoint === undefined) {
      break;
    }

    utf16Count += codePoint > 0xffff ? 2 : 1;
    stringIndex += codePoint > 0xffff ? 2 : 1;
  }

  return offset + stringIndex;
};

const applyTextEdits = (text: string, edits: LspTextEdit[]): string => {
  const normalized = edits
    .map((edit) => ({
      start: edit.range ? lineCharacterToOffset(text, edit.range.start) : 0,
      end: edit.range ? lineCharacterToOffset(text, edit.range.end) : text.length,
      newText: edit.newText
    }))
    .sort((left, right) => right.start - left.start || right.end - left.end);

  let nextText = text;

  for (const edit of normalized) {
    nextText = `${nextText.slice(0, edit.start)}${edit.newText}${nextText.slice(edit.end)}`;
  }

  return nextText;
};

const toLspPosition = (position: { lineNumber: number; column: number }): LspPosition => ({
  line: Math.max(position.lineNumber - 1, 0),
  character: Math.max(position.column - 1, 0)
});

const toMonacoRange = (
  monaco: MonacoModule,
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
): IRange => ({
  startLineNumber: range.start.line + 1,
  startColumn: range.start.character + 1,
  endLineNumber: range.end.line + 1,
  endColumn: range.end.character + 1
});

const toMarkerSeverity = (monaco: MonacoModule, severity?: number): MarkerSeverity => {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Info;
  }
};

const hoverContentsToMarkdown = (contents: LspHover["contents"]): string => {
  const parts = Array.isArray(contents) ? contents : [contents];
  return parts
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      return part.value;
    })
    .filter(Boolean)
    .join("\n\n");
};

const completionKindMap = (monaco: MonacoModule): Record<number, languages.CompletionItemKind> => ({
  1: monaco.languages.CompletionItemKind.Text,
  2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function,
  4: monaco.languages.CompletionItemKind.Constructor,
  5: monaco.languages.CompletionItemKind.Field,
  6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class,
  8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Unit,
  12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet,
  16: monaco.languages.CompletionItemKind.Color,
  17: monaco.languages.CompletionItemKind.File,
  18: monaco.languages.CompletionItemKind.Reference,
  19: monaco.languages.CompletionItemKind.Folder,
  20: monaco.languages.CompletionItemKind.EnumMember,
  21: monaco.languages.CompletionItemKind.Constant,
  22: monaco.languages.CompletionItemKind.Struct,
  23: monaco.languages.CompletionItemKind.Event,
  24: monaco.languages.CompletionItemKind.Operator,
  25: monaco.languages.CompletionItemKind.TypeParameter
});

export class LspClientAdapter {
  private readonly documents = new Map<string, ManagedDocument>();

  private readonly diagnostics = new Map<string, LspDiagnostic[]>();

  private readonly completionEpochs = new Map<string, number>();

  private disposables: IDisposable[] = [];

  private monaco: MonacoModule | null = null;

  private unsubscribe: (() => void) | null = null;

  public constructor(private readonly api: DesktopApi) {}

  public bindMonaco(monaco: MonacoModule): void {
    this.monaco = monaco;
    this.disposeProviders();
    this.disposables = [
      monaco.languages.registerCompletionItemProvider("python", {
        triggerCharacters: [".", "\"", "'", "/"],
        provideCompletionItems: async (model, position, _context, cancellationToken) => {
          const filePath = fileUriToPath(model.uri.toString());
          const workspaceRoot = this.documents.get(filePath)?.workspaceRoot;
          if (!workspaceRoot) {
            return { suggestions: [] };
          }

          const completionEpoch = this.nextCompletionEpoch(filePath);
          await this.flushDocumentChanges(filePath);

          if (
            cancellationToken.isCancellationRequested ||
            !this.isLatestCompletionEpoch(filePath, completionEpoch)
          ) {
            return { suggestions: [] };
          }

          const result = await this.api.lspGetCompletion({
            workspaceRoot,
            filePath,
            position: toLspPosition(position)
          });

          if (
            cancellationToken.isCancellationRequested ||
            !this.isLatestCompletionEpoch(filePath, completionEpoch)
          ) {
            return { suggestions: [] };
          }

          const kindMap = completionKindMap(monaco);
          return {
            suggestions: result.items.map((item: LspCompletionItem) => {
              const suggestion: languages.CompletionItem = {
                label: item.label,
                kind: item.kind ? kindMap[item.kind] ?? monaco.languages.CompletionItemKind.Text : monaco.languages.CompletionItemKind.Text,
                detail: item.detail,
                documentation: item.documentation ? { value: hoverContentsToMarkdown(item.documentation) } : undefined,
                sortText: item.sortText,
                filterText: item.filterText,
                preselect: item.preselect,
                commitCharacters: item.commitCharacters,
                insertText: item.insertText ?? item.label,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: position.column,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column
                },
                insertTextRules:
                  item.insertTextFormat === 2
                    ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                    : monaco.languages.CompletionItemInsertTextRule.None
              };

              if (item.textEdit?.range) {
                suggestion.range = toMonacoRange(monaco, item.textEdit.range);
                suggestion.insertText = item.textEdit.newText;
              } else {
                suggestion.insertText = item.insertText ?? item.label;
              }

              if (item.additionalTextEdits?.length) {
                suggestion.additionalTextEdits = item.additionalTextEdits
                  .filter((edit) => edit.range)
                  .map((edit) => ({
                    range: toMonacoRange(monaco, edit.range!),
                    text: edit.newText
                  }));
              }

              return suggestion;
            })
          };
        }
      }),
      monaco.languages.registerHoverProvider("python", {
        provideHover: async (model, position) => {
          const workspaceRoot = this.documents.get(fileUriToPath(model.uri.toString()))?.workspaceRoot;
          if (!workspaceRoot) {
            return null;
          }

          const hover = await this.api.lspGetHover({
            workspaceRoot,
            filePath: fileUriToPath(model.uri.toString()),
            position: toLspPosition(position)
          });

          if (!hover) {
            return null;
          }

          return {
            contents: [{ value: hoverContentsToMarkdown(hover.contents) }],
            range: hover.range ? toMonacoRange(monaco, hover.range) : undefined
          };
        }
      }),
      monaco.languages.registerDefinitionProvider("python", {
        provideDefinition: async (model, position) => {
          const workspaceRoot = this.documents.get(fileUriToPath(model.uri.toString()))?.workspaceRoot;
          if (!workspaceRoot) {
            return [];
          }

          const definitions = await this.api.lspGetDefinition({
            workspaceRoot,
            filePath: fileUriToPath(model.uri.toString()),
            position: toLspPosition(position)
          });

          return definitions.map((definition) => {
            if ("targetUri" in definition) {
              return {
                originSelectionRange: definition.originSelectionRange
                  ? toMonacoRange(monaco, definition.originSelectionRange)
                  : undefined,
                uri: monaco.Uri.parse(definition.targetUri),
                range: toMonacoRange(monaco, definition.targetRange),
                selectionRange: toMonacoRange(monaco, definition.targetSelectionRange)
              };
            }

            return {
              uri: monaco.Uri.parse(definition.uri),
              range: toMonacoRange(monaco, definition.range)
            };
          });
        }
      })
    ];
    this.applyAllDiagnostics();
  }

  public subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.api.subscribeLspEvents((event) => {
      this.handleEvent(event);
    });
  }

  public dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const document of this.documents.values()) {
      if (document.changeTimer) {
        window.clearTimeout(document.changeTimer);
      }
    }
    this.documents.clear();
    this.completionEpochs.clear();
    this.disposeProviders();
  }

  public resetProject(): void {
    for (const [filePath, document] of this.documents.entries()) {
      if (document.changeTimer) {
        window.clearTimeout(document.changeTimer);
      }
      void this.api.lspCloseDocument({
        workspaceRoot: document.workspaceRoot,
        filePath
      });
    }
    this.documents.clear();
    this.completionEpochs.clear();
    this.clearAllMarkers();
  }

  public async ensureDocumentOpen(workspaceRoot: string, filePath: string, text: string): Promise<void> {
    const existing = this.documents.get(filePath);
    if (!existing) {
      this.documents.set(filePath, {
        workspaceRoot,
        text,
        version: 1,
        changeTimer: null,
        inflightSync: null,
        lastSyncedVersion: 1
      });
      await this.api.lspOpenDocument({
        workspaceRoot,
        filePath,
        text
      });
      return;
    }

    existing.workspaceRoot = workspaceRoot;
    if (existing.text !== text) {
      existing.text = text;
      existing.version += 1;
      await this.syncDocumentChange(filePath, existing, existing.version, text);
    }
  }

  public async prewarmDocument(workspaceRoot: string, filePath: string): Promise<void> {
    await this.api.lspPrewarm({
      workspaceRoot,
      filePath
    });
  }

  public notifyDocumentChange(workspaceRoot: string, filePath: string, text: string, debounceMs: number): void {
    const existing = this.documents.get(filePath);
    if (!existing) {
      void this.ensureDocumentOpen(workspaceRoot, filePath, text);
      return;
    }

    existing.text = text;
    existing.version += 1;

    if (existing.changeTimer) {
      window.clearTimeout(existing.changeTimer);
    }

    existing.changeTimer = window.setTimeout(() => {
      existing.changeTimer = null;
      void this.flushDocumentChanges(filePath).catch(() => undefined);
    }, debounceMs);
  }

  public async notifyDocumentSave(workspaceRoot: string, filePath: string, text: string): Promise<void> {
    await this.flushDocumentChanges(filePath);

    await this.api.lspSaveDocument({
      workspaceRoot,
      filePath,
      text
    });
  }

  public async notifyDocumentClose(workspaceRoot: string, filePath: string): Promise<void> {
    const existing = this.documents.get(filePath);
    if (existing?.changeTimer) {
      window.clearTimeout(existing.changeTimer);
    }
    this.documents.delete(filePath);
    this.completionEpochs.delete(filePath);
    await this.api.lspCloseDocument({
      workspaceRoot,
      filePath
    });
    this.clearMarkersForPath(filePath);
  }

  public async getDefinition(workspaceRoot: string, filePath: string, position: LspPosition) {
    return this.api.lspGetDefinition({
      workspaceRoot,
      filePath,
      position
    });
  }

  public async formatDocument(
    request: LspFormatRequest,
    currentText: string
  ): Promise<{ nextText: string; edits: LspTextEdit[] }> {
    const edits = await this.api.lspFormatDocument(request);
    return {
      edits,
      nextText: applyTextEdits(currentText, edits)
    };
  }

  public async getStatus(workspaceRoot: string, filePath?: string) {
    return this.api.getLspStatus({
      workspaceRoot,
      filePath
    });
  }

  public async restartServer(workspaceRoot: string, languageId: string) {
    return this.api.restartLspServer(workspaceRoot, languageId);
  }

  public async stopServer(workspaceRoot: string, languageId: string) {
    return this.api.stopLspServer(workspaceRoot, languageId);
  }

  private async flushDocumentChanges(filePath: string): Promise<void> {
    const document = this.documents.get(filePath);
    if (!document) {
      return;
    }

    if (document.changeTimer) {
      window.clearTimeout(document.changeTimer);
      document.changeTimer = null;
    }

    while (document.lastSyncedVersion < document.version || document.inflightSync) {
      if (document.inflightSync) {
        await document.inflightSync;
        continue;
      }

      await this.syncDocumentChange(filePath, document, document.version, document.text);
    }
  }

  private async syncDocumentChange(
    filePath: string,
    document: ManagedDocument,
    version: number,
    text: string
  ): Promise<void> {
    const syncPromise = this.api
      .lspChangeDocument({
        workspaceRoot: document.workspaceRoot,
        filePath,
        text,
        version
      })
      .then(() => {
        document.lastSyncedVersion = Math.max(document.lastSyncedVersion, version);
      })
      .finally(() => {
        if (document.inflightSync === syncPromise) {
          document.inflightSync = null;
        }
      });

    document.inflightSync = syncPromise;
    await syncPromise;
  }

  private nextCompletionEpoch(filePath: string): number {
    const nextEpoch = (this.completionEpochs.get(filePath) ?? 0) + 1;
    this.completionEpochs.set(filePath, nextEpoch);
    return nextEpoch;
  }

  private isLatestCompletionEpoch(filePath: string, epoch: number): boolean {
    return this.completionEpochs.get(filePath) === epoch;
  }

  private handleEvent(event: LspEvent): void {
    if (event.kind === "diagnostics") {
      this.diagnostics.set(event.filePath, event.diagnostics);
      this.applyDiagnosticsForPath(event.filePath);
      return;
    }

    if (event.kind === "status" && event.status.status === "stopped") {
      this.clearAllMarkers();
    }
  }

  private applyAllDiagnostics(): void {
    for (const filePath of this.diagnostics.keys()) {
      this.applyDiagnosticsForPath(filePath);
    }
  }

  private applyDiagnosticsForPath(filePath: string): void {
    const monaco = this.monaco;
    if (!monaco) {
      return;
    }

    const targetUri = pathToFileUri(filePath);
    const model = monaco.editor.getModel(monaco.Uri.parse(targetUri));
    if (!model) {
      return;
    }

    const diagnostics = this.diagnostics.get(filePath) ?? [];
    monaco.editor.setModelMarkers(
      model,
      diagnosticsOwner,
      diagnostics.map((diagnostic) => ({
        ...toMonacoRange(monaco, diagnostic.range),
        severity: toMarkerSeverity(monaco, diagnostic.severity),
        code: diagnostic.code ? String(diagnostic.code) : undefined,
        source: diagnostic.source,
        message: diagnostic.message
      }))
    );
  }

  private clearMarkersForPath(filePath: string): void {
    if (!this.monaco) {
      return;
    }

    const model = this.monaco.editor.getModel(this.monaco.Uri.parse(pathToFileUri(filePath)));
    if (!model) {
      return;
    }

    this.monaco.editor.setModelMarkers(model, diagnosticsOwner, []);
  }

  private clearAllMarkers(): void {
    if (!this.monaco) {
      return;
    }

    for (const model of this.monaco.editor.getModels()) {
      this.monaco.editor.setModelMarkers(model, diagnosticsOwner, []);
    }
  }

  private disposeProviders(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}
