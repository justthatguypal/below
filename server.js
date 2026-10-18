const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
const SUBDOMAIN = process.env.SUBDOMAIN || 'below-game-vr';
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
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

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

                // Load existing reports
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

    // Serve Static Files
    if (req.method === 'GET') {
        let reqPath = req.url.split('?')[0];
        if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

        const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
        const filePath = path.join(BASE_DIR, safePath);

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
    log(`Below Web Server is active on http://localhost:${PORT}`);
    startTunnel();
});

// Launch persistent tunnel so the external URL doesn't change
let tunnelProc = null;
function startTunnel() {
    log(`Connecting permanent tunnel for subdomain: ${SUBDOMAIN}...`);
    
    // Use npx localtunnel with fixed subdomain
    const isWin = process.platform === 'win32';
    const npxCmd = isWin ? 'npx.cmd' : 'npx';

    tunnelProc = spawn(npxCmd, ['localtunnel', '--port', PORT.toString(), '--subdomain', SUBDOMAIN], {
        shell: true,
        stdio: 'pipe'
    });

    tunnelProc.stdout.on('data', data => {
        const str = data.toString();
        log(`[Tunnel] ${str.trim()}`);
    });

    tunnelProc.stderr.on('data', data => {
        const str = data.toString();
        if (!str.includes('DeprecationWarning')) {
            log(`[Tunnel Warning] ${str.trim()}`);
        }
    });

    tunnelProc.on('close', code => {
        log(`Tunnel closed with code ${code}. Reconnecting in 5 seconds...`);
        setTimeout(startTunnel, 5000);
    });
}

// Graceful shutdown
process.on('SIGINT', () => {
    if (tunnelProc) tunnelProc.kill();
    server.close();
    process.exit();
});
