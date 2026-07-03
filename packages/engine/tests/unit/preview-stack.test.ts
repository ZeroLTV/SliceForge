import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { EventEmitter } from "events";
import { StackAdapter } from "../../src/adapters/base-adapter.js";
import { SliceForgeConfig } from "../../src/core/config.js";

const createServerMock = jest.fn();

jest.mock("net", () => ({
  createServer: createServerMock,
}));

import { startPreviewStack, stopPreviewStack } from "../../src/gates/preview-stack.js";

class MockServer extends EventEmitter {
  close = jest.fn();
  listen = jest.fn();
}

function createMockNetServer(): MockServer {
  return new MockServer();
}

function createMockAdapter(overrides?: Partial<StackAdapter>): StackAdapter {
  return {
    build: jest.fn<StackAdapter["build"]>(),
    lint: jest.fn<StackAdapter["lint"]>(),
    test: jest.fn<StackAdapter["test"]>(),
    startPreview: jest.fn<StackAdapter["startPreview"]>().mockResolvedValue(undefined),
    stopPreview: jest.fn<StackAdapter["stopPreview"]>().mockResolvedValue(undefined),
    healthCheck: jest.fn<StackAdapter["healthCheck"]>().mockResolvedValue(true),
    ...overrides,
  };
}

function createMockConfig(overrides?: Partial<SliceForgeConfig>): SliceForgeConfig {
  return {
    project: "test-preview",
    agent: { type: "api" },
    stack: {
      type: "node",
      api: { port: 3000, healthPath: "/health" },
      web: { port: 8080, healthPath: "/" },
      ...overrides?.stack,
    },
    checks: {
      commands: {
        build: "npm run build",
        test: {},
      },
      ...overrides?.checks,
    },
    loop: {
      maxIterations: 10,
      maxRetriesPerSlice: 3,
      browserTest: { required: false, requirePreviewStack: false },
      testCaseGate: "skip",
      ...overrides?.loop,
    },
    paths: {
      backlog: "backlog.json",
      testCases: "testcases",
      guardrails: "guardrails.md",
      state: "state.json",
      lock: "lock",
      ...overrides?.paths,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  createServerMock.mockReset();
});

describe("startPreviewStack", () => {
  describe("port conflict detection", () => {
    it("throws error when API port is already in use", async () => {
      const mockServer = createMockNetServer();
      createServerMock.mockReturnValue(mockServer);

      mockServer.listen.mockImplementation((port: number) => {
        setImmediate(() => {
          mockServer.emit(
            "error",
            Object.assign(new Error(`listen EADDRINUSE :::${port}`), { code: "EADDRINUSE" }),
          );
        });
        return mockServer;
      });

      const adapter = createMockAdapter();
      const config = createMockConfig({
        stack: {
          type: "node",
          api: { port: 3000, healthPath: "/health" },
          web: { port: 8080, healthPath: "/" },
        },
      });

      await expect(startPreviewStack(config, adapter)).rejects.toThrow("Port conflict detected");
      expect(adapter.startPreview).not.toHaveBeenCalled();
    });

    it("throws error when Web port is already in use", async () => {
      const apiServer = createMockNetServer();
      const webServer = createMockNetServer();
      createServerMock
        .mockReturnValueOnce(apiServer)
        .mockReturnValueOnce(webServer);

      let apiCalled = false;
      apiServer.listen.mockImplementation(() => {
        setImmediate(() => {
          if (!apiCalled) {
            apiCalled = true;
            apiServer.emit("listening");
          }
        });
        return apiServer;
      });

      webServer.listen.mockImplementation((port: number) => {
        setImmediate(() => {
          webServer.emit(
            "error",
            Object.assign(new Error(`listen EADDRINUSE :::${port}`), { code: "EADDRINUSE" }),
          );
        });
        return webServer;
      });

      const adapter = createMockAdapter();
      const config = createMockConfig({
        stack: {
          type: "node",
          api: { port: 3000, healthPath: "/health" },
          web: { port: 8080, healthPath: "/" },
        },
      });

      await expect(startPreviewStack(config, adapter)).rejects.toThrow("Port conflict detected");
      expect(adapter.startPreview).not.toHaveBeenCalled();
    });

    it("proceeds when ports are free", async () => {
      const mockServer = createMockNetServer();
      createServerMock.mockReturnValue(mockServer);

      mockServer.listen.mockImplementation(() => {
        setImmediate(() => {
          mockServer.emit("listening");
        });
        return mockServer;
      });

      const adapter = createMockAdapter();
      const config = createMockConfig();

      await startPreviewStack(config, adapter);

      expect(adapter.startPreview).toHaveBeenCalled();
    });

    it("proceeds when config has no api/web ports", async () => {
      const adapter = createMockAdapter();
      const config = createMockConfig();
      (config.stack as any).api = undefined;
      (config.stack as any).web = undefined;

      await startPreviewStack(config, adapter);

      expect(adapter.startPreview).toHaveBeenCalled();
      expect(adapter.healthCheck).toHaveBeenCalled();
    });
  });

  it("succeeds when healthcheck passes on first attempt", async () => {
    const mockServer = createMockNetServer();
    createServerMock.mockReturnValue(mockServer);

    mockServer.listen.mockImplementation(() => {
      setImmediate(() => {
        mockServer.emit("listening");
      });
      return mockServer;
    });

    const adapter = createMockAdapter({
      healthCheck: jest.fn<StackAdapter["healthCheck"]>().mockResolvedValue(true),
    });

    await startPreviewStack(createMockConfig(), adapter);

    expect(adapter.startPreview).toHaveBeenCalledTimes(1);
    expect(adapter.healthCheck).toHaveBeenCalledTimes(1);
    expect(adapter.stopPreview).not.toHaveBeenCalled();
  });

  it("retries healthcheck and succeeds after some failures", async () => {
    const mockServer = createMockNetServer();
    createServerMock.mockReturnValue(mockServer);

    mockServer.listen.mockImplementation(() => {
      setImmediate(() => {
        mockServer.emit("listening");
      });
      return mockServer;
    });

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void, _ms?: number) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof global.setTimeout;

    try {
      const healthCheckMock = jest
        .fn<StackAdapter["healthCheck"]>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const adapter = createMockAdapter({ healthCheck: healthCheckMock });

      await startPreviewStack(createMockConfig(), adapter);

      expect(adapter.startPreview).toHaveBeenCalledTimes(1);
      expect(adapter.healthCheck).toHaveBeenCalledTimes(3);
      expect(adapter.stopPreview).not.toHaveBeenCalled();
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  it("calls stopPreview and throws after healthcheck times out", async () => {
    const mockServer = createMockNetServer();
    createServerMock.mockReturnValue(mockServer);

    mockServer.listen.mockImplementation(() => {
      setImmediate(() => {
        mockServer.emit("listening");
      });
      return mockServer;
    });

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void, _ms?: number) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof global.setTimeout;

    try {
      const healthCheckMock = jest.fn<StackAdapter["healthCheck"]>().mockResolvedValue(false);

      const adapter = createMockAdapter({ healthCheck: healthCheckMock });

      await expect(startPreviewStack(createMockConfig(), adapter)).rejects.toThrow(
        "Preview stack failed healthcheck",
      );

      expect(adapter.healthCheck).toHaveBeenCalledTimes(30);
      expect(adapter.stopPreview).toHaveBeenCalledTimes(1);
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  it("still throws healthcheck error even if stopPreview also fails", async () => {
    const mockServer = createMockNetServer();
    createServerMock.mockReturnValue(mockServer);

    mockServer.listen.mockImplementation(() => {
      setImmediate(() => {
        mockServer.emit("listening");
      });
      return mockServer;
    });

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void, _ms?: number) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof global.setTimeout;

    try {
      const adapter = createMockAdapter({
        healthCheck: jest.fn<StackAdapter["healthCheck"]>().mockResolvedValue(false),
        stopPreview: jest.fn<StackAdapter["stopPreview"]>().mockRejectedValue(new Error("stop failed")),
      });

      await expect(startPreviewStack(createMockConfig(), adapter)).rejects.toThrow(
        "Preview stack failed healthcheck",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  it("propagates error from adapter.startPreview", async () => {
    const mockServer = createMockNetServer();
    createServerMock.mockReturnValue(mockServer);

    mockServer.listen.mockImplementation(() => {
      setImmediate(() => {
        mockServer.emit("listening");
      });
      return mockServer;
    });

    const adapter = createMockAdapter({
      startPreview: jest
        .fn<StackAdapter["startPreview"]>()
        .mockRejectedValue(new Error("Docker daemon not running")),
    });

    await expect(startPreviewStack(createMockConfig(), adapter)).rejects.toThrow(
      "Docker daemon not running",
    );
  });
});

describe("stopPreviewStack", () => {
  it("calls adapter.stopPreview and succeeds", async () => {
    const adapter = createMockAdapter();
    await stopPreviewStack(adapter);

    expect(adapter.stopPreview).toHaveBeenCalledTimes(1);
  });

  it("propagates errors from adapter.stopPreview", async () => {
    const adapter = createMockAdapter({
      stopPreview: jest
        .fn<StackAdapter["stopPreview"]>()
        .mockRejectedValue(new Error("Failed to stop containers")),
    });

    await expect(stopPreviewStack(adapter)).rejects.toThrow("Failed to stop containers");
    expect(adapter.stopPreview).toHaveBeenCalledTimes(1);
  });

  it("propagates non-Error thrown from adapter.stopPreview", async () => {
    const adapter = createMockAdapter({
      stopPreview: jest.fn<StackAdapter["stopPreview"]>().mockRejectedValue("string error"),
    });

    await expect(stopPreviewStack(adapter)).rejects.toBe("string error");
  });
});
