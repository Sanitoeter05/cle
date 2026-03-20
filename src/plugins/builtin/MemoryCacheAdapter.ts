import {createHash} from "crypto";
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
        };
        if (config.cacheTTLMs && typeof config.cacheTTLMs === "number") {
            this.ttlMs = config.cacheTTLMs;
        };
    };

    async get(key: string): Promise<FunctionMatch[] | null> {
        const entry = this.cache.get(key);
        if (!entry || this.deleteCacheIfExpired(key, entry)) {
            return null;
        };
        return entry.results;
    };

    private deleteCacheIfExpired(key: string, entry: CacheEntry): boolean {
        if (Date.now() - entry.timestamp > this.ttlMs) {
            this.cache.delete(key);
            return true;
        };
        return false;
    };

    private removeOldestEntry(key:string): void {
        if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
        const firstKey = Array.from(this.cache.keys())[0];
            if (firstKey) {
                this.cache.delete(firstKey);
            };
        };
    };

    private createEntry(key: string, value: FunctionMatch[], hash: string): void {
        this.cache.set(key, {
        results: value,
        fileHash: hash,
        timestamp: Date.now(),
        });
    };

    async set(key: string, value: FunctionMatch[]): Promise<void> {
        this.removeOldestEntry(key);
        this.createEntry(key, value, "");
    };

    async isValid(key: string, fileHash: string): Promise<boolean> {
        const entry = this.cache.get(key);
        if (!entry || this.deleteCacheIfExpired(key, entry)) {
            return false;
        };
        return entry.fileHash === fileHash;
    };

    async clear(): Promise<void> {
        this.cache.clear();
    };

    /**
    * Helper: compute SHA256 hash of file content.
    */
    static computeHash(content: string): string {
        return createHash("sha256").update(content).digest("hex");
    };

    /**
    * Store hash with cache entry for validation.
    */
    async setWithHash(key: string, value: FunctionMatch[], fileHash: string): Promise<void> {
        this.removeOldestEntry(key);
        this.createEntry(key, value, fileHash);
    };

    /**
    * Invalidate cache entry for a specific file.
    * Called when file is deleted or needs forced refresh.
    */
    async invalidate(key: string): Promise<void> {
        this.cache.delete(key);
    };
};
