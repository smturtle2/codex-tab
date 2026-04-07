import * as vscode from "vscode";

import type { LoggerLike } from "./types";

export class OutputLogger implements LoggerLike {
  public readonly channel: vscode.OutputChannel;

  public constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  public info(message: string): void {
    this.write("INFO", message);
  }

  public warn(message: string): void {
    this.write("WARN", message);
  }

  public error(message: string): void {
    this.write("ERROR", message);
  }

  public show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  public dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.channel.appendLine(`[${timestamp}] ${level} ${message}`);
  }
}
