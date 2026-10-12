import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface MT5Payload {
  symbol: string;
  tick?: {
    bid: number;
    ask: number;
    spread: number;
    time: number;
    iso_time?: string;
  };
  candles_m5?: any[];
  candles_h1?: any[];
  account?: {
    login?: number;
    server?: string;
    company?: string;
    trade_mode?: number;
    currency?: string;
    balance?: number;
    equity?: number;
    leverage?: number;
  };
  terminal?: {
    connected?: boolean;
    path?: string;
    name?: string;
    build?: number;
  };
  available_symbols?: any[];
  indicators?: {
    ema20?: number;
    ema200?: number;
    ema200_slope?: number;
    rsi14?: number;
  };
  strategy?: {
    buy?: any;
    sell?: any;
  };
  client_timestamp?: string;
  token?: string;
}

// In-memory state store for real MT5 feed
let latestMT5Data: MT5Payload | null = null;
let lastReceivedTimestamp: number = 0;
let userModeOverride: 'AUTO' | 'DEMO' | 'DISCONNECTED' = 'AUTO';

export async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Support JSON payload up to 10MB (for historical candles)
  app.use(express.json({ limit: '10mb' }));

  // CORS headers so local Python connector can push from any origin
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-GEP5-Token');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // --- API ROUTES ---

  // Health check
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'GEP-5 Market Data API',
      timestamp: new Date().toISOString(),
    });
  });

  // Connector Push Endpoint: Python backend on Windows pushes MT5 data here
  app.post('/api/connector/push', (req: Request, res: Response) => {
    const data: MT5Payload = req.body;
    if (!data || !data.symbol) {
      return res.status(400).json({ error: 'Missing symbol or invalid MT5 payload' });
    }

    latestMT5Data = data;
    lastReceivedTimestamp = Date.now();
    userModeOverride = 'AUTO';

    return res.json({
      success: true,
      received_at: lastReceivedTimestamp,
      symbol: data.symbol,
      m5_count: data.candles_m5?.length || 0,
      h1_count: data.candles_h1?.length || 0,
      tick: data.tick,
    });
  });

  // Status Endpoint
  app.get('/api/connector/status', (req: Request, res: Response) => {
    const now = Date.now();
    const ageSeconds = lastReceivedTimestamp > 0 ? Math.floor((now - lastReceivedTimestamp) / 1000) : null;

    let computedStatus: 'LIVE' | 'STALE' | 'DISCONNECTED' | 'DEMO' = 'DISCONNECTED';

    if (userModeOverride === 'DEMO') {
      computedStatus = 'DEMO';
    } else if (userModeOverride === 'DISCONNECTED') {
      computedStatus = 'DISCONNECTED';
    } else if (lastReceivedTimestamp > 0) {
      if (ageSeconds !== null && ageSeconds <= 20) {
        computedStatus = 'LIVE';
      } else if (ageSeconds !== null && ageSeconds <= 90) {
        computedStatus = 'STALE';
      } else {
        computedStatus = 'DISCONNECTED';
      }
    } else {
      computedStatus = 'DISCONNECTED';
    }

    res.json({
      status: computedStatus,
      is_live: computedStatus === 'LIVE',
      last_received_at: lastReceivedTimestamp || null,
      age_seconds: ageSeconds,
      symbol: latestMT5Data?.symbol || 'XAUUSDm',
      terminal: latestMT5Data?.terminal || null,
      account: latestMT5Data?.account || null,
      has_data: latestMT5Data !== null,
    });
  });

  // Latest Feed Data Endpoint: Polled by React frontend
  app.get('/api/connector/latest', (req: Request, res: Response) => {
    const now = Date.now();
    const ageSeconds = lastReceivedTimestamp > 0 ? Math.floor((now - lastReceivedTimestamp) / 1000) : null;

    let computedStatus: 'LIVE' | 'STALE' | 'DISCONNECTED' | 'DEMO' = 'DISCONNECTED';

    if (userModeOverride === 'DEMO') {
      computedStatus = 'DEMO';
    } else if (userModeOverride === 'DISCONNECTED') {
      computedStatus = 'DISCONNECTED';
    } else if (lastReceivedTimestamp > 0) {
      if (ageSeconds !== null && ageSeconds <= 20) {
        computedStatus = 'LIVE';
      } else if (ageSeconds !== null && ageSeconds <= 90) {
        computedStatus = 'STALE';
      } else {
        computedStatus = 'DISCONNECTED';
      }
    } else {
      computedStatus = 'DISCONNECTED';
    }

    if (computedStatus === 'DISCONNECTED' && userModeOverride !== 'DEMO') {
      return res.json({
        status: 'DISCONNECTED',
        is_live: false,
        message: 'No active MT5 feed received from local connector within the last 90 seconds.',
        last_received_at: lastReceivedTimestamp || null,
        age_seconds: ageSeconds,
        data: null,
      });
    }

    return res.json({
      status: computedStatus,
      is_live: computedStatus === 'LIVE',
      last_received_at: lastReceivedTimestamp,
      age_seconds: ageSeconds,
      data: latestMT5Data,
    });
  });

  // User Mode Switch (e.g. explicitly test DEMO mode or reset)
  app.post('/api/connector/mode', (req: Request, res: Response) => {
    const { mode } = req.body;
    if (mode === 'DEMO' || mode === 'DISCONNECTED' || mode === 'AUTO') {
      userModeOverride = mode;
      return res.json({ success: true, mode: userModeOverride });
    }
    return res.status(400).json({ error: 'Invalid mode' });
  });

  // Explicit Disconnect
  app.post('/api/connector/disconnect', (req: Request, res: Response) => {
    userModeOverride = 'DISCONNECTED';
    latestMT5Data = null;
    lastReceivedTimestamp = 0;
    return res.json({ success: true, status: 'DISCONNECTED', message: 'Feed disconnected' });
  });

  // Explicit Connect / Reconnect
  app.post('/api/connector/connect', (req: Request, res: Response) => {
    userModeOverride = 'AUTO';
    return res.json({ success: true, status: 'AUTO', message: 'Connecting to MT5 feed...' });
  });

  // Download connector scripts directly
  app.get('/api/connector/download/:file', (req: Request, res: Response) => {
    const filename = req.params.file;
    const safeFiles: Record<string, string> = {
      'gep5_connector.py': path.resolve(__dirname, 'connector', 'gep5_connector.py'),
      'test_stage1_connection.py': path.resolve(__dirname, 'connector', 'test_stage1_connection.py'),
      'run_connector.bat': path.resolve(__dirname, 'connector', 'run_connector.bat'),
      'run_stage1_test.bat': path.resolve(__dirname, 'connector', 'run_stage1_test.bat'),
      'requirements.txt': path.resolve(__dirname, 'connector', 'requirements.txt'),
      'README.md': path.resolve(__dirname, 'connector', 'README.md'),
      'GEP5_Strategy_Engine.mq5': path.resolve(__dirname, 'connector', 'GEP5_Strategy_Engine.mq5'),
      'manifest.json': path.resolve(__dirname, 'extension', 'manifest.json'),
      'popup.html': path.resolve(__dirname, 'extension', 'popup.html'),
      'popup.js': path.resolve(__dirname, 'extension', 'popup.js'),
      'background.js': path.resolve(__dirname, 'extension', 'background.js'),
    };

    const filePath = safeFiles[filename];
    if (filePath) {
      res.download(filePath, filename);
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  });

  // --- VITE MIDDLEWARE / STATIC ASSETS ---
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[GEP-5 Server] Listening on port ${PORT}`);
    console.log(`[GEP-5 Server] MT5 Ingestion API: POST http://0.0.0.0:${PORT}/api/connector/push`);
  });
}

startServer();
