module.exports = function (api) {
    api.cache(true);
    return {
      presets: [
        ["babel-preset-expo"],
      ],
      plugins: [
        // Must run first so Lingui macros are expanded before any other transform.
        "@lingui/babel-plugin-lingui-macro",
      ],
    };
  };