import { Logging, PlatformAccessory } from 'homebridge';
import zod from 'zod';
import { Astarte, AstarteRequestMethod } from '../api/astarte.js';
import { FaberHomebridgePlatform } from '../platform.js';
import { ASTARTE_INTERFACE_DEVICE_DETAILS } from '../api/constants.js';
import { UnknownDeviceTypeError, UnknownResponseError } from '../lib/errors.js';
import { RangeHoodDevice } from './rangehood.js';
import { BaseDevice } from './base.js';

export const INFO_VERSION = 1;

export interface DeviceInfo {
  info_version: number;
  model: string;
  kind: string;
  id: string;
  features: Record<string, unknown>;
}

export class DeviceFactory {
  private static readonly AstarteTypeToDeviceKind: Record<string, string> = {
    'HOOD': 'RangeHood',
  };

  private static readonly DeviceKindToClass: Record<string, typeof BaseDevice> = {
    'RangeHood': RangeHoodDevice,
  };

  public static async getDeviceInfo(log: Logging, astarte: Astarte, device_id: string): Promise<DeviceInfo> {
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
    const deviceKind = DeviceFactory.AstarteTypeToDeviceKind[parsed_data.data.data.type];
    if (deviceKind === undefined) {
      throw new UnknownDeviceTypeError;
    }
    const deviceClass = DeviceFactory.DeviceKindToClass[deviceKind!];
    const deviceFeatures = await deviceClass.getDeviceFeatures(log, astarte, device_id);
    return { info_version: INFO_VERSION, model: parsed_data.data.data.modelLine, kind: deviceKind!, id: device_id, features: deviceFeatures };
  }

  public static constructDevice(platform: FaberHomebridgePlatform, accessory: PlatformAccessory) {
    const deviceClass = DeviceFactory.DeviceKindToClass[accessory.context.device.kind];
    return new deviceClass(platform, accessory);
  }
}