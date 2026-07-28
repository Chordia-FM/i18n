// Validates every translated catalog against the English source.
//
// Translation is the one kind of change where a reviewer usually cannot read the diff: the whole
// point is that the strings are in a language the reviewer may not speak. So the things that CAN be
// checked mechanically have to be, or nothing is checked at all.
//
// Run: node scripts/check-catalogs.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

/** `{name}`, `{count, plural, …}` → the set of argument names a string interpolates. */
function placeholders(s) {
	const found = new Set();
	if (typeof s !== "string") return found;
	for (const m of s.matchAll(/\{\s*([A-Za-z0-9_]+)\s*(?:,|\})/g)) found.add(m[1]);
	return found;
}

/** The plural/select categories a string declares, e.g. `one`, `other`, `=0`. */
function categories(s) {
	const found = new Set();
	if (typeof s !== "string") return found;
	for (const m of s.matchAll(/\b(zero|one|two|few|many|other)\s*\{/g)) found.add(m[1]);
	return found;
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
	// A regional catalog (en-GB) legitimately holds only the keys it overrides; a base-language
	// catalog is expected to cover everything.
	const isRegional = locale.includes("-");
	let keys = 0;
	let missing = 0;

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
