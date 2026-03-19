/**
 * Real-world performance test script
 * Tests scanning on the provided path: F:\SanisModding\SM_EasyMod\MS_ConfigCreater
 */

const fs = require('fs/promises');
const path = require('path');

// High-precision timer using hrtime
function hrTimer() {
  let startTime = process.hrtime.bigint();
  return () => {
    const endTime = process.hrtime.bigint();
    return Number(endTime - startTime) / 1_000_000; // Convert to milliseconds
  };
}

// Import the compiled modules
const TypeScriptParser = require('./out/plugins/builtin/TypeScriptParser').TypeScriptParser;
const LineCountStrategy = require('./out/plugins/builtin/LineCountStrategy').LineCountStrategy;
const MemoryCacheAdapter = require('./out/plugins/builtin/MemoryCacheAdapter').MemoryCacheAdapter;
const ScannerEngine = require('./out/core/ScannerEngine').ScannerEngine;

const testPath = 'F:\\SanisModding\\SM_EasyMod\\MS_ConfigCreater';

async function runTest() {
  console.log('🧪 Real-World Performance Test');
  console.log(`📂 Path: ${testPath}\n`);

  // Check if path exists
  try {
    await fs.access(testPath);
  } catch (e) {
    console.error(`❌ Path not found: ${testPath}`);
    process.exit(1);
  }

  // Count files first
  let fileCount = 0;
  async function countFiles(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !['.git', 'node_modules', 'dist', '.vscode'].includes(entry.name)) {
          await countFiles(path.join(dir, entry.name));
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx'))) {
          fileCount++;
        }
      }
    } catch (e) {
      // Ignore
    }
  }

  console.log('📊 Counting files...');
  await countFiles(testPath);
  console.log(`📈 Found ${fileCount} source files\n`);

  // Initialize plugins
  const parser = new TypeScriptParser();
  const strategy = new LineCountStrategy();
  const cache = new MemoryCacheAdapter();

  await parser.initialize({ lineThreshold: 5 });
  await strategy.initialize({ lineThreshold: 5 });
  await cache.initialize({ maxCacheEntries: fileCount + 100 });

  const engine = new ScannerEngine(parser, strategy, cache);

  // Test 1: Full workspace scan (COLD)
  console.log('⏱️  Test 1: FULL WORKSPACE SCAN (Cold Cache)');
  const timer1 = hrTimer();
  const fullResults = await engine.scanWorkspace(testPath, {
    concurrencyLimit: 16,
    onProgress: (processed, total) => {
      if (processed % 10 === 0) {
        process.stdout.write(`\r  Processing: ${processed}/${total} files...`);
      }
    }
  });
  const fullDuration = timer1();
  const fullFunctionCount = fullResults.reduce((sum, r) => sum + r.functions.length, 0);
  console.log(`\n✓ Completed in ${fullDuration.toFixed(2)}ms`);
  console.log(`  Functions found: ${fullFunctionCount}`);
  console.log(`  Files scanned: ${fullResults.length}`);
  console.log(`  Avg time per file: ${(fullDuration / fullResults.length).toFixed(3)}ms\n`);

  // Test 2: Single file scan (WARM cache)
  console.log('⏱️  Test 2: SINGLE FILE SCAN (Warm Cache)');
  let singleDuration = 0;
  const singleFile = fullResults[0];
  if (singleFile) {
    const timer2 = hrTimer();
    const singleResult = await engine.scanFile(singleFile.filePath);
    singleDuration = timer2();
    console.log(`✓ Completed in ${singleDuration.toFixed(3)}ms`);
    console.log(`  File: ${path.basename(singleFile.filePath)}`);
    console.log(`  Functions: ${singleResult.functions.length}\n`);
  }

  // Test 3: Incremental scan (5 files)
  console.log('⏱️  Test 3: INCREMENTAL SCAN (5 files changed)');
  const filesToScan = fullResults.slice(0, 5).map(r => r.filePath);
  const timer3 = hrTimer();
  const incrementalResults = await engine.scanIncremental(filesToScan);
  const incrementalDuration = timer3();
  const incrementalFunctionCount = incrementalResults.reduce((sum, r) => sum + r.functions.length, 0);
  console.log(`✓ Completed in ${incrementalDuration.toFixed(2)}ms`);
  console.log(`  Files scanned: ${incrementalResults.length}`);
  console.log(`  Functions found: ${incrementalFunctionCount}`);
  console.log(`  Speedup vs full scan: ${(fullDuration / Math.max(incrementalDuration, 0.001)).toFixed(1)}x\n`);

  // Test 4: Rapid successive incremental scans
  console.log('⏱️  Test 4: 10 SUCCESSIVE SINGLE-FILE SCANS (Same file, warm cache)');
  const iterations = 10;
  const timer4 = hrTimer();
  for (let i = 0; i < iterations; i++) {
    await engine.scanFile(filesToScan[0]);
  }
  const rapidDuration = timer4();
  const avgPerScan = rapidDuration / iterations;
  console.log(`✓ Completed in ${rapidDuration.toFixed(2)}ms total`);
  console.log(`  Avg per scan: ${avgPerScan.toFixed(3)}ms`);
  console.log(`  Throughput: ${(1000 / Math.max(avgPerScan, 0.001)).toFixed(1)} scans/sec\n`);

  // Summary
  console.log('📊 PERFORMANCE SUMMARY');
  console.log('─'.repeat(60));
  console.log(`Cold Full Scan:          ${fullDuration.toFixed(2)}ms (${fileCount} files)`);
  console.log(`Warm Single File:        ${singleDuration.toFixed(3)}ms`);
  console.log(`Incremental (5 files):   ${incrementalDuration.toFixed(2)}ms`);
  console.log(`Rapid Single File (10x): ${avgPerScan.toFixed(3)}ms average`);
  console.log('─'.repeat(60));
  console.log(`\n✅ All tests completed!`);
  console.log(`\n🎯 Target Achievement:`);
  console.log(`   Target: ≤10ms for incremental single-file scans`);
  console.log(`   Actual: ${avgPerScan.toFixed(3)}ms ${avgPerScan <= 10 ? '✓ PASS' : '⚠ NEEDS OPTIMIZATION'}`);
}

runTest().catch(e => {
  console.error('❌ Test failed:', e.message);
  process.exit(1);
});
