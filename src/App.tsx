/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { QrCode, Grid, HelpCircle, Laptop } from 'lucide-react';
import QRTransfer from './components/QRTransfer';
import NoiseTransfer from './components/NoiseTransfer';
import { AppMode } from './types';

export default function App() {
  const [activeMode, setActiveMode] = useState<AppMode>('qr');

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-slate-900 selection:text-white flex flex-col justify-between">
      {/* Upper Layout Frame */}
      <div className="flex-grow py-8 px-4 sm:px-6">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Main Title & Minimal Branding */}
          <header className="text-center space-y-2">
            <h1 className="text-xl font-bold tracking-tight text-slate-950 font-mono flex items-center justify-center space-x-2">
              <Laptop className="w-5 h-5 text-slate-800" />
              <span>OFFLINE OPTICAL TRANSFER</span>
            </h1>
            <p className="text-xs text-slate-500 font-medium max-w-md mx-auto leading-relaxed">
              Transfer files unidirectionally with zero network overhead, Bluetooth, or cables using high-capacity dynamic matrices.
            </p>
          </header>

          {/* Core Transmission Modes Switcher */}
          <div className="flex justify-center">
            <div className="inline-flex p-1 bg-white border border-slate-200 rounded-xl shadow-sm">
              <button
                id="tab-qr-mode"
                onClick={() => setActiveMode('qr')}
                className={`flex items-center space-x-2 py-2 px-4 text-xs font-semibold rounded-lg transition-all ${
                  activeMode === 'qr'
                    ? 'bg-slate-950 text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-950 hover:bg-slate-50'
                }`}
              >
                <QrCode className="w-4 h-4" />
                <span>QR Code Slideshow</span>
              </button>
              
              <button
                id="tab-noise-mode"
                onClick={() => setActiveMode('noise')}
                className={`flex items-center space-x-2 py-2 px-4 text-xs font-semibold rounded-lg transition-all ${
                  activeMode === 'noise'
                    ? 'bg-slate-950 text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-950 hover:bg-slate-50'
                }`}
              >
                <Grid className="w-4 h-4" />
                <span>Dense Color Noise</span>
              </button>
            </div>
          </div>

          {/* Active Area Rendering */}
          <main className="transition-all duration-300">
            {activeMode === 'qr' ? <QRTransfer /> : <NoiseTransfer />}
          </main>
        </div>
      </div>

      {/* Humble Footer containing clear usage directions */}
      <footer className="py-6 border-t border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-4 text-center space-y-4">
          <div className="flex items-center justify-center space-x-1.5 text-slate-500 font-medium text-xs">
            <HelpCircle className="w-4 h-4 text-slate-400" />
            <span>Operational Mechanics</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-left text-[11px] text-slate-500 font-mono leading-relaxed">
            <div className="border border-slate-100 p-3 rounded-lg bg-slate-50/50">
              <span className="font-bold text-slate-800 block mb-1">QR Code Slideshow:</span>
              <span>
                Perfect for screen-to-camera capture. The sender packages and compresses your file into consecutive QR frames and loops them indefinitely. The receiver scans them in any order and assembles them back locally.
              </span>
            </div>

            <div className="border border-slate-100 p-3 rounded-lg bg-slate-50/50">
              <span className="font-bold text-slate-800 block mb-1">Dense Color Noise:</span>
              <span>
                Encodes data bit-by-bit directly into R, G, B channels of pixel color coordinates. One pixel holds 3 full bytes. Spans into multiple PNG files if file size exceeds matrix limits. Upload images to reverse-compile the file.
              </span>
            </div>
          </div>

          <div className="pt-2 text-[10px] text-slate-400 font-mono uppercase tracking-wider">
            100% Offline | Bit-Perfect SHA-256 Verifications
          </div>
        </div>
      </footer>
    </div>
  );
}
