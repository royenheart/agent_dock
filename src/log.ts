import * as vscode from 'vscode';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  private channel?: vscode.OutputChannel;
  private level: Level = 'info';

  init(): void {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel('Agent Dock');
    }
    const configured = vscode.workspace.getConfiguration('agentDock').get<string>('logLevel', 'info');
    this.level = (configured as Level) || 'info';
  }

  refreshLevel(): void {
    if (this.channel) {
      const configured = vscode.workspace.getConfiguration('agentDock').get<string>('logLevel', 'info');
      this.level = (configured as Level) || 'info';
    }
  }

  show(): void {
    this.init();
    this.channel?.show();
  }

  private write(level: Level, msg: string): void {
    if (!this.channel || ORDER[level] < ORDER[this.level]) {
      return;
    }
    const ts = new Date().toISOString().slice(11, 19);
    this.channel.appendLine(`[${ts}] [${level.toUpperCase()}] ${msg}`);
  }

  debug(msg: string): void {
    this.write('debug', msg);
  }

  info(msg: string): void {
    this.write('info', msg);
  }

  warn(msg: string): void {
    this.write('warn', msg);
  }

  error(msg: string): void {
    this.write('error', msg);
  }
}

export const log = new Logger();
