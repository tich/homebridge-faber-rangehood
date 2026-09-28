import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import * as Path from 'path';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { Astarte } from './api/astarte.js';
import { AstarteChannel } from './api/channel.js';
import { ObjectStore } from './lib/objectstore.js';
import { DeviceFactory, DeviceInfo } from './devices/factory.js';
import type { BaseDevice } from './devices/base.js';
import { InvalidConfigError, isTransientError } from './lib/errors.js';
import { DeviceConfig, parsePluginConfig, PluginConfig } from './config.js';
import { Result } from 'neverthrow';

// Backoff for retrying operations that failed with a network error at startup
const RETRY_MIN_DELAY_MS = 10 * 1000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1000;

/**
 * FaberHomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class FaberHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  public readonly astarte: Astarte;
  public readonly channel: AstarteChannel;
  public readonly fallback_poll_interval_ms: number;
  private readonly object_store: ObjectStore;
  private readonly plugin_config: Result<PluginConfig, InvalidConfigError>;

  // What to stop when Homebridge shuts down
  private shutting_down = false;
  private readonly retry_timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly devices: BaseDevice[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.object_store = new ObjectStore(Path.join(api.user.storagePath(), PLUGIN_NAME, 'persist'));
    this.astarte = new Astarte(log, this.object_store);
    this.plugin_config = parsePluginConfig(config);
    this.channel = new AstarteChannel(log, this.astarte);
    // Only used once the config was found to be valid
    this.fallback_poll_interval_ms = this.plugin_config.map((value) => value.fallback_poll_interval * 1000).unwrapOr(0);

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      log.debug('Executing didFinishLaunching callback');
      if (this.plugin_config.isErr()) {
        // The cached accessories stay in HomeKit, but won't respond until the config is fixed
        this.log.error('The plugin config is invalid, so the plugin won\'t start. Please fix it:\n' + this.plugin_config.error.message);
        return;
      }
      const plugin_config = this.plugin_config.value;

      const storage = await this.object_store.init();
      if (storage.isErr()) {
        this.log.error('Failed to initialize the plugin\'s storage in', this.object_store.storage_path,
          'Please check that Homebridge can write to it', storage.error.cause);
        return;
      }
      await this.runSafely('starting up', () => this.initAstarteAndDiscoverDevices(plugin_config));
    });

    // Homebridge has already saved the accessory cache by then, and exits shortly after
    this.api.on('shutdown', () => this.shutdown());
  }

  /**
   * Stop all background activity: pending retries, and the devices' polling
   */
  private shutdown() {
    this.log.debug('Shutting down');
    this.shutting_down = true;
    this.channel.stop();
    for (const timer of this.retry_timers) {
      clearTimeout(timer);
    }
    this.retry_timers.clear();
    for (const device of this.devices) {
      device.shutdown();
    }
  }

  /**
   * Retry a task later, unless Homebridge is shutting down
   */
  private scheduleRetry(description: string, task: () => Promise<void>, delay_ms: number) {
    if (this.shutting_down) {
      return;
    }
    const timer = setTimeout(() => {
      this.retry_timers.delete(timer);
      void this.runSafely(description, task);
    }, delay_ms);
    this.retry_timers.add(timer);
  }

  /**
   * Run a task, logging any unexpected error. Expected errors are returned as Results rather than thrown,
   * so this only catches bugs, or errors thrown by the Homebridge and HAP-NodeJS APIs.
   *
   * This wraps the plugin's asynchronous entry points (i.e. event handlers and timer callbacks), since an error escaping
   * them would be an unhandled promise rejection, which makes Homebridge shut down entirely. It also wraps each device's
   * setup, so that one device failing doesn't prevent the others from being set up.
   *
   * @param description What the task does, for the log (e.g. "starting up")
   */
  private async runSafely(description: string, task: () => Promise<void>) {
    try {
      await task();
    } catch (error) {
      this.log.error('Unexpected error while', description, error);
    }
  }

  /**
   * Initialize the connection to Astarte, then discover the devices.
   *
   * Network errors are retried with an exponential backoff, since Homebridge can easily start before the network is up
   * (e.g. after a power outage). Until then, the cached accessories stay in HomeKit, but don't respond.
   * Other errors need the user to step in (e.g. to provide a new refresh token), so they aren't retried.
   */
  private async initAstarteAndDiscoverDevices(config: PluginConfig, retry_delay_ms = RETRY_MIN_DELAY_MS) {
    const init = await this.astarte.init(config);
    if (init.isErr()) {
      if (!isTransientError(init.error)) {
        this.log.error('Astarte initialization failed', init.error);
        return;
      }
      this.log.warn(`Astarte initialization failed. Retrying in ${retry_delay_ms / 1000} seconds`);
      this.scheduleRetry('starting up',
        () => this.initAstarteAndDiscoverDevices(config, Math.min(retry_delay_ms * 2, RETRY_MAX_DELAY_MS)), retry_delay_ms);
      return;
    }

    if (this.shutting_down) {
      return;
    }
    // run the method to discover / register your devices as accessories
    await this.discoverDevices(config);
    if (!this.shutting_down) {
      // Devices set up later (e.g. after a retry) start receiving push updates as soon as they're set up
      this.channel.start();
    }
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  private async discoverDevices(config: PluginConfig) {
    const discoveredUUIDs: string[] = [];
    const devicesInAccount = this.astarte.getDevices();
    const configuredDevices = config.devices;
    if (configuredDevices.length === 0) {
      this.log.warn('No devices are configured, so none will be exposed to HomeKit. Add your devices to the plugin config');
    }
    for (const deviceConfig of configuredDevices) {
      if (!devicesInAccount.includes(deviceConfig.id)) {
        this.log.warn('Device ID', deviceConfig.id, 'from the plugin config isn\'t in your Faber account, so it will be ignored.',
          'Devices in your account:', devicesInAccount.join(', '));
      }
    }

    // loop over the discovered devices and register each one if it has not already been registered
    for (const deviceId of devicesInAccount) {
      // Filter out the ones that are not in the config
      const deviceConfig: DeviceConfig | undefined = configuredDevices.find((device: DeviceConfig) => {
        return device.id === deviceId;
      });
      if (!deviceConfig) {
        continue;
      }

      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(deviceId);

      // Mark it as discovered even if setting it up fails below, so a transient error doesn't remove it from HomeKit
      discoveredUUIDs.push(uuid);

      await this.runSafely(`setting up device ID ${deviceId}`, () => this.setUpDevice(deviceId, deviceConfig, uuid));
    }

    // Remove devices which are no longer present by removing them from Homebridge
    for (const [uuid, accessory] of this.accessories) {
      if (!discoveredUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  /**
   * Create or restore a device's accessory, and its handler.
   *
   * The device info is always refreshed, to pick up changes such as a firmware update or a renamed device.
   * If that fails, the cached device info is used instead, as long as it's valid and in the current format.
   * Otherwise, a network error is retried with an exponential backoff. Until then, a cached accessory stays in HomeKit,
   * but doesn't respond, and a new device isn't added yet.
   */
  private async setUpDevice(deviceId: string, deviceConfig: DeviceConfig, uuid: string, retry_delay_ms = RETRY_MIN_DELAY_MS) {
    // see if an accessory with the same uuid has already been registered and restored from
    // the cached devices we stored in the `configureAccessory` method above
    const existingAccessory = this.accessories.get(uuid);
    // The name the device had until now, to detect it being renamed in the plugin config
    const previousName: unknown = existingAccessory?.context.device?.name;

    const fetchedDeviceInfo = await DeviceFactory.getDeviceInfo(this.log, this.astarte, deviceId, deviceConfig.name ?? '');
    let deviceInfo: DeviceInfo;
    if (fetchedDeviceInfo.isOk()) {
      deviceInfo = fetchedDeviceInfo.value;
    } else {
      const error = fetchedDeviceInfo.error;
      const cachedDeviceInfo = existingAccessory ? DeviceFactory.parseCachedDeviceInfo(existingAccessory.context.device) : undefined;
      if (cachedDeviceInfo?.isOk()) {
        this.log.warn('Failed to refresh the device info for device ID', deviceId, 'Using the cached device info');
        // The device may have been renamed in the plugin config since its device info was cached
        deviceInfo = { ...cachedDeviceInfo.value, name: deviceConfig.name || cachedDeviceInfo.value.name };
      } else if (isTransientError(error)) {
        this.log.warn(`Failed to get device info for device ID ${deviceId}. Retrying in ${retry_delay_ms / 1000} seconds`);
        this.scheduleRetry(`setting up device ID ${deviceId}`,
          () => this.setUpDevice(deviceId, deviceConfig, uuid, Math.min(retry_delay_ms * 2, RETRY_MAX_DELAY_MS)), retry_delay_ms);
        return;
      } else {
        this.log.error('Failed to get device info for device ID', deviceId, error);
        return;
      }
    }

    if (this.shutting_down) {
      // Homebridge has already saved the accessory cache, so don't change the accessories anymore
      return;
    }

    // create a new accessory if needed, and store a copy of the device info in the accessory context
    const accessory = existingAccessory ?? new this.api.platformAccessory(deviceInfo.name, uuid);
    accessory.context.device = deviceInfo;

    // create the accessory handler
    const device = DeviceFactory.constructDevice(this, accessory);
    if (device.isErr()) {
      this.log.error('Failed to set up device ID', deviceId, device.error);
      return;
    }
    this.devices.push(device.value);

    if (existingAccessory) {
      this.log.info('Restored existing accessory from cache:', existingAccessory.displayName);
      if (previousName !== undefined && previousName !== deviceInfo.name) {
        // Only when the name changed, so that renames done in the Home app aren't overwritten on every restart
        this.log.info(`Renaming "${previousName}" to "${deviceInfo.name}", as set in the plugin config`);
        device.value.applyName();
      }
      // Persist the refreshed device info, and any services the handler added or removed
      this.api.updatePlatformAccessories([existingAccessory]);
    } else {
      this.log.info('Adding new accessory:', deviceInfo.name);
      // link the accessory to our platform
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }
}
