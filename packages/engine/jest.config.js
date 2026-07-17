/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "CommonJS",
          moduleResolution: "node",
          esModuleInterop: true,
          resolveJsonModule: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverageFrom: ["src/core/**/*.ts", "src/cli/index.ts"],
  coverageDirectory: "coverage",
  coverageThreshold: {
    global: {
      statements: 75,
      branches: 55,
      functions: 80,
      lines: 78,
    },
  },
};
