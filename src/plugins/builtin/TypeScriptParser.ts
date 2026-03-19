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

  /**
   * JavaScript/TypeScript keywords that are NOT functions.
   */
  private readonly KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'try', 'catch', 'finally',
    'with', 'return', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of',
    'class', 'extends', 'implements', 'interface', 'namespace', 'module',
    'import', 'export', 'from', 'as', 'default', 'const', 'let', 'var',
    'public', 'private', 'protected', 'static', 'readonly', 'async', 'await',
  ]);

  async initialize(config: PluginConfig): Promise<void> {
    if (config.lineThreshold && typeof config.lineThreshold === "number") {
      this.lineThreshold = config.lineThreshold;
    }
  }

  async parse(content: string, _filePath: string): Promise<FunctionMatch[]> {
    const lines = content.split("\n");

    // Step 1: Find all blocks
    const allBlocks = this.findAllBlocks(lines);

    // Step 2: Build tree structure (find parent-child relationships)
    const tree = this.buildTree(allBlocks);

    return tree;
  }

  /**
   * Find all blocks in the file (opening and closing braces)
   */
  private findAllBlocks(lines: string[]): FunctionMatch[] {
    const blocks: FunctionMatch[] = [];

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
        blocks.push({
          name: funcName,
          startLine: i + 1,  // 1-based
          endLine: endLine + 1,
          lineCount,
          metrics: { parser: "typescript" },
          children: [],
        });
      }
    }

    return blocks;
  }

  /**
   * Build tree structure: organize blocks into parent-child relationships
   * Returns only top-level blocks (those with no parent)
   */
  private buildTree(allBlocks: FunctionMatch[]): FunctionMatch[] {
    // For each block, find blocks that are completely nested inside it
    for (const parent of allBlocks) {
      const childrenOfParent: FunctionMatch[] = [];

      for (const potential of allBlocks) {
        // A child is completely inside parent if:
        // parent.startLine < potential.startLine AND potential.endLine < parent.endLine
        // AND it's not the parent itself
        if (
          potential !== parent &&
          parent.startLine < potential.startLine &&
          potential.endLine < parent.endLine
        ) {
          // Check if this is a direct child (not a child of another child)
          let isDirectChild = true;
          for (const other of allBlocks) {
            if (other !== parent && other !== potential) {
              // If potential is inside other, and other is inside parent, it's not direct
              if (
                parent.startLine < other.startLine &&
                other.endLine < parent.endLine &&
                other.startLine < potential.startLine &&
                potential.endLine < other.endLine
              ) {
                isDirectChild = false;
                break;
              }
            }
          }

          if (isDirectChild) {
            childrenOfParent.push(potential);
          }
        }
      }

      parent.children = childrenOfParent;
    }

    // Return only top-level blocks (those that have no parent)
    const topLevel: FunctionMatch[] = [];
    for (const block of allBlocks) {
      let hasParent = false;
      for (const other of allBlocks) {
        if (other !== block) {
          // Is block inside other?
          if (
            other.startLine < block.startLine &&
            block.endLine < other.endLine
          ) {
            hasParent = true;
            break;
          }
        }
      }
      if (!hasParent) {
        topLevel.push(block);
      }
    }

    return topLevel;
  }

  /**
   * Extract function name by searching backward from opening brace.
   * Matches function declarations and assignments, filters out control flow keywords.
   */
  private extractFuncName(lines: string[], lineNum: number, braceIndex: number): string | null {
    // Search current line and few before
    for (let i = lineNum; i >= Math.max(0, lineNum - 3); i--) {
      const line = lines[i];
      
      // Pattern 1: explicit "function" keyword
      let match = /\bfunction\s+(\w+)\s*\(/.exec(line);
      if (match && !this.KEYWORDS.has(match[1])) {
        return match[1];
      }
      
      // Pattern 2: variable assignment patterns
      // const/let/var name = function/async/arrow
      match = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\s|\(|async\s*\(|\[|\{)/.exec(line);
      if (match && !this.KEYWORDS.has(match[1])) {
        return match[1];
      }

      // Pattern 2b: plain property/variable assignment with async or arrow
      // name = async (...) or obj.name = async (...) or name = (...)
      match = /\b(\w+)\s*=\s*(?:async\s+)?(?:\(|async\s*\()/.exec(line);
      if (match && !this.KEYWORDS.has(match[1])) {
        return match[1];
      }
      
      // Pattern 3: property/method assignment (on same line as brace)
      if (i === lineNum) {
        const beforeBrace = line.substring(0, braceIndex).trim();
        
        // Skip multi-paren lines (likely function calls with callbacks)
        if ((beforeBrace.match(/\(/g) || []).length > 1) {
          continue;
        }
        
        // Skip lines with arrow functions in params (forEach, map, async callbacks, etc.)
        // UNLESS it's clearly an assignment pattern (has = before it)
        const hasArrow = beforeBrace.includes('=>');
        const hasAssignment = beforeBrace.includes('=');
        if (hasArrow && !hasAssignment) {
          continue;  // This is a function CALL with callback, not a declaration
        }
        
        // Match: identifier(params) at end of line before brace
        match = /(\w+)\s*\(\s*[^{]*\)$/.exec(beforeBrace);
        if (match) {
          const name = match[1];
          
          // REJECT if it's a control flow keyword
          if (this.KEYWORDS.has(name)) {
            continue;
          }
          
          return name;
        }
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

