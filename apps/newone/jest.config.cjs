const expoPreset = require('jest-expo/jest-preset');

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  rootDir: __dirname,
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.[jt]s?(x)'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    ...expoPreset.transform,
    '^.+\\.mjs$': ['babel-jest', { presets: ['babel-preset-expo'] }],
  },
  clearMocks: true,
  restoreMocks: true,
  collectCoverage: true,
  collectCoverageFrom: [
    '<rootDir>/src/**/*.{ts,tsx}',
    '!<rootDir>/src/**/*.d.ts',
    '!<rootDir>/src/**/*.d.tsx',
    '!<rootDir>/src/data/database.types.ts',
  ],
  coverageDirectory: '<rootDir>/.expo/coverage',
  coverageProvider: 'babel',
  coverageReporters: ['json', 'json-summary', 'lcov', 'text'],
  coverageThreshold: {
    global: {
      statements: 91,
      branches: 91,
      functions: 91,
      lines: 91,
    },
  },
};
