import { NavLink } from 'react-router-dom';

/**
 * Sibling-page navigation across the three User Manager sections (spec scope: "Routes
 * /admin/users, /admin/roles, /admin/groups (tabbed or sibling pages)") — the sidebar carries a
 * single gated "User Manager" entry (`nav-user-manager` -> `/admin/users`); this local nav lets an
 * administrator move between Users/Roles/Groups once inside the section. Each destination is still
 * independently `RouteGuard`-gated (`users.view`/`roles.view`/`groups.view`) at the router level, so
 * these links merely aid navigation and never grant access on their own.
 */
function UserManagerNav() {
  const tabClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'qiq-tab qiq-tab--active' : 'qiq-tab');
  return (
    <nav data-testid="user-manager-nav" className="qiq-tabs" style={{ marginBottom: 'var(--qiq-space-4)' }}>
      <NavLink to="/admin/users" data-testid="user-manager-nav-users" className={tabClass}>
        Users
      </NavLink>
      <NavLink to="/admin/roles" data-testid="user-manager-nav-roles" className={tabClass}>
        Roles
      </NavLink>
      <NavLink to="/admin/groups" data-testid="user-manager-nav-groups" className={tabClass}>
        Groups
      </NavLink>
    </nav>
  );
}

export default UserManagerNav;
