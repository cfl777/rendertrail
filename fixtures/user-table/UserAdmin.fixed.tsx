import { useState } from 'react';
import { ROLES, USERS } from './data';
import { FilterPanel, UserTable } from './UserTable';

// Hoisted: the list never depends on state, so it can live outside the component.
const COLUMNS: ('name' | 'email' | 'role')[] = ['name', 'email', 'role'];

export default function UserAdmin() {
  const [filtersOpen, setFiltersOpen] = useState(false);

  return (
    <div>
      <button aria-label="Toggle filters" onClick={() => setFiltersOpen((open) => !open)}>
        {filtersOpen ? 'Hide filters' : 'Show filters'}
      </button>
      <FilterPanel open={filtersOpen} roles={ROLES} />
      <UserTable users={USERS} columns={COLUMNS} />
    </div>
  );
}
