// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      'dist/*',
      // Expo's generated output, plus the upstream checkout and reports the release
      // sync workflow writes. `.upstream` in particular holds a full copy of the
      // library repository, which would otherwise dominate any lint run.
      '.expo/**',
      '.sync/**',
      '.upstream/**',
    ],
  },
]);
