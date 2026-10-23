import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PI_VERSION = "0.87.1";
const PI_DEV_RANGE = `^${PI_VERSION}`;
const PI_PEER_RANGE = "*";

const DIRECT_PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"] as const;
const LEGACY_DIRECT_PI_PACKAGES = ["@mariozechner/pi-coding-agent", "@mariozechner/pi-tui"] as const;
const RELATED_PI_PACKAGES = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"] as const;

function readJson(path: string) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function listFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			files.push(...listFiles(fullPath));
		} else if (/\.(ts|md|json)$/.test(entry)) {
			files.push(fullPath);
		}
	}
	return files;
}

describe("Pi dependency support", () => {
	test("package.json uses the current Earendil Works Pi packages", () => {
		const pkg = readJson("package.json");

		for (const packageName of DIRECT_PI_PACKAGES) {
			expect(pkg.devDependencies?.[packageName]).toBe(PI_DEV_RANGE);
			expect(pkg.peerDependencies?.[packageName]).toBe(PI_PEER_RANGE);
		}

		for (const packageName of LEGACY_DIRECT_PI_PACKAGES) {
			expect(pkg.devDependencies?.[packageName]).toBeUndefined();
			expect(pkg.peerDependencies?.[packageName]).toBeUndefined();
		}
	});

	test("source imports use the current Earendil Works Pi packages", () => {
		const sourceFiles = ["extensions", "tests"]
			.flatMap(listFiles)
			.filter((file) => file !== "tests/package-dependencies.test.ts");

		for (const file of sourceFiles) {
			const contents = readFileSync(file, "utf8");
			expect(contents).not.toContain("@mariozechner/pi-coding-agent");
			expect(contents).not.toContain("@mariozechner/pi-tui");
		}
	});

	test("package-lock.json resolves direct and related Pi packages consistently", () => {
		const lock = readJson("package-lock.json");
		const root = lock.packages?.[""];

		for (const packageName of DIRECT_PI_PACKAGES) {
			expect(root?.devDependencies?.[packageName]).toBe(PI_DEV_RANGE);
			expect(root?.peerDependencies?.[packageName]).toBe(PI_PEER_RANGE);
			expect(lock.packages?.[`node_modules/${packageName}`]?.version).toBe(PI_VERSION);
		}

		for (const packageName of LEGACY_DIRECT_PI_PACKAGES) {
			expect(root?.devDependencies?.[packageName]).toBeUndefined();
			expect(root?.peerDependencies?.[packageName]).toBeUndefined();
			expect(lock.packages?.[`node_modules/${packageName}`]).toBeUndefined();
		}

		for (const packageName of RELATED_PI_PACKAGES) {
			// npm may nest these under a consumer when versions require it; assert a
			// resolved instance matches PI_VERSION anywhere in the tree.
			const resolvedVersions = Object.entries(lock.packages ?? {})
				.filter(([path]) => path === `node_modules/${packageName}` || path.endsWith(`/node_modules/${packageName}`))
				.map(([, info]) => (info as { version?: string }).version);
			expect(resolvedVersions).toContain(PI_VERSION);
		}
	});

	test("bun.lock resolves direct and related Pi packages consistently", () => {
		const lock = readFileSync("bun.lock", "utf8");

		for (const packageName of DIRECT_PI_PACKAGES) {
			expect(lock).toContain(`"${packageName}": "${PI_DEV_RANGE}"`);
			expect(lock).toContain(`"${packageName}": "${PI_PEER_RANGE}"`);
			expect(lock).toContain(`"${packageName}": ["${packageName}@${PI_VERSION}"`);
		}

		for (const packageName of LEGACY_DIRECT_PI_PACKAGES) {
			expect(lock).not.toContain(`"${packageName}": "`);
			expect(lock).not.toContain(`"${packageName}": ["${packageName}@`);
		}

		for (const packageName of RELATED_PI_PACKAGES) {
			expect(lock).toContain(`"${packageName}": ["${packageName}@${PI_VERSION}"`);
		}
	});

	test("lockfiles root name matches package.json name", () => {
		const name = readJson("package.json").name as string;
		expect(name).toBeTruthy();

		const npmLock = readJson("package-lock.json");
		expect(npmLock.name).toBe(name);
		expect(npmLock.packages?.[""]?.name).toBe(name);

		// bun.lock stores the workspace root under workspaces[""].name
		const bunLock = readFileSync("bun.lock", "utf8");
		expect(bunLock).toMatch(new RegExp(`"workspaces": \\{\\s*"": \\{\\s*"name": "${name}"`));
	});
});

