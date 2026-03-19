/**
 * Watches workspace file changes and emits batched change events.
 * Debounces rapid changes to batch multiple edits together.
 */

import * as vscode from 'vscode';

export interface FileChangeEvent {
  added: string[];
  modified: string[];
  deleted: string[];
}

export class FileWatcher {
  private watchers: vscode.FileSystemWatcher[] = [];
  private changeQueue: Map<string, 'added' | 'modified' | 'deleted'> = new Map();
  private debounceTimeout: NodeJS.Timeout | undefined;
  private debounceMs: number = 150; // Debounce window
  private excludeDirs: Set<string>;
  
  private _onFileChange: vscode.EventEmitter<FileChangeEvent> = new vscode.EventEmitter<FileChangeEvent>();
  readonly onFileChange = this._onFileChange.event;

  constructor(excludeDirs?: Set<string>) {
    this.excludeDirs = excludeDirs || this.defaultExcludeDirs();
  }

  /**
   * Start watching the workspace for file changes.
   * @param workspaceRoot Root directory to watch
   * @param fileExtensions File extensions to monitor (e.g., ['.ts', '.js'])
   */
  async start(workspaceRoot: string, fileExtensions: string[]): Promise<void> {
    // Create glob patterns for watched extensions
    const patterns = fileExtensions.map(ext => `**/*${ext}`);
    
    // Create exclude patterns
    const excludePatterns = this.getExcludePatterns();
    
    // Create watchers for each pattern
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, pattern),
        false, // Ignore create events handled by watch
        false,
        false
      );

      watcher.onDidCreate(uri => {
        if (!this.shouldIgnore(uri.fsPath)) {
          this.trackChange(uri.fsPath, 'added');
        }
      });

      watcher.onDidChange(uri => {
        if (!this.shouldIgnore(uri.fsPath)) {
          this.trackChange(uri.fsPath, 'modified');
        }
      });

      watcher.onDidDelete(uri => {
        if (!this.shouldIgnore(uri.fsPath)) {
          this.trackChange(uri.fsPath, 'deleted');
        }
      });

      this.watchers.push(watcher);
    }
  }

  /**
   * Stop watching for file changes.
   */
  dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }
    
    this._onFileChange.dispose();
  }

  /**
   * Track a file change with debouncing.
   */
  private trackChange(filePath: string, changeType: 'added' | 'modified' | 'deleted'): void {
    // Update the change type (modified overrides added, etc.)
    if (changeType === 'deleted') {
      this.changeQueue.set(filePath, 'deleted');
    } else if (changeType === 'modified' && this.changeQueue.get(filePath) !== 'deleted') {
      this.changeQueue.set(filePath, 'modified');
    } else if (changeType === 'added' && !this.changeQueue.has(filePath)) {
      this.changeQueue.set(filePath, 'added');
    }

    // Clear existing debounce timer
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }

    // Set new debounce timer
    this.debounceTimeout = setTimeout(() => {
      this.flushChanges();
    }, this.debounceMs);
  }

  /**
   * Emit batched changes and clear the queue.
   */
  private flushChanges(): void {
    if (this.changeQueue.size === 0) {
      return;
    }

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const [filePath, changeType] of this.changeQueue.entries()) {
      if (changeType === 'added') {
        added.push(filePath);
      } else if (changeType === 'modified') {
        modified.push(filePath);
      } else if (changeType === 'deleted') {
        deleted.push(filePath);
      }
    }

    this.changeQueue.clear();
    this.debounceTimeout = undefined;

    // Emit the batched event
    this._onFileChange.fire({ added, modified, deleted });
  }

  /**
   * Check if a file path should be ignored.
   */
  private shouldIgnore(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    
    // Check for excluded directories
    for (const dir of this.excludeDirs) {
      if (normalized.includes(`/${dir}/`) || normalized.includes(`\\${dir}\\`)) {
        return true;
      }
    }

    // Check for minified files
    if (filePath.endsWith('.min.js') || filePath.endsWith('.min.ts') ||
        filePath.endsWith('.min.jsx') || filePath.endsWith('.min.tsx')) {
      return true;
    }

    return false;
  }

  /**
   * Get glob exclude patterns for the watcher.
   */
  private getExcludePatterns(): string[] {
    return [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.vscode/**',
      '**/.idea/**',
      '**/out/**',
      '**/*.min.js',
      '**/*.min.ts',
    ];
  }

  /**
   * Default directories to exclude.
   */
  private defaultExcludeDirs(): Set<string> {
    return new Set([
      'node_modules',
      '.git',
      '.vscode',
      'dist',
      'build',
      '.idea',
      'out',
    ]);
  }
}
