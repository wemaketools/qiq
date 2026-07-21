import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { selectActiveTenant, selectSession, setThemePreference } from '../../app/slices/sessionSlice';
import type { ThemePreference } from '../../app/slices/sessionSlice';
import { setMePreferences } from '../../api/me';
import { signOut } from '../../auth/supabase';
import Icon from '../common/Icon';

function initialsOf(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

/**
 * Bottom-of-sidebar user card (spec FR-52, PRD 12.2): initials avatar, name, and a menu with
 * profile, theme toggle, and sign-out. `GET /me` does not currently return a display role/title
 * string (only tenant memberships + permission codes), so the secondary line shows the active
 * tenant name instead of a role label — flagged: PRD 12.2 shows a role line ("Head of Sales") the
 * current `/me` contract has no field for; revisit once/if the API adds one.
 */
function UserCard() {
  const dispatch = useAppDispatch();
  const { user, themePreference } = useAppSelector(selectSession);
  const activeTenant = useAppSelector(selectActiveTenant);
  const [menuOpen, setMenuOpen] = useState(false);

  if (!user) {
    return null;
  }

  async function toggleTheme(): Promise<void> {
    const next: ThemePreference = themePreference === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    dispatch(setThemePreference(next));
    await setMePreferences({ themePreference: next });
  }

  return (
    <div data-testid="user-card" className="qiq-user-card" style={{ flexShrink: 0 }}>
      <button
        type="button"
        className="qiq-user-card-btn"
        aria-haspopup="true"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span className="qiq-avatar" data-testid="user-card-initials">
          {initialsOf(user.firstName, user.lastName)}
        </span>
        <span className="qiq-user-card-who">
          <span className="qiq-user-card-name" data-testid="user-card-name">
            {user.firstName} {user.lastName}
          </span>
          <span className="qiq-user-card-sub" data-testid="user-card-role">
            {activeTenant?.tenantName ?? '—'}
          </span>
        </span>
        <Icon name={menuOpen ? 'chevron-down' : 'chevron-up'} size={16} />
      </button>

      {menuOpen && (
        <ul data-testid="user-card-menu" role="menu" className="qiq-menu">
          <li role="menuitem">
            <button type="button">Profile</button>
          </li>
          <li role="menuitem">
            <button type="button" data-testid="theme-toggle" onClick={() => void toggleTheme()}>
              {themePreference === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            </button>
          </li>
          <li role="menuitem">
            <button type="button" data-testid="sign-out-button" onClick={() => void signOut()}>
              Sign out
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

export default UserCard;
