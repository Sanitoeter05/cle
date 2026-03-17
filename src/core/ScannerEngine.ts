/**
 * Central orchestrator for scanning operations.
 * Coordinates parsers, strategies, and caches.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { FunctionMatch, LanguageParser, AnalysisStrategy, CacheAdapter } from "../plugins/PluginInterface";
import { MemoryCacheAdapter } from "../plugins/builtin/MemoryCacheAdapter";

export interface ScannerConfig {
  /**
   * Concurrency limit for parallel file processing.
   * Default: 8
   */
  concurrencyLimit?: number;

  /**
   * File extensions to include. Empty array = all supported.
   */
  fileExtensions?: string[];

  /**
   * Directories to exclude from scanning.
   */
  excludeDirs?: Set<string>;

  /**
   * Progress callback for long scans.
   */
  onProgress?: (processed: number, total: number) => void;
}

export interface ScanResult {
  filePath: string;
  functions: FunctionMatch[];
}

export class ScannerEngine {
  constructor(
    private parser: LanguageParser,
    private strategy?: AnalysisStrategy,
    private cache?: CacheAdapter
  ) {}

  /**
   * Scan a single file.
   */
  async scanFile(filePath: string): Promise<ScanResult> {
    const ext = path.extname(filePath);

    // Skip files not handled by parser
    if (!this.parser.fileExtensions.includes(ext)) {
      return { filePath, functions: [] };
    }

    // Check cache first
    if (this.cache) {
      const cachedResults = await this.cache.get(filePath);
      if (cachedResults) {
        return { filePath, functions: cachedResults };
      }
    }

    // Read and parse file
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
      
      // Skip very large files (> 1MB) - likely minified or generated
      if (content.length > 1024 * 1024) {
        return { filePath, functions: [] };
      }
    } catch (error) {
      return { filePath, functions: [] };
    }

    // Parse functions
    let functions = await this.parser.parse(content, filePath);

    // Apply analysis strategy if configured
    if (this.strategy) {
      functions = await this.strategy.analyze(functions);
    }

    // Store in cache
    if (this.cache) {
      const fileHash = MemoryCacheAdapter.computeHash(content);
      if (this.cache instanceof MemoryCacheAdapter) {
        await this.cache.setWithHash(filePath, functions, fileHash);
      } else {
        await this.cache.set(filePath, functions);
      }
    }

    return { filePath, functions };
  }

  /**
   * Scan all files in workspace directory recursively.
   */
  async scanWorkspace(
    workspaceRoot: string,
    config: ScannerConfig = {}
  ): Promise<ScanResult[]> {
    const concurrencyLimit = config.concurrencyLimit || 16;
    const excludeDirs = config.excludeDirs || this.defaultExcludeDirs();
    const fileExtensions = config.fileExtensions || this.parser.fileExtensions;

    // Collect all eligible files
    const filePaths = await this.gatherFiles(
      workspaceRoot,
      excludeDirs,
      fileExtensions
    );

    // Process files with concurrency limit
    const results: ScanResult[] = [];
    for (let i = 0; i < filePaths.length; i += concurrencyLimit) {
      const batch = filePaths.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(
        batch.map((fp) => this.scanFile(fp))
      );

      results.push(...batchResults);

      // Call progress callback
      if (config.onProgress) {
        config.onProgress(Math.min(i + concurrencyLimit, filePaths.length), filePaths.length);
      }
    }

    return results;
  }

  /**
   * Recursively gather all eligible files in a directory.
   */
  private async gatherFiles(
    dir: string,
    excludeDirs: Set<string>,
    fileExtensions: string[]
  ): Promise<string[]> {
    const files: string[] = [];
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Check if directory should be excluded by name
          if (excludeDirs.has(entry.name)) {
            continue;
          }
          
          // Also exclude any path containing node_modules, dist, etc (safety check)
          if (fullPath.includes('/node_modules/') || fullPath.includes('/dist/') || 
              fullPath.includes('/build/') || fullPath.includes('/.git/')) {
            continue;
          }
          
          try {
            const subFiles = await this.gatherFiles(fullPath, excludeDirs, fileExtensions);
            files.push(...subFiles);
          } catch (error) {
            // Skip directories that can't be read
            continue;
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          
          // Skip minified files (e.g., .min.js, .min.ts)
          if (entry.name.endsWith('.min.js') || entry.name.endsWith('.min.ts') || 
              entry.name.endsWith('.min.jsx') || entry.name.endsWith('.min.tsx')) {
            continue;
          }
          
          if (fileExtensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      // Skip directories that can't be read
    }

    return files;
  }

  /**
   * Default directories to exclude from scanning.
   */
  private defaultExcludeDirs(): Set<string> {
    return new Set([
      "node_modules",
      ".git",
      ".vscode",
      "dist",
      "build",
      "coverage",
      ".next",
      "out",
      ".nuxt",
      ".cache",
      "tmp",
      "temp",
    ]);
  }

  /**
   * Clear all cached data.
   */
  async clearCache(): Promise<void> {
    if (this.cache) {
      await this.cache.clear();
    }
  }
}
