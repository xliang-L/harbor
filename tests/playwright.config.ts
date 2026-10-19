import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "@playwright/test";
const root = resolve(import.meta.dirname, "..");
export default defineConfig({
  testDir: resolve(root, "tests/e2e"),
  testMatch: "*.e2e.ts",
  outputDir: resolve(root, "artifacts/test-results"),
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
    cwd: root,
    command: `MODEL_ENABLED=false PORT=4319 DATA_DIR=${mkdtempSync(join(tmpdir(), "harbor-e2e-"))} npm start`,
    url: "http://127.0.0.1:4319",
    reuseExistingServer: false,
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: resolve(root, "artifacts/playwright-report") }],
  ],
});
