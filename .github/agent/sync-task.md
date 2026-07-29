# Task: finish the heroui-native upgrade

A release of `heroui-native` has been published and `scripts/sync-upstream-example.mjs` has
already performed the mechanical part of the upgrade in this working tree:

- `src/` and `themes/` were mirrored from the upstream repository's `example/` app
- dependency ranges in `package.json` were aligned with the upstream example
- `package-lock.json` was refreshed with `npm install`

Your job is the part that needs judgement. Work only in this repository's working tree.

## Context files

Read these before doing anything else:

- `.sync/report.md` — what the sync changed, which dependencies moved, and which protected
  configuration files differ from upstream
- `.sync/gates.md` — output of the bundle check, appended once per attempt
- `.sync/upstream-changelog.md` — the upstream release notes, when available
- `.upstream/` — a checkout of the released `heroui-native` tag. Its `example/` directory is
  the reference implementation, and its `src/` directory is the library source. Consult these
  whenever you need to know how an API is meant to be used.

## What to do

1. **Make the build pass.** `npm run verify` runs `expo export --platform all`, bundling the
   app for iOS, Android and web against the published `heroui-native` package. This is the
   only blocking gate, and it is the one thing this repository verifies that the library's
   own CI cannot: upstream bundles its example against the library *source* through a babel
   alias, so a packaging or export problem in the published build shows up only here.
   Failures are almost always an import of something the new version renamed, removed, or
   stopped exporting from its entry point.

   Do not try to fix lint or type-check findings. `src/` and `themes/` are mirrored verbatim
   from upstream and are checked in that repository; any change you make here is reverted by
   the next sync. If you notice something genuinely broken in mirrored code, describe it
   under "Review notes" so it can be fixed upstream instead.
2. **Fix breaking changes the way upstream did.** When an API changed, mirror the upstream
   example's usage from `.upstream/example/src` rather than inventing your own fix. If the
   mirrored file is already correct and the failure comes from this repository's own code
   (anything outside `src/` and `themes/`), fix it there.
3. **Assess protected configuration drift.** `.sync/report.md` lists files marked `differs`.
   These diverge on purpose, because this app consumes the published npm package while the
   upstream example consumes the library source. Only port a change when it is a genuine
   requirement of the new version, for example a new stylesheet import that
   `heroui-native/styles` now expects, or a new Expo plugin the library needs. Never copy
   monorepo-specific configuration such as babel aliases, Metro workspace resolution, or
   upstream's EAS project settings.
4. **Confirm nothing repository-specific was lost.** The mirror overwrites `src/` wholesale.
   Check `git diff` for deletions or reversions that look like this repository's own work
   rather than an upstream change. If you find any, restore them and note it in the summary.
5. **Write `.sync/pr-body.md`.** This becomes the pull request description. Use this shape:

   ```markdown
   ## Summary

   One or two sentences on what this upgrade brings, based on the upstream release notes.

   ## Synced from upstream

   Bullet the notable file changes from `.sync/report.md`. Group them; do not paste the
   whole list. State the dependency changes.

   ## Manual changes

   Anything you changed beyond the mechanical sync, and why. Write "None" when the sync was
   clean.

   ## Verification

   Whether the iOS, Android and web bundles built.

   ## Review notes

   Anything a human should look at: protected-file drift you decided not to port, API
   changes worth a closer look, problems that belong upstream. Write "None" when there is
   nothing.
   ```

## Rules

- Do not run `git commit`, `git push`, or `gh`. The workflow handles version control.
- Do not edit `package-lock.json` by hand. Run `npm install` if dependencies must change.
- Do not weaken the gate to make it pass. Do not narrow the platforms `npm run verify`
  builds, do not stub out or comment out a screen to get past a bundling error, and do not
  delete mirrored files that fail to build. Fix the cause instead. If a failure is genuinely
  unfixable here, leave it failing and explain it under "Review notes" so a human decides.
- Do not use the `any` type, non-null assertions (`!`), or casts through `unknown`.
- Do not change the version badge or the `heroui-native` range; the sync script owns those.
- Do not edit files under `.upstream/`. It is a read-only reference.
- Do not modify `scripts/sync-manifest.json` unless the report shows the sync itself is
  misconfigured, and say so under "Review notes" if you do.
- Keep changes minimal and in the existing style. This is an upgrade, not a refactor.
