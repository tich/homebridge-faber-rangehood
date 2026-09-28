import { Logging, PlatformAccessory } from 'homebridge';
import zod from 'zod';
import { err, ok, Result } from 'neverthrow';
import { Astarte, AstarteRequestMethod } from '../api/astarte.js';
import { FaberHomebridgePlatform } from '../platform.js';
import { ASTARTE_INTERFACE_DEVICE_DETAILS } from '../api/constants.js';
import { InvalidCacheError, NetworkServiceError, UnknownDeviceTypeError, UnknownResponseError } from '../lib/errors.js';
import { RangeHoodDevice } from './rangehood.js';
import { BaseDevice } from './base.js';

/**
 * This helps us know when to discard device info from the accessory cache,
 * and compute it again. Bump it up whenever you make a change to the `DeviceInfo` interface,
 * or to what a device type stores in it (e.g. the features its `getDeviceFeatures` returns)
 */
export const INFO_VERSION = 3;

/**
 * The device info cached in an accessory's context. The features' format depends on the device type
 */
const CachedDeviceInfoFormat = zod.object({
  info_version: zod.literal(INFO_VERSION),
  model: zod.string(),
  astarte_type: zod.string(),
  id: zod.string(),
  name: zod.string(),
  features: zod.unknown(),
  firmware_revision: zod.string(),
});

export type DeviceInfo = zod.infer<typeof CachedDeviceInfoFormat>;

/**
 * What a device type must provide. Since TypeScript has no abstract static methods,
 * this is how the compiler makes sure that every device type implements them.
 */
export interface DeviceClass {
  new (platform: FaberHomebridgePlatform, accessory: PlatformAccessory): BaseDevice;

  /** Fetch the features the device supports, to store in its device info */
  getDeviceFeatures(log: Logging, astarte: Astarte, device_id: string): Promise<Result<unknown, NetworkServiceError>>;

  /** Get the device's firmware version, in HomeKit's numeric "x[.y[.z]]" format */
  getFirmwareRevision(log: Logging, astarte: Astarte, device_id: string): Promise<Result<string, NetworkServiceError>>;

  /** Validate the features from a cached device info, as returned by `getDeviceFeatures` */
  parseCachedFeatures(features: unknown): Result<unknown, InvalidCacheError>;
}

interface DeviceDescriptor {
  handler_class: DeviceClass;
  default_name: string;
}

export class DeviceFactory {
  private static readonly AstarteTypeToDeviceDescriptor = new Map<string, DeviceDescriptor>([
    ['HOOD', { handler_class: RangeHoodDevice, default_name: 'RangeHood' }],
  ]);

  private static getDeviceDescriptor(astarte_type: string): Result<DeviceDescriptor, UnknownDeviceTypeError> {
    const descriptor = DeviceFactory.AstarteTypeToDeviceDescriptor.get(astarte_type);
    return descriptor ? ok(descriptor) : err(new UnknownDeviceTypeError(`Unsupported device type: ${astarte_type}`));
  }

  /**
   * Fetch everything the plugin needs to know about a device
   * @returns The device info, or an error:
   * - `UnknownDeviceTypeError` if the device isn't of a type the plugin supports
   * - Any error from `Astarte.doRequest`
   */
  public static async getDeviceInfo(log: Logging, astarte: Astarte, device_id: string, device_name: string)
    : Promise<Result<DeviceInfo, NetworkServiceError | UnknownDeviceTypeError>> {
    const ResponseFormat = zod.object({
      data: zod.object({
        modelLine: zod.string(),
        type: zod.string(),
      }),
    });
    const data = await astarte.doRequest(device_id, ASTARTE_INTERFACE_DEVICE_DETAILS, AstarteRequestMethod.GET, {});
    if (data.isErr()) {
      return err(data.error);
    }
    const parsed_data = ResponseFormat.safeParse(data.value);
    if (!parsed_data.success) {
      log.error('Failed to parse the device details response', parsed_data.error, 'Received:', JSON.stringify(data.value));
      return err(new UnknownResponseError);
    }
    const descriptor = DeviceFactory.getDeviceDescriptor(parsed_data.data.data.type);
    if (descriptor.isErr()) {
      return err(descriptor.error);
    }
    const deviceDescriptor = descriptor.value;
    const deviceFeatures = await deviceDescriptor.handler_class.getDeviceFeatures(log, astarte, device_id);
    if (deviceFeatures.isErr()) {
      return err(deviceFeatures.error);
    }
    const firmwareRevision = await deviceDescriptor.handler_class.getFirmwareRevision(log, astarte, device_id);
    if (firmwareRevision.isErr()) {
      return err(firmwareRevision.error);
    }
    if (!device_name) {
      device_name = deviceDescriptor.default_name;
    }
    return ok({
      info_version: INFO_VERSION,
      model: parsed_data.data.data.modelLine,
      astarte_type: parsed_data.data.data.type,
      id: device_id,
      name: device_name,
      features: deviceFeatures.value,
      firmware_revision: firmwareRevision.value,
    });
  }

  /**
   * Validate the device info cached in an accessory's context
   * @returns The device info, or an error:
   * - `InvalidCacheError` if it's malformed, or from an older version of the plugin (see `INFO_VERSION`)
   * - `UnknownDeviceTypeError` if it's for a device type the plugin doesn't support
   */
  public static parseCachedDeviceInfo(cached: unknown): Result<DeviceInfo, InvalidCacheError | UnknownDeviceTypeError> {
    const parsed = CachedDeviceInfoFormat.safeParse(cached);
    if (!parsed.success) {
      return err(new InvalidCacheError(zod.prettifyError(parsed.error)));
    }
    return DeviceFactory.getDeviceDescriptor(parsed.data.astarte_type)
      .andThen((descriptor) => descriptor.handler_class.parseCachedFeatures(parsed.data.features))
      .map((features) => ({ ...parsed.data, features }));
  }

  /**
   * Create the handler for an accessory, from the device info in its context
   * (either freshly fetched with `getDeviceInfo`, or validated with `parseCachedDeviceInfo`)
   */
  public static constructDevice(platform: FaberHomebridgePlatform, accessory: PlatformAccessory): Result<BaseDevice, UnknownDeviceTypeError> {
    const device_info: DeviceInfo = accessory.context.device;
    return DeviceFactory.getDeviceDescriptor(device_info.astarte_type)
      .map((descriptor) => new descriptor.handler_class(platform, accessory));
  }
}
