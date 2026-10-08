# dsh-service-manager

[English](<README.md>) | 简体中文

## 背景

AI 经常会启动一些服务进程用于测试，却忘记关闭。缺少统一的查看和关闭入口，这些进程便长期驻留在系统中，浪费资源。

`dsh-service-manager` 为 DeepSeek Harness 提供统一的服务管理页面，自动收录支持范围内的后台任务、进程和 Docker 容器，按工作区与会话分组，方便查看并手动关闭。服务只在用户确认后停止，不会随会话结束自动关闭。

插件列表的显示名称与介绍支持英文和中文，随 Harness 语言设置显示，英文为默认回退；英文名称为去掉 npm scope 的原包名，中文名称说明用途，安装仍使用不变的真实包名。

## 截图

![服务管理页面](<docs/screenshots/service-manager.png>)

打开「设置 → 服务管理」，可查看运行中的服务，单独强制停止或全部关闭，也可显示已结束的记录。

## 安装

需要 DSH >= 0.1.7（包括对应预发布版本）。

```sh
npx @deepseek-ai/dsh plugin --profile web add @guowenzhang/dsh-service-manager
```

安装后重启宿主并刷新 Web 页面。

桌面版：打开「插件 → 添加插件」，输入本地克隆路径，安装后选择「立即启用」。

## 许可

[Apache-2.0](<LICENSE>)
