import { a as registryKey, i as ownerFromEnvironment, n as decodeOwner, r as encodeOwner, t as OWNER_ENV } from "./ownership-B1Gd-k8P.mjs";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { access, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import z$1 from "zod";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
//#region src/schema.ts
const text = z$1.string().trim().max(512);
const identitySchema = z$1.object({
	pid: z$1.number().int().min(1).max(2147483647),
	startedAt: z$1.string().min(1).max(256)
}).strict();
const metadata = {
	id: z$1.string().uuid(),
	name: text.min(1),
	project: text,
	session: text,
	url: text.refine((value) => {
		if (value === "") return true;
		try {
			const url = new URL(value);
			return url.protocol === "http:" || url.protocol === "https:";
		} catch {
			return false;
		}
	}),
	createdAt: z$1.string().datetime()
};
const registrySchema = z$1.object({
	version: z$1.literal(1),
	services: z$1.array(z$1.discriminatedUnion("kind", [z$1.object({
		...metadata,
		kind: z$1.literal("process"),
		...identitySchema.shape,
		host: text.min(1),
		tree: z$1.boolean(),
		pendingStop: z$1.array(identitySchema).max(4096)
	}).strict(), z$1.object({
		...metadata,
		kind: z$1.literal("container"),
		containerId: z$1.string().regex(/^[a-f0-9]{64}$/),
		context: text.min(1)
	}).strict()])).max(4096)
}).strict().superRefine((value, ctx) => {
	if (new Set(value.services.map((row) => row.id)).size !== value.services.length) ctx.addIssue({
		code: "custom",
		message: "Duplicate service record IDs"
	});
});
const registerSchema = z$1.object({
	kind: z$1.enum(["process", "container"]),
	name: text.min(1),
	pid: identitySchema.shape.pid.optional(),
	container: text.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).optional(),
	context: text.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).optional(),
	tree: z$1.boolean().optional(),
	project: text.optional(),
	session: text.optional(),
	url: metadata.url.optional()
}).strict().superRefine((value, ctx) => {
	if (value.kind === "process" ? !value.pid || value.container !== void 0 || value.context !== void 0 : !value.container || value.pid !== void 0 || value.tree !== void 0) ctx.addIssue({
		code: "custom",
		message: "Provide a PID for a process, or a container reference and optional Docker context for a container"
	});
});
const idsSchema = z$1.object({ ids: z$1.array(z$1.string().uuid()).min(1).max(100) }).strict();
const stopSchema = idsSchema.extend({ force: z$1.boolean().optional() });
//#endregion
//#region src/store.ts
/** Re-read under a cross-process lock; never silently replace a damaged file. */
var RegistryStore = class {
	file;
	queue = Promise.resolve();
	constructor(file) {
		this.file = resolve(file);
	}
	async read() {
		let content;
		try {
			content = await readFile(this.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return [];
			throw error;
		}
		return registrySchema.parse(JSON.parse(content)).services;
	}
	update(work) {
		const result = this.queue.then(async () => {
			await mkdir(dirname(this.file), {
				recursive: true,
				mode: 448
			});
			return withFileLock(this.file, async () => {
				const rows = await this.read();
				const value = await work(rows);
				const registry = registrySchema.parse({
					version: 1,
					services: rows
				});
				await writeFileAtomic(this.file, `${JSON.stringify(registry, null, 2)}\n`, {
					mode: 384,
					dirMode: 448
				});
				return value;
			}, { waitMs: 6e4 });
		});
		this.queue = result.catch(() => {});
		return result;
	}
};
//#endregion
//#region src/command.ts
const run = (file, args, timeout = 15e3) => new Promise((resolve, reject) => {
	execFile(file, args, {
		windowsHide: true,
		shell: false,
		timeout,
		maxBuffer: 8388608,
		encoding: "utf8"
	}, (error, stdout, stderr) => {
		if (error) reject(/* @__PURE__ */ new Error(`${file}: ${stderr.trim() || error.message}`));
		else resolve(stdout.trim().replace(/^\uFEFF/, ""));
	});
});
/** Encode scripts so quoting and a user's shell cannot change their meaning. */
function powershell(script, runner = run) {
	return runner("powershell.exe", [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-OutputFormat",
		"Text",
		"-EncodedCommand",
		Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); try { ${script} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`, "utf16le").toString("base64")
	]);
}
//#endregion
//#region src/errors.ts
/** A manual normal stop cannot be delivered to a Windows console process. */
var NormalStopUnsupportedError = class extends Error {
	code = "normal-stop-unsupported";
	constructor() {
		super("This Windows process has no window that accepts a close request. It is still running; use explicit force stop if needed.");
	}
};
/** Preserve command diagnostics without adding repeated Error prefixes. */
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/windows-native.ts
/** The native reader needs an x64 Windows process for its PEB layout and FFI. */
function windowsNativeSupported() {
	return process.platform === "win32" && process.arch === "x64";
}
let api;
let loading;
/** Load the native reader once; a failed load stays retryable. */
function loadWindowsNative() {
	if (api) return Promise.resolve(api);
	loading ??= createWindowsNative().then((created) => api = created, (error) => {
		loading = void 0;
		throw error;
	});
	return loading;
}
async function createWindowsNative() {
	const { default: koffi } = await import("koffi");
	const kernel = koffi.load("kernel32.dll");
	const nt = koffi.load("ntdll.dll");
	const enumerate = koffi.load("psapi.dll").func("int __stdcall EnumProcesses(void *ids, uint32_t size, void *used)");
	const open = kernel.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
	const close = kernel.func("int __stdcall CloseHandle(void *handle)");
	const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)");
	const query = nt.func("int32_t __stdcall NtQueryInformationProcess(void *handle, uint32_t kind, void *data, uint32_t size, void *used)");
	const read = kernel.func("int __stdcall ReadProcessMemory(void *handle, void *address, void *data, size_t size, void *used)");
	const times = kernel.func("int __stdcall GetProcessTimes(void *handle, void *created, void *exit, void *kernelTime, void *userTime)");
	const image = kernel.func("int __stdcall QueryFullProcessImageNameW(void *handle, uint32_t flags, void *name, void *size)");
	const QUERY_ONLY = 1052672;
	const QUERY_AND_READ = 1053712;
	const STILL_ACTIVE = 258;
	const TICKS_EPOCH_OFFSET = 504911232000000000n;
	const table = () => {
		const ids = Buffer.alloc(262144);
		const used = Buffer.alloc(4);
		if (!enumerate(ids, ids.length, used)) throw new Error("Cannot enumerate process ownership");
		const rows = [];
		for (let offset = 0; offset < used.readUInt32LE(); offset += 4) {
			const pid = ids.readUInt32LE(offset);
			if (pid > 0) rows.push(pid);
		}
		return rows;
	};
	const inspect = (pid, handle, markers) => {
		if (wait(handle, 0) !== STILL_ACTIVE) return;
		const basic = Buffer.alloc(48);
		const hasBasic = query(handle, 0, basic, basic.length, null) === 0;
		let marker;
		if (markers && hasBasic) {
			const wow = Buffer.alloc(8);
			if (query(handle, 26, wow, wow.length, null) === 0) {
				const narrow = wow.readBigUInt64LE() !== 0n;
				const peb = narrow ? wow.readBigUInt64LE() : basic.readBigUInt64LE(8);
				const memory = (address, size) => {
					const bytes = Buffer.alloc(size);
					const count = Buffer.alloc(8);
					if (!read(handle, address, bytes, size, count) || count.readBigUInt64LE() !== BigInt(size)) return;
					return bytes;
				};
				const pointer = (address) => {
					const bytes = memory(address, narrow ? 4 : 8);
					return bytes && (narrow ? BigInt(bytes.readUInt32LE()) : bytes.readBigUInt64LE());
				};
				const parameters = pointer(peb + (narrow ? 16n : 32n));
				let address = parameters && pointer(parameters + (narrow ? 72n : 128n));
				let environment = "";
				for (let length = 0; address && length < 262144;) {
					const size = 4096 - Number(address % 4096n);
					const bytes = memory(address, size);
					if (!bytes) break;
					environment += bytes.toString("utf16le");
					const end = environment.indexOf("\0\0");
					if (end >= 0) {
						environment = environment.slice(0, end);
						break;
					}
					address += BigInt(size);
					length += size;
				}
				marker = environment ? ownerFromEnvironment(environment) : void 0;
			}
		}
		const created = Buffer.alloc(8);
		const hasTimes = times(handle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)) !== 0;
		const name = Buffer.alloc(65536);
		const size = Buffer.alloc(4);
		size.writeUInt32LE(name.length / 2);
		const path = image(handle, 0, name, size) ? name.subarray(0, size.readUInt32LE() * 2).toString("utf16le") : "";
		if (wait(handle, 0) !== STILL_ACTIVE) return;
		return {
			pid,
			parentPid: hasBasic ? Number(basic.readBigUInt64LE(40)) : 0,
			startedAt: hasTimes ? (created.readBigUInt64LE() + TICKS_EPOCH_OFFSET).toString() : null,
			name: basename(path) || `PID ${pid}`,
			alive: true,
			...marker === void 0 ? {} : { marker }
		};
	};
	return { snapshot(pids, markers = false) {
		const rows = [];
		for (const pid of pids ?? table()) {
			if (pid <= 0) continue;
			const handle = open(markers ? QUERY_AND_READ : QUERY_ONLY, 0, pid);
			if (!handle) continue;
			try {
				const row = inspect(pid, handle, markers);
				if (row) rows.push(row);
			} finally {
				close(handle);
			}
		}
		return rows;
	} };
}
//#endregion
//#region src/processes.ts
function parseLinuxStat(pid, text, boot) {
	const end = text.lastIndexOf(")");
	if (end < 0) throw new Error("Malformed process stat");
	const fields = text.slice(end + 2).trim().split(/\s+/);
	if (!fields[19] || !fields[1]) throw new Error("Incomplete process stat");
	return {
		pid,
		parentPid: Number(fields[1]),
		startedAt: `${boot}:${fields[19]}`,
		name: text.slice(text.indexOf("(") + 1, end),
		alive: fields[0] !== "Z" && fields[0] !== "X"
	};
}
/**
* Order two creation identities read from the same host. Windows reports .NET
* ticks and Linux a boot id with the kernel start tick; anything else falls back
* to ISO timestamps.
* @param left - candidate earlier identity.
* @param right - candidate later identity.
* @returns whether left was created before right, or undefined when the two are not comparable.
*/
function startedBefore(left, right) {
	if (/^\d+$/.test(left) && /^\d+$/.test(right)) return BigInt(left) < BigInt(right);
	const leftParts = left.split(":");
	const rightParts = right.split(":");
	if (leftParts.length === 2 && rightParts.length === 2 && leftParts[0] === rightParts[0] && /^\d+$/.test(leftParts[1]) && /^\d+$/.test(rightParts[1])) return BigInt(leftParts[1]) < BigInt(rightParts[1]);
	const leftMs = Date.parse(left);
	const rightMs = Date.parse(right);
	return Number.isFinite(leftMs) && Number.isFinite(rightMs) ? leftMs < rightMs : void 0;
}
/** Collect children before parents without guessing ownership from ports or names. */
function processTargets(root, snapshot, tree) {
	const current = snapshot.get(root.pid);
	if (!current?.alive || current.startedAt !== root.startedAt) return [];
	const visited = /* @__PURE__ */ new Set();
	const targets = [];
	const visit = (info) => {
		if (visited.has(info.pid)) return;
		visited.add(info.pid);
		if (tree) {
			for (const child of snapshot.values()) if (child.parentPid === info.pid && child.alive && child.startedAt && isNewerChild(child.startedAt, info.startedAt)) visit(child);
		}
		if (info.startedAt) targets.push({
			pid: info.pid,
			startedAt: info.startedAt
		});
	};
	visit(current);
	return targets;
}
function isNewerChild(child, parent) {
	return startedBefore(parent, child) ?? (Number.isFinite(Date.parse(child)) && Date.parse(child) >= Date.parse(parent));
}
/** Merge rows into the PID-keyed view every caller expects. */
function toMap(rows) {
	return new Map(rows.map((row) => [row.pid, row]));
}
var NativeProcesses = class {
	host = `${process.platform}:${hostname()}`;
	self;
	async snapshot(pids) {
		const selected = pids === void 0 ? void 0 : [...new Set(pids)];
		if (selected?.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Invalid process ID");
		if (selected?.length === 0) return /* @__PURE__ */ new Map();
		if (process.platform === "win32") {
			if (windowsNativeSupported()) try {
				return toMap((await loadWindowsNative()).snapshot(selected, false));
			} catch {}
			return this.snapshotWindows(selected);
		}
		if (process.platform === "linux") {
			const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
			const names = selected?.map(String) ?? (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
			return toMap((await Promise.all(names.map(async (name) => {
				try {
					return parseLinuxStat(Number(name), await readFile(`/proc/${name}/stat`, "utf8"), boot);
				} catch (error) {
					if (error.code === "ENOENT" || error.code === "ESRCH") return null;
					return {
						pid: Number(name),
						parentPid: 0,
						startedAt: null,
						name: "",
						alive: true
					};
				}
			}))).filter((row) => row !== null));
		}
		throw new Error(`Unsupported process platform: ${process.platform}`);
	}
	/** The Harness process identity, used to date a record against the current run. */
	selfIdentity() {
		this.self ??= this.snapshot([process.pid]).then((info) => {
			const current = info.get(process.pid);
			return current?.alive && current.startedAt ? {
				pid: current.pid,
				startedAt: current.startedAt
			} : void 0;
		}).catch(() => void 0);
		return this.self;
	}
	async snapshotWindows(selected) {
		const output = await powershell(selected ? `$rows=@(foreach ($targetId in @(${selected.join(",")})) {
      try { $p=[System.Diagnostics.Process]::GetProcessById($targetId) }
      catch [System.ArgumentException] { continue }
      try {
        $stamp=$null
        try { $stamp=$p.StartTime.ToUniversalTime().Ticks.ToString() } catch {}
        [pscustomobject]@{pid=$targetId;parentPid=0;startedAt=$stamp;name=$p.ProcessName;alive=$true}
      } finally { $p.Dispose() }
    }); ConvertTo-Json -InputObject $rows -Compress` : `$stamps=@{}
    Get-Process | ForEach-Object { try { $stamps[$_.Id]=$_.StartTime.ToUniversalTime().Ticks.ToString() } catch {} }
    $rows=@(Get-CimInstance Win32_Process | ForEach-Object {
      $stamp=$stamps[[int]$_.ProcessId]
      [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startedAt=$stamp;name=$_.Name;alive=$true}
    }); ConvertTo-Json -InputObject $rows -Compress`);
		const rows = JSON.parse(output);
		if (!Array.isArray(rows)) throw new Error("Unexpected process snapshot");
		return new Map(rows.filter((row) => row.pid > 0).map((row) => [row.pid, row]));
	}
	async signal(target, force) {
		if (target.pid <= 1 || target.pid === process.pid || !Number.isSafeInteger(target.pid)) throw new Error("Refusing to stop the Harness or a system process");
		if (process.platform === "win32") {
			if (!/^\d+$/.test(target.startedAt)) throw new Error("Invalid process creation identity");
			if (await powershell(`try { $p=Get-Process -Id ${target.pid} -ErrorAction Stop } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { exit 0 }
        if ($p.StartTime.ToUniversalTime().Ticks.ToString() -ne '${target.startedAt}') { throw 'Process identity changed; stop refused' }
        if (${force ? "$true" : "$false"}) { $p.Kill() }
        elseif (-not $p.CloseMainWindow()) { [Console]::Out.Write('normal-stop-unsupported') }`) === "normal-stop-unsupported") throw new NormalStopUnsupportedError();
			return;
		}
		const current = (await this.snapshot()).get(target.pid);
		if (!current?.alive) return;
		if (!current.startedAt || current.startedAt !== target.startedAt) throw new Error("Process identity changed; stop refused");
		try {
			process.kill(target.pid, force ? "SIGKILL" : "SIGTERM");
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	}
};
//#endregion
//#region src/containers.ts
const referencePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
function checkReference(value) {
	if (!referencePattern.test(value) || value.length > 512) throw new Error("Invalid Docker reference");
}
var DockerContainers = class {
	runner;
	constructor(runner = run) {
		this.runner = runner;
	}
	async resolveContext(context) {
		if (!context && !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) throw new Error("DOCKER_HOST overrides require an explicit named Docker context");
		const selected = context ?? await this.runner("docker", ["context", "show"]);
		checkReference(selected);
		return selected;
	}
	async inspect(context, reference) {
		checkReference(context);
		checkReference(reference);
		try {
			const fields = (await this.runner("docker", [
				"--context",
				context,
				"container",
				"inspect",
				"--format",
				"{{json .Id}}|{{json .Name}}|{{json .State.Running}}|{{json .State.Status}}|{{json .HostConfig.RestartPolicy.Name}}",
				reference
			])).split("|").map((part) => JSON.parse(part));
			if (fields.length !== 5 || typeof fields[0] !== "string" || !/^[a-f0-9]{64}$/.test(fields[0]) || typeof fields[1] !== "string" || typeof fields[2] !== "boolean" || typeof fields[3] !== "string" || typeof fields[4] !== "string") throw new Error("Unexpected Docker response");
			return {
				id: fields[0],
				name: fields[1].replace(/^\//, ""),
				running: fields[2],
				phase: fields[3],
				restart: fields[4]
			};
		} catch (error) {
			if (/No such (?:container|object):/i.test(String(error))) return null;
			throw error;
		}
	}
	async stop(context, id, force) {
		checkReference(context);
		if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("A complete container ID is required to stop");
		const current = await this.inspect(context, id);
		if (!current) return;
		if (current.id !== id) throw new Error("Container identity changed; stop refused");
		if (!current.running) return;
		if (current.phase === "paused" && !force) throw new Error("Container is paused; unpause it or use explicit force stop");
		await this.runner("docker", [
			"--context",
			context,
			"container",
			force ? "kill" : "stop",
			...force ? [] : ["--timeout", "-1"],
			id
		], 12e3);
	}
};
//#endregion
//#region src/ports.ts
/**
* Read `netstat -ano` output. The state word stays English on localized
* Windows installs, but the match stays case-insensitive to tolerate variants.
*/
function parseWindowsNetstat(output) {
	const listeners = [];
	for (const line of output.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 5 || !/^tcp/i.test(fields[0])) continue;
		if (!/listen/i.test(fields[3])) continue;
		const address = fields[1];
		const port = Number(address.slice(address.lastIndexOf(":") + 1));
		const pid = Number(fields[4]);
		if (!Number.isSafeInteger(port) || port <= 0 || !Number.isSafeInteger(pid) || pid <= 0) continue;
		listeners.push({
			pid,
			port,
			protocol: "TCP",
			address
		});
	}
	return listeners;
}
/** Read `ss -ltnp` output, where the owning process arrives as `pid=<n>`. */
function parseLinuxListeners(output) {
	const listeners = [];
	for (const line of output.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields[0] !== "LISTEN" || fields.length < 5) continue;
		const local = fields[3];
		const port = Number(local.slice(local.lastIndexOf(":") + 1));
		const pid = Number(/pid=(\d+)/.exec(fields.slice(4).join(" "))?.[1]);
		if (!Number.isSafeInteger(port) || port <= 0 || !Number.isSafeInteger(pid) || pid <= 0) continue;
		listeners.push({
			pid,
			port,
			protocol: "TCP",
			address: local
		});
	}
	return listeners;
}
/** Keep one row per process and port; a dual-stack listener is one service. */
function dedupe(listeners) {
	const seen = /* @__PURE__ */ new Set();
	const rows = [];
	for (const listener of listeners) {
		const key = `${listener.pid}:${listener.port}`;
		if (seen.has(key)) continue;
		seen.add(key);
		rows.push(listener);
	}
	return rows.slice(0, 500);
}
/**
* Read the local listening sockets with their owning PIDs. This is a user-triggered
* read: it starts an external process, so it never runs on a timer.
*/
async function listListeners(runner = run) {
	if (process.platform === "win32") return dedupe(parseWindowsNetstat(await runner("netstat", ["-ano"], 1e4)));
	if (process.platform === "linux") return dedupe(parseLinuxListeners(await runner("ss", ["-ltnpH"], 1e4)));
	throw new Error(`Listening services are not discoverable on ${process.platform}`);
}
//#endregion
//#region src/manager.ts
function matches(target, snapshot) {
	const current = snapshot.get(target.pid);
	return Boolean(current?.alive && current.startedAt === target.startedAt);
}
function protectedPids(snapshot) {
	const protectedSet = /* @__PURE__ */ new Set([
		0,
		1,
		process.pid
	]);
	let parent = snapshot.get(process.pid)?.parentPid;
	while (parent && !protectedSet.has(parent)) {
		protectedSet.add(parent);
		parent = snapshot.get(parent)?.parentPid;
	}
	return protectedSet;
}
var ServiceRegistry = class {
	store;
	processes;
	containers;
	discovery;
	instance;
	constructor(store, processes = new NativeProcesses(), containers = new DockerContainers()) {
		this.store = store;
		this.processes = processes;
		this.containers = containers;
	}
	/** The Harness process identity, read once per run to date a record against it. */
	self() {
		this.instance ??= this.processes.selfIdentity?.() ?? Promise.resolve(void 0);
		return this.instance;
	}
	async register(request) {
		const value = registerSchema.parse(request);
		const metadata = {
			id: randomUUID(),
			name: value.name,
			project: value.project ?? "",
			session: value.session ?? "",
			url: value.url ?? "",
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		let record;
		if (value.kind === "process") {
			const snapshot = await this.processes.snapshot();
			const current = snapshot.get(value.pid);
			if (protectedPids(snapshot).has(value.pid)) throw new Error("Cannot register the Harness, its ancestors, or a system process for stopping");
			if (!current?.alive || !current.startedAt) throw new Error("Process is absent or its creation identity cannot be verified");
			record = {
				...metadata,
				kind: "process",
				pid: current.pid,
				startedAt: current.startedAt,
				host: this.processes.host,
				tree: value.tree ?? false,
				pendingStop: []
			};
		} else {
			const context = await this.containers.resolveContext(value.context);
			const current = await this.containers.inspect(context, value.container);
			if (!current) throw new Error("Container does not exist");
			record = {
				...metadata,
				kind: "container",
				containerId: current.id,
				context
			};
		}
		return this.store.update((rows) => {
			if (rows.some((row) => row.kind === "process" && record.kind === "process" ? row.host === record.host && row.pid === record.pid && row.startedAt === record.startedAt : row.kind === "container" && record.kind === "container" && row.context === record.context && row.containerId === record.containerId)) throw new Error("This service is already registered");
			rows.push(record);
			return record;
		});
	}
	async list() {
		await this.discovery?.refresh();
		const rows = await this.store.read();
		let snapshotError = "";
		const pids = [...new Set(rows.flatMap((row) => row.kind === "process" && row.host === this.processes.host ? [row.pid, ...row.pendingStop.map((target) => target.pid)] : []))];
		const snapshotPromise = pids.length ? this.processes.snapshot(pids).catch((error) => {
			snapshotError = String(error);
		}) : Promise.resolve(void 0);
		const selfPromise = pids.length ? this.self() : Promise.resolve(void 0);
		return {
			services: [...(await Promise.all(rows.map(async (record) => {
				try {
					if (record.kind === "container") {
						const current = await this.containers.inspect(record.context, record.containerId);
						if (current && current.id !== record.containerId) return {
							record,
							status: "changed",
							detail: "Container identity changed",
							remaining: 0
						};
						return {
							record,
							status: current?.running ? "running" : "stopped",
							detail: current ? `${current.phase}; restart=${current.restart}` : "Container no longer exists",
							remaining: current?.running ? 1 : 0
						};
					}
					if (record.host !== this.processes.host) throw new Error("Record belongs to a different host");
					const snapshot = await snapshotPromise;
					if (!snapshot) throw new Error(snapshotError || "Process snapshot unavailable");
					const current = snapshot.get(record.pid);
					const remaining = record.pendingStop.filter((target) => matches(target, snapshot)).length;
					if (record.pendingStop.some((target) => {
						const info = snapshot.get(target.pid);
						return info?.alive && !info.startedAt;
					}) || current?.alive && !current.startedAt) throw new Error("Process identity is inaccessible");
					if (remaining > 0) return {
						record,
						status: "running",
						detail: "A manual stop has remaining process targets",
						remaining
					};
					if (!current?.alive) return {
						record,
						status: "stopped",
						detail: "",
						remaining: 0
					};
					if (current.startedAt !== record.startedAt) return {
						record,
						status: "changed",
						detail: "PID was reused; the registered process has exited",
						remaining: 0
					};
					const self = await selfPromise;
					const legacy = self?.startedAt ? startedBefore(record.startedAt, self.startedAt) : void 0;
					return {
						record,
						status: "running",
						detail: current.name,
						remaining: 1,
						...legacy ? { legacy: true } : {}
					};
				} catch (error) {
					return {
						record,
						status: "unknown",
						detail: String(error),
						remaining: 0
					};
				}
			}))).filter((row) => this.discovery?.visible(row.record) !== false), ...await this.discovery?.list() ?? []],
			file: this.store.file,
			...this.discovery?.warnings?.length ? { warnings: this.discovery.warnings } : {}
		};
	}
	/** Prepare and persist a manual stop's identities before delivering any signal. */
	async prepareProcess(record) {
		if (record.host !== this.processes.host) throw new Error("Record belongs to a different host");
		const snapshot = await this.processes.snapshot();
		const current = snapshot.get(record.pid);
		if (current?.alive && !current.startedAt) throw new Error("Process identity cannot be verified; stop refused");
		if (current?.alive && current.startedAt !== record.startedAt && record.pendingStop.length === 0) throw new Error("PID was reused; stop refused");
		const targets = [];
		for (const root of [...record.pendingStop, {
			pid: record.pid,
			startedAt: record.startedAt
		}]) {
			const info = snapshot.get(root.pid);
			if (info?.alive && !info.startedAt) throw new Error("A stop target cannot be verified");
			for (const target of processTargets(root, snapshot, record.tree)) if (!targets.some((existing) => existing.pid === target.pid && existing.startedAt === target.startedAt)) targets.push(target);
		}
		const protectedSet = protectedPids(snapshot);
		if (targets.some((target) => protectedSet.has(target.pid))) throw new Error("The stop targets include the Harness, an ancestor, or a system process");
		if (record.tree) {
			const parents = new Set(targets.map((target) => target.pid));
			if ([...snapshot.values()].some((info) => parents.has(info.parentPid) && info.alive && !info.startedAt)) throw new Error("A child process identity cannot be verified; tree stop refused");
		}
		record.pendingStop = targets;
		return targets;
	}
	async stop(request) {
		const { ids, force = false } = stopSchema.parse(request);
		const results = [];
		for (const id of new Set(ids)) try {
			const automatic = await this.discovery?.stop(id);
			if (automatic) {
				results.push(automatic);
				continue;
			}
			let targets = [];
			const record = await this.store.update(async (rows) => {
				const row = rows.find((item) => item.id === id);
				if (!row) throw new Error("Service record does not exist");
				if (row.kind === "process") targets = await this.prepareProcess(row);
				return structuredClone(row);
			});
			if (record.kind === "container") {
				await this.containers.stop(record.context, record.containerId, force);
				if ((await this.containers.inspect(record.context, record.containerId))?.running) throw new Error("Container is still running; check its restart policy");
			} else {
				const errors = [];
				for (const target of targets) try {
					await this.processes.signal(target, force);
				} catch (error) {
					errors.push(error);
				}
				const pids = targets.map((target) => target.pid);
				let snapshot = await this.processes.snapshot(pids);
				for (let attempt = 0; attempt < 3 && targets.some((target) => matches(target, snapshot)); attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 150));
					snapshot = await this.processes.snapshot(pids);
				}
				const remaining = targets.filter((target) => matches(target, snapshot) || snapshot.get(target.pid)?.alive && !snapshot.get(target.pid)?.startedAt);
				await this.store.update((rows) => {
					const row = rows.find((item) => item.id === id);
					if (row?.kind === "process") row.pendingStop = remaining;
				});
				if (remaining.length) {
					if (errors.length && errors.every((error) => error instanceof NormalStopUnsupportedError)) throw new NormalStopUnsupportedError();
					throw new Error(errors.map(errorMessage).join("; ") || "Processes are still running; refresh or use explicit force stop");
				}
			}
			results.push({
				id,
				ok: true,
				message: "Stopped"
			});
		} catch (error) {
			results.push({
				id,
				ok: false,
				message: errorMessage(error),
				...error instanceof NormalStopUnsupportedError ? { code: error.code } : {}
			});
		}
		return { results };
	}
	/**
	* Local listening services that the registry does not track yet. The read is
	* user-triggered; adopting one is a separate explicit `register` call.
	*/
	async candidates() {
		let listeners;
		try {
			listeners = await listListeners();
		} catch (error) {
			return {
				candidates: [],
				warnings: [errorMessage(error)]
			};
		}
		const rows = await this.store.read();
		const recorded = new Set(rows.flatMap((row) => row.kind === "process" && row.host === this.processes.host ? [row.pid] : []));
		const pids = [...new Set(listeners.map((listener) => listener.pid))].filter((pid) => pid > 4 && pid !== process.pid && !recorded.has(pid)).slice(0, 200);
		if (!pids.length) return { candidates: [] };
		const selected = new Set(pids);
		let snapshot;
		try {
			snapshot = await this.processes.snapshot(pids);
		} catch (error) {
			return {
				candidates: [],
				warnings: [errorMessage(error)]
			};
		}
		const candidates = [];
		for (const listener of listeners) {
			if (!selected.has(listener.pid)) continue;
			const info = snapshot.get(listener.pid);
			if (!info?.alive || !info.startedAt) continue;
			candidates.push({
				pid: listener.pid,
				startedAt: info.startedAt,
				name: info.name || `PID ${listener.pid}`,
				port: listener.port,
				protocol: listener.protocol,
				address: listener.address
			});
		}
		return { candidates };
	}
	async remove(request) {
		const { ids } = idsSchema.parse(request);
		return this.store.update((rows) => {
			const results = [];
			for (const id of new Set(ids)) {
				const index = rows.findIndex((row) => row.id === id);
				if (index < 0) results.push({
					id,
					ok: false,
					message: "Service record does not exist"
				});
				else {
					rows.splice(index, 1);
					results.push({
						id,
						ok: true,
						message: "Record removed; service was not stopped"
					});
				}
			}
			return { results };
		});
	}
};
//#endregion
//#region src/service-remote.ts
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
let ServiceManager = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _listServices_decorators;
	let _listCandidates_decorators;
	let _registerService_decorators;
	let _stopServices_decorators;
	let _removeServices_decorators;
	return class ServiceManager extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_listServices_decorators = [Remote("listServices")];
			_listCandidates_decorators = [Remote("listCandidates")];
			_registerService_decorators = [Remote("registerService")];
			_stopServices_decorators = [Remote("stopServices")];
			_removeServices_decorators = [Remote("removeServices")];
			__esDecorate(this, null, _listServices_decorators, {
				kind: "method",
				name: "listServices",
				static: false,
				private: false,
				access: {
					has: (obj) => "listServices" in obj,
					get: (obj) => obj.listServices
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listCandidates_decorators, {
				kind: "method",
				name: "listCandidates",
				static: false,
				private: false,
				access: {
					has: (obj) => "listCandidates" in obj,
					get: (obj) => obj.listCandidates
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _registerService_decorators, {
				kind: "method",
				name: "registerService",
				static: false,
				private: false,
				access: {
					has: (obj) => "registerService" in obj,
					get: (obj) => obj.registerService
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _stopServices_decorators, {
				kind: "method",
				name: "stopServices",
				static: false,
				private: false,
				access: {
					has: (obj) => "stopServices" in obj,
					get: (obj) => obj.stopServices
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _removeServices_decorators, {
				kind: "method",
				name: "removeServices",
				static: false,
				private: false,
				access: {
					has: (obj) => "removeServices" in obj,
					get: (obj) => obj.removeServices
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		registry = __runInitializers(this, _instanceExtraInitializers);
		constructor(ctx, registry) {
			super(ctx, "serviceManager");
			this.registry = registry;
		}
		async listServices(request) {
			return this.registry.list();
		}
		async listCandidates(request) {
			return this.registry.candidates();
		}
		async registerService(request) {
			return this.registry.register(request);
		}
		async stopServices(request) {
			return this.registry.stop(request);
		}
		async removeServices(request) {
			return this.registry.remove(request);
		}
	};
})();
//#endregion
//#region src/discover-processes.ts
/**
* Read the process table with parentage and the inherited ownership marker.
* Windows uses native kernel reads; Linux reads `/proc`. Platforms without an
* implementation report no rows, so every caller degrades to jobs and containers.
*/
async function inspectProcesses() {
	if (process.platform === "linux") return inspectLinux();
	if (!windowsNativeSupported()) return [];
	return (await loadWindowsNative()).snapshot(void 0, true);
}
async function inspectLinux() {
	const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
	return (await Promise.all(names.map(async (name) => {
		const pid = Number(name);
		if (pid <= 1 || pid === process.pid) return;
		let row;
		try {
			row = parseLinuxStat(pid, await readFile(`/proc/${pid}/stat`, "utf8"), boot);
		} catch {
			return;
		}
		if (!row.alive) return;
		try {
			const marker = ownerFromEnvironment(await readFile(`/proc/${pid}/environ`, "utf8"));
			if (marker) row.marker = marker;
		} catch {}
		return row;
	}))).filter((row) => row !== void 0);
}
//#endregion
//#region src/automatic.ts
/** Structural lookup keeps optional host services out of the plugin's runtime dependencies. */
function hostService(ctx, name) {
	return ctx.get(name);
}
/** A process is host-owned when its whole ancestor chain reaches the Harness process. */
function reachesHarness(rows, row, harnessPid, cache, depth = 0) {
	if (row.pid === harnessPid) return true;
	if (depth > 64 || !row.startedAt) return false;
	const known = cache.get(row.pid);
	if (known !== void 0) return known;
	const parent = rows.get(row.parentPid);
	const ordered = parent?.startedAt ? startedBefore(row.startedAt, parent.startedAt) === false : false;
	const result = Boolean(parent) && ordered && reachesHarness(rows, parent, harnessPid, cache, depth + 1);
	cache.set(row.pid, result);
	return result;
}
/** Every live row whose ancestor chain reaches the Harness process. */
function hostDescendants(rows, harnessPid) {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const cache = /* @__PURE__ */ new Map();
	return rows.filter((row) => reachesHarness(byPid, row, harnessPid, cache));
}
/** Ancestors of attributed processes, such as the private spawn runners that wrap them. */
function ancestorsOf(rows, pids) {
	const ancestors = /* @__PURE__ */ new Set();
	for (const pid of pids) {
		let parent = rows.get(pid)?.parentPid;
		for (let depth = 0; parent && depth < 64; depth++) {
			if (ancestors.has(parent)) break;
			ancestors.add(parent);
			parent = rows.get(parent)?.parentPid;
		}
	}
	return ancestors;
}
var AutomaticServices = class {
	store;
	sessions;
	scan;
	key;
	call = new AsyncLocalStorage();
	bindings = /* @__PURE__ */ new Map();
	hidden = /* @__PURE__ */ new Set();
	processCalls = /* @__PURE__ */ new Map();
	flight;
	flightContainers = false;
	hostSeen = /* @__PURE__ */ new Set();
	timer;
	sweep;
	lastScan = 0;
	options;
	jobs;
	warnings = [];
	captureContainers;
	constructor(store, sessions, scan = inspectProcesses, options = {}) {
		this.store = store;
		this.sessions = sessions;
		this.scan = scan;
		this.key = registryKey(store.file);
		this.options = {
			hostOwned: true,
			reconcileDelayMs: 1500,
			reconcileMinIntervalMs: 1e4,
			reconcileIntervalMs: 3e4,
			...options
		};
	}
	owner(exec) {
		if (!exec.agent) return {};
		return { [OWNER_ENV]: encodeOwner(this.key, {
			session: String(exec.agent.id),
			project: exec.agent.session.header.cwd ?? "",
			call: String(exec.callId)
		}) };
	}
	attachJobs(jobs) {
		this.jobs = jobs;
		const observe = (job, call = "") => {
			if (!["bash", "pwsh"].includes(job.kind)) return;
			const existing = this.bindings.get(job.id);
			if (!existing || existing.job.startedAt !== job.startedAt) this.bindings.set(job.id, {
				job: { ...job },
				id: randomUUID(),
				call
			});
			else existing.job = { ...job };
			this.schedule();
		};
		const unsubscribe = jobs.events.subscribe({ owners: "all" }, (event) => {
			if (!event.job) return;
			if (event.type === "removed") this.bindings.delete(event.job.id);
			else observe(event.job, this.call.getStore());
		});
		for (const owner of [void 0, ...this.sessions()?.list().map((session) => session.header.id) ?? []]) for (const job of jobs.list(owner)) observe(job);
		return () => {
			unsubscribe();
			this.jobs = void 0;
			this.bindings.clear();
		};
	}
	/**
	* Coalesce one delayed scan after activity that can create processes, never
	* more often than the configured minimum interval. Timers never hold the
	* process open, and every one is cleared by {@link startScheduler}'s disposer.
	*/
	schedule() {
		if (this.options.reconcileDelayMs <= 0 || this.timer) return;
		const wait = Math.max(this.options.reconcileDelayMs, this.lastScan + this.options.reconcileMinIntervalMs - Date.now());
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.reconcile().catch(() => {});
		}, wait);
		this.timer.unref();
	}
	/** Start the periodic sweep; the returned disposer clears every timer. */
	startScheduler() {
		if (this.options.reconcileIntervalMs > 0) {
			this.sweep = setInterval(() => {
				this.schedule();
			}, this.options.reconcileIntervalMs);
			this.sweep.unref();
		}
		return () => {
			if (this.sweep) clearInterval(this.sweep);
			this.sweep = void 0;
			if (this.timer) clearTimeout(this.timer);
			this.timer = void 0;
		};
	}
	refresh(containers = true) {
		if (!this.flight) {
			this.flightContainers = containers;
			this.flight = this.collect(containers).finally(() => {
				this.flight = void 0;
				this.flightContainers = false;
			});
			return this.flight;
		}
		if (!containers || this.flightContainers) return this.flight;
		return this.flight.then(async () => {
			try {
				await this.captureContainers?.();
			} catch (error) {
				this.warnings.push(String(error));
			}
		});
	}
	/** Collect process rows only; container discovery stays a page-triggered read. */
	reconcile() {
		return this.refresh(false);
	}
	async collect(containers) {
		this.warnings = [];
		const [scanned] = await Promise.all([this.scan().catch((error) => {
			this.warnings.push(String(error));
			return [];
		}), containers ? this.captureContainers?.().catch((error) => {
			this.warnings.push(String(error));
		}) : void 0]);
		this.lastScan = Date.now();
		const alive = scanned.filter((row) => row.alive && row.startedAt);
		const byPid = new Map(alive.map((row) => [row.pid, row]));
		const owned = alive.flatMap((info) => {
			const owner = info.marker ? decodeOwner(this.key, info.marker) : void 0;
			return owner ? [{
				info,
				owner
			}] : [];
		});
		const ownedByPid = new Map(owned.map((row) => [row.info.pid, row]));
		const ownedRoots = owned.filter(({ info, owner }) => {
			const parent = ownedByPid.get(info.parentPid);
			return !parent || parent.owner.call !== owner.call || parent.owner.session !== owner.session || identityOlder(info.startedAt, parent.info.startedAt);
		});
		const hostRoots = this.hostRoots(alive, byPid, owned.map((row) => row.info.pid), ownedRoots.map((row) => row.info.pid));
		this.hidden = /* @__PURE__ */ new Set([...owned.filter((row) => !ownedRoots.includes(row)).map((row) => identity(row.info.pid, row.info.startedAt)), ...hostRoots.hidden.map((row) => identity(row.pid, row.startedAt))]);
		this.processCalls = new Map(ownedRoots.map((row) => [identity(row.info.pid, row.info.startedAt), row.owner.call]));
		const independent = ownedRoots.filter((row) => !this.runningJob(row.owner.call));
		const host = new NativeProcesses().host;
		const candidates = [...independent.map(({ info, owner }) => ({
			info,
			name: info.name.slice(0, 512),
			project: owner.project,
			session: owner.session
		})), ...hostRoots.roots.map((info) => ({
			info,
			name: info.name.slice(0, 512),
			project: "",
			session: ""
		}))];
		if (!candidates.length) return;
		const present = await this.store.read();
		const missing = candidates.filter(({ info }) => !present.some((row) => row.kind === "process" && row.host === host && row.pid === info.pid && row.startedAt === info.startedAt));
		if (!missing.length) return;
		await this.store.update((rows) => {
			for (const { info, name, project, session } of missing) {
				if (rows.some((row) => row.kind === "process" && row.host === host && row.pid === info.pid && row.startedAt === info.startedAt)) continue;
				rows.push({
					id: randomUUID(),
					name,
					project,
					session,
					url: "",
					createdAt: (/* @__PURE__ */ new Date()).toISOString(),
					kind: "process",
					pid: info.pid,
					startedAt: info.startedAt,
					host,
					tree: true,
					pendingStop: []
				});
			}
		});
	}
	/**
	* Split the unmarked descendants of the Harness into visible roots and hidden
	* descendants. Two scans must see the same process before it is persisted, so
	* the short-lived helpers this plugin itself spawns never become records.
	*/
	hostRoots(alive, byPid, ownedPids, ownedRootPids) {
		if (!this.options.hostOwned) {
			this.hostSeen = /* @__PURE__ */ new Set();
			return {
				roots: [],
				hidden: []
			};
		}
		const owned = new Set(ownedPids);
		const ancestors = ancestorsOf(byPid, ownedRootPids);
		const candidates = hostDescendants(alive, process.pid).filter((row) => row.pid !== process.pid && !owned.has(row.pid) && !ancestors.has(row.pid));
		const candidatePids = new Set(candidates.map((row) => row.pid));
		const roots = candidates.filter((row) => !candidatePids.has(row.parentPid));
		const hidden = candidates.filter((row) => candidatePids.has(row.parentPid));
		const observed = new Set(candidates.map((row) => identity(row.pid, row.startedAt)));
		const stable = roots.filter((row) => this.hostSeen.has(identity(row.pid, row.startedAt)));
		this.hostSeen = observed;
		return {
			roots: stable,
			hidden
		};
	}
	runningJob(call) {
		if (!call || !this.jobs) return false;
		return [...this.bindings.values()].some((binding) => {
			if (binding.call !== call) return false;
			try {
				const current = this.jobs.get(binding.job.id, binding.job.owner);
				return current.startedAt === binding.job.startedAt && current.status === "running";
			} catch {
				return false;
			}
		});
	}
	visible(record) {
		if (record.kind !== "process") return true;
		const key = identity(record.pid, record.startedAt);
		return !this.hidden.has(key) && !this.runningJob(this.processCalls.get(key) ?? "");
	}
	async list() {
		if (!this.jobs) return [];
		const services = [];
		for (const binding of this.bindings.values()) {
			let job;
			try {
				job = this.jobs.get(binding.job.id, binding.job.owner);
			} catch {
				continue;
			}
			if (job.startedAt !== binding.job.startedAt || job.status !== "running") continue;
			const project = this.sessions()?.list().find((session) => session.header.id === job.owner)?.header.cwd ?? "";
			services.push({
				record: {
					id: binding.id,
					name: job.label.slice(0, 512),
					kind: "job",
					jobId: job.id,
					project,
					session: job.owner ?? "",
					url: "",
					createdAt: new Date(job.startedAt).toISOString()
				},
				status: "running",
				detail: "",
				remaining: 1
			});
		}
		return services;
	}
	async stop(id) {
		const binding = [...this.bindings.values()].find((binding) => binding.id === id);
		if (!binding) return;
		if (!this.jobs) throw new Error("The background task host is unavailable");
		const { job: previous } = binding;
		const job = this.jobs.get(previous.id, previous.owner);
		if (job.startedAt !== previous.startedAt || job.owner !== previous.owner) throw new Error("Background task identity changed; stop refused");
		if (job.status === "running" || job.status === "stopping") {
			this.jobs.kill(job.id, job.owner, "cancelled by the user");
			const settled = await this.jobs.wait(job.id, 1500, job.owner);
			if (settled.status === "running" || settled.status === "stopping") throw new Error("Background task is still stopping; refresh to check its status");
		}
		return {
			id,
			ok: true,
			message: "Stopped"
		};
	}
};
function identity(pid, started) {
	return `${pid}:${started}`;
}
function identityOlder(child, parent) {
	const last = (value) => value.split(":").at(-1);
	return /^\d+$/.test(last(child)) && /^\d+$/.test(last(parent)) && BigInt(last(child)) < BigInt(last(parent));
}
function installAutomatic(ctx, store, options = {}) {
	const automatic = new AutomaticServices(store, () => hostService(ctx, "sessions"), inspectProcesses, options);
	ctx.inject(["jobs"], (child) => {
		child.effect(() => automatic.attachJobs(hostService(child, "jobs")), "service-manager: observe background tasks");
	});
	ctx.inject(["shellEnv"], (child) => {
		child.effect(() => hostService(child, "shellEnv").register({
			name: "service-manager",
			variables: { [OWNER_ENV]: { description: "Host-owned service attribution inherited by child processes." } },
			resolve: (exec) => automatic.owner(exec)
		}), "service-manager: process attribution");
	});
	ctx.on("tools/execute", (exec, next) => {
		automatic.schedule();
		return automatic.call.run(String(exec.callId), next);
	});
	ctx.effect(() => automatic.startScheduler(), "service-manager: process reconciliation");
	return automatic;
}
//#endregion
//#region src/docker-discovery.ts
const quote = (text) => `'${text.replaceAll("'", "''")}'`;
async function prepareDockerShim(root, assets = new URL("./", import.meta.url)) {
	const proxy = fileURLToPath(new URL("docker-proxy.mjs", assets));
	const source = await readFile(new URL("docker-launcher.cs", assets), "utf8");
	const version = createHash("sha256").update(source).update(proxy).digest("hex").slice(0, 12);
	const shim = join(root, "docker-shim", version);
	await mkdir(shim, {
		recursive: true,
		mode: 448
	});
	if (process.platform === "win32") {
		const target = join(shim, "docker.exe");
		try {
			await readFile(target);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			const temporary = join(shim, `docker-${randomUUID()}.exe`);
			await powershell(`Add-Type -TypeDefinition ${quote(source)} -OutputAssembly ${quote(temporary)} -OutputType ConsoleApplication`);
			await rename(temporary, target).catch(async (error) => {
				try {
					await access(target);
				} catch {
					throw error;
				}
				await rm(temporary, { force: true });
			});
		}
	} else {
		const target = join(shim, "docker");
		await writeFile(target, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(proxy)} "$@"\n`, { mode: 448 });
		await chmod(target, 448);
	}
	return {
		shim,
		proxy
	};
}
function installDockerDiscovery(ctx, automatic, runner = run) {
	const root = dirname(automatic.store.file);
	const captures = join(root, "docker-contexts");
	let ready;
	ctx.inject(["shell"], (child) => {
		const shell = hostService(child, "shell");
		const previous = Object.getOwnPropertyDescriptor(shell, "execute");
		const original = shell.execute;
		const wrapped = async function(spec) {
			if (!spec.dshEnv?.DSH_SERVICE_OWNER) return original.call(this, spec);
			const local = function(executor) {
				for (let prototype = executor; prototype; prototype = Object.getPrototypeOf(prototype)) if (["LocalBashExecutor", "PwshLocalExecutor"].includes(prototype.constructor.name)) return true;
				return false;
			};
			if (!local(this) || spec.sandboxPolicy && spec.sandboxPolicy.mode !== "danger-full-access") return original.call(this, spec);
			const env = { ...spec.env };
			const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
			const originalPath = env[pathKey] ?? process.env.PATH ?? process.env.Path ?? "";
			if (!(await Promise.all(originalPath.split(delimiter).map(async (path) => {
				try {
					await access(join(path, process.platform === "win32" ? "docker.exe" : "docker"));
					return true;
				} catch {
					return false;
				}
			}))).some(Boolean)) return original.call(this, spec);
			ready ??= prepareDockerShim(root);
			let launcher;
			try {
				launcher = await ready;
			} catch (error) {
				ctx.logger("service-manager").warn("Docker launcher preparation failed: %s", String(error));
				return original.call(this, spec);
			}
			const { shim, proxy } = launcher;
			env[pathKey] = `${shim}${delimiter}${originalPath}`;
			return original.call(this, {
				...spec,
				env,
				dshEnv: {
					...spec.dshEnv,
					DSH_SERVICE_SHIM: shim,
					DSH_SERVICE_DOCKER_PROXY: proxy,
					DSH_SERVICE_NODE: process.execPath,
					DSH_SERVICE_CAPTURE_DIR: captures,
					DSH_SERVICE_REGISTRY_KEY: automatic.key
				}
			});
		};
		child.effect(() => {
			Object.defineProperty(shell, "execute", {
				configurable: true,
				writable: true,
				value: wrapped
			});
			return () => {
				if (Object.getOwnPropertyDescriptor(shell, "execute")?.value !== wrapped) return;
				if (previous) Object.defineProperty(shell, "execute", previous);
				else Reflect.deleteProperty(shell, "execute");
			};
		}, "service-manager: Docker launch attribution");
	});
	automatic.captureContainers = async () => {
		let files;
		try {
			files = await readdir(captures);
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		for (const file of files.filter((file) => file.endsWith(".json"))) {
			const { context } = JSON.parse(await readFile(join(captures, file), "utf8"));
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(context)) continue;
			const ids = (await runner("docker", [
				"--context",
				context,
				"ps",
				"-a",
				"--no-trunc",
				"--filter",
				`label=io.dsh.service-manager.registry=${automatic.key}`,
				"--format",
				"{{.ID}}"
			], 2e3)).split(/\s+/).filter((id) => /^[a-f0-9]{64}$/.test(id));
			if (!ids.length) continue;
			const discovered = JSON.parse(await runner("docker", [
				"--context",
				context,
				"inspect",
				...ids
			], 2e3)).flatMap((container) => {
				const owner = decodeOwner(automatic.key, container.Config.Labels?.["io.dsh.service-manager.owner"] ?? "");
				return owner && /^[a-f0-9]{64}$/.test(container.Id) ? [{
					container,
					owner
				}] : [];
			});
			const rows = await automatic.store.read();
			if (!discovered.some(({ container }) => !rows.some((row) => row.kind === "container" && row.context === context && row.containerId === container.Id))) continue;
			await automatic.store.update((rows) => {
				for (const { container, owner } of discovered) {
					if (rows.some((row) => row.kind === "container" && row.context === context && row.containerId === container.Id)) continue;
					rows.push({
						id: randomUUID(),
						name: container.Name.replace(/^\//, "").slice(0, 512),
						kind: "container",
						context,
						containerId: container.Id,
						project: owner.project,
						session: owner.session,
						createdAt: (/* @__PURE__ */ new Date()).toISOString(),
						url: ""
					});
				}
			});
		}
	};
}
//#endregion
//#region src/index.ts
const name = "service-manager";
const inject = [];
const Config = z.object({
	dshHome: z.string().description("Harness user-data home override"),
	file: z.string().description("Registry JSON file override"),
	hostOwned: z.boolean().description("Track Harness-spawned processes without an ownership marker (default true)"),
	reconcileDelayMs: z.number().description("Delay before a reconciliation scan after activity, 0 disables it (default 1500)"),
	reconcileMinIntervalMs: z.number().description("Minimum interval between reconciliation scans (default 10000)"),
	reconcileIntervalMs: z.number().description("Periodic reconciliation sweep interval, 0 disables it (default 30000)")
});
function apply(ctx, config = {}) {
	const registry = new ServiceRegistry(new RegistryStore(config.file ? resolve(config.file) : join(resolveDshHome(config.dshHome), "service-manager", "services.json")));
	const automatic = installAutomatic(ctx, registry.store, {
		...config.hostOwned === void 0 ? {} : { hostOwned: config.hostOwned },
		reconcileDelayMs: Math.max(0, config.reconcileDelayMs ?? 1500),
		reconcileMinIntervalMs: Math.max(0, config.reconcileMinIntervalMs ?? 1e4),
		reconcileIntervalMs: Math.max(0, config.reconcileIntervalMs ?? 3e4)
	});
	registry.discovery = automatic;
	installDockerDiscovery(ctx, automatic);
	new ServiceManager(ctx, registry);
}
//#endregion
export { Config, RegistryStore, ServiceManager, ServiceRegistry, apply, inject, name };
