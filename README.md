# AJAWAI 2.2

A minimal browser AI assistant that runs Phi-3.5 Mini Instruct locally using WebGPU on mobile Chrome.

## Architecture

```
src/
├── main.tsx              # Entry point
├── App.tsx               # Main app with state management
├── ai/
│   ├── phiLoader.ts      # Model/tokenizer loading with stage tracking
│   └── generate.ts       # Text generation
└── ui/
    ├── Chat.tsx          # Chat interface
    └── DebugPanel.tsx    # Debug info panel
```

## Features

- **WebGPU Detection**: Checks for WebGPU availability on load
- **Single-flight Loading**: Prevents duplicate model loading
- **Stage Tracking**: `idle` → `checking-webgpu` → `loading-tokenizer` → `loading-model` → `ready` or `error`
- **Chat UI**: Simple input/output interface with streaming simulation
- **Debug Panel**: Shows WebGPU status, loading stage, and storage info

## Tech Stack

- **Vite** - Build tool
- **React** - UI framework
- **TypeScript** - Type safety
- **Transformers.js** - ONNX runtime for browser-based ML
- **WebGPU** - GPU acceleration

## Model

Uses `onnx-community/Phi-3.5-mini-instruct-onnx-web` - a quantized (q4f16) WebGPU-optimized version of Phi-3.5 Mini Instruct.

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

This will start the Vite dev server at `http://localhost:5173`.

### Production Build

```bash
npm run build
```

The built files will be in the `dist/` directory.

### Preview Production Build

```bash
npm run preview
```

## Usage

1. Open the app in a WebGPU-enabled browser (Chrome 113+ on desktop, Chrome on Android)
2. Wait for the model to load (check Debug Panel for progress)
3. Once "Ready" appears, type a prompt and press Send
4. Phi-3.5 Mini will generate a response locally

## Mobile Requirements

- Android Chrome 113+ with WebGPU enabled
- ~350MB free storage for model caching
- Mid-range or better phone recommended

## Default Generation Settings

- `max_new_tokens`: 80
- `temperature`: 0.7
- `top_p`: 0.9

## Debug Logs

Check browser console for:
- `[phiLoader]` - Model loading stages and progress
- `[generate]` - Generation start/completion

Storage estimates are logged before and after model load.

## License

MIT
