/**
 * Function Scanner Extension for Visual Studio Code
 * Detects functions using VS Code's native symbol API
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './utils/Logger';

let functionTreeProvider: FunctionTreeDataProvider;
let logger: Logger;
let fileWatcher: vscode.FileSystemWatcher;
let fileWatcherInstance: FileWatcher | undefined;
let statusBarItem: vscode.StatusBarItem;
let treeView: vscode.TreeView<FunctionNode>;
let scanTimeout: NodeJS.Timeout | undefined;

import { FileWatcher } from './core/FileWatcher';

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
			treeItem.resourceUri = vscode.Uri.file(element.filePath);
			treeItem.contextValue = 'fileWithFunctions';
			// Add pink-colored description with count
			if (element.functionCount > 0) {
				// Use a custom rendering with color styling
				const countBadge = `●  ${element.functionCount} found`;
				treeItem.description = countBadge;
				// Add custom badge rendering
				const args = encodeURIComponent(JSON.stringify({ filePath: element.filePath }));
				treeItem.accessibilityInformation = {
					label: `${element.label} with ${element.functionCount} functions`,
					role: 'treeitem'
				};
			}
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
			// Root level - show files with functions only (filter out empty files)
			const files: FunctionNode[] = [];
			this.functionsData.forEach((functions, filePath) => {
				// Only show files that have functions
				if (functions.length > 0) {
					const count = functions.length;
					files.push(new FunctionNode(
						path.basename(filePath),
						vscode.TreeItemCollapsibleState.Collapsed,
						'file',
						filePath,
						0,
						undefined,
						count
					));
				}
			});
			
			// Show empty state message if no data
			if (files.length === 0) {
				files.push(new FunctionNode(
					'👉 Run "Scan for Functions Longer Than 5 Lines" to begin',
					vscode.TreeItemCollapsibleState.None,
					'empty',
					'',
					0,
					undefined
				));
			}
			return Promise.resolve(files);
		} else if (element.type === 'file') {
			// File level - show top-level functions
			const functions = this.functionsData.get(element.filePath) || [];
			const functionNodes = functions.map(fn => {
				// Determine if this function has children
				const hasChildren = fn.children && fn.children.length > 0;
				return new FunctionNode(
					`${fn.name} (${fn.lineCount} lines)`,
					hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
					'function',
					element.filePath,
					fn.startLine,
					fn
				);
			});
			return Promise.resolve(functionNodes);
		} else if (element.type === 'function' && element.funcMatch?.children) {
			// Function level - show nested functions (children)
			const children = element.funcMatch.children;
			const childNodes = children.map(child => {
				const hasChildren = child.children && child.children.length > 0;
				return new FunctionNode(
					`${child.name} (${child.lineCount} lines)`,
					hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
					'function',
					element.filePath,
					child.startLine,
					child
				);
			});
			return Promise.resolve(childNodes);
		}

		return Promise.resolve([]);
	}

	updateData(fileMap: Map<string, FunctionMatch[]>) {
		// Filter out files with no functions
		const filtered = new Map<string, FunctionMatch[]>();
		fileMap.forEach((functions, filePath) => {
			if (functions.length > 0) {
				filtered.set(filePath, functions);
			}
		});
		this.functionsData = filtered;
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
	children?: FunctionMatch[];
}

class FunctionNode {
	constructor(
		public label: string,
		public collapsibleState: vscode.TreeItemCollapsibleState,
		public type: 'file' | 'function' | 'empty',
		public filePath: string,
		public startLine: number,
		public funcMatch?: FunctionMatch,
		public functionCount: number = 0
	) {}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	console.log('cleanExtension is now active!');

	// Initialize logger
	logger = new Logger('Function Scanner');

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

	// Register scan command - use native symbols only
	const disposable = vscode.commands.registerCommand('cle.scanUsingVSCodeSymbols', async () => {
		await runScanUsingNativeSymbols();
	});
	context.subscriptions.push(disposable);

	// Create status bar item
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'cle.scanUsingVSCodeSymbols';
	updateStatusBar();
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	// Watch for file changes using new FileWatcher for better debouncing
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		fileWatcherInstance = new FileWatcher();
		
		// Start the file watcher for this workspace
		await fileWatcherInstance.start(
			workspaceFolders[0].uri.fsPath,
			['.ts', '.tsx', '.js', '.jsx']
		);

		// Subscribe to file change events - trigger full re-scan on native symbols
		fileWatcherInstance.onFileChange(async (event) => {
			const changedFiles = [...event.added, ...event.modified];
			
			// For deleted files, update tree immediately
			for (const deletedFile of event.deleted) {
				functionTreeProvider.updateSingleFile(deletedFile, []);
			}
			
			// Schedule re-scan for any file changes
			if (changedFiles.length > 0) {
				scheduleScan();
			}
		});
		
		context.subscriptions.push({ dispose: () => fileWatcherInstance?.dispose() });
	}

	// Keep VSCode's file watcher for compatibility (now acts as fallback)
	fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx}');
	fileWatcher.onDidChange(async (uri) => {
		scheduleScan();
	});
	fileWatcher.onDidCreate(async (uri) => {
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
	runScanUsingNativeSymbols(false);
}

function scheduleScan(): void {
	// Clear existing timeout
	if (scanTimeout) {
		clearTimeout(scanTimeout);
	}

	// Set new timeout and trigger native symbol scan
	scanTimeout = setTimeout(async () => {
		// Use native symbol scan instead of custom parser
		await runScanUsingNativeSymbols(false);

		scanTimeout = undefined;
	}, 10000);
}

/**
 * Scan using VS Code's native symbol API (more accurate than custom parser)
 */
