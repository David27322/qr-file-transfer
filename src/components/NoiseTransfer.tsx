/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useMemo } from 'react';
import { 
  Upload, File, Download, CheckCircle, AlertCircle, RefreshCw, 
  Settings, Grid, ChevronRight, HelpCircle
} from 'lucide-react';
import { 
  calculateSHA256, bytesToBase64, base64ToBytes, generateShortId 
} from '../utils/crypto';
import { compressData, decompressData } from '../utils/compress';
import { NoiseImageHeader } from '../types';

export default function NoiseTransfer() {
  const [subMode, setSubMode] = useState<'generate' | 'decode'>('generate');

  // --- GENERATOR STATE ---
  const [genFile, setGenFile] = useState<File | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [gridSize, setGridSize] = useState<number>(1024); // Canvas width/height (1024x1024)
  const [noiseImages, setNoiseImages] = useState<{
    dataUrl: string;
    index: number;
    total: number;
    fileName: string;
  }[]>([]);
  const [genStats, setGenStats] = useState<{
    originalSize: number;
    compressedSize: number;
    totalImages: number;
    hash: string;
  } | null>(null);
  const [showGenSettings, setShowGenSettings] = useState(false);

  // --- DECODER STATE ---
  const [decodeProgress, setDecodeProgress] = useState<{
    fileId: string | null;
    fileName: string;
    fileType: string;
    originalSize: number;
    compressedSize: number;
    hash: string;
    totalImages: number;
    uploadedCount: number;
    uploadedMap: Record<number, Uint8Array>;
    isComplete: boolean;
    error: string | null;
  }>({
    fileId: null,
    fileName: '',
    fileType: '',
    originalSize: 0,
    compressedSize: 0,
    hash: '',
    totalImages: 0,
    uploadedCount: 0,
    uploadedMap: {},
    isComplete: false,
    error: null,
  });

  const dragGenRef = useRef<HTMLDivElement | null>(null);
  const dragDecRef = useRef<HTMLDivElement | null>(null);

  // Sound effects
  const playSuccess = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const now = audioCtx.currentTime;
      [440, 554.37, 659.25, 880].forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);
        gain.gain.setValueAtTime(0.05, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.08 + 0.2);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.2);
      });
    } catch (e) {
      // Ignored
    }
  };

  // --- BINARY SERIALIZER HELPERS ---
  const buildHeader = (
    index: number,
    total: number,
    originalSize: number,
    compressedSize: number,
    hashHex: string,
    fileName: string,
    mimeType: string
  ): Uint8Array => {
    const header = new Uint8Array(1024);
    
    // Magic bytes: OPTN (Optical Packet Transfer Noise)
    header[0] = 79; // O
    header[1] = 80; // P
    header[2] = 84; // T
    header[3] = 78; // N
    
    // Image index (2 bytes)
    header[4] = (index >> 8) & 0xff;
    header[5] = index & 0xff;
    
    // Total images (2 bytes)
    header[6] = (total >> 8) & 0xff;
    header[7] = total & 0xff;
    
    // Original size (4 bytes)
    header[8] = (originalSize >> 24) & 0xff;
    header[9] = (originalSize >> 16) & 0xff;
    header[10] = (originalSize >> 8) & 0xff;
    header[11] = originalSize & 0xff;
    
    // Compressed size (4 bytes)
    header[12] = (compressedSize >> 24) & 0xff;
    header[13] = (compressedSize >> 16) & 0xff;
    header[14] = (compressedSize >> 8) & 0xff;
    header[15] = compressedSize & 0xff;
    
    // SHA-256 hash hex to 32 bytes
    for (let i = 0; i < 32; i++) {
      const hexPair = hashHex.slice(i * 2, i * 2 + 2);
      header[16 + i] = parseInt(hexPair, 16);
    }
    
    // Filename (64 bytes max UTF-8)
    const nameBytes = new TextEncoder().encode(fileName);
    const nameToCopy = nameBytes.subarray(0, 64);
    header.set(nameToCopy, 48);
    
    // MIME type (64 bytes max UTF-8)
    const mimeBytes = new TextEncoder().encode(mimeType);
    const mimeToCopy = mimeBytes.subarray(0, 64);
    header.set(mimeToCopy, 112);
    
    return header;
  };

  const parseHeader = (header: Uint8Array): NoiseImageHeader | null => {
    // Check magic signature "OPTN"
    if (header[0] !== 79 || header[1] !== 80 || header[2] !== 84 || header[3] !== 78) {
      return null;
    }
    
    const index = (header[4] << 8) | header[5];
    const total = (header[6] << 8) | header[7];
    const originalSize = ((header[8] << 24) | (header[9] << 16) | (header[10] << 8) | header[11]) >>> 0;
    const compressedSize = ((header[12] << 24) | (header[13] << 16) | (header[14] << 8) | header[15]) >>> 0;
    
    // Hex hash
    let hash = '';
    for (let i = 0; i < 32; i++) {
      hash += header[16 + i].toString(16).padStart(2, '0');
    }
    
    // Filename
    let nameEnd = 48;
    while (nameEnd < 48 + 64 && header[nameEnd] !== 0) {
      nameEnd++;
    }
    const name = new TextDecoder().decode(header.subarray(48, nameEnd));
    
    // MIME Type
    let mimeEnd = 112;
    while (mimeEnd < 112 + 64 && header[mimeEnd] !== 0) {
      mimeEnd++;
    }
    const type = new TextDecoder().decode(header.subarray(112, mimeEnd)) || 'application/octet-stream';
    
    return { magic: 'OPTN', index, total, originalSize, compressedSize, hash, name, type };
  };

  // --- DENSE IMAGE GENERATOR ---
  const generateNoiseImages = async (file: File) => {
    setIsGenerating(true);
    setGenFile(file);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const rawBytes = new Uint8Array(arrayBuffer);
      
      // 1. Compute original hash
      const fileHash = await calculateSHA256(rawBytes);
      
      // 2. Compress data
      const compressed = await compressData(rawBytes);
      const compressedSize = compressed.byteLength;
      
      // 3. Calculate capacities
      // Each pixel holds 3 bytes (R, G, B). Alpha is fixed to 255.
      const pixelsPerImage = gridSize * gridSize;
      const totalBytesPerImage = pixelsPerImage * 3;
      const payloadBytesPerImage = totalBytesPerImage - 1024; // reserve 1024 bytes for header
      
      const totalImages = Math.ceil(compressedSize / payloadBytesPerImage);
      
      setGenStats({
        originalSize: file.size,
        compressedSize,
        totalImages,
        hash: fileHash,
      });

      const tempImages: typeof noiseImages = [];
      
      for (let i = 0; i < totalImages; i++) {
        const startOffset = i * payloadBytesPerImage;
        const endOffset = Math.min(startOffset + payloadBytesPerImage, compressedSize);
        const chunkPayload = compressed.subarray(startOffset, endOffset);
        
        // Build this frame's 1024-byte header
        const headerBytes = buildHeader(
          i,
          totalImages,
          file.size,
          compressedSize,
          fileHash,
          file.name,
          file.type || 'application/octet-stream'
        );
        
        // Assemble entire image byte array
        const imageBytes = new Uint8Array(totalBytesPerImage);
        imageBytes.set(headerBytes, 0);
        imageBytes.set(chunkPayload, 1024);
        
        // Fill remaining padding with uniform random noise to maintain beautiful visual noise density
        if (imageBytes.length > 1024 + chunkPayload.length) {
          const paddingStart = 1024 + chunkPayload.length;
          for (let p = paddingStart; p < imageBytes.length; p++) {
            imageBytes[p] = Math.floor(Math.random() * 256);
          }
        }
        
        // Draw to offscreen canvas
        const canvas = document.createElement('canvas');
        canvas.width = gridSize;
        canvas.height = gridSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not create offscreen 2D canvas context');
        
        const imgData = ctx.createImageData(gridSize, gridSize);
        const data = imgData.data;
        
        for (let pixelIdx = 0; pixelIdx < pixelsPerImage; pixelIdx++) {
          const srcByteIdx = pixelIdx * 3;
          const destRGBAIdx = pixelIdx * 4;
          
          data[destRGBAIdx + 0] = imageBytes[srcByteIdx + 0]; // R
          data[destRGBAIdx + 1] = imageBytes[srcByteIdx + 1]; // G
          data[destRGBAIdx + 2] = imageBytes[srcByteIdx + 2]; // B
          data[destRGBAIdx + 3] = 255;                         // A (solid opacity)
        }
        
        ctx.putImageData(imgData, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        
        // Clean up file name structure for download
        const suffix = totalImages > 1 ? `_part_${i + 1}_of_${totalImages}` : '';
        const exportName = `${file.name.split('.')[0]}_noise${suffix}.png`;
        
        tempImages.push({
          dataUrl,
          index: i,
          total: totalImages,
          fileName: exportName,
        });
      }
      
      setNoiseImages(tempImages);
    } catch (err) {
      console.error('Dense noise generation failed:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  // Drag and drop for generator
  const handleDragOverGen = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragGenRef.current) {
      dragGenRef.current.classList.add('border-slate-800', 'bg-slate-50/50');
    }
  };

  const handleDragLeaveGen = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragGenRef.current) {
      dragGenRef.current.classList.remove('border-slate-800', 'bg-slate-50/50');
    }
  };

  const handleDropGen = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragGenRef.current) {
      dragGenRef.current.classList.remove('border-slate-800', 'bg-slate-50/50');
    }
    const file = e.dataTransfer.files?.[0];
    if (file) generateNoiseImages(file);
  };

  // --- DENSE IMAGE DECODER ---
  const handleNoiseImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      processUploadedImages(Array.from(files));
    }
  };

  const processUploadedImages = async (files: File[]) => {
    setDecodeProgress((prev) => ({ ...prev, error: null }));
    
    for (const file of files) {
      try {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });
        
        const img = new Image();
        img.src = dataUrl;
        
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error(`Failed to load image: ${file.name}`));
        });
        
        // Draw to offscreen canvas to extract pixel bytes
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not create offscreen canvas context for decode');
        
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;
        const totalPixels = canvas.width * canvas.height;
        
        // Reconstruct binary flat array (3 bytes per pixel)
        const flatBytes = new Uint8Array(totalPixels * 3);
        for (let pixelIdx = 0; pixelIdx < totalPixels; pixelIdx++) {
          const destRGBAIdx = pixelIdx * 4;
          const srcByteIdx = pixelIdx * 3;
          
          flatBytes[srcByteIdx + 0] = data[destRGBAIdx + 0]; // R
          flatBytes[srcByteIdx + 1] = data[destRGBAIdx + 1]; // G
          flatBytes[srcByteIdx + 2] = data[destRGBAIdx + 2]; // B
        }
        
        // Parse first 1024 bytes header
        const header = parseHeader(flatBytes.subarray(0, 1024));
        if (!header) {
          throw new Error(`The file "${file.name}" is not a valid high-density OPTN noise image.`);
        }
        
        // Extract compressed payload bytes
        const capacityPerImage = (canvas.width * canvas.height * 3) - 1024;
        const payloadStart = 1024;
        let payloadLength = capacityPerImage;
        if (header.index === header.total - 1) {
          payloadLength = header.compressedSize - (header.index * capacityPerImage);
        }
        
        const payloadBytes = flatBytes.subarray(payloadStart, payloadStart + payloadLength);
        
        // Update decoder state
        setDecodeProgress((prev) => {
          const isNewFile = prev.hash !== header.hash;
          const map = isNewFile ? {} : { ...prev.uploadedMap };
          
          // Store frame payload
          map[header.index] = payloadBytes;
          
          const updatedCount = Object.keys(map).length;
          const isNowComplete = updatedCount === header.total;
          
          const nextProgress = {
            fileId: header.hash.slice(0, 8),
            fileName: header.name,
            fileType: header.type,
            originalSize: header.originalSize,
            compressedSize: header.compressedSize,
            hash: header.hash,
            totalImages: header.total,
            uploadedCount: updatedCount,
            uploadedMap: map,
            isComplete: isNowComplete,
            error: null,
          };
          
          // If fully assembled, trigger the reassembly & download!
          if (isNowComplete) {
            setTimeout(() => assembleAndDownloadNoiseFile(nextProgress), 100);
          }
          
          return nextProgress;
        });
        
      } catch (err: any) {
        console.error('Error decoding file:', err);
        setDecodeProgress((prev) => ({
          ...prev,
          error: err.message || 'Failed to decode uploaded noise image.'
        }));
      }
    }
  };

  const assembleAndDownloadNoiseFile = async (progress: typeof decodeProgress) => {
    try {
      // 1. Concat payload parts in order
      const mergedBytes = new Uint8Array(progress.compressedSize);
      let offset = 0;
      for (let i = 0; i < progress.totalImages; i++) {
        const part = progress.uploadedMap[i];
        if (!part) {
          throw new Error(`Missing part ${i + 1} of ${progress.totalImages}`);
        }
        mergedBytes.set(part, offset);
        offset += part.byteLength;
      }
      
      // 2. Decompress
      const originalBytes = await decompressData(mergedBytes);
      
      // 3. Verify Checksum
      const computedHash = await calculateSHA256(originalBytes);
      if (computedHash !== progress.hash) {
        throw new Error('Verification failed: SHA-256 file checksum does not match expectations. The file may be corrupt.');
      }
      
      // 4. Download
      const blob = new Blob([originalBytes], { type: progress.fileType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = progress.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      playSuccess();
    } catch (err: any) {
      console.error(err);
      setDecodeProgress((prev) => ({
        ...prev,
        error: err.message || 'An error occurred during reassembly/checksum check.'
      }));
    }
  };

  // Drag & drop decoder
  const handleDragOverDec = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragDecRef.current) {
      dragDecRef.current.classList.add('border-slate-800', 'bg-slate-50/50');
    }
  };

  const handleDragLeaveDec = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragDecRef.current) {
      dragDecRef.current.classList.remove('border-slate-800', 'bg-slate-50/50');
    }
  };

  const handleDropDec = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragDecRef.current) {
      dragDecRef.current.classList.remove('border-slate-800', 'bg-slate-50/50');
    }
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processUploadedImages(Array.from(files));
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const getTheoreticalMaxBytes = (size: number) => {
    return Math.floor((size * size * 3) - 1024);
  };

  return (
    <div className="space-y-6">
      {/* Tab Selector */}
      <div className="flex border border-slate-200 rounded-lg p-1 bg-slate-50/50 max-w-xs mx-auto">
        <button
          id="btn-noise-generator"
          onClick={() => setSubMode('generate')}
          className={`flex-1 py-1.5 px-3 text-xs font-medium rounded-md transition-all ${
            subMode === 'generate'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Noise Encoder
        </button>
        <button
          id="btn-noise-decoder"
          onClick={() => setSubMode('decode')}
          className={`flex-1 py-1.5 px-3 text-xs font-medium rounded-md transition-all ${
            subMode === 'decode'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Noise Decoder
        </button>
      </div>

      {/* --- GENERATOR PANEL --- */}
      {subMode === 'generate' && (
        <div className="max-w-2xl mx-auto space-y-6">
          {!genFile ? (
            <div
              ref={dragGenRef}
              onDragOver={handleDragOverGen}
              onDragLeave={handleDragLeaveGen}
              onDrop={handleDropGen}
              className="border-2 border-dashed border-slate-200 rounded-xl p-10 text-center cursor-pointer hover:border-slate-400 transition-all bg-white"
              onClick={() => document.getElementById('noise-file-input')?.click()}
            >
              <input
                id="noise-file-input"
                type="file"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && generateNoiseImages(e.target.files[0])}
              />
              <div className="flex flex-col items-center space-y-3">
                <div className="p-3 bg-slate-50 rounded-full text-slate-600">
                  <Grid className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-800">Select any file to encode as noise</p>
                  <p className="text-xs text-slate-500 mt-1">supports text, pdf, docx, or binary of any size</p>
                </div>
                <div className="pt-2">
                  <span className="text-[10px] uppercase font-mono tracking-wider bg-slate-100 text-slate-600 px-2.5 py-1 rounded">
                    High-Density Lossless Static
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white p-6 border border-slate-200 rounded-xl space-y-6">
              {/* Header Info */}
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="text-sm font-semibold text-slate-950 flex items-center space-x-2">
                    <File className="w-4 h-4" />
                    <span className="break-all">{genFile.name}</span>
                  </h4>
                  <p className="text-xs text-slate-500 font-mono mt-0.5">{formatSize(genFile.size)}</p>
                </div>
                
                <button
                  id="btn-reset-generator"
                  onClick={() => {
                    setGenFile(null);
                    setNoiseImages([]);
                    setGenStats(null);
                  }}
                  className="text-xs font-mono text-rose-600 hover:text-rose-700 font-semibold border border-rose-100 bg-rose-50/50 hover:bg-rose-50 px-2.5 py-1 rounded"
                >
                  Clear File
                </button>
              </div>

              {/* Settings Dropdown */}
              <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
                <button
                  id="btn-toggle-noise-settings"
                  onClick={() => setShowGenSettings(!showGenSettings)}
                  className="w-full flex items-center justify-between p-3 text-xs font-semibold text-slate-800 bg-slate-50 border-b border-slate-100 hover:bg-slate-100/70"
                >
                  <div className="flex items-center space-x-2">
                    <Settings className="w-3.5 h-3.5" />
                    <span>Resolution Configuration</span>
                  </div>
                  <ChevronRight className={`w-4 h-4 transform transition-transform ${showGenSettings ? 'rotate-90' : ''}`} />
                </button>
                {showGenSettings && (
                  <div className="p-4 space-y-4 text-xs font-mono text-slate-600">
                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">
                        Target Image Matrix:
                      </label>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {[512, 1024, 2048, 4096].map((size) => (
                          <button
                            key={size}
                            id={`btn-matrix-size-${size}`}
                            onClick={() => {
                              setGridSize(size);
                              if (genFile) generateNoiseImages(genFile);
                            }}
                            className={`p-2.5 rounded-lg border text-center transition-all flex flex-col items-center justify-center space-y-1 ${
                              gridSize === size
                                ? 'bg-slate-900 border-slate-900 text-white shadow-sm font-bold'
                                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                            }`}
                          >
                            <span className="text-xs font-semibold">{size} × {size}</span>
                            <span className="text-[9px] opacity-80 font-mono">
                              Max: {formatSize(getTheoreticalMaxBytes(size))}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="p-3 bg-amber-50/50 border border-amber-100 rounded-lg text-[10px] text-amber-800 leading-relaxed font-sans">
                      <HelpCircle className="w-3.5 h-3.5 text-amber-600 inline-block mr-1.5 -translate-y-0.5" />
                      We compress the original file via gzip, then slice the payload into a grid of 100% lossless PNG pixels. Choosing larger matrices (e.g., 2048px or 4096px) squeezes huge files into a single noise canvas, while smaller matrices are faster to process on ultra-low spec browsers.
                    </div>
                  </div>
                )}
              </div>

              {/* Stats overview */}
              {genStats && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 bg-slate-50/50 p-4 border border-slate-100 rounded-xl font-mono text-xs">
                  <div className="space-y-0.5">
                    <span className="text-slate-400 block text-[10px]">COMPRESSED SIZE</span>
                    <span className="font-bold text-slate-900">{formatSize(genStats.compressedSize)}</span>
                  </div>
                  <div className="space-y-0.5">
                    <span className="text-slate-400 block text-[10px]">RATIO</span>
                    <span className="font-bold text-emerald-600">
                      {Math.round((genStats.compressedSize / genStats.originalSize) * 100)}%
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    <span className="text-slate-400 block text-[10px]">GRID RESOLUTION</span>
                    <span className="font-bold text-slate-900">{gridSize} × {gridSize} px</span>
                  </div>
                  <div className="space-y-0.5">
                    <span className="text-slate-400 block text-[10px]">TOTAL IMAGES</span>
                    <span className="font-bold text-slate-900">{genStats.totalImages} Frame(s)</span>
                  </div>
                </div>
              )}

              {/* List of generated noise images */}
              {noiseImages.length > 0 && (
                <div className="space-y-3.5">
                  <h5 className="text-xs font-bold font-mono text-slate-500 uppercase tracking-wider">
                    Generated Lossless Noise Frames
                  </h5>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {noiseImages.map((img) => (
                      <div key={img.index} className="border border-slate-200 rounded-xl p-3.5 flex flex-col justify-between space-y-3 bg-white hover:border-slate-300 shadow-sm transition-all">
                        <div className="flex items-center space-x-3">
                          {/* Image Thumbnail Preview */}
                          <div className="w-16 h-16 border border-slate-200 rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center shrink-0">
                            <img
                              src={img.dataUrl}
                              alt={`Noise frame ${img.index + 1}`}
                              className="w-full h-full object-cover select-none image-render-pixelated"
                            />
                          </div>
                          
                          <div className="font-mono text-xs text-slate-600">
                            <span className="text-slate-900 font-bold block">Frame {img.index + 1} of {img.total}</span>
                            <span className="text-[10px] text-slate-500 block mt-1">Format: sRGB Lossless PNG</span>
                          </div>
                        </div>
                        
                        <a
                          id={`btn-download-noise-frame-${img.index}`}
                          href={img.dataUrl}
                          download={img.fileName}
                          className="w-full py-1.5 px-3 bg-slate-950 hover:bg-slate-900 text-white rounded-lg text-xs font-semibold text-center flex items-center justify-center space-x-1.5 shadow-sm active:scale-98 transition-transform"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Save Frame {img.index + 1}</span>
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {isGenerating && (
                <div className="flex flex-col items-center justify-center py-10 space-y-3">
                  <RefreshCw className="w-8 h-8 text-slate-500 animate-spin" />
                  <p className="text-xs text-slate-500 font-mono">Pixelating & mapping file structures to high-density noise matrix...</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* --- DECODER PANEL --- */}
      {subMode === 'decode' && (
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="bg-white p-6 border border-slate-200 rounded-xl space-y-6">
            <div>
              <h4 className="text-sm font-semibold text-slate-950 flex items-center space-x-2">
                <Upload className="w-4 h-4" />
                <span>Noise Upload Decoder</span>
              </h4>
              <p className="text-xs text-slate-500">Upload the exact lossless PNG frames to recover the original file structures.</p>
            </div>

            {/* Upload Zone */}
            <div
              ref={dragDecRef}
              onDragOver={handleDragOverDec}
              onDragLeave={handleDragLeaveDec}
              onDrop={handleDropDec}
              className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center cursor-pointer hover:border-slate-400 transition-all bg-slate-50/20"
              onClick={() => document.getElementById('decode-file-input')?.click()}
            >
              <input
                id="decode-file-input"
                type="file"
                multiple
                accept="image/png"
                className="hidden"
                onChange={handleNoiseImageUpload}
              />
              <div className="flex flex-col items-center space-y-3">
                <div className="p-3 bg-white border border-slate-100 rounded-xl text-slate-600 shadow-sm">
                  <Upload className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-800">Select or drop noise PNG images</p>
                  <p className="text-[10px] text-slate-500 mt-1">supports uploading multiple frames in any order</p>
                </div>
              </div>
            </div>

            {/* Decoder Error */}
            {decodeProgress.error && (
              <div className="p-3 bg-rose-50 border border-rose-100 rounded-lg text-rose-800 text-xs flex items-start space-x-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{decodeProgress.error}</span>
              </div>
            )}

            {/* Current Reconstruction Progress */}
            {decodeProgress.fileId && (
              <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50/10">
                {/* Header */}
                <div className="p-4 bg-slate-50 border-b border-slate-150 flex flex-col sm:flex-row justify-between sm:items-center gap-2">
                  <div>
                    <h5 className="text-xs font-semibold text-slate-900 flex items-center space-x-1.5">
                      <File className="w-3.5 h-3.5 text-slate-700" />
                      <span className="break-all">{decodeProgress.fileName}</span>
                    </h5>
                    <p className="text-[10px] font-mono text-slate-500 mt-1">
                      MIME Type: {decodeProgress.fileType} | Target Size: {formatSize(decodeProgress.originalSize)}
                    </p>
                  </div>

                  <button
                    id="btn-reset-decoder"
                    onClick={() => {
                      setDecodeProgress({
                        fileId: null,
                        fileName: '',
                        fileType: '',
                        originalSize: 0,
                        compressedSize: 0,
                        hash: '',
                        totalImages: 0,
                        uploadedCount: 0,
                        uploadedMap: {},
                        isComplete: false,
                        error: null,
                      });
                    }}
                    className="text-xs font-mono text-rose-600 hover:text-rose-700 hover:bg-rose-50 border border-rose-100 px-2 py-0.5 rounded text-left self-start"
                  >
                    Reset
                  </button>
                </div>

                {/* Progress bar */}
                <div className="p-4 space-y-4">
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs font-mono">
                      <span className="text-slate-600">Reconstructed Frames:</span>
                      <span className="text-slate-900 font-bold">
                        {decodeProgress.uploadedCount} / {decodeProgress.totalImages} ({Math.round((decodeProgress.uploadedCount / decodeProgress.totalImages) * 100)}%)
                      </span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
                      <div 
                        className="h-full bg-slate-900 transition-all duration-150" 
                        style={{ width: `${(decodeProgress.uploadedCount / decodeProgress.totalImages) * 100}%` }}
                      />
                    </div>
                  </div>

                  {/* Upload state block matrix */}
                  <div className="space-y-2">
                    <span className="text-[10px] font-mono font-bold tracking-wider text-slate-500 uppercase">
                      Frame Assemblies:
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {Array.from({ length: decodeProgress.totalImages }).map((_, idx) => {
                        const uploaded = !!decodeProgress.uploadedMap[idx];
                        return (
                          <div
                            key={idx}
                            className={`px-3 py-1.5 rounded text-xs font-mono border ${
                              uploaded
                                ? 'bg-slate-950 border-slate-950 text-white font-bold'
                                : 'bg-slate-50 border-slate-200 text-slate-400'
                            }`}
                          >
                            Frame {idx + 1}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {decodeProgress.isComplete && (
                    <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs flex items-center space-x-2">
                      <CheckCircle className="w-4 h-4 text-emerald-600" />
                      <span>Data verified! The file has been fully compiled, decompressed, and downloaded.</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
