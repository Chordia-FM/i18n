// Tests for the ICU argument extractor.
//
// This function was wrong twice — once reading plural branch bodies as arguments, once reading
// select case labels as arguments — and both times the wrong reading was laundered into a
// translation brief and corrupted real strings. Every case below is one that actually bit.
//
// Run: node scripts/check-catalogs.test.mjs

import { strict as assert } from "node:assert";
import { pluralConstructs, placeholders } from "./check-catalogs.mjs";

const cases = [
	// Plain arguments.
	["{days}d {hours}h", ["days", "hours"]],
	["since {date}", ["date"]],
	["no arguments at all", []],

	// Plural: the argument is the name before `plural`; the branch bodies are literal words.
	[
		"{count, plural, one {# play} other {# plays}}",
		["count"],
	],
	[
		"{albumsFormatted} {albums, plural, one {album} other {albums}} · {artistsFormatted} {artists, plural, one {artist} other {artists}}",
		["albumsFormatted", "albums", "artistsFormatted", "artists"],
	],

	// Select: labels are arbitrary identifiers, so `them` must not be mistaken for a keyword and
	// `Streaks` — the first word of a branch body — must not be read as an argument.
	[
		"{person, select, them {Streaks, records, and milestones build as they listen.} other {Streaks, records, and milestones build as you listen.}}",
		["person"],
	],

	// Arguments nested inside a branch body are real and must be found.
	[
		"{count, plural, one {{name} played once} other {{name} played # times}}",
		["count", "name"],
	],

	// Formatted arguments carry a style, not sub-messages.
	["{date, date, long}", ["date"]],
	["{value, number, percent}", ["value"]],

	// Unbalanced input must not throw; the brace check reports it separately.
	["{count, plural, one {# a} other {# b}", ["count"]],
];

let failures = 0;
for (const [input, expected] of cases) {
	const got = [...placeholders(input)].sort();
	const want = [...expected].sort();
	try {
		assert.deepEqual(got, want);
	} catch {
		failures++;
		console.error(`FAIL  ${input}\n  expected: ${want.join(", ") || "(none)"}\n  got:      ${got.join(", ") || "(none)"}`);
	}
}

if (failures) {
	console.error(`\n${failures}/${cases.length} failed`);
	process.exit(1);
}
console.log(`${cases.length}/${cases.length} ICU extractor cases passed`);

// Plural vs ordinal. English ordinals legitimately use two/few (2nd, 3rd) while English plurals
// never do — checking one against the other's table rejects correct work, which it did.
const constructCases = [
	[
		"{count, plural, one {# play} other {# plays}}",
		[{ type: "plural", categories: ["one", "other"] }],
	],
	[
		"{ordinal, selectordinal, one {#st play} two {#nd play} few {#rd play} other {#th play}}",
		[{ type: "selectordinal", categories: ["one", "two", "few", "other"] }],
	],
	// `select` labels are ours, not CLDR's, so they must not be reported for validation at all.
	["{person, select, them {a} other {b}}", []],
	// Exact matches are legal in any language.
	[
		"{count, plural, =0 {none} one {# play} other {# plays}}",
		[{ type: "plural", categories: ["=0", "one", "other"] }],
	],
	["no constructs here", []],
];

for (const [input, expected] of constructCases) {
	const got = pluralConstructs(input).map((c) => ({
		type: c.type,
		categories: [...c.categories],
	}));
	try {
		assert.deepEqual(got, expected);
	} catch {
		failures++;
		console.error(`FAIL  ${input}
  expected: ${JSON.stringify(expected)}
  got:      ${JSON.stringify(got)}`);
	}
}
if (failures) process.exit(1);
console.log(`${constructCases.length}/${constructCases.length} plural-construct cases passed`);
