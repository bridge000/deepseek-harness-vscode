import * as vscode from 'vscode';

const MAX_LINES = 400;

/** Output channel + in-memory ring buffer used by the diagnose command. */
export class Logger {
	private readonly channel: vscode.OutputChannel;
	private readonly lines: string[] = [];

	constructor(name = 'DeepSeek Harness') {
		this.channel = vscode.window.createOutputChannel(name);
	}

	info(message: string): void {
		this.append('INFO', message);
	}
	warn(message: string): void {
		this.append('WARN', message);
	}
	error(message: string): void {
		this.append('ERROR', message);
	}

	append(level: string, message: string): void {
		const line = `[${new Date().toISOString()}] [${level}] ${message}`;
		this.lines.push(line);
		if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
		this.channel.appendLine(line);
	}

	/** Raw protocol output (may contain sensitive paths), kept in the same channel. */
	raw(message: string): void {
		this.channel.appendLine(message);
	}

	tail(count = 50): string[] {
		return this.lines.slice(-count);
	}

	show(): void {
		this.channel.show(true);
	}

	dispose(): void {
		this.channel.dispose();
	}
}
