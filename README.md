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

The everyday loop is two commands — push the source up, pull translations down:

```bash
bun install                  # brings in the pinned CLI
bun run crowdin:lint         # validate crowdin.yml (needs the two env vars set)
bun run crowdin:push         # upload the English source strings
bun run crowdin:status       # translation + approval progress per language
bun run crowdin:pull         # download translations back into locales/, minus the empties
```

Push before you pull, so Crowdin is not being asked to translate a stale source. `crowdin:push`
prints `[OK]` for all 16 namespaces every run, changed or not — it is an idempotent replace with no
diff, so identical output twice in a row is expected and proves nothing either way. Pushing new
source keys also *lowers* the reported percentages, because those keys are now countable and
untranslated; that is the work appearing, not a regression.

**Always pass `--branch main` to an ad-hoc CLI command.** The project's files live in a Crowdin
branch of that name, the CLI defaults to `--branch none`, and `upload sources` is the one command
that will not tell you: run branchlessly it reports no error, prints its usual green per-file lines,
and quietly lays down a second, divergent set of sources at the project root. The scripts above all
pass it; you only need to think about this when typing `crowdin …` by hand.

`crowdin:pull` runs `scripts/pull-translations.mjs` rather than a bare `crowdin download`, because
Crowdin writes `""` for untranslated strings instead of omitting the key — and an empty string is
not a missing one. A missing key falls back to English; an empty string is *found*, treated as a
translation, and rendered as nothing, blanking the UI exactly where a translation is absent. The
script strips them, drops any catalog left with nothing in it, and `bun run check` fails on any that
survive. It takes translated strings regardless of approval state; gating on proofreading would be
`--export-only-approved`, which is not currently set.

There is a sixth script, `crowdin:push-drafts` (`upload translations`), that is **not** part of that
loop. It carries translations *written in this repo* up to Crowdin as unapproved suggestions —
`--no-auto-approve-imported` is what marks them as needing review, since approval is a claim that a
native speaker has read the string and only a person can make that claim. Today nothing qualifies:
every string under `locales/<lang>/` came down from Crowdin in the first place, so running it would
re-suggest Crowdin's own output against itself. Reach for it only after editing a translation
in-repo, to stop the next pull silently reverting that edit. It also has a precondition `crowdin:push`
does not — `upload translations` can only attach to source files Crowdin already holds, and reports
`file is missing in the project` once per namespace when the mapping resolves to nothing.

One-time setup in the Crowdin project itself, none of which the CLI can do:

1. Create the project with `en` as the source language and add your target languages.
2. Turn on **ICU Message Syntax** in project settings, so placeholders and plurals are parsed and
   validated. Do *not* enable the i18next plural type — it expects key suffixes, and these catalogs
   keep ICU inline.
3. Leave **Language Mapping** alone. Catalog directories are named for the BCP-47 tag Crowdin
   exports (`de-DE`, `es-ES`, `fr-FR`, `ja-JP`, `ko-KR`, `pt-BR`, `en-GB`), so no mapping is needed
   and setting one would break the alignment. A bare request still resolves — `resolveLocale` goes
   exact → base → regional sibling → default, so a browser asking for `de` gets `de-DE`. Mapping is
   a per-language setting someone has to remember for every new target; forgetting it once is how
   German spent time landing in `locales/de-DE/` while the app read `locales/de/`.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
