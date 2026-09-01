// @chordia/i18n: shared localization catalogs (ICU MessageFormat).
//
// Single source of truth for every Chordia surface (frontend now, mobile/desktop later). The Rust
// crate in this same package serves the backend off the same `locales/` files. Crowdin syncs only
// `locales/`. This JS entry exposes the catalogs i18next-shaped, plus the supported-locale list.
//
// ## The source locale is eager; every other one is fetched when it is wanted
//
// Globbing all of them eagerly put 1.2 MB of catalogs into the client bundle so that each visitor
// could use roughly 185 KB of it. Nine languages downloaded by everyone, including two joke
// locales that are 274 KB between them, on the chance that one of them is the one you asked for.
//
// `en` stays eager and cannot become lazy: it is the fallback every other catalog resolves missing
// keys through, it is the source `localeCoverage` measures against, and the server-error titles in
// `problem.ts` read it synchronously. The rest are dynamic imports, which Vite splits into a chunk
// per file and fetches only for the locale in use.
//
// A new locale directory (e.g. from a Crowdin download) is still picked up with no code change.
const eager = import.meta.glob("./locales/en/*.json", {
	eager: true,
	import: "default",
}) as Record<string, Record<string, unknown>>;

// The negative pattern is what stops `en` being emitted a second time as a lazy chunk. Without it
// every English catalog exists twice in the build: once inlined, once as a chunk nothing fetches.
const lazy = import.meta.glob(["./locales/*/*.json", "!./locales/en/*.json"], {
	import: "default",
}) as Record<string, () => Promise<Record<string, unknown>>>;

/** i18next-shaped resources: `{ en: { common: {…}, player: {…} }, es: {…} }`. */
export type Resources = Record<string, Record<string, Record<string, unknown>>>;

/** Canonical BCP-47 form of a directory name (`en-gb` becomes `en-GB`), so the JS loader matches
 * i18next's own internal canonicalization and stays case-insensitive like the Rust crate. */
function canonicalDir(dir: string): string {
	try {
		return Intl.getCanonicalLocales(dir)[0] ?? dir;
	} catch {
		return dir; // Not a valid BCP-47 tag, so keep as-is rather than throw at module load.
	}
}

/** `./locales/de-DE/player.json` becomes `["de-DE", "player"]`, or null for anything else. */
function parsePath(path: string): [string, string] | null {
	const m = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
	return m ? [canonicalDir(m[1]), m[2]] : null;
}

/**
 * Catalogs currently in memory.
 *
 * `en` is always here. Everything else appears once {@link loadLocale} has fetched it, so reading
 * `resources[locale]` without loading it first gets `undefined` rather than a catalog — which is
 * why the two places that read this directly (i18next init and the server-error titles) run after
 * the root route has loaded the active locale.
 *
 * On an SSR server this is module state shared by every request, so it accumulates catalogs as
 * different visitors arrive and settles at the full set. That is a cache rather than a leak: the
 * contents are the same read-only files for everybody and nothing here is per-request. Which
 * locale a given render USES is decided by the `lng` passed to i18next, not by what is in here.
 */
export const resources: Resources = {};
for (const [path, json] of Object.entries(eager)) {
	const parsed = parsePath(path);
	if (!parsed) continue;
	const [lng, ns] = parsed;
	resources[lng] ??= {};
	resources[lng][ns] = json;
}

export const DEFAULT_LOCALE = "en";

/** In-flight loads, so ten components asking at once cause one fetch rather than ten. */
const pending = new Map<string, Promise<void>>();

/** Whether a locale's catalogs are in memory and can be read synchronously. */
export function isLocaleLoaded(locale: string): boolean {
	return locale in resources;
}

/**
 * Put catalogs into {@link resources} without fetching them.
 *
 * For the case where they arrived by some other route than a dynamic import — the SSR document
 * inlines the active locale so the client has it before hydration, and re-fetching what is already
 * in the page would be a request for bytes already paid for.
 */
