/**
 * Symbol Processor Worker
 * Runs in a separate thread for non-blocking symbol processing
 */

import { parentPort } from 'worker_threads';

interface WorkerMessage {
	id: string;
	symbols: any[];
	filePath: string;
	threshold: number;
}

interface FunctionMatch {
	name: string;
	startLine: number;
	endLine: number;
	lineCount: number;
	metrics: Record<string, unknown>;
	children?: FunctionMatch[];
}

interface WorkerResult {
	id: string;
	functions: FunctionMatch[];
	stats: {
		processedSymbols: number;
		createdFunctions: number;
		elapsed: number;
		memory: number;
	};
}

/**
 * Process symbols in worker thread
 */
function processSymbols(
	syms: any[],
	parent: FunctionMatch | undefined,
	threshold: number,
	counters: { processed: number; created: number }
): FunctionMatch[] {
	const functions: FunctionMatch[] = [];

	for (const sym of syms) {
		counters.processed++;

		// Count only function-like symbols (kinds: 11=Function, 6=Method, 9=Constructor)
		if (sym.kind === 11 || sym.kind === 6 || sym.kind === 9) {
			const lineCount = sym.range.end.line - sym.range.start.line + 1;

			if (lineCount >= threshold) {
				const func: FunctionMatch = {
					name: sym.name,
					startLine: sym.range.start.line + 1,
					endLine: sym.range.end.line + 1,
					lineCount,
					metrics: { parser: 'vscode-symbols-worker' },
					children: [],
				};

				counters.created++;

				if (parent) {
					if (!parent.children) {
						parent.children = [];
					}
					parent.children.push(func);
				} else {
					functions.push(func);
				}

				if (sym.children) {
					const childFunctions = processSymbols(
						sym.children,
						func,
						threshold,
						counters
					);
					// Merge children if any were created
				}
			} else if (sym.children) {
				processSymbols(sym.children, parent, threshold, counters);
			}
		} else if (sym.children) {
			processSymbols(sym.children, parent, threshold, counters);
		}
	}

	return functions;
}

// Handle messages from main thread
if (parentPort) {
	parentPort.on('message', (message: WorkerMessage) => {
		const startTime = Date.now();
		const startMemory = process.memoryUsage().heapUsed;

		const counters = { processed: 0, created: 0 };

		try {
			const functions = processSymbols(
				message.symbols,
				undefined,
				message.threshold,
				counters
			);

			const elapsed = Date.now() - startTime;
			const memory =
				(process.memoryUsage().heapUsed - startMemory) / 1024; // KB

			const result: WorkerResult = {
				id: message.id,
				functions,
				stats: {
					processedSymbols: counters.processed,
					createdFunctions: counters.created,
					elapsed,
					memory,
				},
			};

			parentPort!.postMessage(result);
		} catch (error) {
			parentPort!.postMessage({
				id: message.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
