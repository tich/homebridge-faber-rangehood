import { createRequire } from 'node:module';

/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'FaberRangeHood';

/**
 * This must match the name of your plugin as defined the package.json `name` property
 */
export const PLUGIN_NAME = 'homebridge-faber-range-hood';

/**
 * The plugin's version, as defined in the package.json `version` property.
 * package.json sits one level up from both `src` and the compiled `dist` directory.
 */
export const PLUGIN_VERSION: string = createRequire(import.meta.url)('../package.json').version;
