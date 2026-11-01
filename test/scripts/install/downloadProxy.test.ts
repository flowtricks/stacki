// Goal: the audited global-agent override preserves Electron download proxies.
// Methodology: initialize the actual builder download dependency in a separate
// Node process and send a request through a loopback proxy, without external DNS.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const proxyClient = `
  const { createRequire } = require('node:module');
  const builder = createRequire(require.resolve('electron-builder/package.json'));
  const library = createRequire(builder.resolve('app-builder-lib/package.json'));
  const download = library('@electron/get');
  download.initializeProxy();
  const request = require('node:http').get('http://stacki-proxy.invalid/artifact', response => {
    response.setEncoding('utf8');
    response.on('data', chunk => process.stdout.write(chunk));
  });
  request.setTimeout(3000, () => request.destroy(new Error('Proxy request timed out')));
  request.on('error', error => { console.error(error.message); process.exitCode = 1; });
`;

test('Electron builder downloader initializes the overridden proxy agent', { timeout: 10000 }, async () => {
  let requestedURL: string | undefined;
  const proxy = createServer((request, response) => {
    requestedURL = request.url;
    response.end('stacki-proxy-ok');
  });
  proxy.maxConnections = 1;
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    const address = proxy.address();
    assert.ok(address);
    assert.equal(typeof address, 'object');
    if (typeof address === 'string') {
      throw new Error('Expected a TCP proxy address');
    }
    const proxyURL = `http://127.0.0.1:${address.port}`;
    const result = await execute(process.execPath, ['-e', proxyClient], {
      env: {
        ...process.env,
        GLOBAL_AGENT_HTTP_PROXY: proxyURL,
        GLOBAL_AGENT_HTTPS_PROXY: proxyURL,
        GLOBAL_AGENT_NO_PROXY: '',
      },
      timeout: 5000,
      maxBuffer: 4096,
    });
    assert.equal(result.stdout, 'stacki-proxy-ok');
    assert.equal(requestedURL, 'http://stacki-proxy.invalid/artifact');
  } finally {
    proxy.close();
    proxy.closeAllConnections();
    await once(proxy, 'close');
  }
});
