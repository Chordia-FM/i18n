// Download translations from Crowdin, then make the result safe to commit.
//
// Run: node scripts/pull-translations.mjs   (or `npm run crowdin:pull`)
//
// Crowdin's JSON export preserves the key structure of the source file and writes `""` for anything
// untranslated. That is not a cosmetic difference from omitting the key — it is the opposite of it.
// A missing key falls back to English; an empty string is found, treated as a translation, and
// rendered as nothing, so the UI goes blank exactly where a translation is absent.
//
// Two things were tried before settling on this, and neither worked: ticking "Skip untranslated
// strings" in the project's export settings (which governs the GitHub integration, not the CLI),
// and passing `--skip-untranslated-strings` to `crowdin download`. Both left the output
// byte-identical at 1,920 empty values across seven locales. Rather than keep guessing at the
// exporter's behaviour, the pull now normalises what it receives — which is correct whatever
// Crowdin decides to emit, including if it changes again later.
//
// The flag stays on the download anyway: if it ever does start omitting keys, this becomes a no-op
// rather than a thing to unpick.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../locales", import.meta.url).pathname.replace(
	/^\/([A-Z]:)/,
	"$1",
);
const SOURCE = "en";
// Resolve the platform's binary directly rather than going through a shell. `spawnSync` with
// `shell: true` concatenates arguments instead of escaping them, which Node now warns about
// (DEP0190) — and there is no reason to invoke a shell just to find an executable.
const CLI = join(
	"node_modules",
	".bin",
	process.platform === "win32" ? "crowdin.exe" : "crowdin",
);

/** Remove empty-string leaves, and any object left empty by that. Returns the count removed. */
function prune(node) {
	let removed = 0;
	for (const [k, v] of Object.entries(node)) {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			removed += prune(v);
			if (Object.keys(v).length === 0) delete node[k];
		} else if (typeof v === "string" && !v.trim()) {
			delete node[k];
			removed += 1;
		}
	}
	return removed;
}

/** Stable key order, so a pull produces a reviewable diff rather than a reshuffle. */
function sortDeep(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((k) => [k, sortDeep(value[k])]),
	);
}

const args = [
	"download",
	"--branch",
	"main",
	"--skip-untranslated-strings",
	...process.argv.slice(2),
];
console.log(`> crowdin ${args.join(" ")}`);
const run = spawnSync(CLI, args, { stdio: "inherit" });
if (run.status !== 0) {
	console.error("\ncrowdin download failed; leaving the working tree alone.");
	process.exit(run.status ?? 1);
}

let removed = 0;
let files = 0;
for (const locale of readdirSync(ROOT)) {
	if (locale === SOURCE || !statSync(join(ROOT, locale)).isDirectory()) continue;
	for (const ns of readdirSync(join(ROOT, locale))) {
		if (!ns.endsWith(".json")) continue;
		const path = join(ROOT, locale, ns);
		let json;
		try {
			json = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			console.error(`  ! ${locale}/${ns} is not valid JSON — ${e.message}`);
			process.exitCode = 1;
			continue;
		}
		const n = prune(json);
		if (n === 0) continue;
		writeFileSync(path, `${JSON.stringify(sortDeep(json), null, "\t")}\n`);
		removed += n;
		files += 1;
	}
}

console.log(
	removed
		? `\nStripped ${removed} empty value(s) from ${files} file(s). ` +
				"Each one is an untranslated string, and omitting the key is what lets it fall back to English."
		: "\nNo empty values in the download.",
);
console.log("Review with `git status` / `git diff`, then run `npm run check`.");
