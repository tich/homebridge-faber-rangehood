import { CharacteristicValue, HAPStatus, PlatformAccessory, Service } from 'homebridge';
import zod from 'zod';
import { FaberHomebridgePlatform } from '../platform.js';
import { BaseDevice } from './base.js';
import { AstarteRequestMethod } from '../api/astarte.js';
import { ASTARTE_INTERFACE_CONTROL, ASTARTE_INTERFACE_HOOD_STATUS } from '../api/constants.js';
import { TokenExpiredError, UnknownResponseError } from '../lib/errors.js';
import { mapRange } from '../lib/utils.js';

export class RangeHoodDevice extends BaseDevice {
  private fan_service: Service;
  private light_service: Service;
  private readonly refresh_interval_ms = 3 * 1000;
  
  constructor(
    platform: FaberHomebridgePlatform,
    accessory: PlatformAccessory,
  ) {
    super(platform, accessory);

    // TODO Adaptive Lighting support? https://github.com/homebridge-plugins/homebridge-meross/blob/latest/lib/device/light-cct.js#L97
    // TODO discover allowed light intensities
    // TODO add filter maintenance services (https://developers.homebridge.io/#/service/FilterMaintenance)
    // TODO better discovery of services

    // Get the LightBulb service if it exists, otherwise create a new LightBulb service
    this.light_service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // The light's default name is "<kind> Light" (so in this case "RangeHood Light")
    this.light_service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.kind + ' Light');

