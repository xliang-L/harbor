# 参与 Harbor

欢迎可复现的问题、文档修改，以及范围明确的功能或修复。

## 本地开发

使用 Node.js 22.13+，推荐 24 LTS：

```bash
npm ci
cp .env.example .env
npm run dev
```

保留 `MODEL_ENABLED=false`，即可使用离线模板。测试使用临时数据库和模拟服务；不要把个人工作区或真实凭据用于回归。

## 提交修改

1. 较大的产品变更先提交 Issue，说明实际问题、触发步骤和预期结果。
2. 界面按用途放入 `src/features/`；后端区分 `routes/`、`domain/`、`connectors/`、`services/`、`storage/` 与 `rendering/`。共用界面代码放入 `src/components/` 或 `src/shared/`。
3. 运行 `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm test` 和 `npm run build`。
4. 修改主流程时运行相关浏览器回归。当前 `npm run test:e2e` 使用 macOS Chrome 和端口 4319。
5. PR 说明问题、改变后的行为及实际验证结果；界面改动附不含个人资料的截图。

README 的英文版位于 `README.md`，简体中文版位于 `README.zh-CN.md`；修改功能说明、安装命令或运行边界时，请同步两种语言。

后端回归位于 `tests/server/`，浏览器回归位于 `tests/e2e/`。测试产物统一写入被忽略的 `artifacts/`；临时排查脚本使用系统临时目录。

纯文档修改核对链接、命令、图片与实际能力即可。请不要为凑覆盖率编写只重复实现逻辑的测试。

## 产品约束

- 事实适用范围、有效期与撤回会影响审批；普通改稿不能静默移除事实依赖。
- 审批和导出在服务端检查，变更绑定具体内容版本。
- 人工交付回执保留历史，不冒充平台核验。
- 指标窗口冲突不自动分摊，不覆盖历史数值；修正需要可追溯的撤销。
- 外部平台调用、凭据和写入必须有明确边界，不能把文件导入标成账户集成。
- 数据库、密钥、日志、客户资料与生成产物不提交到仓库。

提交贡献表示你有权提供这些内容，并同意以项目的 [MIT License](LICENSE.md) 发布你的贡献。第三方组件仍适用其原始许可。
