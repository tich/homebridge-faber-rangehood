import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import * as Path from 'path';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { Astarte } from './api/astarte.js';
import { ObjectStore } from './lib/objectstore.js';
import { DeviceFactory, DeviceInfo, INFO_VERSION } from './devices/factory.js';
import { isTransientError } from './lib/errors.js';

// Backoff for retrying operations that failed with a network error at startup
const RETRY_MIN_DELAY_MS = 10 * 1000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1000;

interface DeviceConfig {
  name: string,
  id: string
}

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
  private readonly object_store: ObjectStore;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.object_store = new ObjectStore(Path.join(api.user.storagePath(), PLUGIN_NAME, 'persist'));
    this.astarte = new Astarte(log, config, this.object_store);

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      log.debug('Executing didFinishLaunching callback');
      await this.object_store.init();
      await this.initAstarteAndDiscoverDevices();
    });
  }

  /**
   * Initialize the connection to Astarte, then discover the devices.
   *
   * Network errors are retried with an exponential backoff, since Homebridge can easily start before the network is up
   * (e.g. after a power outage). Until then, the cached accessories stay in HomeKit, but don't respond.
   * Other errors need the user to step in (e.g. to provide a new refresh token), so they aren't retried.
   */
  private async initAstarteAndDiscoverDevices(retry_delay_ms = RETRY_MIN_DELAY_MS) {
    try {
      await this.astarte.init();
    } catch(error) {
      if (!isTransientError(error)) {
        this.log.error('Astarte initialization failed', error);
        return;
      }
      this.log.warn(`Astarte initialization failed. Retrying in ${retry_delay_ms / 1000} seconds`);
      setTimeout(() => this.initAstarteAndDiscoverDevices(Math.min(retry_delay_ms * 2, RETRY_MAX_DELAY_MS)), retry_delay_ms);
      return;
    }

    // run the method to discover / register your devices as accessories
    await this.discoverDevices();
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

  private async discoverDevices() {
    const discoveredUUIDs: string[] = [];
    const devicesInAccount = this.astarte.getDevices();

    // loop over the discovered devices and register each one if it has not already been registered
    for (const deviceId of devicesInAccount) {
      // Filter out the ones that are not in the config
      const deviceConfig: DeviceConfig | undefined = this.config.devices.find((device: DeviceConfig) => {
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

      await this.setUpDevice(deviceId, deviceConfig, uuid);
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
   * If that fails, the cached device info is used instead, as long as it's in the current format.
   * Otherwise, a network error is retried with an exponential backoff. Until then, a cached accessory stays in HomeKit,
   * but doesn't respond, and a new device isn't added yet.
   */
  private async setUpDevice(deviceId: string, deviceConfig: DeviceConfig, uuid: string, retry_delay_ms = RETRY_MIN_DELAY_MS) {
    // see if an accessory with the same uuid has already been registered and restored from
    // the cached devices we stored in the `configureAccessory` method above
    const existingAccessory = this.accessories.get(uuid);

    let deviceInfo: DeviceInfo;
    try {
      deviceInfo = await DeviceFactory.getDeviceInfo(this.log, this.astarte, deviceId, deviceConfig.name);
    } catch(error) {
      if (existingAccessory?.context.device?.info_version === INFO_VERSION) {
        this.log.warn('Failed to refresh the device info for device ID', deviceId, 'Using the cached device info');
        deviceInfo = existingAccessory.context.device;
      } else if (isTransientError(error)) {
        this.log.warn(`Failed to get device info for device ID ${deviceId}. Retrying in ${retry_delay_ms / 1000} seconds`);
        setTimeout(() => this.setUpDevice(deviceId, deviceConfig, uuid, Math.min(retry_delay_ms * 2, RETRY_MAX_DELAY_MS)), retry_delay_ms);
        return;
      } else {
        this.log.error('Failed to get device info for device ID', deviceId, error);
        return;
      }
    }

    if (existingAccessory) {
      // the accessory already exists
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      existingAccessory.context.device = deviceInfo;

      // create the accessory handler for the restored accessory
      DeviceFactory.constructDevice(this, existingAccessory);

      // Persist the refreshed device info, and any services the handler added or removed
      this.api.updatePlatformAccessories([existingAccessory]);
    } else {
      this.log.info('Adding new accessory:', deviceInfo.name);

      // create a new accessory
      const accessory = new this.api.platformAccessory(deviceInfo.name, uuid);

      // store a copy of the device info in the accessory context
      accessory.context.device = deviceInfo;

      // create the accessory handler for the newly create accessory
      DeviceFactory.constructDevice(this, accessory);

      // link the accessory to our platform
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }
}
