/**
 * Function Scanner Extension for Visual Studio Code
 * Detects functions using VS Code's native symbol API
 */

import * as vscode from 'vscode';
import { basename, normalize } from 'path';
import { Logger } from './utils/Logger';
import { PerformanceLogger } from './utils/PerformanceLogger';
import { existsSync, statSync } from 'fs';

/**
 * Configuration constants for the Function Scanner extension
 * Centralized settings for performance tuning and behavior control
 */
const CONFIG = {
	// File processing configuration
	SYMBOL_FETCH_BATCH_SIZE: 4,           // Files processed in parallel (optimal for most systems)
	SYMBOL_PROCESSING_BATCH_SIZE: 10,     // Symbols processed per batch before yielding to event loop
	FUNCTION_LINE_THRESHOLD: 5,           // Minimum number of lines to be considered "long"

	// Timing configuration (in milliseconds)
	FILE_RESCAN_DEBOUNCE_MS: 15000,      // Debounce rapid file changes to prevent excessive rescans
	LANGUAGE_SERVER_WARMUP_DELAY_MS: 300, // Time for VS Code's language server to fully initialize

	// Warmup configuration
	MAX_WARMUP_FILES: 3,                  // Number of files to use for language server warmup
};

let functionTreeProvider: FunctionTreeDataProvider;
let logger: Logger;
let performanceLogger: PerformanceLogger | undefined;
let fileWatcher: vscode.FileSystemWatcher;
let statusBarItem: vscode.StatusBarItem;
let treeView: vscode.TreeView<FunctionNode>;
let scanTimeout: NodeJS.Timeout | undefined;

/**
 * Cache entry structure: stores both scan results and file modification time
 * Allows validation of cache freshness alongside file watcher invalidation
 */
interface CacheEntry {
	data: FunctionMatch[];
	modTime: number;
}

// Memory cache for symbol scan results - key: filePath, value: CacheEntry
// Invalidated when file is modified/deleted or modification time changes
// File watcher provides additional safety for cache invalidation
const memoryCache: Map<string, CacheEntry> = new Map();

// Debounce timers for file rescans - key: filePath, value: NodeJS.Timeout
// Ensures only one rescan per file within 15 seconds
const rescanTimers: Map<string, NodeJS.Timeout> = new Map();

/**
 * Invalidate the cache entry for a specific file
 * Used consistently across all cache invalidation points
 * @param filePath - The file path to invalidate cache for
 */
function invalidateFileCache(filePath: string): void {
	memoryCache.delete(filePath);
}

/**
 * Convert an unknown error type to a standardized Error instance
 * Handles both Error objects and other types (strings, null, undefined, etc.)
 * Does NOT sanitize - Logger handles that internally via sanitizeError()
 * @param error - The error to convert
 * @returns An Error instance
 */
