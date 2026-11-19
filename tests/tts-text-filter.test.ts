import { describe, expect, test } from "bun:test";
import { prepareForSpeech, lightNormalize, normalizeBCP47, baseLanguage } from "../extensions/voice/tts-text-filter";

describe("prepareForSpeech — code blocks", () => {
	test("drops fenced code blocks entirely", () => {
		const input = "Use this:\n```ts\nconst x = 1;\n```\nDone.";
		const r = prepareForSpeech(input);
		expect(r.skipped).toBe(false);
		expect(r.text).not.toContain("const x");
		expect(r.text).toContain("[code block omitted]");
		expect(r.stats.codeBlocksRemoved).toBe(1);
	});

	test("multiple code blocks are all stripped", () => {
		const input = "```\nfoo\n```\nmiddle\n```js\nbar\n```";
		const r = prepareForSpeech(input);
		expect(r.stats.codeBlocksRemoved).toBe(2);
		expect(r.text).not.toContain("foo");
		expect(r.text).not.toContain("bar");
		expect(r.text).toContain("middle");
	});

	test("tilde fences also stripped", () => {
		const input = "~~~\nignored\n~~~";
		const r = prepareForSpeech(input);
		expect(r.stats.codeBlocksRemoved).toBe(1);
	});
});

describe("prepareForSpeech — ANSI escapes", () => {
	test("color codes stripped", () => {
		const input = "\x1b[31mError:\x1b[0m something failed.";
		const r = prepareForSpeech(input);
		expect(r.text).toBe("Error: something failed.");
		expect(r.stats.ansiEscapesRemoved).toBeGreaterThan(0);
	});

	test("OSC 8 hyperlinks stripped", () => {
		const input = "Click \x1b]8;;https://x.dev\x07here\x1b]8;;\x07.";
		const r = prepareForSpeech(input);
		expect(r.text).not.toContain("\x1b");
		expect(r.text).toContain("here");
	});
});

describe("prepareForSpeech — markdown links", () => {
	test("collapses [text](url) to text", () => {
		const r = prepareForSpeech("See [the docs](https://example.com/docs).");
		expect(r.text).toContain("the docs");
		expect(r.text).not.toContain("https://example.com/docs");
		expect(r.stats.linksCollapsed).toBe(1);
	});

	test("drops image syntax entirely", () => {
		const r = prepareForSpeech("![logo](logo.png) Welcome.");
		expect(r.text).not.toContain("logo");
		expect(r.text).toContain("Welcome");
	});

	test("bare URLs become [link omitted]", () => {
		const r = prepareForSpeech("Visit https://example.com today.");
		expect(r.text).toContain("[link omitted]");
		expect(r.text).not.toContain("example.com");
	});
});

describe("prepareForSpeech — markdown emphasis", () => {
	test("strips bold/italic markers but keeps text", () => {
		const r = prepareForSpeech("This is **bold** and *italic*.");
		expect(r.text).toBe("This is bold and italic.");
	});

	test("inline code spans keep inner text", () => {
		const r = prepareForSpeech("Use the `useState` hook.");
		expect(r.text).toBe("Use the useState hook.");
	});
});

describe("prepareForSpeech — headings, quotes, hr", () => {
	test("headings become sentences with trailing period", () => {
		const r = prepareForSpeech("# Welcome\n\nBody text.");
		expect(r.text).toContain("Welcome.");
	});

	test("blockquote markers stripped", () => {
		const r = prepareForSpeech("> A quote.");
		expect(r.text).toBe("A quote.");
	});

	test("horizontal rules removed", () => {
		const r = prepareForSpeech("Above\n---\nBelow");
		expect(r.text).not.toContain("---");
	});
});

describe("prepareForSpeech — list markers", () => {
	test("bullet markers stripped, items keep newlines for sentence boundaries", () => {
		const r = prepareForSpeech("- foo\n- bar\n- baz");
		expect(r.text).not.toMatch(/^\s*[-*+]/m);
		expect(r.text).toContain("foo");
		expect(r.text).toContain("baz");
	});
});

describe("prepareForSpeech — tables and numbered lists", () => {
	test("strips table rows (header, separator, body)", () => {
		const input = "Hier die Tabelle:\n| Name | Wert |\n| ---- | ---- |\n| a | 1 |\nFertig.";
		const r = prepareForSpeech(input);
		expect(r.text).not.toContain("|");
		expect(r.stats.tablesRemoved).toBe(3);
		expect(r.text).toContain("Hier die Tabelle");
		expect(r.text).toContain("Fertig");
	});

	test("strips numbered list markers before number expansion", () => {
		const r = prepareForSpeech("1. first\n2. second\n3. third");
		expect(r.text).toBe("first\nsecond\nthird");
		expect(r.text).not.toMatch(/one|two|three/);
	});

	test("numbered markers with closing-paren form", () => {
		const r = prepareForSpeech("1) eins\n2) zwei");
		expect(r.text).toBe("eins\nzwei");
	});

	test("spaced hyphen and en-dash become a comma pause", () => {
		expect(prepareForSpeech("entweder - oder").text).toBe("entweder, oder");
		expect(prepareForSpeech("entweder – oder").text).toBe("entweder, oder");
	});

	test("unspaced hyphen (compound words) is left alone", () => {
		const r = prepareForSpeech("Entweder-oder bleibt so.");
		expect(r.text).toBe("Entweder-oder bleibt so.");
	});
});


