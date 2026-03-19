/**
 * Performance tests for function scanner.
 * Measures scanning speed before and after optimizations.
 */

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TypeScriptParser } from '../plugins/builtin/TypeScriptParser';
import { LineCountStrategy } from '../plugins/builtin/LineCountStrategy';
import { MemoryCacheAdapter } from '../plugins/builtin/MemoryCacheAdapter';
import { ScannerEngine, ScanResult } from '../core/ScannerEngine';
import { FunctionMatch } from '../plugins/PluginInterface';
import { generateSampleWorkspace } from './fixtures/SampleFiles';

/**
 * Benchmark result for a test run.
 */
interface BenchmarkResult {
  testName: string;
  fileCount: number;
  functionsCount: number;
  duration_ms: number;
  filesPerSecond: number;
  cacheHits?: number;
  cacheMisses?: number;
}

/**
 * Compare benchmark results.
 */
interface ComparisonResult {
  testName: string;
  before_ms: number;
  after_ms: number;
  improvement_percent: number;
  speedup_x: number;
}

suite('Performance Tests', () => {
  let tempDir: string;
  const fileCount = 100;
  const functionsPerFile = 5;

  setup(async () => {
    // Create temporary directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-perf-'));
  });

  teardown(async () => {
    // Clean up temporary directory
    const files = await fs.readdir(tempDir);
    for (const file of files) {
      await fs.unlink(path.join(tempDir, file));
    }
    await fs.rmdir(tempDir);
  });

  test('Baseline: Full workspace scan (100 files, 5 functions each)', async () => {
    // Generate sample files
    const sampleFiles = generateSampleWorkspace(fileCount, functionsPerFile);
    
    // Write files to temp directory
    for (const [fileName, content] of sampleFiles) {
      await fs.writeFile(path.join(tempDir, fileName), content);
    }

    // Create scanner
    const parser = new TypeScriptParser();
    const strategy = new LineCountStrategy();
    const cache = new MemoryCacheAdapter();
    const engine = new ScannerEngine(parser, strategy, cache);

    // Initialize plugins
    await parser.initialize({ lineThreshold: 5 });
    await strategy.initialize({ lineThreshold: 5 });
    await cache.initialize({ maxCacheEntries: 1000 });

    // Run scan and measure time
    const startTime = Date.now();
    const results = await engine.scanWorkspace(tempDir, {
      concurrencyLimit: 8,
    });
    const duration = Date.now() - startTime;

    // Verify results
    const totalFunctions = results.reduce((sum: number, r: ScanResult) => sum + r.functions.length, 0);
    assert.ok(totalFunctions > 0, 'Should find functions');
    assert.ok(duration < 5000, `Scan should complete in < 5 seconds, took ${duration}ms`);

    console.log(`\n✓ Baseline Test Result:`);
    console.log(`  Files scanned: ${fileCount}`);
    console.log(`  Functions found: ${totalFunctions}`);
    console.log(`  Duration: ${duration}ms`);
    console.log(`  Throughput: ${(fileCount / (duration / 1000)).toFixed(1)} files/sec`);
  });

  test('Cache performance: Second scan with cached results', async () => {
    // Generate and write sample files
    const sampleFiles = generateSampleWorkspace(fileCount, functionsPerFile);
    for (const [fileName, content] of sampleFiles) {
      await fs.writeFile(path.join(tempDir, fileName), content);
    }

    // Create scanner with persistent cache
    const parser = new TypeScriptParser();
    const strategy = new LineCountStrategy();
    const cache = new MemoryCacheAdapter();
    const engine = new ScannerEngine(parser, strategy, cache);

    await parser.initialize({ lineThreshold: 5 });
    await strategy.initialize({ lineThreshold: 5 });
    await cache.initialize({ maxCacheEntries: 1000 });

    // First scan (cold cache)
    const coldStart = Date.now();
    const coldResults = await engine.scanWorkspace(tempDir, { concurrencyLimit: 8 });
    const coldDuration = Date.now() - coldStart;

    // Second scan (warm cache) - files unchanged
    const warmStart = Date.now();
    const warmResults = await engine.scanWorkspace(tempDir, { concurrencyLimit: 8 });
    const warmDuration = Date.now() - warmStart;

    // Verify results match
    const coldTotal = coldResults.reduce((sum: number, r: ScanResult) => sum + r.functions.length, 0);
    const warmTotal = warmResults.reduce((sum: number, r: ScanResult) => sum + r.functions.length, 0);
    assert.strictEqual(coldTotal, warmTotal, 'Results should match between scans');

    const improvement = ((coldDuration - warmDuration) / coldDuration * 100).toFixed(1);
    console.log(`\n✓ Cache Performance Test Result:`);
    console.log(`  Cold cache (first scan): ${coldDuration}ms`);
    console.log(`  Warm cache (second scan): ${warmDuration}ms`);
    console.log(`  Improvement: ${improvement}%`);
    console.log(`  Speedup: ${(coldDuration / warmDuration).toFixed(2)}x`);
  });

  test('Single file scan performance', async () => {
    // Generate and write sample file
    const sampleFiles = generateSampleWorkspace(1, functionsPerFile);
    const filePath = path.join(tempDir, 'sample-0.ts');
    const content = Array.from(sampleFiles.values())[0] as string;
    await fs.writeFile(filePath, content);

    // Create scanner
    const parser = new TypeScriptParser();
    const strategy = new LineCountStrategy();
    const cache = new MemoryCacheAdapter();
    const engine = new ScannerEngine(parser, strategy, cache);

    await parser.initialize({ lineThreshold: 5 });
    await strategy.initialize({ lineThreshold: 5 });
    await cache.initialize({ maxCacheEntries: 1000 });

    // Scan single file multiple times
    const iterations = 100;
    const startTime = Date.now();
    for (let i = 0; i < iterations; i++) {
      await engine.scanFile(filePath);
    }
    const duration = Date.now() - startTime;

    const avgTime = duration / iterations;
    console.log(`\n✓ Single File Scan Performance Test Result:`);
    console.log(`  Iterations: ${iterations}`);
    console.log(`  Total time: ${duration}ms`);
    console.log(`  Average per scan: ${avgTime.toFixed(2)}ms`);
  });

  test('Parallel vs sequential scan comparison', async () => {
    // Generate sample files
    const sampleFiles = generateSampleWorkspace(fileCount, functionsPerFile);
    for (const [fileName, content] of sampleFiles) {
      await fs.writeFile(path.join(tempDir, fileName), content);
    }

    // Setup parsers and strategies
    const parser = new TypeScriptParser();
    const strategy = new LineCountStrategy();
    await parser.initialize({ lineThreshold: 5 });
    await strategy.initialize({ lineThreshold: 5 });

    // Test with different concurrency levels
    const concurrencyLevels = [1, 4, 8, 16];
    const results: BenchmarkResult[] = [];

    for (const concurrency of concurrencyLevels) {
      const cache = new MemoryCacheAdapter();
      const engine = new ScannerEngine(parser, strategy, cache);
      await cache.initialize({ maxCacheEntries: 1000 });

      const startTime = Date.now();
      const scanResults = await engine.scanWorkspace(tempDir, {
        concurrencyLimit: concurrency,
      });
      const duration = Date.now() - startTime;

      const totalFunctions = scanResults.reduce((sum: number, r: ScanResult) => sum + r.functions.length, 0);
      results.push({
        testName: `Concurrency Level ${concurrency}`,
        fileCount,
        functionsCount: totalFunctions,
        duration_ms: duration,
        filesPerSecond: fileCount / (duration / 1000),
      });
    }

    console.log(`\n✓ Parallel Scan Performance Comparison:`);
    console.log(`  File Count: ${fileCount}`);
    results.forEach(r => {
      console.log(`  ${r.testName}: ${r.duration_ms}ms (${r.filesPerSecond.toFixed(1)} files/sec)`);
    });

    // Best concurrency should be better than sequential
    const sequential = results[0].duration_ms;
    const best = Math.min(...results.map(r => r.duration_ms));
    assert.ok(
      best < sequential * 0.9,
      `Parallel should be at least 10% faster than sequential`
    );
  });

  test('Incremental scan performance: Scanning only changed files', async () => {
    // Generate sample files
    const sampleFiles = generateSampleWorkspace(fileCount, functionsPerFile);
    for (const [fileName, content] of sampleFiles) {
      await fs.writeFile(path.join(tempDir, fileName), content);
    }

    // Create scanner
    const parser = new TypeScriptParser();
    const strategy = new LineCountStrategy();
    const cache = new MemoryCacheAdapter();
    const engine = new ScannerEngine(parser, strategy, cache);

    // Initialize plugins
    await parser.initialize({ lineThreshold: 5 });
    await strategy.initialize({ lineThreshold: 5 });
    await cache.initialize({ maxCacheEntries: 1000 });

    // First, do a full workspace scan to warm the cache
    const fullScanStart = Date.now();
    await engine.scanWorkspace(tempDir, { concurrencyLimit: 8 });
    const fullScanDuration = Date.now() - fullScanStart;

    // Get the list of all files
    const allFiles = await fs.readdir(tempDir);
    const fullFilePaths = allFiles.map(f => path.join(tempDir, f));

    // Simulate a small change: only rescan 5 files
    const changedFiles = fullFilePaths.slice(0, 5);

    // Measure incremental scan time
    const incrementalStart = Date.now();
    const incrementalResults = await engine.scanIncremental(changedFiles);
    const incrementalDuration = Date.now() - incrementalStart;

    // Verify results
    assert.ok(incrementalResults.length > 0, 'Should find functions in changed files');
    assert.ok(
      incrementalDuration < fullScanDuration * 0.2,
      `Incremental scan (${incrementalDuration}ms) should be significantly faster than full scan (${fullScanDuration}ms)`
    );

    // Measure incremental scan for single file (warmest cache scenario)
    const singleFileStart = Date.now();
    const singleFileResults = await engine.scanIncremental([changedFiles[0]]);
    const singleFileDuration = Date.now() - singleFileStart;

    console.log(`\n✓ Incremental Scan Performance Test Result:`);
    console.log(`  Total files: ${fileCount}`);
    console.log(`  Full workspace scan: ${fullScanDuration}ms`);
    console.log(`  Incremental scan (5 files changed): ${incrementalDuration}ms`);
    console.log(`  Single file scan (from warm cache): ${singleFileDuration}ms`);
    console.log(`  Speedup (5-file vs full): ${(fullScanDuration / incrementalDuration).toFixed(1)}x`);
    console.log(`  Functions found in changed files: ${incrementalResults.reduce((sum, r) => sum + r.functions.length, 0)}`);
  });
});
