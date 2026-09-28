import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * package.json is the nearest one up from this file (e.g. one level up from the compiled `dist` directory).
 */
export const PLUGIN_VERSION: string = (() => {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, 'package.json'))) {
    directory = path.dirname(directory);
  }
  return JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
})();
