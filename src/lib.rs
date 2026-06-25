//! `chordia-i18n` is shared localization for the Chordia ecosystem.
//!
//! The catalogs in `./locales/<lng>/<ns>.json` (ICU MessageFormat) are the single source of truth,
//! synced with Crowdin. They're embedded into the binary at compile time (`include_dir!`) so any
//! Rust consumer (backend, library, and so on) is self-contained, with nothing to deploy beside the
//! binary. The same `locales/` files back the JS surfaces via this package's `index.ts`.
//!
//! Usage: `chordia_i18n::t(locale, "errors:auth.badCredentials", &args)`.

use std::collections::HashMap;
use std::sync::OnceLock;

use include_dir::{include_dir, Dir};
use serde_json::Value;

static LOCALES_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/locales");

pub const DEFAULT_LOCALE: &str = "en";

/// `locale → namespace → catalog JSON`, parsed once.
fn catalogs() -> &'static HashMap<String, HashMap<String, Value>> {
    static CATALOGS: OnceLock<HashMap<String, HashMap<String, Value>>> = OnceLock::new();
    CATALOGS.get_or_init(|| {
        let mut by_locale: HashMap<String, HashMap<String, Value>> = HashMap::new();
        for lang_dir in LOCALES_DIR.dirs() {
            let Some(lng) = lang_dir.path().file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let mut by_ns: HashMap<String, Value> = HashMap::new();
            for file in lang_dir.files() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Some(ns) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if let Ok(v) = serde_json::from_slice::<Value>(file.contents()) {
                    by_ns.insert(ns.to_string(), v);
                }
            }
            // Key by the directory's BCP-47 name as-is (e.g. `en`, `en-GB`). Matching is
            // case-insensitive via `locale_index`.
            by_locale.insert(lng.to_string(), by_ns);
        }
        by_locale
    })
}

/// `(lowercase(code) → canonical key, canonical keys sorted with the default first)`, built once.
fn locale_index() -> &'static (HashMap<String, String>, Vec<String>) {
    static IDX: OnceLock<(HashMap<String, String>, Vec<String>)> = OnceLock::new();
    IDX.get_or_init(|| {
        let mut sorted: Vec<String> = catalogs().keys().cloned().collect();
        sorted.sort_by(|a, b| match (a.as_str(), b.as_str()) {
            (DEFAULT_LOCALE, _) => std::cmp::Ordering::Less,
            (_, DEFAULT_LOCALE) => std::cmp::Ordering::Greater,
            _ => a.cmp(b),
        });
        let by_lower = sorted
            .iter()
            .map(|k| (k.to_lowercase(), k.clone()))
            .collect();
        (by_lower, sorted)
    })
}

/// Locales we ship catalogs for, source first, e.g. `["en", "en-GB", "es"]`.
pub fn supported_locales() -> Vec<&'static str> {
    locale_index().1.iter().map(String::as_str).collect()
}

/// Language subtag of a BCP-47 tag, lowercased (`en-GB` → `en`).
fn base_lang(tag: &str) -> &str {
    tag.split('-').next().unwrap_or(tag)
}

/// Map a raw tag to a shipped locale, in preference order: exact (case-insensitive), then the bare
/// base language (`en-AU` becomes `en`), then any regional sibling (`es` becomes `es-ES`), then
/// `None`.
fn match_supported(tag: &str) -> Option<String> {
    let lower = tag.trim().to_lowercase();
    if lower.is_empty() {
        return None;
    }
    let (by_lower, sorted) = locale_index();
    if let Some(c) = by_lower.get(&lower) {
        return Some(c.clone());
    }
    let base = base_lang(&lower);
    if let Some(c) = by_lower.get(base) {
        return Some(c.clone());
    }
    sorted.iter().find(|k| base_lang(&k.to_lowercase()) == base).cloned()
}

