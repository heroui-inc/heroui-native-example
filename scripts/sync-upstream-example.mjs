#!/usr/bin/env node

/**
 * Mirrors the example application that ships inside the `heroui-native`
 * repository into this standalone repository.
 *
 * The upstream `example/` app is the source of truth for `src/` and `themes/`,
 * while this repository owns its own Expo configuration (it consumes the
 * published npm package instead of the library source). This script performs
 * only the mechanical half of an upgrade:
 *
 *   1. mirrors the directories listed in `scripts/sync-manifest.json`,
 *      including deletions, while preserving repository-only files;
 *   2. merges dependency ranges from the upstream example's `package.json`
 *      without touching this repository's own entries;
 *   3. asserts the on-screen version badge matches the released version;
 *   4. reports upstream changes to protected configuration files so a human or
 *      agent can decide whether they need porting.
 *
 * Usage:
 *   node ./scripts/sync-upstream-example.mjs --version 1.0.7 [options]
 *
 * Options:
 *   --version <semver>     Released `heroui-native` version. Defaults to the
 *                          version found in the upstream checkout.
 *   --upstream-path <dir>  Path to the `heroui-native` checkout. Default `.upstream`.
 *   --report-out <file>    Where to write the markdown report. Default `.sync/report.md`.
 *   --dry-run              Report what would change without writing anything.
 *   --json                 Print the machine-readable summary to stdout.
 *   --help                 Print this usage information.
 *
 * Exit codes: 0 on success (including "no changes"), 1 on a usage or I/O error.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * @typedef {Object} MirrorRule
 * @property {string} from Path to the source directory, relative to the upstream checkout.
 * @property {string} to Path to the destination directory, relative to this repository.
 */

/**
 * @typedef {Object} PackageJsonRules
 * @property {string[]} ignoredUpstreamDependencies Upstream-only tooling that must never be added here.
 * @property {string[]} exampleOnlyDependencies Dependencies this repository intentionally owns.
 */

/**
 * @typedef {Object} Manifest
 * @property {{ repo: string; libraryPackage: string; exampleDir: string }} upstream
 * @property {MirrorRule[]} mirrors
 * @property {string[]} keep Repository-relative paths that are never overwritten or deleted.
 * @property {string[]} ignoreNames Basenames skipped on both sides of a mirror.
 * @property {string[]} protectedFiles Repository-relative paths that are compared but never written.
 * @property {PackageJsonRules} packageJson
 * @property {{ file: string }} versionBadge
 */

/**
 * @typedef {"added" | "modified" | "deleted"} FileChangeKind
 */

/**
 * @typedef {Object} FileChange
 * @property {FileChangeKind} kind
 * @property {string} file Repository-relative path.
 */

/**
 * @typedef {Object} DependencyChange
 * @property {"added" | "updated" | "unchanged"} kind
 * @property {string} name
 * @property {"dependencies" | "devDependencies"} section
 * @property {string | null} from Previous range, or `null` when newly added.
 * @property {string} to Resulting range.
 */

/**
 * @typedef {Object} DriftEntry
 * @property {string} file Repository-relative path of the protected file.
 * @property {"upstream-only" | "differs" | "identical" | "missing-upstream"} status
 */

/**
 * @typedef {Object} SyncSummary
 * @property {string} version
 * @property {string} upstreamPath
 * @property {boolean} dryRun
 * @property {FileChange[]} files
 * @property {DependencyChange[]} dependencies
 * @property {string[]} unexpectedLocalDependencies
 * @property {string[]} staleManifestIgnoreEntries
 * @property {DriftEntry[]} drift
 * @property {string[]} warnings
 * @property {{ file: string; from: string; to: string } | null} versionBadge
 */

/** Semver pattern used for both validation and badge rewriting. */
const SEMVER_SOURCE = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

/**
 * Parses `process.argv` into a typed options object.
 *
 * @param {string[]} argv Raw arguments, excluding the node binary and script path.
 * @returns {{ version: string | null; upstreamPath: string; reportOut: string; dryRun: boolean; json: boolean; help: boolean }}
 * @throws {Error} When a flag is unknown or a value-taking flag has no value.
 */
