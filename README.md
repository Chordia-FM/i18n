# @chordia/i18n · chordia-i18n

Shared localization catalogs (ICU MessageFormat) for the [Chordia](https://github.com/chordia-fm)
ecosystem. **One source of truth**, consumed from both Rust and TypeScript. It's a dual package, mirroring
the `contracts` repo.

- **Catalogs:** `locales/<locale>/<namespace>.json` (e.g. `locales/en/player.json`). English is the
  source language; other locales are synced via Crowdin (`crowdin.yml`).
- **Keys** are `"namespace:key"` (colon separator). Catalog JSON must be **nested objects**, not
  flat-dotted keys.

## Consumers

| Surface | How it's used |
|---------|---------------|
| **Rust** (`backend`) | `chordia-i18n` crate. `include_dir` embeds `locales/` into the binary and `icu_plurals` provides correct CLDR plural categories, so it's self-contained with nothing to deploy alongside. |
| **TypeScript** (`frontend`) | `@chordia/i18n` package. `index.ts` exposes the catalogs as an i18next-shaped resources object plus locale helpers (`DEFAULT_LOCALE`, `SUPPORTED_LOCALES`, `resolveLocale`, `localeName`). The frontend imports it via the tsconfig path `@chordia/i18n` → `../i18n/index.ts`. |

Both surfaces read the **same** `locales/` directory, so a translation added once is available
everywhere.

## Working on it

```bash
cargo build              # build/check the Rust crate
cargo test               # tests
```

Add a new string to the English catalog under the right namespace, keep it nested, then let Crowdin
fan it out to the other locales.

**A brand-new locale needs no code change.** `SUPPORTED_LOCALES` is derived from the catalog glob in
`index.ts`, and `UserSettings.locale` is a plain string, so a new `locales/<code>/` directory is
picked up on the next build by both the frontend and the Rust crate.

## Crowdin

This is a **Crowdin Enterprise** organization, so `crowdin.yml` sets `base_url` to the org's own API
host (`https://naila.api.crowdin.com`). The CLI otherwise defaults to crowdin.com and authenticates
against the wrong instance. Note the `api` segment — the API host is not the one you log in to.

English is the source; every other locale is a translation of it. Auth comes from the environment —
`CROWDIN_PROJECT_ID` and `CROWDIN_PERSONAL_TOKEN`, never committed.

```bash
bun install                  # brings in the pinned CLI
bun run crowdin:lint         # validate crowdin.yml (needs the two env vars set)
bun run crowdin:push         # upload the English source strings
bun run crowdin:push-drafts   # upload local translations as UNAPPROVED drafts
bun run crowdin:status       # translation + approval progress per language
bun run crowdin:pull         # download approved translations back into locales/
```

`crowdin:push-drafts` deliberately passes `--no-auto-approve-imported`. That is what marks a
translation as *needing review*: it lands in Crowdin as a suggestion awaiting a proofreader rather
than as an approved string. Machine-generated first passes must go up this way — approval is a claim
that a native speaker has read it, and only a person can make that claim.

One-time setup in the Crowdin project itself, none of which the CLI can do:

1. Create the project with `en` as the source language and add your target languages.
2. Turn on **ICU Message Syntax** in project settings, so placeholders and plurals are parsed and
   validated. Do *not* enable the i18next plural type — it expects key suffixes, and these catalogs
   keep ICU inline.
3. For a generic language that should live at the bare code (`locales/es/`, not `locales/es-ES/`),
   set **Language Mapping** so that target's `locale` placeholder is the two-letter code. Regional
   variants (`en-GB`, `pt-BR`) need no mapping.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
