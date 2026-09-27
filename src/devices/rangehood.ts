import { CharacteristicValue, HAPStatus, Logging, PlatformAccessory, Service } from 'homebridge';
import zod from 'zod';
import { FaberHomebridgePlatform } from '../platform.js';
import { BaseDevice } from './base.js';
import { Astarte, AstarteRequestMethod } from '../api/astarte.js';
import {
  ASTARTE_INTERFACE_HOOD_CONTROL,
  ASTARTE_INTERFACE_HOOD_FEATURES,
  ASTARTE_INTERFACE_HOOD_MOTOR_PROPERTIES,
  ASTARTE_INTERFACE_HOOD_STATUS }
  from '../api/constants.js';
import { TokenExpiredError, UnknownResponseError } from '../lib/errors.js';
import { mapRange } from '../lib/utils.js';
import { ChannelWriter } from '../lib/channelwriter.js';

/**
 * The latest state HomeKit requested, or the hood reported, in HomeKit's units.
 *
 * HAP-NodeJS only stores a written value once its handler completes, so a handler can't read the other values
 * written in the same HomeKit request (e.g. On + Brightness) from the characteristics. It reads them from here instead.
 */
interface HoodState {
  light: {
    on: boolean;
    brightness: number; // Percentage
    color_temperature: number; // Mireds
  };
  fan: {
    active: boolean;
    speed: number; // Percentage
  };
}

export class RangeHoodDevice extends BaseDevice {
  private fan_service: Service;
  private light_service: Service;
  private carbon_filter_service: Service;
  private grease_filter_service: Service;

  private readonly refresh_interval_ms = 3 * 1000;

  // Polling is paused while writes are in flight, so a poll can't overwrite a write with an outdated state
  private poll_timer?: ReturnType<typeof setTimeout>;
  private polling_stopped = false;
  private writes_in_flight = 0;
  // Incremented whenever a write starts, so a poll can tell that a write happened while it was in flight
  private write_generation = 0;

  private readonly state: HoodState;
  private readonly light_writer: ChannelWriter<number>;
  private readonly color_temperature_writer: ChannelWriter<number>;
  private readonly fan_writer: ChannelWriter<number>;

  private readonly max_fan_speed: number;
  private readonly max_light_intensity: number;
  private readonly max_color_temperature_settings: number;
  // HomeKit's color temperature is in mireds (1,000,000 / Kelvin), so the coolest light has the lowest value.
  // The hood's manual specifies a 2700K - 6500K range. Color temperature setting 0 is the coolest.
  private readonly min_color_temperature_mireds = 154; // 6500K
  private readonly max_color_temperature_mireds = 370; // 2700K
  private readonly max_carbon_filter_hours: number;
  private readonly max_grease_filter_hours: number;

