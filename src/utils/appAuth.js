'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function requireUser(ctx) {
  const auth = ctx.request.header.authorization;
  if (!auth?.startsWith('Bearer ')) {
    ctx.throw(401, 'Authentication required');
  }

  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    return {
      id: payload.sub,
      email: payload.email,
    };
  } catch {
    ctx.throw(401, 'Invalid or expired token');
  }
}

module.exports = { signToken, requireUser };
