// src/lib/drive-client.js
// Pure fetch-based Drive API client (no Node.js SDK - works in Workers)

import { decrypt, encrypt } from './crypto.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export async function refreshAccessToken(account, env) {
  const refreshToken = await decrypt(account.refresh_token_enc, env.MASTER_SECRET);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${await res.text()}`);
  }

  const data = await res.json();
  const accessTokenEnc = await encrypt(data.access_token, env.MASTER_SECRET);
  const expiresAt = Date.now() + (data.expires_in - 60) * 1000;

  // Update in DB
  await env.DB.prepare(
    'UPDATE accounts SET access_token_enc = ?, access_token_expires = ? WHERE id = ?'
  ).bind(accessTokenEnc, expiresAt, account.id).run();

  return data.access_token;
}

export async function getAccessToken(account, env) {
  if (account.access_token_enc && account.access_token_expires > Date.now()) {
    return decrypt(account.access_token_enc, env.MASTER_SECRET);
  }
  return refreshAccessToken(account, env);
}

export async function driveRequest(account, env, method, path, options = {}) {
  const token = await getAccessToken(account, env);
  const url = `${DRIVE_API}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw Object.assign(new Error(`Drive API error: ${errText}`), { status: res.status });
  }

  return res.json();
}

export async function uploadFile(account, env, { name, mimeType, content, parentFolderId }) {
  const token = await getAccessToken(account, env);

  // Use multipart upload for files under 5MB, resumable for larger
  const metadata = {
    name,
    mimeType,
    parents: parentFolderId ? [parentFolderId] : [],
  };

  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadataPart = `Content-Type: application/json\r\n\r\n${JSON.stringify(metadata)}`;

  let body;
  let contentType;

  if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
    // Binary multipart
    const enc = new TextEncoder();
    const parts = [
      enc.encode(`--${boundary}\r\n`),
      enc.encode(metadataPart),
      enc.encode(delimiter),
      enc.encode(`Content-Type: ${mimeType}\r\n\r\n`),
      content instanceof Uint8Array ? content : new Uint8Array(content),
      enc.encode(closeDelimiter),
    ];
    const totalLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
    body = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      body.set(part, offset);
      offset += part.byteLength;
    }
    contentType = `multipart/related; boundary="${boundary}"`;
  } else {
    // Text/JSON multipart
    const bodyStr = [
      `--${boundary}`,
      metadataPart,
      delimiter,
      `Content-Type: ${mimeType}\r\n\r\n${content}`,
      closeDelimiter,
    ].join('');
    body = bodyStr;
    contentType = `multipart/related; boundary="${boundary}"`;
  }

  const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,size,mimeType`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
    },
    body,
  });

  if (!res.ok) {
    throw Object.assign(new Error(`Upload failed: ${await res.text()}`), { status: res.status });
  }

  return res.json();
}

export async function downloadFile(account, env, driveFileId) {
  const token = await getAccessToken(account, env);
  const res = await fetch(`${DRIVE_API}/files/${driveFileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw Object.assign(new Error(`Download failed: ${await res.text()}`), { status: res.status });
  }

  return res; // return raw Response so caller can stream or buffer
}

export async function deleteFile(account, env, driveFileId) {
  const token = await getAccessToken(account, env);
  const res = await fetch(`${DRIVE_API}/files/${driveFileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete failed: ${await res.text()}`);
  }
  return true;
}

export async function createFolder(account, env, { name, parentFolderId }) {
  return driveRequest(account, env, 'POST', '/files', {
    body: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentFolderId ? [parentFolderId] : [],
    },
  });
}

export async function getOrCreateFolder(account, env, { name, parentFolderId }) {
  const token = await getAccessToken(account, env);
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentFolderId ? ` and '${parentFolderId}' in parents` : ''}`;

  const res = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await res.json();
  if (data.files && data.files.length > 0) return data.files[0];

  return createFolder(account, env, { name, parentFolderId });
}

export async function updateFile(account, env, driveFileId, content, mimeType) {
  const token = await getAccessToken(account, env);
  const res = await fetch(`${UPLOAD_API}/files/${driveFileId}?uploadType=media`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mimeType || 'application/octet-stream',
    },
    body: typeof content === 'string' ? content : JSON.stringify(content),
  });

  if (!res.ok) throw new Error(`Update failed: ${await res.text()}`);
  return res.json();
}

export async function getStorageQuota(account, env) {
  const token = await getAccessToken(account, env);
  const res = await fetch(`${DRIVE_API}/about?fields=storageQuota`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.storageQuota; // { limit, usage, usageInDrive }
}
