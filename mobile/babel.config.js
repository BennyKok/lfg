// Required for expo-router: babel-preset-expo injects EXPO_ROUTER_APP_ROOT,
// which expo-router/_ctx uses as the require.context root. Without this file
// the bundle fails with "Invalid call ... process.env.EXPO_ROUTER_APP_ROOT".
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
