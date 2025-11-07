export function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  // Calculate the proportion of the value within the input range (between 0 and 1)
  const proportion = (value - inMin) / (inMax - inMin);

  // Apply that same proportion to the output range
  const result = proportion * (outMax - outMin) + outMin;

  return result;
}
