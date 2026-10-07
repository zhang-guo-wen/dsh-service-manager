# dsh-service-manager

English | [简体中文](<README.zh.md>)

## Background

AI often starts service processes for testing and forgets to stop them. Without a central place to view and shut them down, these processes linger in the system and waste resources.

`dsh-service-manager` provides a unified service management page for DeepSeek Harness. It automatically collects supported background jobs, processes, and Docker containers, grouped by workspace and session, so you can inspect and stop them manually. Services stop only after user confirmation, never automatically when a session ends.

## Screenshot

![Service Manager settings page](<docs/screenshots/service-manager.png>)

Open **Settings → Service Manager** to view running services, force-stop one or stop all, and show ended records.

## Install

Requires DSH >= 0.1.7, including its prereleases.

```sh
npx @deepseek-ai/dsh plugin --profile web add @guowenzhang/dsh-service-manager
```

Restart the host and refresh the Web page after installation.

Desktop: open **Plugins → Add plugin**, enter a local checkout path, install, and choose **Enable now**.

## License

[Apache-2.0](<LICENSE>)
