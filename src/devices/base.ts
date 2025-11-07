import type { PlatformAccessory } from 'homebridge';
import type { FaberHomebridgePlatform } from '../platform.js';

export class BaseDevice {
  constructor(
    protected readonly platform: FaberHomebridgePlatform,
    protected readonly accessory: PlatformAccessory,
  ) {
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Faber')
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.id);
  }
}