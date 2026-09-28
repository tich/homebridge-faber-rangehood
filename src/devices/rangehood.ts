import { CharacteristicValue, HAPStatus, Logging, PlatformAccessory, Service } from 'homebridge';
import zod from 'zod';
import { err, ok, Result } from 'neverthrow';
import { FaberHomebridgePlatform } from '../platform.js';
import { BaseDevice } from './base.js';
import { Astarte, AstarteRequestMethod } from '../api/astarte.js';
import {
  ASTARTE_INTERFACE_HOOD_CONTROL,
  ASTARTE_INTERFACE_HOOD_FEATURES,
  ASTARTE_INTERFACE_HOOD_MOTOR_PROPERTIES,
  ASTARTE_INTERFACE_HOOD_STATUS }
  from '../api/constants.js';
import { DeadlineExceededError, InvalidCacheError, NetworkServiceError, TokenExpiredError, UnknownResponseError } from '../lib/errors.js';
import { mapRange } from '../lib/utils.js';
import { ChannelWriter } from '../lib/channelwriter.js';
import { PLUGIN_VERSION } from '../settings.js';

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

/**
 * What the hood supports, as derived from its device features. An `undefined` feature isn't supported.
 */
interface HoodCapabilities {
  max_fan_speed: number;
  max_light_intensity?: number;
  max_color_temperature_setting?: number;
  carbon_filter_hours?: number;
  grease_filter_hours?: number;
}

// Everything is optional, since not every hood has every feature. See `getCapabilities`
const FeaturesResponseFormat = zod.object({
  data: zod.object({
    filters: zod.object({
      fc: zod.object({
        replacementHours: zod.number(),
      }).optional(),
      fg: zod.object({
        replacementHours: zod.number(),
      }).optional(),
    }).optional(),
    lights: zod.object({
      channels: zod.object({
        1: zod.object({
          maxIntensity: zod.number(),
        }).optional(),
        2: zod.object({
          maxIntensity: zod.number(),
        }).optional(),
      }),
      tunableWhite: zod.object({
        enabled: zod.boolean(),
      }).optional(),
    }).optional(),
  }),
});

const MotorPropertiesResponseFormat = zod.object({
  data: zod.object({
    maxFanSpeed: zod.number(),
  }),
});

/**
 * The features stored in a hood's device info
 */
const HoodFeaturesFormat = zod.object({
  features: FeaturesResponseFormat.shape.data,
  motor: MotorPropertiesResponseFormat.shape.data,
});

type HoodFeatures = zod.infer<typeof HoodFeaturesFormat>;

export class RangeHoodDevice extends BaseDevice {
  private readonly capabilities: HoodCapabilities;
  private readonly fan_service: Service;
  private readonly light_service?: Service;
  private readonly carbon_filter_service?: Service;
  private readonly grease_filter_service?: Service;

  private readonly refresh_interval_ms = 3 * 1000;
  // How long a command from HomeKit may take. HAP-NodeJS gives up on a write handler after 9 seconds,
  // and reports a timeout instead of our error, so give up just before that.
  private readonly write_deadline_ms = 8 * 1000;
  // While polls keep failing with network errors (e.g. during an internet outage), the interval between them
  // doubles with each failure, up to this maximum. This avoids hammering the API and flooding the logs.
  private readonly max_refresh_interval_ms = 5 * 60 * 1000;
  private consecutive_poll_failures = 0;

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

  // HomeKit's color temperature is in mireds (1,000,000 / Kelvin), so the coolest light has the lowest value.
  // The hood's manual specifies a 2700K - 6500K range. Color temperature setting 0 is the coolest.
  private readonly min_color_temperature_mireds = 154; // 6500K
  private readonly max_color_temperature_mireds = 370; // 2700K

