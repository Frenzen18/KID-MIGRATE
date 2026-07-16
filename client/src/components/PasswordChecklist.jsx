const RULES = [
  { label: 'At least 8 characters long', test: pw => pw.length >= 8 },
  { label: 'At least 1 uppercase letter (A–Z)', test: pw => /[A-Z]/.test(pw) },
  { label: 'At least 1 lowercase letter (a–z)', test: pw => /[a-z]/.test(pw) },
  { label: 'At least 1 number (0–9)', test: pw => /[0-9]/.test(pw) },
  { label: 'At least 1 special character (e.g. ! @ # $ % ^ & *)', test: pw => /[^A-Za-z0-9]/.test(pw) }
];

/** Same policy the server enforces (see server/validate.js), kept in sync by hand. */
export const passwordMeetsPolicy = pw => RULES.every(r => r.test(pw || ''));

/** Live checklist that lights up each rule green as the typed password satisfies it. */
export default function PasswordChecklist({ password }) {
  const pw = password || '';
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
      {RULES.map(({ label, test }) => {
        const ok = test(pw);
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: ok ? '#16A34A' : '#94A3B8', fontWeight: ok ? 600 : 500, transition: 'color .15s' }}>
            <i className={'fa-solid ' + (ok ? 'fa-circle-check' : 'fa-circle')} style={{ fontSize: ok ? 13 : 6, width: 13, textAlign: 'center', color: ok ? '#16A34A' : '#CBD5E1' }} />
            {label}
          </div>
        );
      })}
    </div>
  );
}

/** 0–4: length + character variety. Simple heuristic, scored live as the user types. */
function passwordScore(pw) {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  const variety = RULES.slice(1).filter(r => r.test(pw)).length; // uppercase/lowercase/number/special
  if (variety >= 2) score++;
  if (variety >= 3 && pw.length >= 10) score++;
  return score;
}

const STRENGTH = [
  { label: 'Too short', color: '#DC2626' },
  { label: 'Weak', color: '#DC2626' },
  { label: 'Fair', color: '#D97706' },
  { label: 'Good', color: '#0D9488' },
  { label: 'Strong', color: '#16A34A' }
];

/** "Weak/Fair/Good/Strong" bar, meant to sit under PasswordChecklist. */
export function PasswordStrengthMeter({ password }) {
  if (!password) return null;
  const score = passwordScore(password);
  const { label, color } = STRENGTH[score];
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {[1, 2, 3, 4].map(i => (
          <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= score ? color : '#E5E7EB', transition: 'background .2s' }} />
        ))}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color, marginTop: 5 }}>{label}</div>
    </div>
  );
}
