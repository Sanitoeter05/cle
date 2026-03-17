/**
 * Line count analysis strategy.
 * Filters functions based on exceeding a minimum line count threshold.
 */

import { AnalysisStrategy, FunctionMatch, PluginConfig } from "../PluginInterface";

export class LineCountStrategy implements AnalysisStrategy {
  id = "line-count";

  private lineThreshold: number = 5;

  async initialize(config: PluginConfig): Promise<void> {
    if (config.lineThreshold && typeof config.lineThreshold === "number") {
      this.lineThreshold = config.lineThreshold;
    }
  }

  async analyze(functions: FunctionMatch[]): Promise<FunctionMatch[]> {
    return functions.filter((func) => func.lineCount >= this.lineThreshold);
  }
}
