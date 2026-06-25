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
fan it out to the other locales. Adding a brand-new locale folder requires wiring it into
`SUPPORTED_LOCALES` (and, for the frontend, regenerating `UserSettings.locale` in `contracts`).

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
