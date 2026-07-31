// @chordia/i18n: shared localization catalogs (ICU MessageFormat).
//
// Single source of truth for every Chordia surface (frontend now, mobile/desktop later). The Rust
// crate in this same package serves the backend off the same `locales/` files. Crowdin syncs only
// `locales/`. This JS entry exposes the catalogs i18next-shaped, plus the supported-locale list.

// Eager-glob every catalog: locales/<lng>/<ns>.json. This is a Vite feature, and the only JS
// consumer is the Vite frontend. A new locale directory (e.g. from a Crowdin download) is picked
// up automatically.
const modules = import.meta.glob("./locales/*/*.json", {
	eager: true,
	import: "default",
}) as Record<string, Record<string, unknown>>;

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

export const resources: Resources = {};
for (const [path, json] of Object.entries(modules)) {
	const m = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
	if (!m) continue;
	const [, lng, ns] = m;
	const key = canonicalDir(lng);
	resources[key] ??= {};
	resources[key][ns] = json;
}

export const DEFAULT_LOCALE = "en";

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
export const SUPPORTED_LOCALES: string[] = Object.keys(resources).sort((a, b) =>
	a === DEFAULT_LOCALE ? -1 : b === DEFAULT_LOCALE ? 1 : a.localeCompare(b),
);

/** Maps lowercase(code) to the exact catalog key, for case-insensitive matching (`en-gb` to `en-GB`). */
const BY_LOWER = new Map(SUPPORTED_LOCALES.map((l) => [l.toLowerCase(), l]));

/** Language subtag of a BCP-47 tag, lowercased (`en-GB` becomes `en`). */
function baseLang(tag: string): string {
	return tag.toLowerCase().split("-")[0];
}

/** Namespaces present in the source locale (e.g. "common", "player"). */
export const NAMESPACES: string[] = Object.keys(resources[DEFAULT_LOCALE] ?? {});

/**
 * Curated native display names for the picker. Anything not listed is derived automatically via
 * `localeName()` (so a new regional variant from Crowdin shows a real name with no code change).
 */
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
