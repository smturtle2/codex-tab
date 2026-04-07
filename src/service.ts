import * as path from "node:path";
import * as vscode from "vscode";

import { CodexResponsesClient } from "./codexClient";
import type { CompletionRequest, ExtensionSettings } from "./types";
import { buildRelativePathLabel, delay, isAbortError, trimSuggestion } from "./util";
import { REQUIRED_MODEL } from "./types";
import type { OutputLogger } from "./log";

export class CodexAutocompleteService {
  private readonly client: CodexResponsesClient;
  private readonly logger: OutputLogger;
  private readonly statusBar: vscode.StatusBarItem;
  private settings: ExtensionSettings;
  private requestSeq = 0;
  private inflight: AbortController | undefined;
  private setupPromise: Promise<void> | undefined;
  private disabledReason: string | undefined;

  public constructor(
    client: CodexResponsesClient,
    logger: OutputLogger,
    settings: ExtensionSettings,
  ) {
    this.client = client;
    this.logger = logger;
    this.settings = settings;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.statusBar.command = "codexAutocomplete.checkSetup";
    this.statusBar.show();
    this.renderStatus("idle");
  }

  public activate(): void {
    void this.checkSetup(false);
  }

  public dispose(): void {
    this.inflight?.abort();
    this.statusBar.dispose();
  }

  public updateSettings(settings: ExtensionSettings): void {
    this.settings = settings;
    this.client.updateConfig(settings.authFilePath, settings.requestTimeoutMs);
    this.setupPromise = undefined;
    this.disabledReason = undefined;
    this.renderStatus("idle");
    void this.checkSetup(false);
  }

  public async reloadAuth(interactive: boolean): Promise<void> {
    this.client.updateConfig(
      this.settings.authFilePath,
      this.settings.requestTimeoutMs,
    );
    this.setupPromise = undefined;
    this.disabledReason = undefined;
    await this.checkSetup(interactive);
  }

  public showLogs(): void {
    this.logger.show();
  }

  public async checkSetup(interactive: boolean): Promise<void> {
    if (this.setupPromise) {
      await this.setupPromise;
      return;
    }

    this.setupPromise = this.doCheckSetup(interactive).finally(() => {
      this.setupPromise = undefined;
    });
    await this.setupPromise;
  }

  public async provideInlineCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | undefined> {
    if (!this.settings.enabled) {
      this.renderStatus("disabled", "disabled");
      return undefined;
    }

    if (vscode.env.uiKind !== vscode.UIKind.Web) {
      this.disabledReason = "desktop vscode is out of scope";
      this.renderStatus("error", "web ui required");
      return undefined;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
      return undefined;
    }
    if (editor.selection && !editor.selection.isEmpty) {
      return undefined;
    }

    try {
      await this.checkSetup(false);
    } catch {
      return undefined;
    }

    const request = this.createCompletionRequest(document, position);
    const seq = ++this.requestSeq;
    this.inflight?.abort();
    const abortController = new AbortController();
    this.inflight = abortController;
    token.onCancellationRequested(() => abortController.abort());

    try {
      await delay(this.settings.debounceMs, abortController.signal);
      if (seq !== this.requestSeq) {
        return undefined;
      }

      this.renderStatus("running");
      const result = await this.client.complete(request, abortController.signal);
      if (seq !== this.requestSeq) {
        return undefined;
      }

      const text = trimSuggestion(request.prefix, result.completion, request.suffix);
      if (!text) {
        this.renderStatus("ready");
        return undefined;
      }

      this.renderStatus("ready");
      return new vscode.InlineCompletionList([
        new vscode.InlineCompletionItem(
          text,
          new vscode.Range(position, position),
        ),
      ]);
    } catch (error) {
      if (isAbortError(error)) {
        return undefined;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Completion failed: ${message}`);
      this.disabledReason = message;
      this.renderStatus("error", "request failed");
      return undefined;
    } finally {
      if (this.inflight === abortController) {
        this.inflight = undefined;
      }
    }
  }

  public async acceptNextWord(): Promise<void> {
    try {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.acceptNextWord");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`accept next word failed: ${message}`);
      void vscode.window.showInformationMessage(
        "Shift+Tab was not handled by the browser or editor. Try the command palette action instead.",
      );
    }
  }

  private async doCheckSetup(interactive: boolean): Promise<void> {
    if (!this.settings.enabled) {
      this.disabledReason = "disabled";
      this.renderStatus("disabled", "disabled");
      return;
    }

    if (vscode.env.uiKind !== vscode.UIKind.Web) {
      this.disabledReason = "desktop vscode is out of scope";
      this.renderStatus("error", "web ui required");
      if (interactive) {
        void vscode.window.showErrorMessage("Codex Tab only supports code-server style web UI hosts.");
      }
      throw new Error(this.disabledReason);
    }

    this.renderStatus("running", "checking");
    try {
      await this.client.ensureModelAvailable();
      this.disabledReason = undefined;
      this.renderStatus("ready");
      if (interactive) {
        void vscode.window.showInformationMessage(
          `Codex Tab is ready. Model ${REQUIRED_MODEL} is available.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Setup check failed: ${message}`);
      this.disabledReason = message;
      this.renderStatus("error", "check setup");
      if (interactive) {
        void vscode.window.showErrorMessage(`Codex Tab setup failed: ${message}`);
      }
      throw error;
    }
  }

  private createCompletionRequest(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): CompletionRequest {
    const fullText = document.getText();
    const offset = document.offsetAt(position);
    const prefix = fullText.slice(
      Math.max(0, offset - this.settings.maxPrefixChars),
      offset,
    );
    const suffix = fullText.slice(
      offset,
      Math.min(fullText.length, offset + this.settings.maxSuffixChars),
    );

    const line = document.lineAt(position.line);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    return {
      languageId: document.languageId,
      relativePath: buildRelativePathLabel(
        workspaceFolder?.uri.fsPath,
        document.uri.fsPath || path.basename(document.uri.path),
      ),
      prefix,
      suffix,
      linePrefix: line.text.slice(0, position.character),
      lineSuffix: line.text.slice(position.character),
      cursorLine: position.line + 1,
      cursorCharacter: position.character + 1,
    };
  }

  private renderStatus(
    state: "idle" | "running" | "ready" | "error" | "disabled",
    detail?: string,
  ): void {
    switch (state) {
      case "idle":
        this.statusBar.text = "$(sparkle) Codex Tab";
        this.statusBar.tooltip = "Codex Tab is idle.";
        break;
      case "running":
        this.statusBar.text = `$(sync~spin) Codex Tab${detail ? `: ${detail}` : ""}`;
        this.statusBar.tooltip = "Codex Tab is checking setup or generating a completion.";
        break;
      case "ready":
        this.statusBar.text = "$(sparkle-filled) Codex Tab";
        this.statusBar.tooltip = "Codex Tab is ready.";
        break;
      case "disabled":
        this.statusBar.text = `$(circle-slash) Codex Tab${detail ? `: ${detail}` : ""}`;
        this.statusBar.tooltip = "Codex Tab is disabled by settings.";
        break;
      case "error":
        this.statusBar.text = `$(warning) Codex Tab${detail ? `: ${detail}` : ""}`;
        this.statusBar.tooltip = this.disabledReason ?? "Codex Tab setup failed.";
        break;
    }
  }
}
