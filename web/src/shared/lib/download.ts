/** Triggers a download of a Blob via an object URL (no data URLs, CSP friendly). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke soon so the blob does not linger in memory.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Downloads a string as a text file.
export function downloadText(text: string, filename: string, type = 'text/plain;charset=utf-8'): void {
  downloadBlob(new Blob([text], { type }), filename);
}
