import { resolve } from "node:path";
import { createHash } from "node:crypto";
//#region src/ownership.ts
const OWNER_ENV = "DSH_SERVICE_OWNER";
function registryKey(file) {
	const path = resolve(file);
	return createHash("sha256").update(process.platform === "win32" ? path.toLowerCase() : path).digest("hex").slice(0, 24);
}
function encodeOwner(key, owner) {
	return `${key}.${Buffer.from(JSON.stringify(owner)).toString("base64url")}`;
}
function decodeOwner(key, value) {
	if (!value.startsWith(`${key}.`) || value.length > 8192) return;
	try {
		const owner = JSON.parse(Buffer.from(value.slice(key.length + 1), "base64url").toString());
		if ([
			"project",
			"session",
			"call"
		].every((key) => typeof owner[key] === "string" && owner[key].length <= 512)) return owner;
	} catch {}
}
/** Only the ownership marker leaves the environment reader; other values are discarded. */
function ownerFromEnvironment(environment) {
	return environment.split("\0").find((entry) => entry.startsWith(`${OWNER_ENV}=`))?.slice(18);
}
//#endregion
export { registryKey as a, ownerFromEnvironment as i, decodeOwner as n, encodeOwner as r, OWNER_ENV as t };
