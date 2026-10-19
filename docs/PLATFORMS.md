# 平台与集成

本页区分本地功能、只读适配器和真实平台执行能力。默认配置不连接模型或账户；使用者自行提供有权使用的服务及凭据。

| 能力                     | 已实现                                                    | 验证与限制                                                                      |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 网页                     | 公开 HTML/文本读取、原文存档、去重和定期检查              | 有模拟测试和历史公开来源验证；站点与网络变化可能导致失败，不绕过登录或反爬。    |
| RSS/Atom                 | 安全 XML 解析、最多 50 条、来源与变化快照                 | 不继续抓取每条全文；拒绝 DTD/ENTITY 和私网地址。                                |
| GitHub Releases          | 公开 REST 只读适配器、最多 20 条                          | 受匿名限额影响，不能保证每个出口可用。                                          |
| 模型                     | Chat Completions 兼容接口、结构化输出、引用/事实/数字检查 | 默认模板模式；有模拟契约测试，真实输出由所选服务决定，需人工审核。              |
| GA4                      | 固定官方 Data API `runReport`                             | 只读适配器，有模拟测试；需配置 property 及授权令牌，没有内置 OAuth 或令牌续期。 |
| Postiz                   | 按品牌配置查询账号归属和帖子状态                          | 只读 HTTP 契约经过模拟测试，真实实例由使用者配置；不发布、不改帖、不删帖。      |
| LinkedIn / Instagram / X | 本地文案规则、账号标签、审批与 UTM 交付包                 | 没有直接账户连接，最终平台字数及格式以实际 UI/API 为准。                        |
| 搜索广告 / 邮件          | 本地草稿规则与人工导出                                    | 不是广告上传器；没有预算、投放、Gmail/Outlook 发送。                            |
| HyperFrames / Remotion   | 固定模板预览及本机 MP4                                    | 30 秒、640×360、24 fps、H.264、无音轨；需要 Chrome、FFmpeg/ffprobe。            |
| Shopify                  | 商品导出 CSV 的本地解析与变体字段继承                     | 不读取账户、订单或客户；不自动下载远程图片。                                    |
| HubSpot                  | 用户提交联系人 JSON、字段映射、预览与整批导入             | 不连接 HubSpot，不提供自动同步、邮件或 webhook。                                |
| 库存 / 销售退款          | 标准文件导入、退款边界、促销审批及人工核销                | 没有 POS、地图、支付或库存扣减执行。                                            |

## 模型配置

在 `.env` 中设置 `MODEL_ENABLED`、`MODEL_BASE_URL`、`MODEL_NAME` 和 `MODEL_API_KEY`。端点须兼容 Chat Completions；远程使用 HTTPS，本机可用回环 HTTP。

启用后会发送相关品牌与证据文本。模型检查页可读取模型列表，但“可达”和“列出模型”不等于真实生成质量或额度可用。模型调用失败不自动付费重试，不伪装为模板成功。

## GA4 只读报表

配置 `GA4_PROPERTY_ID` 与 `GA4_ACCESS_TOKEN`。令牌需要 `analytics.readonly` 和相应 property 访问权。Harbor 不创建或续期令牌；过期、无权限及接口失败会显示错误。

返回的 sessions、users、keyEvents 和 campaign/source 不等于广告曝光/点击，不会自动映射成内容效果指标。接口依据：[GA4 Data API](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart)。

## Postiz 只读接入

默认品牌显式配置：

```dotenv
POSTIZ_BASE_URL=https://api.postiz.com/public/v1
POSTIZ_API_KEY=your-api-key
POSTIZ_INTEGRATION_ID=your-channel-id
```

自建实例按其部署路径设置 API 根地址，例如 `http://127.0.0.1:4007/api/public/v1`。远程实例须为 HTTPS 和公开地址。

其他品牌使用独立前缀：`brand-demo` 对应 `POSTIZ_BRAND_DEMO_*`，不会回退使用默认品牌的密钥或账号。先查询账号列表验证所选渠道归属，再读取最多 31 天的帖子状态。

请求限制为 10 秒、2 MB、500 条，不跟随跳转；密钥仅服务端使用。上游密钥可能有写权限，当前只读边界由 Harbor 适配器实施。`PUBLISHED` 是 Postiz 报告的状态，计划时间不冒充实际交付时间，也不会自动生成 Harbor 回执。

接口依据：[账号列表](https://docs.postiz.com/public-api/integrations/list)、[帖子列表](https://docs.postiz.com/public-api/posts/list)。Postiz 本体采用 [AGPL-3.0](https://github.com/gitroomhq/postiz-app/blob/main/LICENSE)，Harbor 使用独立 HTTP 适配器，不包含 Postiz 服务或 SDK。

## 后续候选

Akeneo 可用于商品主数据，Mautic 可用于邮件与营销自动化；当前均没有 Harbor 适配器。新增连接应先明确账户、权限、撤销、同步去重和状态回流，再实现外部执行能力。平台的产品宣称不等于 Harbor 已集成。
