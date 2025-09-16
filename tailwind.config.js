import heroUINativePlugin from 'heroui-native/tailwind-plugin';

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    // Your app files
    "./src/**/*.{js,jsx,ts,tsx}",
    // HeroUI Native
    "./node_modules/heroui-native/lib/**/*.{js,ts,jsx,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {},
  },
  plugins: [heroUINativePlugin],
}