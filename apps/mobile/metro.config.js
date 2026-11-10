const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);
// 아바타 선생님 3D 모델(assets/avatar/tutor.glb)
config.resolver.assetExts.push('glb');

module.exports = withNativeWind(config, { input: './global.css' });
