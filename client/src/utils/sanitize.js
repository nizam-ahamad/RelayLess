/**
 * Filename sanitization utility to prevent path traversal,
 * control character injection, Unicode directional spoofing,
 * Windows reserved device name collisions, and dangerous file extensions.
 */

const DANGEROUS_EXTENSIONS = new Set([
  // Executables and scripts
  'exe', 'bat', 'cmd', 'sh', 'bin', 'msi', 'dll', 'com', 'scr', 'pif',
  'vbs', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'ps2', 'psc1', 'msh', 'reg',
  'jar', 'hta', 'cpl', 'app', 'deb', 'rpm', 'apk', 'iso', 'img', 'vhd',
  'msp', 'gadget', 'inf', 'sys', 'drv'
]);

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFileName(rawName, fallback = 'download') {
  if (typeof rawName !== 'string') {
    return fallback;
  }

  // 1. Filesystem null byte truncation (mimics OS null-terminated string semantics)
  let name = rawName.split('\0')[0];

  // Remove C0/C1 control characters and Unicode bidi override characters
  // \x00-\x1f, \x7f-\x9f, \u200e-\u200f (LRM/RLM), \u202a-\u202e (LRE/RLE/PDF/LRO/RLO), \u2066-\u2069 (LRI/RLI/FSI/PDI)
  name = name
    .replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();

  // 2. Strip Windows drive letters (e.g. C:, D:)
  name = name.replace(/^[a-zA-Z]:[/\\]*/, '');

  // 3. Remove path traversal directories (only keep basename)
  name = name.replace(/^.*[/\\]/, '');

  // 4. Neutralize consecutive dots to prevent path traversal tricks
  name = name.replace(/\.{2,}/g, '.');

  // 5. Replace forbidden filesystem characters (< > : " / \ | ? *) with an underscore
  name = name.replace(/[<>:"/\\|?*]/g, '_');

  // 6. Strip leading and trailing whitespace and dots (Windows and POSIX safe)
  name = name.replace(/^[\s.]+|[\s.]+$/g, '');

  if (!name) {
    name = fallback;
  }

  // 7. Check for Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  const baseName = name.replace(/\.[^.]*$/, '');
  if (WINDOWS_RESERVED_NAMES.test(baseName)) {
    name = `safe_${name}`;
  }

  // 8. Prevent execution of dangerous file types by appending .download
  const parts = name.split('.');
  if (parts.length > 1) {
    const ext = parts[parts.length - 1].toLowerCase();
    if (DANGEROUS_EXTENSIONS.has(ext)) {
      name = `${name}.download`;
    }
  }

  // 9. Cap filename length (max 255 chars) while preserving extension
  if (name.length > 255) {
    const lastDot = name.lastIndexOf('.');
    if (lastDot > 0) {
      const ext = name.slice(lastDot);
      name = name.slice(0, 255 - ext.length) + ext;
    } else {
      name = name.slice(0, 255);
    }
  }

  return name || fallback;
}
