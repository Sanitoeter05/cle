/**
 * Performance Logger
 * Logs detailed performance metrics to a file for analysis
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface PerformanceEntry {
	timestamp: string;
	filePath?: string;
	stage: string; // 'start', 'symbols-fetch', 'async-process', 'tree-update', 'complete'
	duration?: number; // ms
	symbolCount?: number;
	functionCount?: number;
	memory?: number; // KB
	details?: Record<string, unknown>;
}

export class PerformanceLogger {
	private logFilePath: string;
	private entries: PerformanceEntry[] = [];
	private scanStartTime: number = 0;
	private sessionId: string;

	constructor(workspaceFolder: vscode.Uri) {
		// Validate workspace folder exists
		if (!fs.existsSync(workspaceFolder.fsPath)) {
			throw new Error(`Invalid workspace folder: ${workspaceFolder.fsPath}`);
		}

		// Safe session ID generation without problematic characters
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		const hours = String(now.getHours()).padStart(2, '0');
		const minutes = String(now.getMinutes()).padStart(2, '0');
		const seconds = String(now.getSeconds()).padStart(2, '0');
		const ms = String(now.getMilliseconds()).padStart(3, '0');
		const uniqueId = Math.random().toString(36).substring(2, 9);
		this.sessionId = `${year}-${month}-${day}T${hours}-${minutes}-${seconds}-${ms}Z-${uniqueId}`;

		const logsDir = path.join(workspaceFolder.fsPath, '.cle-logs');
		
		// Create logs directory with proper error handling
		try {
			if (!fs.existsSync(logsDir)) {
				fs.mkdirSync(logsDir, { recursive: true, mode: 0o755 });
			}
			
			// Test write permissions by attempting to create and delete a test file
			const testFile = path.join(logsDir, '.write-test');
			fs.writeFileSync(testFile, '');
			fs.unlinkSync(testFile);
		} catch (error) {
			throw new Error(`Cannot create or write to logs directory: ${logsDir}`);
		}
		
		this.logFilePath = path.join(logsDir, `performance-${this.sessionId}.log`);
		this.writeHeader();
	}

	private writeHeader(): void {
		const header = `
╔════════════════════════════════════════════════════════════════════════════════╗
║                              CLE Performance Log                               ║
╠════════════════════════════════════════════════════════════════════════════════╣
║ Session ID: ${this.sessionId}
║ Started: ${new Date().toISOString()}
╚════════════════════════════════════════════════════════════════════════════════╝

`;
		fs.writeFileSync(this.logFilePath, header);
	}

	scanStart(): void {
		this.scanStartTime = performance.now();
		this.entries = [];
		this.log({
			stage: 'SCAN_START',
			timestamp: new Date().toISOString(),
		});
	}

	logSymbolFetch(
		filePath: string,
		duration: number,
		symbolCount: number
	): void {
		this.log({
			stage: 'SYMBOLS_FETCH',
			filePath: path.basename(filePath),
			duration,
			symbolCount,
			timestamp: new Date().toISOString(),
		});
	}

	logAsyncProcess(
		filePath: string,
		duration: number,
		processedSymbols: number,
		createdFunctions: number,
		memory: number
	): void {
		this.log({
			stage: 'ASYNC_PROCESS',
			filePath: path.basename(filePath),
			duration,
			symbolCount: processedSymbols,
			functionCount: createdFunctions,
			memory,
			timestamp: new Date().toISOString(),
		});
	}

	logTreeUpdate(duration: number, fileCount: number): void {
		this.log({
			stage: 'TREE_UPDATE',
			duration,
			details: { fileCount },
			timestamp: new Date().toISOString(),
		});
	}

	scanComplete(totalDuration: number, totalFiles: number, totalFunctions: number): void {
		this.log({
			stage: 'SCAN_COMPLETE',
			duration: totalDuration,
			details: { totalFiles, totalFunctions },
			timestamp: new Date().toISOString(),
		});
		this.writeSummary();
	}

	private log(entry: PerformanceEntry): void {
		this.entries.push(entry);
		this.writeEntry(entry);
	}

	private writeEntry(entry: PerformanceEntry): void {
		const timeStr = `[${entry.timestamp}]`;
		let line = `${timeStr} ${entry.stage}`;

		if (entry.filePath) {
			line += ` | File: ${entry.filePath}`;
		}

		if (entry.duration !== undefined) {
			line += ` | Duration: ${entry.duration.toFixed(2)}ms`;
		}

		if (entry.symbolCount !== undefined) {
			line += ` | Symbols: ${entry.symbolCount}`;
		}

		if (entry.functionCount !== undefined) {
			line += ` | Functions: ${entry.functionCount}`;
		}

		if (entry.memory !== undefined) {
			line += ` | Memory: ${entry.memory > 0 ? '+' : ''}${entry.memory.toFixed(2)}KB`;
		}

		if (entry.details) {
			line += ` | ${JSON.stringify(entry.details)}`;
		}

		fs.appendFileSync(this.logFilePath, line + '\n');
	}

	private writeSummary(): void {
		const summary = this.calculateSummary();
		const summaryText = `
╔════════════════════════════════════════════════════════════════════════════════╗
║                              PERFORMANCE SUMMARY                               ║
╠════════════════════════════════════════════════════════════════════════════════╣
`;

		let summaryLines = summaryText;
		summaryLines += `║ Total Scan Time: ${summary.totalTime.toFixed(2)}ms\n`;
		summaryLines += `║ Files Processed: ${summary.fileCount}\n`;
		summaryLines += `║ Total Functions Found: ${summary.functionCount}\n`;
		summaryLines += `║ Total Symbols Processed: ${summary.totalSymbols}\n`;
		summaryLines += `║ \n`;
		summaryLines += `║ Breakdown:\n`;
		summaryLines += `║   - Total Symbol Fetch Time: ${summary.symbolFetchTime.toFixed(2)}ms (${(summary.symbolFetchTime / summary.totalTime * 100).toFixed(1)}%)\n`;
		summaryLines += `║   - Total Async Process Time: ${summary.asyncProcessTime.toFixed(2)}ms (${(summary.asyncProcessTime / summary.totalTime * 100).toFixed(1)}%)\n`;
		summaryLines += `║   - Tree Update Time: ${summary.treeUpdateTime.toFixed(2)}ms (${(summary.treeUpdateTime / summary.totalTime * 100).toFixed(1)}%)\n`;
		summaryLines += `║   - Other (API overhead, etc): ${(summary.totalTime - summary.symbolFetchTime - summary.asyncProcessTime - summary.treeUpdateTime).toFixed(2)}ms\n`;
		summaryLines += `║ \n`;
		summaryLines += `║ Slowest File: ${summary.slowestFile.name} (${summary.slowestFile.duration.toFixed(2)}ms)\n`;
		summaryLines += `║ Most Symbols: ${summary.mostSymbolsFile.name} (${summary.mostSymbolsFile.count} symbols)\n`;
		summaryLines += `║ \n`;

		if (summary.fileCount > 0) {
			summaryLines += `║ Average Time Per File: ${(summary.totalTime / summary.fileCount).toFixed(2)}ms\n`;
			summaryLines += `║ Average Symbols Per File: ${(summary.totalSymbols / summary.fileCount).toFixed(0)}\n`;
			summaryLines += `║ Average Functions Per File: ${(summary.functionCount / summary.fileCount).toFixed(1)}\n`;
		}

		summaryLines += `╚════════════════════════════════════════════════════════════════════════════════╝\n`;

		fs.appendFileSync(this.logFilePath, summaryText);
		fs.appendFileSync(this.logFilePath, summaryLines);

		// Also write detailed file breakdown
		this.writeDetailedBreakdown();
	}

	private writeDetailedBreakdown(): void {
		fs.appendFileSync(this.logFilePath, '\n╔════════════════════════════════════════════════════════════════════════════════╗\n');
		fs.appendFileSync(this.logFilePath, '║                           DETAILED FILE BREAKDOWN                              ║\n');
		fs.appendFileSync(this.logFilePath, '╠════════════════════════════════════════════════════════════════════════════════╣\n');

		// Filter for file-level entries
		const fileEntries = this.entries.filter(e => e.filePath);
		
		// Group by file
		const fileStats: Record<string, { fetch: number; process: number; symbols: number; functions: number }> = {};
		
		for (const entry of fileEntries) {
			if (!entry.filePath) {
				continue;
			}
			
			if (!fileStats[entry.filePath]) {
				fileStats[entry.filePath] = { fetch: 0, process: 0, symbols: 0, functions: 0 };
			}

			if (entry.stage === 'SYMBOLS_FETCH' && entry.duration) {
				fileStats[entry.filePath].fetch = entry.duration;
				fileStats[entry.filePath].symbols = entry.symbolCount || 0;
			} else if (entry.stage === 'ASYNC_PROCESS' && entry.duration) {
				fileStats[entry.filePath].process = entry.duration;
				fileStats[entry.filePath].functions = entry.functionCount || 0;
			}
		}

		// Sort by total time
		const sorted = Object.entries(fileStats)
			.map(([file, stats]) => ({
				file,
				total: stats.fetch + stats.process,
				...stats,
			}))
			.sort((a, b) => b.total - a.total);

		for (const stat of sorted) {
			const line = `║ ${stat.file.padEnd(40)} | Fetch: ${stat.fetch.toFixed(2)}ms | Process: ${stat.process.toFixed(2)}ms | Symbols: ${stat.symbols.toString().padStart(4)} | Functions: ${stat.functions.toString().padStart(3)} ║\n`;
			fs.appendFileSync(this.logFilePath, line);
		}

		fs.appendFileSync(this.logFilePath, '╚════════════════════════════════════════════════════════════════════════════════╝\n');
	}

	private calculateSummary() {
		const complete = this.entries.find(e => e.stage === 'SCAN_COMPLETE');
		const fetchEntries = this.entries.filter(e => e.stage === 'SYMBOLS_FETCH');
		const processEntries = this.entries.filter(e => e.stage === 'ASYNC_PROCESS');
		const updateEntry = this.entries.find(e => e.stage === 'TREE_UPDATE');

		const totalTime = complete?.duration ?? 0;
		const symbolFetchTime = fetchEntries.reduce((sum, e) => sum + (e.duration ?? 0), 0);
		const asyncProcessTime = processEntries.reduce((sum, e) => sum + (e.duration ?? 0), 0);
		const treeUpdateTime = updateEntry?.duration ?? 0;
		const fileCount = (complete?.details?.totalFiles as number) ?? 0;
		const functionCount = (complete?.details?.totalFunctions as number) ?? 0;
		const totalSymbols = fetchEntries.reduce((sum, e) => sum + (e.symbolCount ?? 0), 0);

		// Find slowest file
		let slowestFile = { name: 'N/A', duration: 0 };
		for (const entry of processEntries) {
			if (entry.duration && entry.duration > slowestFile.duration) {
				slowestFile = { name: entry.filePath || 'Unknown', duration: entry.duration };
			}
		}

		// Find file with most symbols
		let mostSymbolsFile = { name: 'N/A', count: 0 };
		for (const entry of fetchEntries) {
			if (entry.symbolCount && entry.symbolCount > mostSymbolsFile.count) {
				mostSymbolsFile = { name: entry.filePath || 'Unknown', count: entry.symbolCount };
			}
		}

		return {
			totalTime,
			symbolFetchTime,
			asyncProcessTime,
			treeUpdateTime,
			fileCount,
			functionCount,
			totalSymbols,
			slowestFile,
			mostSymbolsFile,
		};
	}

	getLogFilePath(): string {
		return this.logFilePath;
	}
}
