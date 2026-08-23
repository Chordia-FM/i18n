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
// The pirate transform is layered, best joke first:
//   1. PIRATE_PHRASES — curated rewrites matched against the FULL English message. Idiom lives
//      here: "Welcome back" is a phrase, not three words.
//   2. PIRATE_WORDS — word-for-word swaps that are safe in ANY grammatical position.
//   3. g-dropping — any remaining "-ing" word loses its g ("playing" → "playin'").
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

/**
 * Double an apostrophe that ICU would read as an escape.
 *
 * In ICU MessageFormat `'` only quotes when it immediately precedes `{`, `}` or `#`, and doubling
 * it is how you say "I meant the character". The pirate dialect elides trailing g's, so a plural
 * branch ending in a verb produces `…listenin'}` — the apostrophe swallows the closing brace and
 * the whole message stops parsing. Two catalogs shipped broken that way before the regeneration
 * that surfaced this.
 *
 * Applied once at the outermost transform, never inside the recursion, or a second pass would turn
 * a correct `''` into `''''`.
 */
export function escapeStrayApostrophes(text) {
	return text.replace(/'(?=[{}#])/g, "''");
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

// ── Names that must survive any transform ──────────────────────────────────────────────────────
//
// Product names, third-party services, codecs and literal technical tokens are not English words
// and must never be "translated" — neither pirate nor pig latin. Each literal run is split on
// these and only the text in between is transformed. Matched case-insensitively (so the literal
// `chordia-library.toml` survives too) but only at word edges: "WAV" must not fire inside "wave".

const PROTECTED =
	/((?<![A-Za-z])(?:chordia-library\.toml|Chordia|Last\.fm|MusicBrainz|AcoustID|Spotify|Discord|GitHub|ReplayGain|fanart\.tv|Dolby|Atmos|Opus|Wrapped|FLAC|ALAC|WAV|AAC|LRC|MiB|e\.g\.|before_ms|before_id)(?![A-Za-z]))/i;

/** Wrap a literal-text transform so protected names pass through verbatim. */
function keepingProtected(fn) {
	// split() with a capturing group interleaves matches at odd indices.
	return (text) =>
		text
			.split(PROTECTED)
			.map((seg, i) => (i % 2 ? seg : fn(seg)))
			.join("");
}

// ── Pirate ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Curated phrase-level rewrites, matched against the FULL English message before any word-level
 * work. Word swaps cannot fix idiom, so the strings a user actually stares at — buttons, nav,
 * player controls, auth screens, empty/loading/error states — get real pirate here.
 *
 * Rules for entries:
 *   - An entry bypasses the ICU-aware transform, so it MUST reproduce every {argument} of its
 *     English source exactly (check-catalogs verifies this). Prefer leaving a string uncurated
 *     over curating it wrongly.
 *   - The key must byte-match the English source string, including `…` and curly quotes.
 *   - Keep the pirate roughly as short as the English — these sit in buttons, a player bar and a
 *     sidebar, and a punchline that overflows its container is not funny.
 */
const PIRATE_PHRASES = new Map(
	Object.entries({
		// Common actions
		Save: "Stow it",
		Cancel: "Belay that",
		Confirm: "Aye aye",
		Close: "Batten down",
		Done: "Shipshape",
		Next: "Onward",
		Previous: "Astern",
		Retry: "Fire again",
		"Try again": "Give 'er another go",
		OK: "Aye",
		Undo: "As ye were",
		"Clear all": "Clear th' decks",
		Leave: "Jump ship",
		Accept: "Welcome aboard",
		"Confirm?": "Aye or nay?",
		"I understand": "Aye, savvy",
		Connect: "Lash on",
		"Connecting…": "Comin' alongside…",

		// Loading / status / errors
		"Loading…": "Heave ho…",
		Failed: "Sunk",
		Cancelled: "Belayed",
		Completed: "Safe in th' hold",
		"Failed to load": "Lost at sea",
		"Failed to save": "Couldn't stow it",
		"Save failed.": "Couldn't stow it.",
		"Page not found": "Fell off th' map",
		"This page doesn't exist.": "Nothin' here but open sea.",
		"Something went wrong": "We struck a reef",
		"An unexpected error interrupted this page. You can try again or head back home.":
			"A rogue wave swamped this page. Try yer luck again, or sail back t' port.",
		"No matches.": "Nary a match.",
		"No results for “{term}”.": "No booty found fer “{term}”.",
		"Incorrect email or password.": "Wrong email or watchword, matey.",

		// Auth
		"Welcome back": "Back aboard, matey!",
		"Sign in": "Come aboard",
		"Sign in to your Chordia account": "Climb aboard yer Chordia vessel",
		"Signing in…": "Comin' aboard…",
		"Sign out": "Abandon ship",
		"Keep me signed in": "Keep me aboard",
		"Don't have an account?": "New t' these waters?",
		"Create one": "Enlist",
		"Create an account": "Join th' crew",
		"Create account": "Join th' crew",
		"Creating account…": "Signin' th' articles…",
		"Already have an account?": "Already one o' th' crew?",
		"Login failed": "Boardin' repelled",
		"Registration failed": "Enlistment failed",
		"Welcome to Chordia": "Welcome aboard Chordia",
		"Continue to Chordia": "Sail on t' Chordia",
		"Completing sign-in…": "Haulin' ye aboard…",

		// Navigation
		"Go home": "Back t' port",

		// Player
		Play: "Strike up",
		"Play {title}": "Strike up {title}",
		"Play {title} by {artist}": "Strike up {title} by {artist}",
		"Play next": "Strike up next",
		Pause: "Avast!",
		Mute: "Muzzle th' parrot",
		Unmute: "Free th' parrot",
		"Not playing": "Becalmed",
		"Nothing playing.": "All quiet on deck.",
		"Nothing playing yet.": "All quiet on deck.",
		"Play something to see the visualizer.": "Strike up a shanty t' see th' visualizer.",
		Queue: "Th' muster",
		"Add to queue": "Add t' th' muster",
		"Remove from queue": "Cast off from th' muster",
		"Queue is empty.": "Th' muster be empty.",
		"About {name}": "Th' legend o' {name}",
		"Sleep timer": "Dogwatch timer",
		"Recently played": "Last heard on deck",
		"Recently Played": "Last Heard on Deck",
		"Liked Songs": "Treasured Shanties",
		"Save to Liked Songs": "Stow in Treasured Shanties",
		"Remove from Liked Songs": "Cast out o' Treasured Shanties",
		Explicit: "Salty",

		// Home / discovery
		"Good morning": "Mornin', me hearty",
		"Good afternoon": "Afternoon, me hearty",
		"Good evening": "Evenin', me hearty",
		"Jump back in": "Climb back aboard",
		"Made for you": "Charted fer ye",
		"Made for {name}": "Charted fer {name}",
		"Recommended for you": "Th' quartermaster's picks",
		"Trending albums": "Treasures makin' waves",
		"Trending artists": "Artists makin' waves",
		"Daily Mix": "Daily Grog",
		Radio: "Pirate radio",

		// Insights ("top" is a superlative English keeps reusing; keep the pirate consistent)
		"Top artists": "Choicest minstrels",
		"Top Artists": "Choicest Minstrels",
		"Top artist": "Choicest minstrel",
		"Top tracks": "Choicest ditties",
		"Top Tracks": "Choicest Ditties",
		"Top track": "Choicest ditty",
		"Top genres": "Choicest genres",
		"Top Genres": "Choicest Genres",
		"Top genre": "Choicest genre",
		"Top albums": "Choicest treasures",
		"Top Albums": "Choicest Treasures",
		"Top album": "Choicest treasure",
		"Your top albums": "Yer choicest treasures",
		"Your top tracks": "Yer choicest ditties",
		"Friend Activity": "Crew's Doin's",
		"Quiet in here": "Quiet as th' deep",

		// Library / downloads / sharing
		"Available offline": "Plays even adrift",
		"stored on this device": "stashed in yer sea chest",
		"Library server connected!": "Ship's lashed alongside!",
		"Pairing failed": "Th' mooring didn't hold",
		"Friends & sharing": "Hearties & spoils",
		"This profile is private": "These waters be private",
		"No friends yet - search to add some": "No hearties yet - press-gang a few",

		// Settings
		"Sign out everywhere": "Abandon all ships",
		"Delete forever": "Send t' Davy Jones",

		// Manager (the quartermaster kept the ship's stores)
		Manager: "Quartermaster",
		"Library Manager": "Th' Quartermaster",
		"Back to Manager": "Back t' th' Quartermaster",
		"Manager settings": "Quartermaster's riggin'",
		"Track your coverage and find what you're missing.":
			"Chart yer coverage an' spy what ye be missin'.",
	}),
);

/**
 * Deterministic word substitutions, so regenerating produces no diff churn.
 *
 * Every entry must read correctly in ANY grammatical position the word can occupy, because this
 * table cannot see context. Entries that only worked in some positions were removed and their
 * showcase strings curated in PIRATE_PHRASES instead:
 *   welcome → "avast"          "avast" means STOP; it was never a greeting ("Avast back")
 *   loading → "hoistin' sail"  nonsense mid-sentence ("Hoistin' sail lyrics…"); g-dropping
 *                              gives "loadin'" for free
 *   about → "concernin'"       wrong for "know about", stilted in the "About {name}" heading
 *   this/that → "this here" /  breaks pronoun, conjunction and degree uses: "This moves files…",
 *     "that thar"              "Anything that helps", "that many plays"
 *   no → "nay"                 "nay" is only the interjection; the determiner broke ("Nay matches")
 *   account → "ship's papers"  wrong number/article everywhere ("an ship's papers")
 *   please → "if ye please"    clause-initial only; "pray" works in every position
 */
const PIRATE_WORDS = new Map(
	Object.entries({
		my: "me", your: "yer", yours: "yers", yourself: "yerself",
		you: "ye", "you're": "ye be", "you've": "ye've", "you'll": "ye'll", "you'd": "ye'd",
		is: "be", are: "be", was: "were", "isn't": "ain't", "aren't": "ain't",
		there: "thar", "there's": "thar be",
		hello: "ahoy", hi: "ahoy", yes: "aye", ok: "aye", okay: "aye",
		friend: "matey", "friend's": "matey's", friends: "hearties", "friends'": "hearties'",
		people: "scallywags", person: "scallywag",
		everyone: "all hands", "everyone's": "all hands'", user: "deckhand", users: "crew",
		music: "shanties", song: "shanty", songs: "shanties", track: "ditty", tracks: "ditties",
		album: "treasure", "album's": "treasure's", albums: "treasures",
		playlist: "chart", playlists: "charts", smart: "cunning",
		library: "hoard", "library's": "hoard's", libraries: "hoards",
		search: "hunt", searching: "huntin'", find: "spy", found: "spied",
		settings: "riggin'", home: "port", stop: "belay", queue: "muster",
		remove: "cast off", delete: "scuttle", error: "calamity", warning: "storm warnin'",
		save: "stow", saved: "stowed", saving: "stowin'",
		download: "plunder", downloads: "booty", downloaded: "plundered", downloading: "plunderin'",
		share: "divvy up", shares: "divvies", shared: "divvied", sharing: "divvyin' up",
		password: "watchword", passwords: "watchwords",
		money: "doubloons", before: "afore", between: "betwixt",
		over: "o'er", never: "ne'er", ever: "e'er", the: "th'", of: "o'",
		and: "an'", to: "t'", for: "fer", with: "wi'", them: "'em",
		very: "mighty", quickly: "smartly",
		goodbye: "fair winds", please: "pray", sorry: "beggin' pardon",
	}),
);

/** Carry the source token's casing onto its replacement. */
function matchCase(src, repl) {
	if (src === src.toUpperCase() && src.length > 1) return repl.toUpperCase();
	if (src[0] === src[0]?.toUpperCase()) return repl[0].toUpperCase() + repl.slice(1);
	return repl;
}

/** ing-root words where the g is part of the root — "string" must not become "strin'". */
const ING_ROOTS = new Set([
	"thing", "string", "spring", "bring", "sting", "swing", "cling", "fling", "wring",
]);

/**
 * Pirates drop their g's: "playing" → "playin'", "recordings" → "recordin's". This is what makes
 * un-curated sentences read pirate instead of find-and-replace. Words of four letters or fewer
 * ("ring", "king", "sing") keep their g — there the "ing" is the whole syllable.
 */
function dropG(word) {
	const lower = word.toLowerCase();
	if (lower.length >= 5 && lower.endsWith("ing") && !ING_ROOTS.has(lower)) {
		return `${word.slice(0, -1)}'`;
	}
	if (lower.length >= 6 && lower.endsWith("ings") && !ING_ROOTS.has(lower.slice(0, -1))) {
		return `${word.slice(0, -2)}'s`;
	}
	return word;
}

/** Word-level pirate for one run of literal text. */
export const toPirate = keepingProtected((text) =>
	text.replace(/[A-Za-z']+/g, (word) => {
		const hit = PIRATE_WORDS.get(word.toLowerCase());
		return hit ? matchCase(word, hit) : dropG(word);
	}),
);

/** Full pirate transform for one message: curated phrase first, else ICU-safe word work. */
export function piratify(message) {
	return escapeStrayApostrophes(
		PIRATE_PHRASES.get(message) ?? mapMessage(message, toPirate),
	);
}

// ── Pig Latin ──────────────────────────────────────────────────────────────────────────────────

const VOWELS = /[aeiou]/i;

// All-caps tokens are initialisms ("EQ", "GB", "URL"), optionally pluralised ("EPs", "IDs").
// "EQWAY" is not a joke anyone is telling; leave them.
const ACRONYM = /^[A-Z]{2,}s?$/;

export function toPigLatinWord(word) {
	if (ACRONYM.test(word)) return word;
	const lower = word.toLowerCase();
	// `y` counts as a vowel anywhere but the first letter: "rhythm" and "my" split at the y,
	// "yellow" does not.
	let split = 0;
	while (split < lower.length && !(VOWELS.test(lower[split]) || (split > 0 && lower[split] === "y"))) {
		split++;
	}
	// No vowel anywhere ("Hz", "GB"): no sensible split; leave it.
	if (split === lower.length) return word;
	const moved = split === 0 ? `${word}way` : `${word.slice(split)}${word.slice(0, split)}ay`;
	return matchCase(word, moved.toLowerCase());
}

// Hyphenated words transform per part ("Hip-Hop" → "Iphay-Ophay"), which is the standard reading.
const toPigLatin = keepingProtected((text) => text.replace(/[A-Za-z]+/g, toPigLatinWord));

/** Full pig latin transform for one message. */
export function piglatinify(message) {
	return escapeStrayApostrophes(mapMessage(message, toPigLatin));
}

// ── Generation ─────────────────────────────────────────────────────────────────────────────────

const VARIANTS = [
	{ dir: "en-x-pirate", mapString: piratify },
	{ dir: "en-x-piglatin", mapString: piglatinify },
];

/** Recursively transform a catalog, keeping only the keys whose value actually changed. */
function transformTree(node, mapString) {
	const out = {};
	for (const [key, value] of Object.entries(node)) {
		if (value && typeof value === "object") {
			const sub = transformTree(value, mapString);
			if (Object.keys(sub).length) out[key] = sub;
		} else if (typeof value === "string") {
			const next = mapString(value);
			// An unchanged string is dead weight: en-x-pirate falls back to en for anything absent,
			// so storing an identical copy only creates something to re-check when the English moves.
			if (next !== value) out[key] = next;
		}
	}
	return out;
}

function main() {
	const namespaces = readdirSync(join(LOCALES, SOURCE)).filter((f) => f.endsWith(".json"));
	for (const { dir, mapString } of VARIANTS) {
		const out = join(LOCALES, dir);
		rmSync(out, { recursive: true, force: true });
		mkdirSync(out, { recursive: true });
		let keys = 0;
		let files = 0;
		for (const ns of namespaces) {
			const src = JSON.parse(readFileSync(join(LOCALES, SOURCE, ns), "utf8"));
			const tree = transformTree(src, mapString);
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
