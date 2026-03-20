/**
 * Function Scanner Extension for Visual Studio Code
 * Detects functions using VS Code's native symbol API
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './utils/Logger';
import { PerformanceLogger } from './utils/PerformanceLogger';

let functionTreeProvider: FunctionTreeDataProvider;
let logger: Logger;
let performanceLogger: PerformanceLogger | undefined;
let fileWatcher: vscode.FileSystemWatcher;
let fileWatcherInstance: FileWatcher | undefined;
let statusBarItem: vscode.StatusBarItem;
let treeView: vscode.TreeView<FunctionNode>;
let scanTimeout: NodeJS.Timeout | undefined;

// Memory cache for symbol scan results - key: filePath, value: FunctionMatch[]
// Invalidated when file is modified/deleted
const memoryCache: Map<string, FunctionMatch[]> = new Map();

// Debounce timers for file rescans - key: filePath, value: NodeJS.Timeout
// Ensures only one rescan per file within 15 seconds
const rescanTimers: Map<string, NodeJS.Timeout> = new Map();

import { FileWatcher } from './core/FileWatcher';
import { get } from 'http';

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
		const treeItem = this.getNewTreeItem(element);
		if (element.type === 'file') {
			this.getTreeFile(treeItem, element);
		} else if (element.type === 'function') {
			this.getTreeFunction(treeItem, element);
		} else if (element.type === 'empty') {
			treeItem.iconPath = new vscode.ThemeIcon('search');
		};
		return treeItem;
	}

	private getNewTreeItem(element: FunctionNode): vscode.TreeItem {
		return new vscode.TreeItem(element.label, element.collapsibleState);
	}

	private getTreeFile(treeItem: vscode.TreeItem, element: FunctionNode): void {
		treeItem.iconPath = new vscode.ThemeIcon('file');
		treeItem.resourceUri = vscode.Uri.file(element.filePath);
		treeItem.contextValue = 'fileWithFunctions';
	};

	private getTreeFunction(treeItem: vscode.TreeItem, element: FunctionNode): void {
		treeItem.iconPath = new vscode.ThemeIcon('symbol-function');
		treeItem.command = {
			command: 'cle.openFunction',
			title: 'Open Function',
			arguments: [element.filePath, element.startLine]
		};
	};

	private async filterChildrensForFunction(){
		// Root level - show files with functions only (filter out empty files)
		const files: FunctionNode[] = [];
		const promises = Array.from(this.functionsData).map(([filePath, functions]) =>
			this.checkFile(functions, filePath, files)
		);
		await Promise.all(promises);
		return files;
	};

	private async checkFile(functions: FunctionMatch[], filePath: string, files: FunctionNode[]){
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
		};
	};

	private checkFiles(element: FunctionNode){
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
		return functionNodes;
	};

	private checkChildrenFunctions(element: FunctionNode): FunctionNode[] {
		// Function level - show nested functions (children)
		if(!element.funcMatch?.children) {
			return [];
		}
		
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
		return childNodes;
	}

	getChildren(element?: FunctionNode): Thenable<FunctionNode[]> {
		if (!element) {
			return (async () => {
				let files = await this.filterChildrensForFunction();
				
				if (files.length === 0) {
					files.push(new FunctionNode('👉 Run "Scan for Functions Longer Than 5 Lines" to begin', vscode.TreeItemCollapsibleState.None, 'empty', '', 0, undefined));
				}
				
				return files;
			})();
		} else if (element.type === 'file') {
			return Promise.resolve(this.checkFiles(element));
		} else if (element.type === 'function' && element.funcMatch?.children) {
			return Promise.resolve(this.checkChildrenFunctions(element));
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

	// Initialize performance logger
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		performanceLogger = new PerformanceLogger(workspaceFolders[0].uri);
	}

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
	if (workspaceFolders) {
		fileWatcherInstance = new FileWatcher();
		
		// Start the file watcher for this workspace
		await fileWatcherInstance.start(
			workspaceFolders[0].uri.fsPath,
			['.ts', '.tsx', '.js', '.jsx']
		);

		// Subscribe to file change events - trigger incremental rescanning with 15s delay
		fileWatcherInstance.onFileChange(async (event) => {
			// For modified files - schedule rescan with 15s debounce
			for (const modifiedFile of event.modified) {
				scheduleFileScan(modifiedFile);
			}
			
			// For deleted files - remove from cache and tree immediately
			for (const deletedFile of event.deleted) {
				// Clear pending rescan if exists
				const timer = rescanTimers.get(deletedFile);
				if (timer) {
					clearTimeout(timer);
					rescanTimers.delete(deletedFile);
				}
				memoryCache.delete(deletedFile);
				functionTreeProvider.updateSingleFile(deletedFile, []);
			}
			
			// For added files - do a full re-scan to integrate new files
			if (event.added.length > 0) {
				scheduleScan();
			}
		});
		
		context.subscriptions.push({ dispose: () => fileWatcherInstance?.dispose() });
	}

	// Keep VSCode's file watcher for compatibility (now acts as fallback)
	fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx}');
	fileWatcher.onDidChange(async (uri) => {
		// Incremental rescan with 15s debounce for modified file
		scheduleFileScan(uri.fsPath);
	});
	fileWatcher.onDidCreate(async (uri) => {
		// New file - full rescan to integrate
		scheduleScan();
	});
	fileWatcher.onDidDelete(async (uri) => {
		// Remove pending rescan and clear cache/tree
		const timer = rescanTimers.get(uri.fsPath);
		if (timer) {
			clearTimeout(timer);
			rescanTimers.delete(uri.fsPath);
		}
		memoryCache.delete(uri.fsPath);
		functionTreeProvider.updateSingleFile(uri.fsPath, []);
		updateStatusBar();
	});
	context.subscriptions.push(fileWatcher);

	// Push logger to disposables
	context.subscriptions.push(logger);

	// Pre-warm the language server BEFORE scan (separate from main processing)
	if (workspaceFolders) {
		await warmupLanguageServer(workspaceFolders[0]);
	}

	// Initial scan on startup (non-blocking, LS is already warm)
	runScanUsingNativeSymbols(false);
}

/**
 * Pre-warm the language server by fetching symbols from one file
 * This initializes the JS language server before the parallel batch scan begins
 */