function parseArgs(argv) {
  /** @type {{ version: string | null; upstreamPath: string; reportOut: string; dryRun: boolean; json: boolean; help: boolean }} */
  const options = {
    version: null,
    upstreamPath: ".upstream",
    reportOut: path.join(".sync", "report.md"),
    dryRun: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    /**
     * Reads the value that follows a flag.
     *
     * @returns {string} The flag value.
     */
    const nextValue = () => {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--version":
        options.version = nextValue().replace(/^v/, "");
        break;
      case "--upstream-path":
        options.upstreamPath = nextValue();
        break;
      case "--report-out":
        options.reportOut = nextValue();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/**
 * Reads and parses a JSON file.
 *
 * @param {string} filePath Absolute path to the file.
 * @returns {Promise<Record<string, unknown>>} Parsed object.
 * @throws {Error} When the file is missing or is not a JSON object.
 */
async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${filePath}`);
  }

  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Loads and validates the sync manifest.
 *
 * @returns {Promise<Manifest>} The manifest.
 * @throws {Error} When a required field is absent or malformed.
 */
async function loadManifest() {
  const manifestPath = path.join(scriptDir, "sync-manifest.json");
  const raw = await readJsonFile(manifestPath);

  const upstream = raw.upstream;
  if (
    upstream === null ||
    typeof upstream !== "object" ||
    Array.isArray(upstream)
  ) {
    throw new Error("Manifest is missing the `upstream` object");
  }

  const upstreamRecord = /** @type {Record<string, unknown>} */ (upstream);
  const repo = upstreamRecord.repo;
  const libraryPackage = upstreamRecord.libraryPackage;
  const exampleDir = upstreamRecord.exampleDir;

  if (
    typeof repo !== "string" ||
    typeof libraryPackage !== "string" ||
    typeof exampleDir !== "string"
  ) {
    throw new Error(
      "Manifest `upstream` must define string `repo`, `libraryPackage` and `exampleDir`"
    );
  }

  if (!Array.isArray(raw.mirrors) || raw.mirrors.length === 0) {
    throw new Error("Manifest must define at least one mirror");
  }

  /** @type {MirrorRule[]} */
  const mirrors = raw.mirrors.map((entry, position) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Manifest mirror at index ${position} must be an object`);
    }
    const record = /** @type {Record<string, unknown>} */ (entry);
    if (typeof record.from !== "string" || typeof record.to !== "string") {
      throw new Error(
        `Manifest mirror at index ${position} must define string \`from\` and \`to\``
      );
    }
    return { from: record.from, to: record.to };
  });

  const packageJsonRules = raw.packageJson;
  if (
    packageJsonRules === null ||
    typeof packageJsonRules !== "object" ||
    Array.isArray(packageJsonRules)
  ) {
    throw new Error("Manifest is missing the `packageJson` object");
  }

  const versionBadge = raw.versionBadge;
  if (
    versionBadge === null ||
    typeof versionBadge !== "object" ||
    Array.isArray(versionBadge)
  ) {
    throw new Error("Manifest is missing the `versionBadge` object");
  }

  const badgeFile = /** @type {Record<string, unknown>} */ (versionBadge).file;
  if (typeof badgeFile !== "string") {
    throw new Error("Manifest `versionBadge.file` must be a string");
  }

  return {
    upstream: { repo, libraryPackage, exampleDir },
    mirrors,
    keep: toStringArray(raw.keep, "keep"),
    ignoreNames: toStringArray(raw.ignoreNames, "ignoreNames"),
    protectedFiles: toStringArray(raw.protectedFiles, "protectedFiles"),
    packageJson: {
      ignoredUpstreamDependencies: toStringArray(
        /** @type {Record<string, unknown>} */ (packageJsonRules)
          .ignoredUpstreamDependencies,
        "packageJson.ignoredUpstreamDependencies"
      ),
      exampleOnlyDependencies: toStringArray(
        /** @type {Record<string, unknown>} */ (packageJsonRules)
          .exampleOnlyDependencies,
        "packageJson.exampleOnlyDependencies"
      ),
    },
    versionBadge: { file: badgeFile },
  };
}

/**
 * Coerces an unknown manifest field into a string array.
 *
 * @param {unknown} value Raw field value; `undefined` yields an empty array.
 * @param {string} fieldName Field name, used in error messages.
 * @returns {string[]} The validated array.
 * @throws {Error} When the value is neither absent nor an array of strings.
 */
function toStringArray(value, fieldName) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Manifest \`${fieldName}\` must be an array of strings`);
  }

  return value.map((entry, position) => {
    if (typeof entry !== "string") {
      throw new Error(`Manifest \`${fieldName}[${position}]\` must be a string`);
    }
    return entry;
  });
}

