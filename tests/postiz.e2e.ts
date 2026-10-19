import { test, expect } from "@playwright/test";

test("Postiz UI distinguishes unconfigured access, reported status and manual delivery without rendering upstream markup", async ({
  page,
}) => {
  await page.goto("/?page=8");
  await expect(page.getByText(/当前品牌尚未配置 Postiz/)).toBeVisible();
  await expect(page.getByRole("button", { name: "查询 Postiz 状态" })).toHaveCount(0);
  await page.route("**/api/postiz/status?*", (route) =>
    route.fulfill({
      json: {
        configured: true,
        integrationId: "mock-account",
        mode: "read-only",
        note: "TEST FIXTURE",
      },
    }),
  );
  await page.route("**/api/postiz/check?*", (route) =>
    route.fulfill({
      json: {
        posts: [
          {
            id: "mock-post",
            content: "<script>throw new Error('untrusted')</script> DEMO",
            publishDate: "2026-10-18T00:00:00Z",
            state: "PUBLISHED",
            releaseURL: "https://example.com/post",
            integration: { id: "mock-account", providerIdentifier: "x", name: "DEMO account" },
          },
        ],
        integration: { id: "mock-account", name: "DEMO account", identifier: "x", disabled: false },
        checkedAt: new Date().toISOString(),
        note: "TEST FIXTURE · 只读状态，不自动生成交付回执",
      },
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  await page.getByLabel("Postiz 开始日期（UTC）").fill("2026-10-01");
  await page.getByLabel("Postiz 结束日期（UTC）").fill("2026-10-18");
  await page.getByRole("button", { name: "查询 Postiz 状态" }).click();
  await expect(page.getByText("Postiz 报告已发布", { exact: true })).toBeVisible();
  await page.getByText("核对 Postiz 文案与当前内容").click();
  await expect(page.locator("pre").filter({ hasText: "<script>throw" })).toBeVisible();
  expect(errors).toEqual([]);
  await expect(page.getByRole("link", { name: "打开 Postiz 提供的发布链接" })).toHaveAttribute(
    "href",
    "https://example.com/post",
  );
  await page.getByLabel("Postiz 开始日期（UTC）").fill("2026-08-01");
  await expect(page.getByRole("button", { name: "查询 Postiz 状态" })).toBeDisabled();
});
