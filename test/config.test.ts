import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import type { PlatformConfig } from 'homebridge';
import { parsePluginConfig } from '../src/config.js';

const VALID = { platform: 'FaberRangeHood', auth_mode: 'token', refresh_token: 'eyJ...' };

// The cases both the config UI's schema and the runtime validation must agree on
const CASES: [string, Record<string, unknown>, boolean][] = [
  ['valid, with devices', { ...VALID, devices: [{ id: 'PIN1', name: 'Kitchen' }] }, true],
  ['valid, without devices', VALID, true],
  ['valid, with a fallback poll interval', { ...VALID, fallback_poll_interval: 60 }, true],
  ['missing refresh_token', { platform: 'FaberRangeHood', auth_mode: 'token' }, false],
  ['empty refresh_token', { ...VALID, refresh_token: '' }, false],
  ['unsupported auth_mode', { ...VALID, auth_mode: 'password' }, false],
  ['devices not an array', { ...VALID, devices: 'PIN1' }, false],
  ['device without an ID', { ...VALID, devices: [{ name: 'Kitchen' }] }, false],
  ['device with an empty ID', { ...VALID, devices: [{ id: '' }] }, false],
  ['fallback poll interval too short', { ...VALID, fallback_poll_interval: 10 }, false],
  ['fallback poll interval not an integer', { ...VALID, fallback_poll_interval: 45.5 }, false],
];

describe('parsePluginConfig', () => {
  for (const [label, config, valid] of CASES) {
    test(`${label}: ${valid ? 'valid' : 'invalid'}`, () => {
      assert.equal(parsePluginConfig(config as PlatformConfig).isOk(), valid);
    });
  }

  test('applies the defaults', () => {
    const config = parsePluginConfig(VALID as PlatformConfig)._unsafeUnwrap();
    assert.deepEqual(config.devices, []);
    assert.equal(config.fallback_poll_interval, 300);
  });

  test('keeps the properties Homebridge adds', () => {
    const config = parsePluginConfig({ ...VALID, _bridge: { username: 'x', name: 'Bridge', pin: '031-45-154' } } as PlatformConfig)._unsafeUnwrap();
    assert.deepEqual(config._bridge, { username: 'x', name: 'Bridge', pin: '031-45-154' });
  });

  test('describes every problem', () => {
    const error = parsePluginConfig({ platform: 'FaberRangeHood', auth_mode: 'password', devices: 'x' })._unsafeUnwrapErr();
    for (const field of ['auth_mode', 'refresh_token', 'devices']) {
      assert.match(error.message, new RegExp(field));
    }
  });
});

describe('config.schema.json', () => {
  const schema = JSON.parse(readFileSync('config.schema.json', 'utf8')).schema;
  // The config UI's schema has its own keywords (e.g. placeholder, condition)
  const validate = new Ajv({ strict: false }).compile(schema);

  for (const [label, config, valid] of CASES) {
    test(`agrees with the runtime validation: ${label}`, () => {
      // Homebridge adds `platform` itself; the schema describes the plugin's own properties
      const properties = { ...config };
      delete properties.platform;
      assert.equal(validate(properties), valid, JSON.stringify(validate.errors));
    });
  }
});
