/**
 * Test fixtures: sample TypeScript code for performance testing.
 * Generates synthetic code with functions of varying lengths.
 */

/**
 * Generate a sample TypeScript file with multiple functions.
 */
export function generateSampleTypeScriptFile(
  fileNumber: number,
  functionsPerFile: number = 5
): string {
  const lines: string[] = [];

  lines.push("// Auto-generated sample TypeScript file for testing");
  lines.push(`// File: sample-${fileNumber}.ts\n`);

  for (let i = 0; i < functionsPerFile; i++) {
    const lineCount = 3 + (i % 10); // Functions from 3 to 12 lines
    lines.push(`export function sampleFunction${i}_${fileNumber}() {`);

    for (let j = 0; j < lineCount; j++) {
      lines.push(`  const value${j} = ${j};`);
      lines.push("  console.log(value);");
    }

    lines.push("}\n");
  }

  return lines.join("\n");
}

/**
 * Generate multiple sample files.
 */
export function generateSampleWorkspace(
  fileCount: number,
  functionsPerFile: number = 5
): Map<string, string> {
  const files = new Map<string, string>();

  for (let i = 0; i < fileCount; i++) {
    const fileName = `sample-${i}.ts`;
    const content = generateSampleTypeScriptFile(i, functionsPerFile);
    files.set(fileName, content);
  }

  return files;
}
