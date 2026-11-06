import type { Request, Response } from 'express';
import { createServer } from '../server';

let appPromise: ReturnType<typeof createServer> | undefined;

export default async function handler(req: Request, res: Response): Promise<void> {
  try {
    appPromise ??= createServer();
    const app = await appPromise;
    app(req, res);
  } catch {
    console.error('Failed to initialize the API server.');
    res.status(500).json({ success: false, error: 'API server initialization failed.' });
  }
}