/// Resolve the locale to use: an explicit user preference wins, then the `Accept-Language` header
/// (in client-preference order), then the default. Always returns a supported locale.
pub fn resolve_locale(accept_language: Option<&str>, user_locale: Option<&str>) -> String {
    if let Some(u) = user_locale {
        if let Some(l) = match_supported(u) {
            return l;
        }
    }
    if let Some(header) = accept_language {
        // Honor q-weights (RFC 9110): parse `tag;q=weight`, drop q<=0, and try tags in descending
        // q. A stable sort keeps header order for equal weights (the spec's tie-break).
        let mut tags: Vec<(f32, &str)> = header
            .split(',')
            .filter_map(|part| {
                let mut bits = part.split(';');
                let tag = bits.next().unwrap_or("").trim();
                if tag.is_empty() {
                    return None;
                }
                let q = bits
                    .find_map(|p| p.trim().strip_prefix("q=").and_then(|v| v.trim().parse().ok()))
                    .unwrap_or(1.0);
                (q > 0.0).then_some((q, tag))
            })
            .collect();
        tags.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        for (_, tag) in tags {
            if let Some(l) = match_supported(tag) {
                return l;
            }
        }
    }
    DEFAULT_LOCALE.to_string()
}

/// Look up `"ns:dotted.key"` for a locale; returns the raw (unformatted) ICU string.
fn lookup<'a>(catalog: &'a HashMap<String, HashMap<String, Value>>, locale: &str, key: &str) -> Option<&'a str> {
    let (ns, path) = key.split_once(':')?;
    let mut node = catalog.get(locale)?.get(ns)?;
    for seg in path.split('.') {
        node = node.get(seg)?;
    }
    node.as_str()
}

/// Translate `"ns:key"` into `locale`, formatting the ICU message with `args` (a JSON object).
/// Looks up the resolved locale, then its base language (so a regional catalog like `en-GB` only
/// needs the keys it overrides), then the default locale, then echoes the key (missing = visible).
pub fn t(locale: &str, key: &str, args: &Value) -> String {
    let cats = catalogs();
    let resolved = match_supported(locale).unwrap_or_else(|| DEFAULT_LOCALE.to_string());
    let base = base_lang(&resolved);
    let raw = lookup(cats, &resolved, key)
        .or_else(|| lookup(cats, base, key))
        .or_else(|| lookup(cats, DEFAULT_LOCALE, key));
    match raw {
        Some(msg) => format_icu(msg, &resolved, args),
        None => key.to_string(),
    }
}

/// Convenience: translate with no arguments.
pub fn t0(locale: &str, key: &str) -> String {
    t(locale, key, &Value::Null)
}

// ICU MessageFormat (subset: interpolation, plural, select, `#`).

fn format_icu(msg: &str, locale: &str, args: &Value) -> String {
    format_icu_hash(msg, locale, args, None)
}

/// `hash` is `Some(n)` inside a `plural` arm, where a literal `#` in the *template* renders the
/// number `n` (per ICU). It is scoped to the nearest enclosing plural and is substituted only in
/// literal text during this copy pass, never applied to interpolated argument values (so a `#`
/// produced by an arg, e.g. the HTML entity `&#39;`, is preserved). Outside a plural (`hash` is
/// `None`) a `#` is an ordinary literal character.
fn format_icu_hash(msg: &str, locale: &str, args: &Value, hash: Option<i64>) -> String {
    let mut out = String::with_capacity(msg.len());
    let bytes = msg.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => {
                if let Some(end) = matching_brace(msg, i) {
                    out.push_str(&format_placeholder(&msg[i + 1..end], locale, args, hash));
                    i = end + 1;
                } else {
                    out.push('{');
                    i += 1;
                }
            }
            b'#' if hash.is_some() => {
                out.push_str(&hash.unwrap_or(0).to_string());
                i += 1;
            }
            _ => {
                // Copy one UTF-8 char.
                let ch_len = utf8_len(bytes[i]);
                out.push_str(&msg[i..i + ch_len]);
                i += ch_len;
            }
        }
    }
    out
}

