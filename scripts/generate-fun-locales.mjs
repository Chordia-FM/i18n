// Generates the joke locales from the English catalogs.
//
// These are override locales on purpose. Pirate speak *is* English with substitutions, so
// `en-x-pirate` only needs the keys it actually changes — i18next resolves the rest through
// en-x-pirate → en, and a string with nothing worth piratifying simply falls through. That keeps
// the diffs small and means a new English string is never *missing* here, only un-piratified.
//
// `-x-` is the BCP-47 private-use subtag, which is the correct home for a locale no registry will
// ever recognise. It canonicalises cleanly through Intl.getCanonicalLocales, so the loader, the
// runtime and the Rust crate all treat it as a normal locale with `en` behind it.
//
// Regenerate: node scripts/generate-fun-locales.mjs

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(here, "..", "locales");
const SOURCE = "en";

// ── ICU-safe transformation ────────────────────────────────────────────────────────────────────
//
// A message is literal text interleaved with ICU constructs. Only the literal text may be
// transformed: mangling `{albums}` breaks the argument, and mangling the `plural`/`select` keywords
// or their case labels breaks the parse. Plural *bodies* are literal text and do get transformed —
// they are what the reader sees.

/** Index of the `}` closing the `{` at `open`, or -1. */
function matchBrace(s, open) {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		if (s[i] === "{") depth++;
		else if (s[i] === "}" && --depth === 0) return i;
	}
	return -1;
}

/** Apply `fn` to every run of literal text in an ICU message, leaving the machinery alone. */
export function mapMessage(text, fn) {
	let out = "";
	let literal = "";
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "{") {
			literal += text[i];
			continue;
		}
		const end = matchBrace(text, i);
		if (end < 0) {
			// Unbalanced. Emit the rest verbatim rather than risk making it worse.
			return out + fn(literal) + text.slice(i);
		}
		out += fn(literal);
		literal = "";
		out += mapArgument(text.slice(i + 1, end), fn);
		i = end;
	}
	return out + fn(literal);
}

/** The inside of one `{...}`. Arguments and keywords survive verbatim; sub-messages recurse. */
function mapArgument(inner, fn) {
	const comma = inner.indexOf(",");
	if (comma < 0) return `{${inner}}`; // plain {name}

	const name = inner.slice(0, comma);
	const rest = inner.slice(comma + 1);
	const typeMatch = /^(\s*)([A-Za-z]+)\s*(?:,([\s\S]*))?$/.exec(rest);
	if (!typeMatch) return `{${inner}}`;
	const [, lead, type, options] = typeMatch;
	// number/date/time carry a format string, not sub-messages — nothing inside to transform.
	if (options === undefined || !/^(plural|selectordinal|select)$/.test(type)) {
		return `{${inner}}`;
	}

	// Option list: `label {body} label {body}`. Labels are syntax; bodies are prose.
	let out = "";
	let i = 0;
	while (i < options.length) {
		if (options[i] !== "{") {
			out += options[i];
			i++;
			continue;
		}
		const end = matchBrace(options, i);
		if (end < 0) {
			out += options.slice(i);
			break;
		}
		out += `{${mapMessage(options.slice(i + 1, end), fn)}}`;
		i = end + 1;
	}
	return `{${name},${lead}${type},${out}}`;
}

// ── Pirate ─────────────────────────────────────────────────────────────────────────────────────