describe("prepareForSpeech — locale (de)", () => {
	test("expands bare numbers to German words", () => {
		const r = prepareForSpeech("Die Antwort ist 42. Das kostet 250 Euro.", { locale: "de" });
		expect(r.text).toBe("Die Antwort ist zweiundvierzig. Das kostet zweihundertfünfzig Euro.");
	});

	test("covers teens, compound tens, and the awkward 70s", () => {
		const r = prepareForSpeech("11 Punkte, 26 Versuche, 71 Fehler, 80 Glück.", { locale: "de" });
		expect(r.text).toBe("elf Punkte, sechsundzwanzig Versuche, siebenundsiebzig Fehler, achtzig Glück.");
	});

	test("hundreds: small remainder gets und, tens concatenate", () => {
		const r = prepareForSpeech("123, 101 und 250", { locale: "de" });
		expect(r.text).toBe("einhundertdreiundzwanzig, einhundertundeins und zweihundertfünfzig");
	});

	test("keeps years intact", () => {
		const r = prepareForSpeech("Das Modell ist von 2026.", { locale: "de" });
		expect(r.text).toContain("2026");
	});

	test("leaves versions, decimals, and unit-suffixed numbers alone", () => {
		const r = prepareForSpeech("Version v2, Faktor 3.14, Timeout 100ms", { locale: "de" });
		expect(r.text).toBe("Version v2, Faktor 3.14, Timeout 100ms");
	});

	test("expands German abbreviations", () => {
		// (The abbreviation's own dot is consumed by the replacement — same
		// behaviour as the English "etc." → "et cetera" rule.)
		const r = prepareForSpeech("Mit z. B. Äpfel, bzw. Birnen, usw.", { locale: "de" });
		expect(r.text).toBe("Mit zum Beispiel Äpfel, beziehungsweise Birnen, und so weiter");
	});

	test("region tag de-DE selects the same rules", () => {
		const r = prepareForSpeech("42", { locale: "de-DE" });
		expect(r.text).toBe("zweiundvierzig");
	});

	test("English is the default without a locale (unchanged behaviour)", () => {
		expect(prepareForSpeech("The answer is 42.").text).toBe("The answer is forty-two.");
	});

	test("non-German locale keeps English number words", () => {
		const r = prepareForSpeech("42", { locale: "es" });
		expect(r.text).toBe("forty-two");
	});
});


describe("prepareForSpeech — length cap", () => {
	test("rejects when output exceeds maxChars", () => {
		const long = "word ".repeat(500); // ~2500 chars
		const r = prepareForSpeech(long, { maxChars: 2000 });
		expect(r.skipped).toBe(true);
		expect(r.reason).toContain("exceeds maxChars");
	});

	test("Infinity cap allows unlimited length", () => {
		const long = "word ".repeat(500);
		const r = prepareForSpeech(long, { maxChars: Infinity });
		expect(r.skipped).toBe(false);
	});
});

describe("prepareForSpeech — empty / non-string", () => {
	test("empty string is skipped", () => {
		expect(prepareForSpeech("").skipped).toBe(true);
	});

	test("whitespace-only is skipped after stripping", () => {
		const r = prepareForSpeech("   \n\t  ");
		expect(r.skipped).toBe(true);
		expect(r.reason).toContain("empty");
	});

	test("non-string input is skipped", () => {
		const r = prepareForSpeech(null as any);
		expect(r.skipped).toBe(true);
	});
});

describe("lightNormalize — manual /voice-speak path", () => {
	test("trims and collapses whitespace only", () => {
		expect(lightNormalize("  hello   world  ")).toBe("hello world");
	});

	test("preserves code/links/ANSI as-is", () => {
		// Manual path: user typed exactly what they want spoken
		expect(lightNormalize("see ```code``` and **bold**")).toBe("see ```code``` and **bold**");
	});
});

describe("normalizeBCP47", () => {
	test("lowercase language, uppercase region", () => {
		expect(normalizeBCP47("EN-us")).toBe("en-US");
		expect(normalizeBCP47("pt-br")).toBe("pt-BR");
	});

	test("underscore separator normalized to dash", () => {
		expect(normalizeBCP47("zh_CN")).toBe("zh-CN");
	});

	test("script subtag preserves Title-case", () => {
		// Architect-flagged regression case from v7 plan godspeed pass
		expect(normalizeBCP47("zh-Hant-TW")).toBe("zh-Hant-TW");
		expect(normalizeBCP47("zh-hant-tw")).toBe("zh-Hant-TW");
	});

	test("3-digit UN M.49 region preserved", () => {
		expect(normalizeBCP47("es-419")).toBe("es-419");
	});

	test("variant subtag stays lowercase", () => {
		expect(normalizeBCP47("sl-rozaj")).toBe("sl-rozaj");
	});

	test("empty / non-string input returns empty", () => {
		expect(normalizeBCP47("")).toBe("");
		expect(normalizeBCP47(null as any)).toBe("");
	});
});

describe("baseLanguage", () => {
	test("strips region", () => {
		expect(baseLanguage("en-US")).toBe("en");
		expect(baseLanguage("zh-Hant-TW")).toBe("zh");
	});

	test("bare language returns itself", () => {
		expect(baseLanguage("ja")).toBe("ja");
	});

	test("empty input returns empty", () => {
		expect(baseLanguage("")).toBe("");
	});
});
