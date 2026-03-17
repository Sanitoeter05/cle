# Plugin System Architecture

## Overview

The Function Scanner uses a plugin-based architecture that follows the **DRY (Don't Repeat Yourself)** and **KISS (Keep It Simple, Stupid)** principles. This design allows extending the scanner with new language parsers, analysis strategies, and caching mechanisms without modifying core code.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Plugin Registry                               │
│  Manages registration and initialization of all plugins          │
└─────────────────────────────────────────────────────────────────┘
         ↓
    ┌────────────────────────────────────────────────────┐
    │              Scanner Engine                        │
    │  Orchestrates plugins and coordinates scanning     │
    └────────────────────────────────────────────────────┘
         ↓
  ┌──────────────┬─────────────────┬────────────────────┐
  ↓              ↓                  ↓                     ↓
┌────────┐  ┌────────────┐  ┌─────────────┐  ┌────────────────┐
│ Parser │  │  Strategy  │  │  Cache      │  │   VS Code      │
│ Plugin │  │  Plugin    │  │  Adapter    │  │   Integration  │
└────────┘  └────────────┘  └─────────────┘  └────────────────┘
```

## Key Components

### 1. LanguageParser Interface

Detects and analyzes functions in source code for a specific language.

```typescript
interface LanguageParser {
  id: string;                                              // Unique identifier
  fileExtensions: string[];                                // Handled file extensions
  initialize(config: PluginConfig): Promise<void>;
  parse(content: string, filePath: string): Promise<FunctionMatch[]>;
}
```

**Example: TypeScript Parser** (`src/plugins/builtin/TypeScriptParser.ts`)
- Uses regex patterns to detect function declarations, arrow functions, and methods
- Counts braces to find function boundaries
- Fast, no external dependencies

### 2. AnalysisStrategy Interface

Filters or transforms parsed functions based on criteria.

```typescript
interface AnalysisStrategy {
  id: string;
  initialize(config: PluginConfig): Promise<void>;
  analyze(functions: FunctionMatch[]): Promise<FunctionMatch[]>;
}
```

**Example: LineCountStrategy** (`src/plugins/builtin/LineCountStrategy.ts`)
- Filters functions >= specified line threshold (default: 5 lines)
- Can be extended for complexity metrics, cognitive load, cyclomatic complexity, etc.

### 3. CacheAdapter Interface

Optionally caches scan results for performance.

```typescript
interface CacheAdapter {
  id: string;
  initialize(config: PluginConfig): Promise<void>;
  get(key: string): Promise<FunctionMatch[] | null>;
  set(key: string, value: FunctionMatch[]): Promise<void>;
  isValid(key: string, fileHash: string): Promise<boolean>;
  clear(): Promise<void>;
}
```

**Example: MemoryCacheAdapter** (`src/plugins/builtin/MemoryCacheAdapter.ts`)
- In-memory cache with LRU eviction
- File hash validation to detect changes
- TTL support for cache invalidation

### 4. PluginRegistry

Central registry for managing plugin lifecycle.

```typescript
const registry = new PluginRegistry();
registry.setConfig({ lineThreshold: 5 });
registry.registerParser(new TypeScriptParser());
registry.registerStrategy(new LineCountStrategy());
registry.registerCache(new MemoryCacheAdapter());
await registry.initializeAll();
```

### 5. ScannerEngine

Orchestrates parsing, analysis, and caching with async I/O and parallelization.

```typescript
const engine = new ScannerEngine(parser, strategy, cache);

// Scan entire workspace
const results = await engine.scanWorkspace('/path/to/workspace', {
  concurrencyLimit: 8,
  onProgress: (processed, total) => console.log(`${processed}/${total}`),
});

// Scan single file
const result = await engine.scanFile('/path/to/file.ts');
```

## Creating a Custom Plugin

### Example: Python Parser Plugin

```typescript
// src/plugins/custom/PythonParser.ts

import { LanguageParser, FunctionMatch, PluginConfig } from '../PluginInterface';

export class PythonParser implements LanguageParser {
  id = 'python';
  fileExtensions = ['.py'];

  async initialize(config: PluginConfig): Promise<void> {
    // No-op for this simple example
  }

  async parse(content: string, filePath: string): Promise<FunctionMatch[]> {
    const functions: FunctionMatch[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const defMatch = /^\s*def\s+(\w+)\s*\(/.exec(line);

      if (defMatch) {
        const functionName = defMatch[1];
        const startLine = i + 1;
        // Calculate end by counting indentation and colons
        const endLine = this.findPythonFunctionEnd(lines, i);

        functions.push({
          name: functionName,
          startLine,
          endLine,
          lineCount: endLine - startLine + 1,
          metrics: { parser: 'python' },
        });
      }
    }

    return functions;
  }

  private findPythonFunctionEnd(lines: string[], startLine: number): number {
    const baseIndent = lines[startLine].match(/^\s*/)?.[0].length ?? 0;

    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;

      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= baseIndent && line.trim()) {
        return i; // Found dedent or next function
      }
    }

    return lines.length;
  }
}
```

### Register the Plugin

```typescript
// In extension.ts activate() function

