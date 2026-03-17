# Glossary

Quick reference for key concepts in the Function Scanner project. Use Ctrl+F to search.

---

## A

### Analysis Strategy
**Definition:** A plugin that filters or transforms parsed functions based on criteria.

**Examples:**
- `LineCountStrategy` - filters functions >= specified line count
- Potential: complexity analyzer, code smell detector

**See Also:** Plugin System, LanguageParser

**Location:** [src/plugins/PluginInterface.ts](../src/plugins/PluginInterface.ts#L48)

---

## B

### Baseline (Performance)
**Definition:** Initial performance measurement before optimizations.

**Purpose:** Establish a reference point to measure improvements against.

**Usage:** Run `npm run perf-test` to generate baseline metrics.

**See Also:** Benchmark, Performance Test

---

### Benchmark
**Definition:** Measurement of execution time, throughput, or resource usage for a specific operation.

**Metrics Tracked:**
- Duration (milliseconds)
- Files per second (throughput)
- Cache hit/miss ratios
- Memory usage

**Location:** [src/test/performance.test.ts](../src/test/performance.test.ts)

---

## C

### Cache Adapter
**Definition:** Optional plugin that stores scan results to avoid re-scanning unchanged files.

**Implementations:**
- `MemoryCacheAdapter` - in-memory with LRU eviction

**Potential Extensions:**
- File-system persistence
- Redis backend
- SQLite database

**Location:** [src/plugins/PluginInterface.ts](../src/plugins/PluginInterface.ts#L64)

---

### Concurrency Limit
**Definition:** Maximum number of files processed in parallel during workspace scanning.

**Default:**  8 files simultaneously

**Rationale:** Balances speed (more parallel) vs memory (less parallel)

**Configurable Via:** `ScannerEngine.scanWorkspace({ concurrencyLimit: N })`

**See Also:** Parallelization, Throughput

---

### Cyclomatic Complexity
**Definition:** Measure of code complexity based on number of decision points (if, for, while, etc.).

**Status:** Not yet implemented; potential future analysis strategy.

**Use Case:** Identify overly complex functions for refactoring.

---

## D

### DRY Principle
**Definition:** "Don't Repeat Yourself" - code should not duplicate logic.

**Applied In:**
- `Logger` utility (centralized logging)
- `ScannerEngine` (single file I/O and parsing orchestrator)
- `ParserRegistry` (shared plugin management)

**Benefit:** Changes to one location propagate everywhere.

**See Also:** KISS Principle

---

## E

### Extension Context
**Definition:** VS Code object providing lifecycle access (subscriptions, storage).

**Usage in cleanExtension:**
```typescript
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(command, treeView, disposables);
}
```

**Location:** [src/extension.ts](../src/extension.ts#L95) activate()

---

## F

### File Extension
**Definition:** The suffix of a filename (e.g., `.ts`, `.js`, `.py`).

**Parser Mapping:**
- `.ts`, `.tsx`, `.js`, `.jsx` → `TypeScriptParser`

**Configuration:** Each `LanguageParser` declares `fileExtensions: string[]`

---

### File System Watcher
**Definition:** VS Code API that monitors file changes (create, modify, delete).

**Purpose:** Trigger incremental re-scans when files change.

**Debounce:** Changes batched and processed after 10-second interval.

**Location:** [src/extension.ts](../src/extension.ts#L136)

---

### FunctionMatch
**Definition:** Data structure representing a detected function with metadata.

**Fields:**
- `name: string` - function identifier
- `startLine: number` - 1-indexed start line number
- `endLine: number` - 1-indexed end line number
- `lineCount: number` - total lines in function
- `metrics: Record<string, unknown>` - extensible metadata

**Location:** [src/plugins/PluginInterface.ts](../src/plugins/PluginInterface.ts#L8)

---

## H

### Hash (File)
**Definition:** SHA256 digest of file content used to detect changes.

**Purpose:** Cache validation - if file unchanged (same hash), skip re-scanning.

**Computation:** `crypto.createHash('sha256').update(content).digest('hex')`

**Location:** [src/plugins/builtin/MemoryCacheAdapter.ts](../src/plugins/builtin/MemoryCacheAdapter.ts#L89)

---

## I

### Initialization
**Definition:** Setup phase where plugins receive configuration and prepare resources.

**Flow:**
1. `PluginRegistry.setConfig()`
2. `registry.registerParser()/registerStrategy()/registerCache()`
3. `registry.initializeAll()` - calls `initialize()` on all plugins

**See Also:** Lifecycle, Plugin

---

## K

### KISS Principle
**Definition:** "Keep It Simple, Stupid" - prefer simplicity over complexity.

**Applied In:**
- Regex parsing (simple) instead of AST (complex)
- In-memory cache (simple) instead of distributed cache (complex)
- Sequential + concurrency limit (simple) instead of worker threads (complex)

**Benefit:** Easier maintenance, faster development.

**See Also:** DRY Principle

---

## L

### Language Parser
**Definition:** Plugin that detects and analyzes functions in source code for a specific language.

**Interface:**
```typescript
interface LanguageParser {
  id: string;
  fileExtensions: string[];
  initialize(config: PluginConfig): Promise<void>;
  parse(content: string, filePath: string): Promise<FunctionMatch[]>;
}
```

**Implementations:**
- `TypeScriptParser` - regex-based for TS/JS files

**Location:** [src/plugins/PluginInterface.ts](../src/plugins/PluginInterface.ts#L27)

---

### Lifecycle (Plugin)
**Definition:** Sequence of stages a plugin goes through.

**Stages:**
1. **Registration** - `registry.registerParser(plugin)`
2. **Initialization** - `plugin.initialize(config)`
3. **Usage** - `plugin.parse(content, filePath)`
4. **Cleanup** - (optional, when extension deactivates)

---

### Line Count
**Definition:** Number of lines in a function.

**Calculation:** `endLine - startLine + 1`

**Threshold:** Default minimum is 5 lines (configurable per `LineCountStrategy`)

---

### Line Count Strategy
**Definition:** Analysis strategy that filters functions based on line count threshold.

**Configuration:**
```typescript
registry.setConfig({ lineThreshold: 5 });
```

**See Also:** Analysis Strategy

**Location:** [src/plugins/builtin/LineCountStrategy.ts](../src/plugins/builtin/LineCountStrategy.ts)

---

## M

### Memory Cache
**Definition:** Cache adapter storing results in RAM (not persisted to disk).

**Features:**
- LRU eviction (removes oldest entry when full)
- TTL (time-to-live) expiration
- Hash-based validation

**Configuration:**
```typescript
registry.setConfig({
  maxCacheEntries: 1000,
  cacheTTLMs: 24 * 60 * 60 * 1000, // 24 hours
});
```

**Location:** [src/plugins/builtin/MemoryCacheAdapter.ts](../src/plugins/builtin/MemoryCacheAdapter.ts)

---

### Metrics
**Definition:** Quantitative measurements of code properties.

**Current Metrics:**
- Line count

**Potential Metrics:**
- Cyclomatic complexity
- Cognitive complexity
- Token count
- Parameter count

---

## O

### Output Channel
**Definition:** VS Code UI panel for displaying text logs.

**Usage:** `logger.show()` displays the output panel.

**See Also:** Logger

---

## P

### Parallelization
**Definition:** Processing multiple files simultaneously instead of sequentially.

**Implementation:** `Promise.all()` with concurrency limit

**Benefit:** ~4x speedup on multi-core systems

**Limitation:** Memory increases with concurrency; default limit is 8 files

**See Also:** Concurrency Limit, Throughput

---

### Parser Registry
**Definition:** Central manager for plugin registration and initialization.

**Responsibilities:**
- Register parsers, strategies, cache adapters
- Initialize all plugins with shared configuration
- Provide lookup methods (`getParser`, `findParserByExtension`, etc.)

**Location:** [src/plugins/ParserRegistry.ts](../src/plugins/ParserRegistry.ts)

---

### Performance Test
**Definition:** Benchmark suite measuring execution time and throughput.

**Tests Include:**
- Baseline scan (full workspace)
- Cache performance (warm vs cold)
- Single file throughput
- Parallel vs sequential comparison

**Run:** `npm run perf-test`

**Location:** [src/test/performance.test.ts](../src/test/performance.test.ts)

---

### Plugin
**Definition:** Modular component that extends scanner functionality without modifying core code.

**Types:**
- **LanguageParser** - detects functions in code
- **Analysis Strategy** - filters/transforms functions
- **Cache Adapter** - stores results

**Benefits:**
- Extensibility (add new languages, strategies)
- Testability (isolated, mockable units)
- Maintainability (changes isolated to plugin)

**See Also:** Plugin System, PluginRegistry

---

### Plugin Configuration
**Definition:** Object passed to plugins during initialization.

**Example:**
```typescript
registry.setConfig({
  lineThreshold: 5,
  maxCacheEntries: 1000,
  cacheTTLMs: 86400000,
});
```

**Type:** `PluginConfig` (Map<string, unknown>)

---

### Plugin Interface
**Definition:** TypeScript interfaces defining the contract plugins must implement.

**Interfaces:**
- `LanguageParser`
- `AnalysisStrategy`
- `CacheAdapter`
- `FunctionMatch`
- `PluginConfig`

**Location:** [src/plugins/PluginInterface.ts](../src/plugins/PluginInterface.ts)

---

### Plugin System
**Definition:** Architecture allowing extensible parsing, analysis, and caching via plugins.

**Core Components:**
- `PluginInterface` - contracts
- `ParserRegistry` - management
- `ScannerEngine` - orchestration
- Built-in plugins (TypeScript, LineCount, MemoryCache)

**Documentation:** [docs/PLUGIN_SYSTEM.md](./PLUGIN_SYSTEM.md)

---

## R

### Regex Pattern
**Definition:** Regular expression for matching text patterns.

**Used For:** Detecting function declarations in code.

**Examples (TypeScript Parser):**
- `/(?:^|\s)(?:async\s+)?function\s+(\w+)\s*\(/` - function declarations
- `/(?:^|\s)(?:async\s+)?\*?\s*(\w+)\s*:\s*\(.*?\)\s*=>/` - arrow functions

**Limitation:** Cannot handle nested braces in strings/comments perfectly.

---

### Regex-Based Parsing
**Definition:** Using regular expressions to detect functions instead of parsing AST.

**Pros:**
- Fast (no compilation phase)
- No external dependencies
- Easy to understand and modify

**Cons:**
- Edge cases (string literals, comments, complex syntax)
- Not scalable to complex languages

---

## S

### Scan Result
**Definition:** Output of a file scan containing detected functions.

**Type:**
```typescript
interface ScanResult {
  filePath: string;
  functions: FunctionMatch[];
}
```

**See Also:** FunctionMatch

---

### Scanner Engine
**Definition:** Orchestrator coordinating parsers, strategies, and caches for workspace scanning.

**Responsibilities:**
- Gather eligible files
- Manage concurrent scanning
- Coordinate plugin execution
- Handle file I/O asynchronously
- Progress reporting

**Usage:**
```typescript
const engine = new ScannerEngine(parser, strategy, cache);
const results = await engine.scanWorkspace(workspaceRoot, {
  concurrencyLimit: 8,
});
```

**Location:** [src/core/ScannerEngine.ts](../src/core/ScannerEngine.ts)

---

### Source Map
**Definition:** Debug information mapping bundled code back to original TypeScript.

**Enables:** Setting breakpoints in VS Code on original source files.

**Generated:** By esbuild during `npm run compile`.

---

## T

### Throughput
**Definition:** Number of files processed per unit time (files/second).

**Formula:** `fileCount / (durationMs / 1000)`

**Typical:** 40-50 files/sec with concurrency=8

**Metric:** Shown in performance test output.

---

### Tree Data Provider
**Definition:** VS Code API for populating tree views with hierarchical data.

**Implementation:** `FunctionTreeDataProvider` in extension.ts

**Hierarchy:** Workspace → Files → Functions

**See Also:** Tree View

---

### Tree View
**Definition:** VS Code sidebar panel displaying hierarchical data in an expandable tree.

**In cleanExtension:**
- Named "Function Scanner" in Activity Bar
- Shows files containing long functions
- Shows individual functions within each file
- Click function to navigate to it in editor

---

### TTL (Time-To-Live)
**Definition:** Duration a cached item remains valid before expiration.

**In MemoryCacheAdapter:** Default 24 hours

**Configuration:** `registry.setConfig({ cacheTTLMs: 86400000 })`

---

## U

### Utility Module
**Definition:** Reusable functions extracted to avoid duplication (DRY principle).

**Examples:**
- `Logger` - centralized logging
- `MemoryCacheAdapter.computeHash()` - file hashing

**Location:** [src/utils/](../src/utils/)

---

## W

### Workspace
**Definition:** Root folder opened in VS Code containing project files.

**Scanner Operations:**
- Recursively scans all directories in workspace
- Excludes common directories (node_modules, dist, .git, etc.)
- Applies plugins to relevant file types

---

### Workspace Root
**Definition:** Top-level path of the VS Code workspace.

**Obtained From:** `vscode.workspace.workspaceFolders[0].uri.fsPath`

**Used As:** Starting point for recursive file gathering.

---

## Symbols & Notation

| Symbol | Meaning |
|--------|---------|
| `→` | leads to, becomes |
| `≈` | approximately |
| `<` | less than |
| `>` | greater than |
| `...` | omitted for brevity |
| `#` | reference (e.g., `#L10` = line 10) |

---

## Related Files

Quick navigation to key source files:

| Concept | File |
|---------|------|
| Plugin Interfaces | [src/plugins/PluginInterface.ts](../src/plugins/PluginInterface.ts) |
| TypeScript Parser | [src/plugins/builtin/TypeScriptParser.ts](../src/plugins/builtin/TypeScriptParser.ts) |
| Scanner Engine | [src/core/ScannerEngine.ts](../src/core/ScannerEngine.ts) |
| Extension Entry Point | [src/extension.ts](../src/extension.ts) |
| Performance Tests | [src/test/performance.test.ts](../src/test/performance.test.ts) |

