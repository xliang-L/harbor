import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
test("new user imports product, creates a two-channel campaign, reviews assets and recovers from stale approval", async ({
  page,
}) => {
  mkdirSync("artifacts/screenshots", { recursive: true });
  await page.goto("/");
  await page.getByLabel("新项目标识").fill("campaign-v3-e2e");
  await page.getByRole("button", { name: "创建独立品牌项目" }).click();
  await expect(page).toHaveURL(/project=campaign-v3-e2e/);
  await expect(page.getByRole("heading", { name: "下一步，完成你的营销工作区" })).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "品牌档案" }).click();
  await page.getByLabel("品牌名称", { exact: true }).fill("Harbor V3 DEMO");
  await page.getByLabel("品牌网址", { exact: true }).fill("https://example.com");
  await page.getByLabel("产品名称").fill("Demo product");
  await page.getByLabel("产品参数").fill("Demonstration only");
  await page.getByLabel("目标受众").fill("Demo shoppers");
  await page.getByRole("button", { name: "保存品牌档案" }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await page.getByRole("button", { name: /设置目标与品牌规范/ }).click();
  await page.getByLabel("营销目标", { exact: true }).fill("Test product information clarity");
  await page.getByLabel("品牌语气").fill("Calm, factual");
  await page.getByLabel("品牌定位与价值主张").fill("Help shoppers review clear product facts");
  await page.getByLabel("禁用表述").fill("miracle cure");
  await page.getByRole("button", { name: "保存目标与品牌规范" }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await page.getByRole("button", { name: "商品导入", exact: true }).click();
  await page.getByLabel("选择商品文件").setInputFiles("fixtures/products-demo.csv");
  await page.getByLabel("这是演示商品").check();
  await page.getByRole("button", { name: "预览商品导入" }).click();
  await expect(page.getByText(/DEMO-BOTTLE · Demo Bottle/)).toBeVisible();
  await page.getByRole("button", { name: "确认导入商品" }).click();
  await expect(
    page.getByRole("heading", { name: "[演示] Demo Bottle", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "用于当前品牌内容生成" }).click();
  await page.getByRole("button", { name: "市场动态", exact: false }).click();
  await page.getByRole("button", { name: "生成 3 条营销建议" }).click();
  await expect(page.getByRole("button", { name: "选择并生成内容" })).toHaveCount(3);
  await page.getByRole("button", { name: "选择并生成内容" }).first().click();
  await expect(page.getByLabel("可编辑文案")).toBeVisible();
  await page.getByRole("button", { name: "批准当前版本 V1" }).click();
  await page.getByRole("button", { name: "活动与商品", exact: false }).click();
  await page.getByRole("button", { name: "素材库", exact: true }).click();
  await page.getByLabel("图片文件", { exact: true }).setInputFiles("fixtures/demo-product.png");
  await page.getByLabel("图片描述").fill("Self-made sample product image");
  await page.getByLabel("来源与使用权说明").fill("Self-made demo fixture, not customer asset");
  await page.getByLabel("演示素材", { exact: true }).check();
  await page.getByRole("button", { name: "保存素材", exact: true }).click();
  await expect(page.getByRole("heading", { name: "[演示] demo-product.png" })).toBeVisible();
  await page.getByRole("button", { name: "活动计划", exact: true }).click();
  await page.getByLabel("活动名称", { exact: true }).fill("DEMO launch campaign");
  await page.getByLabel("目标受众", { exact: true }).fill("Demo shoppers");
  await page
    .getByLabel("活动目标与推荐理由")
    .fill("Test a factual message on two channels without publishing");
  await page.getByLabel("活动开始日期").fill("2026-01-01");
  await page.getByLabel("活动结束日期").fill("2027-12-31");
  await page.getByLabel("X 标准帖子", { exact: true }).check();
  await page
    .getByRole("group", { name: "关联内容（先在内容工作台生成）" })
    .getByRole("checkbox")
    .first()
    .check();
  await page.getByLabel("商品：Demo Bottle", { exact: true }).check();
  await page.getByLabel("图片：demo-product.png", { exact: true }).check();
  await page.getByRole("button", { name: "创建活动计划", exact: true }).click();
  await expect(page.getByText("linkedin 缺少渠道交付计划")).toBeVisible();
  await page.getByLabel("活动内容", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("交付账号", { exact: true }).fill("demo-only-account");
  await page.getByLabel("交付时间", { exact: true }).fill("2026-10-15T12:00");
  await page.getByRole("button", { name: "保存活动渠道版本", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准此渠道版本", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "批准此渠道版本", exact: true }).click();
  await page.getByLabel("活动渠道", { exact: false }).selectOption("x");
  await page
    .getByLabel("渠道版本文案")
    .fill("Meet our DEMO bottle. Review product facts at https://example.com");
  await page.getByRole("button", { name: "保存活动渠道版本", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准此渠道版本", exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "批准此渠道版本", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "批准活动交付", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "批准活动交付", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载活动交付包" }).click();
  await (await download).saveAs("artifacts/e2e-campaign-v3.json");
  await page.screenshot({
    path: "artifacts/screenshots/v3-campaign-approved.png",
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "活动与商品" }).click();
  await page.getByRole("button", { name: "活动计划", exact: true }).click();
  await expect(page.getByText("当前交付已批准", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "目标与规范", exact: true }).click();
  await page.getByLabel("品牌语气").fill("Friendly but factual");
  await page.getByRole("button", { name: "保存目标与品牌规范" }).click();
  await page.getByRole("button", { name: "活动计划", exact: true }).click();
  await expect(page.getByRole("link", { name: "下载活动交付包" })).toHaveCount(0);
  await expect(page.getByText("审批已失效，关联资料发生变化", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "内容工作台" }).click();
  await expect(page.getByRole("button", { name: "批准当前版本 V1" })).toBeEnabled();
  await page.getByRole("button", { name: "批准当前版本 V1" }).click();
  await page.getByRole("button", { name: "活动与商品" }).click();
  await page.getByRole("button", { name: "活动计划", exact: true }).click();
  for (const b of await page.getByRole("button", { name: "批准此渠道版本", exact: true }).all())
    await b.click();
  await page.getByRole("button", { name: "批准活动交付", exact: true }).click();
  await expect(page.getByRole("link", { name: "下载活动交付包" })).toBeVisible();
  await page.getByRole("button", { name: "归档此排期（可恢复）", exact: true }).first().click();
  await expect(page.getByRole("link", { name: "下载活动交付包" })).toHaveCount(0);
  await page.getByRole("button", { name: "恢复排期", exact: true }).click();
  await expect(page.getByRole("link", { name: "下载活动交付包" })).toBeVisible();
  await page.getByRole("button", { name: "连接检查", exact: true }).click();
  await expect(page.getByText("连接前检查：未执行外部请求", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/v3-connection-preflight.png",
    fullPage: true,
  });
});
