import { describe, expect, test } from "bun:test";
import { parseModelRef, polishModelOptions } from "../extensions/voice/post-process";

const models = [
	{ ref: "test-provider/test-model:max", label: "test-model:max" },
	{ ref: "other-provider/other-model", label: "other-model" },
];

describe("polishModelOptions", () => {
	test("offers the session model first and marks the active choice", () => {
		const options = polishModelOptions(models, "session");
		expect(options[0]!.value).toBe("session");
		// Case-insensitive: the shipped label is "Session model (follow the chat)".
		expect(options[0]!.label.toLowerCase()).toContain("session");
		expect(options.map((option) => option.value)).toEqual(["session", ...models.map((model) => model.ref)]);
	});

	test("marks an explicit model when one is configured", () => {
		const options = polishModelOptions(models, "other-provider/other-model");
		expect(options.find((option) => option.value === "other-provider/other-model")!.label).toContain("●");
	});

	test("does not duplicate the session entry for an unknown configured value", () => {
		const options = polishModelOptions(models, "ghost/model");
		expect(options.filter((option) => option.value === "session")).toHaveLength(1);
		expect(options.some((option) => option.value === "ghost/model")).toBe(false);
	});

	// Two invariants worth pinning: a picker row must never carry a reference the
	// resolver rejects, and the list must never be empty (the session entry is
	// unconditional).
	test("every value parses back to a session or explicit reference", () => {
		for (const current of [undefined, "session", "ghost", "other-provider/other-model", "ghost/model"]) {
			for (const option of polishModelOptions(models, current)) {
				const parsed = parseModelRef(option.value);
				expect(parsed.kind === "session" || parsed.kind === "explicit").toBe(true);
			}
		}
	});

	test("never returns an empty list, even with no models or an unknown current value", () => {
		expect(polishModelOptions([], undefined).map((option) => option.value)).toEqual(["session"]);
		expect(polishModelOptions([], "ghost/model").map((option) => option.value)).toEqual(["session"]);
	});

	test("marks the configured value exactly once", () => {
		for (const current of ["session", "other-provider/other-model"]) {
			const marked = polishModelOptions(models, current).filter((option) => option.label.includes("●"));
			expect(marked.map((option) => option.value)).toEqual([current]);
		}
	});
});