async function runScanUsingNativeSymbols(showPopup: boolean = true) {
	logger.show();
	logger.info('Starting scan using VS Code\'s native symbol API...\n');

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		logger.error('No workspace folder found!');
		return;
	}

	try {
		const startTime = Date.now();
		const fileMap = new Map<string, FunctionMatch[]>();
		let totalFunctions = 0;

		const workspaceFolder = workspaceFolders[0];
		
		// Get all source files in this workspace folder only
		const documents = await vscode.workspace.findFiles(
			new vscode.RelativePattern(workspaceFolder, '**/*.{ts,tsx,js,jsx}'),
			`{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/out/**,**/coverage/**,**/.vscode/**,**/.cache/**,**/tmp/**,**/temp/**,**/.nuxt/**}`
		);
		logger.info(`Found ${documents.length} source files in ${workspaceFolder.name}\n`);

		for (const docUri of documents) {
			try {
				// Get symbols for this document using VS Code's native API
				const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
					'vscode.executeDocumentSymbolProvider',
					docUri
				);

				if (!symbols || symbols.length === 0) {
					continue;
				}

				// Filter for functions and convert to our format
				const functions = flattenSymbols(symbols, docUri.fsPath, 5);
				
				if (functions.length > 0) {
					fileMap.set(docUri.fsPath, functions);
					totalFunctions += functions.length;
				}
			} catch (error) {
				// Silently skip files that fail
			}
		}

		functionTreeProvider.updateData(fileMap);
		updateStatusBar();

		const elapsed = Date.now() - startTime;
		logger.info(`✓ Scan complete in ${elapsed}ms. Found ${totalFunctions} functions longer than 5 lines.`);
		logger.info(`Processed ${documents.length} files using VS Code's language servers.\n`);

		if (showPopup) {
			vscode.window.showInformationMessage(`Function Scanner (Native): Found ${totalFunctions} functions longer than 5 lines.`);
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.error('Native symbol scan failed', error instanceof Error ? error : new Error(errorMsg));
		if (showPopup) {
			vscode.window.showErrorMessage(`Function Scanner (Native) failed: ${errorMsg}`);
		}
	}
}

/**
 * Flatten nested DocumentSymbols into a flat array of functions >= threshold lines
 */
function flattenSymbols(symbols: vscode.DocumentSymbol[], filePath: string, threshold: number): FunctionMatch[] {
	const functions: FunctionMatch[] = [];

	function processSymbols(syms: vscode.DocumentSymbol[], parent?: FunctionMatch) {
		for (const sym of syms) {
			// Count only function-like symbols
			if (
				sym.kind === vscode.SymbolKind.Function ||
				sym.kind === vscode.SymbolKind.Method ||
				sym.kind === vscode.SymbolKind.Constructor
			) {
				const lineCount = sym.range.end.line - sym.range.start.line + 1;
				
				if (lineCount >= threshold) {
					const func: FunctionMatch = {
						name: sym.name,
						startLine: sym.range.start.line + 1,
						endLine: sym.range.end.line + 1,
						lineCount,
						metrics: { parser: 'vscode-symbols' },
						children: [],
					};

					if (parent) {
						// Add as child of parent function
						if (!parent.children) {
							parent.children = [];
						}
						parent.children.push(func);
					} else {
						// Top-level function
						functions.push(func);
					}

					// Process children (nested functions)
					if (sym.children) {
						processSymbols(sym.children, func);
					}
				} else if (sym.children) {
					// Still check children even if parent is below threshold
					processSymbols(sym.children, parent);
				}
			} else if (sym.children) {
				// For non-function symbols (classes, interfaces), check their children
				processSymbols(sym.children, parent);
			}
		}
	}

	processSymbols(symbols);
	return functions;
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
	if (fileWatcherInstance) {
		fileWatcherInstance.dispose();
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
