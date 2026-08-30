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
import { parse as parseIcu } from "@formatjs/icu-messageformat-parser";

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

/**
 * British spellings, and what the source should say instead.
 *
 * The source language is **en-US**, and `en-GB` exists precisely to hold the British forms as
 * overrides — it already carries "catalogue", "Organise", "Visualiser" and "Normalise". That split
 * only works if the source stays American, and it had quietly stopped: "Accent colour" and
 * "Cancelled" had leaked in, so British users were getting British spellings by accident on those
 * keys and American ones everywhere else.
 *
 * Matched as a stem inside a word, so "colour" catches "colours" and "colourful" too.
 *
 * Deliberately NOT on this list: "dialogue", which is correct American English for a conversation
 * and would fire on legitimate prose; and "practise"/"licence", whose noun/verb split makes a
 * blanket rule wrong often enough to be annoying. A gate people learn to work around is worse than
 * no gate.
 */
const AMERICAN_SPELLING = new Map([
	["colour", "color"],
	["favourite", "favorite"],
	["behaviour", "behavior"],
	["catalogue", "catalog"],
	["organis", "organiz"],
	["customis", "customiz"],
	["personalis", "personaliz"],
	["normalis", "normaliz"],
	["synchronis", "synchroniz"],
	["recognis", "recogniz"],
	["visualis", "visualiz"],
	["prioritis", "prioritiz"],
	["initialis", "initializ"],
	["analys", "analyz"],
	["cancelled", "canceled"],
	["cancelling", "canceling"],
	["labelled", "labeled"],
	["labelling", "labeling"],
	["travelling", "traveling"],
	["artefact", "artifact"],
	["centre", "center"],
	["defence", "defense"],
	["programme", "program"],
	["enrolment", "enrollment"],
	["fulfil ", "fulfill "],
	["ageing", "aging"],
	["grey", "gray"],
	["whilst", "while"],
	["amongst", "among"],
]);

const BRITISH_RE = new RegExp(
	`\\b\\w*(?:${[...AMERICAN_SPELLING.keys()].map((s) => s.trim()).join("|")})\\w*\\b`,
	"i",
);

