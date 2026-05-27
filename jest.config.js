module.exports = {
  testEnvironment: "jsdom",
  roots: ["<rootDir>/tests"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "lcov"],
  collectCoverageFrom: [
    "db.js",
    "background.js",
    "content.js",
    "popup.js",
    "sidepanel.js",
    "offscreen.js",
    "sandbox.js",
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  // Each test file manages its own setup
  setupFiles: ["<rootDir>/tests/setup.js"],
};
