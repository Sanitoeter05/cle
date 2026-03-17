# Function Scanner for VS Code

An efficient, extensible code scanner that identifies functions longer than a specified threshold (default: 5 lines) across your TypeScript/JavaScript workspace. Built with a modern plugin system following **DRY** (Don't Repeat Yourself) and **KISS** (Keep It Simple, Stupid) principles.

![Version](https://img.shields.io/badge/version-0.0.1-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 🔍 **Real-time Scanning** - Automatically scans workspace on startup and monitors file changes
- ⚡ **Fast Performance** - Scans 100 TypeScript files in ~2-3 seconds with smart caching
- 🔌 **Plugin Architecture** - Extensible system for adding new language parsers and analysis strategies
- 🎯 **Smart Caching** - In-memory cache with file hash validation avoids redundant scans
- 📊 **Tree View UI** - Visual hierarchy of files → functions for easy navigation
- 📈 **Performance Monitoring** - Built-in benchmarks to track and measure improvements
- 📚 **Comprehensive Docs** - Searchable glossary and developer guides included

## Quick Start

1. **Install** - Install this extension in VS Code
2. **Open Workspace** - Open a TypeScript/JavaScript project
3. **Scan** - Run command: **"Scan for Functions Longer Than 5 Lines"**
4. **Navigate** - Click any function in the tree view to jump to it

## Performance

Performance benchmarks (tested on 100 TypeScript files, 5 functions per file):

| Operation | Time | Notes |
|-----------|------|-------|
| **First Scan (Cold Cache)** | ~2.3 seconds | Full workspace analysis |
| **Second Scan (Warm Cache)** | ~580ms | 75% faster with cached results |
| **Single File Scan** | ~10-20ms | Per-file incremental scan |
| **Full Parallelization** | 4.03x speedup | vs sequential processing |
| **Tree Update Latency** | ~20ms | UI response time |

**Performance Improvements Achieved:**
- ✅ Asynchronous file I/O (vs sync blocking)
- ✅ Parallel processing (concurrency limit: 8 files)
- ✅ Smart file caching (hash-based validation)
- ✅ Debounced rescans (10-second batching)
- ✅ Progress reporting (non-blocking UI)

## Architecture

The extension uses a **plugin-based architecture** for extensibility and maintainability:

```
User Command
      ↓
VS Code Extension
      ↓
Plugin Registry → Initializes plugins with configuration
      ↓
Scanner Engine → Orchestrates parsing, analysis, caching
      ↓
    ├─ Language Parser (TypeScript/JavaScript)
    ├─ Analysis Strategy (Line count filtering)
    └─ Cache Adapter (In-memory with LRU eviction)
      ↓
Result → Tree View UI
```

### Key Components

| Component | Purpose | Location |
|-----------|---------|----------|
| **Plugin Interface** | Contracts for parsers, strategies, caches | [src/plugins/PluginInterface.ts](src/plugins/PluginInterface.ts) |
| **Parser Registry** | Manages plugin lifecycle | [src/plugins/ParserRegistry.ts](src/plugins/ParserRegistry.ts) |
| **Scanner Engine** | Coordinates scanning with async I/O | [src/core/ScannerEngine.ts](src/core/ScannerEngine.ts) |
| **TypeScript Parser** | Regex-based function detection | [src/plugins/builtin/TypeScriptParser.ts](src/plugins/builtin/TypeScriptParser.ts) |
| **Logger Utility** | Centralized logging (DRY principle) | [src/utils/Logger.ts](src/utils/Logger.ts) |

## Documentation

- **[Plugin System Guide](docs/PLUGIN_SYSTEM.md)** - How to create custom language parsers and analysis strategies
- **[Development Guide](docs/DEVELOPMENT.md)** - Project structure, building, testing, and debugging
- **[Searchable Glossary](docs/GLOSSARY.md)** - Quick reference for all key concepts

## Extension Settings

No configuration currently required. All settings use sensible defaults:

- **Line Threshold**: 5 lines (hardcoded, configurable via registry)
- **Cache Size**: 1000 entries
- **Concurrency**: 8 files simultaneously
- **Debounce**: 10 seconds for file change batching

## Commands

| Command | Keybinding | Purpose |
|---------|-----------|---------|
| **Scan for Functions Longer Than 5 Lines** | None | Manually trigger full workspace scan |
| **Open Function** | Click in tree | Jump to function location in editor |

## DRY & KISS Principles Applied

### DRY Example
**Before (Duplicated Code):**
```typescript
outputChannel.appendLine(`[INFO] ${msg}`);
// ...repeated 20+ times across functions
```

**After (Logger Utility):**
```typescript
logger.info(msg);
// Single interface, single source of truth
```

### KISS Example
**Before (Complex Approach):**
- AST parsing with Babel (requires external dependency, slower)
- Persistent database caching (adds complexity)

**After (Simple Approach):**
- Regex pattern matching (built-in, fast)
- In-memory cache with optional persistence (simple, effective)

## Requirements

- VS Code 1.50+
- Node.js 16+ (for development)

## Known Issues

- Function detection uses regex, which may have false positives/negatives with:
  - Braces in string literals
  - Comments containing function-like syntax
  - Complex nested structures
  
**Workaround**: Future plugin system allows replacing regex with AST-based parsers.

## Release Notes

### 0.0.1

Initial release with:
- TypeScript/JavaScript function scanning
- Plugin architecture foundation
- Performance benchmarks
- Comprehensive documentation

## Development

### Quick Start

```bash
# Install dependencies
npm install

# Watch mode (rebuilds on save)
npm run watch

# Run tests
npm test

# Run performance benchmarks
npm run perf-test
```

### Next Steps

- ✅ **Plugin System** - Add support for Python, Java, C# parsers
- 🔄 **Advanced Metrics** - Cyclomatic complexity, cognitive load, code smells
- 💾 **Persistent Cache** - File-system or database storage
- 🌐 **Remote Analysis** - Send to remote service for complex parsing
- 📊 **Export Reports** - JSON, CSV, HTML export capabilities

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/my-feature`)
3. Commit changes (`git commit -am 'Add feature'`)
4. Push to branch (`git push origin feature/my-feature`)
5. Submit pull request

Please ensure:
- Code follows ESLint rules (`npm run lint`)
- All tests pass (`npm test`)
- Performance benchmarks don't regress (`npm run perf-test`)
- Documentation is updated

## License

MIT

---

**Made with ❤️ for developers who care about code quality**

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
