import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.e2e.ts",
  outputDir: "artifacts/test-results",
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: "http://127.0.0.1:4319",
    headless: true,
    launchOptions: {
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    viewport: { width: 1440, height: 1100 },
  },
  webServer: {
    command: `MODEL_ENABLED=false PORT=4319 DATA_DIR=${mkdtempSync(join(tmpdir(), "harbor-e2e-"))} npm start`,
    url: "http://127.0.0.1:4319",
    reuseExistingServer: false,
  },
  reporter: [["list"], ["html", { open: "never", outputFolder: "artifacts/playwright-report" }]],
});