/**
 * Recursively lists files beneath a directory.
 *
 * @param {string} rootDir Absolute directory to walk.
 * @param {Set<string>} ignoreNames Basenames to skip.
 * @returns {Promise<string[]>} Paths relative to `rootDir`, using forward slashes.
 */
async function listFiles(rootDir, ignoreNames) {
  /** @type {string[]} */
  const results = [];

  /**
   * @param {string} currentDir Absolute directory being visited.
   * @returns {Promise<void>}
   */
  const walk = async (currentDir) => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (ignoreNames.has(entry.name)) {
        continue;
      }

      const absolute = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      if (entry.isFile()) {
        results.push(path.relative(rootDir, absolute).split(path.sep).join("/"));
      }
    }
  };

  await walk(rootDir);
  return results.sort();
}

/**
 * Checks whether a filesystem path exists.
 *
 * @param {string} target Absolute path.
 * @returns {Promise<boolean>} True when the path is reachable.
 */
async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hashes a file's contents so binary and text files compare identically.
 *
 * @param {string} filePath Absolute path.
 * @returns {Promise<string>} Hex digest.
 */
async function hashFile(filePath) {
  const contents = await fs.readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Mirrors one directory pair, including deletions.
 *
 * @param {MirrorRule} mirror Rule to apply.
 * @param {string} upstreamRoot Absolute path to the upstream checkout.
 * @param {Manifest} manifest Loaded manifest.
 * @param {boolean} dryRun When true, no writes occur.
 * @returns {Promise<FileChange[]>} Changes made (or that would be made).
 * @throws {Error} When the upstream source directory is absent.
 */
async function applyMirror(mirror, upstreamRoot, manifest, dryRun) {
  const sourceDir = path.join(upstreamRoot, mirror.from);
  const targetDir = path.join(repoRoot, mirror.to);

  if (!(await pathExists(sourceDir))) {
    throw new Error(`Upstream directory not found: ${sourceDir}`);
  }

  const ignoreNames = new Set(manifest.ignoreNames);
  const keep = new Set(manifest.keep);
  const protectedFiles = new Set(manifest.protectedFiles);

  const sourceFiles = await listFiles(sourceDir, ignoreNames);
  const targetFiles = (await pathExists(targetDir))
    ? await listFiles(targetDir, ignoreNames)
    : [];

  /** @type {FileChange[]} */
  const changes = [];

  for (const relative of sourceFiles) {
    const repoRelative = [mirror.to, relative].join("/");

    if (keep.has(repoRelative) || protectedFiles.has(repoRelative)) {
      continue;
    }

    const sourceFile = path.join(sourceDir, relative);
    const targetFile = path.join(targetDir, relative);
    const targetExists = await pathExists(targetFile);

    if (targetExists) {
      const [sourceHash, targetHash] = await Promise.all([
        hashFile(sourceFile),
        hashFile(targetFile),
      ]);

      if (sourceHash === targetHash) {
        continue;
      }
    }

    if (!dryRun) {
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      await fs.copyFile(sourceFile, targetFile);
    }

    changes.push({ kind: targetExists ? "modified" : "added", file: repoRelative });
  }

  const sourceSet = new Set(sourceFiles);

  for (const relative of targetFiles) {
    const repoRelative = [mirror.to, relative].join("/");

    if (sourceSet.has(relative) || keep.has(repoRelative)) {
      continue;
    }

    if (!dryRun) {
      await fs.rm(path.join(targetDir, relative), { force: true });
    }

    changes.push({ kind: "deleted", file: repoRelative });
  }

  if (!dryRun) {
    await removeEmptyDirectories(targetDir);
  }

  return changes;
}

/**
 * Removes directories left empty after a mirror deleted their contents.
 *
 * @param {string} directory Absolute directory to prune; itself is never removed.
 * @returns {Promise<boolean>} True when `directory` is empty after pruning.
 */
async function removeEmptyDirectories(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let remaining = entries.length;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const child = path.join(directory, entry.name);
    if (await removeEmptyDirectories(child)) {
      await fs.rm(child, { recursive: true, force: true });
      remaining -= 1;
    }
  }

  return remaining === 0;
}

/**
 * Reads a dependency section from a parsed `package.json`.
 *
 * @param {Record<string, unknown>} packageJson Parsed manifest.
 * @param {"dependencies" | "devDependencies"} section Section name.
 * @returns {Record<string, string>} Dependency ranges, empty when absent.
 * @throws {Error} When the section is present but malformed.
 */
