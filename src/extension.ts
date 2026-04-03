/**
 * Function Scanner Extension for Visual Studio Code
 * Detects functions using VS Code's native symbol API
 */

import * as vscode from 'vscode';
import { basename, normalize } from 'path';
import { Logger } from './utils/Logger';
import { PerformanceLogger } from './utils/PerformanceLogger';
import { existsSync, statSync, Stats } from 'fs';

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
		treeItem.command = {command: 'cle.openFunction',title: 'Open Function',arguments: [element.filePath, element.startLine]};
	};

	private async filterChildrensForFunction(){
		const files: FunctionNode[] = [];
		const promises = this.mapArray(files); 
		await Promise.all(promises);
		return files;
	};

	private mapArray(files: FunctionNode[]) {
		return Array.from(this.functionsData).map(([filePath, functions]) =>
			this.checkFile(functions, filePath, files)
		);
	}

	private async checkFile(functions: FunctionMatch[], filePath: string, files: FunctionNode[]){
		if (functions.length > 0) {
			const count = functions.length;
			files.push(new FunctionNode(basename(filePath),vscode.TreeItemCollapsibleState.Collapsed,'file',filePath,0,undefined,count));
		};
	};

	private checkFiles(element: FunctionNode){
		const functions = this.functionsData.get(element.filePath) || [];
		const functionNodes = functions.map(fn => {
			return this.functionHasChildren(fn, element);
		});
		return functionNodes;
	};

	private functionHasChildren(fn:FunctionMatch, element: FunctionNode): FunctionNode {
		const hasChildren = fn.children && fn.children.length > 0;
		return new FunctionNode(`${fn.name} (${fn.lineCount} lines)`,hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,'function',element.filePath,fn.startLine,fn);
	};

	private checkChildrenFunctions(element: FunctionNode): FunctionNode[] {
		if(!element.funcMatch?.children) {
			return [];
		}
		const children = element.funcMatch.children;
		return (children.map(child => {return this.functionHasChildren(child, element);}));
	};

	public getChildren(element?: FunctionNode): Thenable<FunctionNode[]> {
		if (!element) {
			return this.emptyMessage();
		} else if (element.type === 'file') {
			return Promise.resolve(this.checkFiles(element));
		} else if (element.type === 'function' && element.funcMatch?.children) {
			return Promise.resolve(this.checkChildrenFunctions(element));
		}
		return Promise.resolve([]);
	}

	private async emptyMessage(){
		let files = this.getDefaultMessage(await this.filterChildrensForFunction());						
		return files;
	}

	private getDefaultMessage(files: FunctionNode[]): FunctionNode[] {
		if (files.length === 0) {
			files.push(new FunctionNode('👉 Run "Scan for Functions Longer Than 5 Lines" to begin', vscode.TreeItemCollapsibleState.None, 'empty', '', 0, undefined));
		};
		return files;
	};

	/**
	 * Compare two arrays of FunctionMatch objects for equality
	 * Returns true if arrays have same length and all elements are equal
	 */
	private arraysEqual(arr1: FunctionMatch[], arr2: FunctionMatch[]): boolean {
		if (arr1.length !== arr2.length && !this.compareFunctionArrays(arr1, arr2)) {
			return false;
		}
		return true;
	}

	private compareFunctionArrays(arr1: FunctionMatch[], arr2: FunctionMatch[]): boolean | void {
		for (let i = 0; i < arr1.length; i++) {
			if (this.functionMatchEqual(arr1[i], arr2[i])) {
				return true;
		  	}
		}; 
	};

	/**
	 * Compare two FunctionMatch objects for equality
	 * Performs recursive comparison of children arrays
	 */
	private functionMatchEqual(fn1: FunctionMatch, fn2: FunctionMatch): boolean {
		if (this.comparePropertys(fn1, fn2)&& this.compeareArrayHasChildren(fn1, fn2) && (fn1.children && fn2.children)) {
			return this.arraysEqual(fn1.children, fn2.children );
		}
		return false;
	}

	private comparePropertys(fn1: FunctionMatch, fn2: FunctionMatch): boolean {
		if (fn1.name !== fn2.name || fn1.startLine !== fn2.startLine || fn1.endLine !== fn2.endLine || fn1.lineCount !== fn2.lineCount) {
			return false;
		}
		return true;
	};

	private compeareArrayHasChildren(fn1: FunctionMatch, fn2: FunctionMatch): boolean {
		if ((!fn1.children && fn2.children) || (fn1.children && !fn2.children)) {
			return false;
		};
		return true;
	};

	updateData(fileMap: Map<string, FunctionMatch[]>) {
		let changed = false;
		changed = this.addFilesToMap(fileMap, changed);
		changed = this.removeDeletedFilesFromMap(fileMap,changed);
		this.fireIfChanged(changed);
	};

	public removeDeletedFilesFromMap(fileMap: Map<string, FunctionMatch[]>, changed:boolean): boolean {
		for (const filePath of this.functionsData.keys()) {
			changed = this.DeleteFileWhenPersistent(filePath,fileMap ,changed);
		}
		return changed;
	};

	private DeleteFileWhenPersistent(filePath: string, fileMap: Map<string, FunctionMatch[]>, changed:boolean): boolean {
		if (!fileMap.has(filePath) || fileMap.get(filePath)!.length === 0) {
			this.functionsData.delete(filePath);
			changed = true;
		}
		return changed;
	};

	public addFilesToMap(fileMap: Map<string, FunctionMatch[]>, changed:boolean =false): boolean {
		for (const [filePath, newFunctions] of fileMap) {
			if (this.updateProcess(newFunctions, filePath)) {changed = true;}
		}
		return changed;
	};

	private updateProcess(newFunctions: FunctionMatch[], filePath: string): boolean{
		if (newFunctions.length > 0) {
			const oldFunctions = this.functionsData.get(filePath);
			return this.updateIfChanged(oldFunctions, newFunctions, filePath);
		}
		return false;
	};

	private updateIfChanged(oldFunctions: FunctionMatch[] | undefined, newFunctions: FunctionMatch[], filePath: string): boolean {
		if (!oldFunctions || !this.arraysEqual(oldFunctions, newFunctions)) {
			this.functionsData.set(filePath, newFunctions);
			return true;
		}
		return false;
	};

	public updateSingleFile(filePath: string, functions: FunctionMatch[]) {
		let hasChanged = false;
		const oldFunctions = this.functionsData.get(filePath);
		hasChanged = this.updateContend(filePath, functions, oldFunctions);
		this.fireIfChanged(hasChanged);
	}

	private updateContend(filePath: string, functions: FunctionMatch[],oldFunctions: FunctionMatch[] | undefined): boolean {
		if (functions.length > 0) {
			return this.dataDifferesFromData(oldFunctions, functions, filePath);
		} else {
			return this.checkIfEntryExisted(oldFunctions, filePath);
		}
	};

	private checkIfEntryExisted(oldFunctions: FunctionMatch[] | undefined, filePath: string): boolean {
		if (oldFunctions !== undefined) {
			this.functionsData.delete(filePath);
			return true;
		};
		return false;
	};

	private dataDifferesFromData(oldFunctions: FunctionMatch[] | undefined, functions: FunctionMatch[], filePath: string){
		if (!oldFunctions || !this.arraysEqual(oldFunctions, functions)) {
			this.functionsData.set(filePath, functions);
			return true;
		}
		return false;
	};

	private fireIfChanged(hasChanged: boolean): void {
		if (hasChanged) {
			this._onDidChangeTreeData.fire();
		}
	};
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
	constructor( public label: string, public collapsibleState: vscode.TreeItemCollapsibleState, public type: 'file' | 'function' | 'empty', public filePath: string, public startLine: number, public funcMatch?: FunctionMatch, public functionCount: number = 0 ) {}
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