async function warmupLanguageServer(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	try {
		// Find all source files
		const documents = await vscode.workspace.findFiles(
			new vscode.RelativePattern(workspaceFolder, '**/*.{ts,tsx,js,jsx}'),
			`{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/out/**,**/coverage/**,**/.vscode/**,**/.cache/**,**/tmp/**,**/temp/**,**/.nuxt/**}`
		);

		if (documents.length === 0) {
			return;
		}

		// Sort files alphabetically
		const sortedDocs = documents.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

		// Find the first non-test file
		const testFilePatterns = [/test/i, /spec/i, /mock/i];
		let warmupFile: vscode.Uri | null = null;

		for (const doc of sortedDocs) {
			const filename = doc.fsPath.toLowerCase();
			const isTestFile = testFilePatterns.some(pattern => pattern.test(filename));
			
			if (!isTestFile) {
				warmupFile = doc;
				break;
			}
		}

		if (warmupFile) {
			// Single warmup call - initializes the JS language server
			await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				warmupFile
			);
		}
	} catch (error) {
		// Silently ignore warmup errors
	}
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
 * Now using multiple parallel batches for performance
 */
async function runScanUsingNativeSymbols(showPopup: boolean = true) {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		logger.error('No workspace folder found!');
		return;
	}

	// Start performance logging
	if (performanceLogger) {
		performanceLogger.scanStart();
	}

	try {
		const startTime = Date.now();
		const fileMap = new Map<string, FunctionMatch[]>();
		let totalFunctions = 0;

		const workspaceFolder = workspaceFolders[0];

		// Get all source files in this workspace folder only
		const documents = await vscode.workspace.findFiles(
			new vscode.RelativePattern(
				workspaceFolder,
				'**/*.{ts,tsx,js,jsx}'
			),
			`{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/out/**,**/coverage/**,**/.vscode/**,**/.cache/**,**/tmp/**,**/temp/**,**/.nuxt/**}`
		);
		
		// Sort files alphabetically for deterministic processing order
		// This ensures the warmup file is processed early
		const sortedDocuments = documents.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
		


		// Process files in parallel batches to maximize throughput
		// Each batch processes up to 4 files concurrently
		// (Language servers serialize internally, 4 is optimal balance)
		const BATCH_SIZE = 4;
		
		// Helper function to process a single file
		const processSingleFile = async (docUri: vscode.Uri): Promise<{ path: string; functions: FunctionMatch[] | null }> => {
			try {
				// Check memory cache first
				const cached = memoryCache.get(docUri.fsPath);
				if (cached) {
					if (performanceLogger) {
						performanceLogger.logSymbolFetch(docUri.fsPath, 0, cached.length);
					}
					return { path: docUri.fsPath, functions: cached };
				}

				// Cache miss - fetch symbols from VS Code API
				const symbolFetchStart = performance.now();
				const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
					'vscode.executeDocumentSymbolProvider',
					docUri
				);
				const symbolFetchDuration = performance.now() - symbolFetchStart;

				if (!symbols || symbols.length === 0) {
					if (performanceLogger) {
						performanceLogger.logSymbolFetch(docUri.fsPath, symbolFetchDuration, 0);
					}
					return { path: docUri.fsPath, functions: null };
				}

				if (performanceLogger) {
					performanceLogger.logSymbolFetch(docUri.fsPath, symbolFetchDuration, symbols.length);
				}

				const result = await flattenSymbolsAsync(symbols, docUri.fsPath, 5);

				if (performanceLogger && result.stats) {
					performanceLogger.logAsyncProcess(
						docUri.fsPath,
						result.elapsed,
						result.stats.processedSymbols,
						result.stats.createdFunctions,
						result.stats.memory
					);
				}

				// Store in memory cache
				if (result.functions.length > 0) {
					memoryCache.set(docUri.fsPath, result.functions);
					return { path: docUri.fsPath, functions: result.functions };
				}

				return { path: docUri.fsPath, functions: null };
			} catch (error) {
				return { path: docUri.fsPath, functions: null };
			}
		};

		// Process all files in parallel batches
		for (let i = 0; i < sortedDocuments.length; i += BATCH_SIZE) {
			const batch = sortedDocuments.slice(i, i + BATCH_SIZE);
			const batchResults = await Promise.allSettled(batch.map(doc => processSingleFile(doc)));
			
			for (const result of batchResults) {
				if (result.status === 'fulfilled' && result.value.functions) {
					fileMap.set(result.value.path, result.value.functions);
					totalFunctions += result.value.functions.length;
				}
			}
		}

		// Measure tree update time
		const treeUpdateStart = performance.now();
		functionTreeProvider.updateData(fileMap);
		const treeUpdateDuration = performance.now() - treeUpdateStart;

		if (performanceLogger) {
			performanceLogger.logTreeUpdate(treeUpdateDuration, fileMap.size);
		}

		updateStatusBar();

		const elapsed = Date.now() - startTime;

		// Log scan completion to performance logger
		if (performanceLogger) {
			performanceLogger.scanComplete(elapsed, documents.length, totalFunctions);
		}

		logger.show();
		logger.info(
			`✓ Scan complete in ${elapsed}ms. Found ${totalFunctions} functions in ${documents.length} files. | 📊 Log: ${performanceLogger?.getLogFilePath() || 'N/A'}\n`
		);

		if (showPopup) {
			vscode.window.showInformationMessage(
				`Function Scanner (Async): Found ${totalFunctions} functions longer than 5 lines in ${elapsed}ms.`
			);
		}
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : String(error);
		logger.error(
			'Async scan failed',
			error instanceof Error ? error : new Error(errorMsg)
		);
		if (showPopup) {
			vscode.window.showErrorMessage(
				`Function Scanner (Async) failed: ${errorMsg}`
			);
		}
	}
}

