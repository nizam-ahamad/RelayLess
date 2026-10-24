/* StreamSaver service worker, hosted locally for offline/static deployments. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const downloads = new Map();

self.addEventListener('message', (event) => {
  if (event.data === 'ping') {
    return;
  }

  const data = event.data;
  const downloadUrl = data.url || `${self.registration.scope}${Math.random()}/${data.filename || 'download'}`;
  const port = event.ports[0];
  const metadata = { stream: null, data, port };

  if (data.readableStream) {
    metadata.stream = data.readableStream;
  } else if (data.transferringReadable) {
    port.onmessage = (messageEvent) => {
      port.onmessage = null;
      metadata.stream = messageEvent.data.readableStream;
    };
  } else {
    metadata.stream = new ReadableStream({
      start(controller) {
        port.onmessage = ({ data: chunk }) => {
          if (chunk === 'end') {
            controller.close();
          } else if (chunk === 'abort') {
            controller.error('Aborted the download');
          } else {
            controller.enqueue(chunk);
          }
        };
      },
      cancel(reason) {
        console.warn('StreamSaver download cancelled', reason);
        port.postMessage({ abort: true });
      }
    });
  }

  downloads.set(downloadUrl, metadata);
  port.postMessage({ download: downloadUrl });
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if (url.endsWith('/ping')) {
    event.respondWith(new Response('pong'));
    return;
  }

  const download = downloads.get(url);
  if (!download) {
    return;
  }
  downloads.delete(url);

  const responseHeaders = new Headers({
    'Content-Type': 'application/octet-stream; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'",
    'X-Content-Security-Policy': "default-src 'none'",
    'X-WebKit-CSP': "default-src 'none'",
    'X-XSS-Protection': '1; mode=block'
  });
  const headers = new Headers(download.data.headers || {});
  for (const name of ['Content-Length', 'Content-Disposition']) {
    if (headers.has(name)) {
      responseHeaders.set(name, headers.get(name));
    }
  }

  event.respondWith(new Response(download.stream, { headers: responseHeaders }));
  download.port.postMessage({ debug: 'Download started' });
});