  constructor(
    platform: FaberHomebridgePlatform,
    accessory: PlatformAccessory,
  ) {
    super(platform, accessory);

    // TODO Adaptive Lighting support? https://github.com/homebridge-plugins/homebridge-meross/blob/latest/lib/device/light-cct.js#L97

    // The features were validated when the device info was built (see `getDeviceFeatures` and `parseCachedFeatures`)
    this.capabilities = RangeHoodDevice.getCapabilities(this.device_info.features as HoodFeatures);

    // Only expose what the hood supports. Services and characteristics for unsupported features are removed,
    // in case they were created by an earlier version of the plugin that exposed everything.
    const cached_light_service = this.accessory.getService(this.platform.Service.Lightbulb);
    if (this.capabilities.max_light_intensity !== undefined) {
      // Get the LightBulb service if it exists, otherwise create a new LightBulb service
      this.light_service = cached_light_service || this.accessory.addService(this.platform.Service.Lightbulb);

      // The light's default name is "<name> Light" (e.g. "RangeHood Light")
      this.setServiceName(this.light_service, this.device_info.name + ' Light');

      // register handlers for the light's characteristics
      this.light_service.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setLightOn.bind(this));
      this.light_service.getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(this.setLightBrightness.bind(this));

      if (this.capabilities.max_color_temperature_setting !== undefined) {
        this.light_service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
          .onSet(this.setColorTemperature.bind(this))
          .setProps({
            minValue: this.min_color_temperature_mireds,
            maxValue: this.max_color_temperature_mireds,
            // Snap the slider to the hood's discrete color temperature settings
            minStep: (this.max_color_temperature_mireds - this.min_color_temperature_mireds) / this.capabilities.max_color_temperature_setting,
          });
      } else if (this.light_service.testCharacteristic(this.platform.Characteristic.ColorTemperature)) {
        this.platform.log.info('Removing the unsupported light color temperature from', this.device_info.name);
        this.light_service.removeCharacteristic(this.light_service.getCharacteristic(this.platform.Characteristic.ColorTemperature));
      }
    } else if (cached_light_service) {
      this.platform.log.info('Removing the unsupported light from', this.device_info.name);
      this.accessory.removeService(cached_light_service);
    }

    this.fan_service = this.accessory.getService(this.platform.Service.Fanv2) || this.accessory.addService(this.platform.Service.Fanv2);
    this.setServiceName(this.fan_service, this.device_info.name + ' Fan');

