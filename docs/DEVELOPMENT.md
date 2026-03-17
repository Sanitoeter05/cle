# Development Guide

## Project Structure

```
.
├── src/
│   ├── extension.ts              # Entry point - VS Code extension activation
│   ├── core/
│   │   ├── ScannerEngine.ts       # Orchestrates parsing, analysis, and caching
│   ├── plugins/
│   │   ├── PluginInterface.ts     # Core plugin interfaces
│   │   ├── ParserRegistry.ts      # Plugin registry and lifecycle
│   │   ├── builtin/
│   │   │   ├── TypeScriptParser.ts      # Regex-based TS/JS parser
│   │   │   ├── LineCountStrategy.ts     # Line count filtering
│   │   │   └── MemoryCacheAdapter.ts    # In-memory cache
│   ├── utils/
│   │   └── Logger.ts              # Centralized logging (DRY)
│   └── test/
│       ├── extension.test.ts       # Extension unit tests
│       ├── performance.test.ts     # Performance benchmarks
│       └── fixtures/
│           └── SampleFiles.ts      # Test data generation
├── dist/                          # Compiled output (esbuild)
├── docs/
│   ├── PLUGIN_SYSTEM.md           # Plugin architecture guide
│   ├── DEVELOPMENT.md             # This file
│   └── GLOSSARY.md                # Searchable terms
├── package.json
├── tsconfig.json
├── esbuild.js                     # Build configuration
├── eslint.config.mjs              # Lint configuration
└── README.md                      # User-facing documentation
```

## DRY & KISS Principles Applied

### 1. DRY (Don't Repeat Yourself)

| Pattern | Location | Benefit |
|---------|----------|---------|
| **Centralized Logging** | `src/utils/Logger.ts` | Single interface for all log output |
| **Plugin Registry** | `src/plugins/ParserRegistry.ts` | Avoids duplicating plugin management logic |
| **ScannerEngine** | `src/core/ScannerEngine.ts` | Consolidates file I/O, caching, parallelization |
| **Interfaces** | `src/plugins/PluginInterface.ts` | Enforces consistency across plugins |
| **File Gathering** | `ScannerEngine.gatherFiles()` | Single recursive directory walker |

**Before (Monolithic Code):**
```typescript
// Duplicated across multiple functions
outputChannel.appendLine(`Start: ${Date.now()}`);
outputChannel.appendLine(`Error: ${error}`);
// ...repeated 10+ times
```

**After (Logger Utility):**
```typescript
logger.info('Start scanning...');
logger.error('Error occurred', error);
// Single, consistent interface
```

### 2. KISS (Keep It Simple, Stupid)

| Area | Simplification |
|------|-----------------|
| **Parsing** | Regex patterns (simple, fast) vs AST parsing (complex, flexible) |
| **Caching** | In-memory cache (simple) vs persistent storage (complex) |
| **Concurrency** | Promise.all with limit (simple) vs worker threads (complex) |
| **File Discovery** | Synchronous fs operations in batches (simple) vs streaming (complex) |
| **Error Handling** | Return empty arrays (simple) vs throw/reject (complex) |

## Building

### Prerequisites

- Node.js 16+ (check with `node --version`)
- npm 7+ (check with `npm --version`)

### Install Dependencies

```bash
npm install
```

### Development Workflow

Two options:

**Option 1: Watch Mode (Recommended)**
```bash
npm run watch
```

This runs in parallel:
- `npm run watch:tsc` - Type-checking with incremental compilation
- `npm run watch:esbuild` - Code bundling for distribution

Output: `dist/extension.js` (automatically rebuilt on save)

**Option 2: One-Time Compile**
```bash
npm run compile
```

Runs:
1. Type checking (`tsc --noEmit`)
2. Linting (`eslint src`)
3. Bundling (`esbuild`)

## Testing

### Run All Tests

```bash
npm test
```

Runs:
- Unit tests in `src/test/extension.test.ts`
- Functional tests in `src/test/extension.test.ts`

### Performance Testing

```bash
npm run perf-test
```

