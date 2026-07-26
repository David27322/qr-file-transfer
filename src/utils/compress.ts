/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Checks if browser-native CompressionStream and DecompressionStream are supported.
 */
export const isCompressionSupported = (): boolean => {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
};

/**
 * Compresses bytes using gzip format via native CompressionStream.
 */
export async function compressData(data: Uint8Array): Promise<Uint8Array> {
  if (!isCompressionSupported()) {
    console.warn('CompressionStream is not supported in this environment, using raw data.');
    return data;
  }
  try {
    const stream = new Response(data).body?.pipeThrough(new CompressionStream('gzip'));
    if (!stream) throw new Error('Failed to create compression stream');
    const arrayBuffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } catch (error) {
    console.error('Compression failed:', error);
    return data;
  }
}

/**
 * Decompresses gzip bytes via native DecompressionStream.
 */
export async function decompressData(data: Uint8Array): Promise<Uint8Array> {
  if (!isCompressionSupported()) {
    console.warn('DecompressionStream is not supported in this environment, using raw data.');
    return data;
  }
  try {
    const stream = new Response(data).body?.pipeThrough(new DecompressionStream('gzip'));
    if (!stream) throw new Error('Failed to create decompression stream');
    const arrayBuffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } catch (error) {
    console.error('Decompression failed:', error);
    throw error;
  }
}
