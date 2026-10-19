import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test("offline retail: mapped stock and order import, evidence draft, approval, redemption, return and void", async ({
  page,
  request,
}) => {
  const project = "retail-browser";
  const post = async (path: string, body: unknown) => {
    const r = await request.post("/api/" + path, {
      headers: {
        "X-Harbor-Project": project,
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: body,
    });
    expect(r.ok()).toBeTruthy();
    return r.json();
  };
  await post("projects", { id: project });
  await post("products/import", {
    format: "csv",
    text: readFileSync("fixtures/products-demo.csv", "utf8"),
    sourceName: "DEMO catalog",
    sourceUrl: "https://example.com",
    currency: "USD",
    demo: true,
  });
  await page.goto("/?project=" + project + "&page=9");
  await page.getByLabel("门店代码", { exact: true }).fill("DEMO-SHOP");
  await page.getByLabel("门店名称", { exact: true }).fill("DEMO 门店");
  await page.getByLabel("区域（自定义标签）").fill("DEMO 北区");
  await page.getByRole("button", { name: "保存新门店" }).click();
  await expect(page.getByText("DEMO 门店 · DEMO-SHOP · DEMO 北区 ·")).toBeVisible();
  const date = new Date(Date.now() - 3600000).toISOString();
  await page
    .getByLabel("零售CSV内容")
    .fill(`store,product,time,stock\nDEMO-SHOP,DEMO-BOTTLE,${date},40`);
  await page.getByText("零售字段映射", { exact: true }).click();
  for (const [key, value] of Object.entries({
    storeId: "store",
    sku: "product",
    asOf: "time",
    quantity: "stock",
  }))
    await page
      .locator(".retail details")
      .filter({ hasText: "零售字段映射" })
      .getByLabel(key, { exact: true })
      .fill(value);
  await page.getByLabel("演示数据（与真实数据分组）").check();
  await page.getByRole("button", { name: "预览零售导入" }).click();
  await expect(page.getByText("预览新增 1 条，重复 0 条；尚未写入。")).toBeVisible();
  await page.getByRole("button", { name: "确认零售导入" }).click();
  await expect(page.getByText("缺少销量证据，请先补充流水")).toBeVisible();
  await page.getByRole("button", { name: "平台导入", exact: false }).click();
  const orders = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "订单与退款 CSV 导入" }),
  });
  await orders.getByRole("button", { name: "载入销售与退货样例（未保存）" }).click();
  await orders.getByRole("button", { name: "预检订单（不保存）" }).click();
  await expect(orders.getByText("预检通过：新增 2，重复 0；当前尚未保存。")).toBeVisible();
  const stateBefore = await request.get("/api/state?project=" + project).then((r) => r.json());
  expect(stateBefore.retail.sales).toHaveLength(0);
  await orders.getByRole("button", { name: "确认导入订单" }).click();
  await expect(orders.getByText(/新增 2 个事件/)).toBeVisible();
  await orders.getByRole("button", { name: "预检订单（不保存）" }).click();
  await expect(orders.getByText("预检通过：新增 0，重复 2；当前尚未保存。")).toBeVisible();
  await page.getByRole("button", { name: "门店与促销", exact: false }).click();
  await page.getByRole("button", { name: "生成待审核促销草稿" }).click();
  await page.getByRole("button", { name: "多品牌控制台" }).click();
  await page.getByLabel("队列品牌").selectOption(project);
  await expect(page.getByText("当前筛选 1 项待审核")).toBeVisible();
  await page.getByRole("link", { name: "打开此品牌门店促销审批页面" }).click();
  await expect(page).toHaveURL(/project=retail-browser&page=9/);
  let card = page
    .locator(".retail > article.card")
    .filter({ has: page.getByRole("heading", { name: /小范围促销草稿/ }) });
  await expect(card.getByText(/待审核 \/ 已失效/)).toBeVisible();
  await card.getByLabel("促销标题", { exact: true }).fill("DEMO 本店促销");
  await card.getByLabel("促销文案", { exact: true }).fill("本地测试促销，条款以已审核导出为准。");
  await card
    .getByLabel("开始时间（UTC）")
    .fill(new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 16));
  await card.getByRole("button", { name: "保存促销修订并刷新依据" }).click();
  card = page
    .locator(".retail > article.card")
    .filter({ has: page.getByRole("heading", { name: /DEMO 本店促销/ }) });
  await card.getByLabel("审核／记录人（自报）").fill("DEMO 审核员");
  await card.getByRole("button", { name: "批准已保存促销版本" }).click();
  await expect(card.getByText(/已审核具体版本/)).toBeVisible();
  const download = page.waitForEvent("download");
  await card.getByRole("link", { name: "导出已审核促销包" }).click();
  expect((await download).suggestedFilename()).toMatch(/^harbor-promotion-LOCAL-/);
  await card.getByLabel("审核／记录人（自报）").fill("DEMO 审核员");
  await card.getByText("记录人工核销", { exact: true }).click();
  await card.getByLabel("实际销售行").selectOption({ index: 1 });
  await card.getByLabel("核销凭证编号").fill("DEMO-RECEIPT-1");
  await card.getByRole("button", { name: "保存核销记录" }).click();
  await expect(page.getByText(/有效核销记录 1，撤销 0/)).toBeVisible();
  await expect(page.getByText(/净件数 1、净商品金额 20.00 USD/)).toBeVisible();
  await page.screenshot({
    path: "/tmp/harbor-retail-browser.png",
    fullPage: true,
  });
  await card.getByLabel("撤销原因").fill("DEMO 录入纠错");
  await card.getByRole("button", { name: "撤销此核销（保留审计）" }).click();
  await expect(page.getByText(/有效核销记录 0，撤销 1/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/有效核销记录 0，撤销 1/)).toBeVisible();
  const state = await request.get("/api/state?project=" + project).then((r) => r.json());
  expect(state.retail.sales).toHaveLength(2);
  expect(state.metrics).toHaveLength(0);
  await page.getByLabel("品牌项目").selectOption("default");
  await page.getByRole("button", { name: "门店与促销", exact: false }).click();
  await expect(page.getByText(/有效核销记录/)).toHaveCount(0);
  await expect(page.getByText("尚无库存快照，无法产生促销建议。")).toBeVisible();
});
