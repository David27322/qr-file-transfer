/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { 
  Upload, QrCode, Camera, CheckCircle, AlertCircle, Play, Pause, 
  SkipForward, SkipBack, RefreshCw, File, Download, Settings, ChevronRight, Info
} from 'lucide-react';
import { 
  calculateSHA256, bytesToBase64, base64ToBytes, generateShortId 
} from '../utils/crypto';
import { compressData, decompressData } from '../utils/compress';
import { QRPacket, QRReceiveProgress } from '../types';

export default function QRTransfer() {
  const [subMode, setSubMode] = useState<'send' | 'receive'>('send');

  // --- SENDER STATE ---
  const [sendFile, setSendFile] = useState<File | null>(null);
  const [sendMetadata, setSendMetadata] = useState<{
    id: string;
    name: string;
    size: number;
    mime: string;
    hash: string;
    compressedSize: number;
  } | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [packets, setPackets] = useState<string[]>([]);
  const [activeFrameIndex, setActiveFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [fps, setFps] = useState(5); // Frames per second (default 5 FPS = 200ms)
  const [packetSize, setPacketSize] = useState(400); // Bytes of data payload per QR code (default 400 bytes)
  const [qrDensity, setQrDensity] = useState<'L' | 'M' | 'H'>('L'); // Error correction level (L allows maximum payload)
  const [showSenderSettings, setShowSenderSettings] = useState(false);

  // --- RECEIVER STATE ---
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [recvProgress, setRecvProgress] = useState<QRReceiveProgress>({
    fileId: null,
    fileName: '',
    fileType: '',
    fileSize: 0,
    fileHash: '',
    totalPackets: 0,
    receivedCount: 0,
    receivedMap: {},
    isActive: false,
    isComplete: false,
    error: null,
    packetsPerSecond: 0,
    lastPacketTime: 0,
    startTime: 0,
  });

  const [lastScannedIndex, setLastScannedIndex] = useState<number | null>(null);
  const [recentFails, setRecentFails] = useState<string | null>(null);

  // Refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const slideshowTimerRef = useRef<NodeJS.Timeout | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastScanTimeRef = useRef<number>(0);
  const dragRef = useRef<HTMLDivElement | null>(null);

  // Synth sounds
  const playTick = useCallback(() => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1400, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.04, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.05);
    } catch (e) {
      // Ignored if AudioContext blocked
    }
  }, []);

  const playSuccess = useCallback(() => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const now = audioCtx.currentTime;
      [587.33, 783.99, 987.77].forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.1);
        gain.gain.setValueAtTime(0.06, now + idx * 0.1);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.1 + 0.25);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + idx * 0.1);
        osc.stop(now + idx * 0.1 + 0.25);
      });
    } catch (e) {
      // Ignored
    }
  }, []);

  // --- SENDER LOGIC: Prepare file ---
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) prepareFileForQR(file);
  };

  const prepareFileForQR = async (file: File) => {
    setIsPreparing(true);
    setSendFile(file);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const rawBytes = new Uint8Array(arrayBuffer);
      
      // 1. Compute Hash
      const fileHash = await calculateSHA256(rawBytes);
      
      // 2. Compress Data
      const compressed = await compressData(rawBytes);
      
      const fileId = generateShortId(6);
      
      setSendMetadata({
        id: fileId,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        hash: fileHash,
        compressedSize: compressed.byteLength,
      });

      // 3. Chunk & Package
      const chunks: string[] = [];
      const totalBytes = compressed.byteLength;
      const totalPackets = Math.ceil(totalBytes / packetSize);
      
      const mimeBase64 = window.btoa(file.type || 'application/octet-stream');
      const nameBase64 = bytesToBase64(new TextEncoder().encode(file.name));

      for (let i = 0; i < totalPackets; i++) {
        const start = i * packetSize;
        const end = Math.min(start + packetSize, totalBytes);
        const slice = compressed.subarray(start, end);
        const chunkBase64 = bytesToBase64(slice);
        
        // Packet string structure:
        // OPT;[file_id];[index];[total];[file_size];[mime_base64];[name_base64];[file_sha256];[chunk_base64]
        const packetStr = `OPT;${fileId};${i};${totalPackets};${file.size};${mimeBase64};${nameBase64};${fileHash};${chunkBase64}`;
        chunks.push(packetStr);
      }
      
      setPackets(chunks);
      setActiveFrameIndex(0);
      setIsPlaying(true);
    } catch (error) {
      console.error('Error preparing file:', error);
    } finally {
      setIsPreparing(false);
    }
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragRef.current) {
      dragRef.current.classList.add('border-slate-800', 'bg-slate-50/50');
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragRef.current) {
      dragRef.current.classList.remove('border-slate-800', 'bg-slate-50/50');
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragRef.current) {
      dragRef.current.classList.remove('border-slate-800', 'bg-slate-50/50');
    }
    const file = e.dataTransfer.files?.[0];
    if (file) prepareFileForQR(file);
  };

  // Render QR Code of active frame to canvas
  useEffect(() => {
    if (canvasRef.current && packets.length > 0 && activeFrameIndex < packets.length) {
      const packetText = packets[activeFrameIndex];
      QRCode.toCanvas(
        canvasRef.current,
        packetText,
        {
          width: 380,
          margin: 1,
          errorCorrectionLevel: qrDensity,
          color: {
            dark: '#0f172a', // Slate-900
            light: '#ffffff',
          },
        },
        (error) => {
          if (error) console.error('QR Render Error:', error);
        }
      );
    }
  }, [packets, activeFrameIndex, qrDensity]);

  // Slideshow play/pause timer
  useEffect(() => {
    if (slideshowTimerRef.current) {
      clearInterval(slideshowTimerRef.current);
      slideshowTimerRef.current = null;
    }

    if (isPlaying && packets.length > 0) {
      const intervalMs = Math.round(1000 / fps);
      slideshowTimerRef.current = setInterval(() => {
        setActiveFrameIndex((prevIndex) => {
          if (prevIndex + 1 >= packets.length) {
            return 0; // loop
          }
          return prevIndex + 1;
        });
      }, intervalMs);
    }

    return () => {
      if (slideshowTimerRef.current) {
        clearInterval(slideshowTimerRef.current);
      }
    };
  }, [isPlaying, packets, fps]);

  // Adjust packets if package config changes while a file is selected
  const handleSettingsChange = () => {
    if (sendFile) {
      prepareFileForQR(sendFile);
    }
  };

  // --- RECEIVER LOGIC: Camera & Scanner ---
  const startCamera = async () => {
    setCameraError(null);
    setIsCameraActive(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        videoRef.current.play();
      }
    } catch (err: any) {
      console.error('Camera access error:', err);
      setCameraError('Could not access camera. Please check camera permissions in your browser or iframe.');
      setIsCameraActive(false);
    }
  };

  const stopCamera = () => {
    setIsCameraActive(false);
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  };

  const resetReceiver = () => {
    setRecvProgress({
      fileId: null,
      fileName: '',
      fileType: '',
      fileSize: 0,
      fileHash: '',
      totalPackets: 0,
      receivedCount: 0,
      receivedMap: {},
      isActive: false,
      isComplete: false,
      error: null,
      packetsPerSecond: 0,
      lastPacketTime: 0,
      startTime: 0,
    });
    setLastScannedIndex(null);
    setRecentFails(null);
  };

  // Camera stream frame scan loop
  const scanLoop = useCallback(() => {
    if (!isCameraActive || !videoRef.current || !scanCanvasRef.current) return;

    const video = videoRef.current;
    const canvas = scanCanvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const now = performance.now();
    // Throttle scan rate to prevent heavy CPU usage (~15 frames per second)
    if (now - lastScanTimeRef.current >= 65) {
      lastScanTimeRef.current = now;

      if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
        canvas.width = Math.min(video.videoWidth, 800);
        canvas.height = Math.min(video.videoHeight, 600);
        
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        // Extract pixel data and decode QR
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });

        if (code && code.data) {
          handleQRData(code.data);
        }
      }
    }

    animationFrameRef.current = requestAnimationFrame(scanLoop);
  }, [isCameraActive]);

  useEffect(() => {
    if (isCameraActive) {
      animationFrameRef.current = requestAnimationFrame(scanLoop);
    } else {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    }
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isCameraActive, scanLoop]);

  // Decode packet data
  const handleQRData = (rawText: string) => {
    if (!rawText.startsWith('OPT;')) {
      return; // Ignore non-OPT qr codes
    }

    const parts = rawText.split(';');
    if (parts.length < 9) {
      setRecentFails('Malformed packet detected.');
      return;
    }

    const [, fileId, indexStr, totalStr, fileSizeStr, mimeBase64, nameBase64, fileHash, chunkBase64] = parts;
    const index = parseInt(indexStr, 10);
    const total = parseInt(totalStr, 10);
    const fileSize = parseInt(fileSizeStr, 10);

    if (isNaN(index) || isNaN(total) || isNaN(fileSize)) {
      return;
    }

    // Trigger state updater
    setRecvProgress((prev) => {
      // If we receive a packet for a new file ID, or if receiver was inactive
      const isNewFile = prev.fileId !== fileId;
      
      if (isNewFile) {
        // Reset and start tracking new file
        let resolvedName = 'Unknown File';
        let resolvedType = 'application/octet-stream';
        try {
          resolvedName = new TextDecoder().decode(base64ToBytes(nameBase64));
          resolvedType = window.atob(mimeBase64);
        } catch (e) {
          console.error('Failed to parse metadata base64', e);
        }

        const newMap: Record<number, Uint8Array> = {};
        try {
          newMap[index] = base64ToBytes(chunkBase64);
        } catch (err) {
          console.error(err);
          return prev;
        }

        playTick();
        setLastScannedIndex(index);
        return {
          fileId,
          fileName: resolvedName,
          fileType: resolvedType,
          fileSize,
          fileHash,
          totalPackets: total,
          receivedCount: 1,
          receivedMap: newMap,
          isActive: true,
          isComplete: total === 1,
          error: null,
          packetsPerSecond: 1,
          lastPacketTime: Date.now(),
          startTime: Date.now(),
        };
      }

      // If already complete, ignore further frames
      if (prev.isComplete) {
        return prev;
      }

      // If index already received, update recent but don't add
      if (prev.receivedMap[index]) {
        setLastScannedIndex(index);
        return prev;
      }

      // Add new packet
      const updatedMap = { ...prev.receivedMap };
      try {
        updatedMap[index] = base64ToBytes(chunkBase64);
      } catch (err) {
        console.error('Failed to decode chunk bytes', err);
        return prev;
      }

      const updatedCount = prev.receivedCount + 1;
      const isNowComplete = updatedCount === prev.totalPackets;

      // Audio feedback
      if (isNowComplete) {
        playSuccess();
      } else {
        playTick();
      }

      // Calculate instant packet rate
      const currentTime = Date.now();
      const elapsedSeconds = (currentTime - prev.startTime) / 1000;
      const calculatedPps = elapsedSeconds > 0 ? Number((updatedCount / elapsedSeconds).toFixed(1)) : 1;

      setLastScannedIndex(index);

      return {
        ...prev,
        receivedCount: updatedCount,
        receivedMap: updatedMap,
        isComplete: isNowComplete,
        packetsPerSecond: calculatedPps,
        lastPacketTime: currentTime,
      };
    });
  };

  // Reassemble, decompress and download when complete
  useEffect(() => {
    if (recvProgress.isComplete && recvProgress.fileId && recvProgress.receivedCount === recvProgress.totalPackets) {
      assembleAndDownloadFile();
    }
  }, [recvProgress.isComplete, recvProgress.receivedCount]);

  const assembleAndDownloadFile = async () => {
    // Prevent double processing
    setRecvProgress(prev => {
      if (prev.error || prev.fileSize === 0) return prev;
      return { ...prev, isActive: false }; // deactivate camera capture triggers
    });

    try {
      // 1. Merge Uint8Array chunks
      const sortedIndices = Object.keys(recvProgress.receivedMap)
        .map(Number)
        .sort((a, b) => a - b);
      
      const totalCompressedLength = sortedIndices.reduce((sum, idx) => sum + recvProgress.receivedMap[idx].byteLength, 0);
      const mergedCompressedBytes = new Uint8Array(totalCompressedLength);
      
      let offset = 0;
      for (const idx of sortedIndices) {
        const chunk = recvProgress.receivedMap[idx];
        mergedCompressedBytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      // 2. Decompress
      const originalBytes = await decompressData(mergedCompressedBytes);

      // 3. Verify SHA-256 Checksum
      const computedHash = await calculateSHA256(originalBytes);
      if (computedHash !== recvProgress.fileHash) {
        throw new Error(`Data integrity verification failed! Expected SHA-256: ${recvProgress.fileHash.slice(0, 8)}... but got: ${computedHash.slice(0, 8)}... Please rescan.`);
      }

      // 4. Download file
      const blob = new Blob([originalBytes], { type: recvProgress.fileType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = recvProgress.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      stopCamera();
    } catch (err: any) {
      console.error(err);
      setRecvProgress(prev => ({
        ...prev,
        error: err.message || 'An error occurred during file reassembly.'
      }));
    }
  };

  // UI calculations
  const missingPackets = useMemo(() => {
    if (!recvProgress.fileId) return [];
    const missing = [];
    for (let i = 0; i < recvProgress.totalPackets; i++) {
      if (!recvProgress.receivedMap[i]) {
        missing.push(i);
      }
    }
    return missing;
  }, [recvProgress.receivedMap, recvProgress.totalPackets, recvProgress.fileId]);

  const estimatedTimeRemaining = useMemo(() => {
    if (recvProgress.receivedCount === 0 || recvProgress.packetsPerSecond === 0) return null;
    const remaining = recvProgress.totalPackets - recvProgress.receivedCount;
    const seconds = Math.ceil(remaining / recvProgress.packetsPerSecond);
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }, [recvProgress.receivedCount, recvProgress.totalPackets, recvProgress.packetsPerSecond]);

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  return (
    <div className="space-y-6">
      {/* Sub Mode Selector */}
      <div className="flex border border-slate-200 rounded-lg p-1 bg-slate-50/50 max-w-xs mx-auto">
        <button
          id="btn-qr-sender"
          onClick={() => { setSubMode('send'); stopCamera(); }}
          className={`flex-1 py-1.5 px-3 text-xs font-medium rounded-md transition-all ${
            subMode === 'send'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Sender (Slideshow)
        </button>
        <button
          id="btn-qr-receiver"
          onClick={() => { setSubMode('receive'); }}
          className={`flex-1 py-1.5 px-3 text-xs font-medium rounded-md transition-all ${
            subMode === 'receive'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Receiver (Scanner)
        </button>
      </div>

      {/* --- SENDER SIDE --- */}
      {subMode === 'send' && (
        <div className="max-w-2xl mx-auto space-y-6">
          {!sendFile ? (
            <div
              ref={dragRef}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className="border-2 border-dashed border-slate-200 rounded-xl p-10 text-center cursor-pointer hover:border-slate-400 transition-all bg-white"
              onClick={() => document.getElementById('qr-file-input')?.click()}
            >
              <input
                id="qr-file-input"
                type="file"
                className="hidden"
                onChange={handleFileSelect}
              />
              <div className="flex flex-col items-center space-y-3">
                <div className="p-3 bg-slate-50 rounded-full text-slate-600">
                  <Upload className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-800">Drag & drop your file here</p>
                  <p className="text-xs text-slate-500 mt-1">or click to browse your storage</p>
                </div>
                <div className="pt-2">
                  <span className="text-[10px] uppercase font-mono tracking-wider bg-slate-100 text-slate-600 px-2.5 py-1 rounded">
                    Offline Optical Transfer
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6 bg-white p-6 border border-slate-200 rounded-xl">
              {/* Slideshow Display Canvas */}
              <div className="md:col-span-7 flex flex-col items-center justify-center space-y-4">
                <div className="relative p-3 border border-slate-200 rounded-xl bg-white shadow-sm flex items-center justify-center w-full max-w-[400px] aspect-square">
                  {isPreparing ? (
                    <div className="flex flex-col items-center space-y-3">
                      <RefreshCw className="w-8 h-8 text-slate-500 animate-spin" />
                      <p className="text-xs text-slate-500 font-mono">Preparing QR codes...</p>
                    </div>
                  ) : (
                    <canvas ref={canvasRef} className="w-full max-w-[360px]" id="sender-qr-canvas" />
                  )}
                  
                  {/* Overlay Pause Indicator */}
                  {!isPlaying && !isPreparing && (
                    <div className="absolute inset-0 bg-white/70 backdrop-blur-[1px] flex items-center justify-center rounded-xl">
                      <div className="bg-slate-900 text-white rounded-full p-3 shadow-md">
                        <Pause className="w-6 h-6 fill-white" />
                      </div>
                    </div>
                  )}
                </div>

                {/* Slideshow Controls */}
                <div className="flex items-center justify-between w-full max-w-[380px] px-2">
                  <div className="flex items-center space-x-2">
                    <button
                      id="btn-sender-prev"
                      onClick={() => {
                        setIsPlaying(false);
                        setActiveFrameIndex((prev) => (prev - 1 + packets.length) % packets.length);
                      }}
                      className="p-1.5 border border-slate-200 rounded hover:bg-slate-50 text-slate-600 active:scale-95 transition-transform"
                      title="Previous Packet"
                    >
                      <SkipBack className="w-4 h-4" />
                    </button>
                    <button
                      id="btn-sender-play"
                      onClick={() => setIsPlaying(!isPlaying)}
                      className={`p-2 rounded shadow-sm text-white active:scale-95 transition-transform ${
                        isPlaying ? 'bg-slate-950 hover:bg-slate-900' : 'bg-emerald-600 hover:bg-emerald-500'
                      }`}
                      title={isPlaying ? 'Pause Loop' : 'Start Playback Loop'}
                    >
                      {isPlaying ? <Pause className="w-4 h-4 fill-white" /> : <Play className="w-4 h-4 fill-white" />}
                    </button>
                    <button
                      id="btn-sender-next"
                      onClick={() => {
                        setIsPlaying(false);
                        setActiveFrameIndex((prev) => (prev + 1) % packets.length);
                      }}
                      className="p-1.5 border border-slate-200 rounded hover:bg-slate-50 text-slate-600 active:scale-95 transition-transform"
                      title="Next Packet"
                    >
                      <SkipForward className="w-4 h-4" />
                    </button>
                  </div>

                  <span className="text-xs font-mono font-medium text-slate-700 bg-slate-100 px-2.5 py-1 rounded">
                    Packet {activeFrameIndex + 1} / {packets.length}
                  </span>
                </div>
              </div>

              {/* Information & Settings panel */}
              <div className="md:col-span-5 flex flex-col justify-between space-y-6">
                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="text-sm font-semibold text-slate-950 line-clamp-2" title={sendFile.name}>
                        {sendFile.name}
                      </h4>
                      <p className="text-xs text-slate-500 font-mono mt-0.5">{formatSize(sendFile.size)}</p>
                    </div>
                    <button
                      id="btn-reset-sender"
                      onClick={() => {
                        setSendFile(null);
                        setSendMetadata(null);
                        setPackets([]);
                        setActiveFrameIndex(0);
                      }}
                      className="text-xs font-mono text-rose-600 hover:text-rose-700 font-semibold border border-rose-100 bg-rose-50/50 hover:bg-rose-50 px-2 py-1 rounded"
                    >
                      Clear File
                    </button>
                  </div>

                  <div className="border border-slate-100 rounded-lg p-3 bg-slate-50/30 text-xs space-y-2 font-mono text-slate-600">
                    <div className="flex justify-between">
                      <span>Compressed:</span>
                      <span className="text-slate-900 font-medium">
                        {sendMetadata ? formatSize(sendMetadata.compressedSize) : '-'}
                        {sendMetadata && (
                          <span className="text-emerald-600 text-[10px] ml-1">
                            ({Math.round((sendMetadata.compressedSize / sendMetadata.size) * 100)}%)
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Total Packets:</span>
                      <span className="text-slate-900 font-medium">{packets.length}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Checksum:</span>
                      <span className="text-slate-900 font-medium" title={sendMetadata?.hash}>
                        {sendMetadata ? `${sendMetadata.hash.slice(0, 8)}...${sendMetadata.hash.slice(-8)}` : '-'}
                      </span>
                    </div>
                  </div>

                  {/* Settings toggle */}
                  <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
                    <button
                      id="btn-toggle-sender-settings"
                      onClick={() => setShowSenderSettings(!showSenderSettings)}
                      className="w-full flex items-center justify-between p-3 text-xs font-semibold text-slate-800 bg-slate-50 border-b border-slate-100 hover:bg-slate-100/70"
                    >
                      <div className="flex items-center space-x-2">
                        <Settings className="w-3.5 h-3.5" />
                        <span>Transmission Settings</span>
                      </div>
                      <ChevronRight className={`w-4 h-4 transform transition-transform ${showSenderSettings ? 'rotate-90' : ''}`} />
                    </button>
                    {showSenderSettings && (
                      <div className="p-3 space-y-3.5 text-xs">
                        <div>
                          <label className="block text-[11px] font-mono text-slate-500 mb-1">
                            PLAYBACK FPS: {fps} ({Math.round(1000 / fps)}ms)
                          </label>
                          <input
                            id="input-fps-range"
                            type="range"
                            min="1"
                            max="20"
                            step="1"
                            value={fps}
                            onChange={(e) => setFps(parseInt(e.target.value, 10))}
                            className="w-full accent-slate-900"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-mono text-slate-500 mb-1">
                            PACKET SIZE: {packetSize} bytes
                          </label>
                          <select
                            id="select-packet-size"
                            value={packetSize}
                            onChange={(e) => {
                              setPacketSize(parseInt(e.target.value, 10));
                              setTimeout(handleSettingsChange, 50);
                            }}
                            className="w-full border border-slate-200 rounded px-2 py-1 font-mono text-xs bg-white text-slate-800"
                          >
                            <option value="150">150 bytes (Compact - Quick focus)</option>
                            <option value="250">250 bytes (Standard Lite)</option>
                            <option value="400">400 bytes (Balanced - Recommended)</option>
                            <option value="600">600 bytes (High Density)</option>
                            <option value="1000">1000 bytes (Super Dense - Requires high-res screen)</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-[11px] font-mono text-slate-500 mb-1">
                            QR ERROR CORRECTION: {qrDensity}
                          </label>
                          <div className="flex space-x-1">
                            {(['L', 'M', 'H'] as const).map((lvl) => (
                              <button
                                key={lvl}
                                id={`btn-ec-level-${lvl}`}
                                onClick={() => {
                                  setQrDensity(lvl);
                                  setTimeout(handleSettingsChange, 50);
                                }}
                                className={`flex-1 py-1 px-2 text-center font-mono rounded text-[10px] border transition-all ${
                                  qrDensity === lvl
                                    ? 'bg-slate-900 text-white border-slate-900'
                                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                                }`}
                              >
                                {lvl === 'L' ? 'Low (L) - Best Capacity' : lvl === 'M' ? 'Medium (M)' : 'High (H)'}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Packet Defragmentation Grid */}
                <div className="space-y-2">
                  <span className="text-[10px] font-mono font-bold tracking-wider text-slate-500 uppercase">
                    Interactive Segment Map (Looping)
                  </span>
                  <div className="border border-slate-200 rounded-lg p-2 max-h-[140px] overflow-y-auto bg-slate-50/50">
                    <div className="grid grid-cols-8 gap-1.5">
                      {packets.map((_, idx) => (
                        <button
                          key={idx}
                          id={`btn-sender-packet-block-${idx}`}
                          onClick={() => {
                            setIsPlaying(false);
                            setActiveFrameIndex(idx);
                          }}
                          className={`aspect-square rounded text-[10px] font-mono transition-all ${
                            activeFrameIndex === idx
                              ? 'bg-slate-900 text-white font-bold ring-2 ring-offset-1 ring-slate-950 scale-105'
                              : 'bg-slate-200/80 text-slate-600 hover:bg-slate-300'
                          }`}
                        >
                          {idx + 1}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-400 font-mono italic">
                    Click any segment above to freeze the loop on that specific packet for easy manual scanning.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* --- RECEIVER SIDE --- */}
      {subMode === 'receive' && (
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="bg-white p-6 border border-slate-200 rounded-xl space-y-6">
            {/* Action Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h4 className="text-sm font-semibold text-slate-950 flex items-center space-x-2">
                  <Camera className="w-4 h-4" />
                  <span>Continuous Scanner</span>
                </h4>
                <p className="text-xs text-slate-500">Align with the sender's slideshow to receive the file.</p>
              </div>

              <div className="flex space-x-2">
                <button
                  id="btn-toggle-camera"
                  onClick={isCameraActive ? stopCamera : startCamera}
                  className={`flex items-center space-x-2 py-1.5 px-3 rounded-lg text-xs font-semibold shadow-sm transition-all ${
                    isCameraActive
                      ? 'bg-rose-600 hover:bg-rose-500 text-white'
                      : 'bg-slate-950 hover:bg-slate-900 text-white'
                  }`}
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>{isCameraActive ? 'Stop Camera' : 'Start Camera'}</span>
                </button>
                {(recvProgress.isActive || recvProgress.isComplete) && (
                  <button
                    id="btn-reset-receiver"
                    onClick={resetReceiver}
                    className="flex items-center space-x-1.5 py-1.5 px-3 rounded-lg text-xs font-semibold border border-slate-200 hover:bg-slate-50 text-slate-600"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Reset</span>
                  </button>
                )}
              </div>
            </div>

            {/* Camera Viewport */}
            {isCameraActive && (
              <div className="relative border border-slate-200 rounded-xl bg-slate-950 overflow-hidden w-full aspect-video flex items-center justify-center">
                <video
                  ref={videoRef}
                  className="w-full h-full object-cover"
                  playsInline
                  muted
                />
                
                {/* Visual Scanner Overlay Guides */}
                <div className="absolute inset-0 border-2 border-slate-950/20 pointer-events-none flex items-center justify-center">
                  <div className="w-64 h-64 border-2 border-dashed border-emerald-500/80 rounded-lg relative flex items-center justify-center">
                    <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-emerald-500" />
                    <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-emerald-500" />
                    <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-emerald-500" />
                    <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-emerald-500" />
                    
                    {/* Laser line effect */}
                    <div className="w-full h-0.5 bg-emerald-500/60 shadow-[0_0_8px_rgba(16,185,129,0.8)] absolute animate-[bounce_2.5s_infinite]" />
                  </div>
                </div>

                {/* Status badges */}
                <div className="absolute top-3 right-3 flex space-x-2">
                  <span className="text-[10px] font-mono bg-emerald-600/90 text-white font-bold uppercase tracking-wider px-2 py-0.5 rounded shadow">
                    Active
                  </span>
                  {lastScannedIndex !== null && (
                    <span className="text-[10px] font-mono bg-slate-900/90 text-white px-2 py-0.5 rounded shadow">
                      Scanned: #{lastScannedIndex + 1}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Hidden canvas for decoding frames */}
            <canvas ref={scanCanvasRef} className="hidden" />

            {/* Error alerts */}
            {cameraError && (
              <div className="p-3 bg-rose-50 border border-rose-100 rounded-lg text-rose-800 text-xs flex items-start space-x-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{cameraError}</span>
              </div>
            )}

            {recvProgress.error && (
              <div className="p-3 bg-rose-50 border border-rose-100 rounded-lg text-rose-800 text-xs flex items-start space-x-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{recvProgress.error}</span>
              </div>
            )}

            {recentFails && (
              <div className="p-2.5 bg-amber-50 border border-amber-100 rounded-lg text-amber-800 text-[11px] flex items-center space-x-2">
                <Info className="w-3.5 h-3.5 text-amber-600" />
                <span>{recentFails}</span>
              </div>
            )}

            {/* Active Transfer Info & Status */}
            {recvProgress.fileId && (
              <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50/20">
                {/* File summary header */}
                <div className="p-4 bg-slate-50 border-b border-slate-150 flex flex-col sm:flex-row justify-between sm:items-center gap-2">
                  <div>
                    <h5 className="text-xs font-semibold text-slate-900 flex items-center space-x-1.5">
                      <File className="w-3.5 h-3.5 text-slate-700" />
                      <span className="break-all">{recvProgress.fileName}</span>
                    </h5>
                    <p className="text-[10px] font-mono text-slate-500 mt-1">
                      File ID: <span className="text-slate-700 font-semibold">{recvProgress.fileId}</span> | Expected Size: {formatSize(recvProgress.fileSize)}
                    </p>
                  </div>

                  <div className="flex sm:flex-col items-start sm:items-end justify-between font-mono text-[10px] text-slate-500">
                    <div>
                      PPS: <span className="text-slate-900 font-semibold">{recvProgress.packetsPerSecond} /s</span>
                    </div>
                    <div>
                      Time: <span className="text-slate-900 font-semibold">{((Date.now() - recvProgress.startTime)/1000).toFixed(0)}s</span>
                    </div>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="p-4 space-y-4">
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs font-mono">
                      <span className="text-slate-600 font-medium">Reconstruction Progress:</span>
                      <span className="text-slate-900 font-bold">
                        {recvProgress.receivedCount} / {recvProgress.totalPackets} ({Math.round((recvProgress.receivedCount / recvProgress.totalPackets) * 100)}%)
                      </span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
                      <div 
                        className="h-full bg-slate-900 transition-all duration-150 ease-out" 
                        style={{ width: `${(recvProgress.receivedCount / recvProgress.totalPackets) * 100}%` }}
                      />
                    </div>
                    {estimatedTimeRemaining && !recvProgress.isComplete && (
                      <p className="text-[10px] text-slate-500 font-mono">
                        Estimated remaining: <span className="text-slate-800 font-semibold">{estimatedTimeRemaining}</span> (Ensure direct focus on sender QR)
                      </p>
                    )}
                  </div>

                  {/* Defragmentation blocks map */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] font-mono font-bold tracking-wider text-slate-500 uppercase">
                        Segment Verification Matrix
                      </span>
                      {missingPackets.length > 0 && missingPackets.length <= 15 && (
                        <span className="text-[9px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                          Missing: {missingPackets.map(i => i + 1).join(', ')}
                        </span>
                      )}
                    </div>
                    
                    <div className="border border-slate-200 rounded-lg p-2.5 max-h-[140px] overflow-y-auto bg-white shadow-inner">
                      <div className="grid grid-cols-10 gap-1">
                        {Array.from({ length: recvProgress.totalPackets }).map((_, idx) => {
                          const received = !!recvProgress.receivedMap[idx];
                          const isLast = lastScannedIndex === idx;
                          return (
                            <div
                              key={idx}
                              className={`aspect-square rounded-[3px] text-[9px] font-mono flex items-center justify-center transition-all ${
                                received
                                  ? isLast
                                    ? 'bg-emerald-500 text-white font-bold scale-105 shadow-sm ring-1 ring-emerald-400'
                                    : 'bg-slate-900 text-white'
                                  : 'bg-slate-100 text-slate-400 border border-slate-200/50'
                              }`}
                              title={`Segment ${idx + 1}: ${received ? 'Received' : 'Pending'}`}
                            >
                              {idx + 1}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-400 font-mono italic">
                      Continuous scanning aggregates segments. If a segment is stuck, tap it on the Sender's segment map to isolate its QR code.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Waiting placeholder */}
            {!isCameraActive && !recvProgress.fileId && (
              <div className="border border-dashed border-slate-200 rounded-xl p-10 text-center text-slate-400 font-mono text-xs">
                Camera offline. Click "Start Camera" above and hold your device facing the sender's slideshow.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