    this.fan_service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setFanActive.bind(this));
    this.fan_service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setFanSpeed.bind(this))
      .setProps({ minStep: 100 / this.capabilities.max_fan_speed });

    this.carbon_filter_service = this.setUpFilterService('Carbon', ' Carbon Filter',
      this.capabilities.carbon_filter_hours, this.resetCarbonFilter.bind(this));
    this.grease_filter_service = this.setUpFilterService('Grease', ' Grease Filter',
      this.capabilities.grease_filter_hours, this.resetGreaseFilter.bind(this));

    // Start from the last known state, as restored from the accessory cache
    this.state = {
      light: {
        on: false,
        brightness: 0,
        color_temperature: this.min_color_temperature_mireds,
      },
      fan: {
        active: this.fan_service.getCharacteristic(this.platform.Characteristic.Active).value === this.platform.Characteristic.Active.ACTIVE,
        speed: this.fan_service.getCharacteristic(this.platform.Characteristic.RotationSpeed).value as number,
      },
    };
    if (this.light_service) {
      this.state.light.on = this.light_service.getCharacteristic(this.platform.Characteristic.On).value as boolean;
      this.state.light.brightness = this.light_service.getCharacteristic(this.platform.Characteristic.Brightness).value as number;
      if (this.capabilities.max_color_temperature_setting !== undefined) {
        this.state.light.color_temperature = this.light_service.getCharacteristic(this.platform.Characteristic.ColorTemperature).value as number;
      }
    }

    this.light_writer = new ChannelWriter(
      () => this.getLightIntensity(),
      (intensity, signal) => this.sendToChannel('/lights/channels/1/intensity', intensity, signal));
    this.color_temperature_writer = new ChannelWriter(
      () => this.getColorTemperatureSetting(),
      (setting, signal) => this.sendToChannel('/lights/channels/2/intensity', setting, signal));
    this.fan_writer = new ChannelWriter(
      () => this.getFanSpeed(),
      (speed, signal) => this.sendToChannel('/fan/speed', speed, signal));

    this.schedulePoll();
  }

  /**
   * Work out what the hood supports from its device features.
   * A feature the hood doesn't report, or reports with a zero maximum, is treated as unsupported.
   */
  private static getCapabilities(features: HoodFeatures): HoodCapabilities {
    const positive = (value?: number) => value !== undefined && value > 0 ? value : undefined;
    const max_light_intensity = positive(features.features.lights?.channels[1]?.maxIntensity);
    return {
      max_fan_speed: features.motor.maxFanSpeed,
      max_light_intensity,
      // Color temperature is the light's second channel, when the hood reports its tunable white feature as enabled
      max_color_temperature_setting: max_light_intensity !== undefined && features.features.lights?.tunableWhite?.enabled
        ? positive(features.features.lights.channels[2]?.maxIntensity)
        : undefined,
      carbon_filter_hours: positive(features.features.filters?.fc?.replacementHours),
      grease_filter_hours: positive(features.features.filters?.fg?.replacementHours),
    };
  }

  /**
   * Get or create a filter's service if the hood has that filter, otherwise remove any cached one
   * @returns The filter's service, or `undefined` if the hood doesn't have that filter
   */
  private setUpFilterService(subtype: string, name_suffix: string, replacement_hours: number | undefined,
    onReset: (value: CharacteristicValue) => Promise<void>) {
    const cached_service = this.accessory.getServiceById(this.platform.Service.FilterMaintenance, subtype);
    if (replacement_hours === undefined) {
      if (cached_service) {
        this.platform.log.info('Removing the unsupported' + name_suffix.toLowerCase(), 'from', this.device_info.name);
        this.accessory.removeService(cached_service);
      }
      return undefined;
    }

    const service = cached_service
      || this.accessory.addService(new this.platform.Service.FilterMaintenance(this.device_info.name + name_suffix, subtype));
    this.setServiceName(service, this.device_info.name + name_suffix);
    service.getCharacteristic(this.platform.Characteristic.ResetFilterIndication)
      .onSet(onReset);
    return service;
  }

  public override shutdown() {
    // Any poll or write still in flight completes, but doesn't schedule another poll
    this.polling_stopped = true;
    clearTimeout(this.poll_timer);
  }

  /**
   * Schedule the next status poll, replacing any poll that's already scheduled
   */
  private schedulePoll() {
    clearTimeout(this.poll_timer);
    if (this.polling_stopped) {
      return;
    }
    const delay_ms = Math.min(this.refresh_interval_ms * 2 ** this.consecutive_poll_failures, this.max_refresh_interval_ms);
    this.poll_timer = setTimeout(() => this.updateHoodStatus(), delay_ms);
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
    const error = new this.platform.api.hap.HapStatusError(hapStatus);
    this.light_service?.updateCharacteristic(this.platform.Characteristic.On, error);
    this.light_service?.updateCharacteristic(this.platform.Characteristic.Brightness, error);
    if (this.capabilities.max_color_temperature_setting !== undefined) {
      this.light_service?.updateCharacteristic(this.platform.Characteristic.ColorTemperature, error);
    }

    this.fan_service.updateCharacteristic(this.platform.Characteristic.Active, error);
    this.fan_service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, error);

    this.carbon_filter_service?.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication, error);
    this.carbon_filter_service?.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, error);

    this.grease_filter_service?.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication, error);
    this.grease_filter_service?.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, error);
  }

  private async updateHoodStatus() {
    const Intensity = zod.object({
      intensity: zod.object({
        value: zod.number(),
      }),
    });
    const HoursUntilReplacement = zod.object({
      hoursUntilReplacement: zod.object({
        value: zod.number(),
      }),
    });
    // Everything but the fan is optional, since not every hood has every feature
    const ResponseFormat = zod.object({
      data: zod.object({
        fan: zod.object({
          speed: zod.object({
            value: zod.number(),
          }),
        }),
        filters: zod.object({
          fc: HoursUntilReplacement.optional(),
          fg: HoursUntilReplacement.optional(),
        }).optional(),
        lights: zod.object({
          channels: zod.object({
            1: Intensity.optional(),
            2: Intensity.optional(),
          }),
        }).optional(),
      }),
    });

    const poll_write_generation = this.write_generation;
    const data = await this.platform.astarte.doRequest(this.device_info.id, ASTARTE_INTERFACE_HOOD_STATUS, AstarteRequestMethod.GET, {});
    if (this.isPollOutdated(poll_write_generation)) {
      return;
    }
    const parsed_status = data.andThen((value) => {
      const parsed_data = ResponseFormat.safeParse(value);
      if (!parsed_data.success) {
        this.platform.log.error('Failed to parse the hood status response', parsed_data.error, 'Received:', JSON.stringify(value));
        return err(new UnknownResponseError);
      }
      return ok(parsed_data.data.data);
    });
    if (parsed_status.isErr()) {
      if (parsed_status.error instanceof TokenExpiredError || parsed_status.error instanceof UnknownResponseError) {
        this.propagateHapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        this.polling_stopped = true;
      } else {
        // This sounds like a recoverable network error. Keep polling, but back off until it recovers
        if (this.consecutive_poll_failures === 0) {
          this.platform.log.warn('Lost connection to', this.device_info.name + '. Retrying less often until it recovers');
        }
        this.consecutive_poll_failures++;
        this.schedulePoll();
      }
      return;
    }
    const status = parsed_status.value;

    if (this.consecutive_poll_failures > 0) {
      this.platform.log.info('Reconnected to', this.device_info.name);
      this.consecutive_poll_failures = 0;
    }

    // Track the reported state, so the next writes start from it (e.g. after the hood's own buttons were used).
    // When the light or fan is off, keep the last brightness or speed, so turning it back on restores it.
    const light_intensity = status.lights?.channels[1]?.intensity.value;
    if (this.capabilities.max_light_intensity !== undefined && light_intensity !== undefined) {
      this.state.light.on = light_intensity > 0;
      if (this.state.light.on) {
        this.state.light.brightness = Math.round(mapRange(light_intensity, 0, this.capabilities.max_light_intensity, 0, 100));
      }
    }
    const color_temperature_setting = status.lights?.channels[2]?.intensity.value;
    if (this.capabilities.max_color_temperature_setting !== undefined && color_temperature_setting !== undefined) {
      this.state.light.color_temperature = mapRange(color_temperature_setting, 0, this.capabilities.max_color_temperature_setting,
        this.min_color_temperature_mireds, this.max_color_temperature_mireds);
    }
    const fan_speed = status.fan.speed.value;
    this.state.fan.active = fan_speed > 0;
    if (this.state.fan.active) {
      this.state.fan.speed = mapRange(fan_speed, 0, this.capabilities.max_fan_speed, 0, 100);
    }

    // Brightness and speed are updated even when the light or fan is off: re-asserting the value
    // still clears any error status left behind by a failed write
    if (this.light_service) {
      this.light_service.updateCharacteristic(this.platform.Characteristic.On, this.state.light.on);
      this.light_service.updateCharacteristic(this.platform.Characteristic.Brightness, this.state.light.brightness);
      if (this.capabilities.max_color_temperature_setting !== undefined) {
        this.light_service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, this.state.light.color_temperature);
      }
    }
    this.fan_service.updateCharacteristic(this.platform.Characteristic.Active,
      this.state.fan.active ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
    this.fan_service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.state.fan.speed);

    this.updateFilterStatus(this.carbon_filter_service, status.filters?.fc?.hoursUntilReplacement.value, this.capabilities.carbon_filter_hours);
    this.updateFilterStatus(this.grease_filter_service, status.filters?.fg?.hoursUntilReplacement.value, this.capabilities.grease_filter_hours);

    this.schedulePoll();
  }

  private updateFilterStatus(filter_service: Service | undefined, hours_until_replacement: number | undefined, replacement_hours?: number) {
    if (!filter_service || hours_until_replacement === undefined || replacement_hours === undefined) {
      return;
    }
    if (hours_until_replacement > 0) {
      filter_service.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication,
        this.platform.Characteristic.FilterChangeIndication.FILTER_OK);
      filter_service.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel,
        mapRange(hours_until_replacement, 0, replacement_hours, 0, 100));
    } else {
      filter_service.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication,
        this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER);
      filter_service.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, 0);
    }
  }

  public static async getDeviceFeatures(log: Logging, astarte: Astarte, device_id: string): Promise<Result<HoodFeatures, NetworkServiceError>> {
    const feature_data = await astarte.doRequest(device_id, ASTARTE_INTERFACE_HOOD_FEATURES, AstarteRequestMethod.GET, {});
    if (feature_data.isErr()) {
      return err(feature_data.error);
    }
    const parsed_feature_data = FeaturesResponseFormat.safeParse(feature_data.value);
    if (!parsed_feature_data.success) {
      log.error('Failed to parse the device features response', parsed_feature_data.error, 'Received:', JSON.stringify(feature_data.value));
      return err(new UnknownResponseError);
    }

    const motor_data = await astarte.doRequest(device_id, ASTARTE_INTERFACE_HOOD_MOTOR_PROPERTIES, AstarteRequestMethod.GET, {});
    if (motor_data.isErr()) {
      return err(motor_data.error);
    }
    const parsed_motor_data = MotorPropertiesResponseFormat.safeParse(motor_data.value);
    if (!parsed_motor_data.success) {
      log.error('Failed to parse the device motor properties response', parsed_motor_data.error, 'Received:', JSON.stringify(motor_data.value));
      return err(new UnknownResponseError);
    }

    return ok({ features: parsed_feature_data.data.data, motor: parsed_motor_data.data.data });
  }

  public static parseCachedFeatures(features: unknown): Result<HoodFeatures, InvalidCacheError> {
    const parsed = HoodFeaturesFormat.safeParse(features);
    return parsed.success ? ok(parsed.data) : err(new InvalidCacheError(zod.prettifyError(parsed.error)));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public static async getFirmwareRevision(log: Logging, astarte: Astarte, device_id: string): Promise<Result<string, NetworkServiceError>> {
    // The hood's firmware version isn't available from the cloud API, so report the plugin's version instead.
    // HomeKit expects a numeric "x[.y[.z]]" version, so drop any pre-release suffix (e.g. "-beta.1")
    return ok(PLUGIN_VERSION.split('-')[0]);
  }

  /**
   * Hold off polling until the write completes. Any poll already in flight will discard its result.
   * Writes can be nested; polling resumes once the outermost one completes.
   */
  private async pausePollingDuring<T>(write: () => Promise<T>): Promise<T> {
    this.writes_in_flight++;
    this.write_generation++;
    clearTimeout(this.poll_timer);
    try {
      return await write();
    } finally {
      // Resume polling after the last write. The hood reports its new state asynchronously,
      // so polling immediately would likely read the state from before the write
      this.writes_in_flight--;
      if (this.writes_in_flight === 0) {
        this.schedulePoll();
      }
    }
  }

  private async sendControlRequest(api_interface: string, data: Record<string, unknown>, signal: AbortSignal)
    : Promise<Result<void, NetworkServiceError>> {
    return await this.pausePollingDuring(async () => {
      this.platform.log.debug('Sending:', api_interface, JSON.stringify(data));
      const result = await this.platform.astarte.doRequest(
        this.device_info.id,
        ASTARTE_INTERFACE_HOOD_CONTROL + api_interface,
        AstarteRequestMethod.POST,
        data,
        signal);
      if (result.isErr() && (result.error instanceof TokenExpiredError || result.error instanceof UnknownResponseError)) {
        // These point at a problem with the account or the API rather than a network blip,
        // so mark the whole accessory as not responding
        this.propagateHapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      // Otherwise this sounds like a recoverable network error, so only this request failed.
      // The next successful status update clears the error from the characteristic.
      return result.map(() => undefined);
    });
  }

  /**
   * Convert an error into what a characteristic's write handler should throw, telling HomeKit that the write failed,
   * so the Home app doesn't show a state the hood isn't in.
   * This is where Results meet HAP-NodeJS, which expects a write handler to throw a HapStatusError.
   */
  private toHapStatusError(error: unknown) {
    // Other errors have been logged already
    if (error instanceof DeadlineExceededError) {
      this.platform.log.warn('A command to', this.device_info.name, 'didn\'t complete within', this.write_deadline_ms / 1000, 'seconds');
    }
    return new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  /**
   * Send a channel's latest requested state, from a characteristic's write handler
   */
  private async writeChannel(writer: ChannelWriter<number>) {
    await this.pausePollingDuring(async () => {
      try {
        await writer.write(this.write_deadline_ms);
      } catch (error) {
        throw this.toHapStatusError(error);
      }
    });
  }

  /**
   * Send a value to a channel, for a ChannelWriter, which expects a failed send to throw
   */
  private async sendToChannel(api_interface: string, value: number, signal: AbortSignal) {
    const result = await this.sendControlRequest(api_interface, { data: value }, signal);
    if (result.isErr()) {
      throw result.error;
    }
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

  // The light and color temperature writers are only used by handlers that are registered when the hood supports them

  private getLightIntensity() {
    if (!this.state.light.on) {
      return 0;
    }
    // On, but the brightness can still be 0% (e.g. a new accessory, or the brightness was set to 0): use the lowest level
    return Math.max(this.percentageToLevel(this.state.light.brightness, this.capabilities.max_light_intensity!), 1);
  }

  private getColorTemperatureSetting() {
    return Math.round(mapRange(this.state.light.color_temperature,
      this.min_color_temperature_mireds, this.max_color_temperature_mireds, 0, this.capabilities.max_color_temperature_setting!));
  }

  private getFanSpeed() {
    if (!this.state.fan.active) {
      return 0;
    }
    // Active, but the speed can still be 0% (e.g. a new accessory, or the speed was set to 0): use the lowest speed
    return Math.max(this.percentageToLevel(this.state.fan.speed, this.capabilities.max_fan_speed), 1);
  }

  // The handlers only record what HomeKit requested, then let the channel's writer send the resulting state.
  // They must record it before any `await`, so that the writer sees all the writes of a HomeKit request.

  async setLightOn(value: CharacteristicValue) {
    this.platform.log.debug('Turning light', value ? 'On': 'Off');
    this.state.light.on = value as boolean;
    await this.writeChannel(this.light_writer);
  }

  async setLightBrightness(value: CharacteristicValue) {
    this.platform.log.debug('Setting light brightness to', value);
    this.state.light.brightness = value as number;
    // Setting a brightness also turns the light on (or off, for 0%)
    this.state.light.on = this.state.light.brightness > 0;
    await this.writeChannel(this.light_writer);
  }

  async setColorTemperature(value: CharacteristicValue) {
    this.platform.log.debug('Setting color temperature to', value);
    this.state.light.color_temperature = value as number;
    await this.writeChannel(this.color_temperature_writer);
  }

  async setFanActive(value: CharacteristicValue) {
    this.platform.log.debug('Turning fan', value === this.platform.Characteristic.Active.ACTIVE ? 'On': 'Off');
    this.state.fan.active = value === this.platform.Characteristic.Active.ACTIVE;
    await this.writeChannel(this.fan_writer);
  }

  async setFanSpeed(value: CharacteristicValue) {
    this.platform.log.debug('Setting fan speed to', value);
    this.state.fan.speed = value as number;
    // Setting a speed also turns the fan on (or off, for 0%)
    this.state.fan.active = this.state.fan.speed > 0;
    await this.writeChannel(this.fan_writer);
  }

  // The filter reset handlers are only registered when the hood has that filter

  async resetCarbonFilter(_value: CharacteristicValue) {
    this.platform.log.debug('Resetting carbon filter');
    const post_data = {
      data: true,
    };
    const result = await this.sendControlRequest('/filters/fc/resetCountdown', post_data, AbortSignal.timeout(this.write_deadline_ms));
    if (result.isErr()) {
      throw this.toHapStatusError(result.error);
    }
    this.resetFilterStatus(this.carbon_filter_service!);
  }

  async resetGreaseFilter(_value: CharacteristicValue) {
    this.platform.log.debug('Resetting grease filter');
    const post_data = {
      data: true,
    };
    const result = await this.sendControlRequest('/filters/fg/resetCountdown', post_data, AbortSignal.timeout(this.write_deadline_ms));
    if (result.isErr()) {
      throw this.toHapStatusError(result.error);
    }
    this.resetFilterStatus(this.grease_filter_service!);
  }

  /**
   * Show a successfully reset filter as new.
   *
   * When HomeKit writes a characteristic like Brightness, HAP-NodeJS stores the written value once the write succeeds,
   * so the Home app shows the new state right away. A filter reset is different: HomeKit writes the write-only
   * ResetFilterIndication trigger, while the Home app displays FilterChangeIndication and FilterLifeLevel, which nothing
   * writes. Without this, the Home app would keep asking for the filter to be replaced until the next poll picks up
   * the reset countdown.
   */
  private resetFilterStatus(filter_service: Service) {
    filter_service.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication,
      this.platform.Characteristic.FilterChangeIndication.FILTER_OK);
    filter_service.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, 100);
  }
}
