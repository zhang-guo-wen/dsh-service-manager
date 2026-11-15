---
description: "See and stop the background jobs, processes and Docker containers that AI started, all in one DeepSeek Harness page"
kind: "plugin-readme"
---

# @guowenzhang/dsh-service-manager

English | [中文](<README.md>)

## Background

**Services AI starts, closed in one place.**

AI often starts services for testing and forgets to stop them, so they linger in the system. This plugin brings background jobs, processes and Docker containers into one table, grouped by workspace and session, so you can inspect and stop them by hand. A service stops only after you confirm, never when a session ends.

## Screenshots

**Services**: running services grouped by workspace and session; every row names its status beside the colour dot.

![Service Manager settings page](<docs/screenshots/service-manager.png>)

**Clean up leftovers**: every service that will be stopped is listed first, and one confirmation starts the batch.

![Clean up leftovers confirmation](<docs/screenshots/service-manager-cleanup-leftovers.png>)

## Install

```sh
npx @deepseek-ai/dsh plugin --profile web add @guowenzhang/dsh-service-manager
```

Requires DSH 0.1.7 or newer and below 0.3.0, prereleases included. Restart the host, refresh the page, then open **Settings → Service Manager**.

## Features

1. **Collected automatically**: background jobs, processes and Docker containers share one table, grouped by workspace and session.
2. **Stopped only on confirmation**: force-stopping one, stopping all or cleaning up leftovers never happens when a session ends.
3. **Recognised across restarts**: a record stores identity only (PID, creation time, host, full container ID) and is re-checked on every refresh, so a reused PID is labelled as such.
4. **Adopt untracked services**: scan local listening ports and add a service that nothing tracks yet.
5. **Retry in place**: stopping, removing and adopting each report in progress, success and failure, and a failure keeps its data.
