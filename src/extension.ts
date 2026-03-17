/**
 * Function Scanner Extension for Visual Studio Code
 * Detects functions longer than specified line threshold using a plugin system.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { PluginRegistry } from './plugins/ParserRegistry';
import { TypeScriptParser } from './plugins/builtin/TypeScriptParser';
import { LineCountStrategy } from './plugins/builtin/LineCountStrategy';
import { MemoryCacheAdapter } from './plugins/builtin/MemoryCacheAdapter';
import { ScannerEngine, ScanResult } from './core/ScannerEngine';
import { Logger } from './utils/Logger';

let functionTreeProvider: FunctionTreeDataProvider;
let logger: Logger;
let fileWatcher: vscode.FileSystemWatcher;
let statusBarItem: vscode.StatusBarItem;
let treeView: vscode.TreeView<FunctionNode>;
let scanTimeout: NodeJS.Timeout | undefined;
let pendingFiles: Set<string> = new Set();
let scanner: ScannerEngine;
let registry: PluginRegistry;

class FunctionTreeDataProvider implements vscode.TreeDataProvider<FunctionNode> {
	private _onDidChangeTreeData: vscode.EventEmitter<FunctionNode | undefined | null | void> = new vscode.EventEmitter<FunctionNode | undefined | null | void>();
	onDidChangeTreeData: vscode.Event<FunctionNode | undefined | null | void> = this._onDidChangeTreeData.event;

	private functionsData: Map<string, FunctionMatch[]> = new Map();

	getTotalCount(): number {
		let total = 0;
		this.functionsData.forEach(functions => {
			total += functions.length;
		});
		return total;
	}

	getTreeItem(element: FunctionNode): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(
			element.label,
			element.collapsibleState
		);

		if (element.type === 'file') {
			treeItem.iconPath = new vscode.ThemeIcon('file');
		} else if (element.type === 'function') {
			treeItem.iconPath = new vscode.ThemeIcon('symbol-function');
			treeItem.command = {
				command: 'cle.openFunction',
				title: 'Open Function',
				arguments: [element.filePath, element.startLine]
			};
		} else if (element.type === 'empty') {
			treeItem.iconPath = new vscode.ThemeIcon('search');
		}

		return treeItem;
	}

	getChildren(element?: FunctionNode): Thenable<FunctionNode[]> {
		if (!element) {
			// Root level - show files or empty state
			const files: FunctionNode[] = [];
			this.functionsData.forEach((functions, filePath) => {
				files.push(new FunctionNode(
					path.basename(filePath),
					vscode.TreeItemCollapsibleState.Collapsed,
					'file',
					filePath,
					0
				));
			});
			
			// Show empty state message if no data
			if (files.length === 0) {
				files.push(new FunctionNode(
					'👉 Run "Scan for Functions Longer Than 5 Lines" to begin',
					vscode.TreeItemCollapsibleState.None,
					'empty',
					'',
					0
				));
			}
			return Promise.resolve(files);
		} else if (element.type === 'file') {
			// File level - show functions
			const functions = this.functionsData.get(element.filePath) || [];
			const functionNodes = functions.map(fn =>
				new FunctionNode(
					`${fn.name} (${fn.lineCount} lines)`,
					vscode.TreeItemCollapsibleState.None,
					'function',
					element.filePath,
					fn.startLine
				)
			);
			return Promise.resolve(functionNodes);
		}

		return Promise.resolve([]);
	}

	updateData(fileMap: Map<string, FunctionMatch[]>) {
		this.functionsData = fileMap;
		this._onDidChangeTreeData.fire();
	}

	updateSingleFile(filePath: string, functions: FunctionMatch[]) {
		if (functions.length > 0) {
			this.functionsData.set(filePath, functions);
		} else {
			this.functionsData.delete(filePath);
		}
		this._onDidChangeTreeData.fire();
	}
}

interface FunctionMatch {
	name: string;
	startLine: number;
	endLine: number;
	lineCount: number;
	metrics: Record<string, unknown>;
}

class FunctionNode {
	constructor(
		public label: string,
		public collapsibleState: vscode.TreeItemCollapsibleState,
		public type: 'file' | 'function' | 'empty',
		public filePath: string,
		public startLine: number
	) {}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	console.log('cleanExtension is now active!');

	// Initialize logger
	logger = new Logger('Function Scanner');

	// Initialize plugin registry with built-in plugins
	registry = new PluginRegistry();
	registry.setConfig({ lineThreshold: 5 });
	
	const typeScriptParser = new TypeScriptParser();
	const lineCountStrategy = new LineCountStrategy();
	const memoryCache = new MemoryCacheAdapter();
	
	registry.registerParser(typeScriptParser);
	registry.registerStrategy(lineCountStrategy);
	registry.registerCache(memoryCache);
	
	// Initialize all plugins
	await registry.initializeAll();
	
	// Create scanner engine
	scanner = new ScannerEngine(typeScriptParser, lineCountStrategy, memoryCache);

	// Initialize tree view provider
	functionTreeProvider = new FunctionTreeDataProvider();
	treeView = vscode.window.createTreeView('functionScannerView', {
		treeDataProvider: functionTreeProvider
	});
	context.subscriptions.push(treeView);

	// Register open function command
	const openFunctionDisposable = vscode.commands.registerCommand('cle.openFunction', async (filePath: string, startLine: number) => {
		const document = await vscode.workspace.openTextDocument(filePath);
		const editor = await vscode.window.showTextDocument(document);
		const range = new vscode.Range(startLine - 1, 0, startLine - 1, 0);
		editor.selection = new vscode.Selection(range.start, range.start);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
	});
	context.subscriptions.push(openFunctionDisposable);

	// Register scan command
	const disposable = vscode.commands.registerCommand('cle.scanLongFunctions', async () => {
		await runScan();
	});
	context.subscriptions.push(disposable);

	// Create status bar item
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'cle.scanLongFunctions';
	updateStatusBar();
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	// Watch for file changes and scan only changed file
	fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx}');
	fileWatcher.onDidChange(async (uri) => {
		pendingFiles.add(uri.fsPath);
		scheduleScan();
	});
	fileWatcher.onDidCreate(async (uri) => {
		pendingFiles.add(uri.fsPath);
		scheduleScan();
	});
	fileWatcher.onDidDelete(async (uri) => {
		functionTreeProvider.updateSingleFile(uri.fsPath, []);
		updateStatusBar();
	});
	context.subscriptions.push(fileWatcher);

	// Push logger to disposables
	context.subscriptions.push(logger);

	// Initial scan on startup (non-blocking)
	runScan(false);
}

function scheduleScan(): void {
	// Clear existing timeout
	if (scanTimeout) {
		clearTimeout(scanTimeout);
	}

	// Set new timeout for 10 seconds
	scanTimeout = setTimeout(async () => {
		const filesToScan = Array.from(pendingFiles);
		pendingFiles.clear();

		// Scan all pending files
		for (const filePath of filesToScan) {
			await scanSingleFile(filePath);
		}

		scanTimeout = undefined;
	}, 10000);
}

async function runScan(showPopup: boolean = true) {
	logger.show();
	logger.info('Starting scan for functions longer than 5 lines...\n');

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		logger.error('No workspace folder found!');
		return;
	}

	try {
		const startTime = Date.now();
		
		// Define exclusions to skip node_modules, dist, build etc
		const customExclusions = new Set([
			'node_modules',
			'.git',
			'.vscode',
			'dist',
			'build',
			'coverage',
			'.next',
			'out',
			'.nuxt',
			'.cache',
			'tmp',
			'temp',
		]);
		
		const results = await scanner.scanWorkspace(workspaceFolders[0].uri.fsPath, {
			concurrencyLimit: 16,
			excludeDirs: customExclusions,
			onProgress: (processed, total) => {
				logger.info(`Scanned ${processed}/${total} files...`);
			}
		});
		
		// Convert ScanResult array to fileMap
		const fileMap = new Map<string, FunctionMatch[]>();
		results.forEach(result => {
			fileMap.set(result.filePath, result.functions);
		});
		
		functionTreeProvider.updateData(fileMap);
		updateStatusBar();
		
		const elapsed = Date.now() - startTime;
		const totalFunctions = results.reduce((sum, r) => sum + r.functions.length, 0);
		logger.info(`✓ Scan complete in ${elapsed}ms. Found ${totalFunctions} functions longer than 5 lines.`);
		
		if (showPopup) {
			vscode.window.showInformationMessage(`Function Scanner: Found ${totalFunctions} functions longer than 5 lines.`);
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.error('Scan failed', error instanceof Error ? error : new Error(errorMsg));
		if (showPopup) {
			vscode.window.showErrorMessage(`Function Scanner failed: ${errorMsg}`);
		}
	}
}

async function scanSingleFile(filePath: string): Promise<void> {
	try {
		const result = await scanner.scanFile(filePath);
		functionTreeProvider.updateSingleFile(filePath, result.functions);
		updateStatusBar();

		if (result.functions.length > 0) {
			logger.info(`📄 ${filePath}`);
			result.functions.forEach(fn => {
				logger.info(`  ├─ ${fn.name} (line ${fn.startLine}, ${fn.lineCount} lines)`);
			});
		}
	} catch (error) {
		// silently ignore if file can't be read (e.g., deleted)
	}
}

function updateStatusBar(): void {
	const total = functionTreeProvider.getTotalCount();
	statusBarItem.text = `$(symbol-function) ${total} Functions > 5L`;
	statusBarItem.color = '#FF1493'; // Deep pink
	statusBarItem.tooltip = `Found ${total} functions longer than 5 lines. Click to rescan.`;

	// Set badge on Activity Bar tree view
	treeView.badge = {
		value: total,
		tooltip: `${total} functions longer than 5 lines`
	};
}

// This method is called when your extension is deactivated
export function deactivate() {
	if (scanTimeout) {
		clearTimeout(scanTimeout);
	}
	if (fileWatcher) {
		fileWatcher.dispose();
	}
	if (statusBarItem) {
		statusBarItem.dispose();
	}
	if (logger) {
		logger.dispose();
	}
}