    // register handlers for the light's characteristics
    this.light_service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setLightOn.bind(this));
    this.light_service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setLightBrightness.bind(this))
      .setProps({ minStep: 50 });
    this.light_service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
      .onSet(this.setColorTemperature.bind(this));

    this.fan_service = this.accessory.getService(this.platform.Service.Fanv2) || this.accessory.addService(this.platform.Service.Fanv2);
    this.fan_service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.kind + ' Fan');

    this.fan_service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setFanActive.bind(this));
    this.fan_service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setFanSpeed.bind(this))
      .setProps({ minStep: 33.33 });

    setTimeout(() => this.updateHoodStatus(), this.refresh_interval_ms);
  }

  private propagateHapStatus(hapStatus: HAPStatus) {
    // Update all the services and characterstics with this hap status
    this.light_service.updateCharacteristic(this.platform.Characteristic.On, new this.platform.api.hap.HapStatusError(hapStatus));
    this.light_service.updateCharacteristic(this.platform.Characteristic.Brightness, new this.platform.api.hap.HapStatusError(hapStatus));
    this.light_service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, new this.platform.api.hap.HapStatusError(hapStatus));
  
    this.fan_service.updateCharacteristic(this.platform.Characteristic.Active, new this.platform.api.hap.HapStatusError(hapStatus));
    this.fan_service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, new this.platform.api.hap.HapStatusError(hapStatus));
  }

  private async updateHoodStatus() {
    const ResponseFormat = zod.object({
      data: zod.object({
        fan: zod.object({
          speed: zod.object({
            value: zod.number(),
          }),
        }),
        lights: zod.object({
          channels: zod.object({
            1: zod.object({
              intensity: zod.object({
                value: zod.number(),
              }),
            }),
            2: zod.object({
              intensity: zod.object({
                value: zod.number(),
              }),
            }),
          }),
        }),
      }),
    });
  
    let parsed_data = undefined;
    try {
      const data = await this.platform.astarte.doRequest(this.accessory.context.device.id, ASTARTE_INTERFACE_HOOD_STATUS, AstarteRequestMethod.GET, {});
      parsed_data = ResponseFormat.safeParse(data);
      if (!parsed_data.success) {
        this.platform.log.error('Failed to parse the hood status response', parsed_data.error, 'Received:', JSON.stringify(data));
        throw new UnknownResponseError;
      }
    } catch(error) {
      if (error instanceof TokenExpiredError) {
        this.propagateHapStatus(HAPStatus.INSUFFICIENT_AUTHORIZATION);
      } else if (error instanceof UnknownResponseError) {
        this.propagateHapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      } else {
        // This sounds like a recoverable network error. No need to stop updating
        setTimeout(() => this.updateHoodStatus, this.refresh_interval_ms);
      }
      return;
    }

    if (parsed_data!.data!.data.lights.channels[1].intensity.value > 0) {
      this.light_service.updateCharacteristic(this.platform.Characteristic.On, true);
      this.light_service.updateCharacteristic(this.platform.Characteristic.Brightness,
        mapRange(parsed_data!.data!.data.lights.channels[1].intensity.value, 0, 2, 0, 100));
    } else {
      this.light_service.updateCharacteristic(this.platform.Characteristic.On, false);
    }

    this.light_service.updateCharacteristic(this.platform.Characteristic.ColorTemperature,
      mapRange(parsed_data!.data!.data.lights.channels[1].intensity.value, 0, 4, 140, 500));

    if (parsed_data!.data!.data.fan.speed.value > 0) {
      this.fan_service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE);
      this.fan_service.updateCharacteristic(this.platform.Characteristic.RotationSpeed,
        mapRange(parsed_data!.data!.data.fan.speed.value, 0, 3, 0, 100));
    } else {
      this.fan_service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.INACTIVE);
    }

    setTimeout(() => this.updateHoodStatus(), this.refresh_interval_ms);
  }

  private async sendControlRequest(api_interface: string, data: Record<string, unknown>) {
    try {
      this.platform.log.info('Sending:', JSON.stringify(data));
      await this.platform.astarte.doRequest(
        this.accessory.context.device.id,
        ASTARTE_INTERFACE_CONTROL + api_interface,
        AstarteRequestMethod.POST,
        data);
    } catch(error) {
      if (error instanceof TokenExpiredError) {
        this.propagateHapStatus(HAPStatus.INSUFFICIENT_AUTHORIZATION);
      } else if (error instanceof UnknownResponseError) {
        this.propagateHapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      } else {
        // This sounds like a recoverable network error. No need to blow up
        // The error has been logged already. Just return
        return;
      }
    }
  }

  async setLightOn(value: CharacteristicValue) {
    const isOn = value as boolean;
    this.platform.log.info('Turning light', isOn ? 'On': 'Off');
    const configuredBrightness = this.light_service.getCharacteristic(this.platform.Characteristic.Brightness).value! as number;
    this.platform.log.info('Configured brightness:', configuredBrightness);
    const intensityFromBrightness = mapRange(configuredBrightness, 0, 100, 0, 2);
    this.platform.log.info('Intensity from brightness:', intensityFromBrightness);
    const post_data = {
      data: isOn ? intensityFromBrightness ? intensityFromBrightness : 1 : 0,
    };
    await this.sendControlRequest('/lights/channels/1/intensity', post_data);
  }

  async setLightBrightness(value: CharacteristicValue) {
    const brightness = value as number;
    this.platform.log.info('Setting light brightness to', brightness);
    const intensityFromBrightness = mapRange(brightness, 0, 100, 0, 2);
    this.platform.log.info('Intensity from brightness:', intensityFromBrightness);
    const post_data = {
      data: intensityFromBrightness,
    };
    await this.sendControlRequest('/lights/channels/1/intensity', post_data);
  }

  async setColorTemperature(value: CharacteristicValue) {
    const temperature = value as number;
    this.platform.log.info('Setting color temperature to', temperature);
    const intensityFromTemperature = Math.round(mapRange(temperature, 140, 500, 0, 4));
    this.platform.log.info('Intensity from temperature:', intensityFromTemperature);
    const post_data = {
      data: intensityFromTemperature,
    };
    await this.sendControlRequest('/lights/channels/2/intensity', post_data);
  }

  async setFanActive(value: CharacteristicValue) {
    const isOn = value as number === this.platform.Characteristic.Active.ACTIVE;
    this.platform.log.info('Turning fan', isOn ? 'On': 'Off');
    const configuredSpeed = this.fan_service.getCharacteristic(this.platform.Characteristic.RotationSpeed).value! as number;
    this.platform.log.info('Configured speed:', configuredSpeed);
    const intensityFromSpeed = Math.round(mapRange(configuredSpeed, 0, 100, 0, 3));
    this.platform.log.info('Intensity from speed:', intensityFromSpeed);
    const post_data = {
      data: isOn ? intensityFromSpeed ? intensityFromSpeed : 1 : 0,
    };
    await this.sendControlRequest('/fan/speed', post_data);
  }

  async setFanSpeed(value: CharacteristicValue) {
    const speed = value as number;
    this.platform.log.info('Setting fan speed to', speed);
    const intensityFromSpeed = Math.round(mapRange(speed, 0, 100, 0, 3));
    this.platform.log.info('Intensity from speed:', intensityFromSpeed);
    const post_data = {
      data: intensityFromSpeed,
    };
    await this.sendControlRequest('/fan/speed', post_data);
  }
}