import { PythonParser } from './plugins/custom/PythonParser';

const pythonParser = new PythonParser();
registry.registerParser(pythonParser);
```

## Configuration

Plugins receive configuration via `PluginConfig` object:

```typescript
registry.setConfig({
  lineThreshold: 5,           // For parsers and strategies
  maxCacheEntries: 1000,      // For cache adapters
  cacheTTLMs: 24 * 60 * 60 * 1000, // 24 hours
});
```

## Performance Characteristics

| Component | Time | Notes |
|-----------|------|-------|
| **TypeScript Parser** | ~0.1ms per file | Regex-based, very fast |
| **LineCount Strategy** | Negligible | Simple filter |
| **Memory Cache** | O(1) lookup | In-memory, no I/O |
| **Workspace Scan (100 files)** | ~2-3 seconds | With concurrency=8 |
| **Single File Scan** | ~10-20ms | Including I/O |

## Best Practices

1. **Implement Async**: Use `async/await` even if synchronous to maintain consistency
2. **Handle Errors**: Return empty arrays on parse errors; don't throw
3. **Use Config**: Read from `PluginConfig`, don't hardcode values
4. **Cache Wisely**: Implement hash validation to detect file changes
5. **Follow DRY**: Extract common patterns into utility modules
6. **Test Plugins**: Add unit tests to `src/test/` for new plugins

## Extending with New Strategies

### Example: Complexity Analyzer

```typescript
// src/plugins/custom/ComplexityStrategy.ts

export class ComplexityStrategy implements AnalysisStrategy {
  id = 'complexity';
  private complexityThreshold = 10;

  async initialize(config: PluginConfig): Promise<void> {
    if (config.complexityThreshold) {
      this.complexityThreshold = config.complexityThreshold;
    }
  }

  async analyze(functions: FunctionMatch[]): Promise<FunctionMatch[]> {
    return functions.filter(fn => {
      const complexity = this.calculateComplexity(fn);
      return complexity >= this.complexityThreshold;
    });
  }

  private calculateComplexity(fn: FunctionMatch): number {
    // Implement cyclomatic complexity calculation
    return 0;
  }
}
```

## Future Extensions

The plugin system enables:

- ✅ **Multiple language parsers** (Python, Java, C#, Go, Rust, etc.)
- ✅ **Advanced metrics** (cyclomatic complexity, cognitive load, code smells)
- ✅ **AST-based parsing** (replacing regex with TypeScript Compiler API, Babel, etc.)
- ✅ **Persistent caching** (file-system, SQLite, Redis)
- ✅ **Remote analysis** (send to remote service for complex parsing)
- ✅ **Custom reporting** (export to JSON, CSV, HTML reports)

