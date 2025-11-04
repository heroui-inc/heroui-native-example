const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require('uniwind/metro'); 
 
const config = getDefaultConfig(__dirname)
 
module.exports = withUniwindConfig(config, {  
  cssEntryFile: './global.css',
  dtsFile: './src/uniwind-types.d.ts',
  extraThemes: [
    'lavender-light',
    'lavender-dark',
    'mint-light',
    'mint-dark',
    'sky-light',
    'sky-dark',
  ],
});