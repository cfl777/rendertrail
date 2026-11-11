import { memo } from 'react';
import type { Role, User } from './data';

// Deliberately slow (about 0.06 ms per row) so wasted renders cost real time.
function busyWait(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // do nothing
  }
}

type Column = keyof Omit<User, 'id'>;

function UserRow({ user, columns }: { user: User; columns: Column[] }) {
  busyWait(0.06);
  return (
    <tr>
      {columns.map((column) => (
        <td key={column}>{user[column]}</td>
      ))}
    </tr>
  );
}

export const UserTable = memo(function UserTable({ users, columns }: { users: User[]; columns: Column[] }) {
  return (
    <table>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column}>{column}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {users.map((user) => (
          <UserRow key={user.id} user={user} columns={columns} />
        ))}
      </tbody>
    </table>
  );
});

export const FilterPanel = memo(function FilterPanel({ open, roles }: { open: boolean; roles: Role[] }) {
  if (!open) return null;
  return (
    <aside>
      {roles.map((role) => (
        <label key={role}>
          <input type="checkbox" /> {role}
        </label>
      ))}
    </aside>
  );
});