export function adoptCatalogs(
	locale: string,
	catalogs: Record<string, Record<string, unknown>>,
): void {
	const key = canonicalDir(locale);
	resources[key] = { ...catalogs, ...resources[key] };
	pending.set(key, Promise.resolve());
}

/**
 * Fetch one locale's catalogs into {@link resources}.
 *
 * Idempotent and safe to call for `en` or for anything unrecognised: both resolve immediately
 * without a request. Failures resolve rather than reject -- a catalog that will not load leaves
 * i18next to fall back to English, which is a degraded interface rather than a broken one, and
 * throwing here would take the route load down with it.
 */
export function loadLocale(locale: string): Promise<void> {
	const key = canonicalDir(locale);
	if (isLocaleLoaded(key)) return Promise.resolve();
	const existing = pending.get(key);
	if (existing) return existing;

	const entries = Object.entries(lazy).filter(
		([path]) => parsePath(path)?.[0] === key,
	);
	if (entries.length === 0) return Promise.resolve();

	const load = Promise.all(
		entries.map(async ([path, importer]) => {
			const ns = parsePath(path)?.[1];
			if (!ns) return;
			try {
				const json = await importer();
				resources[key] ??= {};
				resources[key][ns] = json;
			} catch {
				// One namespace missing is a gap i18next fills from English, not a reason to fail.
			}
		}),
	).then(() => {});
	pending.set(key, load);
	return load;
}

/**
 * Fetch every catalog.
 *
 * Exists for the language picker, which shows a coverage percentage for each locale and therefore
 * genuinely needs all of them. That is the whole 1.2 MB -- paid once, by someone who opened the
 * language settings, instead of by everyone on first paint.
 */
export function loadAllLocales(): Promise<void> {
	return Promise.all(SUPPORTED_LOCALES.map(loadLocale)).then(() => {});
}

/**
 * Locales we ship catalogs for, source `en` first then the rest alphabetically.
 *
 * Directory names are the BCP-47 tags Crowdin exports, which for every translated language means a
 * regional one (`de-DE`, `fr-FR`, `ja-JP`, `ko-KR`, `es-ES`, `pt-BR`). Matching Crowdin's own output
 * is deliberate: the alternative was setting Language Mapping per target to strip the region, and a
 * mapping that must be re-set for every new language is a step someone will forget — as one already
 * was, which is how translations spent time landing in `locales/de-DE/` while the app read
 * `locales/de/`.
 *
 * A bare request still resolves: `resolveLocale` falls back exact → base → regional sibling, so a
 * browser asking for `de` gets `de-DE`. `en-GB` is the one true override catalog — it has `en`
 * behind it, so it carries only the keys where British spelling differs.
 */
export const SUPPORTED_LOCALES: string[] = [
	...new Set(
		[...Object.keys(eager), ...Object.keys(lazy)]
			.map((path) => parsePath(path)?.[0])
			.filter((l): l is string => Boolean(l)),
	),
].sort((a, b) =>
	a === DEFAULT_LOCALE ? -1 : b === DEFAULT_LOCALE ? 1 : a.localeCompare(b),
);

/** Maps lowercase(code) to the exact catalog key, for case-insensitive matching (`en-gb` to `en-GB`). */
const BY_LOWER = new Map(SUPPORTED_LOCALES.map((l) => [l.toLowerCase(), l]));

/** Language subtag of a BCP-47 tag, lowercased (`en-GB` becomes `en`). */
function baseLang(tag: string): string {
	return tag.toLowerCase().split("-")[0];
}

/**
 * Namespaces present in the source locale (e.g. "common", "player").
 *
 * From the eager catalog rather than from whatever happens to be loaded, so this is the same list
 * on the first render as on the hundredth.
 */
export const NAMESPACES: string[] = Object.keys(resources[DEFAULT_LOCALE] ?? {});

