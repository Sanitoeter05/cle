/**
 * Core plugin interfaces for the scanner system.
 * Enables extensibility through language parsers and analysis strategies.
 */

/**
 * Represents a detected function and its metadata.
 */
export interface FunctionMatch {
  name: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  metrics: Record<string, unknown>;
  children?: FunctionMatch[]; // Nested blocks inside this function
}

/**
 * Plugin configuration passed at initialization.
 */
export interface PluginConfig {
  [key: string]: unknown;
}

/**
 * Analyzes source code and detects functions matching specific criteria.
 */
export interface LanguageParser {
  /**
   * Unique identifier for this parser (e.g., "typescript", "python").
   */
  id: string;

  /**
   * File extensions this parser handles (e.g., [".ts", ".tsx", ".js"]).
   */
  fileExtensions: string[];

  /**
   * Initialize the parser with configuration.
   */
  initialize(config: PluginConfig): Promise<void>;

  /**
   * Parse file content and detect functions.
   * @param content File contents
   * @param filePath Path to the file for context
   * @returns Array of detected functions
   */
  parse(content: string, filePath: string): Promise<FunctionMatch[]>;
}

/**
 * Analyzes parsed functions and applies filtering/metrics.
 */
export interface AnalysisStrategy {
  /**
   * Unique identifier for this strategy (e.g., "line-count", "complexity").
   */
  id: string;

  /**
   * Initialize the strategy with configuration.
   */
  initialize(config: PluginConfig): Promise<void>;

  /**
   * Filter and transform functions based on strategy criteria.
   * @param functions Parsed functions from a language parser
   * @returns Filtered/transformed functions
   */
  analyze(functions: FunctionMatch[]): Promise<FunctionMatch[]>;
}

/**
 * Optional interface for caching scan results.
 */
export interface CacheAdapter {
  /**
   * Unique identifier for this cache (e.g., "memory", "file-system").
   */
  id: string;

  /**
   * Initialize the cache adapter.
   */
  initialize(config: PluginConfig): Promise<void>;

  /**
   * Get cached results if available.
   * @param key Cache key (e.g., file path)
   * @returns Cached results or null
   */
  get(key: string): Promise<FunctionMatch[] | null>;

  /**
   * Store results in cache.
   * @param key Cache key
   * @param value Results to cache
   */
  set(key: string, value: FunctionMatch[]): Promise<void>;

  /**
   * Check if a cache entry is valid (e.g., file hasn't changed).
   * @param key Cache key
   * @param fileHash Current file hash
   * @returns true if cache is valid
   */
  isValid(key: string, fileHash: string): Promise<boolean>;

  /**
   * Clear all cache entries.
   */
  clear(): Promise<void>;
}