// The two packages the security overrides exist for. Both arrive through the pinned
// Pi dev baseline; the published package ships no runtime dependency of its own.
const GUARDED_PACKAGES = ["protobufjs", "@protobufjs/utf8"] as const;

describe("published manifest metadata", () => {
	test("the ws dependency is gone from every manifest field", () => {
		const pkg = readJson("package.json");
		expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
		expect(pkg.overrides?.ws).toBeUndefined();
		expect(Object.keys(pkg.devDependencies ?? {})).not.toContain("@types/ws");
		expect(Object.keys(pkg.devDependencies ?? {})).not.toContain("ws");
	});
});

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every version `package-lock.json` resolved for this package, nested copies included. */
function npmResolutions(npmLock: Record<string, unknown>, packageName: string): string[] {
	const packages = (npmLock.packages ?? {}) as Record<string, { version?: string }>;
	return Object.entries(packages)
		.filter(([path]) => path === `node_modules/${packageName}` || path.endsWith(`/node_modules/${packageName}`))
		.map(([, info]) => info.version ?? "");
}

/** Every version `bun.lock` resolved for this package, read from its flat package table. */
function bunResolutions(bunLock: string, packageName: string): string[] {
	const name = escapeRegExp(packageName);
	const pattern = new RegExp(`"${name}": \\["${name}@([0-9][^"]*)"`, "g");
	return [...bunLock.matchAll(pattern)].map((match) => match[1]);
}

describe("security override invariants", () => {
	const manifest = readJson("package.json");
	const overrides = (manifest.overrides ?? {}) as Record<string, string>;
	const npmLock = readJson("package-lock.json");
	const bunLock = readFileSync("bun.lock", "utf8");

	/** The range that actually governs this package: a literal override, else the direct dependency. */
	function declaredRange(packageName: string): string | undefined {
		const override = overrides[packageName];
		if (typeof override === "string" && !override.startsWith("$")) {
			return override;
		}
		return manifest.dependencies?.[packageName];
	}

	for (const packageName of GUARDED_PACKAGES) {
		test(`${packageName} resolves to exactly one version in each lockfile`, () => {
			// A second copy is the regression that a stale generator or a dropped
			// override produces, and `npm ci` accepts it silently.
			expect(npmResolutions(npmLock, packageName)).toHaveLength(1);
			expect(bunResolutions(bunLock, packageName)).toHaveLength(1);
		});
	}

	test("both lockfiles agree on the guarded packages", () => {
		for (const packageName of GUARDED_PACKAGES) {
			const [npmVersion] = npmResolutions(npmLock, packageName);
			const [bunVersion] = bunResolutions(bunLock, packageName);
			expect(npmVersion).toBeTruthy();
			expect(npmVersion).toBe(bunVersion);
		}
	});

	test("the guarded packages stay inside the ranges package.json declares", () => {
		for (const packageName of GUARDED_PACKAGES) {
			const range = declaredRange(packageName);
			expect(range).toBeTruthy();

			const [npmVersion] = npmResolutions(npmLock, packageName);
			const [bunVersion] = bunResolutions(bunLock, packageName);
			expect(Bun.semver.satisfies(npmVersion, range as string)).toBe(true);
			expect(Bun.semver.satisfies(bunVersion, range as string)).toBe(true);
		}
	});
});
