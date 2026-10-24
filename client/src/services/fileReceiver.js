import streamSaver from 'streamsaver';

export async function createFileReceiver(metadata, { onProgress, onComplete, onError }) {
  let writable = null;
  let bytesReceived = 0;
  let chunksReceived = 0;
  let closed = false;

  try {
    if ('showSaveFilePicker' in window) {
      const extension = extensionFor(metadata.fileName);
      const pickerOptions = { suggestedName: metadata.fileName };
      if (extension) {
        pickerOptions.types = [{
          description: metadata.fileType || 'File',
          accept: { [metadata.fileType || 'application/octet-stream']: [extension] }
        }];
      }
      const handle = await window.showSaveFilePicker(pickerOptions);
      writable = await handle.createWritable();
    } else if (metadata.fileSize > 2 * 1024 * 1024 * 1024) {
      throw new Error(
        'This browser cannot stream files larger than 2 GB directly to disk. Use Chrome or Edge for very large transfers.'
      );
    } else {
      streamSaver.mitm = new URL('/streamsaver/mitm.html', window.location.origin).toString();
      writable = streamSaver.createWriteStream(metadata.fileName, {
        size: metadata.fileSize
      }).getWriter();
    }
  } catch (error) {
    onError?.(error);
    throw error;
  }

  return {
    metadata,
    async write(chunk) {
      if (closed) {
        throw new Error('The receiver is already closed.');
      }
      const buffer = chunk instanceof ArrayBuffer ? chunk : await chunk.arrayBuffer();
      await writable.write(new Uint8Array(buffer));
      bytesReceived += buffer.byteLength;
      chunksReceived += 1;
      onProgress?.({
        transferId: metadata.transferId,
        fileName: metadata.fileName,
        fileSize: metadata.fileSize,
        bytesReceived,
        chunksReceived,
        percent: metadata.fileSize === 0 ? 100 : (bytesReceived / metadata.fileSize) * 100
      });
    },
    async complete() {
      if (closed) {
        return;
      }
      closed = true;
      await writable.close();
      onComplete?.({
        transferId: metadata.transferId,
        fileName: metadata.fileName,
        fileSize: metadata.fileSize,
        bytesReceived,
        chunksReceived
      });
    },
    async cancel() {
      if (closed) {
        return;
      }
      closed = true;
      await writable?.abort();
    }
  };
}

function extensionFor(fileName) {
  const match = String(fileName).match(/(\.[^./\\]+)$/);
  return match?.[1] || null;
}
