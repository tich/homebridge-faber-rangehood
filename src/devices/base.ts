import type { Logging, PlatformAccessory, Service } from 'homebridge';
import type { FaberHomebridgePlatform } from '../platform.js';
import { Astarte } from '../api/astarte.js';

export class BaseDevice {
  protected readonly device_info;

  constructor(
    protected readonly platform: FaberHomebridgePlatform,
    protected readonly accessory: PlatformAccessory,
  ) {
    this.device_info = accessory.context.device;
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Faber')
      .setCharacteristic(this.platform.Characteristic.Model, this.device_info.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device_info.id);
  }

  /**
   * Set a service's name.
   * On iOS 16+, the Home app mostly ignores the read-only `Name` of secondary services, and uses `ConfiguredName` instead.
   * `ConfiguredName` is also where the Home app writes the name when the user renames the service,
   * so it's only set when empty, to keep the user's renames across restarts.
   */
  protected setServiceName(service: Service, name: string) {
    service.setCharacteristic(this.platform.Characteristic.Name, name);

    // The optional characteristics are persisted in the accessory cache, so only add it once
    if (!service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    }
    if (!service.getCharacteristic(this.platform.Characteristic.ConfiguredName).value) {
      service.updateCharacteristic(this.platform.Characteristic.ConfiguredName, name);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public static async getDeviceFeatures(log: Logging, astarte: Astarte, device_id: string) {
    return {};
  }
}