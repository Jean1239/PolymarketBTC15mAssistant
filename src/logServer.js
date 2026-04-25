import http from 'http';
import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);
const LOGS_DIR = './logs';
const PORT = process.env.LOG_SERVER_PORT ?? 3456;

const ALLOWED_EXTENSIONS = new Set(['.csv', '.log', '.json']);

const HTML = (body) => `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Polymarket BTC — Reports</title>
  <style>
    body { font-family: monospace; background: #0d1117; color: #e6edf3; padding: 2rem; }
    a { color: #58a6ff; }
    h2 { color: #f0f6fc; border-bottom: 1px solid #30363d; padding-bottom: .5rem; }
    pre { background: #161b22; padding: 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
    ul { list-style: none; padding: 0; }
    li { margin: .4rem 0; }
    .nav { margin-bottom: 1.5rem; }
    .nav a { margin-right: 1rem; }
  </style>
</head>
<body>
  <div class="nav"><a href="/">Home</a><a href="/report">Report</a><a href="/logs">Logs</a></div>
  ${body}
</body>
</html>`;

async function handleReport(res) {
  try {
    const { stdout } = await execFileAsync('node', ['scripts/report.js']);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML(`<h2>Performance Report</h2><pre>${stdout}</pre>`));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(err.message);
  }
}

async function handleLogsList(res) {
  try {
    const files = (await readdir(LOGS_DIR))
      .filter(f => ALLOWED_EXTENSIONS.has(path.extname(f)))
      .sort();
    const links = files.map(f => `<li><a href="/logs/${encodeURIComponent(f)}">${f}</a></li>`).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML(`<h2>Log Files</h2><ul>${links}</ul>`));
  } catch (err) {
    res.writeHead(500); res.end(err.message);
  }
}

async function handleLogFile(filename, res) {
  const safe = path.basename(filename);
  if (!ALLOWED_EXTENSIONS.has(path.extname(safe))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const filepath = path.join(LOGS_DIR, safe);
  if (!existsSync(filepath)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const data = await readFile(filepath);
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safe}"`,
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/report') {
      await handleReport(res);
    } else if (url.pathname === '/logs') {
      await handleLogsList(res);
    } else if (url.pathname.startsWith('/logs/')) {
      await handleLogFile(decodeURIComponent(url.pathname.slice(6)), res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
  } catch (err) {
    res.writeHead(500); res.end(err.message);
  }
});

server.listen(PORT, () => console.log(`Log server on http://0.0.0.0:${PORT}`));
