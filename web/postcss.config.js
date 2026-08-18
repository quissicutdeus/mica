export default {
  plugins: {
    'postcss-preset-env': {
      features: {
        'oklab-function': { preserve: true },
        'color-functional-notation': { preserve: true },
        'nesting-rules': true
      }
    },
    autoprefixer: {}
  }
};
