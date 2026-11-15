---
description: "在 DeepSeek Harness 里统一查看并关闭 AI 起动的后台任务、进程与 Docker 容器"
kind: "plugin-readme"
---

# @guowenzhang/dsh-service-manager

[English](<README.en.md>)

## 背景

**AI 起的服务，一处收尾。**

AI 常为测试起动服务，之后忘记关闭，进程就长期驻留在系统里。这个插件把后台任务、进程和 Docker 容器收进同一张表，按工作区与会话分组，方便查看和手动停止。服务只在你确认后停止，不会随会话结束自动关闭。

## 截图

**服务列表**：运行中的服务按工作区与会话分组，每一行的状态除色点外还有文字。

![服务管理页面](<docs/screenshots/service-manager.png>)

**清理遗留**：先列出全部将被停止的服务，一次确认后才动手。

![清理遗留确认框](<docs/screenshots/service-manager-cleanup-leftovers.png>)

## 安装

```sh
npx @deepseek-ai/dsh plugin --profile web add @guowenzhang/dsh-service-manager
```

需要 DSH 0.1.7 及以上、0.3.0 以下（含预发布版本）。装完重启宿主并刷新页面，打开 **设置 → 服务管理**。

## 特点

1. **自动收录**：后台任务、进程和 Docker 容器都进同一张表，按工作区与会话分组。
2. **只在确认后停止**：单个强制停止、全部关闭或批量清理遗留，都不会在会话结束时自动动手。
3. **跨重启仍能认回**：记录只存身份（PID 加创建时间、主机、容器完整 ID），每次刷新重新校验，PID 被复用会标出来。
4. **认领没跟踪的服务**：扫描本机监听端口，把漏掉的服务显式加进来。
5. **失败可原地重试**：停止、移除、认领都有进行中、成功、失败三态，失败时保留原数据。
