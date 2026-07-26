/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface FileMetadata {
  id: string;
  name: string;
  type: string;
  size: number;
  hash: string;
  compressedSize?: number;
}

export interface QRPacket {
  fileId: string;
  index: number;
  total: number;
  fileSize: number;
  mimeType: string;
  fileName: string;
  fileHash: string;
  chunkBase64: string;
}

export interface QRReceiveProgress {
  fileId: string | null;
  fileName: string;
  fileType: string;
  fileSize: number;
  fileHash: string;
  totalPackets: number;
  receivedCount: number;
  receivedMap: Record<number, Uint8Array>;
  isActive: boolean;
  isComplete: boolean;
  error: string | null;
  packetsPerSecond: number;
  lastPacketTime: number;
  startTime: number;
}

export interface NoiseImageHeader {
  magic: string; // "OPTN"
  index: number;
  total: number;
  originalSize: number;
  compressedSize: number;
  hash: string;
  name: string;
  type: string;
}

export type AppMode = 'qr' | 'noise';
export type QRSubMode = 'send' | 'receive';
export type NoiseSubMode = 'generate' | 'decode';
