import { randomBytes } from 'node:crypto';
import { db } from './db.js';

export const SESSION_COOKIE = 'demo_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

export function createSession() {
  const token = randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO sessions (token, created_at) VALUES (?, ?)'
  ).run(token, new Date().toISOString());
  return token;
}

export function isValidSession(token) {
  if (!token) return false;
  const row = db
    .prepare('SELECT token FROM sessions WHERE token = ?')
    .get(token);
  return Boolean(row);
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function readSessionToken(request) {
  return request.cookies ? request.cookies[SESSION_COOKIE] : null;
}
