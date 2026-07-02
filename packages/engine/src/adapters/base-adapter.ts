import { ShellResult } from "../utils/shell.js";

export interface StackAdapter {
  build(): Promise<ShellResult>;
  lint(): Promise<ShellResult>;
  test(layer: "unit" | "integration" | "e2e"): Promise<ShellResult>;
  startPreview(): Promise<void>;
  stopPreview(): Promise<void>;
  healthCheck(): Promise<boolean>;
}
