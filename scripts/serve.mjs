#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, extname, sep } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

export function startServer({ port = 5174, host = '127.0.0.1' } = {}) {
  return new Promise((done, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
        const file = await stat(path);
        if (!file.isFile()) { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream', 'Content-Length': file.size, 'Cache-Control': pathname.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        createReadStream(path).pipe(response);
      } catch { response.writeHead(404).end('Not found'); }
    });
    server.once('error', reject);
    server.listen(port, host, () => done({ server, url: `http://${host}:${server.address().port}` }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('Revia — local image editing\n\nUsage: npm start -- [--port 5174] [--no-open]\n');
  else {
    const portIndex = args.indexOf('--port'), port = portIndex >= 0 ? Number(args[portIndex + 1]) : 5174;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Choose a port between 0 and 65535.');
    const { server, url } = await startServer({ port });
    console.log(`Revia is ready at ${url}\nPress Ctrl+C to stop.`);
    if (!args.includes('--no-open')) {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const child = spawn(command, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { detached: true, stdio: 'ignore' });
      child.on('error', () => {}); child.unref();
    }
    process.on('SIGINT', () => server.close()); process.on('SIGTERM', () => server.close());
  }
}
