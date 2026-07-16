import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';

/* == page: my-calendar (therapist-only) ==
   Same weekly-grid idea as the admin Master Calendar, but scoped to just the
   logged-in therapist's own shift hours and their own bookings, never the
   whole clinic's schedule. */

function pad(n) { return String(n).padStart(2, '0'); }
function fmtYMD(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
/** 24h hour -> "8:00 AM" slot label. Mirrors server/routes/shifts.js hourLabel(). */
function hourLabel(h) {
  const hr = h % 12 === 0 ? 12 : h % 12;
  return hr + ':00 ' + (h >= 12 ? 'PM' : 'AM');
}
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ALL_WORK_DAYS = [true, true, true, true, true, true, false];

export default function MyCalendar({ toast, therapistName }) {
  const [shift, setShift] = useState(null);
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);

  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const weekStart = useMemo(() => {
    const dow = today.getDay();
    const d = new Date(today);
    d.setDate(today.getDate() - ((dow === 0 ? 7 : dow) - 1));
    return d;
  }, [today]);
  const weekDays = useMemo(() => {
    const out = [];
    for (let i = 0; i < 7; i++) { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); out.push(d); }
    return out;
  }, [weekStart]);

  useEffect(() => {
    if (!therapistName) return;
    setLoading(true);
    Promise.all([
      api('/shifts'),
      api('/reservations?from=' + fmtYMD(weekDays[0]) + '&to=' + fmtYMD(weekDays[6]) + '&therapist_name=' + encodeURIComponent(therapistName))
    ]).then(([shifts, res]) => {
      setShift((shifts || []).find(s => s.name === therapistName) || null);
      setReservations((res || []).filter(r => !['cancelled', 'declined'].includes(r.status)));
    }).catch(() => {
      toast('Failed to load your calendar', 'fa-triangle-exclamation');
    }).finally(() => setLoading(false));
  }, [therapistName, weekDays, toast]);

  const slotMap = useMemo(() => {
    const m = {};
    for (const r of reservations) (m[r.date + '|' + r.time_slot] = m[r.date + '|' + r.time_slot] || []).push(r);
    return m;
  }, [reservations]);

  const workDays = shift?.work_days && shift.work_days.length === 7 ? shift.work_days : ALL_WORK_DAYS;
  const timeSlots = [];
  if (shift) for (let h = shift.start_hour; h < shift.end_hour; h++) timeSlots.push(hourLabel(h));

  const weekLabel = MON_SHORT[weekDays[0].getMonth()] + ' ' + weekDays[0].getDate() + ' – ' + MON_SHORT[weekDays[6].getMonth()] + ' ' + weekDays[6].getDate() + ', ' + weekDays[6].getFullYear();
  const daysOffLabel = DAY_SHORT.filter((_, i) => workDays[i] === false).join(', ') || 'None';

  return (
    <div className="spa-page" id="spa-my-calendar">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Booking Schedule</h1>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />Loading your calendar…</div>
      ) : !shift ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No shift has been set up for you yet, contact an admin.</div>
      ) : (
        <div className="card" style={{ padding: '22px 0 0' }}>
          <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div className="section-title">My Calendar</div>
              <div className="section-sub">Week of {weekLabel}</div>
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <span className="pill pill-blue" style={{ fontSize: 11 }}><i className="fa-regular fa-clock" style={{ marginRight: 5 }} />{hourLabel(shift.start_hour)} – {hourLabel(shift.end_hour)}</span>
              <span className="pill pill-gray" style={{ fontSize: 11 }}><i className="fa-regular fa-calendar-xmark" style={{ marginRight: 5 }} />Off: {daysOffLabel}</span>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr style={{ background: '#F8FAFC' }}>
                  <th style={{ padding: '10px 12px', textAlign: 'left', color: '#64748B', fontWeight: 600, borderBottom: '2px solid #E2E8F0', width: 110 }}>Time</th>
                  {weekDays.map((d, i) => {
                    const isToday = fmtYMD(d) === fmtYMD(today);
                    const off = workDays[i] === false;
                    const label = DAY_SHORT[i] + ' ' + d.getDate();
                    return (
                      <th key={i} style={{
                        padding: '10px 8px', textAlign: 'center', fontWeight: isToday ? 700 : 600,
                        color: off ? '#CBD5E1' : (isToday ? '#0EA5E9' : '#64748B'),
                        borderBottom: isToday ? '2px solid #0EA5E9' : '2px solid #E2E8F0',
                        background: isToday ? '#F0F9FF' : (off ? '#F8FAFC' : undefined)
                      }}>{label}{isToday ? ' ◀ Today' : ''}{off ? ' · Off' : ''}</th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {timeSlots.length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, fontSize: 12.5, color: '#94A3B8' }}>No shift hours set</td></tr>
                )}
                {timeSlots.map(time => (
                  <tr key={time} style={{ borderBottom: '1px solid #F1F5F9' }}>
                    <td style={{ padding: '10px 12px', color: '#94A3B8', fontWeight: 500 }}>{time}</td>
                    {weekDays.map((d, i) => {
                      const isToday = fmtYMD(d) === fmtYMD(today);
                      const off = workDays[i] === false;
                      const cellBg = off ? { background: '#F8FAFC' } : (isToday ? { background: '#F0F9FF' } : {});
                      if (off) return <td key={i} style={{ padding: '6px 4px', textAlign: 'center', ...cellBg }} />;
                      const bks = slotMap[fmtYMD(d) + '|' + time] || [];
                      if (bks.length) {
                        return (
                          <td key={i} style={{ padding: '6px 4px', textAlign: 'center', ...cellBg }}>
                            {bks.map(bk => {
                              const client = bk.clients?.full_name || '-';
                              const type = bk.session_type || '';
                              const isSpeech = /speech/i.test(type);
                              const pending = bk.status === 'pending';
                              const blockBg = pending ? '#FEF9C3' : (isSpeech ? '#CCFBF1' : '#DBEAFE');
                              const blockColor = pending ? '#B45309' : (isSpeech ? '#0F766E' : '#1D4ED8');
                              const typeAbbr = isSpeech ? 'Sp' : (/occupational|OT/i.test(type) ? 'OT' : (type ? type.substring(0, 4) : ''));
                              return (
                                <div key={bk.id} style={{ background: blockBg, color: blockColor, borderRadius: 6, padding: '4px 6px', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                                  {pending ? '⏳ ' : ''}{client.split(' ')[0]}, {typeAbbr}{bk.room ? <><br /><span style={{ fontWeight: 400 }}>{bk.room}</span></> : null}
                                </div>
                              );
                            })}
                          </td>
                        );
                      }
                      return <td key={i} style={{ padding: '6px 4px', ...cellBg }} />;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 14, padding: '14px 24px', borderTop: '1px solid #F1F5F9', fontSize: 12, color: '#64748B', flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 12, height: 12, background: '#DBEAFE', borderRadius: 3, display: 'inline-block' }} />OT Session</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 12, height: 12, background: '#CCFBF1', borderRadius: 3, display: 'inline-block' }} />Speech Session</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 12, height: 12, background: '#FEF9C3', borderRadius: 3, display: 'inline-block' }} />Pending Booking</span>
          </div>
        </div>
      )}

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Booking Schedule</span></div>
    </div>
  );
}
