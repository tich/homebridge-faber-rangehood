import type { Logging, PlatformAccessory } from 'homebridge';
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public static async getDeviceFeatures(log: Logging, astarte: Astarte, device_id: string) {
    return {};
  }
}