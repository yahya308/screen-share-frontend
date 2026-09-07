#!/usr/bin/env node
// Validate the room's actual options with native Chromium getDisplayMedia.
// The fake monitor is Chromium's test device; no desktop content is captured.
// https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/media/webrtc/webrtc_getdisplaymedia_browsertest.cc
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = `<!doctype html><button id="capture">Capture</button>
<script type="module">
import { screenSettings, screenCaptureOptions } from '/media-policy.mjs';
document.getElementById('capture').onclick = async () => {
    window.result = null;
    try {
        const options = screenCaptureOptions(screenSettings(window.height || 720, window.fps || 30, 5000));
        if (window.conflicting) options.preferCurrentTab = true;
        const stream = await navigator.mediaDevices.getDisplayMedia(options);
        const video = stream.getVideoTracks()[0];
        window.result = { live: video?.readyState === 'live', surface: video?.getSettings().displaySurface };
        stream.getTracks().forEach(track => track.stop());
    } catch (error) { window.result = { error: error.name, message: error.message }; }
};
window.ready = true;
</script>`;

(async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/media-policy.mjs') {
            res.setHeader('Content-Type', 'application/javascript');
            res.end(fs.readFileSync(path.join(__dirname, '../public/media-policy.mjs')));
        } else {
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
        }
    });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await chromium.launch({
            executablePath: process.env.CHROMIUM_PATH || undefined,
            args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=display-media-type=monitor']
        });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => window.ready);
        for (const config of [{ height: 720, fps: 30 }, { height: 1080, fps: 60 }, { conflicting: true }]) {
            await page.evaluate(config => { Object.assign(window, config); window.result = null; }, config);
            await page.click('#capture');
            await page.waitForFunction(() => window.result, null, { timeout: 10000 });
            const result = await page.evaluate(() => window.result);
            if (config.conflicting) {
                assert.equal(result.error, 'TypeError');
                assert.match(result.message, /Self-contradictory configuration/);
                console.log('PASS: Chrome rejects the reported conflicting options');
            } else {
                assert.equal(result.live, true, JSON.stringify(result));
                assert.equal(result.surface, 'monitor');
                console.log(`PASS: native getDisplayMedia starts ${config.height}p / ${config.fps} FPS request`);
            }
        }
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
