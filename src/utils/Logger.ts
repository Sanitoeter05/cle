/**
 * Centralized logging utility to avoid duplication.
 */

import * as vscode from "vscode";

export class Logger {
  private outputChannel: vscode.OutputChannel;

  constructor(channelName: string = "Function Scanner") {
    this.outputChannel = vscode.window.createOutputChannel(channelName);
  }

  info(message: string): void {
    this.log(message, "INFO");
  }

  warn(message: string): void {
    this.log(message, "WARN");
  }

  error(message: string, error?: Error): void {
    const errorMsg = error ? `${message}: ${error.message}` : message;
    this.log(errorMsg, "ERROR");
  }

  debug(message: string): void {
    this.log(message, "DEBUG");
  }

  private log(message: string, level: string): void {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] [${level}] ${message}`;
    this.outputChannel.appendLine(formatted);
  }

  show(): void {
    this.outputChannel.show();
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}