function readDependencySection(packageJson, section) {
  const value = packageJson[section];

  if (value === undefined) {
    return {};
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected \`${section}\` to be an object`);
  }

  /** @type {Record<string, string>} */
  const result = {};

  for (const [name, range] of Object.entries(value)) {
    if (typeof range !== "string") {
      throw new Error(`Expected \`${section}.${name}\` to be a string`);
    }
    result[name] = range;
  }

  return result;
}

/**
 * Merges upstream dependency ranges into this repository's `package.json`.
 *
 * Ranges are adopted from upstream for packages both apps share, new upstream
 * packages are added to the section upstream uses, and this repository's own
 * entries are left untouched. Packages are never moved between sections.
 *
 * @param {string} version Released `heroui-native` version.
 * @param {string} upstreamRoot Absolute path to the upstream checkout.
 * @param {Manifest} manifest Loaded manifest.
 * @param {boolean} dryRun When true, no writes occur.
 * @returns {Promise<{ changes: DependencyChange[]; unexpectedLocal: string[]; staleIgnoreEntries: string[] }>}
 */
async function mergePackageJson(version, upstreamRoot, manifest, dryRun) {
  const localPath = path.join(repoRoot, "package.json");
  const upstreamPath = path.join(
    upstreamRoot,
    manifest.upstream.exampleDir,
    "package.json"
  );

  const localPackage = await readJsonFile(localPath);
  const upstreamPackage = await readJsonFile(upstreamPath);

  /** @type {Record<"dependencies" | "devDependencies", Record<string, string>>} */
  const local = {
    dependencies: readDependencySection(localPackage, "dependencies"),
    devDependencies: readDependencySection(localPackage, "devDependencies"),
  };

  /** @type {Record<"dependencies" | "devDependencies", Record<string, string>>} */
  const upstream = {
    dependencies: readDependencySection(upstreamPackage, "dependencies"),
    devDependencies: readDependencySection(upstreamPackage, "devDependencies"),
  };

  const ignored = new Set(manifest.packageJson.ignoredUpstreamDependencies);
  const exampleOnly = new Set(manifest.packageJson.exampleOnlyDependencies);

  /** @type {DependencyChange[]} */
  const changes = [];

  /** @type {Array<"dependencies" | "devDependencies">} */
  const sections = ["dependencies", "devDependencies"];

  for (const section of sections) {
    for (const [name, range] of Object.entries(upstream[section])) {
      if (ignored.has(name) || name === manifest.upstream.libraryPackage) {
        continue;
      }

      /** The section this repository already keeps the package in, if any. */
      const existingSection = sections.find((candidate) =>
        Object.hasOwn(local[candidate], name)
      );

      if (existingSection === undefined) {
        local[section][name] = range;
        changes.push({
          kind: "added",
          name,
          section,
          from: null,
          to: range,
        });
        continue;
      }

      const currentRange = local[existingSection][name];
      if (currentRange !== range) {
        local[existingSection][name] = range;
        changes.push({
          kind: "updated",
          name,
          section: existingSection,
          from: currentRange,
          to: range,
        });
      }
    }
  }

  const libraryRange = `^${version}`;
  const librarySection = sections.find((candidate) =>
    Object.hasOwn(local[candidate], manifest.upstream.libraryPackage)
  );

  if (librarySection === undefined) {
    local.dependencies[manifest.upstream.libraryPackage] = libraryRange;
    changes.push({
      kind: "added",
      name: manifest.upstream.libraryPackage,
      section: "dependencies",
      from: null,
      to: libraryRange,
    });
  } else {
    const currentRange = local[librarySection][manifest.upstream.libraryPackage];
    if (currentRange !== libraryRange) {
      local[librarySection][manifest.upstream.libraryPackage] = libraryRange;
      changes.push({
        kind: "updated",
        name: manifest.upstream.libraryPackage,
        section: librarySection,
        from: currentRange,
        to: libraryRange,
      });
    } else {
      changes.push({
        kind: "unchanged",
        name: manifest.upstream.libraryPackage,
        section: librarySection,
        from: currentRange,
        to: libraryRange,
      });
    }
  }

  /** Packages this repository carries that upstream neither ships nor is known to own. */
  const unexpectedLocal = sections
    .flatMap((section) => Object.keys(local[section]))
    .filter(
      (name) =>
        !exampleOnly.has(name) &&
        !ignored.has(name) &&
        !Object.hasOwn(upstream.dependencies, name) &&
        !Object.hasOwn(upstream.devDependencies, name)
    )
    .sort();

  /**
   * Ignore-list entries upstream no longer ships. Keeps the manifest honest as
   * the upstream monorepo tooling changes.
   */
  const upstreamNames = new Set(
    sections.flatMap((section) => Object.keys(upstream[section]))
  );
  const staleIgnoreEntries = manifest.packageJson.ignoredUpstreamDependencies
    .filter((name) => !upstreamNames.has(name))
    .sort();

  if (!dryRun && changes.some((change) => change.kind !== "unchanged")) {
    localPackage.dependencies = sortKeys(local.dependencies);
    localPackage.devDependencies = sortKeys(local.devDependencies);
    await fs.writeFile(
      localPath,
      `${JSON.stringify(localPackage, null, 2)}\n`,
      "utf8"
    );
  }

  return { changes, unexpectedLocal, staleIgnoreEntries };
}

