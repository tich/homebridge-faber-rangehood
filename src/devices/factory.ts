import { Logging, PlatformAccessory } from 'homebridge';
import zod from 'zod';
import { Astarte, AstarteRequestMethod } from '../api/astarte.js';
import { FaberHomebridgePlatform } from '../platform.js';
import { ASTARTE_INTERFACE_DEVICE_DETAILS } from '../api/constants.js';
import { UnknownResponseError } from '../lib/errors.js';
import { RangeHoodDevice } from './rangehood.js';

export class DeviceFactory {
  private static readonly AstarteTypeToDeviceKind: Record<string, string> = {
    'HOOD': 'RangeHood',
  };

  public static async getDeviceInfo(log: Logging, astarte: Astarte, device_id: string): Promise<{ model: string; kind: string; id: string; }> {
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
    let deviceKind = DeviceFactory.AstarteTypeToDeviceKind[parsed_data.data.data.type];
    if (deviceKind === undefined) {
      deviceKind = 'Unknown';
    }
    return { model: parsed_data.data.data.modelLine, kind: deviceKind, id: device_id };
  }

  public static constructDevice(platform: FaberHomebridgePlatform, accessory: PlatformAccessory) {
    switch(accessory.context.device.kind) {
    case 'RangeHood':
      return new RangeHoodDevice(platform, accessory);
    default:
      throw new Error('wtf');
    }
  }
}