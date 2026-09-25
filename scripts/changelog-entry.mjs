#!/usr/bin/env node
// scripts/changelog-entry.mjs
//
// Version number in, that version's CHANGELOG.md body out. Repository-side tool:
// `package.json` -> `files` is an allow-list that does not include `scripts/`, so
// this never ships to npm consumers.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^\[?(?:v?\d+\.\d+\.\d+|Unreleased)\]?$/;
const USAGE = "usage: node scripts/changelog-entry.mjs <version> [--file CHANGELOG.md]";

export function normalizeVersion(input) {
	return String(input).trim().replace(/^\[|\]$/g, "").replace(/^v/, "");
}

export function extractEntry(markdown, version) {
	const wanted = normalizeVersion(version);
	const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const heading = new RegExp(`^## \\[${escaped}\\](\\s|$)`);
	const lines = markdown.split(/\r?\n/);

	const start = lines.findIndex((line) => heading.test(line));
	if (start === -1) return { status: "missing" };

	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^## /.test(lines[i])) {
			end = i;
			break;
		}
	}

	const body = lines.slice(start + 1, end);
	const isTrailer = (line) => line.trim() === "" || /^\[[^\]]+\]:\s*\S+/.test(line);
	while (body.length && isTrailer(body[body.length - 1])) body.pop();
	while (body.length && body[0].trim() === "") body.shift();

	return body.length ? { status: "ok", body: `${body.join("\n")}\n` } : { status: "empty" };
}

function main(argv) {
	let version = null;
	let file = "CHANGELOG.md";
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--file") {
			file = argv[++i] ?? "";
			if (!file) {
				console.error(USAGE);
				return 2;
			}
		} else if (argv[i].startsWith("--")) {
			console.error(`unknown option: ${argv[i]}`, USAGE);
			return 2;
		} else {
			positional.push(argv[i]);
		}
	}
	if (positional.length !== 1) {
		console.error(USAGE);
		return 2;
	}
	version = positional[0];
	if (!VERSION_PATTERN.test(version)) {
		console.error(`unrecognized version spelling: ${version}`);
		return 2;
	}

	let markdown;
	try {
		markdown = readFileSync(file, "utf8");
	} catch {
		console.error(`unreadable: ${file}`);
		return 2;
	}

	const result = extractEntry(markdown, version);
	if (result.status === "missing") {
		console.error(`no section for ${normalizeVersion(version)} in ${file}`);
		return 1;
	}
	if (result.status === "empty") {
		console.error(`section present but empty: ${normalizeVersion(version)} in ${file}`);
		return 1;
	}

	process.stdout.write(result.body);
	return 0;
}

const invokedDirectly = process.argv[1]
	? import.meta.url === pathToFileURL(process.argv[1]).href
	: false;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
