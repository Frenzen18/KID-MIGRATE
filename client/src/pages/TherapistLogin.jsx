import AuthCard from '../components/AuthCard.jsx';

export default function TherapistLogin() {
  return (
    <AuthCard
      icon="fa-hands-holding-child"
      iconSize={36}
      eyebrow={<>Therapist Portal<br />OT &amp; Speech</>}
      title="Therapist sign-in"
      subtitle="For occupational and speech therapists, sign in to view your clients and progress notes."
      portal="therapist"
      fallbackHome="/portal"
      footerLink={{ to: '/staff/login', label: 'Staff sign-in instead →' }}
    />
  );
}
