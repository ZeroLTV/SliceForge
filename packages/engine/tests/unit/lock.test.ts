import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { LockAcquisitionError } from "../../src/utils/errors.js";

const mockExistsSync = jest.fn<() => boolean>();
const mockReadFileSync = jest.fn<() => string>();
const mockWriteFileSync = jest.fn<() => void>();
const mockUnlinkSync = jest.fn<() => void>();

jest.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
}));

import { acquireLock, releaseLock } from "../../src/utils/lock.js";

const LOCK_PATH = "/fake/.sliceforge.lock";
const CURRENT_PID = process.pid;

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteFileSync.mockReturnValue(undefined);
  mockUnlinkSync.mockReturnValue(undefined);
  mockReadFileSync.mockReturnValue("");
  mockExistsSync.mockReturnValue(false);
});

describe("acquireLock", () => {
  it("creates lock file with PID when no lock exists", () => {
    mockExistsSync.mockReturnValue(false);

    acquireLock(LOCK_PATH);

    expect(mockWriteFileSync).toHaveBeenCalledWith(LOCK_PATH, `${CURRENT_PID}`, "utf8");
  });

  it("throws error when process is already running", () => {
    const existingPid = 99999;

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`${existingPid}\n`);

    const processKillSpy = jest.spyOn(process, "kill").mockImplementation(() => {
      return true;
    });

    expect(() => acquireLock(LOCK_PATH)).toThrow(
      `Another SliceForge instance is already running (PID: ${existingPid})`,
    );

    expect(mockReadFileSync).toHaveBeenCalledWith(LOCK_PATH, "utf8");

    processKillSpy.mockRestore();
  });

  it("cleans up stale lock when PID process is dead", () => {
    const stalePid = 12345;

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`${stalePid}\n`);

    const processKillSpy = jest.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    acquireLock(LOCK_PATH);

    expect(mockWriteFileSync).toHaveBeenCalledWith(LOCK_PATH, `${CURRENT_PID}`, "utf8");

    processKillSpy.mockRestore();
  });

  it("throws LockAcquisitionError when lock file write fails", () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });

    expect(() => acquireLock(LOCK_PATH)).toThrow(LockAcquisitionError);
    expect(() => acquireLock(LOCK_PATH)).toThrow("Failed to create lock file");
  });

  it("throws LockAcquisitionError when lock file read fails", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });

    expect(() => acquireLock(LOCK_PATH)).toThrow(LockAcquisitionError);
    expect(() => acquireLock(LOCK_PATH)).toThrow("Failed to read lock file");
  });

  it("cleans up stale lock with non-numeric content", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("garbage-content");

    acquireLock(LOCK_PATH);

    expect(mockWriteFileSync).toHaveBeenCalledWith(LOCK_PATH, `${CURRENT_PID}`, "utf8");
  });

  it("cleans up stale lock when kill throws non-ESRCH error", () => {
    const stalePid = 12345;

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`${stalePid}\n`);

    const processKillSpy = jest.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    expect(() => acquireLock(LOCK_PATH)).toThrow();

    processKillSpy.mockRestore();
  });
});

describe("releaseLock", () => {
  it("removes lock file when it exists", () => {
    mockExistsSync.mockReturnValue(true);

    releaseLock(LOCK_PATH);

    expect(mockUnlinkSync).toHaveBeenCalledWith(LOCK_PATH);
  });

  it("throws LockAcquisitionError on unlink failure", () => {
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });

    expect(() => releaseLock(LOCK_PATH)).toThrow(LockAcquisitionError);
    expect(() => releaseLock(LOCK_PATH)).toThrow("Failed to release lock file");
  });

  it("does nothing when lock file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    releaseLock(LOCK_PATH);

    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });
});
