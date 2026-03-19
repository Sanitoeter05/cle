/**
 * Persistent disk cache for function scan results.
 * Caches results across extension restarts for blazing-fast rescans.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { CacheAdapter, FunctionMatch, PluginConfig } from "../PluginInterface";

interface CacheEntry {
  results: FunctionMatch[];
  fileHash: string;
  timestamp: number;
}

export class DiskCacheAdapter implements CacheAdapter {
  id = "disk";

  private cache: Map<string, CacheEntry> = new Map();
  private cacheDir: string = "";
  private maxEntries: number = 5000;
  private ttlMs: number = 24 * 60 * 60 * 1000; // 24 hours

  async initialize(config: PluginConfig): Promise<void> {
    // Use temp directory for cache
    this.cacheDir = path.join(os.tmpdir(), "vscode-function-scanner-cache");

    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (error) {
      // Fallback if directory creation fails
      console.warn("Failed to create cache directory, disk cache disabled");
      this.cacheDir = "";
    }

    if (config.maxCacheEntries && typeof config.maxCacheEntries === "number") {
      this.maxEntries = config.maxCacheEntries;
    }

    if (config.cacheTTLMs && typeof config.cacheTTLMs === "number") {
      this.ttlMs = config.cacheTTLMs;
    }

    // Load cache from disk on initialization
    await this.loadCacheFromDisk();
  }

  async get(key: string): Promise<FunctionMatch[] | null> {
    if (!this.cacheDir) {
      return null;
    };

    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if cache entry has expired
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      await this.removeCacheFile(key);
      return null;
    }

    return entry.results;
  }

  async set(key: string, value: FunctionMatch[]): Promise<void> {
    if (!this.cacheDir) {
      return;
    }

    // LRU: remove oldest entry if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const firstKey = Array.from(this.cache.keys())[0];
      if (firstKey) {
        this.cache.delete(firstKey);
        await this.removeCacheFile(firstKey);
      }
    }

    this.cache.set(key, {
      results: value,
      fileHash: "",
      timestamp: Date.now(),
    });

    // Write to disk asynchronously
    await this.writeCacheFile(key, { results: value, fileHash: "", timestamp: Date.now() });
  }

  async isValid(key: string, fileHash: string): Promise<boolean> {
    if (!this.cacheDir) {
      return false;
    }

    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    // Check expiration and hash match
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      await this.removeCacheFile(key);
      return false;
    }

    return entry.fileHash === fileHash;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    if (this.cacheDir) {
      try {
        const files = await fs.readdir(this.cacheDir);
        for (const file of files) {
          await fs.unlink(path.join(this.cacheDir, file));
        }
      } catch (error) {
        // Ignore if directory doesn't exist
      }
    }
  }

  static computeHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  async setWithHash(
    key: string,
    value: FunctionMatch[],
    fileHash: string
  ): Promise<void> {
    if (!this.cacheDir) {
      return;
    }

    // LRU: remove oldest entry if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const firstKey = Array.from(this.cache.keys())[0];
      if (firstKey) {
        this.cache.delete(firstKey);
        await this.removeCacheFile(firstKey);
      }
    }

    const entry: CacheEntry = {
      results: value,
      fileHash,
      timestamp: Date.now(),
    };

    this.cache.set(key, entry);

    // Write to disk asynchronously
    await this.writeCacheFile(key, entry);
  }

  /**
   * Invalidate cache entry for a specific file.
   */
  async invalidate(key: string): Promise<void> {
    this.cache.delete(key);
    if (this.cacheDir) {
      await this.removeCacheFile(key);
    }
  }

  /**
   * Get cache file path for a given key.
   */
  private getCacheFilePath(key: string): string {
    const hash = crypto.createHash("md5").update(key).digest("hex");
    return path.join(this.cacheDir, `${hash}.json`);
  }

  /**
   * Write cache entry to disk.
   */
  private async writeCacheFile(key: string, entry: CacheEntry): Promise<void> {
    if (!this.cacheDir) {
      return;
    }

    try {
      const filePath = this.getCacheFilePath(key);
      const data = {
        key,
        ...entry,
      };
      await fs.writeFile(filePath, JSON.stringify(data), "utf-8");
    } catch (error) {
      // Silently fail - cache is just an optimization
    }
  }

  /**
   * Remove cache file from disk.
   */
  private async removeCacheFile(key: string): Promise<void> {
    if (!this.cacheDir) {
      return;
    }

    try {
      const filePath = this.getCacheFilePath(key);
      await fs.unlink(filePath);
    } catch (error) {
      // Silently fail if file doesn't exist
    }
  }

  /**
   * Load cache from disk on startup.
   */
  private async loadCacheFromDisk(): Promise<void> {
    if (!this.cacheDir) {
      return;
    }

    try {
      const files = await fs.readdir(this.cacheDir);

      for (const file of files) {
        if (!file.endsWith(".json")) {
          continue;
        }
        try {
          const filePath = path.join(this.cacheDir, file);
          const content = await fs.readFile(filePath, "utf-8");
          const data = JSON.parse(content);

          if (data.key && data.results && data.timestamp) {
            // Check if expired
            if (Date.now() - data.timestamp > this.ttlMs) {
              await fs.unlink(filePath);
              continue;
            }

            const { key, results, fileHash, timestamp } = data;
            this.cache.set(key, { results, fileHash, timestamp });
          }
        } catch (error) {
          // Skip corrupted cache files
        }
      }

      console.log(`[CACHE] Loaded ${this.cache.size} entries from disk cache`);
    } catch (error) {
      // Silently fail - disk cache is optional
    }
  }
}
