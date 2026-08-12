import { describe, expect, it, vi } from 'vitest';
import type { Response, NextFunction } from 'express';
import { authenticateToken, type AuthRequest } from './auth.js';

function createMockRes(): { res: Partial<Response>; statusFn: ReturnType<typeof vi.fn>; jsonFn: ReturnType<typeof vi.fn> } {
  const jsonFn = vi.fn();
  const statusFn = vi.fn().mockReturnValue({ json: jsonFn });
  const res: Partial<Response> = {
    status: statusFn as unknown as Response['status'],
  };
  return { res, statusFn, jsonFn };
}

describe('authenticateToken middleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const req = { headers: {} } as AuthRequest;
    const { res, statusFn } = createMockRes();
    const next = vi.fn() as NextFunction;

    await authenticateToken(req, res as Response, next);

    expect(statusFn).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is not Bearer', async () => {
    const req = { headers: { authorization: 'Basic 12345' } } as AuthRequest;
    const { res, statusFn } = createMockRes();
    const next = vi.fn() as NextFunction;

    await authenticateToken(req, res as Response, next);

    expect(statusFn).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('extracts uid from JWT token payload when Bearer token is provided', async () => {
    // Create a mock JWT payload base64url encoded
    const payload = { uid: 'usr_test_123', email: 'test@stratemark.ai' };
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `header.${base64Payload}.signature`;

    const req = { headers: { authorization: `Bearer ${token}` } } as AuthRequest;
    const { res } = createMockRes();
    const next = vi.fn() as NextFunction;

    await authenticateToken(req, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.userId).toBe('usr_test_123');
    expect(req.user?.email).toBe('test@stratemark.ai');
  });

  it('extracts sub from Google ID token payload when sub is used as uid', async () => {
    const payload = { sub: 'google_user_99', email: 'guser@gmail.com' };
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `header.${base64Payload}.signature`;

    const req = { headers: { authorization: `Bearer ${token}` } } as AuthRequest;
    const { res } = createMockRes();
    const next = vi.fn() as NextFunction;

    await authenticateToken(req, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.userId).toBe('google_user_99');
  });
});
