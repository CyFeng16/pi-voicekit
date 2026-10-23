// tests/declared-dependencies.test.ts
//
// A package an extension imports at runtime must be declared in package.json. Pi installs
// managed packages with `npm install --omit=dev`, so anything reachable only through a
// hoisted neighbour disappears the day that neighbour stops shipping it. The declaration
// must be checked, not assumed: `sherpa-onnx-node` is loaded by `import()` and declared in
// optionalDependencies, and a dropped declaration would still typecheck against the ambient
// `declare module` shim.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MANIFEST = JSON.parse(readFileSync("package.json", "utf8"));

/** Packages Pi supplies to every extension; declared as peers, never bundled. */
const SUPPLIED_BY_PI = new Set(Object.keys(MANIFEST.peerDependencies ?? {}));

const DECLARED = new Set([
	...Object.keys(MANIFEST.dependencies ?? {}),
	...Object.keys(MANIFEST.optionalDependencies ?? {}),
	...SUPPLIED_BY_PI,
]);

// A real parser, not a regex over the text: prose in comments and look-alikes inside
// template literals must never turn into a dependency claim.
const scanner = new Bun.Transpiler({ loader: "ts" });

function listFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) files.push(...listFiles(full));
		else if (entry.endsWith(".ts")) files.push(full);
	}
	return files;
}

/**
 * Runtime specifiers `source` imports, deduped in first-seen order: static imports,
 * re-exports, dynamic imports and `require` calls. Type-only imports erase, so they never
 * demand a runtime dependency.
 */
export function importedSpecifiers(source: string): string[] {
	return [...new Set(scanner.scanImports(source).map((hit) => hit.path))];
}

test("importedSpecifiers ignores prose and literals that read like imports", () => {
	const source = [
		"/**",
		' *     from "no speech detected" with distinct user messages.',
		" */",
		'// require("gave up") from "Language Name (code)"',
		'const endpoint = "wss://api.deepgram.com/v1/speak";',
		"const nested = `outer ${cond ? `inner` : `other`} tail`;",
		'const tricky = `text with import("not-a-real-import") inside`;',
	].join("\n");
	expect(importedSpecifiers(source)).toEqual([]);
});

test("importedSpecifiers reads every runtime import form the extensions use", () => {
	const source = [
		'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
		'import { Key } from "@earendil-works/pi-tui";',
		'import "./relative-side-effect";',
		'export { helper } from "./re-exported";',
		'const sherpa = await import("sherpa-onnx-node");',
		'const fs = require("node:fs");',
		'import {\n\tone,\n\ttwo,\n} from "multi-line-package";',
	].join("\n");
	expect(importedSpecifiers(source)).toEqual([
		"@earendil-works/pi-tui",
		"./relative-side-effect",
		"./re-exported",
		"sherpa-onnx-node",
		"node:fs",
		"multi-line-package",
	]);
});

test("every package an extension imports at runtime is declared in package.json", () => {
	const undeclared: string[] = [];
	for (const file of listFiles("extensions")) {
		if (file.endsWith(".d.ts")) continue;
		for (const specifier of importedSpecifiers(readFileSync(file, "utf8"))) {
			if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
			if (!DECLARED.has(specifier)) undeclared.push(`${specifier} (${file})`);
		}
	}
	expect(undeclared).toEqual([]);
});
