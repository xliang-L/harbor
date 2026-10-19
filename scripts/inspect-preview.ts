import { chromium } from "@playwright/test";
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
page.on("console", (e) => {
  if (e.type() === "error") console.log("CONSOLE", e.text());
});
await page.goto("http://127.0.0.1:4318");
await page.getByRole("button", { name: "内容工作台" }).click();
await page.frameLocator("iframe").locator("h1").first().waitFor();
await page.waitForTimeout(1200);
console.log(
  await page.locator("iframe").evaluate((e) => ({
    transform: getComputedStyle(e).transform,
    width: e.getBoundingClientRect().width,
  })),
);
console.log(
  await page.frames()[1].evaluate(() => ({
    body: document.body.innerText,
    style: getComputedStyle(document.querySelector("h1")!).opacity,
  })),
);
await page.screenshot({ path: "artifacts/screenshots/preview-check.png" });
await browser.close();
