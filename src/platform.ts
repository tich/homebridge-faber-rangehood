import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import * as Path from 'path';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { Astarte } from './api/astarte.js';
import { ObjectStore } from './lib/objectstore.js';
import { DeviceFactory, INFO_VERSION } from './devices/factory.js';

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

      try {
        await this.astarte.init();
      } catch(error) {
        this.log.error('Astarte initialization failed', error);
        return;
      }

      // run the method to discover / register your devices as accessories
      await this.discoverDevices();
    });
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
      if (!this.config.device_ids.includes(deviceId)) {
        continue;
      }

      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(deviceId);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // Check if the device info needs to be updated
        if (existingAccessory.context.device.info_version !== INFO_VERSION) {
          let deviceInfo = undefined;
          try {
            deviceInfo = await DeviceFactory.getDeviceInfo(this.log, this.astarte, deviceId);
          } catch(error) {
            this.log.error('Failed to get device info for device ID', deviceId, 'Skipping it');
            continue;
          }
          existingAccessory.context.device = deviceInfo!;
        }

        // create the accessory handler for the restored accessory
        // Accessory kind is stored in accessory.context.device
        DeviceFactory.constructDevice(this, existingAccessory);
      } else {
        this.log.info('Matched new device ID', deviceId);

        // the accessory does not yet exist, so we need to create it
        let deviceInfo = undefined;
        try {
          deviceInfo = await DeviceFactory.getDeviceInfo(this.log, this.astarte, deviceId);
        } catch(error) {
          this.log.error('Failed to get device info for device ID', deviceId, 'Skipping it');
          continue;
        }

        this.log.info('Adding new accessory:', deviceInfo!.kind);

        // create a new accessory
        const accessory = new this.api.platformAccessory(deviceInfo!.kind, uuid);

        // store a copy of the device info in the accessory context
        accessory.context.device = deviceInfo!;

        // create the accessory handler for the newly create accessory
        DeviceFactory.constructDevice(this, accessory);

        // link the accessory to our platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // push into discoveredCacheUUIDs
      discoveredUUIDs.push(uuid);
    }

    // Remove devices which are no longer present by removing them from Homebridge
    for (const [uuid, accessory] of this.accessories) {
      if (!discoveredUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
