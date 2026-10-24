import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeFileName } from '../../client/src/utils/sanitize.js';

test('sanitizeFileName prevents directory traversal and drive letter attacks', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('..\\..\\windows\\system32\\calc.exe'), 'calc.exe.download');
  assert.equal(sanitizeFileName('C:\\secret\\file.txt'), 'file.txt');
  assert.equal(sanitizeFileName('/var/log/syslog'), 'syslog');
  assert.equal(sanitizeFileName('folder/sub/nested/photo.png'), 'photo.png');
  assert.equal(sanitizeFileName('....//....//deep.tar.gz'), 'deep.tar.gz');
});

test('sanitizeFileName handles null bytes and Unicode bidirectional overrides', () => {
  // Null byte injection attempts (OS null-terminated string semantics)
  assert.equal(sanitizeFileName('document.pdf\0.exe'), 'document.pdf');
  assert.equal(sanitizeFileName('malware.exe\0.png'), 'malware.exe.download');
  assert.equal(sanitizeFileName('\0secret.txt'), 'download');

  // Unicode Right-to-Left Override (\u202E) spoofing attack (e.g. "my-doc[RLO]gpj.exe")
  const rloSpoofed = 'my-doc\u202egpj.exe';
  const sanitized = sanitizeFileName(rloSpoofed);
  assert.equal(sanitized.includes('\u202e'), false);
  assert.equal(sanitized, 'my-docgpj.exe.download');
});

test('sanitizeFileName neutralizes Windows reserved device names', () => {
  assert.equal(sanitizeFileName('CON'), 'safe_CON');
  assert.equal(sanitizeFileName('prn.txt'), 'safe_prn.txt');
  assert.equal(sanitizeFileName('AUX.pdf'), 'safe_AUX.pdf');
  assert.equal(sanitizeFileName('NUL.tar'), 'safe_NUL.tar');
  assert.equal(sanitizeFileName('com1.dat'), 'safe_com1.dat');
  assert.equal(sanitizeFileName('LPT9'), 'safe_LPT9');
});

test('sanitizeFileName appends .download to dangerous executable and script extensions', () => {
  const dangerous = [
    'malware.exe',
    'script.bat',
    'setup.msi',
    'payload.sh',
    'hack.ps1',
    'trojan.dll',
    'worm.vbs',
    'app.apk',
    'disk.iso',
    'bad.cmd'
  ];

  for (const name of dangerous) {
    const sanitized = sanitizeFileName(name);
    assert.ok(
      sanitized.endsWith('.download'),
      `Expected ${name} to end with .download, got ${sanitized}`
    );
  }

  // Safe extensions should remain unchanged
  assert.equal(sanitizeFileName('presentation.pdf'), 'presentation.pdf');
  assert.equal(sanitizeFileName('photo.jpeg'), 'photo.jpeg');
  assert.equal(sanitizeFileName('archive.zip'), 'archive.zip');
  assert.equal(sanitizeFileName('video.mp4'), 'video.mp4');
});

test('sanitizeFileName handles empty inputs and enforces length limit', () => {
  assert.equal(sanitizeFileName(''), 'download');
  assert.equal(sanitizeFileName(null), 'download');
  assert.equal(sanitizeFileName(undefined, 'custom_fallback'), 'custom_fallback');
  assert.equal(sanitizeFileName('   ..  '), 'download');

  // Max length 255 chars with extension preserved
  const longName = 'a'.repeat(300) + '.zip';
  const sanitizedLong = sanitizeFileName(longName);
  assert.equal(sanitizedLong.length, 255);
  assert.ok(sanitizedLong.endsWith('.zip'));
});
