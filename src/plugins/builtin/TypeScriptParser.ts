/**
 * TypeScript/JavaScript language parser - MAXIMUM SPEED
 * 
 * Dead-simple algorithm:
 * 1. Find lines with opening brace {
 * 2. Search backward for function keyword or identifier
 * 3. Count forward until closing brace }
 * 4. Record if line count >= threshold
 * 
 * No complex regex per-line, no string scanning, just simple operations.
 */

import { LanguageParser, FunctionMatch, PluginConfig } from "../PluginInterface";

export class TypeScriptParser implements LanguageParser {
  id = "typescript";
  fileExtensions = [".ts", ".tsx", ".js", ".jsx"];
  private lineThreshold: number = 5;

  async initialize(config: PluginConfig): Promise<void> {
    if (config.lineThreshold && typeof config.lineThreshold === "number") {
      this.lineThreshold = config.lineThreshold;
    }
  }

  async parse(content: string, _filePath: string): Promise<FunctionMatch[]> {
    const functions: FunctionMatch[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Quick check: does this line have an opening brace?
      const braceIndex = line.indexOf("{");
      if (braceIndex === -1) continue;

      // Extract function name by searching backwards
      const funcName = this.extractFuncName(lines, i, braceIndex);
      if (!funcName) continue;

      // Find closing brace, count lines
      const endLine = this.findClosingBraceLine(lines, i, braceIndex);
      if (endLine === -1) continue;

      const lineCount = endLine - i + 1;
      if (lineCount >= this.lineThreshold) {
        functions.push({
          name: funcName,
          startLine: i + 1,  // 1-based
          endLine: endLine + 1,
          lineCount,
          metrics: { parser: "typescript" },
        });
      }
    }

    return functions;
  }

  /**
   * Extract function name by searching backward from opening brace.
   * Looks for: `function name(`, `name() =>`, `name(`, or `name: function`
   */
  private extractFuncName(lines: string[], lineNum: number, braceIndex: number): string | null {
    // Search current line and few before it
    for (let i = lineNum; i >= Math.max(0, lineNum - 3); i--) {
      const line = lines[i];
      
      // Look for function keyword followed by identifier
      let match = /function\s+(\w+)/.exec(line);
      if (match) return match[1];
      
      // Look for identifier followed by parentheses
      match = /(\w+)\s*\([^)]*\)\s*(?:=>|:)/.exec(line);
      if (match) return match[1];
      
      // Look for identifier() or identifier => in current line
      if (i === lineNum) {
        match = /(\w+)\s*\(/.exec(line.substring(0, braceIndex));
        if (match) return match[1];
      }
    }

    return null;
  }

  /**
   * Find closing brace line by counting braces.
   * Simple brace counter: doesn't need to traverse entire file.
   */
  private findClosingBraceLine(lines: string[], startLine: number, startBraceIndex: number): number {
    let braceCount = 1;  // We found opening brace

    // Count remaining braces on starting line
    const startLineRest = lines[startLine].substring(startBraceIndex + 1);
    for (const char of startLineRest) {
      if (char === "{") braceCount++;
      else if (char === "}") {
        braceCount--;
        if (braceCount === 0) return startLine;
      }
    }

    // Continue on following lines
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      for (const char of line) {
        if (char === "{") {
          braceCount++;
        } else if (char === "}") {
          braceCount--;
          if (braceCount === 0) {
            return i;
          }
        }
      }
    }

    return -1;
  }
}

