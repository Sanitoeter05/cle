# Function Scanner for VS Code

An efficient, extensible code scanner that identifies functions longer than a specified threshold (default: 5 lines) across your TypeScript/JavaScript workspace. Built with a modern plugin system following **DRY** (Don't Repeat Yourself) and **KISS** (Keep It Simple, Stupid) principles.

![Version](https://img.shields.io/badge/version-0.0.1-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 🔍 **Real-time Scanning** - Automatically scans workspace on startup and monitors file changes
- ⚡ **Fast Performance** - Scans 100 TypeScript files in ~2-3 seconds with smart caching
- 🎯 **Smart Caching** - In-memory cache with file hash validation avoids redundant scans
- 📊 **Tree View UI** - Visual hierarchy of files → functions for easy navigation

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

## License

MIT

---

**Made with ❤️ for developers who care about code quality**

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
