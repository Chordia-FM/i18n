// Tests for the ICU-safe message transform behind the joke locales.
//
// The whole risk here is mangling something that must survive verbatim: an {argument}, a `plural`
// keyword, a case label. Any of those turns a working string into a broken one, and the joke
// locales are exactly where nobody would notice for months.
//
// Run: node scripts/generate-fun-locales.test.mjs

import { strict as assert } from "node:assert";
import {
	mapMessage,
	piglatinify,
	piratify,
	toPigLatinWord,
	toPirate,
} from "./generate-fun-locales.mjs";

const upper = (s) => s.toUpperCase();

const cases = [
	// Plain text is transformed.
	["play all", "PLAY ALL"],

	// Arguments survive untouched, surrounding text does not.
	["since {date}", "SINCE {date}"],
	["{days}d {hours}h", "{days}D {hours}H"],
	["{artist} · {year}", "{artist} · {year}"],

	// Plural: the argument and the `plural` keyword and the case labels all survive; the bodies
	// are prose and get transformed. `#` must come through intact.
	[
		"{count, plural, one {# play} other {# plays}}",
		"{count, plural, one {# PLAY} other {# PLAYS}}",
	],

	// Select: labels are arbitrary identifiers and must not be touched.
	[
		"{person, select, them {they listen} other {you listen}}",
		"{person, select, them {THEY LISTEN} other {YOU LISTEN}}",
	],

	// Nested argument inside a plural body survives.
	[
		"{count, plural, one {{name} played once} other {{name} played # times}}",
		"{count, plural, one {{name} PLAYED ONCE} other {{name} PLAYED # TIMES}}",
	],

	// Formatted arguments carry a style, not a sub-message — nothing inside may be transformed.
	["on {date, date, long}", "ON {date, date, long}"],
	["{value, number, percent} done", "{value, number, percent} DONE"],

	// Multiple arguments in one message.
	[
		"{albumsFormatted} {albums, plural, one {album} other {albums}}",
		"{albumsFormatted} {albums, plural, one {ALBUM} other {ALBUMS}}",
	],

	// Malformed input must not throw or corrupt what it cannot parse.
	["{count, plural, one {# a}", "{count, plural, one {# a}"],
];

// ── Pirate ─────────────────────────────────────────────────────────────────────────────────────
//
// Curated phrases fire only on an exact full-message match and must reproduce ICU arguments;
// everything else goes through the ICU-safe word layer, whose entries must be safe in any
// grammatical position.

const pirateCases = [
	// Curated phrases beat the word table ("Avast back" was the old, wrong output).
	["Welcome back", "Back aboard, matey!"],
	["Pause", "Avast!"],
	["Save", "Stow it"],
	["Loading…", "Heave ho…"],

	// A curated phrase must carry its {arguments} through exactly.
	["About {name}", "Th' legend o' {name}"],
	["Play {title}", "Strike up {title}"],
	["No results for “{term}”.", "No booty found fer “{term}”."],

	// Curation is exact-match only — near misses fall through to the word layer untouched.
	["Play it", "Play it"],
	["Save preset", "Stow preset"],

	// The word layer still honours ICU structure: keywords and labels survive, bodies transform.
	[
		"{count, plural, one {# track} other {# tracks}}",
		"{count, plural, one {# ditty} other {# ditties}}",
	],

	// Protected names are never translated.
	["Scrobble your plays to Last.fm automatically.", "Scrobble yer plays t' Last.fm automatically."],
	["in each library's chordia-library.toml", "in each hoard's chordia-library.toml"],

	// g-dropping: "-ing" words read pirate without dictionary entries…
	["Loading libraries…", "Loadin' hoards…"],
	["Anything that helps reviewers", "Anythin' that helps reviewers"],
	["All live recordings", "All live recordin's"],

	// …but not where the g belongs to the root.
	["a thing on a string", "a thing on a string"],

	// Removed dictionary nonsense stays removed: "welcome" is not "avast", pronoun "This" is not
	// "This here", determiner "No" is not "Nay".
	["Welcome, friend", "Welcome, matey"],
	["This moves files on disk.", "This moves files on disk."],
	["No lyrics available for this track.", "No lyrics available fer this ditty."],
];

// ── Pig Latin ──────────────────────────────────────────────────────────────────────────────────

const pigWordCases = [
	// All-caps initialisms (optionally pluralised) are left alone — "EQWAY" is not a word.
	["EQ", "EQ"],
	["FLAC", "FLAC"],
	["GB", "GB"],
	["EPs", "EPs"],
	// No vowel at all: no sensible split.
	["Hz", "Hz"],
	// `y` is a vowel anywhere but the first letter…
	["my", "ymay"],
	["rhythm", "ythmrhay"],
	["type", "ypetay"],
	// …and is a consonant there.
	["yellow", "ellowyay"],
	// Casing carries onto the moved cluster.
	["Play", "Ayplay"],
	["Shuffle", "Uffleshay"],
];

const pigMessageCases = [
	// Arguments and protected names survive; hyphenated words transform per part.
	["Play {title} on Chordia", "Ayplay {title} onway Chordia"],
	["Hip-Hop", "Iphay-Ophay"],
	// "WAV" is protected but must not fire inside "wave".
	["Mirror wave", "Irrormay aveway"],
	["~96 kbps Opus - minimal data.", "~96 kbps Opus - inimalmay ataday."],
];

let failures = 0;
let total = 0;

function run(label, inputs, fn) {
	for (const [input, expected] of inputs) {
		total++;
		let got;
		try {
			got = fn(input);
		} catch (e) {
			got = `THREW: ${e.message}`;
		}
		try {
			assert.equal(got, expected);
		} catch {
			failures++;
			console.error(`FAIL  [${label}] ${input}\n  expected: ${expected}\n  got:      ${got}`);
		}
	}
}

run("icu", cases, (input) => mapMessage(input, upper));
run("pirate", pirateCases, piratify);
run("piglatin-word", pigWordCases, toPigLatinWord);
run("piglatin", pigMessageCases, piglatinify);

// The pirate literal transform is exported for the generator; sanity-check it directly so a
// refactor cannot quietly stop applying the word table.
total++;
if (toPirate("your music") !== "yer shanties") {
	failures++;
	console.error(`FAIL  [pirate-literal] your music\n  got: ${toPirate("your music")}`);
}

if (failures) {
	console.error(`\n${failures}/${total} failed`);
	process.exit(1);
}
console.log(`${total}/${total} transform cases passed`);
