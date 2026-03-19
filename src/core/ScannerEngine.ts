/**
 * Central orchestrator for scanning operations.
 * Coordinates parsers, strategies, and caches.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
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

export interface ScanTimings {
  gatherTime: number;  // Time to gather/discover files
  scanTime: number;    // Time to parse all files
  totalTime: number;   // Total time
  fileCount: number;   // Number of files scanned
  functionsCount: number; // Total functions found
}

export class ScannerEngine {
  private lastScanTimings: ScanTimings | null = null;

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

    // Check cache using mtime (fast - no file read needed)
    if (this.cache) {
      try {
        const stat = await fs.stat(filePath);
        const mtimeKey = `${filePath}:${stat.mtimeMs}`; // file path + modification time
        const cachedResults = await this.cache.get(mtimeKey);
        
        if (cachedResults) {
          return { filePath, functions: cachedResults };
        }
      } catch (error) {
        // File doesn't exist or can't be stat'd, continue to parse attempt
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

    // Store in cache with mtime-based key
    if (this.cache) {
      try {
        const stat = await fs.stat(filePath);
        const mtimeKey = `${filePath}:${stat.mtimeMs}`;
        const fileHash = MemoryCacheAdapter.computeHash(content);
        
        if (this.cache instanceof MemoryCacheAdapter) {
          await this.cache.setWithHash(mtimeKey, functions, fileHash);
        } else {
          await this.cache.set(mtimeKey, functions);
        }
      } catch (error) {
        // Silently fail cache write
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
    const concurrencyLimit = config.concurrencyLimit || 64; // Increased from 16 - stat() is very fast
    const excludeDirs = config.excludeDirs || this.defaultExcludeDirs();
    const fileExtensions = config.fileExtensions || this.parser.fileExtensions;

    // Timing instrumentation for bottleneck detection
    const timings = {
      start: Date.now(),
      gatherStart: 0,
      gatherEnd: 0,
      scanStart: 0,
      scanEnd: 0
    };

    // Collect all eligible files using optimized file discovery
    timings.gatherStart = Date.now();
    const filePaths = await this.gatherFiles(
      workspaceRoot,
      excludeDirs,
      fileExtensions
    );
    timings.gatherEnd = Date.now();

    // Process files with concurrency limit
    timings.scanStart = Date.now();
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
    timings.scanEnd = Date.now();

    // Log detailed timing if any results were found
    if (results.length > 0) {
      const gatherTime = timings.gatherEnd - timings.gatherStart;
      const scanTime = timings.scanEnd - timings.scanStart;
      const totalTime = timings.scanEnd - timings.start;
      const functionsCount = results.reduce((sum, r) => sum + r.functions.length, 0);
      
      this.lastScanTimings = {
        gatherTime,
        scanTime,
        totalTime,
        fileCount: results.length,
        functionsCount
      };
    }

    return results;
  }

  /**
   * Recursively gather all eligible files in a directory.
   * Uses VSCode's workspace.findFiles() for speed (optimized file discovery).
   */
  private async gatherFilesOptimized(
    workspaceRoot: string,
    excludeDirs: Set<string>,
    fileExtensions: string[]
  ): Promise<string[]> {
    // Convert file extensions to glob pattern (e.g., ['.ts', '.js'] -> **/*.{ts,js})
    const extPattern = fileExtensions.map(ext => ext.substring(1)).join(',');
    const includePattern = `**/*.{${extPattern}}`;
    
    // Build exclude pattern from directories
    const excludePatterns = Array.from(excludeDirs)
      .map(dir => `**/${dir}/**`)
      .join(',');
    
    try {
      // Find the workspace folder that contains this root
      const workspaceFolders = vscode.workspace.workspaceFolders || [];
      const workspaceFolder = workspaceFolders.find(
        folder => workspaceRoot.toLowerCase().startsWith(folder.uri.fsPath.toLowerCase())
      );

      if (!workspaceFolder) {
        // No workspace folder found, fall back to manual gathering
        return this.gatherFiles(workspaceRoot, excludeDirs, fileExtensions);
      }

      // Use VSCode's workspace API with RelativePattern to limit to specific folder
      const relativePattern = new vscode.RelativePattern(workspaceFolder, includePattern);
      const uris = await vscode.workspace.findFiles(
        relativePattern,
        excludePatterns,
        50000  // Increase limit to ensure we get all files
      );
      
      // Normalize paths for comparison
      const normalizedRoot = path.normalize(workspaceRoot).toLowerCase();
      
      // Filter to only include files from the specific workspace root we want
      return uris
        .map(uri => uri.fsPath)
        .filter(fsPath => path.normalize(fsPath).toLowerCase().startsWith(normalizedRoot));
    } catch (error) {
      // Fallback to manual gathering if workspace API fails
      return this.gatherFiles(workspaceRoot, excludeDirs, fileExtensions);
    }
  }

  /**
   * Recursively gather all eligible files in a directory (optimized with parallel I/O).
   */
  private async gatherFiles(
    dir: string,
    excludeDirs: Set<string>,
    fileExtensions: string[]
  ): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      const files: string[] = [];
      const subdirectories: string[] = [];

      // Separate files and directories
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip excluded directories
          if (excludeDirs.has(entry.name)) {
            continue;
          }
          
          // Skip by path pattern
          if (fullPath.includes('/node_modules/') || fullPath.includes('/dist/') || 
              fullPath.includes('/build/') || fullPath.includes('/.git/')) {
            continue;
          }
          
          subdirectories.push(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          
          // Skip minified files
          if (entry.name.endsWith('.min.js') || entry.name.endsWith('.min.ts') || 
              entry.name.endsWith('.min.jsx') || entry.name.endsWith('.min.tsx')) {
            continue;
          }
          
          if (fileExtensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }

      // Process all subdirectories in parallel
      if (subdirectories.length > 0) {
        const subResults = await Promise.all(
          subdirectories.map(subdir => 
            this.gatherFiles(subdir, excludeDirs, fileExtensions)
              .catch(() => []) // Handle errors gracefully
          )
        );
        
        // Flatten results
        subResults.forEach(result => files.push(...result));
      }

      return files;
    } catch (error) {
      // Cannot read directory
      return [];
    }
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
   * Scan only changed files for incremental updates.
   * Much faster than full workspace scan - only touched files are re-parsed.
   * Uses warm cache for unmodified files.
   */
  async scanIncremental(
    changedFiles: string[],
    config: ScannerConfig = {}
  ): Promise<ScanResult[]> {
    if (changedFiles.length === 0) {
      return [];
    }

    const concurrencyLimit = config.concurrencyLimit || 16;
    const results: ScanResult[] = [];

    // Process changed files with concurrency limit
    for (let i = 0; i < changedFiles.length; i += concurrencyLimit) {
      const batch = changedFiles.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(
        batch.map((fp) => this.scanFile(fp))
      );

      results.push(...batchResults.filter(r => r.functions.length > 0));

      // Call progress callback
      if (config.onProgress) {
        config.onProgress(Math.min(i + concurrencyLimit, changedFiles.length), changedFiles.length);
      }
    }

    return results;
  }

  /**
   * Invalidate cache for specific files (called on deletion).
   */
  async invalidateCacheEntries(filePaths: string[]): Promise<void> {
    if (!this.cache || !(this.cache instanceof MemoryCacheAdapter)) {
      return;
    }

    for (const filePath of filePaths) {
      await (this.cache as MemoryCacheAdapter).invalidate(filePath);
    }
  }

  /**
   * Clear all cached data.
   */
  async clearCache(): Promise<void> {
    if (this.cache) {
      await this.cache.clear();
    }
  }

  /**
   * Get timing information from the last scan.
   */
  getLastScanTimings(): ScanTimings | null {
    return this.lastScanTimings;
  }
}
