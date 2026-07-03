import * as fs from "fs";
import * as path from "path";

export enum LogLevel {
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
  SUCCESS = "SUCCESS",
  DEBUG = "DEBUG",
}

class Logger {
  private logFilePath: string | null = null;

  public setLogFile(filePath: string) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.logFilePath = filePath;
    fs.writeFileSync(
      filePath,
      `--- SliceForge Log Started: ${new Date().toISOString()} ---\n`,
    );
  }

  public info(msg: string) {
    console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`);
    this.writeToFile(LogLevel.INFO, msg);
  }

  public warn(msg: string) {
    console.warn(`\x1b[33m[WARN]\x1b[0m ${msg}`);
    this.writeToFile(LogLevel.WARN, msg);
  }

  public error(msg: string) {
    console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
    this.writeToFile(LogLevel.ERROR, msg);
  }

  public success(msg: string) {
    console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`);
    this.writeToFile(LogLevel.SUCCESS, msg);
  }

  public debug(msg: string) {
    this.writeToFile(LogLevel.DEBUG, msg);
    if (process.env.DEBUG) {
      console.log(`\x1b[90m[DEBUG]\x1b[0m ${msg}`);
    }
  }

  public section(title: string) {
    const separator = "=".repeat(60);
    console.log(
      `\n\x1b[1;35m${separator}\n=== ${title}\n${separator}\x1b[0m\n`,
    );
    this.writeToFile(LogLevel.INFO, `SECTION: ${title}`);
  }

  public step(name: string) {
    console.log(`\n\x1b[1;34m--> Step: ${name}\x1b[0m`);
    this.writeToFile(LogLevel.INFO, `STEP: ${name}`);
  }

  private writeToFile(level: LogLevel, message: string) {
    if (!this.logFilePath) return;
    try {
      const timestamp = new Date().toISOString();
      fs.appendFileSync(
        this.logFilePath,
        `[${timestamp}] [${level}] ${message}\n`,
      );
    } catch {
      // Silently ignore write errors to log file
    }
  }
}

export const logger = new Logger();
