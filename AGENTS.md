# dsh-service-manager

Independent DeepSeek Harness / Cordis plugin. Host code is in src/, browser code
in src/client/, generated installable bundles in lib/. Keep @deepseek-ai/* and
React external. Rebuild lib/ after source changes.

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

Run npm run typecheck, npm test, npm run build. Include regression tests for
identity reuse, unknown status, concurrent file updates, manual-only stops,
reconciliation timing, the unmarked parent chain, and the listener parsers.
`tests/host-bundle.spec.ts` asserts the built plugin registers no model tools.

## Browser section

- `ServiceSection` contributes a `settings.section`, so it follows the settings
  geometry: `container: service-manager / inline-size` plus `max-width: 760px`,
  never the 960px first-level page column. Row copy, status words, and the
  relative-time buckets all live in `src/client/locales.ts`; the buckets come
  from the host's `relativeTime`. `createdAt` is displayable, while `startedAt`
  is a process identity string and must never be parsed as a date.
- A failed read keeps the rows already on screen and marks them as the last
  successful read; only a first read that never succeeded shows the failure
  block. Stop, remove, and claim each keep their dialog or candidate row open on
  failure with a retry, and report success next to the section.
- Running status is a word beside a host `StateDot`, never colour alone. The
  leftover marker stays a plain span because `Tag` cannot carry its explanatory
  title, and the test doubles in `tests/client-section.spec.tsx` and
  `tests/client-bundle.spec.tsx` mirror whichever primitives the section uses.
