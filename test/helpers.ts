import type { Logging, PlatformAccessory } from 'homebridge';
import { mock } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Captured before any test fakes the timers, to let pending promise callbacks and I/O run
const realSetImmediate = setImmediate;

/**
 * Let everything that's ready to run (promise callbacks, I/O callbacks) run
 */
export async function flush(times = 5) {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => realSetImmediate(resolve));
  }
}

/**
 * Fake the timers and `Date`, starting at a fixed time. Call `mock.timers.reset()` (e.g. in `afterEach`) to restore them
 */
export function useFakeTime(now = Date.parse('2026-01-01T00:00:00Z')) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate', 'Date'], now });
}

/**
 * Advance the fake time, in small steps, letting promise callbacks run in between
 */
export async function advance(ms: number, step_ms = 10) {
  for (let elapsed = 0; elapsed < ms; elapsed += step_ms) {
    mock.timers.tick(Math.min(step_ms, ms - elapsed));
    await flush();
  }
}

export interface TestLog {
  log: Logging;
  lines: string[];
  /** The lines logged at a level, e.g. 'warn' */
  at(level: string): string[];
}

/**
 * A Homebridge logger that records what's logged, as "<level>: <message>"
 */
export function createLog(): TestLog {
  const lines: string[] = [];
  const record = (level: string) => (...args: unknown[]) => {
    lines.push(`${level}: ${args.map((arg) => arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)).join(' ')}`);
  };
  const log = Object.assign(record('log'), {
    prefix: 'test',
    info: record('info'),
    success: record('success'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    log: record('log'),
  });
  return {
    log: log as unknown as Logging,
    lines,
    at: (level) => lines.filter((line) => line.startsWith(`${level}: `)),
  };
}

/**
 * Homebridge's PlatformAccessory class. Homebridge only exports its type, and creates instances through its API
 */
export async function loadPlatformAccessory(): Promise<typeof PlatformAccessory> {
  const module_path = path.resolve('node_modules/homebridge/dist/platformAccessory.js');
  const module: { PlatformAccessory: typeof PlatformAccessory } = await import(pathToFileURL(module_path).href);
  return module.PlatformAccessory;
}

/**
 * The features of a hood that has everything, as its device info stores them (see `RangeHoodDevice.getDeviceFeatures`)
 */
export const FULL_FEATURES = {
  features: {
    filters: { fc: { replacementHours: 200 }, fg: { replacementHours: 100 } },
    lights: { channels: { 1: { maxIntensity: 2 }, 2: { maxIntensity: 4 } }, tunableWhite: { enabled: true } },
  },
  motor: { maxFanSpeed: 3 },
};
