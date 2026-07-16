import { useState } from 'react';

const OTHERS = 'Others';

/**
 * "Primary mode of communication" only makes sense once the child has been
 * marked non-verbal, so it stays hidden until "Verbal" is answered "No".
 * Keyed by label, not a generic admin-configurable dependency, it's the one
 * conditional relationship the clinic's intake form needs today.
 */
export function devFieldHidden(field, allFields, data) {
  if (field.label !== 'Primary mode of communication') return false;
  const verbalField = allFields.find(f => f.label === 'Verbal');
  if (!verbalField) return false;
  return data[verbalField.id] !== 'No';
}

/**
 * Renders one Development & Functional Information field: 'text' is a plain
 * input, 'select' a dropdown, 'select_other' a dropdown with an implicit
 * trailing "Others" option that reveals a free-text box underneath.
 */
export default function DevFunctionalField({ field, data, onChange, disabled }) {
  const value = data[field.id] || '';
  const options = field.options || [];
  const [otherMode, setOtherMode] = useState(field.field_type === 'select_other' && value !== '' && !options.includes(value));

  if (field.field_type === 'select' || field.field_type === 'select_other') {
    return (
      <>
        <select
          className="form-select"
          value={otherMode ? OTHERS : value}
          disabled={disabled}
          onChange={e => {
            if (field.field_type === 'select_other' && e.target.value === OTHERS) {
              setOtherMode(true);
              onChange(field.id, '');
            } else {
              setOtherMode(false);
              onChange(field.id, e.target.value);
            }
          }}
        >
          <option value="">- Select -</option>
          {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
          {field.field_type === 'select_other' && <option value={OTHERS}>{OTHERS}</option>}
        </select>
        {field.field_type === 'select_other' && otherMode && (
          <input
            className="form-input"
            style={{ marginTop: 6 }}
            value={value}
            disabled={disabled}
            onChange={e => onChange(field.id, e.target.value)}
            placeholder="Please specify"
          />
        )}
      </>
    );
  }

  return <input className="form-input" value={value} disabled={disabled} onChange={e => onChange(field.id, e.target.value)} placeholder="Optional" />;
}
