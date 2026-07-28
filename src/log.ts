import * as vscode from 'vscode';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const SECTION = 'agentDock';

/**
 * 结构化上下文字段。单行值渲染为 k=v 追加在消息后；
 * 多行值（如 stderr tail）渲染为缩进块，保证输出通道里可直接读。
 */
export type Fields = Record<string, unknown>;

const MAX_FIELD_LEN = 600;

function renderFields(fields?: Fields): string {
  if (!fields) {
    return '';
  }
  const inline: string[] = [];
  const blocks: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') {
      continue;
    }
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s.length > MAX_FIELD_LEN) {
      s = `${s.slice(0, MAX_FIELD_LEN)}…(+${s.length - MAX_FIELD_LEN} chars)`;
    }
    if (s.includes('\n')) {
      const indented = s
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      blocks.push(`  ${k}:\n${indented}`);
    } else {
      inline.push(`${k}=${s}`);
    }
  }
  const head = inline.length > 0 ? ` ${inline.join(' ')}` : '';
  return blocks.length > 0 ? `${head}\n${blocks.join('\n')}` : head;
}

export interface SubLogger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

class Logger implements SubLogger {
  private channel?: vscode.OutputChannel;
  private level: Level = 'info';
  private watched = false;
  /** 各级别累计条数（含被级别过滤掉的），可用于确认日志级别是否生效。 */
  readonly counts: Record<Level, number> = { debug: 0, info: 0, warn: 0, error: 0 };

  init(): void {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel('Agent Dock');
    }
    this.refreshLevel();
    if (!this.watched) {
      this.watched = true;
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.logLevel`)) {
          this.refreshLevel();
        }
      });
    }
  }

  refreshLevel(): void {
    const configured = vscode.workspace.getConfiguration(SECTION).get<string>('logLevel', 'info');
    this.level = (configured as Level) || 'info';
  }

  show(): void {
    this.init();
    this.channel?.show();
  }

  /** 子系统 logger：自动带 [tag] 前缀，调用点不用再手写 "[ssh]" 之类。 */
  child(tag: string): SubLogger {
    return {
      debug: (msg, fields) => this.write('debug', tag, msg, fields),
      info: (msg, fields) => this.write('info', tag, msg, fields),
      warn: (msg, fields) => this.write('warn', tag, msg, fields),
      error: (msg, fields) => this.write('error', tag, msg, fields),
    };
  }

  private write(level: Level, tag: string | undefined, msg: string, fields?: Fields): void {
    this.counts[level] += 1;
    if (!this.channel || ORDER[level] < ORDER[this.level]) {
      return;
    }
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = `[${ts}] [${level.toUpperCase().padEnd(5)}]${tag ? ` [${tag}]` : ''}`;
    this.channel.appendLine(`${prefix} ${msg}${renderFields(fields)}`);
  }

  debug(msg: string, fields?: Fields): void {
    this.write('debug', undefined, msg, fields);
  }

  info(msg: string, fields?: Fields): void {
    this.write('info', undefined, msg, fields);
  }

  warn(msg: string, fields?: Fields): void {
    this.write('warn', undefined, msg, fields);
  }

  error(msg: string, fields?: Fields): void {
    this.write('error', undefined, msg, fields);
  }
}

export const log = new Logger();

/** 截断长输出（stderr/stdout tail），控制日志体积。 */
export function tail(s: string, max = 400): string {
  const t = s.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}
