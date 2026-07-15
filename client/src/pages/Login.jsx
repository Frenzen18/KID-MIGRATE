import AuthCard from '../components/AuthCard.jsx';

export default function Login() {
  return (
    <AuthCard
      icon="fa-child-reaching"
      eyebrow={<>Pediatric Speech &amp;<br />Occupational Therapy Clinic</>}
      title="Welcome back"
      subtitle="Sign in to your parent portal to book sessions and follow your child's progress."
      fallbackHome="/portal"
      showSignupLink
    />
  );
}