/// Index of the `}` matching the `{` at `open` (handles nesting), or `None`.
fn matching_brace(s: &str, open: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Format the inside of a `{…}` placeholder, one of `name`, `name, plural, arms`, or
/// `name, select, arms`. `hash` carries the number of the enclosing plural (if any), so a `#` in a
/// nested `select` arm still renders the right number and a nested `plural` overrides it.
fn format_placeholder(inner: &str, locale: &str, args: &Value, hash: Option<i64>) -> String {
    let mut parts = inner.splitn(3, ',');
    let name = parts.next().unwrap_or("").trim();
    let kind = parts.next().map(str::trim);
    match kind {
        // Interpolation: the arg value is inserted verbatim, never scanned for `#`.
        None => arg_to_string(args.get(name)),
        Some("plural") => {
            let body = parts.next().unwrap_or("");
            let n = args.get(name).and_then(value_as_i64).unwrap_or(0);
            let arm = select_plural_arm(body, locale, n);
            // This plural establishes the `#` number for its arm (overriding any outer one).
            format_icu_hash(&arm, locale, args, Some(n))
        }
        Some("select") => {
            let body = parts.next().unwrap_or("");
            let key = args.get(name).and_then(|v| v.as_str()).unwrap_or("other");
            let arm = select_named_arm(body, key).unwrap_or_default();
            // `select` doesn't introduce a number, so inherit the enclosing plural's `#`, if any.
            format_icu_hash(&arm, locale, args, hash)
        }
        // Unknown type (e.g. `number`/`date`): render the raw arg.
        Some(_) => arg_to_string(args.get(name)),
    }
}

/// Parse `selector {message}` arms into `(selector, message)` pairs (selector is `=N` or a category
/// for plural, or a key for select).
fn parse_arms(body: &str) -> Vec<(String, String)> {
    let mut arms = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Skip whitespace, read the selector up to '{'.
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let sel_start = i;
        while i < bytes.len() && bytes[i] != b'{' {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let selector = body[sel_start..i].trim().to_string();
        let Some(end) = matching_brace(body, i) else {
            break;
        };
        let message = body[i + 1..end].to_string();
        arms.push((selector, message));
        i = end + 1;
    }
    arms
}

fn select_named_arm(body: &str, key: &str) -> Option<String> {
    let arms = parse_arms(body);
    arms.iter()
        .find(|(s, _)| s == key)
        .or_else(|| arms.iter().find(|(s, _)| s == "other"))
        .map(|(_, m)| m.clone())
}

fn select_plural_arm(body: &str, locale: &str, n: i64) -> String {
    let arms = parse_arms(body);
    // Exact `=N` match wins.
    let exact = format!("={n}");
    if let Some((_, m)) = arms.iter().find(|(s, _)| *s == exact) {
        return m.clone();
    }
    let cat = plural_category(locale, n);
    arms.iter()
        .find(|(s, _)| s == cat)
        .or_else(|| arms.iter().find(|(s, _)| s == "other"))
        .map(|(_, m)| m.clone())
        .unwrap_or_default()
}

/// CLDR cardinal plural category for `n` in `locale` (via ICU4X), e.g. `"one"`/`"other"`.
fn plural_category(locale: &str, n: i64) -> &'static str {
    use icu_plurals::{PluralCategory, PluralRuleType, PluralRules};
    let loc: icu_locid::Locale = locale.parse().unwrap_or(icu_locid::Locale::UND);
    let rules = PluralRules::try_new(&loc.into(), PluralRuleType::Cardinal)
        .or_else(|_| PluralRules::try_new(&icu_locid::Locale::UND.into(), PluralRuleType::Cardinal));
    let Ok(rules) = rules else { return "other" };
    match rules.category_for(n) {
        PluralCategory::Zero => "zero",
        PluralCategory::One => "one",
        PluralCategory::Two => "two",
        PluralCategory::Few => "few",
        PluralCategory::Many => "many",
        PluralCategory::Other => "other",
    }
}