Generates performance benchmarks:
- **Baseline scan**: Full workspace scan with 100 sample files
- **Cache performance**: Warm vs cold cache comparison
- **Single file scan**: Per-file throughput
- **Parallel scaling**: Concurrency level analysis

**Example Output:**
```
✓ Baseline Test Result:
  Files scanned: 100
  Functions found: 425
  Duration: 88ms
  Throughput: 1136.4 files/sec

✓ Cache Performance Test Result:
  Cold cache (first scan): 45ms
  Warm cache (second scan): 2ms
  Improvement: 95.6%
  Speedup: 22.50x
```

**See Also:** [Performance Optimization Guide](PERFORMANCE_OPTIMIZATION.md) for troubleshooting slow scans

### Watch Tests

```bash
npm run watch-tests
```

Re-runs tests on code changes (useful during development).

## Code Quality

### Type Checking

```bash
npm run check-types
```

Runs TypeScript in strict mode. All code must be type-safe.

### Linting

```bash
npm run lint
```

Enforces ESLint rules. Fix automatically with:
```bash
npm run lint:fix
```

### Code Coverage

Currently not configured. To add:
```bash
npm install --save-dev nyc
```

## VS Code Extension Debugging

### 1. Install the Extension Locally

```bash
# From project root
npm install
npm run compile

# VS Code will auto-detect and load extension from outputs
```

### 2. Run in VS Code

- Press `F5` to launch VS Code with the extension
- Opens a new VS Code window with extension loaded
- Set breakpoints in `src/extension.ts`
- Use Debug console for inspection

### 3. Debug the Scanner

```typescript
// In src/extension.ts
console.log('Debug info:', results);

// Output appears in:
// - VS Code Debug Console (lower panel)
// - Extension's Output Channel (View → Output)
```

## Performance Optimization Checklist

When modifying code, verify:

- [ ] New file I/O uses `fs/promises` (async, not sync)
- [ ] Loops use parallelization where possible
- [ ] Cache is invalidated on file changes
- [ ] No unnecessary regex compilations
- [ ] DRY: Extract repeated patterns to utilities
- [ ] Tests pass: `npm test`
- [ ] Performance tests show no regressions: `npm run perf-test`

## Common Tasks

### Add a New Language Parser

1. Create `src/plugins/custom/MyLanguageParser.ts`
   - Implement `LanguageParser` interface
   - Add tests in `src/test/`
2. Register in `src/extension.ts` activate():
   ```typescript
   registry.registerParser(new MyLanguageParser());
   ```
3. Verify in tests

### Add a New Analysis Strategy

1. Create `src/plugins/custom/MyStrategy.ts`
   - Implement `AnalysisStrategy` interface
2. Register in registry
3. Update configuration in `registry.setConfig()`

### Report a Performance Regression

1. Run baseline: `npm run perf-test > baseline.txt`
2. Make changes
3. Run again: `npm run perf-test > after.txt`
4. Compare: `diff baseline.txt after.txt`

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Type errors after edit | Run `npm run check-types` |
| Extension doesn't load | Run `npm run compile` then reload VS Code |
| Tests fail | Clear cache: `rm -rf dist/`, then `npm install` |
| Watch mode hangs | Kill with Ctrl+C, restart: `npm run watch` |
| `Cannot find module` | Run `npm install` dependencies |

## Release Checklist

Before publishing to VS Code Marketplace:

- [ ] Update version in `package.json`
- [ ] Update `CHANGELOG.md`
- [ ] All tests pass: `npm test`
- [ ] Performance tests acceptable: `npm run perf-test`
- [ ] No lint errors: `npm run lint`
- [ ] Build succeeds: `npm run compile`
- [ ] Manual testing in VS Code works

## File Size & Performance Targets

| Metric | Target | Current |
|--------|--------|---------|
| Bundle size | < 100KB | ~30KB |
| Initial scan (100 files) | < 5 seconds | ~2-3s |
| Single file scan | < 50ms | ~10-20ms |
| Tree update latency | < 100ms | ~20ms |

## Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Node.js fs/promises](https://nodejs.org/api/fs.html#fs_promises_api)
- [Mocha Testing Framework](https://mochajs.org/)

