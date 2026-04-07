import * as vscode from "vscode";

import { CodexAuthStore } from "./auth";
import { CodexResponsesClient } from "./codexClient";
import { NodeHttpClient } from "./http";
import { OutputLogger } from "./log";
import { CodexAutocompleteService } from "./service";
import type { ExtensionSettings } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  const logger = new OutputLogger("Codex Tab");
  const settings = readSettings();
  const httpClient = new NodeHttpClient();
  const authStore = new CodexAuthStore(settings.authFilePath, httpClient, logger);
  const client = new CodexResponsesClient(
    authStore,
    httpClient,
    logger,
    settings.requestTimeoutMs,
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
    vscode.commands.registerCommand("codexAutocomplete.checkSetup", async () => {
      await service.checkSetup(true);
    }),
    vscode.commands.registerCommand("codexAutocomplete.reloadAuth", async () => {
      await service.reloadAuth(true);
    }),
    vscode.commands.registerCommand("codexAutocomplete.openLogs", () => {
      service.showLogs();
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
    debounceMs: config.get<number>("debounceMs", 250),
    maxPrefixChars: config.get<number>("maxPrefixChars", 4000),
    maxSuffixChars: config.get<number>("maxSuffixChars", 1200),
    authFilePath: config.get<string>("authFilePath", "~/.codex/auth.json"),
    requestTimeoutMs: config.get<number>("requestTimeoutMs", 20_000),
  };
}
