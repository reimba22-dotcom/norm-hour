const http = require('http');
const fs = require('fs');
const path = require('path');
const dir = __dirname;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  let p = path.join(dir, reqPath === '/' ? 'index.html' : reqPath);
  
  try {
    if (!fs.existsSync(p)) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      p = path.join(p, 'index.html');
      if (!fs.existsSync(p)) {
        res.statusCode = 404;
        return res.end('Not found');
      }
    }
    const ext = path.extname(p);
    res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
    const stream = fs.createReadStream(p);
    stream.on('error', () => {
      if (!res.headersSent) { res.statusCode = 500; res.end('Server error'); }
    });
    stream.pipe(res);
  } catch (err) {
    res.statusCode = 500;
    res.end('Server error');
  }
});

server.listen(8085, '127.0.0.1', () => {
  console.log('M-Telemetry dev server running on http://127.0.0.1:8085');
});
