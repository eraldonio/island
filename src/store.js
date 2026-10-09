// Persistence: localStorage autosave plus JSON export/import.

import { sanitizeHtml } from './notes.js';

const KEY = 'island.world.v1';

export function save(world, cam) {
  try {
    const data = world.serialize();
    data.camera = { ox: cam.ox, oy: cam.oy, scale: cam.scale };
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (err) {
    console.warn('[island] save failed', err);
    return false;
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.voxels)) return null;
    for (const n of data.notes || []) n.html = sanitizeHtml(n.html || '');
    return data;
  } catch (err) {
    console.warn('[island] load failed', err);
    return null;
  }
}

export function clear() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function download(world, cam) {
  const data = world.serialize();
  data.camera = { ox: cam.ox, oy: cam.oy, scale: cam.scale };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'island-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => {
      try {
        const data = JSON.parse(String(fr.result));
        if (!data || !Array.isArray(data.voxels)) throw new Error('not an island file');
        for (const n of data.notes || []) n.html = sanitizeHtml(n.html || '');
        resolve(data);
      } catch (err) { reject(err); }
    };
    fr.readAsText(file);
  });
}
