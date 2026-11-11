import { useState } from 'react';
import { ROLES, USERS } from './data';
import { FilterPanel, UserTable } from './UserTable';

export default function UserAdmin() {
  const [filtersOpen, setFiltersOpen] = useState(false);

  return (
    <div>
      <button aria-label="Toggle filters" onClick={() => setFiltersOpen((open) => !open)}>
        {filtersOpen ? 'Hide filters' : 'Show filters'}
      </button>
      <FilterPanel open={filtersOpen} roles={ROLES} />
      <UserTable users={USERS} columns={['name', 'email', 'role']} />
    </div>
  );
}
