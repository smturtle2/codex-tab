import * as path from "node:path";
import * as vscode from "vscode";

import { AuthRequiredError } from "./auth";
import { CodexResponsesClient } from "./codexClient";
import {
  createSyntheticModelDescriptor,
  findModelDescriptor,
  formatReasoningEffortLabel,
  getReasoningEffortsForModel,
  normalizeModelId,
  resolveDefaultModel,
  validateModelReasoning,
} from "./models";
import type { CompletionRequest, ExtensionSettings, ModelDescriptor } from "./types";
import { buildRelativePathLabel, delay, isAbortError, trimSuggestion } from "./util";
import type { OutputLogger } from "./log";

type StatusState = "idle" | "running" | "ready" | "error" | "disabled" | "needs-auth";

interface ResolvedModelSelection {
  effectiveModel: ModelDescriptor;
}

type ModelPickerItem = vscode.QuickPickItem & (
  | { action: "auto" }
  | { action: "custom" }
  | { action: "model"; model: ModelDescriptor }
);

export class CodexAutocompleteService {
  private readonly client: CodexResponsesClient;
  private readonly logger: OutputLogger;
  private readonly statusBar: vscode.StatusBarItem;
  private settings: ExtensionSettings;
  private requestSeq = 0;
  private inflight: AbortController | undefined;
  private setupPromise: Promise<void> | undefined;
  private modelCache: ModelDescriptor[] | undefined;
  private modelCachePromise: Promise<ModelDescriptor[]> | undefined;
  private disabledReason: string | undefined;
  private resolvedModelId: string | undefined;

  public constructor(
    client: CodexResponsesClient,
    logger: OutputLogger,
    settings: ExtensionSettings,
  ) {
    this.client = client;
    this.logger = logger;
    this.settings = settings;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
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
    this.client.updateConfig({
      reasoningEffort: settings.reasoningEffort,
      requestTimeoutMs: settings.requestTimeoutMs,
    });
    this.setupPromise = undefined;
    this.modelCache = undefined;
    this.modelCachePromise = undefined;
    this.disabledReason = undefined;
    this.resolvedModelId = undefined;
    this.renderStatus("idle");
    void this.checkSetup(false);
  }

  public async signIn(interactive: boolean): Promise<void> {
    if (!this.settings.enabled) {
      this.renderStatus("disabled", "disabled");
      return;
    }

    this.renderStatus("running", "signing in");
    try {
      await this.client.signIn();
      this.setupPromise = undefined;
      this.disabledReason = undefined;
      await this.checkSetup(interactive);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Sign-in failed: ${message}`);
      this.disabledReason = message;
      if (/cancelled/i.test(message)) {
        this.renderStatus("needs-auth");
        if (interactive) {
          void vscode.window.showInformationMessage("Codex Tab sign-in was cancelled.");
        }
        return;
      }
      this.renderStatus("error", "sign in");
      if (interactive) {
        void vscode.window.showErrorMessage(`Codex Tab sign-in failed: ${message}`);
      }
      throw error;
    }
  }

  public async signOut(interactive: boolean): Promise<void> {
    await this.client.signOut();
    this.setupPromise = undefined;
    this.disabledReason = "sign in required";
    this.resolvedModelId = undefined;
    this.renderStatus("needs-auth");
    if (interactive) {
      void vscode.window.showInformationMessage("Codex Tab signed out.");
    }
  }

  public async reloadAuth(interactive: boolean): Promise<void> {
    this.client.invalidate();
    this.setupPromise = undefined;
    this.disabledReason = undefined;
    this.resolvedModelId = undefined;
    await this.checkSetup(interactive);
  }

  public showLogs(): void {
    this.logger.show();
  }

  public async selectModel(): Promise<void> {
    try {
      let models: ModelDescriptor[] = [];
      let loadError: string | undefined;
      try {
        models = await this.loadModels(true);
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          throw error;
        }
        loadError = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Could not refresh model list before opening picker: ${loadError}`);
      }

