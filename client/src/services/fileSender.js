export const CHUNK_SIZE = 64 * 1024;
export const LOW_WATERMARK = 2 * 1024 * 1024;
export const HIGH_WATERMARK = 8 * 1024 * 1024;

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

export function createTransferId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function sendFile({ file, dataChannel, signal, onProgress, onComplete }) {
  if (!file || dataChannel?.readyState !== 'open') {
    throw new Error('A file and an open data channel are required.');
  }

  const transferId = createTransferId();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const metadata = {
    type: 'METADATA',
    transferId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'application/octet-stream',
    chunkSize: CHUNK_SIZE,
    totalChunks
  };

  dataChannel.bufferedAmountLowThreshold = LOW_WATERMARK;
  dataChannel.send(JSON.stringify(metadata));

  let offset = 0;
  let chunkIndex = 0;
  let lastReportedAt = performance.now();
  let lastReportedBytes = 0;

  while (offset < file.size) {
    if (signal?.aborted) {
      dataChannel.send(JSON.stringify({ type: 'CANCEL', transferId }));
      throw new DOMException('The transfer was cancelled.', 'AbortError');
    }

    while (dataChannel.bufferedAmount > HIGH_WATERMARK) {
      await waitForBufferedAmountLow(dataChannel, signal);
    }

    const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
    const buffer = await slice.arrayBuffer();
    if (signal?.aborted) {
      dataChannel.send(JSON.stringify({ type: 'CANCEL', transferId }));
      throw new DOMException('The transfer was cancelled.', 'AbortError');
    }

    dataChannel.send(buffer);
    offset += buffer.byteLength;
    chunkIndex += 1;

    const now = performance.now();
    if (now - lastReportedAt >= 150 || offset === file.size) {
      const elapsedSeconds = Math.max((now - lastReportedAt) / 1000, 0.001);
      const speed = (offset - lastReportedBytes) / elapsedSeconds;
      onProgress?.({
        transferId,
        fileName: file.name,
        fileSize: file.size,
        bytesSent: offset,
        totalChunks,
        chunksSent: chunkIndex,
        percent: file.size === 0 ? 100 : (offset / file.size) * 100,
        speed,
        bufferedAmount: dataChannel.bufferedAmount
      });
      lastReportedAt = now;
      lastReportedBytes = offset;
    }

    if (dataChannel.bufferedAmount > LOW_WATERMARK) {
      await pause();
    }
  }

  dataChannel.send(JSON.stringify({
    type: 'COMPLETE',
    transferId,
    totalChunks,
    fileSize: file.size
  }));
  onComplete?.({ transferId, fileName: file.name, fileSize: file.size });
  return { transferId };
}

function waitForBufferedAmountLow(dataChannel, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The transfer was cancelled.', 'AbortError'));
      return;
    }

    let settled = false;
    const cleanup = () => {
      dataChannel.removeEventListener('bufferedamountlow', handleLow);
      signal?.removeEventListener('abort', handleAbort);
    };
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const handleLow = () => finish(resolve);
    const handleAbort = () => finish(() => reject(new DOMException('The transfer was cancelled.', 'AbortError')));

    dataChannel.addEventListener('bufferedamountlow', handleLow, { once: true });
    signal?.addEventListener('abort', handleAbort, { once: true });
    if (dataChannel.bufferedAmount <= LOW_WATERMARK) {
      finish(resolve);
    }
  });
}