/**
 * Rescan a single file with 15-second debounce
 * Prevents excessive rescanning during rapid edits
 */
function scheduleFileScan(filePath: string): void {
	// Clear existing timer for this file
	const existingTimer = rescanTimers.get(filePath);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	// Schedule rescan in 15 seconds
	const timer = setTimeout(async () => {
		await rescanSingleFile(filePath);
		rescanTimers.delete(filePath);
	}, 15000);

	rescanTimers.set(filePath, timer);
}

/**
 * Rescan a single file and update the tree
 * Called when a file is modified or deleted (incremental scanning)
 */
async function rescanSingleFile(filePath: string): Promise<void> {
	try {
		// Invalidate cache for this file
		memoryCache.delete(filePath);

		// If file was deleted or we can't read it, remove from tree
		if (!require('fs').existsSync(filePath)) {
			functionTreeProvider.updateSingleFile(filePath, []);
			updateStatusBar();
			return;
		}

		// Rescan just this one file
		const docUri = vscode.Uri.file(filePath);
		const symbolFetchStart = performance.now();
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider',
			docUri
		);
		const symbolFetchDuration = performance.now() - symbolFetchStart;

		if (!symbols || symbols.length === 0) {
			functionTreeProvider.updateSingleFile(filePath, []);
			updateStatusBar();
			return;
		}

		const result = await flattenSymbolsAsync(symbols, filePath, 5);

		// Cache the result
		if (result.functions.length > 0) {
			memoryCache.set(filePath, result.functions);
			functionTreeProvider.updateSingleFile(filePath, result.functions);
		} else {
			functionTreeProvider.updateSingleFile(filePath, []);
		}

		updateStatusBar();
	} catch (error) {
		// Silently fail on rescan errors
	}
}

/**
 * Flatten nested DocumentSymbols using async/await with Promise-based recursion (Option 2)
 * Truly non-blocking with batched processing and yields between batches
 */
