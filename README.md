# dsh-service-manager

English | [简体中文](<README.zh.md>)

## Background

AI often starts service processes for testing and forgets to stop them. Without a central place to view and shut them down, these processes linger in the system and waste resources.

`dsh-service-manager` provides a unified service management page for DeepSeek Harness. It automatically collects supported background jobs, processes, and Docker containers, grouped by workspace and session, so you can inspect and stop them manually. Services stop only after user confirmation, never automatically when a session ends.

## Tracking across restarts

- A record stores identity only (PID plus creation time, host, and the full container ID), never live status. Every refresh re-checks it, and a reused PID is reported as **PID reused** instead of being mistaken for the original service.
- Ownership has two channels: the marker child processes inherit (which survives the launcher exiting, so a restart can find the process again) and, for processes without a marker, the ancestor chain back to the Harness process.
- A service that was already running before this Harness run is labelled **Started earlier**, and the page can stop those leftovers in one confirmed batch.
- In the plugin list, display names and descriptions follow the Harness language setting in English or Chinese (English is the default fallback); English names use the package name without its npm scope, Chinese names describe the purpose, and installation still uses the unchanged real package name.

## Screenshot

![Service Manager settings page](<docs/screenshots/service-manager.png>)

Open **Settings → Service Manager** to view running services, force-stop one or stop all, clean up leftovers that predate this run, remove ended records (the record only, never the resource), and scan local listening ports to adopt services that are not tracked yet. A failed refresh keeps the last successful list and says so; stopping, removing, and adopting each report in progress, success, and failure, and a failure keeps its data and retries in place; every row names its status beside the colour dot.

## Install

Requires DSH >= 0.1.7, including its prereleases.

```sh
npx @deepseek-ai/dsh plugin --profile web add @guowenzhang/dsh-service-manager
```

Restart the host and refresh the Web page after installation.

Desktop: open **Plugins → Add plugin**, enter a local checkout path, install, and choose **Enable now**.

## License

[Apache-2.0](<LICENSE>)
