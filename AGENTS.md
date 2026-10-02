# dsh-service-manager

Independent DeepSeek Harness / Cordis plugin. Host code is in src/, browser code
in src/client/, generated installable bundles in lib/. Keep @deepseek-ai/* and
React external. Rebuild lib/ after source changes.

No model-facing tools. Discovery is automatic and stopping is a user action in
the settings section; the Remote methods (`listServices` / `registerService` /
`stopServices` / `removeServices`) are the whole management surface, and the
former `service_register` / `service_list` / `service_stop` tools stay removed.
`src/tools.ts` is gone — do not reintroduce a `ctx.inject(['tools'], …)`
registration.

Services are stopped ONLY by an explicit stop call. Never add exit hooks,
scope disposal, background cleanup, restart policies, or shutdown signals.
Removing a record must never stop its resource. Persist identities, not live status.
Check process creation identity and the full container ID before any stop.
Never overwrite malformed registry files. Use atomic replacement and a file lock.
All browser copy belongs in the English and Chinese dictionaries.

Run npm run typecheck, npm test, npm run build. Include regression tests for
identity reuse, unknown status, concurrent file updates, and manual-only stops.
`tests/host-bundle.spec.ts` asserts the built plugin registers no model tools.