/**
 * Curated native display names for the picker. Anything not listed is derived automatically via
 * `localeName()` (so a new regional variant from Crowdin shows a real name with no code change).
 */
/**
 * Where someone can help translate. Public crowdsourcing page for the Crowdin project.
 *
 * Lives here rather than in a client because every surface that offers a language picker wants it,
 * and because it belongs next to the catalogs it is about.
 */
export const TRANSLATION_PROJECT_URL = "https://naila.crowdin.com/chordia";

/** How much of the source catalog a locale actually supplies. */
export interface LocaleCoverage {
	/** Keys this catalog holds that the source also has. */
	translated: number;
	/** Keys in the source catalog. */
	total: number;
	/** 0-100. `undefined` for an override-only catalog, where a percentage means nothing. */
	percent?: number;
	/**
	 * True when this catalog only overrides a base language that is itself shipped.
	 *
	 * `en-GB` has `en` behind it, so its 32 keys are the whole job and "1% translated" would be a
	 * lie. `pt-BR` has no `pt` catalog to fall back to, so it resolves straight to English and its
	 * gaps are real gaps. Same rule the catalog check uses; the two must agree or the settings
	 * screen and CI will describe the same locale differently.
	 */
	overridesOnly: boolean;
}

const coverageCache = new Map<string, LocaleCoverage>();

/**
 * Count what a locale covers, from the catalogs themselves.
 *
 * Derived rather than generated into a file on purpose: a checked-in number is a number that can
 * disagree with the catalogs beside it, and this one is cheap — a few thousand key comparisons,
 * once, the first time a language picker asks.
 */
export function localeCoverage(locale: string): LocaleCoverage {
	const cached = coverageCache.get(locale);
	if (cached) return cached;

	const source = resources[DEFAULT_LOCALE] ?? {};
	const target = resources[locale] ?? {};
	// Not loaded yet is not the same as empty. Counting an absent catalog would report a real
	// language as 0% translated, and caching that would keep saying so after it arrived -- so this
	// answers "unknown" and, crucially, does not remember the answer.
	const known = isLocaleLoaded(locale);
	let total = 0;
	let translated = 0;
	for (const [ns, keys] of Object.entries(source)) {
		const flatSource = flattenKeys(keys);
		total += flatSource.size;
		const flatTarget = flattenKeys(target[ns] ?? {});
		for (const key of flatSource) if (flatTarget.has(key)) translated++;
	}

	const base = locale.split("-")[0];
	// Against the shipped list, not against what is loaded. `base in resources` used to mean the
	// same thing when every catalog was in memory; with lazy loading it would call `en-GB` an
	// override-only catalog or not depending on whether `en` happened to be loaded yet.
	const overridesOnly =
		locale.includes("-") && locale !== base && SUPPORTED_LOCALES.includes(base);

	const result: LocaleCoverage = {
		translated,
		total,
		overridesOnly,
		percent:
			overridesOnly || total === 0 || !known
				? undefined
				: Math.round((translated / total) * 100),
	};
	if (known) coverageCache.set(locale, result);
	return result;
}

/** Dotted leaf keys of one namespace, so nested objects compare like the check's flatten does. */
function flattenKeys(
	node: Record<string, unknown>,
	prefix = "",
	out = new Set<string>(),
): Set<string> {
	for (const [k, v] of Object.entries(node)) {
		const key = prefix ? `${prefix}.${k}` : k;
		if (v && typeof v === "object" && !Array.isArray(v)) {
			flattenKeys(v as Record<string, unknown>, key, out);
		} else {
			out.add(key);
		}
	}
	return out;
}