/**
 * Returns a copy of a record with alphabetically ordered keys, matching how
 * npm itself serialises dependency sections.
 *
 * @param {Record<string, string>} record Source record.
 * @returns {Record<string, string>} Ordered copy.
 */
function sortKeys(record) {
  /** @type {Record<string, string>} */
  const sorted = {};

  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }

  return sorted;
}

/**
 * Resolves the upstream counterpart of a mirrored repository file.
 *
 * @param {string} repoRelative Repository-relative path, using forward slashes.
 * @param {string} upstreamRoot Absolute path to the upstream checkout.
 * @param {Manifest} manifest Loaded manifest.
 * @returns {Promise<string | null>} Absolute upstream path, or `null` when the
 *   file is not mirrored or has no upstream counterpart.
 */
async function resolveMirrorSource(repoRelative, upstreamRoot, manifest) {
  for (const mirror of manifest.mirrors) {
    const prefix = `${mirror.to}/`;

    if (!repoRelative.startsWith(prefix)) {
      continue;
    }

    const candidate = path.join(
      upstreamRoot,
      mirror.from,
      repoRelative.slice(prefix.length)
    );

    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Ensures the version badge rendered on the home screen matches the released
 * version. Upstream maintains this string, so this is a safety net for the case
 * where the release tag moved without the badge being updated.
 *
 * @param {string} version Released `heroui-native` version.
 * @param {string} upstreamRoot Absolute path to the upstream checkout.
 * @param {Manifest} manifest Loaded manifest.
 * @param {boolean} dryRun When true, no writes occur.
 * @returns {Promise<{ change: { file: string; from: string; to: string } | null; warning: string | null }>}
 */
async function syncVersionBadge(version, upstreamRoot, manifest, dryRun) {
  const badgePath = path.join(repoRoot, manifest.versionBadge.file);

  // A dry run has not mirrored anything yet, so read the upstream copy to
  // describe the state the badge would actually be left in.
  const readPath = dryRun
    ? ((await resolveMirrorSource(
        manifest.versionBadge.file,
        upstreamRoot,
        manifest
      )) ?? badgePath)
    : badgePath;

  if (!(await pathExists(readPath))) {
    return {
      change: null,
      warning: `Version badge file not found: ${manifest.versionBadge.file}`,
    };
  }

  const contents = await fs.readFile(readPath, "utf8");
  const badgePattern = new RegExp(
    `(\\n\\s*)v(${SEMVER_SOURCE})(\\s*\\n\\s*</AppText>)`
  );
  const match = contents.match(badgePattern);

  if (match === null) {
    return {
      change: null,
      warning: [
        `Could not locate the version badge in ${manifest.versionBadge.file}.`,
        "Verify the displayed version manually.",
      ].join(" "),
    };
  }

  const current = `v${match[2]}`;
  const expected = `v${version}`;

  if (current === expected) {
    return { change: null, warning: null };
  }

  if (!dryRun) {
    await fs.writeFile(
      badgePath,
      contents.replace(badgePattern, `$1${expected}$3`),
      "utf8"
    );
  }

  return {
    change: { file: manifest.versionBadge.file, from: current, to: expected },
    warning: null,
  };
}

/**
 * Compares protected configuration files against their upstream counterparts.
 * These files intentionally diverge, so differences are reported rather than
 * resolved; only their upstream-side existence and equality is inspected.
 *
 * @param {string} upstreamRoot Absolute path to the upstream checkout.
 * @param {Manifest} manifest Loaded manifest.
 * @returns {Promise<DriftEntry[]>} One entry per protected file.
 */
async function inspectProtectedFiles(upstreamRoot, manifest) {
  /** @type {DriftEntry[]} */
  const entries = [];

  for (const relative of manifest.protectedFiles) {
    const localFile = path.join(repoRoot, relative);
    const upstreamFile = path.join(
      upstreamRoot,
      manifest.upstream.exampleDir,
      relative
    );

    const [localExists, upstreamExists] = await Promise.all([
      pathExists(localFile),
      pathExists(upstreamFile),
    ]);

    if (!upstreamExists) {
      entries.push({ file: relative, status: "missing-upstream" });
      continue;
    }

    if (!localExists) {
      entries.push({ file: relative, status: "upstream-only" });
      continue;
    }

    const [localHash, upstreamHash] = await Promise.all([
      hashFile(localFile),
      hashFile(upstreamFile),
    ]);

    entries.push({
      file: relative,
      status: localHash === upstreamHash ? "identical" : "differs",
    });
  }

  return entries;
}

/**
 * Resolves the upstream checkout path and the version being synced.
 *
 * @param {string | null} requestedVersion Version passed on the command line.
 * @param {string} upstreamPathOption Raw `--upstream-path` value.
 * @returns {Promise<{ upstreamRoot: string; version: string; warnings: string[] }>}
 * @throws {Error} When the checkout is missing or no version can be determined.
 */
async function resolveTarget(requestedVersion, upstreamPathOption) {
  const upstreamRoot = path.resolve(repoRoot, upstreamPathOption);

  if (!(await pathExists(upstreamRoot))) {
    throw new Error(
      [
        `Upstream checkout not found at ${upstreamRoot}.`,
        "Pass --upstream-path pointing at a heroui-native checkout.",
      ].join(" ")
    );
  }

  const upstreamPackage = await readJsonFile(
    path.join(upstreamRoot, "package.json")
  );
  const checkoutVersion = upstreamPackage.version;

  if (typeof checkoutVersion !== "string") {
    throw new Error(
      `Could not read a version from ${path.join(upstreamRoot, "package.json")}`
    );
  }

  /** @type {string[]} */
  const warnings = [];
  const version = requestedVersion ?? checkoutVersion;

  if (!new RegExp(`^${SEMVER_SOURCE}$`).test(version)) {
    throw new Error(`\`${version}\` is not a valid version`);
  }

  if (requestedVersion !== null && requestedVersion !== checkoutVersion) {
    warnings.push(
      [
        `Requested version ${requestedVersion} but the upstream checkout reports`,
        `${checkoutVersion}. Confirm the checkout is at tag v${requestedVersion}.`,
      ].join(" ")
    );
  }

  return { upstreamRoot, version, warnings };
}

/**
 * Renders the markdown report handed to the reviewing agent and the pull request.
 *
 * @param {SyncSummary} summary Result of the sync.
 * @returns {string} Markdown document.
 */
function renderReport(summary) {
  /** @type {string[]} */
  const lines = [
    `# heroui-native sync report: v${summary.version}`,
    "",
    `- Upstream checkout: \`${summary.upstreamPath}\``,
    `- Mode: ${summary.dryRun ? "dry run" : "applied"}`,
    "",
  ];

  lines.push("## Mirrored files", "");

  if (summary.files.length === 0) {
    lines.push("No file changes; `src/` and `themes/` already match upstream.", "");
  } else {
    /** @type {Record<FileChangeKind, string>} */
    const headings = {
      added: "Added",
      modified: "Modified",
      deleted: "Deleted",
    };

    for (const kind of /** @type {FileChangeKind[]} */ ([
      "added",
      "modified",
      "deleted",
    ])) {
      const group = summary.files.filter((change) => change.kind === kind);
      if (group.length === 0) {
        continue;
      }
      lines.push(`### ${headings[kind]} (${group.length})`, "");
      for (const change of group) {
        lines.push(`- \`${change.file}\``);
      }
      lines.push("");
    }
  }

  lines.push("## Dependencies", "");

  const actionable = summary.dependencies.filter(
    (change) => change.kind !== "unchanged"
  );

  if (actionable.length === 0) {
    lines.push("No dependency changes.", "");
  } else {
    for (const change of actionable) {
      const transition =
        change.from === null
          ? `added as \`${change.to}\``
          : `\`${change.from}\` to \`${change.to}\``;
      lines.push(`- **${change.name}** (${change.section}): ${transition}`);
    }
    lines.push("");
  }

  if (summary.unexpectedLocalDependencies.length > 0) {
    lines.push(
      "### Unrecognised local-only dependencies",
      "",
      "Present here but absent upstream, and not listed as intentional in `scripts/sync-manifest.json`. Confirm upstream did not drop them.",
      ""
    );
    for (const name of summary.unexpectedLocalDependencies) {
      lines.push(`- \`${name}\``);
    }
    lines.push("");
  }

  if (summary.staleManifestIgnoreEntries.length > 0) {
    lines.push(
      "### Stale manifest ignore entries",
      "",
      "Listed as ignored upstream tooling but no longer present upstream; the manifest can likely be trimmed.",
      ""
    );
    for (const name of summary.staleManifestIgnoreEntries) {
      lines.push(`- \`${name}\``);
    }
    lines.push("");
  }

  lines.push(
    "## Protected configuration",
    "",
    "These files are never written by the sync because this repository consumes the published package rather than the library source. `differs` is expected; review it only when upstream changed the file in a way that also applies here.",
    ""
  );

  for (const entry of summary.drift) {
    lines.push(`- \`${entry.file}\`: ${entry.status}`);
  }
  lines.push("");

  if (summary.versionBadge !== null) {
    lines.push(
      "## Version badge",
      "",
      `Rewrote \`${summary.versionBadge.file}\` from \`${summary.versionBadge.from}\` to \`${summary.versionBadge.to}\`.`,
      ""
    );
  }

  if (summary.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of summary.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Runs the sync.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(
      [
        "Usage: node ./scripts/sync-upstream-example.mjs [options]",
        "",
        "  --version <semver>     Released heroui-native version (default: upstream checkout version)",
        "  --upstream-path <dir>  Path to a heroui-native checkout (default: .upstream)",
        "  --report-out <file>    Markdown report destination (default: .sync/report.md)",
        "  --dry-run              Report changes without writing",
        "  --json                 Print the machine-readable summary to stdout",
        "  --help                 Show this message",
        "",
      ].join("\n")
    );
    return;
  }

  const manifest = await loadManifest();
  const { upstreamRoot, version, warnings } = await resolveTarget(
    options.version,
    options.upstreamPath
  );

  /** @type {FileChange[]} */
  const files = [];

  for (const mirror of manifest.mirrors) {
    files.push(
      ...(await applyMirror(mirror, upstreamRoot, manifest, options.dryRun))
    );
  }

  const packageResult = await mergePackageJson(
    version,
    upstreamRoot,
    manifest,
    options.dryRun
  );

  const badgeResult = await syncVersionBadge(
    version,
    upstreamRoot,
    manifest,
    options.dryRun
  );
  if (badgeResult.warning !== null) {
    warnings.push(badgeResult.warning);
  }

  const drift = await inspectProtectedFiles(upstreamRoot, manifest);

  /** @type {SyncSummary} */
  const summary = {
    version,
    upstreamPath: options.upstreamPath,
    dryRun: options.dryRun,
    files,
    dependencies: packageResult.changes,
    unexpectedLocalDependencies: packageResult.unexpectedLocal,
    staleManifestIgnoreEntries: packageResult.staleIgnoreEntries,
    drift,
    warnings,
    versionBadge: badgeResult.change,
  };

  const report = renderReport(summary);

  if (options.dryRun) {
    process.stdout.write(`${report}\n`);
  } else {
    const reportPath = path.resolve(repoRoot, options.reportOut);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${report}\n`, "utf8");
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }

  const changedFileCount = summary.files.length;
  const changedDependencyCount = summary.dependencies.filter(
    (change) => change.kind !== "unchanged"
  ).length;

  process.stderr.write(
    [
      `Synced heroui-native v${version}:`,
      `${changedFileCount} file change(s),`,
      `${changedDependencyCount} dependency change(s),`,
      `${summary.warnings.length} warning(s).`,
      options.dryRun ? "No files were written (dry run)." : "",
      "\n",
    ]
      .filter((part) => part.length > 0)
      .join(" ")
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sync-upstream-example: ${message}\n`);
  process.exitCode = 1;
});
