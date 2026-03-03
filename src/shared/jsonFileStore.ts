import * as fs from "fs";
import * as path from "path";
import { normalizeErrorMessage } from "../errorUtils";

type Logger = (message: string) => void;

export class JsonFileStore {
  private cachedData: Record<string, unknown> | null = null;
  private cachedMtimeMs: number | null = null;

  constructor(
    private readonly filePath: string,
    private readonly log: Logger,
  ) {}

  read(): Record<string, unknown> {
    try {
      const stat = fs.statSync(this.filePath);
      if (this.cachedData !== null && this.cachedMtimeMs === stat.mtimeMs) {
        return this.cachedData;
      }
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      this.cachedData = data;
      this.cachedMtimeMs = stat.mtimeMs;
      return data;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.cachedData = null;
        this.cachedMtimeMs = null;
        return {};
      }
      this.log(
        `Failed to parse ${this.filePath}, returning empty: ${normalizeErrorMessage(err)}`,
      );
      this.cachedData = null;
      this.cachedMtimeMs = null;
      return {};
    }
  }

  write(data: Record<string, unknown>): boolean {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const content = JSON.stringify(data, null, 2);
      if (process.platform === "win32") {
        fs.writeFileSync(this.filePath, content, "utf-8");
      } else {
        fs.writeFileSync(this.filePath, content, {
          encoding: "utf-8",
          mode: 0o600,
        });
      }
      this.cachedData = data;
      try {
        this.cachedMtimeMs = fs.statSync(this.filePath).mtimeMs;
      } catch {
        this.cachedMtimeMs = null;
      }
      return true;
    } catch (err) {
      this.cachedData = null;
      this.cachedMtimeMs = null;
      this.log(
        `Failed to write ${this.filePath}: ${normalizeErrorMessage(err)}`,
      );
      return false;
    }
  }

  update(
    updater: (data: Record<string, unknown>) => Record<string, unknown>,
  ): boolean {
    const data = this.read();
    const before = JSON.stringify(data);
    const updated = updater(data);
    const after = JSON.stringify(updated);
    if (before === after) {
      return true;
    }
    return this.write(updated);
  }
}
