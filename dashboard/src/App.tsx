import { useState, useEffect, useCallback, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { NumberCheckProvider } from './components/NumberCheckProvider';
import { useRole } from './hooks/useRole';
import { RoleProvider } from './components/RoleProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { API_BASE_URL } from './services/api';
import { clearActorState, isUserRole, resolveStartupValidation } from './utils/authLifecycle';
import { clearCredential, readCredential, storeAccount, storeCredential, type StoredAccount } from './utils/credential';
import './App.css';

const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Chats = lazy(() => import('./pages/Chats').then(m => ({ default: m.Chats })));
const Inbox = lazy(() => import('./pages/Inbox').then(m => ({ default: m.Inbox })));
const Reports = lazy(() => import('./pages/Reports').then(m => ({ default: m.Reports })));
const Divisions = lazy(() => import('./pages/Divisions').then(m => ({ default: m.Divisions })));
const Pipeline = lazy(() => import('./pages/Pipeline').then(m => ({ default: m.Pipeline })));
const Campaigns = lazy(() => import('./pages/Campaigns').then(m => ({ default: m.Campaigns })));
const Webhooks = lazy(() => import('./pages/Webhooks').then(m => ({ default: m.Webhooks })));
const Templates = lazy(() => import('./pages/Templates').then(m => ({ default: m.Templates })));
const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));
const ApiKeys = lazy(() => import('./pages/ApiKeys').then(m => ({ default: m.ApiKeys })));
const Users = lazy(() => import('./pages/Users').then(m => ({ default: m.Users })));
const MessageTester = lazy(() => import('./pages/MessageTester').then(m => ({ default: m.MessageTester })));
const NumberChecker = lazy(() => import('./pages/NumberChecker').then(m => ({ default: m.NumberChecker })));
const Infrastructure = lazy(() => import('./pages/Infrastructure').then(m => ({ default: m.Infrastructure })));
const Plugins = lazy(() => import('./pages/Plugins'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

function AppContent() {
  // Capture the key ONCE at mount. Read live per render, the null→key transition when
  // handleLogin stores a fresh key would re-fire the startup check below and double the /auth/me
  // request on every sign-in — the effect is for genuine page refreshes with a saved key only.
  const [savedKey] = useState(() => readCredential());
  const [isAuthenticated, setIsAuthenticated] = useState(!!savedKey);
  const [, setApiKey] = useState(savedKey || '');
  const { setRole, role, setEngineType, setScoped, scoped, setKeyIdentity } = useRole();

  const handleLogin = (
    key: string,
    validatedRole?: string,
    engineType?: string,
    scoped = false,
    keyId?: string,
    keyName?: string,
    user?: StoredAccount,
  ) => {
    setApiKey(key);
    storeCredential(key);
    // An API-key sign-in passes no account, which also clears the name cached by an earlier email
    // sign-in in this tab, so the Users page never marks a key's caller as a person.
    storeAccount(user ?? null);

    // The login page's validate response already carried the role, so no second /auth/validate
    // round-trip is needed here. An absent or unrecognized role falls back to viewer, the
    // least-privileged default.
    setRole(isUserRole(validatedRole) ? validatedRole : 'viewer');
    setEngineType(engineType ?? null);
    setScoped(scoped);
    setKeyIdentity?.(keyId ?? null, keyName ?? null);

    setIsAuthenticated(true);
  };

  const handleLogout = useCallback(() => {
    setApiKey('');
    setIsAuthenticated(false);
    setRole(null);
    setEngineType(null);
    setScoped(false);
    setKeyIdentity?.(null, null);
    clearCredential();
    // Wipe the React Query cache too: it is keyed by resource, not actor, so without a full
    // clear a logout → login in the same tab with a different key/scope shows the previous
    // actor's sessions/messages/apiKeys/audit rows.
    clearActorState(queryClient);
  }, [setRole, setEngineType, setScoped, setKeyIdentity]);

  // Re-validate and refresh the role on mount if already authenticated
  useEffect(() => {
    if (!savedKey) return;

    // /auth/me answers for both credential kinds and adds the signed-in account, so one round-trip
    // refreshes the role, the session scope, the key identity and the stored account name. It is
    // the same trust decision /auth/validate feeds: 401/403 logs out, 429/5xx keeps the cache.
    fetch(`${API_BASE_URL}/auth/me`, {
      method: 'GET',
      headers: { 'X-API-Key': savedKey },
    })
      .then(async res => {
        const body: {
          user?: StoredAccount | null;
          role?: string;
          engineType?: string;
          scoped?: unknown;
          keyId?: unknown;
          keyName?: unknown;
        } | null = await res.json().catch(() => null);
        // resolveStartupValidation reads the /auth/validate shape; a 2xx from /auth/me is the same
        // proof of validity that endpoint's `valid: true` carries.
        const decision = resolveStartupValidation(
          res.status,
          body ? { valid: true, role: body.role, engineType: body.engineType, scoped: body.scoped } : null,
        );
        // Nothing cancels this request on logout. If the user has since signed out, or back in with
        // another key, the answer is about a key no longer in use: applying it would hand the new
        // session the old key's role, or log it out over the old key's 401.
        if (readCredential() !== savedKey) return;
        if (decision.action === 'logout') {
          handleLogout();
        } else if (decision.action === 'role') {
          setRole(decision.role);
          setScoped(decision.scoped);
          if (decision.engineType) setEngineType(decision.engineType);
          if (typeof body?.keyId === 'string') {
            setKeyIdentity?.(body.keyId, typeof body.keyName === 'string' ? body.keyName : null);
          }
          // A session token resolves to its account; an API key resolves to null, which drops any
          // account left behind by an earlier email sign-in in this tab.
          const account = body?.user;
          storeAccount(
            account && typeof account.id === 'string' && typeof account.email === 'string'
              ? { id: account.id, email: account.email, name: account.name }
              : null,
          );
        }
      })
      .catch(() => {
        // Network failure (API unreachable): keep the cached role so a transient outage at
        // page load doesn't eject the user — an explicit 401/403 above still logs out.
      });
  }, [savedKey, setRole, setEngineType, setScoped, setKeyIdentity, handleLogout]);

  const loadingFallback = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Loader2 className="animate-spin" size={32} />
    </div>
  );

  if (!isAuthenticated) {
    return (
      <Suspense fallback={loadingFallback}>
        <Login onLogin={handleLogin} />
      </Suspense>
    );
  }

  return (
    <ToastProvider>
      {/* Above the routes, so a bulk Number Checker run survives leaving its page; a logout unmounts it. */}
      <NumberCheckProvider>
        <BrowserRouter>
          <Suspense fallback={loadingFallback}>
            <Routes>
              <Route path="/" element={<Layout onLogout={handleLogout} userRole={role} />}>
                <Route index element={<Dashboard />} />
                <Route path="sessions" element={<Sessions />} />
                <Route path="chats" element={<Chats />} />
                <Route path="inbox" element={<Inbox />} />
                <Route path="reports" element={<Reports />} />
                {role === 'admin' && <Route path="divisions" element={<Divisions />} />}
                <Route path="pipeline" element={<Pipeline />} />
                <Route path="campaigns" element={<Campaigns />} />
                <Route path="number-checker" element={<NumberChecker />} />
                <Route path="webhooks" element={<Webhooks />} />
                <Route path="templates" element={<Templates />} />
                {role === 'admin' && !scoped && <Route path="api-keys" element={<ApiKeys />} />}
                {role === 'admin' && !scoped && <Route path="users" element={<Users />} />}
                {role === 'admin' && <Route path="logs" element={<Logs />} />}
                <Route path="message-tester" element={<MessageTester />} />
                {role === 'admin' && !scoped && <Route path="infrastructure" element={<Infrastructure />} />}
                {role === 'admin' && !scoped && <Route path="plugins" element={<Plugins />} />}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </NumberCheckProvider>
    </ToastProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RoleProvider>
          <AppContent />
        </RoleProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