async function flattenSymbolsAsync(
	symbols: vscode.DocumentSymbol[],
	filePath: string,
	threshold: number
): Promise<{ functions: FunctionMatch[]; elapsed: number; stats: any }> {
	const overallStart = performance.now();
	const startMemory = process.memoryUsage().heapUsed;
	let processedSymbols = 0;
	let createdFunctions = 0;
	const BATCH_SIZE = 10; // Process 10 symbols per batch, then yield

	const functions: FunctionMatch[] = [];

	// Async recursive function that batches symbols and yields between batches
	async function processSymbolsAsync(
		syms: vscode.DocumentSymbol[],
		parent?: FunctionMatch
	): Promise<void> {
		for (let i = 0; i < syms.length; i++) {
			const sym = syms[i];
			processedSymbols++;

			// Count only function-like symbols
			if (
				sym.kind === vscode.SymbolKind.Function ||
				sym.kind === vscode.SymbolKind.Method ||
				sym.kind === vscode.SymbolKind.Constructor
			) {
				const lineCount =
					sym.range.end.line - sym.range.start.line + 1;

				if (lineCount >= threshold) {
					const func: FunctionMatch = {
						name: sym.name,
						startLine: sym.range.start.line + 1,
						endLine: sym.range.end.line + 1,
						lineCount,
						metrics: { parser: 'vscode-symbols-async' },
						children: [],
					};

					createdFunctions++;

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
						await processSymbolsAsync(sym.children, func);
					}
				} else if (sym.children) {
					// Still check children even if parent is below threshold
					await processSymbolsAsync(sym.children, parent);
				}
			} else if (sym.children) {
				// For non-function symbols (classes, interfaces), check their children
				await processSymbolsAsync(sym.children, parent);
			}

			// Yield after every BATCH_SIZE symbols to break up the work
			if ((i + 1) % BATCH_SIZE === 0) {
				await new Promise((resolve) => setImmediate(resolve));
			}
		}
	}

	try {
		await processSymbolsAsync(symbols);

		const overallElapsed = performance.now() - overallStart;
		const memoryDelta =
			(process.memoryUsage().heapUsed - startMemory) / 1024; // KB

		logger.info(
			`[flattenSymbolsAsync] File: ${path.basename(filePath)} | ` +
			`Processed: ${processedSymbols} symbols | ` +
			`Created: ${createdFunctions} functions | ` +
			`Time: ${overallElapsed.toFixed(2)}ms | ` +
			`Memory: ${memoryDelta > 0 ? '+' : ''}${memoryDelta.toFixed(2)}KB`
		);

		return {
			functions,
			elapsed: overallElapsed,
			stats: {
				processedSymbols,
				createdFunctions,
				elapsed: overallElapsed,
				memory: memoryDelta,
			},
		};
	} catch (error) {
		logger.error(
			`Async processing failed for ${path.basename(filePath)}`,
			error instanceof Error ? error : new Error(String(error))
		);
		return {
			functions: [],
			elapsed: performance.now() - overallStart,
			stats: {
				processedSymbols: 0,
				createdFunctions: 0,
				elapsed: 0,
				memory: 0,
			},
		};
	}
}

/**
 * Flatten nested DocumentSymbols into a flat array of functions >= threshold lines
 * With performance and memory tracking (fallback synchronous version)
 */
function flattenSymbols(
	symbols: vscode.DocumentSymbol[],
	filePath: string,
	threshold: number
): FunctionMatch[] {
	const startTime = performance.now();
	const startMemory = process.memoryUsage().heapUsed;
	let processedSymbols = 0;
	let createdFunctions = 0;

	const functions: FunctionMatch[] = [];

	function processSymbols(
		syms: vscode.DocumentSymbol[],
		parent?: FunctionMatch
	): void {
		for (const sym of syms) {
			processedSymbols++;

			// Count only function-like symbols
			if (
				sym.kind === vscode.SymbolKind.Function ||
				sym.kind === vscode.SymbolKind.Method ||
				sym.kind === vscode.SymbolKind.Constructor
			) {
				const lineCount =
					sym.range.end.line - sym.range.start.line + 1;

				if (lineCount >= threshold) {
					const func: FunctionMatch = {
						name: sym.name,
						startLine: sym.range.start.line + 1,
						endLine: sym.range.end.line + 1,
						lineCount,
						metrics: { parser: 'vscode-symbols' },
						children: [],
					};

					createdFunctions++;

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
	setStatusBar(total, '#FF1493', `$(symbol-function) ${total} Functions > 5L`, `Found ${total} functions longer than 5 lines. Click to rescan.`);
	setBadge(total);	
}

function setStatusBar(total:number, color: string, text: string, tooltip: string) {
	statusBarItem.text = `$(symbol-function) ${total} Functions > 5L`;
	statusBarItem.color = '#FF1493'; // Deep pink
	statusBarItem.tooltip = `Found ${total} functions longer than 5 lines. Click to rescan.`;
};

function setBadge(total:number){
	treeView.badge = {
		value: total,
		tooltip: `${total} functions longer than 5 lines`
	};
};

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
