---
description: "@guowenzhang/dsh-service-manager 的行为验证记录：每次验证的环境绑定、产物哈希、逐项读数与未覆盖项。"
kind: "package-reference"
---

# 行为验证记录

本页回答一个问题：**每个结论各自被什么证据支持、怎么复现。**
**没跑过的结论不写成本页的结论**；失败、未覆盖与受阻项如实保留。
读数必须绑定产物哈希：重建 `lib/` 之后旧读数不再是结论。

生成：`node tools/testing/record.mjs dsh-service-manager --title "<行为>" [--run <证据 json>] [--instance <test-instance.json>]`

## 1、发版 0.5.0：服务跨重启追踪、原生身份读取与 UI 规范收敛（2026-11-03，产物 `45D694EA` / `9E712573`）

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 日期 | 2026-11-03T22:21:07+08:00 |
| 插件 | @guowenzhang/dsh-service-manager@0.5.0（HEAD a77f556，工作树 2 项未提交） |
| 宿主 | （未绑定隔离实例；如为源码内验证请写明） |
| DSH_HOME | （未绑定） |
| 端口 / URL | （未绑定） |
| Node | v24.12.0 |
| lib/index.mjs | `45d694ea64d461bf03a43c76a8ed5f0fe7bf63c534abcd0b483da6d9306e4fd9`（57954 字节，2026-11-03T14:20:55.136Z） |
| lib/client.js | `9e712573d198bae91a6ac6058b0effbb8ac6cafe4cfa30f3b9aa07530690c7b1`（56628 字节，2026-11-03T14:20:55.232Z） |
| 证据文件 | `.scratch/test-system/runs/2026-11-03-222057-dsh-service-manager.json` |

### 车道结果

| 车道 | 状态 | 退出码 | 耗时 |
|---|---|---|---|
| typecheck | passed | 0 | 1.6s |
| build | passed | 0 | 0.9s |
| metadata | passed | 0 | 0.4s |
| unit | passed | 0 | 3.1s |
| artifact | passed | 0 | 3.3s |

### 逐项读数

- `npm run typecheck`：`tsc --noEmit -p tsconfig.json`，退出码 0（1.6s）。
- `npm run build`：tsdown（host）+ `build-client.mjs`，退出码 0；产物 SHA256 见上表。重建后 `git status` 无 `lib/` 改动，仓库里已提交的产物与当前工具链重建结果一致。
- `npm run test:metadata`：1 项通过、0 失败。
- `npm test`（unit 与 artifact 两条车道各跑一次，结果一致）：**14 个文件 / 116 项通过、0 失败**。分布：`client-section.spec.tsx` 40、`service-tree.spec.ts` 18、`registry.spec.ts` 18、`reconcile.spec.ts` 11、`automatic.spec.ts` 7、`client-bundle.spec.tsx` 5、`containers.spec.ts` 3、`ports.spec.ts` 3、`docker-discovery.spec.ts` 3、`host-bundle.spec.ts` 2、`native-process.spec.ts` 2、`section-layout.spec.ts` 2、`client-apply.spec.ts` 1、`native-discovery.spec.ts` 1。
- 覆盖行为：跨重启的服务追踪与对账（`reconcile` / `registry`）、原生进程身份读取（`native-process` / `native-discovery` / `windows-native`）、端口占用（`ports`）、Docker 发现（`docker-discovery` / `containers`）、设置页几何与失败反馈（`client-section` / `section-layout`）。
- `npm pack --dry-run`：`@guowenzhang/dsh-service-manager@0.5.0`，包含 `cordis.patch.yml`、`lib/`、`locale/`、双语 README、LICENSE 与 `docs/screenshots`，无可疑文件或本地数据。

### 本节未覆盖

- 本包没有 `harness` 与 `browser:*` 车道（`package.json` 未定义对应脚本），没有真实 Loader 组合回归与真实浏览器读数。
- 未在隔离 Harness 实例里装载 0.5.0 实测设置页的停止/移除浮层提示与进程行渲染；`native-*` 与 `docker-discovery` 套件在本机跑通，但未在本轮真实进程/Docker 容器上做停止操作验收。
- 未在真实 Windows 服务/容器上验证「停止前核对进程创建身份与完整容器 ID」的对端行为。

---
