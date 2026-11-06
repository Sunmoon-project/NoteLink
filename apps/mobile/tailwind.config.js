const { colors, fontSize, spacing, borderRadius } = require('./src/theme/tokens');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: { extend: { colors, fontSize, spacing, borderRadius } },
  plugins: [],
};
