import { afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { API, PlatformAccessory, PlatformConfig } from 'homebridge';
// The HAP implementation Homebridge uses (and so its PlatformAccessory does too)
import { Characteristic, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import { err, ok, Result } from 'neverthrow';
import { FaberHomebridgePlatform } from '../src/platform.js';
import { DeviceFactory, INFO_VERSION } from '../src/devices/factory.js';
import { NetworkServiceError, RequestRejectedError, TokenExpiredError } from '../src/lib/errors.js';
import { advance, createLog, flush, FULL_FEATURES, loadPlatformAccessory, TestLog, useFakeTime } from './helpers.js';

let PlatformAccessoryClass: typeof PlatformAccessory;
before(async () => PlatformAccessoryClass = await loadPlatformAccessory());

const CONFIG = { platform: 'FaberRangeHood', auth_mode: 'token', refresh_token: 'RT' };

/**
 * A platform, with a fake Homebridge API, a fake cloud, and a fake push channel
 */
function createPlatform(config: Record<string, unknown>, options: {
  storage_path?: string;
  cached?: Record<string, Record<string, unknown>>; // Cached accessories, by device ID: their context's device info
  devices_in_account?: string[];
} = {}) {
  const log: TestLog = createLog();
  const handlers: Record<string, () => unknown> = {};
  const registered: PlatformAccessory[] = [];
  const updated: string[] = [];
  const unregistered: string[] = [];
  const api = {
    hap: { Service, Characteristic, uuid, HapStatusError },
    platformAccessory: PlatformAccessoryClass,
    user: { storagePath: () => options.storage_path! },
    on: (event: string, handler: () => unknown) => handlers[event] = handler,
    registerPlatformAccessories: (_plugin: string, _platform: string, accessories: PlatformAccessory[]) => registered.push(...accessories),
    updatePlatformAccessories: (accessories: PlatformAccessory[]) => updated.push(...accessories.map((a) => a.context.device.id)),
    unregisterPlatformAccessories: (_plugin: string, _platform: string, accessories: PlatformAccessory[]) =>
      unregistered.push(...accessories.map((a) => a.displayName)),
  };
  const platform = new FaberHomebridgePlatform(log.log, config as PlatformConfig, api as unknown as API);

  for (const [id, device] of Object.entries(options.cached ?? {})) {
    const accessory = new PlatformAccessoryClass(`Cached ${id}`, uuid.generate(id));
    accessory.context.device = device;
    platform.configureAccessory(accessory);
  }

  // The fake cloud
  const cloud = {
    init: (): Result<void, NetworkServiceError> => ok(),
    device_info_error: {} as Record<string, NetworkServiceError>,
    inits: 0,
    device_info_requests: {} as Record<string, number>,
  };
  mock.method(platform.astarte, 'init', async () => {
    cloud.inits++;
    return cloud.init();
  });
  mock.method(platform.astarte, 'getDevices', () => options.devices_in_account ?? ['PIN1']);
  mock.method(platform.astarte, 'doRequest', async (device_id: string, api_interface: string) => {
    if (api_interface.endsWith('HoodStatus')) {
      return new Promise(() => {}); // Status polls aren't tested here
    }
    if (api_interface.endsWith('DeviceDetails')) {
      cloud.device_info_requests[device_id] = (cloud.device_info_requests[device_id] ?? 0) + 1;
      if (cloud.device_info_error[device_id]) {
        return err(cloud.device_info_error[device_id]);
      }
      return ok({ data: { modelLine: 'STRATUS ISOLA', type: 'HOOD' } });
    }
    if (api_interface.endsWith('MotorProperties')) {
      return ok({ data: FULL_FEATURES.motor });
    }
    return ok({ data: FULL_FEATURES.features });
  });
  const channel = {
    start: mock.method(platform.channel, 'start', () => {}),
    stop: mock.method(platform.channel, 'stop', () => {}),
    watch: mock.method(platform.channel, 'watch', () => {}),
  };

  return {
    platform, log, cloud, channel, registered, updated, unregistered,
    launch: async () => {
      await handlers.didFinishLaunching();
      await flush();
    },
    shutdown: () => handlers.shutdown(),
    cachedAccessory: (id: string) => platform.accessories.get(uuid.generate(id))!,
  };
}

const cachedDevice = (id: string, overrides: Record<string, unknown> = {}) => ({
  info_version: INFO_VERSION, model: 'STRATUS ISOLA', astarte_type: 'HOOD', id, name: 'Hood', firmware_revision: '1.2.0',
  features: FULL_FEATURES, ...overrides,
});

describe('FaberHomebridgePlatform', () => {
  let storage_path: string;
  let fixture: ReturnType<typeof createPlatform> | undefined;
  beforeEach(() => {
    storage_path = mkdtempSync(path.join(os.tmpdir(), 'faber-test-'));
    useFakeTime();
  });
  afterEach(() => {
    fixture?.shutdown();
    fixture = undefined;
    mock.timers.reset();
    mock.restoreAll();
    rmSync(storage_path, { recursive: true, force: true });
  });
  const create = (config: Record<string, unknown>, options: Parameters<typeof createPlatform>[1] = {}) =>
    fixture = createPlatform(config, { storage_path, ...options });

  describe('startup', () => {
    test('doesn\'t start with an invalid config, and says what\'s wrong', async () => {
      const { launch, log, cloud } = create({ platform: 'FaberRangeHood', auth_mode: 'token' });
      await launch();
      assert.equal(cloud.inits, 0);
      assert.match(log.at('error').join(), /The plugin config is invalid[\s\S]*refresh_token/);
    });

    test('doesn\'t start when its storage isn\'t writable', async () => {
      const { launch, log, cloud } = fixture = createPlatform({ ...CONFIG, devices: [{ id: 'PIN1' }] }, { storage_path: '/dev/null' });
      await launch();
      assert.equal(cloud.inits, 0);
      assert.match(log.at('error').join(), /Failed to initialize the plugin's storage/);
    });

    test('retries logging in with a backoff while the network is down', async () => {
      const { launch, cloud, registered } = create({ ...CONFIG, devices: [{ id: 'PIN1' }] });
      cloud.init = () => err(new NetworkServiceError);
      await launch();
      await advance(10000 + 20000 + 40000);
      assert.equal(cloud.inits, 4);
      cloud.init = () => ok();
      await advance(80000);
      assert.equal(cloud.inits, 5);
      assert.equal(registered.length, 1);
    });

    test('doesn\'t retry logging in when retrying won\'t help', async () => {
      const { launch, cloud } = create({ ...CONFIG, devices: [{ id: 'PIN1' }] });
      cloud.init = () => err(new TokenExpiredError);
      await launch();
      await advance(600000, 1000);
      assert.equal(cloud.inits, 1);
    });

    test('starts the push updates after discovering the devices', async () => {
      const { launch, channel } = create({ ...CONFIG, devices: [{ id: 'PIN1' }] });
      await launch();
      assert.equal(channel.watch.mock.callCount(), 1);
      assert.equal(channel.start.mock.callCount(), 1);
    });

    test('warns about configured devices that aren\'t in the account, or when none are configured', async () => {
      let { launch, log } = create({ ...CONFIG, devices: [{ id: 'PIN_TYPO' }] });
      await launch();
      assert.match(log.at('warn').join(), /Device ID PIN_TYPO from the plugin config isn't in your Faber account.*PIN1/);
      fixture!.shutdown();
      ({ launch, log } = create(CONFIG));
      await launch();
      assert.match(log.at('warn').join(), /No devices are configured/);
    });
  });

  describe('device discovery', () => {
    test('adds a new device', async () => {
      const { launch, registered } = create({ ...CONFIG, devices: [{ id: 'PIN1', name: 'Kitchen' }] });
      await launch();
      assert.equal(registered.length, 1);
      assert.equal(registered[0].displayName, 'Kitchen');
      assert.ok(registered[0].getService(Service.Fanv2));
    });

    test('restores a cached device, refreshing and saving its device info', async () => {
      const { launch, updated, registered, cachedAccessory } = create({ ...CONFIG, devices: [{ id: 'PIN1' }] },
        { cached: { PIN1: cachedDevice('PIN1', { firmware_revision: '0.9.0' }) } });
      await launch();
      assert.deepEqual(updated, ['PIN1']);
      assert.equal(registered.length, 0);
      assert.notEqual(cachedAccessory('PIN1').context.device.firmware_revision, '0.9.0');
    });

    test('removes cached devices that are no longer configured', async () => {
      const { launch, unregistered } = create({ ...CONFIG, devices: [{ id: 'PIN1' }] }, { cached: { PIN_OLD: cachedDevice('PIN_OLD') } });
      await launch();
      assert.deepEqual(unregistered, ['Cached PIN_OLD']);
    });

    test('falls back to valid cached device info when refreshing it fails', async () => {
      const { launch, cloud, updated, log } = create({ ...CONFIG, devices: [{ id: 'PIN1' }] }, { cached: { PIN1: cachedDevice('PIN1') } });
      cloud.device_info_error.PIN1 = new NetworkServiceError;
      await launch();
      assert.deepEqual(updated, ['PIN1']);
      assert.match(log.at('warn').join(), /Using the cached device info/);
    });

    for (const [label, cached] of [
      ['outdated', cachedDevice('PIN1', { info_version: INFO_VERSION - 1 })],
      ['for an unknown device type', cachedDevice('PIN1', { astarte_type: 'OVEN' })],
      ['malformed', cachedDevice('PIN1', { features: { features: {} } })],
    ] as const) {
      test(`retries with a backoff when the cached device info is ${label} and refreshing it fails, keeping the accessory`, async () => {
        const { launch, cloud, updated, unregistered } = create({ ...CONFIG, devices: [{ id: 'PIN1' }] }, { cached: { PIN1: cached } });
        cloud.device_info_error.PIN1 = new NetworkServiceError;
        await launch();
        assert.deepEqual(updated, []);
        assert.deepEqual(unregistered, []);
        await advance(10000 + 20000);
        assert.equal(cloud.device_info_requests.PIN1, 3);
        delete cloud.device_info_error.PIN1;
        await advance(40000);
        assert.deepEqual(updated, ['PIN1']);
      });
    }

    test('doesn\'t retry a device whose device info request is rejected', async () => {
      const { launch, cloud, log, registered } = create({ ...CONFIG, devices: [{ id: 'PIN1' }] });
      cloud.device_info_error.PIN1 = new RequestRejectedError(404);
      await launch();
      await advance(600000, 1000);
      assert.equal(cloud.device_info_requests.PIN1, 1);
      assert.equal(registered.length, 0);
      assert.match(log.at('error').join(), /Failed to get device info for device ID PIN1.*404/);
    });

    test('sets up the other devices when one fails unexpectedly', async () => {
      const { launch, registered, log } = create({ ...CONFIG, devices: [{ id: 'PIN_BUG' }, { id: 'PIN2' }] },
        { devices_in_account: ['PIN_BUG', 'PIN2'] });
      const construct = DeviceFactory.constructDevice.bind(DeviceFactory);
      mock.method(DeviceFactory, 'constructDevice', (platform: FaberHomebridgePlatform, accessory: PlatformAccessory) => {
        if (accessory.context.device.id === 'PIN_BUG') {
          throw new TypeError('simulated bug');
        }
        return construct(platform, accessory);
      });
      await launch();
      assert.deepEqual(registered.map((accessory) => accessory.context.device.id), ['PIN2']);
      assert.match(log.at('error').join(), /Unexpected error while setting up device ID PIN_BUG/);
    });
  });

  describe('renaming', () => {
    test('applies a rename from the config once, keeping renames made in the Home app otherwise', async () => {
      let { launch, cachedAccessory } = create({ ...CONFIG, devices: [{ id: 'PIN1', name: 'Hood' }] }, { cached: { PIN1: cachedDevice('PIN1') } });
      await launch();
      const fanName = () => cachedAccessory('PIN1').getService(Service.Fanv2)!.getCharacteristic(Characteristic.ConfiguredName);
      fanName().setValue('Extractor'); // Renamed in the Home app
      const cached = cachedAccessory('PIN1');
      fixture!.shutdown();

      // Restart, with the same config: the Home app's name stays
      ({ launch, cachedAccessory } = create({ ...CONFIG, devices: [{ id: 'PIN1', name: 'Hood' }] }));
      fixture!.platform.configureAccessory(cached);
      await launch();
      assert.equal(fanName().value, 'Extractor');
      fixture!.shutdown();

      // Restart, renamed in the config: the config's name wins
      ({ launch, cachedAccessory } = create({ ...CONFIG, devices: [{ id: 'PIN1', name: 'Kitchen Hood' }] }));
      fixture!.platform.configureAccessory(cached);
      await launch();
      assert.equal(fanName().value, 'Kitchen Hood Fan');
      assert.equal(cached.displayName, 'Kitchen Hood');
      assert.match(fixture!.log.at('info').join(), /Renaming "Hood" to "Kitchen Hood"/);
    });
  });

  describe('shutdown', () => {
    test('stops the push updates and the pending retries', async () => {
      const { launch, cloud, channel, shutdown } = create({ ...CONFIG, devices: [{ id: 'PIN1' }] });
      cloud.init = () => err(new NetworkServiceError);
      await launch();
      shutdown();
      await advance(600000, 1000);
      assert.equal(cloud.inits, 1);
      assert.equal(channel.stop.mock.callCount(), 1);
      fixture = undefined;
    });
  });
});