export const LOCALE_NAMES: Record<string, string> = {
	en: "English",
	// Curated because the derived names read as bureaucracy once the tags carry a region:
	// `Intl.DisplayNames` turns `de-DE` into "Deutsch (Deutschland)", which is not what a German
	// speaker calls their language. The region is kept only where it genuinely distinguishes the
	// variant on offer — Brazilian Portuguese, British English.
	"de-DE": "Deutsch",
	"en-GB": "English (UK)",
	"es-ES": "Español",
	"fr-FR": "Français",
	"ja-JP": "日本語",
	"ko-KR": "한국어",
	"pt-BR": "Português (Brasil)",
	// Joke locales. Intl.DisplayNames cannot name a private-use subtag, so these have to be
	// curated — and by the same convention every other entry follows, each is written in itself.
	"en-x-pirate": "Pirate Speak",
	"en-x-piglatin": "Igpay Atinlay",
};

/**
 * Flag shown beside each language in the picker.
 *
 * Flags mean countries and these are languages, so the mapping is a convention, not a fact:
 * Spanish is not only Spain's, and Portuguese here is explicitly Brazil's. It stays an explicit
 * table rather than something derived from the region subtag precisely because those choices
 * deserve to be looked at rather than computed — and because a bare language like `es` has no
 * region to derive from. A locale absent from this table renders without a flag.
 */
export const LOCALE_FLAGS: Record<string, string> = {
	en: "\u{1F1FA}\u{1F1F8}",
	"en-GB": "\u{1F1EC}\u{1F1E7}",
	"es-ES": "\u{1F1EA}\u{1F1F8}",
	"fr-FR": "\u{1F1EB}\u{1F1F7}",
	"de-DE": "\u{1F1E9}\u{1F1EA}",
	"ja-JP": "\u{1F1EF}\u{1F1F5}",
	"ko-KR": "\u{1F1F0}\u{1F1F7}",
	"pt-BR": "\u{1F1E7}\u{1F1F7}",
	"en-x-pirate": "\u{1F3F4}\u{200D}\u{2620}\u{FE0F}",
	"en-x-piglatin": "\u{1F437}",
};

/**
 * Flag emoji for a locale, or undefined when there is no sensible one.
 *
 * Falls back from an exact match to the base language, so a future `es-MX` shows Spain's flag
 * rather than nothing until someone decides it deserves Mexico's.
 */
export function localeFlag(code: string): string | undefined {
	return LOCALE_FLAGS[code] ?? LOCALE_FLAGS[baseLang(code)];
}

/** Human-readable native name for a locale code, for the language picker. */
export function localeName(code: string): string {
	const curated = LOCALE_NAMES[code];
	if (curated) return curated;
	try {
		// In the locale's own language: `en-GB` gives "British English", `es-MX` gives "Español de México".
		const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
		if (name && name.toLowerCase() !== code.toLowerCase()) {
			return name.charAt(0).toUpperCase() + name.slice(1);
		}
	} catch {
		// Intl.DisplayNames unavailable or unknown code, so fall through to the raw code.
	}
	return code;
}

/**
 * Resolve a requested tag to a locale we actually ship, in preference order:
 *   1. exact match (case-insensitive): `en-GB` resolves to `en-GB`
 *   2. the bare base language:         `en-AU` resolves to `en`
 *   3. any regional sibling:           `es`    resolves to `es-ES` (when only regional Spanish is shipped)
 *   4. the default locale.
 * Returns a real catalog key, so it's safe to hand straight to i18next as `lng` or use as `<html lang>`.
 */
export function resolveLocale(candidate: string | null | undefined): string {
	if (!candidate) return DEFAULT_LOCALE;
	// Trim + lowercase to match the Rust `match_supported` normalization exactly (so the SSR cookie
	// resolver and the backend never disagree on a padded/odd-cased value).
	const lower = candidate.trim().toLowerCase();
	if (!lower) return DEFAULT_LOCALE;
	const exact = BY_LOWER.get(lower);
	if (exact) return exact;
	const base = baseLang(lower);
	const bare = BY_LOWER.get(base);
	if (bare) return bare;
	const sibling = SUPPORTED_LOCALES.find((l) => baseLang(l) === base);
	return sibling ?? DEFAULT_LOCALE;
}
