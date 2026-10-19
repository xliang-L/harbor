# 架构与设计

Harbor 使用 React、TypeScript、Express 与 SQLite。它是面向本地单用户的模块化应用，不依赖外部数据库或 Agent 编排服务。

## 请求与存储

```mermaid
flowchart TB
    UI[React 工作台] --> API[Express API]
    API --> Rules[领域规则与审批检查]
    Rules --> Store[品牌工作区 / SQLite]
    API --> Queue[持久任务队列]
    Queue --> Sources[公开资料只读采集]
    Queue --> Model[可选模型服务]
    Queue --> Video[固定模板视频渲染]
```

`server/storage/workspaces.ts` 按品牌路由到独立 Store；默认库为 `data/harbor.sqlite`，其他库位于 `data/projects/<id>/harbor.sqlite`。品牌上下文必须一致，不能通过更换对象 ID 跨库读取或写入。

`server/storage/store.ts` 使用 SQLite 事务保存 JSON 状态。新领域字段以读取默认值兼容旧库；当前适合小规模本地数据，尚未实现分表、全文索引或大规模归档。

## 模块地图

| 位置                                            | 职责                                                       |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `src/main.tsx`                                  | 仅挂载 React 应用并加载样式。                              |
| `src/app/App.tsx`                               | 应用外壳、品牌切换、导航、请求状态及未保存编辑保护。       |
| `src/features/brand/`、`src/features/sources/`  | 品牌档案与市场资料。                                       |
| `src/features/content/`                         | 内容选择与版本编辑器。                                     |
| `src/features/analytics/`                       | 指标记录、质量状态与归因观察。                             |
| `src/features/campaigns/`                       | 规范、商品、素材、活动与交付检查。                         |
| `src/features/operations/`                      | 来源、事实、行动与渠道日历；事实编辑和交付回执独立成模块。 |
| `src/features/crm/`、`src/features/retail/`     | B2B 跟进与零售流程。                                       |
| `src/features/integrations/`                    | 文件与平台导入、订单及 Postiz 只读界面。                   |
| `src/features/workspace/`                       | 今日工作台与多品牌控制台。                                 |
| `src/components/`、`src/shared/`、`src/styles/` | 共用组件、前端类型、品牌请求上下文和样式。                 |
| `server/app.ts`、`server/index.ts`              | 应用组装与本机 HTTP 服务入口。                             |
| `server/routes/`                                | 请求校验、业务 API、审批、导出和只读集成入口。             |
| `server/domain/`                                | 事实、活动、指标、CRM、零售与复盘的业务规则。              |
| `server/connectors/`                            | 网页、订阅、文件、GA4 与 Postiz 适配器。                   |
| `server/services/`、`server/providers/`         | 内容生成与模型传输、结构校验、超时及服务端凭据。           |
| `server/storage/`                               | 多品牌工作区与 SQLite 存储。                               |
| `server/rendering/`                             | 受信模板预览、渲染进程、模板、产物验证与失败日志。         |
| `scripts/macos/`、`scripts/verify/`             | 本机启动安装及显式执行的来源、视频验证工具。               |
| `tests/server/`、`tests/e2e/`                   | 领域/API 与浏览器业务回归，按测试目的分开。                |

新增界面放到对应 `src/features/<用途>/`；只有跨功能复用的组件或前端辅助代码进入 `components/` 和 `shared/`。API、业务规则、外部适配器与存储分别放入既有后端目录，不将页面组件或渲染模板堆回应用入口。

根目录保留说明、许可证、必要工具配置与启动入口。测试截图、报告和视频进入被忽略的 `artifacts/`，业务导出与历史本地资料不进入源码仓库。

## 正确性约束

### 事实与版本

事实区分品牌通用和具体商品，保留来源、逐字引用、确认人、适用时间及撤回记录。结构化属性的不同值只标为潜在冲突，不做语义真伪判断或单位换算。

内容版本保存自己的品牌、证据和事实快照。审批与导出核对当前事实登记；模型等待期间事实失效，也会在保存前阻断。有效期采用含起始、不含截止规则，未来排期同时检查当前与计划时点。

普通改稿保留事实依赖。明确复核全文、分镜和新依据后，才能生成新版本脱离旧依赖。续期追加新事实，不覆盖旧记录或自动恢复旧审批。

### 审批与交付

审批在服务端绑定内容修订、规范及渠道计划。人工回执绑定具体版本、账号、渠道和实际交付时间，保存当时快照。撤销追加操作者、原因和时间，保留原始记录，不删除外部帖子。

### 指标质量

指标窗口、读取时点和报告元数据分别保存。相邻半开窗口可累计；同窗同值去重，包含、部分重叠或同窗数值变化均形成冲突。读取时间、时区标签和币种变化不能把同一流量变成独立样本。

历史缺窗口、损坏、冲突和撤销记录保留，但排除汇总。`metricQuality` 是复盘、归因和活动反馈共用的资格投影，不任意选取一条冲突数据，也不按天数拆分汇总值。

### 外部请求

模型输出作为 JSON 数据处理，不执行任意代码或来源内指令。请求有超时、体积和结构限制，凭据不发送到浏览器。逐字引用、事实引用及数字检查不能代替语义核实。

公开抓取检查 DNS 解析结果，固定目标 IP，拒绝私网及保留地址，不跟随跳转。API 写入有同源、幂等和版本检查；这些措施不构成多人身份认证。

## 测试与运行

`*.test.ts` 使用临时 SQLite 和模拟模型/平台；`*.e2e.ts` 使用隔离工作区与真实 Chrome。公开网络验证是单独命令，不包含在默认测试中。

每品牌最多 3 个并行任务。重启后，运行中断的任务标记失败供人工重试；来源订阅在服务运行时继续检查。没有系统级常驻服务、集群锁或高可用保证。

## 设计参考与第三方许可

参考的是职责和工作流，未复制以下项目源码：

- [Pomo](https://usepomo.ai/)：公开介绍中的信号、决策、人工审核与结果回流。
- [Postiz](https://github.com/gitroomhq/postiz-app)、[Frappe CRM](https://github.com/frappe/crm)：渠道计划、集中线索与跟进界面的产品组织方式，相关项目采用 AGPL-3.0。
- [Plausible](https://github.com/plausible/analytics)：导入窗口与明确冲突提示，AGPL-3.0；Harbor 不自动裁剪汇总窗口。
- [Luxon](https://github.com/moment/luxon)、[date-fns](https://github.com/date-fns/date-fns)：半开区间边界，MIT；Harbor 自行实现严格输入校验。
- [Payload](https://github.com/payloadcms/payload)、[OpenLineage](https://github.com/OpenLineage/OpenLineage)：版本快照与对象依赖，分别采用 MIT、Apache-2.0。

本项目源码的 MIT 许可不覆盖第三方组件。HyperFrames 为 Apache-2.0；Remotion 使用自己的许可，GSAP 使用 Standard License；FFmpeg 与 npm 预编译发行包有各自许可及分发条件。详见 [Remotion](https://www.remotion.dev/license)、[GSAP](https://gsap.com/standard-license/)、[FFmpeg](https://ffmpeg.org/legal.html) 及锁定发行包中的 LICENSE/NOTICE。仓库不分发 `node_modules` 或这些工具的二进制。
