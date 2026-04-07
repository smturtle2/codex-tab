import * as vscode from "vscode";

import { CodexAuthStore } from "./auth";
import { CodexResponsesClient } from "./codexClient";
import { NodeHttpClient } from "./http";
import { OutputLogger } from "./log";
import { normalizeModelId, normalizeReasoningEffort } from "./models";
import { CodexAutocompleteService } from "./service";
import type { AuthUi, ExtensionSettings, SecretStore } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  const logger = new OutputLogger("Codex Tab");
  const settings = readSettings();
  const httpClient = new NodeHttpClient();
  const authStore = new CodexAuthStore(
    new VscodeSecretStore(context.secrets),
    new VscodeAuthUi(logger),
    httpClient,
    logger,
  );
  const client = new CodexResponsesClient(
    authStore,
    httpClient,
    logger,
    {
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      requestTimeoutMs: settings.requestTimeoutMs,
    },
  );
  const service = new CodexAutocompleteService(client, logger, settings);

  context.subscriptions.push(
    logger,
    service,
    vscode.languages.registerInlineCompletionItemProvider(
      [{ scheme: "file" }],
      {
        provideInlineCompletionItems(document, position, inlineContext, token) {
          if (inlineContext.selectedCompletionInfo) {
            return undefined;
          }
          return service.provideInlineCompletion(document, position, token);
        },
      },
    ),
    vscode.commands.registerCommand("codexAutocomplete.signIn", async () => {
      await service.signIn(true);
    }),
    vscode.commands.registerCommand("codexAutocomplete.signOut", async () => {
      await service.signOut(true);
    }),
    vscode.commands.registerCommand("codexAutocomplete.checkSetup", async () => {
      await service.checkSetup(true);
    }),
    vscode.commands.registerCommand("codexAutocomplete.reloadAuth", async () => {
      await service.reloadAuth(true);
    }),
    vscode.commands.registerCommand("codexAutocomplete.openLogs", () => {
      service.showLogs();
    }),
    vscode.commands.registerCommand("codexAutocomplete.selectModel", async () => {
      await service.selectModel();
    }),
    vscode.commands.registerCommand("codexAutocomplete.selectReasoningEffort", async () => {
      await service.selectReasoningEffort();
    }),
    vscode.commands.registerCommand("codexAutocomplete.acceptNextWord", async () => {
      await service.acceptNextWord();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("codexAutocomplete")) {
        return;
      }
      service.updateSettings(readSettings());
    }),
  );

  service.activate();
}

export function deactivate(): void {}

function readSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration("codexAutocomplete");
  return {
    enabled: config.get<boolean>("enabled", true),
    model: normalizeModelId(config.get<string>("model")),
    reasoningEffort: normalizeReasoningEffort(
      config.get<string>("reasoningEffort"),
    ),
    debounceMs: config.get<number>("debounceMs", 250),
    maxPrefixChars: config.get<number>("maxPrefixChars", 4000),
    maxSuffixChars: config.get<number>("maxSuffixChars", 1200),
    requestTimeoutMs: config.get<number>("requestTimeoutMs", 20_000),
  };
}

class VscodeSecretStore implements SecretStore {
  private readonly secrets: vscode.SecretStorage;

  public constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
  }

  public async get(key: string): Promise<string | undefined> {
    return await this.secrets.get(key);
  }

  public async store(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
  }

  public async delete(key: string): Promise<void> {
    await this.secrets.delete(key);
  }
}

class VscodeAuthUi implements AuthUi {
  private readonly logger: OutputLogger;

  public constructor(logger: OutputLogger) {
    this.logger = logger;
  }

  public async authorize(authorizeUrl: string): Promise<string | undefined> {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl));
    if (!opened) {
      this.logger.warn("VS Code could not open the OAuth URL automatically");
      void vscode.window.showWarningMessage(
        "Codex Tab could not open the sign-in URL automatically. Copy it from the output log, finish sign-in, then paste the callback URL.",
      );
    } else {
      void vscode.window.showInformationMessage(
        "Complete the Codex sign-in flow in the browser, then paste the callback URL.",
      );
    }

    return await vscode.window.showInputBox({
      title: "Codex Tab Sign In",
      prompt: "Paste the full localhost callback URL from the OAuth flow.",
      placeHolder: "http://localhost:1455/auth/callback?code=...",
      ignoreFocusOut: true,
    });
  }
}
