import type { PlatformAccessory, Service } from 'homebridge';
import type { FaberHomebridgePlatform } from '../platform.js';
import type { DeviceInfo } from './factory.js';

export class BaseDevice {
  protected readonly device_info: DeviceInfo;
  // The services named with `setServiceName`, and their names
  private readonly service_names = new Map<Service, string>();

  constructor(
    protected readonly platform: FaberHomebridgePlatform,
    protected readonly accessory: PlatformAccessory,
  ) {
    this.device_info = accessory.context.device;
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Faber')
      .setCharacteristic(this.platform.Characteristic.Model, this.device_info.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device_info.id)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.device_info.firmware_revision);
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
    this.service_names.set(service, name);
  }

  /**
   * Stop any background activity (e.g. polling), since Homebridge is shutting down.
   * Device types that have background activity should override this.
   */
  public shutdown() {}

  /**
   * Apply the device's name to the accessory and all its services, overwriting any names set in the Home app.
   * Used when the device was renamed in the plugin config. HomeKit keeps its own copy of the accessory's name
   * once it's paired, so the Home app may not pick up the accessory's new name, but it does pick up the services' names.
   */
  public applyName() {
    this.accessory.updateDisplayName(this.device_info.name);
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .updateCharacteristic(this.platform.Characteristic.Name, this.device_info.name);
    for (const [service, name] of this.service_names) {
      service.updateCharacteristic(this.platform.Characteristic.ConfiguredName, name);
    }
  }
}
