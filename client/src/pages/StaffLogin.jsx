import AuthCard from '../components/AuthCard.jsx';

export default function StaffLogin() {
  return (
    <AuthCard
      icon="fa-user-tie"
      eyebrow="Staff Portal"
      title="Staff sign-in"
      subtitle="Sign in with your staff account to manage clients, reservations, and clinic content."
      portal="staff"
      fallbackHome="/staff"
      footerLink={{ to: '/therapist/login', label: 'Therapist sign-in instead →' }}
    />
  );
}
