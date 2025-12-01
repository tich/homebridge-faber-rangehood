import { Logging, PlatformAccessory } from 'homebridge';
import zod from 'zod';
import { Astarte, AstarteRequestMethod } from '../api/astarte.js';
import { FaberHomebridgePlatform } from '../platform.js';
import { ASTARTE_INTERFACE_DEVICE_DETAILS } from '../api/constants.js';
import { UnknownDeviceTypeError, UnknownResponseError } from '../lib/errors.js';
import { RangeHoodDevice } from './rangehood.js';
import { BaseDevice } from './base.js';

/**
 * This helps us know when to discard device info from the accessory cache,
 * and compute it again. Bump it up whenever you make a change to the `DeviceInfo` interface
 */
export const INFO_VERSION = 2;

export interface DeviceInfo {
  info_version: number;
  model: string;
  astarte_type: string;
  id: string;
  name: string;
  features: Record<string, unknown>;
}

interface DeviceDescriptor {
  handler_class: typeof BaseDevice;
  default_name: string;
}

export class DeviceFactory {
  private static readonly AstarteTypeToDeviceDescriptor: Record<string, DeviceDescriptor> = {
    'HOOD': { handler_class: RangeHoodDevice, default_name: 'RangeHood' },
  };

  public static async getDeviceInfo(log: Logging, astarte: Astarte, device_id: string, device_name: string): Promise<DeviceInfo> {
    const ResponseFormat = zod.object({
      data: zod.object({
        modelLine: zod.string(),
        type: zod.string(),
      }),
    });
    const data = await astarte.doRequest(device_id, ASTARTE_INTERFACE_DEVICE_DETAILS, AstarteRequestMethod.GET, {});
    const parsed_data = ResponseFormat.safeParse(data);
    if (!parsed_data.success) {
      log.error('Failed to parse the device details response', parsed_data.error, 'Received:', JSON.stringify(data));
      throw new UnknownResponseError;
    }
    const deviceDescriptor = DeviceFactory.AstarteTypeToDeviceDescriptor[parsed_data.data.data.type];
    if (deviceDescriptor === undefined) {
      throw new UnknownDeviceTypeError;
    }
    const deviceFeatures = await deviceDescriptor.handler_class.getDeviceFeatures(log, astarte, device_id);
    if (!device_name) {
      device_name = deviceDescriptor.default_name;
    }
    return {
      info_version: INFO_VERSION,
      model: parsed_data.data.data.modelLine,
      astarte_type: parsed_data.data.data.type,
      id: device_id,
      name: device_name,
      features: deviceFeatures,
    };
  }

  public static constructDevice(platform: FaberHomebridgePlatform, accessory: PlatformAccessory) {
    const deviceDescriptor = DeviceFactory.AstarteTypeToDeviceDescriptor[accessory.context.device.astarte_type];
    return new deviceDescriptor.handler_class(platform, accessory);
  }
}