/** The offending word and its American form, or null. */
function britishSpelling(value) {
	const hit = BRITISH_RE.exec(value);
	if (!hit) return null;
	const word = hit[0];
	for (const [british, american] of AMERICAN_SPELLING) {
		const stem = british.trim();
		if (word.toLowerCase().includes(stem)) {
			return { word, suggestion: word.replace(new RegExp(stem, "i"), american.trim()) };
		}
	}
	return null;
}

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

	// The source catalog gets validated too. It used to be exempt on the reasoning that a reviewer
	// can read English — but the failure this catches is not a wording problem, it is a *format*
	// problem, and those are invisible in review. A real one shipped: `player:queue.addedAlbum` was
	// written in i18next's `_one`/`_other` suffix style, which this project's i18next-icu setup does
	// not resolve at all. The key silently missed, so every locale fell through to the call site's
	// `defaultValue` — an ungrammatical, untranslatable English string ("Added 12 to queue") that no
	// translator could ever reach. Every translated catalog was checked; the one that was wrong was
	// the one nobody checked.
	for (const ns of namespaces) {
		for (const [key, value] of Object.entries(source[ns])) {
			if (typeof value !== "string") {
				problems.push(`${SOURCE}/${ns}: ${key} is ${typeof value}, expected string`);
				errors++;
				continue;
			}
			if (/_(zero|one|two|few|many|other)$/.test(key)) {
				problems.push(
					`${SOURCE}/${ns}: ${key} uses i18next plural-suffix keys, which i18next-icu does ` +
						`not resolve — use one key with an ICU plural: ` +
						`"{count, plural, one {…} other {…}}"`,
				);
				errors++;
				continue;
			}
			try {
				parseIcu(value);
			} catch (e) {
				problems.push(
					`${SOURCE}/${ns}: ${key} is not valid ICU — ${String(e.message).split("\n")[0]}`,
				);
				errors++;
				continue;
			}
			// Same two value-shape checks the targets get. A zero-width character or an unrestored
			// placeholder mask is no less broken for being in the source — and the source is the
			// string that gets uploaded to Crowdin, so a defect here propagates into every language.
			// Em dashes, banned outright in the source. They are this project's most-repeated review
			// note: the dash reads as machine-written, and it accumulates because each one looks fine
			// on its own. A blanket ban is the only version of this rule that a script can enforce and
			// a writer can remember. Where two values genuinely need separating, the app already uses
			// a middle dot ("@handle · date"); everywhere else the clause wanted a colon, a
			// semicolon or a full stop, which is a decision worth making rather than deferring.
			if (value.includes("—")) {
				problems.push(
					`${SOURCE}/${ns}: ${key} contains an em dash. Use a colon, semicolon or full stop, ` +
						`or "·" when separating two values.`,
				);
				errors++;
			}
			// American spelling in the source. `en-GB` is the deliberate home for the British forms,
			// and it can only do that job if the source it overrides is consistently American.
			// Checked in the SOURCE loop only — every target locale, en-GB included, is exempt.
			const british = britishSpelling(value);
			if (british) {
				problems.push(
					`${SOURCE}/${ns}: ${key} uses the British spelling "${british.word}". The source ` +
						`catalog is en-US, so write "${british.suggestion}" and put the British form in ` +
						`locales/en-GB/${ns} if it is worth overriding.`,
				);
				errors++;
			}
			const invisible = value.match(/[​‌⁠﻿‎‏]/);
			if (invisible) {
				const point = invisible[0].codePointAt(0).toString(16).toUpperCase();
				problems.push(`${SOURCE}/${ns}: ${key} contains an invisible character U+${point}`);
				errors++;
			}
			// English plural/ordinal categories, checked against the same CLDR tables the targets
			// use. A source that uses a category English does not have (`few`, `many`) produces a
			// message no English count can ever select.
			for (const { type, categories } of pluralConstructs(value)) {
				const allowed =
					type === "selectordinal" ? ORDINAL_CATEGORIES[SOURCE] : PLURAL_CATEGORIES[SOURCE];
				for (const c of categories) {
					// `=0`/`=1` exact matches are always legal, whatever the language's categories.
					if (c.startsWith("=") || allowed.includes(c)) continue;
					problems.push(
						`${SOURCE}/${ns}: ${key} uses ${type} category "${c}", not valid for ${SOURCE} ` +
							`(allowed: ${allowed.join(", ")})`,
					);
					errors++;
				}
				if (!categories.has("other")) {
					problems.push(`${SOURCE}/${ns}: ${key} ${type} is missing the required "other" case`);
					errors++;
				}
			}
		}
	}

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
				// An empty value is worse than a missing key, and looks like the opposite. i18next
				// finds it, treats it as a translation, and renders nothing — so the string is blank
				// on screen instead of falling back to English. Crowdin emits these for untranslated
				// entries whenever "Skip untranslated strings" is off, and a pull once brought back
				// 1,920 of them at a stroke. Omit the key instead; that is what makes fallback work.
				if (!value.trim()) {
					problems.push(
						`${locale}/${ns}: ${key} is empty — omit the key so it falls back to ${SOURCE}`,
					);
					errors++;
					continue;
				}
				// The real ICU parser, not our reading of it. The hand-rolled helpers above answer
				// narrower questions (which arguments, which categories) and have been wrong more
				// than once; this is the authority on whether the string is a valid message at all,
				// and it is what the runtime will actually do with it.
				try {
					parseIcu(value);
				} catch (e) {
					problems.push(
						`${locale}/${ns}: ${key} is not valid ICU — ${String(e.message).split("\n")[0]}`,
					);
					errors++;
					continue;
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
				// ...and INVENTING one is the same bug seen from the other side, with a nastier cause.
				// It means the translation is of a PREVIOUS version of this string: Crowdin keeps a
				// translation when its source is edited, so rewording the English silently leaves every
				// locale describing the old copy. `catalog:report.helpText` sat like that in six
				// languages — the English lost its {name} in a rewrite and the translations kept it.
				//
				// That one happened to stay harmless because the call site still passes `name`. The
				// same staleness the other way round drops a value the reader needed, and nothing says
				// so at runtime; i18next renders the literal text and moves on.
				for (const p of got) {
					if (!want.has(p)) {
						problems.push(
							`${locale}/${ns}: ${key} invents placeholder {${p}} — the source has no such argument, so this is a translation of an older version of the string`,
						);
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
