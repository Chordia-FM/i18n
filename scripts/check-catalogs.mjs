// Validates every translated catalog against the English source.
//
// Translation is the one kind of change where a reviewer usually cannot read the diff: the whole
// point is that the strings are in a language the reviewer may not speak. So the things that CAN be
// checked mechanically have to be, or nothing is checked at all.
//
// Run: node scripts/check-catalogs.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../locales", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const SOURCE = "en";

/** CLDR plural categories per language. A catalog may use a subset, never anything outside it. */
const PLURAL_CATEGORIES = {
	en: ["one", "other"],
	es: ["one", "many", "other"],
	fr: ["one", "many", "other"],
	de: ["one", "other"],
	pt: ["one", "many", "other"],
	it: ["one", "many", "other"],
	nl: ["one", "other"],
	ja: ["other"],
	ko: ["other"],
	zh: ["other"],
	pl: ["one", "few", "many", "other"],
	ru: ["one", "few", "many", "other"],
	tr: ["one", "other"],
};

/** Flatten to dotted paths so two catalogs can be compared key by key. */
function flatten(obj, prefix = "", out = {}) {
	for (const [k, v] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${k}` : k;
		if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
		else out[path] = v;
	}
	return out;
}

/**
 * The set of ICU argument names a string interpolates.
 *
 * This needs a parser, not a pattern. Braces mean two different things in ICU: `{name}` opens an
 * argument, but inside a plural or select the braces after each case label open a *branch body* of
 * literal text. Both look identical to a regex, and guessing either way is wrong in a way that
 * matters:
 *
 *   {albums, plural, one {album} other {albums}}          → argument is `albums`, not `album`
 *   {person, select, them {Streaks, records, …} other {…}} → argument is `person`, not `Streaks`
 *
 * Denylisting the plural keywords does not save you, because select labels are arbitrary
 * identifiers — `them` above. So: read an argument, and if it is a plural/select, treat everything
 * in its option list as label/body pairs and recurse into the bodies only.
 */
export function placeholders(text) {
	const found = new Set();
	if (typeof text !== "string") return found;

	/** Scan a run of message text, collecting arguments. */
	function scanMessage(s) {
		for (let i = 0; i < s.length; i++) {
			if (s[i] !== "{") continue;
			const end = matchBrace(s, i);
			if (end < 0) {
				// Unbalanced — the brace check reports that separately. Still read the name, so a
				// malformed string says which argument it was reaching for instead of going quiet.
				scanArgument(s.slice(i + 1));
				return;
			}
			scanArgument(s.slice(i + 1, end));
			i = end;
		}
	}

	/** The inside of one `{...}`: `name`, `name, type, ...`. */
	function scanArgument(inner) {
		const comma = inner.indexOf(",");
		const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
		if (!/^[A-Za-z0-9_]+$/.test(name)) return;
		found.add(name);
		if (comma < 0) return;

		const rest = inner.slice(comma + 1).trim();
		const typeMatch = /^([A-Za-z]+)\s*(?:,([\s\S]*))?$/.exec(rest);
		if (!typeMatch) return;
		const [, type, options = ""] = typeMatch;
		// number/date/time carry a format, not sub-messages — nothing further to read.
		if (!/^(plural|selectordinal|select)$/.test(type)) return;
		// Option list: `label {body} label {body}`. Only the bodies are messages.
		for (let i = 0; i < options.length; i++) {
			if (options[i] !== "{") continue;
			const end = matchBrace(options, i);
			if (end < 0) return;
			scanMessage(options.slice(i + 1, end));
			i = end;
		}
	}

	/** Index of the `}` closing the `{` at `open`, or -1. */
	function matchBrace(s, open) {
		let depth = 0;
		for (let i = open; i < s.length; i++) {
			if (s[i] === "{") depth++;
			else if (s[i] === "}" && --depth === 0) return i;
		}
		return -1;
	}

	scanMessage(text);
	return found;
}

/**
 * CLDR *ordinal* categories, which are a different set from the plural ones and easy to mistake
 * for them. English ordinals need one/two/few/other — 1st, 2nd, 3rd, 4th — while English plurals
 * need only one/other. Checking a `selectordinal` against the plural table rejects correct work.
 */
const ORDINAL_CATEGORIES = {
	en: ["one", "two", "few", "other"],
	es: ["other"],
	fr: ["one", "other"],
	de: ["other"],
	pt: ["one", "other"],
	it: ["many", "other"],
	nl: ["other"],
	ja: ["other"],
	ko: ["other"],
	zh: ["other"],
	pl: ["other"],
	ru: ["other"],
	tr: ["other"],
};

/**
 * Every plural/selectordinal construct in a message, as `{ type, categories }`.
 *
 * Parsed rather than pattern-matched for the same reason `placeholders` is: a regex cannot tell a
 * category label from a word that happens to sit before a brace, and it cannot tell which kind of
 * construct a label belongs to. `select` is deliberately excluded — its labels are arbitrary
 * identifiers chosen by us (`them`, `other`), not a CLDR set to validate against.
 */
export function pluralConstructs(text) {
	const found = [];
	if (typeof text !== "string") return found;

	function matchBrace(s, open) {
		let depth = 0;
		for (let i = open; i < s.length; i++) {
			if (s[i] === "{") depth++;
			else if (s[i] === "}" && --depth === 0) return i;
		}
		return -1;
	}

	function scanMessage(s) {
		for (let i = 0; i < s.length; i++) {
			if (s[i] !== "{") continue;
			const end = matchBrace(s, i);
			if (end < 0) return;
			scanArgument(s.slice(i + 1, end));
			i = end;
		}
	}

	function scanArgument(inner) {
		const comma = inner.indexOf(",");
		if (comma < 0) return;
		const rest = inner.slice(comma + 1).trim();
		const m = /^([A-Za-z]+)\s*(?:,([\s\S]*))?$/.exec(rest);
		if (!m) return;
		const [, type, options = ""] = m;
		if (!/^(plural|selectordinal|select)$/.test(type)) return;

		const cats = new Set();
		for (let i = 0; i < options.length; i++) {
			if (options[i] !== "{") continue;
			// The label is whatever precedes this brace, back to the previous body or the start.
			const label = options.slice(0, i).match(/([A-Za-z0-9=]+)\s*$/)?.[1];
			if (label) cats.add(label);
			const end = matchBrace(options, i);
			if (end < 0) break;
			scanMessage(options.slice(i + 1, end));
			i = end;
		}
		if (type !== "select") found.push({ type, categories: cats });
	}

	scanMessage(text);
	return found;
}

/**
 * Literal prose with the ICU machinery removed. A string that reduces to nothing — "{date}",
 * "{artist} · {year}", "OK" — is inert: identical across languages because there is nothing in it
 * to translate. Anything left over is real words, and a target identical to the source there means
 * the string was never translated.
 */
function prose(s) {
	let out = String(s);
	// Nested plural/select bodies need several passes to unwrap.
	for (let i = 0; i < 5; i++) out = out.replace(/\{[^{}]*\}/g, "");
	return out.replace(/[^A-Za-z]+/g, "");
}

function braincesBalanced(s) {
	if (typeof s !== "string") return true;
	let depth = 0;
	for (const ch of s) {
		if (ch === "{") depth++;
		else if (ch === "}" && --depth < 0) return false;
	}
	return depth === 0;
}

// Only validate when run directly. The ICU extractor above is imported by the tests, and a
// module that validates (and exits) on import would kill the test process before it started.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const locales = readdirSync(ROOT).filter((d) => statSync(join(ROOT, d)).isDirectory());
	const namespaces = readdirSync(join(ROOT, SOURCE)).filter((f) => f.endsWith(".json"));

	const source = {};
	for (const ns of namespaces) {
		source[ns] = flatten(JSON.parse(readFileSync(join(ROOT, SOURCE, ns), "utf8")));
	}

	let errors = 0;
	const problems = [];
	const summary = [];

	for (const locale of locales.filter((l) => l !== SOURCE)) {
		const base = locale.split("-")[0];
		const allowed = PLURAL_CATEGORIES[base];
		// A regional catalog holds only the keys it overrides — but only when its base language is
		// actually present to fall back to. `en-GB` has `en` behind it, so 23 keys is complete;
		// `pt-BR` with no `pt` catalog resolves straight to English, so partial coverage there is
		// missing translation, not intentional override.
		const isRegional = locale.includes("-") && locales.includes(base);
		let keys = 0;
		let missing = 0;
		let untranslated = 0;

		for (const ns of namespaces) {
			const path = join(ROOT, locale, ns);
			let flat;
			try {
				flat = flatten(JSON.parse(readFileSync(path, "utf8")));
			} catch (e) {
				if (e.code === "ENOENT") {
					if (!isRegional) missing += Object.keys(source[ns]).length;
					continue;
				}
				// A malformed catalog is not just this locale's problem: the frontend glob-imports
				// every file eagerly, so one bad JSON takes down the whole build and every test
				// that touches i18n. Name the likely cause, because "Unexpected token" over a
				// literal backslash-t is a genuinely confusing thing to land on.
				const raw = readFileSync(path, "utf8");
				const hint = /^\s*\\t/m.test(raw)
					? " — indentation is the two characters backslash-t, not a tab"
					: /\\n\s*$/.test(raw)
						? " — file ends with a literal backslash-n instead of a newline"
						: "";
				problems.push(`${locale}/${ns}: invalid JSON — ${e.message}${hint}`);
				errors++;
				continue;
			}

			for (const [key, value] of Object.entries(flat)) {
				keys++;
				// An extra key is dead weight the source no longer has; usually a hallucinated key.
				if (!(key in source[ns])) {
					problems.push(`${locale}/${ns}: key not in source — ${key}`);
					errors++;
					continue;
				}
				if (typeof value !== "string") {
					problems.push(`${locale}/${ns}: ${key} is ${typeof value}, expected string`);
					errors++;
					continue;
				}
				if (!braincesBalanced(value)) {
					problems.push(`${locale}/${ns}: ${key} has unbalanced braces`);
					errors++;
				}
				// Zero-width characters are invisible in every editor and diff, so they survive
				// review indefinitely — and one landed *inside* an ICU plural in Portuguese, where
				// it breaks the parse. NBSP is deliberately not in this set: French typography
				// requires it before : ; ! ? and it is correct there.
				const invisible = value.match(/[​‌⁠﻿‎‏]/);
				if (invisible) {
					const point = invisible[0].codePointAt(0).toString(16).toUpperCase();
					problems.push(
						`${locale}/${ns}: ${key} contains an invisible character U+${point}`,
					);
					errors++;
				}
				// Machine translators often mask placeholders before translating and restore them
				// after. When the restore step fails the mask survives into the catalog and renders
				// literally — "[[[P7_0]]]d" where the user should see "3d". Worse than a dropped
				// argument, because it looks like corruption rather than absence.
				const mask = value.match(/\[{2,}[A-Za-z]*\d+[_\d]*\]{2,}|__[A-Z]+_\d+__|%%\w+%%/);
				if (mask) {
					problems.push(
						`${locale}/${ns}: ${key} contains an unrestored placeholder mask — ${mask[0]}`,
					);
					errors++;
				}
				// Advisory, not an error: a healthy catalog still reports a few dozen. "Radio", "Bio",
			// "Genres", "Album" and "Popular" really are the same word in several of these
			// languages, and "new@example.com" is the same in all of them. Read a jump — 280 in a
			// 1418-key catalog — as a translator that stopped early, not the baseline.
			// Key parity says a catalog is "complete" while a fifth of its values are still English.
				// A regional catalog is exempt: en-GB only overrides where British spelling differs, so
				// matching en is the normal case there, not a gap.
				if (!isRegional && value === source[ns][key] && prose(value).length >= 2) {
					untranslated++;
				}
				// Dropping a placeholder means the number or name silently never renders.
				const want = placeholders(source[ns][key]);
				const got = placeholders(value);
				for (const p of want) {
					if (!got.has(p)) {
						problems.push(`${locale}/${ns}: ${key} drops placeholder {${p}}`);
						errors++;
					}
				}
				// A category outside the language's CLDR set never matches, so that branch is dead and
				// the string falls through to `other` — silently, at runtime, only for some counts.
				// Plural and ordinal have different category sets; `=0`-style exact matches are
				// always legal in both.
				for (const { type, categories } of pluralConstructs(value)) {
					const valid =
						type === "selectordinal" ? ORDINAL_CATEGORIES[base] : allowed;
					if (!valid) continue;
					for (const c of categories) {
						if (c.startsWith("=") || valid.includes(c)) continue;
						problems.push(
							`${locale}/${ns}: ${key} uses ${type} category '${c}', not valid for '${base}' (${valid.join(", ")})`,
						);
						errors++;
					}
				}
			}
			for (const key of Object.keys(source[ns])) {
				if (!(key in flat) && !isRegional) missing++;
			}
		}

		const total = Object.values(source).reduce((n, o) => n + Object.keys(o).length, 0);
		const pct = Math.round((keys / total) * 100);
		summary.push(
			`${locale.padEnd(7)} ${String(keys).padStart(5)}/${total} keys (${pct}%)` +
				(missing && !isRegional ? `  ${missing} missing` : "") +
				(untranslated ? `  ${untranslated} still in English` : "") +
				(isRegional ? "  [regional: overrides only]" : ""),
		);
	}

	console.log(summary.join("\n"));
	if (problems.length) {
		console.log(`\n${problems.length} problem(s):`);
		console.log(problems.slice(0, 40).join("\n"));
		if (problems.length > 40) console.log(`… and ${problems.length - 40} more`);
	}
	process.exit(errors ? 1 : 0);
}