fn value_as_i64(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_f64().map(|f| f as i64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

fn arg_to_string(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn utf8_len(first_byte: u8) -> usize {
    match first_byte {
        b if b < 0x80 => 1,
        b if b >> 5 == 0b110 => 2,
        b if b >> 4 == 0b1110 => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn interpolates_and_falls_back() {
        // From email.json (en). Missing locale falls back to en.
        let s = t("zz", "email:friendRequest.subject", &json!({ "name": "Ada" }));
        assert_eq!(s, "Ada sent you a friend request");
    }

    #[test]
    fn plural_selects_arm_and_substitutes_hash() {
        let one = t("en", "player:plays", &json!({ "count": 1 }));
        let many = t("en", "player:plays", &json!({ "count": 5 }));
        assert_eq!(one, "1 play");
        assert_eq!(many, "5 plays");
    }

    #[test]
    fn missing_key_echoes() {
        assert_eq!(t("en", "common:nope.nope", &Value::Null), "common:nope.nope");
    }

    #[test]
    fn hash_does_not_corrupt_interpolated_args() {
        // A `#` introduced by an interpolated arg (here an HTML entity from an escaped name) must
        // survive, because only the literal `#` token in the template renders the number.
        let msg = "{count, plural, one {# play by {name}} other {# plays by {name}}}";
        let s = format_icu(msg, "en", &json!({ "count": 5, "name": "O&#39;Brien" }));
        assert_eq!(s, "5 plays by O&#39;Brien");
    }

    #[test]
    fn literal_hash_outside_plural_is_preserved() {
        // Outside a plural arm, `#` is an ordinary character (e.g. a musical key).
        assert_eq!(
            format_icu("Now playing in {key}", "en", &json!({ "key": "C# minor" })),
            "Now playing in C# minor"
        );
    }

    #[test]
    fn nested_select_inside_plural_keeps_the_number() {
        // A `#` in a nested `select` arm renders the enclosing plural's number.
        let msg = "{count, plural, other {# {g, select, f {tracks} other {songs}}}}";
        let s = format_icu(msg, "en", &json!({ "count": 3, "g": "f" }));
        assert_eq!(s, "3 tracks");
    }

    #[test]
    fn resolve_prefers_user_then_header() {
        assert_eq!(resolve_locale(Some("es-MX,en;q=0.8"), None), "es"); // if es is shipped
        assert_eq!(resolve_locale(Some("fr"), Some("en")), "en"); // user wins
        assert_eq!(resolve_locale(None, None), "en");
    }

    #[test]
    fn resolve_honors_q_weights() {
        // The higher-q tag wins even when it appears later in the header (RFC 9110).
        assert_eq!(resolve_locale(Some("es;q=0.5, en;q=0.9"), None), "en");
        assert_eq!(resolve_locale(Some("en;q=0.3, es;q=0.7"), None), "es");
        // q=0 means "not acceptable", so skip it.
        assert_eq!(resolve_locale(Some("es;q=0, en"), None), "en");
        // Equal weights keep header order.
        assert_eq!(resolve_locale(Some("es, en"), None), "es");
    }

    #[test]
    fn resolves_regional_variants() {
        // Exact match wins and preserves canonical casing (dir is `en-GB`).
        assert_eq!(resolve_locale(Some("en-GB"), None), "en-GB");
        assert_eq!(resolve_locale(None, Some("en-gb")), "en-GB"); // case-insensitive
        assert_eq!(resolve_locale(Some("en-GB;q=0.9,en;q=0.8"), None), "en-GB");
        // A regional variant we don't ship falls back to the bare base language.
        assert_eq!(resolve_locale(Some("en-AU"), None), "en");
        // The shipped set is exposed canonically, source first.
        assert!(supported_locales().contains(&"en-GB"));
    }

    #[test]
    fn regional_overlay_falls_back_to_base() {
        // en-GB overrides this one key…
        assert_eq!(t0("en-GB", "common:userMenu.stats"), "Statistics");
        // …and inherits everything else from the base `en` catalog (same namespace)…
        assert_eq!(t0("en-GB", "common:nav.listen"), "Listen");
        // …including whole namespaces en-GB doesn't ship at all.
        assert_eq!(
            t0("en-GB", "errors:auth.badCredentials"),
            "Incorrect email or password."
        );
    }
}
