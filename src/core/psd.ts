export function embedPsdProfile(bytes: Uint8Array, profile: Uint8Array): Uint8Array {
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const resourcesOffset = 30 + input.getUint32(26), resourcesLength = input.getUint32(resourcesOffset);
  const insertion = resourcesOffset + 4 + resourcesLength, block = new Uint8Array(12 + profile.length + profile.length % 2), header = new DataView(block.buffer);
  block.set(new TextEncoder().encode('8BIM')); header.setUint16(4, 1039); header.setUint32(8, profile.length); block.set(profile, 12);
  const output = new Uint8Array(bytes.length + block.length);
  output.set(bytes.subarray(0, insertion)); output.set(block, insertion); output.set(bytes.subarray(insertion), insertion + block.length);
  new DataView(output.buffer).setUint32(resourcesOffset, resourcesLength + block.length);
  return output;
}

export function replacePsdComposite(bytes: Uint8Array, width: number, height: number, rgba: Uint8Array): Uint8Array {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), channels = header.getUint16(12);
  const resources = 30 + header.getUint32(26), layers = resources + 4 + header.getUint32(resources), start = layers + 4 + header.getUint32(layers);
  const count = width * height, output = new Uint8Array(start + 2 + count * channels);
  output.set(bytes.subarray(0, start));
  // Raw planar samples avoid the upstream composite RLE scratch-buffer limit.
  for (let channel = 0; channel < channels; channel++) for (let pixel = 0; pixel < count; pixel++) {
    let value = rgba[pixel * 4 + channel];
    const alpha = rgba[pixel * 4 + 3];
    if (channels === 4 && channel < 3 && alpha > 0 && alpha < 255) value = Math.round(value * alpha / 255 + 255 - alpha);
    output[start + 2 + channel * count + pixel] = value;
  }
  return output;
}