function toError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}
	return new Error(String(error));
}


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
	};

	getTreeItem(element: FunctionNode): vscode.TreeItem {
		const treeItem = this.getNewTreeItem(element);
		
		return this.applyTreeItemFilters(element, treeItem);
	};

	private applyTreeItemFilters(element: FunctionNode, treeItem: vscode.TreeItem): vscode.TreeItem {
		if (element.type === 'file') {
			this.getTreeFile(treeItem, element);
		} else if (element.type === 'function') {
			this.getTreeFunction(treeItem, element);
		} else if (element.type === 'empty') {
			treeItem.iconPath = new vscode.ThemeIcon('search');
		};
		return treeItem;
	};

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
				basename(filePath),
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
			return this.functionHasChildren(fn, element);
		});
		return functionNodes;
	};

	private functionHasChildren(fn:FunctionMatch, element: FunctionNode): FunctionNode {
		const hasChildren = fn.children && fn.children.length > 0;
		return new FunctionNode(
			`${fn.name} (${fn.lineCount} lines)`,
			hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
			'function',
			element.filePath,
			fn.startLine,
			fn
		);
	};

	private checkChildrenFunctions(element: FunctionNode): FunctionNode[] {
		// Function level - show nested functions (children)
		if(!element.funcMatch?.children) {
			return [];
		}
		const children = element.funcMatch.children;
		const childNodes = children.map(child => {
			return this.functionHasChildren(child, element);
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

	/**
	 * Compare two Maps of function matches for equality
	 * Returns true if maps have identical content (deep comparison)
	 * Uses property-based comparison instead of JSON.stringify for performance
	 */
	private mapsEqual(map1: Map<string, FunctionMatch[]>, map2: Map<string, FunctionMatch[]>): boolean {
		if (map1.size !== map2.size) {
			return false;
		}
		
		for (const [key, value1] of map1) {
			const value2 = map2.get(key);
			if (!value2 || !this.arraysEqual(value1, value2)) {
				return false;
			}
		}
		
		return true;
	}

	/**
	 * Compare two arrays of FunctionMatch objects for equality
	 * Returns true if arrays have same length and all elements are equal
	 */
	private arraysEqual(arr1: FunctionMatch[], arr2: FunctionMatch[]): boolean {
		if (arr1.length !== arr2.length) {
			return false;
		}
		
		for (let i = 0; i < arr1.length; i++) {
			if (!this.functionMatchEqual(arr1[i], arr2[i])) {
				return false;
			}
		}
		
		return true;
	}

	/**
	 * Compare two FunctionMatch objects for equality
	 * Performs recursive comparison of children arrays
	 */
	private functionMatchEqual(fn1: FunctionMatch, fn2: FunctionMatch): boolean {
		// Compare basic properties
		if (fn1.name !== fn2.name ||
			fn1.startLine !== fn2.startLine ||
			fn1.endLine !== fn2.endLine ||
			fn1.lineCount !== fn2.lineCount) {
			return false;
		}

		// Compare children arrays
		if (!fn1.children && !fn2.children) {
			return true; // Both have no children
		}
		if (!fn1.children || !fn2.children) {
			return false; // One has children, the other doesn't
		}
		return this.arraysEqual(fn1.children, fn2.children);
	}

	updateData(fileMap: Map<string, FunctionMatch[]>) {
		// Filter out files with no functions
		const filtered = new Map<string, FunctionMatch[]>();
		fileMap.forEach((functions, filePath) => {
			if (functions.length > 0) {
				filtered.set(filePath, functions);
			}
		});
		
		// Only fire change event if data actually differs from current state
		if (!this.mapsEqual(this.functionsData, filtered)) {
			this.functionsData = filtered;
			this._onDidChangeTreeData.fire();
		}
	}

	updateSingleFile(filePath: string, functions: FunctionMatch[]) {
		const oldFunctions = this.functionsData.get(filePath);
		let hasChanged = false;
		
		if (functions.length > 0) {
			// Check if new data differs from old data
			if (!oldFunctions || !this.arraysEqual(oldFunctions, functions)) {
				this.functionsData.set(filePath, functions);
				hasChanged = true;
			}
		} else {
			// Check if we're removing an entry that existed
			if (oldFunctions !== undefined) {
				this.functionsData.delete(filePath);
				hasChanged = true;
			}
		}
		
		// Only fire change event if something actually changed
		if (hasChanged) {
			this._onDidChangeTreeData.fire();
		}
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

function initPerformanceLogger(){
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		performanceLogger = new PerformanceLogger(workspaceFolders[0].uri);
	}
	return workspaceFolders;
};

function initTreeView(context: vscode.ExtensionContext) {
	functionTreeProvider = new FunctionTreeDataProvider();
	treeView = vscode.window.createTreeView('functionScannerView', {
		treeDataProvider: functionTreeProvider
	});
	context.subscriptions.push(treeView);
};

function registerOpenFunctionCommand(context: vscode.ExtensionContext) {
	const openFunctionDisposable = vscode.commands.registerCommand('cle.openFunction', async (filePath: string, startLine: number) => {
		const document = await vscode.workspace.openTextDocument(filePath);
		const editor = await vscode.window.showTextDocument(document);
		const range = new vscode.Range(startLine - 1, 0, startLine - 1, 0);
		editor.selection = new vscode.Selection(range.start, range.start);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
	});
	context.subscriptions.push(openFunctionDisposable);
};

function RegisterScanCommand(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('cle.scanUsingVSCodeSymbols', async () => {
		await runScanUsingNativeSymbols();
	});
	context.subscriptions.push(disposable);
};

function createStatusBarItem(context: vscode.ExtensionContext) {
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'cle.scanUsingVSCodeSymbols';
	updateStatusBar();
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);
};


function createFileWatcher(context: vscode.ExtensionContext) {
	
	fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx}');
	fileWatcher.onDidChange(async (uri) => {
		scheduleFileScan(uri.fsPath);
	});

	fileWatcher.onDidCreate(async (uri) => {
		scheduleFileScan(uri.fsPath);
	});

	fileWatcher.onDidDelete(async (uri) => {
		removeRescan(uri);
		functionTreeProvider.updateSingleFile(uri.fsPath, []);
		updateStatusBar();
	});
	context.subscriptions.push(fileWatcher);
};

function removeRescan(uri: vscode.Uri){
	const timer = rescanTimers.get(uri.fsPath);
	if (timer) {
		clearTimeout(timer);
		rescanTimers.delete(uri.fsPath);
	}
	invalidateFileCache(uri.fsPath);
};

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	logger = new Logger('Function Scanner');
	const workspaceFolders = initPerformanceLogger();
	initTreeView(context);
	registerOpenFunctionCommand(context);
	RegisterScanCommand(context);
	createStatusBarItem(context);
	createFileWatcher(context);

	context.subscriptions.push(logger);

	// Discover files once and use for both warmup and main scan to avoid duplicate discovery
	if (workspaceFolders) {
		try {
			const documents = await getAllFiles(workspaceFolders[0]);
			if (documents && documents.length > 0) {
				// Pre-warm the language server with discovered files
				await warmupLanguageServer(documents);
				// Critical: Wait for VS Code's LS to fully initialize
				// Without this, first batch hits uninitialized LS, returns 0 symbols, takes 250+ms each
				// With this, LS is ready for parallel batch processing
				await new Promise(resolve => setTimeout(resolve, CONFIG.LANGUAGE_SERVER_WARMUP_DELAY_MS));
				// Initial scan on startup (non-blocking, LS is already warm, files already discovered)
				runScanUsingNativeSymbols(false, documents);
			} else {
				// No files found, run scan without pre-discovery
				runScanUsingNativeSymbols(false);
			}
		} catch (error) {
			// If discovery fails, run scan normally
			runScanUsingNativeSymbols(false);
		}
	}
}

