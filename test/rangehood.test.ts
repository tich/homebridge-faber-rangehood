import { afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAccessory } from 'homebridge';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from 'hap-nodejs';
import { err, ok } from 'neverthrow';
import { RangeHoodDevice } from '../src/devices/rangehood.js';
import type { ChannelEvent, ChannelListener } from '../src/api/channel.js';
import type { FaberHomebridgePlatform } from '../src/platform.js';
import { DeadlineExceededError, NetworkServiceError, RequestRejectedError } from '../src/lib/errors.js';
import { INFO_VERSION } from '../src/devices/factory.js';
import { advance, createLog, FULL_FEATURES, loadPlatformAccessory, TestLog, useFakeTime } from './helpers.js';

let PlatformAccessoryClass: typeof PlatformAccessory;
before(async () => PlatformAccessoryClass = await loadPlatformAccessory());

type PostMode = 'ok' | 'hang' | NetworkServiceError;

/**
 * A hood behind a fake cloud: its reported state (with when the cloud received each value), the commands sent to it,
 * and a fake push channel. Everything runs on fake time.
 */
function createHood(options: { features?: object; accessory?: PlatformAccessory } = {}) {
  const log: TestLog = createLog();
  const reported = new Map<string, { value: number; at: number }>();
  const report = (path: string, value: number) => reported.set(path, { value, at: Date.now() });
  report('/lights/channels/1/intensity', 0);
  report('/lights/channels/2/intensity', 0);
  report('/fan/speed', 0);
  report('/filters/fc/hoursUntilReplacement', 200);
  report('/filters/fg/hoursUntilReplacement', 100);

  const posts: { path: string; value: unknown; signal?: AbortSignal }[] = [];
  const cloud = { polls: 0, poll_delay_ms: 0, poll_error: undefined as NetworkServiceError | undefined, post_mode: 'ok' as PostMode, post_delay_ms: 100 };
  const snapshot = (path: string) => {
    const value = reported.get(path)!;
    return { value: value.value, reception_timestamp: new Date(value.at).toISOString() };
  };

  const astarte = {
    async doRequest(device_id: string, api_interface: string, method: string, body: { data: unknown }, signal?: AbortSignal) {
      if (method === 'get') {
        cloud.polls++;
        if (cloud.poll_error) {
          return err(cloud.poll_error);
        }
        // Taken when the request reaches the cloud; the response may take a while
        const status = { fan: { speed: snapshot('/fan/speed') },
          filters: { fc: { hoursUntilReplacement: snapshot('/filters/fc/hoursUntilReplacement') },
            fg: { hoursUntilReplacement: snapshot('/filters/fg/hoursUntilReplacement') } },
          lights: { channels: { 1: { intensity: snapshot('/lights/channels/1/intensity') }, 2: { intensity: snapshot('/lights/channels/2/intensity') } } } };
        await new Promise((resolve) => setTimeout(resolve, cloud.poll_delay_ms));
        return ok({ data: status });
      }
      const path = api_interface.replace('com.faberspa.connectedhood.Control', '');
      posts.push({ path, value: body.data, signal });
      if (cloud.post_mode instanceof NetworkServiceError) {
        return err(cloud.post_mode);
      }
      if (cloud.post_mode === 'hang') {
        return new Promise((resolve) => signal?.addEventListener('abort', () => resolve(err(new DeadlineExceededError)), { once: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, cloud.post_delay_ms));
      return ok(undefined);
    },
  };

  let listener: ChannelListener | undefined;
  const channel = { watch: (_device_id: string, _interface: string, l: ChannelListener) => listener = l };
  const platform = { Service, Characteristic, log: log.log, astarte, channel, fallback_poll_interval_ms: 300 * 1000, api: { hap: { HapStatusError } } };

  const accessory = options.accessory ?? new PlatformAccessoryClass('Hood', uuid.generate(`hood-${Math.random()}`));
  accessory.context.device = { info_version: INFO_VERSION, model: 'STRATUS ISOLA', astarte_type: 'HOOD', id: 'PIN1', name: 'Hood',
    firmware_revision: '1.2.0', features: options.features ?? FULL_FEATURES };
  const device = new RangeHoodDevice(platform as unknown as FaberHomebridgePlatform, accessory);

  const value = (service: Service | undefined, characteristic: typeof Characteristic.On) => service!.getCharacteristic(characteristic).value;
  return {
    device, accessory, log, cloud, posts, report,
    light: accessory.getService(Service.Lightbulb),
    fan: accessory.getService(Service.Fanv2)!,
    carbon: accessory.getServiceById(Service.FilterMaintenance, 'Carbon'),
    grease: accessory.getServiceById(Service.FilterMaintenance, 'Grease'),
    value,
    /** A push event, as the channel delivers it */
    push(path: string, value: unknown, at = Date.now()) {
      listener!.onEvent({ path, value, timestamp: at } satisfies ChannelEvent);
    },
    setPushActive: (active: boolean) => listener!.onActiveChange(active),
  };
}

/** How a promise settled so far, without leaving a rejection unhandled */
function track(promise: Promise<unknown>) {
  const outcome: { settled?: 'resolved' | 'rejected'; error?: unknown } = {};
  promise.then(() => outcome.settled = 'resolved', (error) => {
    outcome.settled = 'rejected';
    outcome.error = error;
  });
  return outcome;
}

const isCommunicationFailure = (error: unknown) => error instanceof HapStatusError && error.hapStatus === HAPStatus.SERVICE_COMMUNICATION_FAILURE;

describe('RangeHoodDevice', () => {
  let hood: ReturnType<typeof createHood> | undefined;
  beforeEach(() => useFakeTime());
  afterEach(() => {
    hood?.device.shutdown();
    hood = undefined;
    mock.timers.reset();
  });

  describe('services', () => {
    test('exposes everything a fully featured hood supports', () => {
      hood = createHood();
      const color_temperature = hood.light!.getCharacteristic(Characteristic.ColorTemperature);
      assert.equal(color_temperature.props.minValue, 154);
      assert.equal(color_temperature.props.maxValue, 370);
      assert.equal(color_temperature.props.minStep, 54);
      assert.ok(hood.carbon && hood.grease);
      assert.equal(hood.value(hood.fan, Characteristic.ConfiguredName), 'Hood Fan');
      assert.equal(hood.value(hood.light, Characteristic.ConfiguredName), 'Hood Light');
      const information = hood.accessory.getService(Service.AccessoryInformation)!;
      assert.equal(information.getCharacteristic(Characteristic.FirmwareRevision).value, '1.2.0');
      assert.equal(information.getCharacteristic(Characteristic.Model).value, 'STRATUS ISOLA');
    });

    test('only exposes the fan of a hood that reports nothing else', () => {
      hood = createHood({ features: { features: {}, motor: { maxFanSpeed: 3 } } });
      assert.equal(hood.light, undefined);
      assert.equal(hood.carbon, undefined);
      assert.equal(hood.grease, undefined);
    });

    test('removes the cached services and characteristics of features the hood doesn\'t have', () => {
      const full = createHood();
      full.device.shutdown();
      hood = createHood({ accessory: full.accessory, features: {
        features: { filters: { fg: { replacementHours: 100 } }, lights: { channels: { 1: { maxIntensity: 2 } }, tunableWhite: { enabled: false } } },
        motor: { maxFanSpeed: 3 },
      } });
      assert.equal(hood.carbon, undefined);
      assert.ok(hood.grease);
      assert.ok(!hood.light!.testCharacteristic(Characteristic.ColorTemperature));
      assert.equal(hood.log.at('info').length, 2);
    });
  });

  describe('status polling', () => {
    test('maps the hood\'s status to HomeKit', async () => {
      hood = createHood();
      hood.report('/lights/channels/1/intensity', 1);
      hood.report('/lights/channels/2/intensity', 4);
      hood.report('/fan/speed', 2);
      hood.report('/filters/fc/hoursUntilReplacement', 100);
      hood.report('/filters/fg/hoursUntilReplacement', 0);
      await advance(3000);
      assert.equal(hood.value(hood.light, Characteristic.On), true);
      assert.equal(hood.value(hood.light, Characteristic.Brightness), 50);
      assert.equal(hood.value(hood.light, Characteristic.ColorTemperature), 370);
      assert.equal(hood.value(hood.fan, Characteristic.Active), Characteristic.Active.ACTIVE);
      assert.equal(Math.round(hood.value(hood.fan, Characteristic.RotationSpeed) as number), 67);
      assert.equal(hood.value(hood.carbon, Characteristic.FilterLifeLevel), 50);
      assert.equal(hood.value(hood.carbon, Characteristic.FilterChangeIndication), Characteristic.FilterChangeIndication.FILTER_OK);
      assert.equal(hood.value(hood.grease, Characteristic.FilterChangeIndication), Characteristic.FilterChangeIndication.CHANGE_FILTER);
    });

    test('keeps the last brightness while the light is off, so turning it back on restores it', async () => {
      hood = createHood();
      hood.report('/lights/channels/1/intensity', 1);
      await advance(3000);
      hood.report('/lights/channels/1/intensity', 0);
      await advance(3000);
      assert.equal(hood.value(hood.light, Characteristic.On), false);
      assert.equal(hood.value(hood.light, Characteristic.Brightness), 50);
    });

    test('polls every 3 seconds while push updates aren\'t active', async () => {
      hood = createHood();
      await advance(9000);
      assert.equal(hood.cloud.polls, 3);
    });

    test('backs off while polls fail with network errors, and recovers', async () => {
      hood = createHood();
      hood.cloud.poll_error = new NetworkServiceError;
      await advance(3000 + 6000 + 12000 + 24000); // The intervals double
      assert.equal(hood.cloud.polls, 4);
      assert.equal(hood.log.at('warn').filter((line) => line.includes('Lost connection')).length, 1);
      hood.cloud.poll_error = undefined;
      await advance(48000);
      assert.ok(hood.log.at('info').some((line) => line.includes('Reconnected')));
      const polls = hood.cloud.polls;
      await advance(3000);
      assert.equal(hood.cloud.polls, polls + 1);
    });

    test('stops polling when retrying won\'t help', async () => {
      hood = createHood();
      hood.cloud.poll_error = new RequestRejectedError(404);
      await advance(60000);
      assert.equal(hood.cloud.polls, 1);
      assert.ok(hood.log.at('error').some((line) => line.includes('Stopped updating the status of Hood')));
    });

    test('stops polling on shutdown', async () => {
      hood = createHood();
      hood.device.shutdown();
      await advance(10000);
      assert.equal(hood.cloud.polls, 0);
    });
  });

  describe('writes', () => {
    test('turns the light on at the brightness it had', async () => {
      hood = createHood();
      hood.report('/lights/channels/1/intensity', 1);
      await advance(3000);
      hood.report('/lights/channels/1/intensity', 0);
      await advance(3000);
      await Promise.all([hood.device.setLightOn(true), advance(200)]);
      assert.deepEqual(hood.posts.map((post) => [post.path, post.value]), [['/lights/channels/1/intensity', 1]]);
    });

    test('turns a new accessory\'s light on at the lowest level, rather than at 0%', async () => {
      hood = createHood();
      await Promise.all([hood.device.setLightOn(true), advance(200)]);
      assert.equal(hood.posts[0].value, 1);
    });

    test('sends the On and Brightness of one HomeKit request as a single command', async () => {
      hood = createHood();
      await Promise.all([hood.device.setLightOn(true), hood.device.setLightBrightness(100), advance(200)]);
      assert.deepEqual(hood.posts.map((post) => post.value), [2]);
    });

    test('maps percentages to the hood\'s levels, keeping a low speed on', async () => {
      hood = createHood();
      await Promise.all([hood.device.setFanSpeed(10), advance(200)]);
      await Promise.all([hood.device.setFanSpeed(100), advance(200)]);
      await Promise.all([hood.device.setFanActive(Characteristic.Active.INACTIVE), advance(200)]);
      await Promise.all([hood.device.setColorTemperature(262), advance(200)]);
      assert.deepEqual(hood.posts.map((post) => [post.path, post.value]),
        [['/fan/speed', 1], ['/fan/speed', 3], ['/fan/speed', 0], ['/lights/channels/2/intensity', 2]]);
    });

    test('reports a failed command to HomeKit', async () => {
      hood = createHood();
      hood.cloud.post_mode = new NetworkServiceError;
      const write = track(hood.device.setFanSpeed(50));
      await advance(200);
      assert.ok(isCommunicationFailure(write.error));
    });

    test('gives up on a command before HomeKit does, and cancels it', async () => {
      hood = createHood();
      hood.cloud.post_mode = 'hang';
      const write = track(hood.device.setFanSpeed(50));
      await advance(7990);
      assert.equal(write.settled, undefined);
      await advance(20);
      assert.ok(isCommunicationFailure(write.error));
      assert.ok(hood.posts[0].signal!.aborted);
      assert.ok(hood.log.at('warn').some((line) => line.includes('didn\'t complete within 8 seconds')));
    });

    test('shows a reset filter as new straight away', async () => {
      hood = createHood();
      hood.report('/filters/fc/hoursUntilReplacement', 0);
      await advance(3000);
      await Promise.all([hood.device.resetCarbonFilter(1), advance(200)]);
      assert.deepEqual(hood.posts.map((post) => post.path), ['/filters/fc/resetCountdown']);
      assert.equal(hood.value(hood.carbon, Characteristic.FilterLifeLevel), 100);
      assert.equal(hood.value(hood.carbon, Characteristic.FilterChangeIndication), Characteristic.FilterChangeIndication.FILTER_OK);
    });

    test('leaves a filter as it was when resetting it fails', async () => {
      hood = createHood();
      hood.report('/filters/fg/hoursUntilReplacement', 0);
      await advance(3000);
      hood.cloud.post_mode = new NetworkServiceError;
      const reset = track(hood.device.resetGreaseFilter(1));
      await advance(200);
      assert.ok(isCommunicationFailure(reset.error));
      assert.equal(hood.value(hood.grease, Characteristic.FilterChangeIndication), Characteristic.FilterChangeIndication.CHANGE_FILTER);
    });
  });

  describe('reports during writes', () => {
    test('holds back reports about the channel being written, applies the others, and catches up after the write', async () => {
      hood = createHood();
      hood.setPushActive(true);
      hood.cloud.post_delay_ms = 1000;
      const write = hood.device.setLightOn(true);
      await advance(100);
      hood.push('/lights/channels/1/intensity', 0);          // Outdated: from before the write
      hood.push('/fan/speed', 3);                            // Another channel
      assert.equal(hood.value(hood.fan, Characteristic.Active), Characteristic.Active.ACTIVE);
      assert.equal(hood.value(hood.light, Characteristic.On), false); // HomeKit only stores the new value once the write completes
      await advance(1000);
      await write;
      hood.report('/lights/channels/1/intensity', 1);         // The hood applied the write
      const polls = hood.cloud.polls;
      await advance(3000);
      assert.equal(hood.cloud.polls, polls + 1);             // The poll that follows the write
      assert.equal(hood.value(hood.light, Characteristic.On), true);
    });

    test('ignores the written channel in a poll that was sent before the write', async () => {
      hood = createHood();
      hood.cloud.poll_delay_ms = 500;
      hood.report('/fan/speed', 1);
      await advance(3000);                                   // A poll is now in flight, and saw the light off
      // Like HomeKit's write: runs the handler, and stores the value once it succeeds
      hood.light!.getCharacteristic(Characteristic.On).setValue(true);
      await advance(700);                                    // The write completes, then the outdated poll returns
      assert.equal(hood.posts.length, 1);
      assert.equal(hood.value(hood.light, Characteristic.On), true); // Not reverted by the outdated poll
      assert.equal(hood.value(hood.fan, Characteristic.Active), Characteristic.Active.ACTIVE); // Its other channels still applied
    });

    test('ignores a report older than the one last applied', async () => {
      hood = createHood();
      hood.setPushActive(true);
      hood.cloud.poll_delay_ms = 500;
      hood.report('/fan/speed', 1);
      await advance(3000);                                   // The catch-up poll is in flight, and saw speed 1
      hood.push('/fan/speed', 2, Date.now());                // Newer, while the poll is in flight
      await advance(500);
      assert.equal(Math.round(hood.value(hood.fan, Characteristic.RotationSpeed) as number), 67);
    });
  });

  describe('push updates', () => {
    test('applies them immediately', () => {
      hood = createHood();
      hood.push('/lights/channels/1/intensity', 2);
      assert.equal(hood.value(hood.light, Characteristic.On), true);
      assert.equal(hood.value(hood.light, Characteristic.Brightness), 100);
    });

    test('ignores unknown paths and unexpected values', () => {
      hood = createHood();
      hood.push('/unknown/path', 1);
      hood.push('/lights/channels/1/intensity', 'bright');
      assert.equal(hood.value(hood.light, Characteristic.On), false);
      assert.equal(hood.log.at('debug').length, 2);
    });

    test('only polls as a safety net while active, after catching up', async () => {
      hood = createHood();
      hood.setPushActive(true);
      await advance(3000);
      assert.equal(hood.cloud.polls, 1);                     // The catch-up poll
      await advance(290000);
      assert.equal(hood.cloud.polls, 1);
      await advance(10000);
      assert.equal(hood.cloud.polls, 2);                     // The fallback poll, every 5 minutes
      hood.setPushActive(false);
      await advance(3000);
      assert.equal(hood.cloud.polls, 3);                     // Back to regular polling
    });
  });
});
