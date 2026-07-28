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

/** The plural/select categories a string declares, e.g. `one`, `other`, `=0`. */
function categories(s) {
	const found = new Set();
	if (typeof s !== "string") return found;
	for (const m of s.matchAll(/\b(zero|one|two|few|many|other)\s*\{/g)) found.add(m[1]);
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
				problems.push(`${locale}/${ns}: invalid JSON — ${e.message}`);
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
				if (allowed) {
					for (const c of categories(value)) {
						if (!allowed.includes(c)) {
							problems.push(
								`${locale}/${ns}: ${key} uses plural category '${c}', not valid for '${base}' (${allowed.join(", ")})`,
							);
							errors++;
						}
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