async function getAllFiles(workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Uri[] | null> {
	const documents = await vscode.workspace.findFiles(
	new vscode.RelativePattern(workspaceFolder, '**/*.{ts,tsx,js,jsx}'),
		`{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/out/**,**/coverage/**,**/.vscode/**,**/.cache/**,**/tmp/**,**/temp/**,**/.nuxt/**}`
	);
	if (documents.length === 0) {
		return null;
	}else {
		return documents;
	};
};

/**
 * Sanitize error messages to prevent leaking sensitive information in UI
 * @param error - The error to sanitize
 * @returns Safe error message for display to users
 */
function sanitizeErrorForUI(error: unknown): string {
	let message = error instanceof Error ? error.message : String(error);
	
	// Limit message length
	if (message.length > 200) {
		message = message.slice(0, 200) + '...';
	}
	
	// Redact file paths
	message = message.replace(/\/home\/[\w\-]+/g, '~');
	message = message.replace(/[A-Z]:\\Users\\[\w\-]+/g, '~');
	
	// Redact credentials
	message = message.replace(/token['"\':\s=]+[^\s'"\']+/gi, 'token=[REDACTED]');
	message = message.replace(/password['"\':\s=]+[^\s'"\']+/gi, 'password=[REDACTED]');
	
	return message;
}

const testFilePatterns =[/test/i, /spec/i, /mock/i];

/**
 * Validate that a file path is within the workspace boundaries
 * Prevents path traversal and symlink attacks
 * @param filePath - The file path to validate
 * @param workspaceFolder - The workspace folder URI
 * @returns true if path is safe and within workspace, false otherwise
 */
function validateFilePath(filePath: string, workspaceFolder: vscode.Uri): boolean {
	try {
		const normalizedPath = normalize(filePath);
		const workspacePath = normalize(workspaceFolder.fsPath);
		
		// Ensure file is within workspace
		if (!normalizedPath.startsWith(workspacePath)) {
			logger.warn(`Path outside workspace: ${filePath}`);
			return false;
		}
		
		// Reject paths with suspicious patterns
		if (normalizedPath.includes('..') || normalizedPath.includes('.git')) {
			logger.warn(`Suspicious path detected: ${filePath}`);
			return false;
		}
		
		return true;
	} catch (error) {
		logger.error(`Error validating path: ${filePath}`, toError(error));
		return false;
	}
}

/**
 * Pre-warm the language server by fetching symbols from multiple files
 * This initializes the JS language server before the parallel batch scan begins
 * Warmup with 2-3 files ensures LS is fully ready for parallel batch processing
 * @param documents - Pre-discovered list of source files (avoids duplicate discovery)
 */
async function warmupLanguageServer(documents: vscode.Uri[]): Promise<void> {
	try {
		const sortedDocs = documents.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
		const warmupFiles = findWarmupFiles(sortedDocs, CONFIG.MAX_WARMUP_FILES);
		if (warmupFiles.length > 0) {
			// Warmup in sequence (not parallel) - ensures LS gets properly initialized
			for (const warmupFile of warmupFiles) {
				await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
					'vscode.executeDocumentSymbolProvider',
					warmupFile
				);
			}
		}
	} catch (error) {
		logger.warn(
			`Language server warmup encountered an error: ${error instanceof Error ? error.message : String(error)}`
		);
		// Continue execution - warmup failure is not critical
	}
}

/**
 * Find first N non-test files for warmup
 */
function findWarmupFiles(sortedDocs: vscode.Uri[], count: number): vscode.Uri[] {
	const warmupFiles: vscode.Uri[] = [];
	for (const doc of sortedDocs) {
		const filename = doc.fsPath.toLowerCase();
		const isTestFile = testFilePatterns.some(pattern => pattern.test(filename));
		if (!isTestFile) {
			warmupFiles.push(doc);
			if (warmupFiles.length >= count) {
				break;
			}
		}
	}
	return warmupFiles;
}

/**
 * Process a single file to extract function symbols
 * Handles caching, symbol fetching, and flattening with error recovery
 * @param docUri - URI of the file to process
 * @returns Object with file path and extracted functions (or null on error)
 */
async function processSingleFile(docUri: vscode.Uri): Promise<{ path: string; functions: FunctionMatch[] | null }> {
	try {
		// Validate file path for security
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || !validateFilePath(docUri.fsPath, workspaceFolders[0].uri)) {
			logger.error(`Invalid or unsafe file path: ${docUri.fsPath}`);
			return { path: docUri.fsPath, functions: null };
		}

		// Check memory cache first - validate against file modification time
		const cached = memoryCache.get(docUri.fsPath);
		if (cached) {
			try {
				const stats = statSync(docUri.fsPath);
				// Use cache only if file hasn't been modified since we cached it
				if (stats.mtimeMs === cached.modTime) {
					if (performanceLogger) {
						performanceLogger.logSymbolFetch(docUri.fsPath, 0, cached.data.length);
					}
					return { path: docUri.fsPath, functions: cached.data };
				}
				// File was modified, invalidate cache
				invalidateFileCache(docUri.fsPath);
			} catch (err) {
				// If we can't stat the file, invalidate cache
			invalidateFileCache(docUri.fsPath);
			}
		}

		// Cache miss or invalidated - fetch symbols from VS Code API
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

		const result = await flattenSymbolsAsync(symbols, docUri.fsPath);

		if (performanceLogger && result.stats) {
			performanceLogger.logAsyncProcess(
				docUri.fsPath,
				result.elapsed,
				result.stats.processedSymbols,
				result.stats.createdFunctions,
				result.stats.memory
			);
		}

		// Store in memory cache with modification time
		if (result.functions.length > 0) {
			try {
				const stats = statSync(docUri.fsPath);
				memoryCache.set(docUri.fsPath, {
					data: result.functions,
					modTime: stats.mtimeMs
				});
			} catch (err) {
				// If we can't stat the file, store without modTime tracking
				// (file may have been deleted or is inaccessible)
			}
			return { path: docUri.fsPath, functions: result.functions };
		}

		return { path: docUri.fsPath, functions: null };
	} catch (error) {
		return { path: docUri.fsPath, functions: null };
	}
}

/**
 * Scan using VS Code's native symbol API (more accurate than custom parser)
 * Now using multiple parallel batches for performance
 * @param showPopup - Whether to show completion message
 * @param preDiscoveredDocs - Optional pre-discovered files to avoid duplicate discovery
 */
async function runScanUsingNativeSymbols(showPopup: boolean = true, preDiscoveredDocs?: vscode.Uri[]) {
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
		const failedFiles: string[] = [];

		const workspaceFolder = workspaceFolders[0];

		// Get all source files (either from pre-discovery during activation or discover now)
		let documents: vscode.Uri[];
		if (preDiscoveredDocs) {
			documents = preDiscoveredDocs;
		} else {
			documents = await vscode.workspace.findFiles(
				new vscode.RelativePattern(
					workspaceFolder,
					'**/*.{ts,tsx,js,jsx}'
				),
				`{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/out/**,**/coverage/**,**/.vscode/**,**/.cache/**,**/tmp/**,**/temp/**,**/.nuxt/**}`
			);
		}
		
		// Sort files alphabetically for deterministic processing order
		// This ensures the warmup file is processed early
		const sortedDocuments = documents.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
		


		// Process files in parallel batches to maximize throughput
		// Each batch processes up to SYMBOL_FETCH_BATCH_SIZE files concurrently
		// (Language servers serialize internally, this is optimal balance)
		const BATCH_SIZE = CONFIG.SYMBOL_FETCH_BATCH_SIZE;

		// Process all files in parallel batches
		for (let i = 0; i < sortedDocuments.length; i += BATCH_SIZE) {
			const batch = sortedDocuments.slice(i, i + BATCH_SIZE);
			const batchResults = await Promise.allSettled(batch.map(doc => processSingleFile(doc)));
			
			for (const result of batchResults) {
				if (result.status === 'fulfilled' && result.value.functions) {
					fileMap.set(result.value.path, result.value.functions);
					totalFunctions += result.value.functions.length;
				} else if (result.status === 'rejected') {
					const failedPath = result.reason?.path || 'Unknown';
					failedFiles.push(failedPath);
					logger.warn(`Failed to scan file: ${failedPath} - ${result.reason?.message || result.reason}`);
				}
			}
		}

		// Log summary of any failures
		if (failedFiles.length > 0) {
			logger.warn(`${failedFiles.length} file(s) failed to scan: ${failedFiles.join(', ')}`);
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
		const actualTotalFunctions = functionTreeProvider.getTotalCount(); // Use tree as source of truth

		// Log scan completion to performance logger
		if (performanceLogger) {
			performanceLogger.scanComplete(elapsed, documents.length, actualTotalFunctions);
		}

		logger.show();
		logger.info(
			`✓ Scan complete in ${elapsed}ms. Found ${actualTotalFunctions} functions in ${documents.length} files. | 📊 Log: ${performanceLogger?.getLogFilePath() || 'N/A'}\n`
		);

		if (showPopup) {
			vscode.window.showInformationMessage(
				`Function Scanner (Async): Found ${actualTotalFunctions} functions longer than 5 lines in ${elapsed}ms.`
			);
		}
	} catch (error) {
		const errorMsg = sanitizeErrorForUI(error);
		logger.error(
			'Async scan failed',
			toError(error)
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

	// Schedule rescan with debounce delay
	const timer = setTimeout(async () => {
		await rescanSingleFile(filePath);
		rescanTimers.delete(filePath);
	}, CONFIG.FILE_RESCAN_DEBOUNCE_MS);

	rescanTimers.set(filePath, timer);
}

/**
 * Rescan a single file and update the tree
 * Called when a file is modified or deleted (incremental scanning)
 */
async function rescanSingleFile(filePath: string): Promise<void> {
	try {
		// Validate file path for security
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || !validateFilePath(filePath, workspaceFolders[0].uri)) {
			logger.error(`Invalid or unsafe file path: ${filePath}`);
			return;
		}

		// Invalidate cache for this file
		invalidateFileCache(filePath);

		// If file was deleted or we can't read it, remove from tree
		if (!existsSync(filePath)) {
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

		const result = await flattenSymbolsAsync(symbols, filePath);

		// Cache the result with modification time
		if (result.functions.length > 0) {
			try {
				const stats = statSync(filePath);
				memoryCache.set(filePath, {
					data: result.functions,
					modTime: stats.mtimeMs
				});
			} catch (err) {
				// If we can't stat the file, skip caching
			}
			functionTreeProvider.updateSingleFile(filePath, result.functions);
		} else {
			functionTreeProvider.updateSingleFile(filePath, []);
		}

		updateStatusBar();
	} catch (error) {
		logger.warn(
			`Rescan failed for file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
		);
		// Continue execution - rescan failure is non-critical for already-cached data
	}
}

const FUNCTION_LIKE_KINDS = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor
]);

/**
 * Flatten nested DocumentSymbols using async/await with Promise-based recursion (Option 2)
 * Truly non-blocking with batched processing and yields between batches
 */
async function flattenSymbolsAsync(
	symbols: vscode.DocumentSymbol[],
	filePath: string,
	threshold: number = CONFIG.FUNCTION_LINE_THRESHOLD
): Promise<{ functions: FunctionMatch[]; elapsed: number; stats: any }> {
	const overallStart = performance.now();
	const startMemory = process.memoryUsage().heapUsed;
	let processedSymbols = 0;
	let createdFunctions = 0;
	const BATCH_SIZE = CONFIG.SYMBOL_PROCESSING_BATCH_SIZE; // Process symbols per batch, then yield

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
			if (FUNCTION_LIKE_KINDS.has(sym.kind)) {
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
			`[flattenSymbolsAsync] File: ${basename(filePath)} | ` +
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
			`Async processing failed for ${basename(filePath)}`,
			toError(error)
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

function updateStatusBar(): void {
	const total = functionTreeProvider.getTotalCount();
	setStatusBarEntry('#FF1493', `$(symbol-function) ${total} Functions > 5L`, `Found ${total} functions longer than 5 lines. Click to rescan.`);
	setBadge(total);	
}

function setStatusBarEntry( color: string, text: string, tooltip: string) {
	statusBarItem.text = text;
	statusBarItem.color = color;
	statusBarItem.tooltip = tooltip;
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
