window.__ModuleLoader__.load({
	id: "@guowenzhang/dsh-service-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/remote.ts
		const REMOTE_NAMESPACE = "serviceManager";
		const passthrough = { parse: (value) => value };
		function codec(typeSymbol) {
			return {
				mode: "strict",
				typeSymbol,
				schema: passthrough,
				create: () => passthrough
			};
		}
		function descriptor(method) {
			const owner = `@guowenzhang/dsh-service-manager#${REMOTE_NAMESPACE}/${method}`;
			return {
				id: owner,
				service: REMOTE_NAMESPACE,
				namespace: REMOTE_NAMESPACE,
				method,
				invocation: { kind: "direct" },
				parameters: [{
					name: "request",
					wire: "request",
					source: "json",
					codec: codec(`${owner}:request`)
				}],
				result: codec(`${owner}:result`)
			};
		}
		const TYPERT_REMOTE = {
			package: "@guowenzhang/dsh-service-manager",
			descriptors: [
				"listServices",
				"registerService",
				"stopServices",
				"removeServices"
			].map(descriptor)
		};
		//#endregion
		//#region src/client/locales.ts
		const NS = "settings.serviceManager";
		const zh = {
			nav: "服务管理",
			title: "服务管理",
			hint: "按工作区和会话查看服务；默认只显示运行中的服务。",
			workspace: "工作区",
			session: "会话",
			services: "服务",
			unassignedWorkspace: "未关联工作区",
			unassignedSession: "未关联会话",
			process: "进程",
			container: "容器",
			job: "后台任务",
			running: "运行中",
			stopped: "已退出",
			changed: "PID 已被复用",
			unknown: "状态未知",
			ended: "已结束",
			showEnded: "显示已结束",
			openSession: "打开会话",
			openSessionFailed: "无法打开该会话",
			refresh: "刷新",
			refreshing: "查询中…",
			loadFailed: "查询失败，请重试。",
			empty: "没有正在运行的服务",
			emptyHint: "后台任务和自动发现的服务会在这里显示。",
			forceStopHint: "确认强制停止此服务？未保存的数据可能丢失。",
			forceStop: "强制停止",
			stopAll: "全部关闭",
			stopAllHint: "确认关闭全部 {count} 个正在运行的服务？未保存的数据可能丢失。",
			stopAllFailed: "有 {count} 个服务未能关闭",
			cancel: "取消",
			close: "关闭",
			busy: "停止中…",
			error: "操作未完成",
			discoveryWarning: "部分资源未能自动发现"
		};
		const en = {
			nav: "Services",
			title: "Services",
			hint: "Services by workspace and session; running services only by default.",
			workspace: "Workspaces",
			session: "Session",
			services: "Services",
			unassignedWorkspace: "No workspace",
			unassignedSession: "No session",
			process: "Process",
			container: "Container",
			job: "Background task",
			running: "Running",
			stopped: "Exited",
			changed: "PID reused",
			unknown: "Status unknown",
			ended: "Ended",
			showEnded: "Show ended",
			openSession: "Open session",
			openSessionFailed: "Could not open the session",
			refresh: "Refresh",
			refreshing: "Checking…",
			loadFailed: "Could not load services. Please retry.",
			empty: "No running services",
			emptyHint: "Background tasks and automatically discovered services appear here.",
			forceStopHint: "Force stop this service? Unsaved data may be lost.",
			forceStop: "Force stop",
			stopAll: "Stop all",
			stopAllHint: "Stop all {count} running services? Unsaved data may be lost.",
			stopAllFailed: "{count} services could not be stopped",
			cancel: "Cancel",
			close: "Close",
			busy: "Stopping…",
			error: "Action incomplete",
			discoveryWarning: "Some resources could not be discovered"
		};
		//#endregion
		//#region src/client/service-tree.ts
		function projectPath(project) {
			const windows = /^(?:[a-z]:[\\/]|(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+)/i.test(project);
			if (!windows && !project.startsWith("/")) return;
			const normalized = (windows ? project.replace(/\\/g, "/") : project).replace(/\/+$/, "") || "/";
			return {
				key: `${windows ? "windows" : "posix"}:${windows ? normalized.toLowerCase() : normalized}`,
				project,
				name: normalized.split("/").pop() || "",
				windows
			};
		}
		const sessionIdentity = /^session-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
		const bareSessionIdentity = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
		/**
		* The Harness session a record belongs to, when the record names one. Current
		* sessions carry the `session-` prefix; sessions stored before it are bare
		* UUIDs. A user-written label is never a navigation target.
		*/
		function sessionTargetId(session) {
			return sessionIdentity.test(session) || bareSessionIdentity.test(session) ? session : void 0;
		}
		/** Group services without merging sessions across workspaces. */
		function groupServices(services, options = {}) {
			const running = services.filter((service) => service.status === "running");
			const visible = options.includeEnded ? services : running;
			const pathsBySession = /* @__PURE__ */ new Map();
			for (const { record } of running) {
				const path = projectPath(record.project);
				if (!path || !sessionIdentity.test(record.session)) continue;
				let paths = pathsBySession.get(record.session);
				if (!paths) pathsBySession.set(record.session, paths = /* @__PURE__ */ new Map());
				if (!paths.has(path.key)) paths.set(path.key, path);
			}
			const workspaces = /* @__PURE__ */ new Map();
			const sessions = /* @__PURE__ */ new Map();
			for (const service of visible) {
				const { project, session } = service.record;
				let path = projectPath(project);
				if (!path && project && !/[\\/]/.test(project)) {
					const candidates = [...pathsBySession.get(session)?.values() ?? []].filter((candidate) => candidate.windows ? candidate.name.toLowerCase() === project.toLowerCase() : candidate.name === project);
					if (candidates.length === 1) path = candidates[0];
				}
				const key = path?.key ?? `label:${project}`;
				let workspace = workspaces.get(key);
				if (!workspace) {
					workspace = {
						project: path?.project ?? project,
						sessions: [],
						count: 0,
						ended: 0
					};
					workspaces.set(key, workspace);
					sessions.set(workspace, /* @__PURE__ */ new Map());
				}
				const account = sessions.get(workspace);
				let group = account.get(session);
				if (!group) {
					group = {
						session,
						services: [],
						running: 0,
						ended: 0
					};
					account.set(session, group);
					workspace.sessions.push(group);
				}
				group.services.push(service);
				if (service.status === "running") {
					group.running++;
					workspace.count++;
				} else {
					group.ended++;
					workspace.ended++;
				}
			}
			for (const workspace of workspaces.values()) for (const group of workspace.sessions) group.services.sort((left, right) => Number(right.status === "running") - Number(left.status === "running"));
			return [...workspaces.values()];
		}
		/** Show the directory name; the full registered path remains in the tooltip. */
		function projectLabel(project, fallback) {
			return project.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || project || fallback;
		}
		const isIdentity = (value) => sessionIdentity.test(value) || bareSessionIdentity.test(value);
		/**
		* Prefer the name the Session list shows in the sidebar, then preserve explicit
		* session labels, then shorten opaque identities. A name that is only the
		* identity again is no improvement over the shortened form.
		*/
		function sessionLabel(session, title, label, fallback) {
			const name = title?.trim();
			if (name && !isIdentity(name)) return name;
			if (!session) return fallback;
			if (sessionIdentity.test(session)) return `${label} · ${session.slice(8, 16)}`;
			if (bareSessionIdentity.test(session)) return `${label} · ${session.slice(0, 8)}`;
			return session;
		}
		//#endregion
		//#region \0dsh-css:C:\02-codespace\DeepSeek\dsh-service-manager\src\client\ServiceSection.module.css.mjs
		const css = ".IfS7Xq_section{width:100%;color:var(--dsw-alias-label-primary);flex-direction:column;gap:20px;font-size:13px;display:flex}.IfS7Xq_header{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}.IfS7Xq_controls{flex-wrap:wrap;flex-shrink:0;justify-content:flex-end;align-items:center;gap:8px;display:flex}.IfS7Xq_toggle{color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;align-items:center;gap:6px;font-size:12px;display:inline-flex}.IfS7Xq_toggle input{accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;margin:0}.IfS7Xq_header h2{align-items:center;gap:10px;margin:0 0 6px;font-size:17px;font-weight:600;display:flex}.IfS7Xq_total{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:1px 7px;font-size:12px;font-weight:500}.IfS7Xq_hint,.IfS7Xq_meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}.IfS7Xq_hint{margin:0}.IfS7Xq_workspaces,.IfS7Xq_sessions,.IfS7Xq_services{margin:0;padding:0;list-style:none}.IfS7Xq_workspaces{flex-direction:column;gap:16px;display:flex}.IfS7Xq_workspace{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}.IfS7Xq_workspace>summary{background:var(--dsw-alias-bg-layer-1);padding:12px 14px;font-weight:600}.IfS7Xq_workspace summary,.IfS7Xq_session summary{cursor:pointer;align-items:center;gap:8px;list-style:none;display:flex}.IfS7Xq_workspace summary::-webkit-details-marker,.IfS7Xq_session summary::-webkit-details-marker{display:none}.IfS7Xq_workspace summary:before,.IfS7Xq_session summary:before{content:\"\";border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);flex-shrink:0;width:5px;height:5px;transform:rotate(-45deg)}.IfS7Xq_workspace[open]>summary:before,.IfS7Xq_session[open]>summary:before{transform:rotate(45deg)}.IfS7Xq_groupLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.IfS7Xq_count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;align-items:center;gap:4px;margin-left:auto;font-size:11px;font-weight:400;display:inline-flex}.IfS7Xq_countEnded{color:var(--dsw-alias-label-tertiary);opacity:.8}.IfS7Xq_jump{color:var(--dsw-alias-state-business-primary);font:inherit;cursor:pointer;background:0 0;border:0;border-radius:4px;flex-shrink:0;padding:2px 4px;font-size:12px}.IfS7Xq_jump:hover{text-underline-offset:2px;text-decoration:underline}.IfS7Xq_sessions{padding:4px 14px 10px 24px}.IfS7Xq_session>summary{color:var(--dsw-alias-label-secondary);padding:10px 0;font-size:12px}.IfS7Xq_services{border-left:1px solid var(--dsw-alias-border-l2);margin-left:2px;padding-left:16px}.IfS7Xq_service{align-items:center;gap:10px;padding:10px 0;display:flex}.IfS7Xq_service+.IfS7Xq_service{border-top:.5px solid var(--dsw-alias-border-l2)}.IfS7Xq_dot,.IfS7Xq_emptyDot{background:var(--dsw-alias-state-success-primary);border-radius:50%;flex-shrink:0;width:6px;height:6px}.IfS7Xq_dot[data-status=stopped],.IfS7Xq_dot[data-status=changed],.IfS7Xq_dot[data-status=unknown]{background:var(--dsw-alias-label-tertiary);opacity:.4}.IfS7Xq_status{color:var(--dsw-alias-label-tertiary);flex-shrink:0;font-size:12px}.IfS7Xq_service[data-status=stopped] .IfS7Xq_info strong,.IfS7Xq_service[data-status=changed] .IfS7Xq_info strong,.IfS7Xq_service[data-status=unknown] .IfS7Xq_info strong{color:var(--dsw-alias-label-secondary);font-weight:400}.IfS7Xq_info{flex-direction:column;flex:1;gap:3px;min-width:0;display:flex}.IfS7Xq_info strong{text-overflow:ellipsis;white-space:nowrap;font-weight:500;overflow:hidden}.IfS7Xq_meta{text-overflow:ellipsis;white-space:nowrap;font-size:11px;overflow:hidden}.IfS7Xq_url{color:var(--dsw-alias-state-business-primary);text-underline-offset:2px;text-decoration:underline}.IfS7Xq_url:hover{text-decoration-thickness:2px}.IfS7Xq_service>button{flex-shrink:0}.IfS7Xq_empty{text-align:center;color:var(--dsw-alias-label-secondary);padding:64px 16px;font-size:13px}.IfS7Xq_emptyDot{background:var(--dsw-alias-label-tertiary);opacity:.4;width:8px;height:8px;margin:0 auto 16px;display:block}.IfS7Xq_empty strong{font-weight:500}.IfS7Xq_empty p{color:var(--dsw-alias-label-tertiary);margin:8px 0 0;font-size:12px}.IfS7Xq_error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font-size:12px}.IfS7Xq_actions{justify-content:flex-end;gap:8px;display:flex}.IfS7Xq_target{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;margin:0 0 16px;font-size:13px;font-weight:600}.IfS7Xq_targets{max-height:160px;color:var(--dsw-alias-label-secondary);margin:0;padding-left:18px;font-size:12px;list-style:outside;overflow:auto}.IfS7Xq_targets li{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.IfS7Xq_workspace summary:focus-visible,.IfS7Xq_session summary:focus-visible,.IfS7Xq_url:focus-visible,.IfS7Xq_jump:focus-visible,.IfS7Xq_toggle input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:4px}@media (width<=480px){.IfS7Xq_sessions{padding-left:16px;padding-right:10px}.IfS7Xq_services{padding-left:10px}.IfS7Xq_service{gap:7px}}";
		const tagId = "@guowenzhang/dsh-service-manager/ServiceSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ServiceSection_module_css_default = {
			"actions": "IfS7Xq_actions",
			"controls": "IfS7Xq_controls",
			"count": "IfS7Xq_count",
			"countEnded": "IfS7Xq_countEnded",
			"dot": "IfS7Xq_dot",
			"empty": "IfS7Xq_empty",
			"emptyDot": "IfS7Xq_emptyDot",
			"error": "IfS7Xq_error",
			"groupLabel": "IfS7Xq_groupLabel",
			"header": "IfS7Xq_header",
			"hint": "IfS7Xq_hint",
			"info": "IfS7Xq_info",
			"jump": "IfS7Xq_jump",
			"meta": "IfS7Xq_meta",
			"section": "IfS7Xq_section",
			"service": "IfS7Xq_service",
			"services": "IfS7Xq_services",
			"session": "IfS7Xq_session",
			"sessions": "IfS7Xq_sessions",
			"status": "IfS7Xq_status",
			"target": "IfS7Xq_target",
			"targets": "IfS7Xq_targets",
			"toggle": "IfS7Xq_toggle",
			"total": "IfS7Xq_total",
			"url": "IfS7Xq_url",
			"workspace": "IfS7Xq_workspace",
			"workspaces": "IfS7Xq_workspaces"
		};
		//#endregion
		//#region src/client/ServiceSection.tsx
		const message = (error) => error instanceof Error ? error.message : String(error);
		const noTitles$1 = /* @__PURE__ */ new Map();
		const noSubscription$1 = () => {};
		/** Name the first failures; a batch can report more than a notice can read. */
		function describeFailures(failures, names) {
			const shown = failures.slice(0, 3).map((row) => `${names.get(row.id) ?? row.id}: ${row.message}`);
			return failures.length > shown.length ? `${shown.join("; ")} …` : shown.join("; ");
		}
		function ServiceSection({ list, stop, openSession, sessionTitles, subscribeSessions, close, t }) {
			const [data, setData] = (0, react.useState)({
				services: [],
				file: ""
			});
			const [loading, setLoading] = (0, react.useState)(true);
			const [loaded, setLoaded] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)("");
			const [showEnded, setShowEnded] = (0, react.useState)(false);
			const [action, setAction] = (0, react.useState)(null);
			const [stoppingAll, setStoppingAll] = (0, react.useState)(false);
			const mounted = (0, react.useRef)(false);
			const generation = (0, react.useRef)(0);
			const readTitles = (0, react.useCallback)(() => sessionTitles?.() ?? noTitles$1, [sessionTitles]);
			const watchSessions = (0, react.useCallback)((notify) => subscribeSessions?.(notify) ?? noSubscription$1, [subscribeSessions]);
			const titles = (0, react.useSyncExternalStore)(watchSessions, readTitles, readTitles);
			const refresh = (0, react.useCallback)(async () => {
				const revision = ++generation.current;
				setLoading(true);
				try {
					const next = await list();
					if (!mounted.current || revision !== generation.current) return;
					setData(next);
					setLoaded(true);
					setError("");
				} catch (err) {
					if (mounted.current && revision === generation.current) {
						setData({
							services: [],
							file: ""
						});
						setLoaded(false);
						setError(message(err));
					}
				} finally {
					if (mounted.current && revision === generation.current) setLoading(false);
				}
			}, [list]);
			(0, react.useEffect)(() => {
				mounted.current = true;
				refresh();
				return () => {
					mounted.current = false;
					generation.current++;
				};
			}, [refresh]);
			const groups = groupServices(data.services, { includeEnded: showEnded });
			const running = groups.reduce((count, group) => count + group.count, 0);
			const ended = groups.reduce((count, group) => count + group.ended, 0);
			const runningServices = data.services.filter((service) => service.status === "running");
			const confirm = async () => {
				if (!action || busy) return;
				const pending = action;
				setBusy(true);
				setError("");
				try {
					const result = await stop({
						ids: [pending.id],
						force: true
					});
					if (!mounted.current) return;
					const failure = result.results.find((row) => !row.ok);
					await refresh();
					if (!mounted.current) return;
					setAction(null);
					if (failure) setError(`${pending.name}: ${failure.message}`);
				} catch (err) {
					if (mounted.current) {
						setAction(null);
						setError(message(err));
					}
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			const confirmAll = async () => {
				if (busy) return;
				const targets = runningServices;
				if (!targets.length) {
					setStoppingAll(false);
					return;
				}
				const names = new Map(targets.map((service) => [service.record.id, service.record.name]));
				setBusy(true);
				setError("");
				try {
					const failures = (await stop({
						ids: targets.map((service) => service.record.id),
						force: true
					})).results.filter((row) => !row.ok);
					await refresh();
					if (!mounted.current) return;
					setStoppingAll(false);
					if (failures.length) setError(`${t("stopAllFailed", { count: failures.length })}: ${describeFailures(failures, names)}`);
				} catch (err) {
					if (mounted.current) {
						setStoppingAll(false);
						setError(message(err));
					}
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			const jump = (session) => {
				if (!openSession) return;
				setError("");
				try {
					openSession(session);
					close?.();
				} catch (err) {
					if (mounted.current) setError(`${t("openSessionFailed")}: ${message(err)}`);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: ServiceSection_module_css_default.section,
				"aria-label": t("title"),
				"aria-busy": loading || busy,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: ServiceSection_module_css_default.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h2", { children: [
							t("title"),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ServiceSection_module_css_default.total,
								children: running
							}),
							showEnded && ended > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: ServiceSection_module_css_default.total,
								children: [
									t("ended"),
									" ",
									ended
								]
							})
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: ServiceSection_module_css_default.hint,
							children: t("hint")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ServiceSection_module_css_default.controls,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: ServiceSection_module_css_default.toggle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: showEnded,
										disabled: busy,
										onChange: (event) => {
											setShowEnded(event.target.checked);
										}
									}), t("showEnded")]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									disabled: loading || busy,
									onClick: () => {
										refresh();
									},
									children: loading ? t("refreshing") : t("refresh")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									disabled: loading || busy || !running,
									onClick: () => {
										setStoppingAll(true);
									},
									children: t("stopAll")
								})
							]
						})]
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: ServiceSection_module_css_default.error,
						role: "alert",
						children: [
							t("error"),
							": ",
							error
						]
					}),
					data.warnings?.map((warning) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: ServiceSection_module_css_default.error,
						role: "alert",
						children: [
							t("discoveryWarning"),
							": ",
							warning
						]
					}, warning)),
					!loaded ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: ServiceSection_module_css_default.empty,
						role: "status",
						children: loading ? t("refreshing") : t("loadFailed")
					}) : !groups.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ServiceSection_module_css_default.empty,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: ServiceSection_module_css_default.emptyDot }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("empty") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("emptyHint") })
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: ServiceSection_module_css_default.workspaces,
						"aria-label": t("workspace"),
						children: groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
							className: ServiceSection_module_css_default.workspace,
							open: true,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
								title: group.project,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: ServiceSection_module_css_default.groupLabel,
									children: projectLabel(group.project, t("unassignedWorkspace"))
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: ServiceSection_module_css_default.count,
									children: group.count
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: ServiceSection_module_css_default.sessions,
								"aria-label": t("session"),
								children: group.sessions.map((session) => {
									const target = sessionTargetId(session.session);
									return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
										className: ServiceSection_module_css_default.session,
										open: true,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
											title: session.session,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: ServiceSection_module_css_default.groupLabel,
													children: sessionLabel(session.session, titles.get(session.session), t("session"), t("unassignedSession"))
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: ServiceSection_module_css_default.count,
													children: [session.running, showEnded && session.ended > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: ServiceSection_module_css_default.countEnded,
														title: t("ended"),
														children: ["+", session.ended]
													})]
												}),
												target && openSession && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: ServiceSection_module_css_default.jump,
													onClick: (event) => {
														event.preventDefault();
														event.stopPropagation();
														jump(target);
													},
													children: t("openSession")
												})
											]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
											className: ServiceSection_module_css_default.services,
											"aria-label": t("services"),
											children: session.services.map(({ record, status, detail }) => {
												const identity = record.kind === "process" ? String(record.pid) : record.kind === "container" ? `${record.context} · ${record.containerId}` : record.jobId;
												return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
													className: ServiceSection_module_css_default.service,
													"data-status": status,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: ServiceSection_module_css_default.dot,
															"data-status": status,
															title: t(status)
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: ServiceSection_module_css_default.info,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
																title: record.name,
																children: record.name
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																className: ServiceSection_module_css_default.meta,
																title: status === "running" ? identity : detail || identity,
																children: [
																	t(record.kind),
																	" · ",
																	record.kind === "process" ? `PID ${record.pid}` : record.kind === "container" ? record.containerId.slice(0, 12) : record.jobId,
																	record.url && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
																		className: ServiceSection_module_css_default.url,
																		href: record.url,
																		target: "_blank",
																		rel: "noopener noreferrer",
																		title: record.url,
																		children: record.url
																	})] })
																]
															})]
														}),
														status === "running" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
															variant: "outline",
															size: "sm",
															disabled: busy || loading,
															onClick: () => setAction(record),
															children: t("forceStop")
														}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: ServiceSection_module_css_default.status,
															title: detail || void 0,
															children: t(status)
														})
													]
												}, record.id);
											})
										})]
									}) }, session.session);
								})
							})]
						}) }, group.project))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: action !== null,
						onClose: () => {
							if (!busy) setAction(null);
						},
						title: t("forceStop"),
						closeLabel: t("close"),
						description: t("forceStopHint"),
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ServiceSection_module_css_default.actions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: busy,
								onClick: () => setAction(null),
								"data-modal-autofocus": true,
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								disabled: busy,
								onClick: () => {
									confirm();
								},
								children: busy ? t("busy") : t("forceStop")
							})]
						}),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: ServiceSection_module_css_default.target,
							children: action?.name
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: stoppingAll,
						onClose: () => {
							if (!busy) setStoppingAll(false);
						},
						title: t("stopAll"),
						closeLabel: t("close"),
						description: t("stopAllHint", { count: running }),
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ServiceSection_module_css_default.actions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: busy,
								onClick: () => setStoppingAll(false),
								"data-modal-autofocus": true,
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								disabled: busy,
								onClick: () => {
									confirmAll();
								},
								children: busy ? t("busy") : t("stopAll")
							})]
						}),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: ServiceSection_module_css_default.targets,
							children: runningServices.map((service) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
								title: service.record.name,
								children: service.record.name
							}, service.record.id))
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		const noTitles = /* @__PURE__ */ new Map();
		const noSubscription = () => {};
		async function unwrap(call) {
			const result = await call;
			if (!result.ok) throw new Error(result.error.message);
			return result.value;
		}
		const inject = [
			"slots",
			"locale",
			"remote"
		];
		async function apply(ctx) {
			const off = await ctx.remote.$mount(TYPERT_REMOTE);
			ctx.effect(() => () => off(), "service-manager: remote mount");
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "service-manager: dictionaries");
			const t = ctx.locale.bind(NS);
			const remote = () => {
				const service = ctx.get(`remote.${REMOTE_NAMESPACE}`);
				if (!service) throw new Error("serviceManager namespace is not mounted");
				return service;
			};
			const sessions = () => ctx.get("sessions");
			let titles;
			const sessionTitles = () => {
				const snapshot = sessions()?.list?.getSnapshot();
				if (!snapshot) return noTitles;
				if (titles?.snapshot !== snapshot) {
					const value = /* @__PURE__ */ new Map();
					for (const [id, row] of Object.entries(snapshot.byId ?? {})) {
						const name = row?.displayTitle?.trim();
						if (name) value.set(id, name);
					}
					titles = {
						snapshot,
						value
					};
				}
				return titles.value;
			};
			const face = {
				list: () => unwrap(remote().listServices({})),
				stop: (request) => unwrap(remote().stopServices(request)),
				openSession: (session) => {
					const workspace = ctx.get("uiWorkspace");
					if (typeof workspace?.openSession !== "function") throw new Error("session navigation is unavailable");
					workspace.openSession(session);
				},
				sessionTitles,
				subscribeSessions: (listener) => sessions()?.list?.subscribe(listener) ?? noSubscription
			};
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "service-manager",
				order: 15.5,
				label: () => t("nav"),
				locale: NS,
				inject: () => face
			}, ServiceSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
