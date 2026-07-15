import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { ToastProvider } from './components/ui.jsx';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import AdminLogin from './pages/AdminLogin.jsx';
import StaffLogin from './pages/StaffLogin.jsx';
import TherapistLogin from './pages/TherapistLogin.jsx';
import Signup from './pages/Signup.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import SetPassword from './pages/SetPassword.jsx';
import TherapistPortal from './portals/therapist/TherapistPortal.jsx';
import AdminPortal from './portals/admin/AdminPortal.jsx';
import StaffPortal from './portals/staff/StaffPortal.jsx';
import ParentPortal from './portals/parent/ParentPortal.jsx';

// Where each role lands after login, a full-fidelity self-contained portal.
export const HOME_FOR_ROLE = {
  admin: '/admin',
  staff: '/staff',
  ot: '/ot',
  speech: '/speech',
  parent: '/parent'
};

function RequireAuth({ children, roles, loginPath = '/login' }) {
  const { user } = useAuth();
  if (!user) return <Navigate to={loginPath} replace />;
  // Admin-issued temporary passwords must be replaced before the user can
  // reach any portal page, enforced here so no route is reachable around it.
  if (user.must_change_password) return <Navigate to="/set-password" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={HOME_FOR_ROLE[user.role] || '/'} replace />;
  return children;
}

// Guards /set-password itself: any logged-in user may be here, but once the
// flag is already cleared there's nothing to do, send them to their portal.
function RequireSession({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!user.must_change_password) return <Navigate to={HOME_FOR_ROLE[user.role] || '/'} replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/set-password" element={<RequireSession><SetPassword /></RequireSession>} />
            <Route path="/admin/login" element={<AdminLogin />} />
            <Route path="/staff/login" element={<StaffLogin />} />
            <Route path="/therapist/login" element={<TherapistLogin />} />
            <Route path="/admin" element={<RequireAuth roles={['admin']} loginPath="/admin/login"><AdminPortal /></RequireAuth>} />
            <Route path="/staff" element={<RequireAuth roles={['staff']} loginPath="/staff/login"><StaffPortal /></RequireAuth>} />
            <Route path="/parent" element={<RequireAuth roles={['parent']}><ParentPortal /></RequireAuth>} />
            <Route path="/ot" element={<RequireAuth roles={['ot']} loginPath="/therapist/login"><TherapistPortal /></RequireAuth>} />
            <Route path="/speech" element={<RequireAuth roles={['speech']} loginPath="/therapist/login"><TherapistPortal /></RequireAuth>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
