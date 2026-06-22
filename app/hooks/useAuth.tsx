import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getStoredAuth, verifySession, signOut as performSignOut, User } from '../services/auth';

interface AuthContextType {
  user: User | null;
  sessionToken: string | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  sessionToken: null,
  loading: true,
  signOut: async () => {},
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Loads the stored session and validates it against the server. Falls back to
  // the cached user if verification can't reach the server, so a flaky network
  // doesn't bounce a signed-in user back to the login screen.
  const refresh = useCallback(async () => {
    const stored = await getStoredAuth();

    if (!stored.sessionToken) {
      setUser(null);
      setSessionToken(null);
      setLoading(false);
      return;
    }

    setSessionToken(stored.sessionToken);
    const verified = await verifySession(stored.sessionToken);
    setUser(verified?.user ?? stored.user ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await performSignOut();
    setUser(null);
    setSessionToken(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, sessionToken, loading, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