      const currentModelId = this.getConfiguredModelId();
      const selected = await vscode.window.showQuickPick(
        buildModelPickerItems(models, currentModelId, this.resolvedModelId),
        {
          title: "Codex Tab Model",
          placeHolder: loadError
            ? "Live model list is unavailable. Use account default or enter a custom model ID."
            : "Select the model used for inline completions.",
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (!selected) {
        return;
      }

      if (selected.action === "auto") {
        await this.updateSetting("model", "");
        return;
      }

      if (selected.action === "custom") {
        const customModel = await vscode.window.showInputBox({
          title: "Codex Tab Custom Model",
          prompt: "Enter a model ID to send directly to the Codex responses API.",
          placeHolder: "gpt-5.3-codex",
          value: currentModelId || this.resolvedModelId || "",
          ignoreFocusOut: true,
        });
        if (customModel === undefined) {
          return;
        }

        const normalized = normalizeModelId(customModel);
        if (!normalized) {
          void vscode.window.showWarningMessage(
            "A custom model ID cannot be empty. Use \"Use Account Default\" to clear the model setting.",
          );
          return;
        }

        await this.updateSetting("model", normalized);
        const listedModel = findModelDescriptor(models, normalized);
        if (listedModel) {
          this.warnIfReasoningMayMismatch(listedModel);
        } else {
          this.warnIfReasoningMayMismatch(createSyntheticModelDescriptor(normalized));
        }
        return;
      }

      await this.updateSetting("model", selected.model.id);
      this.warnIfReasoningMayMismatch(selected.model);
    } catch (error) {
      await this.handleSettingsActionError(error, "open model picker");
    }
  }

