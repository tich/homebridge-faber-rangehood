import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { err, ok, Result } from 'neverthrow';
import type { Astarte } from '../src/api/astarte.js';
import { DeviceFactory, INFO_VERSION } from '../src/devices/factory.js';
import { NetworkServiceError, UnknownDeviceTypeError, UnknownResponseError } from '../src/lib/errors.js';
import { createLog, FULL_FEATURES } from './helpers.js';

const DETAILS = 'com.faberspa.DeviceDetails';
const FEATURES = 'com.faberspa.connectedhood.Features';
const MOTOR = 'com.faberspa.connectedhood.MotorProperties';

/**
 * A fake cloud that replies to the device info requests, by interface. By default, like a fully featured hood
 */
function fakeAstarte(replies: Record<string, Result<unknown, NetworkServiceError>> = {}) {
  const all_replies: Record<string, Result<unknown, NetworkServiceError>> = {
    [DETAILS]: ok({ data: { modelLine: 'STRATUS ISOLA', type: 'HOOD' } }),
    [FEATURES]: ok({ data: FULL_FEATURES.features }),
    [MOTOR]: ok({ data: FULL_FEATURES.motor }),
    ...replies,
  };
  return { doRequest: async (_device_id: string, api_interface: string) => all_replies[api_interface] } as unknown as Astarte;
}

describe('DeviceFactory.getDeviceInfo', () => {
  test('fetches a hood\'s device info', async () => {
    const info = await DeviceFactory.getDeviceInfo(createLog().log, fakeAstarte(), 'PIN1', 'Kitchen Hood');
    const { firmware_revision, ...rest } = info._unsafeUnwrap();
    assert.deepEqual(rest, {
      info_version: INFO_VERSION, model: 'STRATUS ISOLA', astarte_type: 'HOOD', id: 'PIN1', name: 'Kitchen Hood', features: FULL_FEATURES,
    });
    // The plugin's version, since the cloud doesn't provide the hood's
    assert.match(firmware_revision, /^\d+\.\d+\.\d+$/);
  });

  test('names an unnamed device after its type', async () => {
    const info = await DeviceFactory.getDeviceInfo(createLog().log, fakeAstarte(), 'PIN1', '');
    assert.ok(info._unsafeUnwrap().name.length > 0);
  });

  for (const [label, replies, expected] of [
    ['the device details are malformed', { [DETAILS]: ok({ data: { type: 'HOOD' } }) }, UnknownResponseError],
    ['the device is of an unsupported type', { [DETAILS]: ok({ data: { modelLine: 'X', type: 'OVEN' } }) }, UnknownDeviceTypeError],
    ['the features are malformed', { [FEATURES]: ok({ data: { lights: { channels: { 1: {} } } } }) }, UnknownResponseError],
    ['the motor properties are malformed', { [MOTOR]: ok({ data: {} }) }, UnknownResponseError],
    ['the device details request fails', { [DETAILS]: err(new NetworkServiceError) }, NetworkServiceError],
    ['the features request fails', { [FEATURES]: err(new NetworkServiceError) }, NetworkServiceError],
    ['the motor properties request fails', { [MOTOR]: err(new NetworkServiceError) }, NetworkServiceError],
  ] as const) {
    test(`fails when ${label}`, async () => {
      const log = createLog();
      const info = await DeviceFactory.getDeviceInfo(log.log, fakeAstarte(replies), 'PIN1', 'Hood');
      assert.ok(info.isErr() && info.error.constructor === expected);
      if (expected === UnknownResponseError) {
        assert.match(log.at('error').join(), /Failed to parse the device/);
      }
    });
  }
});
