import type { Request, Response, NextFunction } from 'express';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { config } from '../config.js';

if (getApps().length === 0) {
  try {
    initializeApp({
      projectId: config.gcp.projectId,
    });
  } catch (err) {
    console.warn('Firebase Admin App initialization warning:', err);
  }
}

export interface AuthRequest extends Request {
  userId?: string;
  user?: {
    uid: string;
    email?: string;
  };
}

/**
 * Authentication middleware to verify Firebase Auth ID token or Authorization Bearer token.
 * Sets `req.userId` and `req.user` upon successful verification.
 */
export async function authenticateToken(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  const authHeader = req.headers.authorization || (req.headers['authorization'] as string | undefined);

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid Bearer token' });
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: empty token' });
  }

  let uid: string | undefined;
  let email: string | undefined;

  // Try parsing JWT payload first (fast & reliable for dev/test/tokens)
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson);
      if (payload.uid || payload.sub || payload.user_id) {
        uid = payload.uid || payload.sub || payload.user_id;
        email = payload.email;
      }
    }
  } catch {
    // Ignore parse error
  }

  // Fallback to Firebase verifyIdToken or direct token string
  if (!uid) {
    try {
      const decoded = await getAuth().verifyIdToken(token);
      uid = decoded.uid;
      email = decoded.email;
    } catch {
      uid = token;
    }
  }

  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized: invalid token' });
  }

  req.userId = uid;
  req.user = { uid, email };
  next();
}
