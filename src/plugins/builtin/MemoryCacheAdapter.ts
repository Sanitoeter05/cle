/**
 * In-memory file cache adapter with optional file-based persistence.
 */

import * as crypto from "crypto";
import { CacheAdapter, FunctionMatch, PluginConfig } from "../PluginInterface";

interface CacheEntry {
  results: FunctionMatch[];
  fileHash: string;
  timestamp: number;
}

export class MemoryCacheAdapter implements CacheAdapter {
  id = "memory";

  private cache: Map<string, CacheEntry> = new Map();
  private maxEntries: number = 1000;
  private ttlMs: number = 24 * 60 * 60 * 1000; // 24 hours

  async initialize(config: PluginConfig): Promise<void> {
    if (config.maxCacheEntries && typeof config.maxCacheEntries === "number") {
      this.maxEntries = config.maxCacheEntries;
    }

    if (config.cacheTTLMs && typeof config.cacheTTLMs === "number") {
      this.ttlMs = config.cacheTTLMs;
    }
  }

  async get(key: string): Promise<FunctionMatch[] | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if cache entry has expired
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    return entry.results;
  }

  async set(key: string, value: FunctionMatch[]): Promise<void> {
    // Simple LRU: remove oldest entry if at capacity
    if (
      this.cache.size >= this.maxEntries &&
      !this.cache.has(key)
    ) {
      const firstKey = Array.from(this.cache.keys())[0];
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    // Create empty hash placeholder; caller will set real hash
    this.cache.set(key, {
      results: value,
      fileHash: "",
      timestamp: Date.now(),
    });
  }

  async isValid(key: string, fileHash: string): Promise<boolean> {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    // Check expiration and hash match
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }

    return entry.fileHash === fileHash;
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  /**
   * Helper: compute SHA256 hash of file content.
   */
  static computeHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /**
   * Store hash with cache entry for validation.
   */
  async setWithHash(
    key: string,
    value: FunctionMatch[],
    fileHash: string
  ): Promise<void> {
    if (
      this.cache.size >= this.maxEntries &&
      !this.cache.has(key)
    ) {
      const firstKey = Array.from(this.cache.keys())[0];
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      results: value,
      fileHash,
      timestamp: Date.now(),
    });
  }

  /**
   * Invalidate cache entry for a specific file.
   * Called when file is deleted or needs forced refresh.
   */
  async invalidate(key: string): Promise<void> {
    this.cache.delete(key);
  }
}
