import { studioTranslate } from '../../shared/studioTranslate';
import { request } from '../project/projectClient';

export async function assetOperation(body: Readonly<Record<string, string>>) {
  const result = await request('/studio/api/assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  window.dispatchEvent(new Event('studio:assets-changed'));
  return result;
}
export async function uploadFiles(destination: string, files: readonly File[]) {
  if (files.length > 20) {
    throw new Error(studioTranslate('assets.error.uploadMax', { count: 20 }));
  }
  let added = 0;
  try {
    for (const file of files) {
      await request(`/studio/api/upload?file=${encodeURIComponent((destination || 'public') + '/' + file.name)}`, {
        method: 'POST',
        body: file,
      });
      added++;
    }
    return { added };
  } finally {
    window.dispatchEvent(new Event('studio:assets-changed'));
  }
}
export async function chooseUploads(destination: string) {
  const files = await new Promise<readonly File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    const finish = (files: readonly File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.append(input);
    input.click();
  });
  return uploadFiles(destination, files);
}

/** Asks for a file and writes it over the asset, keeping its path; false when cancelled. */
export async function chooseReplacement(rel: string): Promise<boolean> {
  const [file] = await new Promise<readonly File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    const finish = (files: readonly File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.append(input);
    input.click();
  });
  if (file === undefined) {
    return false;
  }
  try {
    await request(`/studio/api/upload?${new URLSearchParams({ file: rel, replacement: file.name })}`, { method: 'POST', body: file });
  } finally {
    window.dispatchEvent(new Event('studio:assets-changed'));
  }
  return true;
}
