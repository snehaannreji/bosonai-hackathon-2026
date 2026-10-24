export const MAX_AVATAR_BYTES = 10 * 1024 * 1024;
export const AVATAR_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
import type { CharacterId } from "./characters";
export interface AvatarPhoto { blob: Blob; name: string }

export function validateAvatarFile(file: Blob): void {
  if (!AVATAR_IMAGE_TYPES.includes(file.type)) throw new Error("Choose a JPG, PNG or WebP photo.");
  if (file.size === 0) throw new Error("That file is empty. Choose another photo.");
  if (file.size > MAX_AVATAR_BYTES) throw new Error("That photo is too large. Choose one under 10 MB.");
}

/** Verify actual browser decoding, rather than trusting the file extension. */
export async function decodeAvatarFile(file: Blob): Promise<void> {
  validateAvatarFile(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Invalid image dimensions.");
  } catch {
    throw new Error("That photo could not be opened. Try a different JPG, PNG or WebP image.");
  } finally { URL.revokeObjectURL(url); }
}

// IndexedDB stores the image blob without the small localStorage string quota.
// Photos never leave the browser. Store the blob, not a temporary object URL.
const DB_NAME = "teachback-avatar";
const STORE = "photos";
// Use the bundled portrait after its update instead of a previously saved
// upload with unwanted borders. The old IndexedDB photo remains untouched.
const photoKey = (characterId: CharacterId) => characterId === "baby-yoda" ? "student:baby-yoda:portrait-v2" : characterId === "kevin" ? "student:kevin:portrait-v2" : `student:${characterId}`;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("Browser storage is unavailable."));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open photo storage."));
  });
}

async function transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = work(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("Photo storage was interrupted.")); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("Could not save the photo.")); };
  });
}

export async function loadAvatarPhoto(characterId: CharacterId = "alex"): Promise<AvatarPhoto | null> {
  const stored: unknown = await transaction("readonly", store => store.get(photoKey(characterId)));
  if (!stored || typeof stored !== "object" || !("blob" in stored) || !(stored.blob instanceof Blob) || !("name" in stored) || typeof stored.name !== "string") return null;
  validateAvatarFile(stored.blob);
  return { blob: stored.blob, name: stored.name };
}
export async function saveAvatarPhoto(photo: AvatarPhoto, characterId: CharacterId = "alex"): Promise<void> {
  validateAvatarFile(photo.blob);
  await transaction("readwrite", store => store.put(photo, photoKey(characterId)));
}
export async function removeAvatarPhoto(characterId: CharacterId = "alex"): Promise<void> {
  await transaction("readwrite", store => store.delete(photoKey(characterId)));
}
