// Tests for the ICU-safe message transform behind the joke locales.
//
// The whole risk here is mangling something that must survive verbatim: an {argument}, a `plural`
// keyword, a case label. Any of those turns a working string into a broken one, and the joke
// locales are exactly where nobody would notice for months.
//
// Run: node scripts/generate-fun-locales.test.mjs

import { strict as assert } from "node:assert";
import { mapMessage } from "./generate-fun-locales.mjs";

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

let failures = 0;
for (const [input, expected] of cases) {
	let got;
	try {
		got = mapMessage(input, upper);
	} catch (e) {
		got = `THREW: ${e.message}`;
	}
	try {
		assert.equal(got, expected);
	} catch {
		failures++;
		console.error(`FAIL  ${input}\n  expected: ${expected}\n  got:      ${got}`);
	}
}

if (failures) {
	console.error(`\n${failures}/${cases.length} failed`);
	process.exit(1);
}
console.log(`${cases.length}/${cases.length} ICU transform cases passed`);
