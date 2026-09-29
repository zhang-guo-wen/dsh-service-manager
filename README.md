# dsh-service-manager

A DeepSeek Harness service registry with a **Service Manager** settings page directly after **Plugins**.
Register existing processes and Docker containers, refresh their status, manually stop selected services, or remove their records.

**Manual stops only.** Session completion, plugin unload, and Harness shutdown never stop registered services.
Removing a record never stops the service or deletes containers or volumes.

## Install

Requires DSH >= 0.1.7, including its prereleases. Install the local package, restart Harness, and refresh the browser:

Desktop: open **Plugins → Add plugin**, enter `C:/02-codespace/DeepSeek/dsh-service-manager`, install, and choose **Enable now**. The desktop profile is managed by the app rather than the CLI.

Web:

```powershell
npx @deepseek-ai/dsh plugin --profile web add C:/02-codespace/DeepSeek/dsh-service-manager
```

The `lib/` directory contains installable host and browser bundles.

## Use

Open **Settings → Service Manager**. The collapsible tree groups **Workspace → Session → Service** and displays confirmed running services only. Missing associations have dedicated fallback groups. Each service has one **Force stop** action, with a page-level refresh control.

Click a service's HTTP(S) address to open it in a new browser tab.

Grouping recognizes Windows path case, slash, and trailing separator variants. A legacy workspace name joins a matching directory only when running records share the complete Harness session ID and identify a single matching path. Distinct paths and ambiguous names remain separate; grouping does not rewrite registry records or stop identities.

The host collects resources without an additional model tool call:

- Bash/PowerShell jobs are observed through the Harness job registry, including existing live jobs. Session ownership supplies workspace grouping, and explicit stopping uses the host's cancellation policy.
- The `shellEnv` extension supplies an inherited ownership marker. Refresh discovers marked processes on Windows x64 and Linux with creation identities, even after their launcher exits. Other environment values are neither returned nor persisted.
- Local, unconfined shell runs use a Docker launcher that preserves argument vectors. A temporary local pipe/Unix socket annotates only container-create API requests, including Compose, without changing Compose files or config hashes. Labels recover container identity and ownership after the command exits.

Process/container identities remain in the shared registry; refresh deduplicates them. Plugin disposal only removes observers and launch hooks, without stopping resources. No Docker PATH override is installed when Docker is absent.

Discovery covers new executions after this version loads. Processes that clear inherited environment or were detached before marking cannot be attributed retrospectively. Docker capture covers `docker`/`docker.exe` resolved through PATH with a named context using a local pipe or Unix socket. Absolute binary paths, remote SSH/TCP endpoints, custom `--config`, confined runs, and remote executors pass through normally and can use manual registration. macOS and Windows ARM detached processes currently require manual registration.

Resources outside automatic discovery can be registered through the plugin's `registerService` API, supplying a PID or container reference and optional workspace/session metadata. The model is not given a registration tool.

Stopped, unknown, and changed identities are hidden without deleting their records. Successful stops disappear from the tree. Failed refreshes hide stale rows and show a query error. The API still returns complete statuses and supports removing records.

Refresh checks only registered local PIDs and remaining manual-stop targets in one batch, alongside container checks. Status is queried live without caching; full process-tree queries are reserved for registration and preparing a manual stop.

**Force stop** opens a confirmation with **Cancel** and **Force stop**, without a checkbox. Confirming sends `force: true` directly, with no normal-stop attempt. Cancelling leaves the service running. The API continues to support normal and force stops:

- Windows normal stops through the API request window closure, which console services commonly cannot accept. The page requests force termination after confirmation. PowerShell failures return plain diagnostics without CLIXML or module preparation progress.
- Linux sends SIGTERM normally, SIGKILL on force.
- Docker normal stop uses an infinite grace period, with a 12-second local deadline. The daemon request can remain pending; refresh and explicitly force stop if necessary. Force uses `docker kill`.
- Docker restart policies are retained and may restart the service. The status detail shows the policy.
- Child processes are optional, off by default. Tree stops verify identities and signal children before parents. Remaining child identities are persisted for later manual stops, including orphaned children. Inaccessible child identities block the tree stop.

Processes currently support Windows and Linux. Docker requires its CLI on the host PATH. No privileges are elevated. Direct DOCKER_HOST overrides require an explicit named context. Already detached processes need independent registration.
PID checks reduce reuse risk; Linux still has a race between identity lookup and signal delivery.

## File storage

Default: `$DSH_HOME/service-manager/services.json`, falling back to `~/.dsh/service-manager/services.json`.
Versioned JSON stores metadata, runtime identities, and targets left by a manual stop. Live status, environment variables, command lines, and secrets are not stored.
The registry does not launch or restart services or perform automatic cleanup.

Writes re-read under a cross-process lock and atomically replace through a temporary sibling. Invalid JSON, unsupported versions, and malformed records fail without overwriting the original. Files use 0600 and directories 0700; Windows permissions follow system ACLs.

Optional config overrides the Harness home or file (`file` takes precedence):

```yaml
config:
  dshHome: C:/Users/me/.dsh
  file: C:/Users/me/.dsh/service-manager/services.json
```

## Agent and plugin API

- Registration is handled by host discovery. The former `service_register` model tool has been removed, so agents no longer choose it as a manual fallback. Reload the plugin or restart Harness to update the available tools; refreshing the browser alone is insufficient. Existing conversation history may still show earlier calls.
- `service_list`: Read records with freshly queried status.
- `service_stop`: Stop record UUIDs only when requested by the user. Force requires `force: true`.

Plugins can call `ctx.get('serviceManager').registerService(request)`, `listServices({})`, `stopServices({ ids, force })`, or `removeServices({ ids })`. The same methods are exposed through Typert Remote. Integration does not replace other plugins' existing lifecycle behavior.

## Development

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

Tests cover concurrent writers, damaged files, PID reuse, partial tree stops, inherited ownership after a real detached launcher's exit, job observation/cancellation, UI behavior, and plugin unload. A local mock Docker daemon verifies pipe forwarding, argument preservation, Compose labels, stdout, and exit codes; no real containers are launched.
