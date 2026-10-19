import { test, expect } from "@playwright/test";
test("B2B browser flow: CSV preview, lead, followup, log, draft, isolation and HubSpot import", async ({
  page,
}) => {
  await page.goto("/?page=6");
  await page.getByLabel("新项目标识").fill("crm-browser");
  await page.getByRole("button", { name: "创建独立品牌项目" }).click();
  await expect(page).toHaveURL(/project=crm-browser/);
  await page.getByRole("button", { name: "B2B 线索" }).click();
  await page.getByText("CSV 导入／导出与演示样例").click();
  await page.getByRole("button", { name: "预览线索导入" }).click();
  await expect(page.getByText("预览：新增 1，重复 0。尚未写入。")).toBeVisible();
  await page.getByRole("button", { name: "确认导入线索" }).click();
  await page.getByRole("button", { name: "DEMO 示例公司 / 示例联系人" }).click();
  await page.getByText("安排下一步跟进").click();
  await page.getByLabel("任务", { exact: true }).fill("核实预算");
  await page.getByLabel("执行人", { exact: true }).fill("测试负责人");
  await page.getByLabel("到期时间", { exact: true }).fill("2026-01-01T12:00");
  await page.getByRole("button", { name: "创建跟进任务" }).click();
  await expect(page.getByRole("heading", { name: "到期提醒队列 · 1" })).toBeVisible();
  await page.getByLabel("记录人", { exact: true }).fill("测试记录人");
  await page.getByLabel("联系结果与下一步").fill("本地演示联系记录，未发送任何邮件");
  await page.getByRole("button", { name: "保存联系记录／备注" }).click();
  await expect(page.getByText(/测试记录人：本地演示联系记录/)).toBeVisible();
  await page.getByRole("button", { name: "生成未发送拓展草稿" }).click();
  await expect(page.getByLabel("未发送拓展草稿")).toContainText("尚未发送");
  await page.getByRole("button", { name: "完成任务" }).first().click();
  await expect(page.getByRole("heading", { name: "到期提醒队列 · 0" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出本品牌线索 CSV" }).click();
  expect((await download).suggestedFilename()).toBe("harbor-leads.csv");
  await page.screenshot({ path: "/tmp/harbor-crm-browser.png", fullPage: true });
  await page.getByRole("button", { name: "平台导入", exact: false }).click();
  await expect(page.getByText(/HubSpot：未连接/)).toBeVisible();
  await page.getByRole("button", { name: "载入演示 JSON（尚未导入）" }).click();
  await page.getByRole("button", { name: "预检（不保存）" }).click();
  await expect(page.getByText(/可新增 2 条/)).toBeVisible();
  await page.getByRole("button", { name: "确认导入当前品牌" }).click();
  await expect(page.getByText(/已导入 2 条，重复 0 条/)).toBeVisible();
  await page.getByRole("button", { name: "B2B 线索" }).click();
  await expect(page.getByRole("button", { name: "DEMO Harbor Retail / Demo Buyer" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "B2B 线索" }).click();
  await expect(page.getByRole("button", { name: "DEMO 示例公司 / 示例联系人" })).toBeVisible();
  await page.getByLabel("品牌项目").selectOption("default");
  await page.getByRole("button", { name: "B2B 线索" }).click();
  await expect(page.getByRole("button", { name: "DEMO 示例公司 / 示例联系人" })).toHaveCount(0);
  await page.getByRole("button", { name: "多品牌控制台" }).click();
  await expect(page.getByText(/本地自报姓名/).first()).toBeVisible();
  await page.getByLabel("队列品牌").selectOption("crm-browser");
  await expect(page.getByText("当前筛选 0 项待审核")).toBeVisible();
});
test("console browser assigns and comments on the explicitly selected brand", async ({
  page,
  request,
}) => {
  const project = "console-browser";
  const post = async (path: string, body: unknown) => {
    const r = await request.post("/api/" + path, {
      headers: { "Idempotency-Key": crypto.randomUUID(), "X-Harbor-Project": project },
      data: body,
    });
    expect(r.ok()).toBeTruthy();
    return r.json();
  };
  await post("projects", { id: project });
  await post("brand", {
    name: "CONSOLE DEMO",
    url: "https://example.com",
    product: "Demo",
    parameters: "Test only",
    audience: "Test",
    market: "US",
    competitors: [],
    image: "",
  });
  await post("evidence", {
    title: "DEMO evidence",
    url: "https://example.com",
    publishedAt: "2026-01-01",
    text: "Demonstration source text for local browser approval testing.",
    demo: true,
  });
  const state = async () => request.get("/api/state?project=" + project).then((r) => r.json());
  await post("tasks", { kind: "suggest" });
  await expect.poll(async () => (await state()).suggestions.length).toBeGreaterThan(0);
  await post("tasks", {
    kind: "content",
    payload: { suggestionId: (await state()).suggestions[0].id },
  });
  await expect.poll(async () => (await state()).contents.length).toBe(1);
  await page.goto("/?page=7");
  await page.getByLabel("队列品牌").selectOption(project);
  await expect(page.getByText("当前筛选 1 项待审核")).toBeVisible();
  await page.getByLabel("操作人（自报）").fill("演示审核员");
  await page.getByLabel("负责人（自报）").fill("演示负责人");
  await page.getByLabel("分配优先级").selectOption("high");
  await page.getByLabel("评论", { exact: true }).fill("请核对来源后审批");
  await page.getByRole("button", { name: "保存分配 / 评论" }).click();
  await expect(page.getByText(/负责人：演示负责人/)).toBeVisible();
  await page.getByLabel("队列优先级").selectOption("high");
  await expect(page.getByText("当前筛选 1 项待审核")).toBeVisible();
  await page.screenshot({ path: "/tmp/harbor-console-browser.png", fullPage: true });
  await page.getByRole("link", { name: "打开此品牌内容审批页面" }).click();
  await expect(page).toHaveURL(/project=console-browser&page=2/);
  await expect(page.getByRole("button", { name: "批准当前版本 V1" })).toBeVisible();
  await page.getByRole("button", { name: "批准当前版本 V1" }).click();
  await page.getByRole("button", { name: "多品牌控制台" }).click();
  await page.getByLabel("队列品牌").selectOption(project);
  await expect(page.getByText("当前筛选 0 项待审核")).toBeVisible();
  await page.getByText("最近协作事件（最多 100 条；按品牌筛选）").click();
  await expect(page.getByText(/审批通过/)).toBeVisible();
});
