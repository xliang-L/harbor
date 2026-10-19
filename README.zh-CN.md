<div align="center">

<img src="docs/images/cover.png" alt="Harbor — Local-first marketing workspace. From signals to action." width="100%" />

[English](README.md) · **简体中文**

### 把资料、内容与结果，收进同一个营销工作台。

Local-first marketing operations · Evidence in. Human decisions. Clear next steps.

[![CI](https://github.com/xliang-L/harbor/actions/workflows/ci.yml/badge.svg)](https://github.com/xliang-L/harbor/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-315B46?style=flat-square)](LICENSE.md) [![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.13-315B46?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-315B46?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[快速开始](#quick-start) · [产品预览](#preview) · [功能与边界](#capabilities) · [文档](#documentation) · [参与贡献](CONTRIBUTING.md)

</div>

Harbor 是一个开源、本地优先的营销工作台。它把来源资料、品牌事实、内容版本、渠道审批、人工交付和效果复盘连接起来，让独立营销负责人及小团队的运营者可以在一个工作区里推进一轮完整的营销工作。

默认使用明确标注的离线模板，也可接入兼容 OpenAI Chat Completions 的模型服务。业务数据保存在本机 SQLite；启用模型或来源采集后，相应资料会发送到你配置的服务或站点。

> **当前定位：本地单用户工作台。** 发布、邮件发送与广告投放由操作者在外部平台完成；Harbor 负责准备、审核、导出、记录与复盘。多品牌项目用于数据分区，不代表多人权限系统。

<a id="preview"></a>

## 产品预览

### 每天从清楚的下一步开始

待审内容、到期跟进、近期排期和事实问题集中呈现，点击即可进入对应记录。

![Harbor 今日工作台](docs/images/overview.png)

<table>
  <tr>
    <td width="50%"><strong>带依据的内容工作台</strong><br />编辑文案与分镜，审核具体版本，保留事实和来源快照。</td>
    <td width="50%"><strong>可追溯的活动交付</strong><br />关联商品、素材与多渠道计划，按实际审批状态检查交付缺口。</td>
  </tr>
  <tr>
    <td><a href="docs/images/studio.png"><img src="docs/images/studio.png" alt="文案、分镜与版本审批" /></a></td>
    <td><a href="docs/images/campaigns.png"><img src="docs/images/campaigns.png" alt="活动计划、渠道排期与交付检查" /></a></td>
  </tr>
</table>

<sub>截图来自隔离的合成 DEMO 工作区，所有品牌、来源和效果数值仅用于功能展示，不是客户资料或经营实绩。</sub>

## 一轮营销，六个环节

```mermaid
flowchart LR
    A[收集资料] --> B[确认事实]
    B --> C[生成与改稿]
    C --> D[审核具体版本]
    D --> E[人工交付与回执]
    E --> F[指标复盘]
    F --> A
```

| 环节             | Harbor 帮你完成的工作                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| **发现与整理**   | 导入证据，读取公开网页、RSS/Atom 和 GitHub Releases，保留原文、时间及变化快照。 |
| **确认可用事实** | 为品牌或具体商品确认逐字引用，设置有效期，提示属性潜在冲突，查看撤回影响。      |
| **创作与修订**   | 基于资料提出行动假设，生成文案与分镜，保存不可变版本，预览或渲染固定模板视频。  |
| **审批与交付**   | 检查品牌规范、内容版本及排期时点，导出带 UTM 的交付包，记录人工交付凭证。       |
| **衡量与复盘**   | 预览并导入指标，核对统计窗口，按活动、渠道、UTM 与币种查看观察值。              |
| **继续下一轮**   | 管理 B2B 线索、联系人、跟进任务，保留假设、来源和历史记录。                     |

## 为什么是 Harbor

**让内容的依据有边界。** 商品 A 的事实不会自动用于商品 B。事实到期、撤回或出现潜在冲突后，相关审批和导出会被阻止；续期保留旧记录，旧内容仍需明确复核。

**让批准落在具体版本上。** 审批绑定文案修订、品牌规范和渠道计划。改稿后重新审核，已发生的交付和历史审批仍然保留。回执明确标注为人工记录，不冒充平台核验。

**让数字可以解释。** 指标填写明确的统计起止时间。同窗同数值跳过，累计窗口重叠或数值变化提示冲突；缺窗口及错误记录保留，但不会悄悄进入汇总。修正通过带原因的撤销与重录完成。

**让失败有恢复入口。** 来源状态、任务失败与待办分开显示。保存失败保留输入，主要表单提供离开保护，内容编辑可检测其他窗口的新版本，模型失败不会伪装成成功结果。

<a id="quick-start"></a>

## 快速开始

需要 **Node.js 22.13 或更新版本**，推荐 Node.js 24 LTS。基础工作流不需要模型密钥、外部数据库或 Docker。

```bash
git clone https://github.com/xliang-L/harbor.git
cd harbor
npm ci
cp .env.example .env
npm run build
npm start
```

打开 **[http://127.0.0.1:4317](http://127.0.0.1:4317)**。Windows 可将复制命令替换为 `Copy-Item .env.example .env`；macOS 也可使用项目内的 `启动Harbor.command`。

默认 `MODEL_ENABLED=false`：先用模板走通工作流，再决定是否启用模型。应用只监听本机回环地址。

### 第一次使用

1. **建立品牌**：填写产品、受众与市场，在「活动与商品」设置目标和品牌规范。
2. **准备依据**：导入商品或证据，从原文确认适用范围明确的事实。
3. **创建内容**：生成行动假设，选择一条创建草稿，检查文案、分镜和引用。
4. **审核交付**：批准具体版本，建立渠道计划，导出交付包，人工发布后登记回执。
5. **记录结果**：填写统计窗口，预览指标，再决定下一轮实验。

详细步骤和文件格式见 [使用指南](docs/USER-GUIDE.md)。`fixtures/` 提供带 DEMO 标识的证据、商品、指标、联系人和订单样例，导入前请替换实际 ID。

### 可选：接入模型

在 `.env` 中配置你有权使用的 Chat Completions 兼容服务：

```dotenv
MODEL_ENABLED=true
MODEL_BASE_URL=https://your-provider.example/v1
MODEL_NAME=your-model-id
MODEL_API_KEY=your-api-key
```

重新启动后，生成请求会携带当前品牌与所选证据。凭据保留在服务端，不下发浏览器。远程端点须使用 HTTPS；本机服务可使用回环 HTTP。接口连接检查只证明服务可达，模型输出仍需人工核查。

### 可选：生成视频

HyperFrames 与 Remotion 均使用受信模板，当前输出为 **30 秒 · 640 × 360 · 24 fps · H.264 · 无音轨**。分镜描述不等于任意动画生成。

视频渲染还需要 Google Chrome、FFmpeg 和 ffprobe。macOS Apple Silicon 使用可选 npm 二进制；其他环境通过 `.env` 指定路径：

```dotenv
HYPERFRAMES_BROWSER_PATH=/path/to/chrome
HYPERFRAMES_FFMPEG_PATH=/path/to/ffmpeg
HYPERFRAMES_FFPROBE_PATH=/path/to/ffprobe
REMOTION_BROWSER_PATH=/path/to/chrome
```

<a id="capabilities"></a>

## 功能与集成状态

| 能力              | 当前提供                                                   | 接入边界                                                                   |
| ----------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| 公开资料          | 网页、RSS/Atom、GitHub Releases 只读适配器，周期检查与快照 | 受站点访问规则、网络与 API 限额影响；不绕过登录或反爬。                    |
| 内容与视频        | 模板 / 可配置模型、版本编辑、人工审批、双视频渲染器        | 模型与渲染服务由使用者配置；视频为固定模板。                               |
| 活动与渠道        | 商品、素材、活动、渠道文案、UTM、人工回执                  | LinkedIn、Instagram、X、搜索广告和邮件是本地草稿格式，没有自动发布或投放。 |
| 效果与归因        | 手工、CSV / JSON 导入，统计窗口校验，CTR / CPC / CPA       | 汇总观察值，不提供因果归因、MMM 或自动 ROAS 承诺。                         |
| GA4               | 官方 Data API 只读报表适配器                               | 需自行配置已授权凭据和 property；默认未连接。                              |
| Postiz            | 只读渠道与帖子状态适配器                                   | 需自行配置实例、密钥和渠道；不发布、不自动创建交付回执。                   |
| Shopify / HubSpot | 商品 CSV、联系人 JSON 的本地映射与导入                     | 文件导入，不是远程账户同步。                                               |
| B2B 与零售        | 线索跟进、未发送拓展稿、库存/销售退款导入、促销人工核销    | 没有邮件发送、POS 或支付执行能力。                                         |

各适配器的配置、验证边界和参考接口见 [平台矩阵](docs/PLATFORMS.md)。

## 数据与运行方式

```text
data/harbor.sqlite                     默认工作区
data/projects/<project>/harbor.sqlite  其他品牌工作区
artifacts/                            导出内容、视频与渲染日志
```

- 每品牌独立 SQLite，任务与记录持久化；每个品牌最多 3 个并行任务。
- 来源周期在本机服务运行时执行。电脑睡眠或服务退出时暂停；重启后，中断任务标记失败并可人工重试。
- 同源请求、写入幂等、版本与审批检查由服务端执行；公开抓取检查 DNS 与目标 IP，限制响应大小和超时。
- 当前面向本地单用户使用。多人认证、RBAC、公网部署和高可用尚未提供。
- 备份使用 SQLite backup API，或先停止服务再复制数据与产物目录。运行中只复制主数据库文件可能遗漏 WAL 中的数据。

`.env`、数据库、工作区资料和生成产物均由 `.gitignore` 排除。模型、来源采集与可选平台接口的外部请求由相应配置控制。

## 开发与验证

```bash
npm run dev           # Vite + Express 开发模式
npm run format        # 统一源码与文档格式
npm run format:check  # 检查格式
npm run lint
npm run typecheck
npm test              # 临时数据库 + 模拟外部服务
npm run build
npm run test:e2e      # 隔离数据 + 本机 Chrome
```

浏览器回归当前使用 macOS 的 Google Chrome 路径，端口为 `4319`；真实模型在测试配置中关闭。视频流程包含实际渲染与下载，运行时间较长。公开来源检查 `npm run test:public` 是单独的联网操作，不包含在默认测试中。

```text
src/app/             应用外壳、导航与编辑保护
src/features/        按品牌、内容、活动、CRM 等用途归类的界面
src/components/      跨功能共用的界面组件
src/shared/          前端类型、时间格式与品牌上下文
src/styles/          应用样式
server/routes/       API 路由与请求校验
server/domain/       业务规则与指标投影
server/connectors/   资料、文件及只读平台适配器
server/services/     内容生成服务
server/storage/      多品牌工作区与 SQLite
server/rendering/    视频预览、渲染进程与受信模板
scripts/             macOS 启动安装与显式验证工具
tests/server/        领域与 API 回归
tests/e2e/           浏览器业务流程回归
fixtures/            合成示例数据
docs/                使用指南、架构与产品截图
.github/             CI 与贡献协作模板
```

<a id="documentation"></a>

## 文档与参与

| 文档                               | 内容                                           |
| ---------------------------------- | ---------------------------------------------- |
| [使用指南](docs/USER-GUIDE.md)     | 第一轮工作流、事实复核、交付、指标与导入格式。 |
| [架构与设计](docs/ARCHITECTURE.md) | 模块边界、审批与安全规则、设计参考和依赖许可。 |
| [平台矩阵](docs/PLATFORMS.md)      | 已实现适配器、配置方法与尚未提供的能力。       |
| [路线图](docs/ROADMAP.md)          | 当前版本能力、已知限制与后续重点。             |
| [贡献指南](CONTRIBUTING.md)        | 环境、验证、问题反馈及 Pull Request 要求。     |
| [安全策略](SECURITY.md)            | 适用运行边界与漏洞反馈方式。                   |

欢迎提交可复现问题、文档改进和范围明确的 Pull Request。产品优先保证事实、版本、审批与统计的正确性，再扩展平台连接。请通过 [Issues](https://github.com/xliang-L/harbor/issues) 讨论需求。

## 许可

Harbor 自身的源码和文档采用 [MIT License](LICENSE.md)。依赖保留各自许可；尤其 [Remotion](https://www.remotion.dev/license)、[GSAP](https://gsap.com/standard-license/) 和 [FFmpeg](https://ffmpeg.org/legal.html) 有各自的使用与分发条件，本项目的 MIT 许可不替代这些条款。

<div align="center">
  <sub>从一条有依据的信息，到下一次有把握的行动。</sub>
</div>