/** Deterministic word substitutions, so regenerating produces no diff churn. */
const PIRATE_WORDS = new Map(
	Object.entries({
		my: "me", your: "yer", you: "ye", "you're": "ye be", yours: "yers",
		is: "be", are: "be", was: "were", "isn't": "ain't", "aren't": "ain't",
		hello: "ahoy", hi: "ahoy", yes: "aye", no: "nay", ok: "aye", okay: "aye",
		friend: "matey", friends: "hearties", people: "scallywags", person: "scallywag",
		everyone: "all hands", user: "deckhand", users: "crew", account: "ship's papers",
		music: "shanties", song: "shanty", songs: "shanties", track: "ditty", tracks: "ditties",
		album: "treasure", albums: "treasures", playlist: "chart", playlists: "charts",
		library: "hoard", search: "hunt", searching: "huntin'", find: "spy", found: "spied",
		loading: "hoistin' sail", settings: "riggin'", home: "port", stop: "belay",
		remove: "cast off", delete: "scuttle", error: "calamity", warning: "storm warnin'",
		money: "doubloons", before: "afore", between: "betwixt", about: "concernin'",
		over: "o'er", never: "ne'er", ever: "e'er", the: "th'", of: "o'",
		and: "an'", to: "t'", for: "fer", with: "wi'", them: "'em", there: "thar",
		this: "this here", that: "that thar", very: "mighty", quickly: "smartly",
		welcome: "avast", goodbye: "fair winds", please: "if ye please", sorry: "beggin' pardon",
	}),
);

/** Carry the source token's casing onto its replacement. */
function matchCase(src, repl) {
	if (src === src.toUpperCase() && src.length > 1) return repl.toUpperCase();
	if (src[0] === src[0]?.toUpperCase()) return repl[0].toUpperCase() + repl.slice(1);
	return repl;
}

function toPirate(text) {
	return text.replace(/[A-Za-z']+/g, (word) => {
		const hit = PIRATE_WORDS.get(word.toLowerCase());
		return hit ? matchCase(word, hit) : word;
	});
}

// ── Pig Latin ──────────────────────────────────────────────────────────────────────────────────

const VOWELS = /[aeiou]/i;

function toPigLatinWord(word) {
	// Words with no vowel (initialisms like "FLAC", "ID") have no sensible split; leave them.
	if (!VOWELS.test(word)) return word;
	const lower = word.toLowerCase();
	// `y` counts as a vowel anywhere but the first letter: "rhythm" splits at the y, "yellow" does not.
	let split = 0;
	while (split < lower.length && !(VOWELS.test(lower[split]) || (split > 0 && lower[split] === "y"))) {
		split++;
	}
	const moved = split === 0 ? `${word}way` : `${word.slice(split)}${word.slice(0, split)}ay`;
	return matchCase(word, moved.toLowerCase());
}

function toPigLatin(text) {
	return text.replace(/[A-Za-z]+/g, toPigLatinWord);
}

// ── Generation ─────────────────────────────────────────────────────────────────────────────────

const VARIANTS = [
	{ dir: "en-x-pirate", transform: toPirate },
	{ dir: "en-x-piglatin", transform: toPigLatin },
];

/** Recursively transform a catalog, keeping only the keys whose value actually changed. */
function transformTree(node, fn) {
	const out = {};
	for (const [key, value] of Object.entries(node)) {
		if (value && typeof value === "object") {
			const sub = transformTree(value, fn);
			if (Object.keys(sub).length) out[key] = sub;
		} else if (typeof value === "string") {
			const next = mapMessage(value, fn);
			// An unchanged string is dead weight: en-x-pirate falls back to en for anything absent,
			// so storing an identical copy only creates something to re-check when the English moves.
			if (next !== value) out[key] = next;
		}
	}
	return out;
}

function main() {
	const namespaces = readdirSync(join(LOCALES, SOURCE)).filter((f) => f.endsWith(".json"));
	for (const { dir, transform } of VARIANTS) {
		const out = join(LOCALES, dir);
		rmSync(out, { recursive: true, force: true });
		mkdirSync(out, { recursive: true });
		let keys = 0;
		let files = 0;
		for (const ns of namespaces) {
			const src = JSON.parse(readFileSync(join(LOCALES, SOURCE, ns), "utf8"));
			const tree = transformTree(src, transform);
			const count = JSON.stringify(tree).match(/":/g)?.length ?? 0;
			if (!count) continue;
			writeFileSync(
				join(out, ns),
				`${JSON.stringify(tree, null, "\t")}\n`,
				"utf8",
			);
			keys += count;
			files++;
		}
		console.log(`${dir}: ${keys} overridden keys across ${files} files`);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
