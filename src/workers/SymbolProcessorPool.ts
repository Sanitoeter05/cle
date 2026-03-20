/**
 * Worker Thread Manager
 * Manages a pool of worker threads for symbol processing
 */

import { Worker } from 'worker_threads';
import * as path from 'path';

interface ProcessRequest {
	symbols: any[];
	filePath: string;
	threshold: number;
}

interface ProcessResult {
	functions: any[];
	stats: {
		processedSymbols: number;
		createdFunctions: number;
		elapsed: number;
		memory: number;
	};
}

export class SymbolProcessorPool {
	private worker: Worker | null = null;
	private queue: Array<{
		id: string;
		request: ProcessRequest;
		resolve: (result: ProcessResult) => void;
		reject: (error: Error) => void;
	}> = [];
	private processing = false;

	constructor() {
		this.initializeWorker();
	}

	private initializeWorker(): void {
		try {
			// Try to load compiled worker first, fall back to source
			let workerPath = path.join(__dirname, 'symbolProcessor.worker.js');
			
			// For development, try TypeScript file location
			try {
				require.resolve(workerPath);
			} catch {
				workerPath = path.join(__dirname, '..', 'workers', 'symbolProcessor.worker.ts');
			}

			this.worker = new Worker(workerPath, {
				execArgv: process.env.NODE_DEBUG_OPTION ? [process.env.NODE_DEBUG_OPTION] : []
			});

			this.worker.on('message', (message: any) => {
				this.handleWorkerMessage(message);
			});

			this.worker.on('error', (error) => {
				console.error('Worker error:', error);
				this.restartWorker();
			});

			this.worker.on('exit', (code) => {
				console.warn('Worker exited with code:', code);
				this.worker = null;
				this.restartWorker();
			});
		} catch (error) {
			console.error('Failed to initialize worker:', error);
		}
	}

	private restartWorker(): void {
		this.worker = null;
		setTimeout(() => this.initializeWorker(), 100);
	}

	private handleWorkerMessage(message: any): void {
		// Find request by ID
		const index = this.queue.findIndex((item) => item.id === message.id);
		if (index !== -1) {
			const { resolve, reject } = this.queue[index];
			this.queue.splice(index, 1);

			if (message.error) {
				reject(new Error(message.error));
			} else {
				resolve({
					functions: message.functions,
					stats: message.stats,
				});
			}
		}

		this.processing = false;
		this.processNext();
	}

	async process(request: ProcessRequest): Promise<ProcessResult> {
		return new Promise((resolve, reject) => {
			const id = `${Date.now()}-${Math.random()}`;
			this.queue.push({ id, request, resolve, reject });
			this.processNext();
		});
	}

	private processNext(): void {
		if (this.processing || this.queue.length === 0 || !this.worker) {
			return;
		}

		this.processing = true;
		const { id, request } = this.queue[0];

		this.worker.postMessage({
			id,
			symbols: request.symbols,
			filePath: request.filePath,
			threshold: request.threshold,
		});
	}

	dispose(): void {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		this.queue = [];
	}
}

// Export singleton
export const symbolProcessorPool = new SymbolProcessorPool();
