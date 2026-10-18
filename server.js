const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
const BASE_DIR = __dirname;
const REPORTS_FILE = path.join(BASE_DIR, 'reports.json');
const LOG_FILE = path.join(BASE_DIR, 'server.log');

function log(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    try {
        fs.appendFileSync(LOG_FILE, entry + '\n');
    } catch (e) {}
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.webm': 'video/webm',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Rate limiter memory store for anti-spam
const ipReportHistory = new Map();
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

const server = http.createServer((req, res) => {
    const clientIP = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    // Handle Report API endpoint
    if (req.method === 'POST' && req.url === '/api/report') {
        const lastSubmitted = ipReportHistory.get(clientIP) || 0;
        const now = Date.now();

        if (now - lastSubmitted < COOLDOWN_MS) {
            const waitSeconds = Math.ceil((COOLDOWN_MS - (now - lastSubmitted)) / 1000);
            res.writeHead(429, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `Rate limited. Please wait ${waitSeconds} seconds.` }));
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 50000) req.destroy();
        });

        req.on('end', () => {
            try {
                const report = JSON.parse(body);
                report.receivedAt = new Date().toISOString();
                report.clientIP = clientIP;

                let reports = [];
                if (fs.existsSync(REPORTS_FILE)) {
                    try { reports = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8')); } catch (e) { reports = []; }
                }
                reports.push(report);
                fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));

                ipReportHistory.set(clientIP, now);
                log(`[Report Received] Category: ${report.type} from Player: ${report.playerTag || 'Anon'}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Report saved.' }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
            }
        });
        return;
    }

    // Serve Static Files with proper path handling on Windows
    if (req.method === 'GET') {
        let reqPath = req.url.split('?')[0];
        if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

        // Strip leading slashes to prevent Windows path.join drive-root misinterpretation
        const cleanPath = reqPath.replace(/^[/\\]+/, '');
        const filePath = path.join(BASE_DIR, cleanPath);

        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                return res.end('<h1>404 Not Found</h1>');
            }

            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';

            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
                'Access-Control-Allow-Origin': '*'
            });

            fs.createReadStream(filePath).pipe(res);
        });
        return;
    }

    res.writeHead(405);
    res.end();
});

server.listen(PORT, '0.0.0.0', () => {
    log(`Below Server is active on http://localhost:${PORT}`);
    startCloudflareTunnel();
});

// Launch Cloudflare Tunnel (100% IP masked, no reminder screens)
let cloudflaredProc = null;
function startCloudflareTunnel() {
    log(`Starting Cloudflare Tunnel to protect IP and serve site...`);
    
    const cloudflaredBin = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
    
    // Check if cloudflared is installed
    if (!fs.existsSync(cloudflaredBin)) {
        log(`Cloudflared not found at ${cloudflaredBin}`);
        return;
    }

    cloudflaredProc = spawn(cloudflaredBin, ['tunnel', '--url', `http://localhost:${PORT}`], {
        stdio: 'pipe'
    });

    cloudflaredProc.stderr.on('data', data => {
        const str = data.toString();
        // Look for the tunnel URL
        const match = str.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) {
            log(`[Cloudflare Tunnel Active] URL: ${match[0]}`);
        }
    });

    cloudflaredProc.on('close', code => {
        log(`Cloudflare tunnel closed (code: ${code}). Reconnecting in 5 seconds...`);
        setTimeout(startCloudflareTunnel, 5000);
    });
}

// Graceful shutdown
process.on('SIGINT', () => {
    if (cloudflaredProc) cloudflaredProc.kill();
    server.close();
    process.exit();
});