async function openFunctionCallback(filePath: string, startLine: number): Promise<void> {
	const document = await vscode.workspace.openTextDocument(filePath);
	const editor = await vscode.window.showTextDocument(document);
	const range = new vscode.Range(startLine - 1, 0, startLine - 1, 0);
	editor.selection = new vscode.Selection(range.start, range.start);
	editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

function registerOpenFunctionCommand(context: vscode.ExtensionContext) {
	const openFunctionDisposable = vscode.commands.registerCommand('cle.openFunction', openFunctionCallback);
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
	fileWatcher.onDidChange(async (uri) => {scheduleFileScan(uri.fsPath);});
	fileWatcher.onDidCreate(async (uri) => {scheduleFileScan(uri.fsPath);});
	fileWatcher.onDidDelete(deleteWatcherListener);
	context.subscriptions.push(fileWatcher);
};

async function deleteWatcherListener (uri: vscode.Uri){
	removeRescan(uri);
	functionTreeProvider.updateSingleFile(uri.fsPath, []);
	updateStatusBar();
}

function removeRescan(uri: vscode.Uri){
	const timer = rescanTimers.get(uri.fsPath);
	clearRescanTimer(timer, uri);
	invalidateFileCache(uri.fsPath);
};

function clearRescanTimer(timer: NodeJS.Timeout | undefined, uri: vscode.Uri) {
	if (timer) {
		clearTimeout(timer);
		rescanTimers.delete(uri.fsPath);
	}
};

export async function activate(context: vscode.ExtensionContext) {
	intitialRegistry(context);
	registerLogger(context);
	await initialScan();
}

function intitialRegistry(context: vscode.ExtensionContext){
	initTreeView(context);
	registerOpenFunctionCommand(context);
	RegisterScanCommand(context);
	createStatusBarItem(context);
	createFileWatcher(context);
};

function registerLogger(context: vscode.ExtensionContext){
	logger = new Logger('Function Scanner');
	context.subscriptions.push(logger);
};

async function initialScan(){
	const workspaceFolders = initPerformanceLogger();
	if (workspaceFolders) {
		tryUpdate(workspaceFolders);
	}
};

async function tryUpdate(workspaceFolders: readonly vscode.WorkspaceFolder[]) {
	try {
		const documents = await getAllFiles(workspaceFolders[0]);
		await updateDocuments(documents);
	} catch (error) {runScanUsingNativeSymbols(false);}
};

async function updateDocuments(documents: vscode.Uri[] | null) {
	if (documents && documents.length > 0) {
		await startScan(documents);
	} else {
		runScanUsingNativeSymbols(false);
	}
};

async function startScan(documents: vscode.Uri[]) {
	await warmupLanguageServer(documents);
	await new Promise(resolve => setTimeout(resolve, CONFIG.LANGUAGE_SERVER_WARMUP_DELAY_MS));
	runScanUsingNativeSymbols(false, documents);
};

async function getAllFiles(workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Uri[] | null> {
	const documents = await vscode.workspace.findFiles(
	new vscode.RelativePattern(workspaceFolder, '**/*.{ts,tsx,js,jsx}'),`{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/out/**,**/coverage/**,**/.vscode/**,**/.cache/**,**/tmp/**,**/temp/**,**/.nuxt/**}`);
	return checkDocument(documents);
};

function checkDocument(documents: vscode.Uri[]): vscode.Uri[] | null {
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
	message = limitLentgh(message);
	message = redactPaths(message);
	message = redactCreds(message);
	return message;
}

function limitLentgh(message: string): string {
	if (message.length > 200) {
		message = message.slice(0, 200) + '...';
	}
	return message;
};

function redactPaths(message: string): string {
	message = message.replace(/\/home\/[\w\-]+/g, '~');
	message = message.replace(/[A-Z]:\\Users\\[\w\-]+/g, '~');
	return message;
};

function redactCreds(message: string): string {
	message = message.replace(/token['"\':\s=]+[^\s'"\']+/gi, 'token=[REDACTED]');
	message = message.replace(/password['"\':\s=]+[^\s'"\']+/gi, 'password=[REDACTED]');
	return message;
};

const testFilePatterns =[/test/i, /spec/i, /mock/i];

/**
 * Validate that a file path is within the workspace boundaries
 * Prevents path traversal and symlink attacks
 * @param filePath - The file path to validate
 * @param workspaceFolder - The workspace folder URI
 * @returns true if path is safe and within workspace, false otherwise
 */
function validateFilePath(filePath: string, workspaceFolder: vscode.Uri): boolean {
    const paths = preparePaths(filePath, workspaceFolder);
    return isPathValid(paths);
}

function preparePaths(filePath: string, workspaceFolder: vscode.Uri) {
    return {
        normalized: normalize(filePath),
        workspace: normalize(workspaceFolder.fsPath),
        original: filePath
    };
}

function isPathValid(paths: ReturnType<typeof preparePaths>): boolean {
    if (isSuspiciousPath(paths.normalized, paths.original)||isPathOutsideWorkspace(paths.normalized, paths.workspace, paths.original)) {
		return false;
	}
    return true;
}

function isSuspiciousPath(normalizedPath: string, filePath: string): boolean {
	if (normalizedPath.includes('..') || normalizedPath.includes('.git')) {
		logger.warn(`Suspicious path detected: ${filePath}`);
		return true;
	}
	return false;
};

function isPathOutsideWorkspace(normalizedPath: string, workspacePath: string, filePath: string): boolean {
	if (!normalizedPath.startsWith(workspacePath)) {
		logger.warn(`Path outside workspace: ${filePath}`);
		return true;
	}
	return false;
};

/**
 * Pre-warm the language server by fetching symbols from multiple files
 * This initializes the JS language server before the parallel batch scan begins
 * Warmup with 2-3 files ensures LS is fully ready for parallel batch processing
 * @param documents - Pre-discovered list of source files (avoids duplicate discovery)
 */
async function warmupLanguageServer(documents: vscode.Uri[]): Promise<void> {
	try {
		warmUp(documents);
	} catch (error) {
		logger.warn(`Language server warmup encountered an error: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function warmUp(documents: vscode.Uri[]): void {
	const sortedDocs = documents.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
	const warmupFiles = findWarmupFiles(sortedDocs, CONFIG.MAX_WARMUP_FILES);
	warmUpIfFound(warmupFiles);
};

function warmUpIfFound(warmupFiles: vscode.Uri[]): void {
	if (warmupFiles.length > 0) {
		fetchSymbolsForWarmupFile(warmupFiles);
	}
};

async function fetchSymbolsForWarmupFile(warmupFiles: vscode.Uri[]): Promise<void> {
	for (const warmupFile of warmupFiles) {
		await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider',warmupFile);
	}
};

/**
 * Find first N non-test files for warmup
 */
function findWarmupFiles(sortedDocs: vscode.Uri[], count: number): vscode.Uri[] {
    return sortedDocs
        .filter(doc => !isNonTestFile(doc))
        .slice(0, count);
}

function isNonTestFile(doc: vscode.Uri): boolean {
    const filename = doc.fsPath.toLowerCase();
    return !testFilePatterns.some(pattern => pattern.test(filename));
}

/**
 * Process a single file to extract function symbols
 * Handles caching, symbol fetching, and flattening with error recovery
 * @param docUri - URI of the file to processr
 * @returns Object with file path and extracted functions (or null on error)
 */
async function processSingleFile(docUri: vscode.Uri): Promise<{ path: string; functions: FunctionMatch[] | null }> {
	try {
		if(!validateFilePathForSingleScan(docUri)){return { path: docUri.fsPath, functions: null };}

		// Check memory cache first - validate against file modification time
		// Optimization: Reuse stats object to avoid duplicate statSync() calls
		let fileStats: Stats | null = null;
		const cached = memoryCache.get(docUri.fsPath);
		if (cached) {
			try {
				fileStats = statSync(docUri.fsPath);
				// Use cache only if file hasn't been modified since we cached it
				if (fileStats.mtimeMs === cached.modTime) {
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
				// Only call statSync if we haven't already called it above
				// This eliminates the duplicate statSync() on cache validation
				if (!fileStats) {
					fileStats = statSync(docUri.fsPath);
				}
				memoryCache.set(docUri.fsPath, {
					data: result.functions,
					modTime: fileStats.mtimeMs
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

function validateFilePathForSingleScan(docUri: vscode.Uri):boolean{
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || !validateFilePath(docUri.fsPath, workspaceFolders[0].uri)) {
		logger.error(`Invalid or unsafe file path: ${docUri.fsPath}`);
		return false;
	}
	return true;
};

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
	clearTimer(filePath);
	clearSingleRescanTimer(filePath);
};

function clearTimer(filePath: string){
	const existingTimer = rescanTimers.get(filePath);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}
};

function clearSingleRescanTimer(filePath: string) {
	const timer = setTimeout(async () => {await rescanSingleFile(filePath);rescanTimers.delete(filePath);}, CONFIG.FILE_RESCAN_DEBOUNCE_MS);
	rescanTimers.set(filePath, timer);
};

/**
 * Rescan a single file and update the tree
 * Called when a file is modified or deleted (incremental scanning)
 */
async function rescanSingleFile(filePath: string): Promise<void> {
	try {
		await scanProcsses(filePath);
	} catch (error) {
		logger.warn(`Rescan failed for file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function scanProcsses(filePath: string): Promise<void> {
	if(!validateFilePathForRescan(filePath) || removeIfNotExists(filePath)) {return;}
	const docUri = vscode.Uri.file(filePath);
	const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider',docUri);
	await scaning(filePath, symbols);
};

async function scaning(filePath: string, symbols: vscode.DocumentSymbol[]): Promise<void> {
	invalidateFileCache(filePath);
	updateTreeForEmptySymbols(filePath, symbols);
	const result = await flattenSymbolsAsync(symbols, filePath);
	cacheResult(result, filePath);
	updateStatusBar();
};

function removeIfNotExists(filePath: string): boolean {
	if (!existsSync(filePath)) {
		functionTreeProvider.updateSingleFile(filePath, []);
		updateStatusBar(); return true; }
	return false;
};

function validateFilePathForRescan(filePath: string): boolean {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || !validateFilePath(filePath, workspaceFolders[0].uri)) {
		logger.error(`Invalid or unsafe file path: ${filePath}`); return false;}
	return true;
};

function updateTreeForEmptySymbols(filePath: string, symbols: vscode.DocumentSymbol[] | undefined) {
	if (!symbols || symbols.length === 0) {
		functionTreeProvider.updateSingleFile(filePath, []);
		updateStatusBar();
		return;
	}
};

function cacheResult(result: { functions: FunctionMatch[]; elapsed: number; stats: any }, filePath: string, ): void {
	if (result.functions.length > 0) {
		tryCaching(filePath, result);
		functionTreeProvider.updateSingleFile(filePath, result.functions);
	} else {
		functionTreeProvider.updateSingleFile(filePath, []);
	}
};

function tryCaching(filePath: string, result: { functions: FunctionMatch[]; elapsed: number; stats: any }): void {
	try {
		const stats = statSync(filePath);
		memoryCache.set(filePath, {data: result.functions,modTime: stats.mtimeMs});
	} catch (err) {logger.error(`Failed to stat file for caching: ${filePath} - ${err instanceof Error ? err.message : String(err)}`);}
};


const FUNCTION_LIKE_KINDS = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor
]);

/**
 * Flatten nested DocumentSymbols using async/await with Promise-based recursion (Option 2)
 * Truly non-blocking with batched processing and yields between batches
 */
async function flattenSymbolsAsync(symbols: vscode.DocumentSymbol[], filePath: string, threshold: number = CONFIG.FUNCTION_LINE_THRESHOLD, processedSymbols:number = 0,createdFunctions:number = 0, functions: FunctionMatch[] = []): Promise<{ functions: FunctionMatch[]; elapsed: number; stats: any }> {
	const overallStart = performance.now();
	const startMemory = process.memoryUsage().heapUsed;
	const BATCH_SIZE = CONFIG.SYMBOL_PROCESSING_BATCH_SIZE; // Process symbols per batch, then yield
	return await tryFlattenSymbols(processedSymbols, createdFunctions, functions, symbols, threshold, BATCH_SIZE, overallStart, startMemory, filePath);
}

async function tryFlattenSymbols(processedSymbols:number, createdFunctions:number, functions: FunctionMatch[], symbols: vscode.DocumentSymbol[], threshold: number, BATCH_SIZE: number, overallStart: number, startMemory: number, filePath: string): Promise<{ functions: FunctionMatch[]; elapsed: number; stats: any }> {
	try {return await getFunctionSymbols(overallStart, startMemory, processedSymbols, createdFunctions, functions, symbols, threshold, BATCH_SIZE, filePath);} 
	catch (error) {
		logger.error(`Async processing failed for ${basename(filePath)}`,toError(error));
		return {functions: [],elapsed: performance.now() - overallStart,stats: {processedSymbols: 0,createdFunctions: 0,elapsed: 0,memory: 0,},};
	}
};

async function getFunctionSymbols(overallStart: number, startMemory: number, processedSymbols:number, createdFunctions:number, functions: FunctionMatch[], symbols: vscode.DocumentSymbol[], threshold: number, BATCH_SIZE: number, filePath: string): Promise<{ functions: FunctionMatch[]; elapsed: number; stats: any }> {
	({ processedSymbols, createdFunctions, functions } = await processSymbolsAsync(symbols, processedSymbols, createdFunctions, threshold, BATCH_SIZE, functions));
	const overallElapsed = performance.now() - overallStart;
	const memoryDelta =(process.memoryUsage().heapUsed - startMemory) / 1024; // KB delta
	logger.info(`[flattenSymbolsAsync] File: ${basename(filePath)} | ` +`Processed: ${processedSymbols} symbols | ` +`Created: ${createdFunctions} functions | ` +`Time: ${overallElapsed.toFixed(2)}ms | ` +`Memory: ${memoryDelta > 0 ? '+' : ''}${memoryDelta.toFixed(2)}KB`);
	return {functions,elapsed: overallElapsed,stats: {processedSymbols,createdFunctions,elapsed: overallElapsed,memory: memoryDelta,},};
};

// Async recursive function that batches symbols and yields between batches
async function processSymbolsAsync(syms: vscode.DocumentSymbol[], processedSymbols: number, createdFunctions: number,threshold: number , BATCH_SIZE: number, functions: FunctionMatch[], parent?: FunctionMatch): Promise<{ processedSymbols: number; createdFunctions: number; functions: FunctionMatch[] }> {
	for (let i = 0; i < syms.length; i++) {
		const sym = syms[i];
		processedSymbols++;

		// Count only function-like symbols
		if (FUNCTION_LIKE_KINDS.has(sym.kind)) {
			const lineCount =
				(sym.range.end.line) - (sym.range.start.line + 1);

			if (lineCount > threshold) {
				const func: FunctionMatch = {
					name: sym.name,
					startLine: sym.range.start.line + 1,
					endLine: sym.range.end.line - 1,
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
					({ processedSymbols, createdFunctions, functions } = await processSymbolsAsync(sym.children, processedSymbols, createdFunctions, threshold, BATCH_SIZE, functions, func));
				}
			} else if (sym.children) {
					// Still check children even if parent is below threshold
				({ processedSymbols, createdFunctions, functions } = await processSymbolsAsync(sym.children, processedSymbols, createdFunctions, threshold, BATCH_SIZE, functions, parent));
			}
		} else if (sym.children) {
			// For non-function symbols (classes, interfaces), check their children
			({ processedSymbols, createdFunctions, functions } = await processSymbolsAsync(sym.children, processedSymbols, createdFunctions, threshold, BATCH_SIZE, functions, parent));
		}

		// Yield after every BATCH_SIZE symbols to break up the work
		if ((i + 1) % BATCH_SIZE === 0) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	}
	return { processedSymbols, createdFunctions, functions};
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

export function deactivate() {
	scanClearTimeouts(scanTimeout);
	fileWatcherDispose(fileWatcher);
	statusBarItemDispose(statusBarItem);
	loggerDispose(logger);
};

function scanClearTimeouts(scanTimeout: NodeJS.Timeout | undefined) {
	if (scanTimeout) {
		clearTimeout(scanTimeout);
	}
};

function fileWatcherDispose(fileWatcher: vscode.FileSystemWatcher | undefined) {
	if (fileWatcher) {
		fileWatcher.dispose();
	}
};

function statusBarItemDispose(statusBarItem: vscode.StatusBarItem | undefined) {
	if (statusBarItem) {
		statusBarItem.dispose();
	}
};

function loggerDispose(logger: Logger | undefined) {
	if (logger) {
		logger.dispose();
	}
};