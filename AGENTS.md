# Working in this repository

This is the standalone showcase app for [HeroUI Native](https://github.com/heroui-inc/heroui-native).
It is not the original: `src/` and `themes/` are mirrored from the `example/` app inside the
library repository, and this copy exists so the app can be built and shipped against the
**published npm package** rather than the library source.

That distinction drives everything below.

## What is mirrored and what is owned here

`src/` and `themes/` are mirrored verbatim from upstream by
`scripts/sync-upstream-example.mjs` on every release. Anything you change there is reverted
by the next sync. Fix upstream instead.

Everything else belongs to this repository and deliberately diverges from upstream:

| File | Why it differs |
| --- | --- |
| `package.json` | Depends on `heroui-native` from npm; upstream resolves it through a babel alias. Also carries extra dependencies this app needs on its own. |
| `global.css` | Imports `heroui-native/styles`; upstream imports the library's local `src/styles/index.css`. |
| `babel.config.js` | No module-resolver aliases; upstream aliases the package name to the library source. |
| `metro.config.js` | No monorepo workspace resolution, and writes uniwind types to `src/uniwind-types.d.ts`. |
| `tsconfig.json` | Extends `expo/tsconfig.base`; upstream extends the monorepo root config. |
| `app.json` | This app's own identity, icons, EAS project and OTA update configuration. |
| `eslint.config.js`, `README.md` | Only exist here. |

`scripts/sync-manifest.json` encodes these rules. The sync compares the protected files
against upstream and reports differences, but never writes them.

## Do not fix lint or type findings in mirrored code

`npm run lint` and `tsc --noEmit` both report pre-existing findings in `src/`. They come from
upstream, where that code is checked under a different configuration, and they are not
actionable here:

- fixing them is reverted by the next sync;
- some only appear here at all because this app enables `typedRoutes` while the upstream
  example does not.

Neither is part of the automated release check for that reason. If you find something
genuinely broken in mirrored code, report it so it can be fixed upstream.

## The check that matters

```bash
npm run verify
```

This runs `expo export --platform all`, bundling for iOS, Android and web. It is the one
thing this repository verifies that the library's CI cannot: upstream bundles its example
against the library *source*, so a packaging problem in the published build (a missing
export, a bad `exports` map, an unshipped file) shows up only here.

## Upgrading to a new library release

This is automated by `.github/workflows/sync-heroui-native.yml`, which the library's release
workflow triggers. See `.github/agent/sync-task.md` for the exact contract the automation
follows. To do it by hand, or to debug the automation:

```bash
git clone --branch v1.0.8 --depth 1 https://github.com/heroui-inc/heroui-native .upstream
npm run sync:upstream -- --version 1.0.8 --upstream-path .upstream --dry-run  # preview
npm run sync:upstream -- --version 1.0.8 --upstream-path .upstream           # apply
npm install
npm run verify
```

The sync writes a report to `.sync/report.md` covering mirrored file changes, dependency
changes, protected-file drift, and any warnings. `.upstream/` and `.sync/` are git-ignored.

## Conventions

- TypeScript is strict. Do not use `any`, non-null assertions, or casts through `unknown`.
- Match the surrounding style of whichever area you are in. Mirrored code follows upstream's
  conventions; scripts in `scripts/` use JSDoc-annotated ESM.
