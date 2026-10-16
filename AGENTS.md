# dsh-service-manager

Independent DeepSeek Harness / Cordis plugin. Host code is in src/, browser code
in src/client/, generated installable bundles in lib/. Keep @deepseek-ai/* and
React external. Rebuild lib/ after source changes.

Commands: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:metadata`.

## Hard constraints

No model-facing tools. Discovery is automatic and stopping is a user action in
the settings section; the Remote methods (`listServices` / `listCandidates` /
`registerService` / `stopServices` / `removeServices`) are the whole management
surface, and the former `service_register` / `service_list` / `service_stop`
tools stay removed. `src/tools.ts` is gone — do not reintroduce a
`ctx.inject(['tools'], …)` registration.

Services are stopped ONLY by an explicit stop call. Never add exit hooks,
scope disposal, background cleanup, restart policies, or shutdown signals.
Removing a record must never stop its resource. Persist identities, not live status.
Check process creation identity and the full container ID before any stop.
Never overwrite malformed registry files. Use atomic replacement and a file lock.
All browser copy belongs in the English and Chinese dictionaries.

## 详细规则

明细放 `.claude/rules/`，按 `paths:` 路径作用域加载：每个文件都带非空 `paths:`（项目根相对、正斜杠的 picomatch glob），只有 `read` 读到命中这些 glob 的文件后，才在**下一次请求**折入上下文，每条规则每会话至多一次；**没有 `paths:`（或为空）的规则会像 `CLAUDE.md` 一样每次会话都注入**，所以明细一律必须带 `paths:`。按需读取，不要把 `.claude/rules/` 当成默认上下文。

- [.claude/rules/host-mechanisms.md](.claude/rules/host-mechanisms.md)：归属判定（`DSH_SERVICE_OWNER` / `hostDescendants`）、`src/windows-native.ts` 读取器、定时对账与注册表 schema；改发现、归属或停止判定时读。
- [.claude/rules/browser-section.md](.claude/rules/browser-section.md)：`ServiceSection` 的设置页几何、文案与失败反馈、状态渲染；改 `src/client/` 或浏览器测试替身时读。
- [.claude/rules/testing.md](.claude/rules/testing.md)：构建/测试命令与必须覆盖的回归清单；加测试、改测试或准备验证时读。
