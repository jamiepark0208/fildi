import { z } from 'zod';

export const registerSchema = z.object({
  email:      z.string().email('Invalid email format'),
  username:   z.string().min(3, 'Username must be at least 3 characters').max(20),
  password:   z.string().min(8, 'Password must be at least 8 characters'),
  inviteCode: z.string().min(1, 'Invite code is required'),
});

export const loginSchema = z.object({
  email:    z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export const adminCreateUserSchema = z.object({
  email:    z.string().email('Invalid email format'),
  username: z.string().min(3, 'Username must be at least 3 characters').max(20),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role:     z.enum(['admin', 'member']).default('member'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword:      z.string().min(8, 'New password must be at least 8 characters'),
});
