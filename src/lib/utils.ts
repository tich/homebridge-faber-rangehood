export function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  // Calculate the proportion of the value within the input range (between 0 and 1)
  const proportion = (value - inMin) / (inMax - inMin);

  // Apply that same proportion to the output range
  const result = proportion * (outMax - outMin) + outMin;

  return result;
}

/**
 * Serialize a value to JSON for logging, redacting anything whose key looks like a token
 * (e.g. `id_token`, `refresh_token`, `token`), so credentials never end up in the Homebridge logs.
 */
export function toRedactedJSON(value: unknown) {
  return JSON.stringify(value, (key, val) => /token/i.test(key) ? '<redacted>' : val);
}