  constructor(
    platform: FaberHomebridgePlatform,
    accessory: PlatformAccessory,
  ) {
    super(platform, accessory);

    // TODO Adaptive Lighting support? https://github.com/homebridge-plugins/homebridge-meross/blob/latest/lib/device/light-cct.js#L97
    
    this.max_fan_speed = this.device_info.features.motor.maxFanSpeed;
    this.max_light_intensity = this.device_info.features.features.lights.channels[1].maxIntensity;
    this.max_color_temperature_settings = this.device_info.features.features.lights.channels[2].maxIntensity;
    this.max_carbon_filter_hours = this.device_info.features.features.filters.fc.replacementHours;
    this.max_grease_filter_hours = this.device_info.features.features.filters.fg.replacementHours;

    // Get the LightBulb service if it exists, otherwise create a new LightBulb service
    this.light_service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // The light's default name is "<name> Light" (e.g. "RangeHood Light")
    this.setServiceName(this.light_service, this.device_info.name + ' Light');

    // register handlers for the light's characteristics
    this.light_service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setLightOn.bind(this));
    this.light_service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setLightBrightness.bind(this));
    this.light_service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
      .onSet(this.setColorTemperature.bind(this))
      .setProps({
        minValue: this.min_color_temperature_mireds,
        maxValue: this.max_color_temperature_mireds,
        // Snap the slider to the hood's discrete color temperature settings
        minStep: (this.max_color_temperature_mireds - this.min_color_temperature_mireds) / this.max_color_temperature_settings,
      });

    this.fan_service = this.accessory.getService(this.platform.Service.Fanv2) || this.accessory.addService(this.platform.Service.Fanv2);
    this.setServiceName(this.fan_service, this.device_info.name + ' Fan');

    this.fan_service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setFanActive.bind(this));
    this.fan_service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setFanSpeed.bind(this))
      .setProps({ minStep: 100 / this.max_fan_speed });

    let carbon_filter_service = this.accessory.getServiceById(this.platform.Service.FilterMaintenance, 'Carbon');
    if (!carbon_filter_service) {
      carbon_filter_service = new this.platform.Service.FilterMaintenance(this.device_info.name + ' Carbon Filter', 'Carbon');
      carbon_filter_service = this.accessory.addService(carbon_filter_service);
    }
    this.carbon_filter_service = <Service>carbon_filter_service;
    this.setServiceName(this.carbon_filter_service, this.device_info.name + ' Carbon Filter');

    this.carbon_filter_service.getCharacteristic(this.platform.Characteristic.ResetFilterIndication)
      .onSet(this.resetCarbonFilter.bind(this));

    let grease_filter_service = this.accessory.getServiceById(this.platform.Service.FilterMaintenance, 'Grease');
    if (!grease_filter_service) {
      grease_filter_service = new this.platform.Service.FilterMaintenance(this.device_info.name + ' Grease Filter', 'Grease');
      grease_filter_service = this.accessory.addService(grease_filter_service);
    }
    this.grease_filter_service = <Service>grease_filter_service;
    this.setServiceName(this.grease_filter_service, this.device_info.name + ' Grease Filter');

    this.grease_filter_service.getCharacteristic(this.platform.Characteristic.ResetFilterIndication)
      .onSet(this.resetGreaseFilter.bind(this));

    // Start from the last known state, as restored from the accessory cache
    this.state = {
      light: {
        on: this.light_service.getCharacteristic(this.platform.Characteristic.On).value as boolean,
        brightness: this.light_service.getCharacteristic(this.platform.Characteristic.Brightness).value as number,
        color_temperature: this.light_service.getCharacteristic(this.platform.Characteristic.ColorTemperature).value as number,
      },
      fan: {
        active: this.fan_service.getCharacteristic(this.platform.Characteristic.Active).value === this.platform.Characteristic.Active.ACTIVE,
        speed: this.fan_service.getCharacteristic(this.platform.Characteristic.RotationSpeed).value as number,
      },
    };

    this.light_writer = new ChannelWriter(
      () => this.getLightIntensity(),
      (intensity) => this.sendControlRequest('/lights/channels/1/intensity', { data: intensity }));
    this.color_temperature_writer = new ChannelWriter(
      () => this.getColorTemperatureSetting(),
      (setting) => this.sendControlRequest('/lights/channels/2/intensity', { data: setting }));
    this.fan_writer = new ChannelWriter(
      () => this.getFanSpeed(),
      (speed) => this.sendControlRequest('/fan/speed', { data: speed }));

    this.schedulePoll();
  }

  /**
   * Schedule the next status poll, replacing any poll that's already scheduled
   */
  private schedulePoll() {
    clearTimeout(this.poll_timer);
    if (this.polling_stopped) {
      return;
    }
    this.poll_timer = setTimeout(() => this.updateHoodStatus(), this.refresh_interval_ms);
  }

  /**
   * A poll's result is outdated if a write is in flight, or if one started after the poll did.
   * The write's completion schedules the next poll, so an outdated poll shouldn't schedule one itself.
   */
  private isPollOutdated(poll_write_generation: number) {
    return this.writes_in_flight > 0 || poll_write_generation !== this.write_generation;
  }

  private propagateHapStatus(hapStatus: HAPStatus) {
    // Update all the services and characterstics with this hap status
    this.light_service.updateCharacteristic(this.platform.Characteristic.On, new this.platform.api.hap.HapStatusError(hapStatus));
    this.light_service.updateCharacteristic(this.platform.Characteristic.Brightness, new this.platform.api.hap.HapStatusError(hapStatus));
    this.light_service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, new this.platform.api.hap.HapStatusError(hapStatus));
  
    this.fan_service.updateCharacteristic(this.platform.Characteristic.Active, new this.platform.api.hap.HapStatusError(hapStatus));
    this.fan_service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, new this.platform.api.hap.HapStatusError(hapStatus));
  
    this.carbon_filter_service.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication, new this.platform.api.hap.HapStatusError(hapStatus));
    this.carbon_filter_service.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, new this.platform.api.hap.HapStatusError(hapStatus));

    this.grease_filter_service.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication, new this.platform.api.hap.HapStatusError(hapStatus));
    this.grease_filter_service.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, new this.platform.api.hap.HapStatusError(hapStatus));
  }

  private async updateHoodStatus() {
    const ResponseFormat = zod.object({
      data: zod.object({
        fan: zod.object({
          speed: zod.object({
            value: zod.number(),
          }),
        }),
        filters: zod.object({
          fc: zod.object({
            hoursUntilReplacement: zod.object({
              value: zod.number(),
            }),
          }),
          fg: zod.object({
            hoursUntilReplacement: zod.object({
              value: zod.number(),
            }),
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
  
    const poll_write_generation = this.write_generation;
    let parsed_data = undefined;
    try {
      const data = await this.platform.astarte.doRequest(this.device_info.id, ASTARTE_INTERFACE_HOOD_STATUS, AstarteRequestMethod.GET, {});
      if (this.isPollOutdated(poll_write_generation)) {
        return;
      }
      parsed_data = ResponseFormat.safeParse(data);
      if (!parsed_data.success) {
        this.platform.log.error('Failed to parse the hood status response', parsed_data.error, 'Received:', JSON.stringify(data));
        throw new UnknownResponseError;
      }
    } catch(error) {
      if (this.isPollOutdated(poll_write_generation)) {
        return;
      }
      if (error instanceof TokenExpiredError || error instanceof UnknownResponseError) {
        this.propagateHapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        this.polling_stopped = true;
      } else {
        // This sounds like a recoverable network error. No need to stop updating
        this.schedulePoll();
      }
      return;
    }

    // Track the reported state, so the next writes start from it (e.g. after the hood's own buttons were used).
    // When the light or fan is off, keep the last brightness or speed, so turning it back on restores it.
    const light_intensity = parsed_data!.data!.data.lights.channels[1].intensity.value;
    this.state.light.on = light_intensity > 0;
    if (this.state.light.on) {
      this.state.light.brightness = Math.round(mapRange(light_intensity, 0, this.max_light_intensity, 0, 100));
    }
    this.state.light.color_temperature = mapRange(parsed_data!.data!.data.lights.channels[2].intensity.value, 0, this.max_color_temperature_settings,
      this.min_color_temperature_mireds, this.max_color_temperature_mireds);
    const fan_speed = parsed_data!.data!.data.fan.speed.value;
    this.state.fan.active = fan_speed > 0;
    if (this.state.fan.active) {
      this.state.fan.speed = mapRange(fan_speed, 0, this.max_fan_speed, 0, 100);
    }

    // Brightness and speed are updated even when the light or fan is off: re-asserting the value
    // still clears any error status left behind by a failed write
    this.light_service.updateCharacteristic(this.platform.Characteristic.On, this.state.light.on);
    this.light_service.updateCharacteristic(this.platform.Characteristic.Brightness, this.state.light.brightness);
    this.light_service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, this.state.light.color_temperature);
    this.fan_service.updateCharacteristic(this.platform.Characteristic.Active,
      this.state.fan.active ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
    this.fan_service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.state.fan.speed);

    if (parsed_data!.data!.data.filters.fc.hoursUntilReplacement.value > 0) {
      this.carbon_filter_service.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication,
        this.platform.Characteristic.FilterChangeIndication.FILTER_OK);
      this.carbon_filter_service.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel,
        mapRange(parsed_data!.data!.data.filters.fc.hoursUntilReplacement.value, 0, this.max_carbon_filter_hours, 0, 100));
    } else {
      this.carbon_filter_service.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication,
        this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER);
      this.carbon_filter_service.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, 0);
    }

    if (parsed_data!.data!.data.filters.fg.hoursUntilReplacement.value > 0) {
      this.grease_filter_service.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication,
        this.platform.Characteristic.FilterChangeIndication.FILTER_OK);
      this.grease_filter_service.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel,
        mapRange(parsed_data!.data!.data.filters.fg.hoursUntilReplacement.value, 0, this.max_grease_filter_hours, 0, 100));
    } else {
      this.grease_filter_service.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication,
        this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER);
      this.grease_filter_service.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, 0);
    }

    this.schedulePoll();
  }

  public static async getDeviceFeatures(log: Logging, astarte: Astarte, device_id: string) {
    // TODO are any of these features optional?
    const FeaturesResponseFormat = zod.object({
      data: zod.object({
        filters: zod.object({
          fc: zod.object({
            replacementHours: zod.number(),
          }),
          fg: zod.object({
            replacementHours: zod.number(),
          }),
        }),
        lights: zod.object({
          channels: zod.object({
            1: zod.object({
              maxIntensity: zod.number(),
            }),
            2: zod.object({
              maxIntensity: zod.number(),
            }),
          }),
        }),
      }),
    });
    const feature_data = await astarte.doRequest(device_id, ASTARTE_INTERFACE_HOOD_FEATURES, AstarteRequestMethod.GET, {});
    const parsed_feature_data = FeaturesResponseFormat.safeParse(feature_data);
    if (!parsed_feature_data.success) {
      log.error('Failed to parse the device features response', parsed_feature_data.error, 'Received:', JSON.stringify(feature_data));
      throw new UnknownResponseError;
    }

    const MotorPropertiesResponseFormat = zod.object({
      data: zod.object({
        maxFanSpeed: zod.number(),
      }),
    });
    const motor_data = await astarte.doRequest(device_id, ASTARTE_INTERFACE_HOOD_MOTOR_PROPERTIES, AstarteRequestMethod.GET, {});
    const parsed_motor_data = MotorPropertiesResponseFormat.safeParse(motor_data);
    if (!parsed_motor_data.success) {
      log.error('Failed to parse the device motor properties response', parsed_motor_data.error, 'Received:', JSON.stringify(motor_data));
      throw new UnknownResponseError;
    }

    return { features: parsed_feature_data.data!.data, motor: parsed_motor_data.data!.data };
  }

  /**
   * Hold off polling until the write completes. Any poll already in flight will discard its result.
   * Writes can be nested; polling resumes once the outermost one completes.
   */
  private async pausePollingDuring(write: () => Promise<void>) {
    this.writes_in_flight++;
    this.write_generation++;
    clearTimeout(this.poll_timer);
    try {
      await write();
    } finally {
      // Resume polling after the last write. The hood reports its new state asynchronously,
      // so polling immediately would likely read the state from before the write
      this.writes_in_flight--;
      if (this.writes_in_flight === 0) {
        this.schedulePoll();
      }
    }
  }

  private async sendControlRequest(api_interface: string, data: Record<string, unknown>) {
    await this.pausePollingDuring(async () => {
      try {
        this.platform.log.debug('Sending:', api_interface, JSON.stringify(data));
        await this.platform.astarte.doRequest(
          this.device_info.id,
          ASTARTE_INTERFACE_HOOD_CONTROL + api_interface,
          AstarteRequestMethod.POST,
          data);
      } catch(error) {
        // The error has been logged already.
        if (error instanceof TokenExpiredError || error instanceof UnknownResponseError) {
          // These point at a problem with the account or the API rather than a network blip,
          // so mark the whole accessory as not responding
          this.propagateHapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        // Otherwise this sounds like a recoverable network error, so only this request failed.
        // The next successful status update clears the error from the characteristic.
        // In all cases, tell HomeKit the write failed, so the Home app doesn't show a state the hood isn't in
        throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });
  }

  /**
   * Convert a HomeKit percentage (e.g. brightness or fan speed) to one of the hood's discrete levels.
   * Any non-zero percentage maps to at least level 1, so a low percentage doesn't turn the light or fan off.
   */
  private percentageToLevel(percentage: number, max_level: number) {
    if (percentage <= 0) {
      return 0;
    }
    return Math.max(Math.round(mapRange(percentage, 0, 100, 0, max_level)), 1);
  }

  private getLightIntensity() {
    if (!this.state.light.on) {
      return 0;
    }
    // On, but the brightness can still be 0% (e.g. a new accessory, or the brightness was set to 0): use the lowest level
    return Math.max(this.percentageToLevel(this.state.light.brightness, this.max_light_intensity), 1);
  }

  private getColorTemperatureSetting() {
    return Math.round(mapRange(this.state.light.color_temperature,
      this.min_color_temperature_mireds, this.max_color_temperature_mireds, 0, this.max_color_temperature_settings));
  }

  private getFanSpeed() {
    if (!this.state.fan.active) {
      return 0;
    }
    // Active, but the speed can still be 0% (e.g. a new accessory, or the speed was set to 0): use the lowest speed
    return Math.max(this.percentageToLevel(this.state.fan.speed, this.max_fan_speed), 1);
  }

  // The handlers only record what HomeKit requested, then let the channel's writer send the resulting state.
  // They must record it before any `await`, so that the writer sees all the writes of a HomeKit request.

  async setLightOn(value: CharacteristicValue) {
    this.platform.log.debug('Turning light', value ? 'On': 'Off');
    this.state.light.on = value as boolean;
    await this.pausePollingDuring(() => this.light_writer.write());
  }

  async setLightBrightness(value: CharacteristicValue) {
    this.platform.log.debug('Setting light brightness to', value);
    this.state.light.brightness = value as number;
    // Setting a brightness also turns the light on (or off, for 0%)
    this.state.light.on = this.state.light.brightness > 0;
    await this.pausePollingDuring(() => this.light_writer.write());
  }

  async setColorTemperature(value: CharacteristicValue) {
    this.platform.log.debug('Setting color temperature to', value);
    this.state.light.color_temperature = value as number;
    await this.pausePollingDuring(() => this.color_temperature_writer.write());
  }

  async setFanActive(value: CharacteristicValue) {
    this.platform.log.debug('Turning fan', value === this.platform.Characteristic.Active.ACTIVE ? 'On': 'Off');
    this.state.fan.active = value === this.platform.Characteristic.Active.ACTIVE;
    await this.pausePollingDuring(() => this.fan_writer.write());
  }

  async setFanSpeed(value: CharacteristicValue) {
    this.platform.log.debug('Setting fan speed to', value);
    this.state.fan.speed = value as number;
    // Setting a speed also turns the fan on (or off, for 0%)
    this.state.fan.active = this.state.fan.speed > 0;
    await this.pausePollingDuring(() => this.fan_writer.write());
  }

  async resetCarbonFilter(_value: CharacteristicValue) {
    this.platform.log.debug('Resetting carbon filter');
    const post_data = {
      data: true,
    };
    await this.sendControlRequest('/filters/fc/resetCountdown', post_data);
  }

  async resetGreaseFilter(_value: CharacteristicValue) {
    this.platform.log.debug('Resetting grease filter');
    const post_data = {
      data: true,
    };
    await this.sendControlRequest('/filters/fg/resetCountdown', post_data);
  }
}