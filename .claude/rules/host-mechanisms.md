---
paths:
  - "src/**"
  - "tests/**"
---

> 覆盖：归属判定与身份语义、Windows 原生读取器、定时对账与注册表 schema；何时读：改发现/归属/停止判定、`src/**` 或 `tests/**` 时

Attribution has two channels: the inherited `DSH_SERVICE_OWNER` marker, and for
unmarked processes the ancestor chain back to the Harness process validated by
creation-time ordering (`hostDescendants`). Never infer ownership from ports or
names; `src/ports.ts` only feeds an explicit user adoption. An unmarked
descendant is persisted only after two scans observe the same identity, so the
plugin's own helper processes never become records.

`src/windows-native.ts` is the shared Windows reader: one kernel enumeration
serves discovery, identity checks, and parentage, and the PowerShell path stays
as the fallback for non-x64 hosts and unloadable bindings. A live process with an
unreadable creation time keeps a null `startedAt` so stop is refused rather than
reported as already gone.

Scheduled reconciliation is observation only: it writes records and never
signals a process. Its timers are unref'ed and cleared by the fiber disposer, and
container discovery stays page-triggered. The `legacy` field compares a record's
creation identity with the Harness process identity; it is a label, never a stop
decision. Keep the registry schema unchanged — add fields only with a versioned
reader.
