import type { PlatformConfig } from 'homebridge';
import zod from 'zod';
import { err, ok, Result } from 'neverthrow';
import { InvalidConfigError } from './lib/errors.js';

/**
 * The plugin config, as described by config.schema.json.
 * Unknown properties are kept, since Homebridge adds its own (e.g. `platform`, `_bridge`).
 */
const PluginConfigFormat = zod.looseObject({
  name: zod.string().optional(),
  auth_mode: zod.literal('token'),
  refresh_token: zod.string().min(1),
  // Seconds. While push updates are active, how often to also poll the hoods' status, in case an update was missed
  fallback_poll_interval: zod.number().int().min(30).default(300),
  devices: zod.array(zod.object({
    id: zod.string().min(1),
    name: zod.string().optional(),
  })).default([]),
});

export type PluginConfig = zod.infer<typeof PluginConfigFormat>;
export type DeviceConfig = PluginConfig['devices'][number];

/**
 * Validate the plugin config
 * @returns The validated config, or an `InvalidConfigError` describing everything that's wrong with it
 */
export function parsePluginConfig(config: PlatformConfig): Result<PluginConfig, InvalidConfigError> {
  const parsed = PluginConfigFormat.safeParse(config);
  if (!parsed.success) {
    return err(new InvalidConfigError(zod.prettifyError(parsed.error)));
  }
  return ok(parsed.data);
}
