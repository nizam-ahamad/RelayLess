import streamSaver from 'streamsaver';
import { sanitizeFileName } from '../utils/sanitize.js';

export async function createFileReceiver(metadata, { onProgress, onComplete, onError }) {
  let writable = null;
  let bytesReceived = 0;
  let chunksReceived = 0;
  let closed = false;

  const safeFileName = sanitizeFileName(metadata?.fileName);
  const safeMetadata = {
    ...metadata,
    fileName: safeFileName
  };

  try {
    if ('showSaveFilePicker' in window) {
      const extension = extensionFor(safeFileName);
      const pickerOptions = { suggestedName: safeFileName };
      if (extension) {
        pickerOptions.types = [{
          description: safeMetadata.fileType || 'File',
          accept: { [safeMetadata.fileType || 'application/octet-stream']: [extension] }
        }];
      }
      const handle = await window.showSaveFilePicker(pickerOptions);
      writable = await handle.createWritable();
    } else if (safeMetadata.fileSize > 2 * 1024 * 1024 * 1024) {
      throw new Error(
        'This browser cannot stream files larger than 2 GB directly to disk. Use Chrome or Edge for very large transfers.'
      );
    } else {
      streamSaver.mitm = new URL('/streamsaver/mitm.html', window.location.origin).toString();
      writable = streamSaver.createWriteStream(safeFileName, {
        size: safeMetadata.fileSize
      }).getWriter();
    }
  } catch (error) {
    onError?.(error);
    throw error;
  }

  return {
    metadata: safeMetadata,
    async write(chunk) {
      if (closed) {
        throw new Error('The receiver is already closed.');
      }
      const buffer = chunk instanceof ArrayBuffer ? chunk : await chunk.arrayBuffer();
      await writable.write(new Uint8Array(buffer));
      bytesReceived += buffer.byteLength;
      chunksReceived += 1;
      onProgress?.({
        transferId: safeMetadata.transferId,
        fileName: safeFileName,
        fileSize: safeMetadata.fileSize,
        bytesReceived,
        chunksReceived,
        percent: safeMetadata.fileSize === 0 ? 100 : (bytesReceived / safeMetadata.fileSize) * 100
      });
    },
    async complete() {
      if (closed) {
        return;
      }
      closed = true;
      await writable.close();
      onComplete?.({
        transferId: safeMetadata.transferId,
        fileName: safeFileName,
        fileSize: safeMetadata.fileSize,
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
