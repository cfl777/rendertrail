export type User = { id: number; name: string; email: string; role: Role };
export type Role = 'admin' | 'editor' | 'viewer';

export const ROLES: Role[] = ['admin', 'editor', 'viewer'];

// 150 users with deterministic names and roles.
export const USERS: User[] = Array.from({ length: 150 }, (_, i) => ({
  id: i + 1,
  name: `User ${i + 1}`,
  email: `user${i + 1}@example.test`,
  role: ROLES[i % ROLES.length],
}));
