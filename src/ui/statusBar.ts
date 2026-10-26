import * as vscode from 'vscode';
import type { RuntimeState } from '../types';

export interface StatusBarController {
	update(runtime: RuntimeState, busy: boolean): void;
	dispose(): void;
}

/** Bottom-left indicator: runtime phase + busy spinner, click opens the sidebar. */
export function createStatusBar(open: () => void): StatusBarController {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
	item.command = 'dshReview.openChat';
	item.tooltip = 'DSH Review：点击打开侧边栏';
	item.show();

	const update = (runtime: RuntimeState, busy: boolean): void => {
		if (busy) {
			item.text = '$(sync~spin) DSH 正在处理';
			item.backgroundColor = undefined;
		} else if (runtime.phase === 'error') {
			item.text = '$(warning) DSH 错误';
			item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else if (runtime.phase === 'ready') {
			item.text = '$(circle-filled) DSH 就绪';
			item.backgroundColor = undefined;
		} else if (runtime.phase === 'starting') {
			item.text = '$(sync~spin) DSH 启动中';
			item.backgroundColor = undefined;
		} else {
			item.text = '$(circle-slash) DSH 未启动';
			item.backgroundColor = undefined;
		}
	};

	return {
		update,
		dispose: () => item.dispose(),
	};
}
