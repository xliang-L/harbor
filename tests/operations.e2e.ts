import { test, expect } from "@playwright/test";
test("operations UI: isolated brand, facts, channel approval, calendar download and metric preview", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("新项目标识").fill("e2e-operations");
  await page.getByRole("button", { name: "创建独立品牌项目" }).click();
  await expect(page).toHaveURL(/project=e2e-operations/);
  await page.locator("nav").getByRole("button", { name: "品牌档案" }).click();
  await page.getByLabel("品牌名称", { exact: true }).fill("Operations DEMO");
  await page.getByLabel("品牌网址", { exact: true }).fill("https://example.com");
  await page.getByLabel("产品名称").fill("DEMO bottle");
  await page.getByLabel("产品参数").fill("500 ml sample");
  await page.getByLabel("目标受众").fill("Demo audience");
  await page.getByRole("button", { name: "保存品牌档案" }).click();
  await page.getByRole("button", { name: "市场动态" }).click();
  await page.getByLabel("来源 URL").fill("https://example.com");
  await page.getByLabel("资料发布时间").fill("2026-01-01T12:00");
  await page.getByLabel("资料标题").fill("DEMO evidence");
  await page
    .getByLabel("公开原文")
    .fill("DEMO evidence: Operations DEMO provides public product documentation.");
  await page.getByLabel("这是测试").check();
  await page.getByRole("button", { name: "保存证据" }).click();
  await expect(page.getByRole("status")).toContainText("已导入");
  await page.getByRole("button", { name: "生成 3 条营销建议" }).click();
  await expect(page.getByRole("button", { name: "选择并生成内容" })).toHaveCount(3);
  await page.getByRole("button", { name: "选择并生成内容" }).first().click();
  await expect(page.getByLabel("可编辑文案")).toBeVisible();
  await page.getByRole("button", { name: "批准当前版本 V1" }).click();
  await page.getByRole("button", { name: "运营流程" }).click();
  await page.getByLabel("证据", { exact: true }).selectOption({ label: "[演示] DEMO evidence" });
  await page.getByLabel("逐字原文引用").fill("provides public product documentation");
  await page
    .getByLabel("确认的品牌事实")
    .fill("Operations DEMO provides public product documentation");
  await page.getByLabel("适用范围", { exact: true }).selectOption("brand");
  await page.getByLabel("确认人（自报）", { exact: true }).fill("Demo reviewer");
  await page.getByRole("button", { name: "保存确认事实" }).click();
  await expect(
    page.getByText("Operations DEMO provides public product documentation", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "渠道日历", exact: true }).click();
  await page.getByLabel("内容版本", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("输出渠道").selectOption("x");
  await page.getByLabel("目标账号").fill("demo-account");
  await page.getByLabel("Campaign 名称").fill("demo-campaign");
  await page.getByLabel("排期（").fill("2027-01-01T09:00");
  await page.getByRole("button", { name: "保存待审批排期" }).click();
  await page.getByRole("button", { name: "批准此渠道" }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载含 UTM" }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/^harbor-x-/);
  await page.reload();
  await page.getByRole("button", { name: "运营流程" }).click();
  await page.getByRole("button", { name: "渠道日历", exact: true }).click();
  await expect(page.getByText(/交付已批准/)).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/05-calendar.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "批量指标与复盘" }).click();
  await page
    .getByLabel("指标数据")
    .fill(
      "contentId,revisionId,url,date,impressions,clicks,conversions,spend,notes,currency,timezone\nbad,bad,https://example.com,2026-01-01,1,1,0,0,DEMO,USD,UTC",
    );
  await page.getByRole("button", { name: "校验预览" }).click();
  await expect(page.locator("pre")).toContainText("内容具体版本未曾批准");
  await expect(page.getByRole("button", { name: "确认导入有效新行" })).toHaveCount(0);
  await page.getByRole("button", { name: "连接器状态", exact: true }).click();
  await expect(page.getByText("模板模式：不会调用模型")).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/06-connectors.png",
    fullPage: true,
  });
  // The deliberately invalid metrics preview was not saved; discard it explicitly.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("品牌项目").selectOption("default");
  await expect(page).toHaveURL(/project=default/);
  await page.locator("nav").getByRole("button", { name: "品牌档案" }).click();
  await expect(page.getByLabel("品牌名称", { exact: true })).not.toHaveValue("Operations DEMO");
});
