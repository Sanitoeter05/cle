/**
 * Registry for managing plugin lifecycle and discovery.
 */

import {
  LanguageParser,
  AnalysisStrategy,
  CacheAdapter,
  PluginConfig,
} from "./PluginInterface";

export class PluginRegistry {
  private parsers: Map<string, LanguageParser> = new Map();
  private strategies: Map<string, AnalysisStrategy> = new Map();
  private caches: Map<string, CacheAdapter> = new Map();
  private config: PluginConfig = {};

  /**
   * Set global plugin configuration.
   */
  setConfig(config: PluginConfig): void {
    this.config = config;
  }

  /**
   * Register a language parser plugin.
   */
  registerParser(parser: LanguageParser): void {
    this.parsers.set(parser.id, parser);
  }

  /**
   * Register an analysis strategy plugin.
   */
  registerStrategy(strategy: AnalysisStrategy): void {
    this.strategies.set(strategy.id, strategy);
  }

  /**
   * Register a cache adapter plugin.
   */
  registerCache(cache: CacheAdapter): void {
    this.caches.set(cache.id, cache);
  }

  /**
   * Get a parser by ID.
   */
  getParser(id: string): LanguageParser | undefined {
    return this.parsers.get(id);
  }

  /**
   * Get a strategy by ID.
   */
  getStrategy(id: string): AnalysisStrategy | undefined {
    return this.strategies.get(id);
  }

  /**
   * Get a cache adapter by ID.
   */
  getCache(id: string): CacheAdapter | undefined {
    return this.caches.get(id);
  }

  /**
   * Find a parser that handles a given file extension.
   */
  findParserByExtension(ext: string): LanguageParser | undefined {
    for (const parser of this.parsers.values()) {
      if (parser.fileExtensions.includes(ext)) {
        return parser;
      }
    }
    return undefined;
  }

  /**
   * Get all registered parsers.
   */
  getAllParsers(): LanguageParser[] {
    return Array.from(this.parsers.values());
  }

  /**
   * Initialize all registered plugins with configuration.
   */
  async initializeAll(): Promise<void> {
    const initPromises: Promise<void>[] = [];

    for (const parser of this.parsers.values()) {
      initPromises.push(parser.initialize(this.config));
    }

    for (const strategy of this.strategies.values()) {
      initPromises.push(strategy.initialize(this.config));
    }

    for (const cache of this.caches.values()) {
      initPromises.push(cache.initialize(this.config));
    }

    await Promise.all(initPromises);
  }

  /**
   * Clear all plugins.
   */
  clear(): void {
    this.parsers.clear();
    this.strategies.clear();
    this.caches.clear();
  }
}
