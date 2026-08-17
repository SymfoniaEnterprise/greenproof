import { randomBytes } from 'node:crypto';
import { db } from './db.js';

export const SESSION_COOKIE = 'benchmark_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    now.toISOString(),
    expiresAt.toISOString()
  );
  return token;
}

export function isValidSession(token) {
  if (!token) return false;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return false;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}

export function getSessionUser(token) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const user = db.prepare('SELECT id, username, full_name, role, active FROM users WHERE id = ?').get(session.user_id);
  return user || null;
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function readSessionToken(request) {
  return request.cookies ? request.cookies[SESSION_COOKIE] : null;
}
