const webpack = require('webpack');

module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      const wasmExtensionRegExp = /\.wasm$/;
      webpackConfig.resolve.extensions.push('.wasm');
      webpackConfig.experiments = {
        asyncWebAssembly: true,
        syncWebAssembly: true,
      };
      webpackConfig.resolve.fallback = {
        fs:      false,
        crypto:  require.resolve('crypto-browserify'),
        buffer:  require.resolve('buffer/'),
        stream:  require.resolve('stream-browserify'),
        process: require.resolve('process/browser.js'),
      };
      // ESM packages resolve 'process/browser' as a strict specifier; alias it
      // to the absolute .js path so webpack finds it from any module origin.
      webpackConfig.resolve.alias = {
        ...(webpackConfig.resolve.alias || {}),
        'process/browser': require.resolve('process/browser.js'),
      };
      webpackConfig.module.rules.forEach((rule) => {
        (rule.oneOf || []).forEach((oneOf) => {
          if (oneOf.type === 'asset/resource') {
            oneOf.exclude.push(wasmExtensionRegExp);
          }
        });
      });
      webpackConfig.plugins.push(
        new webpack.ProvidePlugin({
          Buffer:  ['buffer', 'Buffer'],
          process: require.resolve('process/browser.js'),
        }),
      );
      return webpackConfig;
    },
  },
};
