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
			hint: "按工作区和会话查看正在运行的服务。",
			workspace: "工作区",
			session: "会话",
			services: "服务",
			unassignedWorkspace: "未关联工作区",
			unassignedSession: "未关联会话",
			process: "进程",
			container: "容器",
			job: "后台任务",
			running: "运行中",
			refresh: "刷新",
			refreshing: "查询中…",
			loadFailed: "查询失败，请重试。",
			empty: "没有正在运行的服务",
			emptyHint: "后台任务和自动发现的服务会在这里显示。",
			forceStopHint: "确认强制停止此服务？未保存的数据可能丢失。",
			forceStop: "强制停止",
			cancel: "取消",
			close: "关闭",
			busy: "停止中…",
			error: "操作未完成",
			discoveryWarning: "部分资源未能自动发现"
		};
		const en = {
			nav: "Services",
			title: "Services",
			hint: "Running services grouped by workspace and session.",
			workspace: "Workspaces",
			session: "Session",
			services: "Services",
			unassignedWorkspace: "No workspace",
			unassignedSession: "No session",
			process: "Process",
			container: "Container",
			job: "Background task",
			running: "Running",
			refresh: "Refresh",
			refreshing: "Checking…",
			loadFailed: "Could not load services. Please retry.",
			empty: "No running services",
			emptyHint: "Background tasks and automatically discovered services appear here.",
			forceStopHint: "Force stop this service? Unsaved data may be lost.",
			forceStop: "Force stop",
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
		/** Group confirmed running services without merging sessions across workspaces. */
		function groupRunningServices(services) {
			const running = services.filter((service) => service.status === "running");
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
			for (const service of running) {
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
						count: 0
					};
					workspaces.set(key, workspace);
					sessions.set(workspace, /* @__PURE__ */ new Map());
				}
				const account = sessions.get(workspace);
				let group = account.get(session);
				if (!group) {
					group = {
						session,
						services: []
					};
					account.set(session, group);
					workspace.sessions.push(group);
				}
				group.services.push(service);
				workspace.count++;
			}
			return [...workspaces.values()];
		}
		/** Show the directory name; the full registered path remains in the tooltip. */
		function projectLabel(project, fallback) {
			return project.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || project || fallback;
		}
		/** Shorten opaque session identities while preserving explicit session labels. */
		function sessionLabel(session, label, fallback) {
			if (!session) return fallback;
			return /^session-[\da-f-]+$/i.test(session) ? `${label} · ${session.slice(8, 16)}` : session;
		}
		//#endregion
		//#region \0dsh-css:C:\02-codespace\DeepSeek\dsh-service-manager\src\client\ServiceSection.module.css.mjs
		const css = ".IfS7Xq_section{width:100%;color:var(--dsw-alias-label-primary);flex-direction:column;gap:20px;font-size:13px;display:flex}.IfS7Xq_header{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}.IfS7Xq_header h2{align-items:center;gap:10px;margin:0 0 6px;font-size:17px;font-weight:600;display:flex}.IfS7Xq_total{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:1px 7px;font-size:12px;font-weight:500}.IfS7Xq_hint,.IfS7Xq_meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}.IfS7Xq_hint{margin:0}.IfS7Xq_workspaces,.IfS7Xq_sessions,.IfS7Xq_services{margin:0;padding:0;list-style:none}.IfS7Xq_workspaces{flex-direction:column;gap:16px;display:flex}.IfS7Xq_workspace{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}.IfS7Xq_workspace>summary{background:var(--dsw-alias-bg-layer-1);padding:12px 14px;font-weight:600}.IfS7Xq_workspace summary,.IfS7Xq_session summary{cursor:pointer;align-items:center;gap:8px;list-style:none;display:flex}.IfS7Xq_workspace summary::-webkit-details-marker,.IfS7Xq_session summary::-webkit-details-marker{display:none}.IfS7Xq_workspace summary:before,.IfS7Xq_session summary:before{content:\"\";border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);flex-shrink:0;width:5px;height:5px;transform:rotate(-45deg)}.IfS7Xq_workspace[open]>summary:before,.IfS7Xq_session[open]>summary:before{transform:rotate(45deg)}.IfS7Xq_groupLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.IfS7Xq_count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;margin-left:auto;font-size:11px;font-weight:400}.IfS7Xq_sessions{padding:4px 14px 10px 24px}.IfS7Xq_session>summary{color:var(--dsw-alias-label-secondary);padding:10px 0;font-size:12px}.IfS7Xq_services{border-left:1px solid var(--dsw-alias-border-l2);margin-left:2px;padding-left:16px}.IfS7Xq_service{align-items:center;gap:10px;padding:10px 0;display:flex}.IfS7Xq_service+.IfS7Xq_service{border-top:.5px solid var(--dsw-alias-border-l2)}.IfS7Xq_dot,.IfS7Xq_emptyDot{background:var(--dsw-alias-state-success-primary);border-radius:50%;flex-shrink:0;width:6px;height:6px}.IfS7Xq_info{flex-direction:column;flex:1;gap:3px;min-width:0;display:flex}.IfS7Xq_info strong{text-overflow:ellipsis;white-space:nowrap;font-weight:500;overflow:hidden}.IfS7Xq_meta{text-overflow:ellipsis;white-space:nowrap;font-size:11px;overflow:hidden}.IfS7Xq_url{color:var(--dsw-alias-state-business-primary);text-underline-offset:2px;text-decoration:underline}.IfS7Xq_url:hover{text-decoration-thickness:2px}.IfS7Xq_service>button{flex-shrink:0}.IfS7Xq_empty{text-align:center;color:var(--dsw-alias-label-secondary);padding:64px 16px;font-size:13px}.IfS7Xq_emptyDot{background:var(--dsw-alias-label-tertiary);opacity:.4;width:8px;height:8px;margin:0 auto 16px;display:block}.IfS7Xq_empty strong{font-weight:500}.IfS7Xq_empty p{color:var(--dsw-alias-label-tertiary);margin:8px 0 0;font-size:12px}.IfS7Xq_error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font-size:12px}.IfS7Xq_actions{justify-content:flex-end;gap:8px;display:flex}.IfS7Xq_target{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;margin:0 0 16px;font-size:13px;font-weight:600}.IfS7Xq_workspace summary:focus-visible,.IfS7Xq_session summary:focus-visible,.IfS7Xq_url:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:4px}@media (width<=480px){.IfS7Xq_sessions{padding-left:16px;padding-right:10px}.IfS7Xq_services{padding-left:10px}.IfS7Xq_service{gap:7px}}";
		const tagId = "@guowenzhang/dsh-service-manager/ServiceSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ServiceSection_module_css_default = {
			"actions": "IfS7Xq_actions",
			"count": "IfS7Xq_count",
			"dot": "IfS7Xq_dot",
			"empty": "IfS7Xq_empty",
			"emptyDot": "IfS7Xq_emptyDot",
			"error": "IfS7Xq_error",
			"groupLabel": "IfS7Xq_groupLabel",
			"header": "IfS7Xq_header",
			"hint": "IfS7Xq_hint",
			"info": "IfS7Xq_info",
			"meta": "IfS7Xq_meta",
			"section": "IfS7Xq_section",
			"service": "IfS7Xq_service",
			"services": "IfS7Xq_services",
			"session": "IfS7Xq_session",
			"sessions": "IfS7Xq_sessions",
			"target": "IfS7Xq_target",
			"total": "IfS7Xq_total",
			"url": "IfS7Xq_url",
			"workspace": "IfS7Xq_workspace",
			"workspaces": "IfS7Xq_workspaces"
		};
		//#endregion
		//#region src/client/ServiceSection.tsx
		const message = (error) => error instanceof Error ? error.message : String(error);
		function ServiceSection({ list, stop, t }) {
			const [data, setData] = (0, react.useState)({
				services: [],
				file: ""
			});
			const [loading, setLoading] = (0, react.useState)(true);
			const [loaded, setLoaded] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)("");
			const [action, setAction] = (0, react.useState)(null);
			const mounted = (0, react.useRef)(false);
			const generation = (0, react.useRef)(0);
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
			const groups = groupRunningServices(data.services);
			const running = groups.reduce((count, group) => count + group.count, 0);
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
							})
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: ServiceSection_module_css_default.hint,
							children: t("hint")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							size: "sm",
							disabled: loading || busy,
							onClick: () => {
								refresh();
							},
							children: loading ? t("refreshing") : t("refresh")
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
								children: group.sessions.map((session) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
									className: ServiceSection_module_css_default.session,
									open: true,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
										title: session.session,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: ServiceSection_module_css_default.groupLabel,
											children: sessionLabel(session.session, t("session"), t("unassignedSession"))
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: ServiceSection_module_css_default.count,
											children: session.services.length
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
										className: ServiceSection_module_css_default.services,
										"aria-label": t("services"),
										children: session.services.map(({ record }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
											className: ServiceSection_module_css_default.service,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: ServiceSection_module_css_default.dot,
													title: t("running")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: ServiceSection_module_css_default.info,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
														title: record.name,
														children: record.name
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: ServiceSection_module_css_default.meta,
														title: record.kind === "process" ? String(record.pid) : record.kind === "container" ? `${record.context} · ${record.containerId}` : record.jobId,
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
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "outline",
													size: "sm",
													disabled: busy || loading,
													onClick: () => setAction(record),
													children: t("forceStop")
												})
											]
										}, record.id))
									})]
								}) }, session.session))
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
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
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
			const face = {
				list: () => unwrap(remote().listServices({})),
				stop: (request) => unwrap(remote().stopServices(request))
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
