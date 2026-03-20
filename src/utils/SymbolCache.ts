/**
 * Symbol Cache
 * Caches document symbols to avoid re-fetching unchanged files
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface CachedSymbols {
	symbols: vscode.DocumentSymbol[];
	timestamp: number;
	hash: string;
}

export class SymbolCache {
	private cache: Map<string, CachedSymbols> = new Map();
	private fileHashes: Map<string, string> = new Map();

	/**
	 * Get cached symbols for a file
	 */
	get(filePath: string): vscode.DocumentSymbol[] | null {
		const cached = this.cache.get(filePath);
		if (!cached) {
			return null;
		}

		// Check if file still exists and hasn't been modified
		try {
			const stats = fs.statSync(filePath);
			const currentHash = this.hashFileStats(stats);

			if (cached.hash === currentHash) {
				return cached.symbols;
			}
		} catch (error) {
			// File doesn't exist or can't be read, invalidate cache
			this.invalidate(filePath);
			return null;
		}

		// File was modified, invalidate
		this.invalidate(filePath);
		return null;
	}

	/**
	 * Set cached symbols for a file
	 */
	set(filePath: string, symbols: vscode.DocumentSymbol[]): void {
		try {
			const stats = fs.statSync(filePath);
			const hash = this.hashFileStats(stats);

			this.cache.set(filePath, {
				symbols,
				timestamp: Date.now(),
				hash,
			});

			this.fileHashes.set(filePath, hash);
		} catch (error) {
			// Can't cache if we can't get file stats
		}
	}

	/**
	 * Invalidate cache for a specific file
	 */
	invalidate(filePath: string): void {
		this.cache.delete(filePath);
		this.fileHashes.delete(filePath);
	}

	/**
	 * Clear all cache
	 */
	clear(): void {
		this.cache.clear();
		this.fileHashes.clear();
	}

	/**
	 * Get stats about cache
	 */
	getStats() {
		return {
			cachedFiles: this.cache.size,
			cacheSize: Array.from(this.cache.values()).reduce(
				(sum, c) => sum + JSON.stringify(c.symbols).length,
				0
			),
		};
	}

	/**
	 * Create a simple hash from file stats
	 */
	private hashFileStats(stats: fs.Stats): string {
		// Use mtime and size as a simple hash
		return `${stats.mtimeMs}-${stats.size}`;
	}
}
