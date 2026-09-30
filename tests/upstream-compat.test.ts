// tests/upstream-compat.test.ts
//
// Pure surface of the upstream compatibility probe. The probe's job is to typecheck
// `extensions/` against an arbitrary upstream Pi release; these tests pin down input
// parsing and manifest rewriting so the network-touching part stays a thin shell.
import { expect, test } from "bun:test";
import { applyTargetVersions, parseArgs, resolveTargetSpec, UsageError } from "../scripts/upstream-compat.mjs";

const MANIFEST = {
	name: "pi-voicekit",
	scripts: { check: "bun run typecheck && bun run test" },
	peerDependencies: {
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
	},
	devDependencies: {
		"@earendil-works/pi-coding-agent": "^0.87.1",
		"@earendil-works/pi-tui": "^0.87.1",
		"@types/ws": "^8",
		prettier: "3.3.3",
	},
	optionalDependencies: { "sherpa-onnx-node": "^1.13.0" },
};

test("parseArgs defaults to the latest upstream release", () => {
	expect(parseArgs([])).toEqual({ target: "latest", keep: false, json: false, help: false });
});

test("parseArgs reads an explicit version target", () => {
	expect(parseArgs(["0.99.1"]).target).toBe("0.99.1");
});

test("parseArgs reads flags before and after the target", () => {
	expect(parseArgs(["--keep", "0.99.1"]).keep).toBe(true);
	expect(parseArgs(["0.99.1", "--json"]).json).toBe(true);
});

test("parseArgs reports --help without demanding a target", () => {
	expect(parseArgs(["--help"]).help).toBe(true);
});

test("parseArgs rejects unknown flags", () => {
	expect(() => parseArgs(["--wat"])).toThrow(UsageError);
});

test("parseArgs rejects more than one target", () => {
	expect(() => parseArgs(["0.99.1", "0.87.1"])).toThrow(UsageError);
});

test("resolveTargetSpec passes latest through", () => {
	expect(resolveTargetSpec("latest")).toBe("latest");
});

test("resolveTargetSpec normalises a v-prefixed version", () => {
	expect(resolveTargetSpec("v0.99.1")).toBe("0.99.1");
	expect(resolveTargetSpec("0.87.1")).toBe("0.87.1");
});

test("resolveTargetSpec rejects partial versions and ranges", () => {
	expect(() => resolveTargetSpec("0.99")).toThrow(UsageError);
	expect(() => resolveTargetSpec("^0.99.1")).toThrow(UsageError);
	expect(() => resolveTargetSpec("next")).toThrow(UsageError);
});

test("applyTargetVersions pins both host packages to the target", () => {
	const patched = applyTargetVersions(MANIFEST, "0.99.1");
	expect(patched.devDependencies["@earendil-works/pi-coding-agent"]).toBe("0.99.1");
	expect(patched.devDependencies["@earendil-works/pi-tui"]).toBe("0.99.1");
});

test("applyTargetVersions keeps peer ranges and unrelated fields untouched", () => {
	const patched = applyTargetVersions(MANIFEST, "latest");
	expect(patched.peerDependencies).toEqual(MANIFEST.peerDependencies);
	expect(patched.devDependencies["@types/ws"]).toBe("^8");
	expect(patched.devDependencies.prettier).toBe("3.3.3");
	expect(patched.scripts).toEqual(MANIFEST.scripts);
	expect(patched.optionalDependencies).toEqual(MANIFEST.optionalDependencies);
});

test("applyTargetVersions leaves the input manifest alone", () => {
	applyTargetVersions(MANIFEST, "0.99.1");
	expect(MANIFEST.devDependencies["@earendil-works/pi-coding-agent"]).toBe("^0.87.1");
});