  public async selectReasoningEffort(): Promise<void> {
    try {
      const model = await this.getReasoningModelDescriptor();
      const reasoningEfforts = getReasoningEffortsForModel(model, model.id);
      const selected = await vscode.window.showQuickPick(
        reasoningEfforts.map((effort) => ({
          label: formatReasoningEffortLabel(effort),
          description: effort === this.settings.reasoningEffort ? "Current" : effort,
          detail:
            model.reasoningEffortSource === "backend"
              ? `Supported by ${model.id}${model.defaultReasoningEffort === effort ? " (default)" : ""}`
              : `Shown using inferred support for ${model.id}${model.defaultReasoningEffort === effort ? " (backend default)" : ""}`,
          effort,
        })),
        {
          title: "Codex Tab Reasoning Effort",
          placeHolder: `Select reasoning effort for ${describeConfiguredModelSetting(this.getConfiguredModelId(), model.id)}.`,
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (!selected) {
        return;
      }

      await this.updateSetting("reasoningEffort", selected.effort);
    } catch (error) {
      await this.handleSettingsActionError(error, "load reasoning options");
    }
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
      const modelId = await this.getActiveModelId();
      const result = await this.client.complete(request, modelId, abortController.signal);
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
      if (error instanceof AuthRequiredError) {
        this.renderStatus("needs-auth");
      } else {
        this.renderStatus("error", "request failed");
      }
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
      if (!(await this.client.hasSession())) {
        throw new AuthRequiredError();
      }

      const resolved = await this.resolveEffectiveModelSelection();
      validateModelReasoning(resolved.effectiveModel, this.settings.reasoningEffort);
      await this.client.probeReady(resolved.effectiveModel.id);
      this.resolvedModelId = resolved.effectiveModel.id;
      this.disabledReason = undefined;
      this.renderStatus("ready");
      if (interactive) {
        void vscode.window.showInformationMessage(
          `Codex Tab is ready. Model ${resolved.effectiveModel.id} is available with ${this.settings.reasoningEffort} reasoning.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Setup check failed: ${message}`);
      this.disabledReason = message;
      if (error instanceof AuthRequiredError) {
        this.renderStatus("needs-auth");
        if (interactive) {
          const action = await vscode.window.showInformationMessage(
            "Codex Tab requires sign-in before completions can run.",
            "Sign In",
          );
          if (action === "Sign In") {
            void this.signIn(true);
          }
        }
      } else {
        this.renderStatus("error", "check setup");
        if (interactive) {
          const action = await vscode.window.showErrorMessage(
            `Codex Tab setup failed: ${message}`,
            "Select Model",
          );
          if (action === "Select Model") {
            void this.selectModel();
          }
        }
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

  private async loadModels(forceRefresh: boolean): Promise<ModelDescriptor[]> {
    if (!forceRefresh && this.modelCache) {
      return this.modelCache;
    }
    if (!forceRefresh && this.modelCachePromise) {
      return await this.modelCachePromise;
    }

    const promise = this.client.listModels().then((models) => {
      this.modelCache = models;
      return models;
    });
    this.modelCachePromise = promise;

    try {
      return await promise;
    } finally {
      if (this.modelCachePromise === promise) {
        this.modelCachePromise = undefined;
      }
    }
  }

  private async tryLoadModels(forceRefresh: boolean): Promise<ModelDescriptor[] | undefined> {
    try {
      return await this.loadModels(forceRefresh);
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Model list is unavailable: ${message}`);
      return undefined;
    }
  }

  private async resolveEffectiveModelSelection(): Promise<ResolvedModelSelection> {
    const configuredModelId = this.getConfiguredModelId();
    if (configuredModelId) {
      return {
        effectiveModel: createSyntheticModelDescriptor(configuredModelId),
      };
    }

    let models: ModelDescriptor[];
    try {
      models = await this.loadModels(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not resolve the account default model from the live model list: ${message}. Use "Codex Tab: Select Model" to choose a listed model or enter a custom model ID.`,
      );
    }

    return {
      effectiveModel: resolveDefaultModel(models),
    };
  }

  private async getReasoningModelDescriptor(): Promise<ModelDescriptor> {
    const configuredModelId = this.getConfiguredModelId();
    if (configuredModelId) {
      const models = await this.tryLoadModels(false);
      return findModelDescriptor(models ?? [], configuredModelId)
        ?? createSyntheticModelDescriptor(configuredModelId);
    }

    const models = await this.tryLoadModels(false);
    if (models?.length) {
      return resolveDefaultModel(models);
    }
    if (this.resolvedModelId) {
      return createSyntheticModelDescriptor(this.resolvedModelId);
    }

    throw new Error(
      "Could not resolve the account default model for reasoning options. Run \"Codex Tab: Select Model\" to choose a listed model or enter a custom model ID.",
    );
  }

  private async getActiveModelId(): Promise<string> {
    if (this.resolvedModelId) {
      return this.resolvedModelId;
    }

    const resolved = await this.resolveEffectiveModelSelection();
    this.resolvedModelId = resolved.effectiveModel.id;
    return resolved.effectiveModel.id;
  }

  private getConfiguredModelId(): string {
    return normalizeModelId(this.settings.model);
  }

  private warnIfReasoningMayMismatch(model: ModelDescriptor): void {
    const supportedEfforts = getReasoningEffortsForModel(model, model.id);
    if (!supportedEfforts.includes(this.settings.reasoningEffort)) {
      const recommended = model.defaultReasoningEffort ?? supportedEfforts[0];
      void vscode.window.showWarningMessage(
        `Model ${model.id} may not support reasoning effort "${this.settings.reasoningEffort}". Run "Codex Tab: Select Reasoning Effort" to adjust it.${recommended ? ` Recommended: ${recommended}.` : ""}`,
      );
    }
  }

  private async updateSetting(
    key: "model" | "reasoningEffort",
    value: string,
  ): Promise<void> {
    await vscode.workspace
      .getConfiguration("codexAutocomplete")
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  private async handleSettingsActionError(
    error: unknown,
    action: string,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Could not ${action}: ${message}`);
    if (error instanceof AuthRequiredError) {
      this.renderStatus("needs-auth");
      const selected = await vscode.window.showInformationMessage(
        "Codex Tab requires sign-in before settings can be loaded.",
        "Sign In",
      );
      if (selected === "Sign In") {
        void this.signIn(true);
      }
      return;
    }

    void vscode.window.showErrorMessage(`Codex Tab could not ${action}: ${message}`);
  }

  private renderStatus(state: StatusState, detail?: string): void {
    switch (state) {
      case "idle":
        this.statusBar.command = "codexAutocomplete.checkSetup";
        this.statusBar.text = "$(sparkle) Codex Tab";
        this.statusBar.tooltip = this.buildStatusTooltip("Codex Tab is idle.");
        break;
      case "running":
        this.statusBar.command = "codexAutocomplete.checkSetup";
        this.statusBar.text = `$(sync~spin) Codex Tab${detail ? `: ${detail}` : ""}`;
        this.statusBar.tooltip = this.buildStatusTooltip(
          "Codex Tab is checking setup or generating a completion.",
        );
        break;
      case "ready":
        this.statusBar.command = "codexAutocomplete.checkSetup";
        this.statusBar.text = "$(sparkle-filled) Codex Tab";
        this.statusBar.tooltip = this.buildStatusTooltip("Codex Tab is ready.");
        break;
      case "disabled":
        this.statusBar.command = "codexAutocomplete.checkSetup";
        this.statusBar.text = `$(circle-slash) Codex Tab${detail ? `: ${detail}` : ""}`;
        this.statusBar.tooltip = this.buildStatusTooltip("Codex Tab is disabled by settings.");
        break;
      case "needs-auth":
        this.statusBar.command = "codexAutocomplete.signIn";
        this.statusBar.text = "$(account) Codex Tab: sign in";
        this.statusBar.tooltip = this.buildStatusTooltip(
          this.disabledReason ?? "Codex Tab requires sign-in.",
        );
        break;
      case "error":
        this.statusBar.command = "codexAutocomplete.checkSetup";
        this.statusBar.text = `$(warning) Codex Tab${detail ? `: ${detail}` : ""}`;
        this.statusBar.tooltip = this.buildStatusTooltip(
          this.disabledReason ?? "Codex Tab setup failed.",
        );
        break;
    }
  }

  private buildStatusTooltip(summary: string): string {
    return [
      summary,
      `Model: ${describeConfiguredModelSetting(this.getConfiguredModelId(), this.resolvedModelId)}`,
      `Reasoning: ${this.settings.reasoningEffort}`,
    ].join("\n");
  }
}

function buildModelPickerItems(
  models: ModelDescriptor[],
  currentModelId: string,
  resolvedModelId: string | undefined,
): ModelPickerItem[] {
  const items: ModelPickerItem[] = [
    {
      label: "Use Account Default",
      description: currentModelId ? "Auto" : "Current",
      detail: resolvedModelId
        ? `Clear the model setting and use the live account default. Last resolved: ${resolvedModelId}.`
        : "Clear the model setting and use the live account default from the model list.",
      action: "auto",
    },
    {
      label: "Enter Custom Model ID...",
      description: currentModelId && !findModelDescriptor(models, currentModelId) ? "Current" : "Custom",
      detail: "Use a model directly with /responses even if it is absent from the live model list.",
      action: "custom",
    },
  ];

  if (currentModelId && !findModelDescriptor(models, currentModelId)) {
    const synthetic = createSyntheticModelDescriptor(currentModelId);
    items.push({
      label: synthetic.label,
      description: "Current custom model",
      detail: `${describeReasoningSupport(synthetic)}; not present in the live model list`,
      action: "model",
      model: synthetic,
    });
  }

  return items.concat(
    models.map((model) => ({
      label: model.label,
      description: model.id === currentModelId ? `Current - ${model.id}` : model.id,
      detail: describeReasoningSupport(model),
      action: "model" as const,
      model,
    })),
  );
}

function describeConfiguredModelSetting(
  configuredModelId: string,
  resolvedModelId: string | undefined,
): string {
  if (configuredModelId) {
    return configuredModelId;
  }
  return resolvedModelId ? `auto (${resolvedModelId})` : "auto";
}

function describeReasoningSupport(model: ModelDescriptor): string {
  const efforts = getReasoningEffortsForModel(model);
  const source =
    model.reasoningEffortSource === "backend" ? "reported by backend" : "inferred";
  const defaultEffort = model.defaultReasoningEffort
    ? `; default: ${model.defaultReasoningEffort}`
    : "";
  return `Reasoning: ${efforts.join(", ")} (${source}${defaultEffort})`;
}
