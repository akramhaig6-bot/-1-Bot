import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import { apiErrorHandler, apiRouter } from './src/server/api.js';
import { restoreTelegramBots, stopTelegramBots } from './src/server/telegram.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const isProduction = process.env.NODE_ENV === 'production';
let vite: ViteDevServer | undefined;

app.disable('x-powered-by');
app.use('/api', apiRouter);
app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'مسار API غير موجود.' });
});
app.use('/api', apiErrorHandler);

if (isProduction) {
  const clientBuild = path.join(root, 'dist');
  app.use(express.static(clientBuild, { index: false, maxAge: '1h' }));
  app.get('*', (_request, response) => {
    const indexFile = path.join(clientBuild, 'index.html');
    if (!fs.existsSync(indexFile)) {
      response.status(500).send('لم يتم إنشاء ملفات الواجهة بعد. نفّذ npm run build.');
      return;
    }
    response.sendFile(indexFile);
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: {
      middlewareMode: true,
      allowedHosts: ['localhost', '127.0.0.1', '.e2b.app'],
      hmr: false,
    },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Botmakers يعمل على http://0.0.0.0:${port}`);
  void restoreTelegramBots();
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await stopTelegramBots();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await vite?.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
