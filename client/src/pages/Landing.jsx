import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import './landing.css';

/** In Branding & Theme's live preview (?preview=1), sign-in/portal links render
    as inert, non-clickable copies, same visual design, no navigating out of the iframe. */
function AuthLink({ preview, to, className, children }) {
  if (preview) return <span className={className} style={{ cursor: 'default' }}>{children}</span>;
  return <Link to={to} className={className}>{children}</Link>;
}

/** Fades a section in the first time it scrolls into view, gives the page life without re-triggering on every scroll. */
function useReveal() {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); obs.disconnect(); }
    }, { threshold: 0.12 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return [ref, visible];
}

/** Animated (not instant-jump) scroll to an in-page section, respecting each target's scroll-margin-top. */
function scrollToSection(e, id) {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* Faithful port of index.html, same markup, same copy, same images. */
export default function Landing() {
  const [searchParams] = useSearchParams();
  const preview = searchParams.get('preview') === '1';

  const [cmsPosts, setCmsPosts] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [annDismissed, setAnnDismissed] = useState(false);
  const [annIndex, setAnnIndex] = useState(0);
  const [newsPage, setNewsPage] = useState(0);
  const [homepage, setHomepage] = useState(null);
  const [openPost, setOpenPost] = useState(null);
  const [brand, setBrand] = useState(null);

  useEffect(() => {
    fetch('/api/cms/public')
      .then(r => r.json())
      .then(data => {
        setCmsPosts(data.posts || []);
        setAnnouncements(data.announcements || (data.announcement ? [data.announcement] : []));
        if (data.homepage) setHomepage(data.homepage);
      })
      .catch(() => {});
    fetch('/api/settings/branding/public').then(r => r.json()).then(setBrand).catch(() => {});

    const onBranding = e => { if (e.detail) setBrand(e.detail); };
    window.addEventListener('kid:branding', onBranding);
    return () => window.removeEventListener('kid:branding', onBranding);
  }, []);

  // Rotate announcements every 6 seconds
  useEffect(() => {
    if (announcements.length <= 1) return;
    const timer = setInterval(() => {
      setAnnIndex(i => (i + 1) % announcements.length);
    }, 6000);
    return () => clearInterval(timer);
  }, [announcements.length]);

  const [promiseRef, promiseVisible] = useReveal();
  const [newsRef, newsVisible] = useReveal();

  return (
    <div className="ld">
      {/* NAV */}
      <nav className="ld-nav">
        <Link to="/" className="ld-nav-brand">
          {brand?.logo_url
            ? <img src={brand.logo_url} alt={brand.clinic_name || 'Clinic logo'} style={{ width: 34, height: 34, borderRadius: 8, objectFit: 'cover' }} />
            : <div className="ld-nav-icon">{(brand?.clinic_name || 'KID').charAt(0)}</div>}
          <div style={{ minWidth: 0 }}>
            <div className="ld-nav-name" style={{ maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={brand?.clinic_name}>{brand?.clinic_name || 'KID'}</div>
            <div className="ld-nav-sub">Pediatric Clinic System</div>
          </div>
        </Link>
        <div className="ld-nav-links">
          <a href="#news" onClick={e => scrollToSection(e, 'news')}>News</a>
          <a href="#announcements" onClick={e => scrollToSection(e, 'announcements')}>Announcements</a>
          <a href="#promise" onClick={e => scrollToSection(e, 'promise')}>Our Approach</a>
          <a href="#about" onClick={e => scrollToSection(e, 'about')}>About</a>
        </div>
        <div className="ld-nav-actions">
          <AuthLink preview={preview} to="/login" className="ld-nav-ghost">Sign In</AuthLink>
        </div>
      </nav>

      {/* ANNOUNCEMENT BAND */}
      {!annDismissed && announcements.length > 0 && (
        <div className="ld-ann-band" id="announcements">
          <div className="ld-ann-inner">
            <span className="ld-ann-label">Announcement</span>
            <div className="ld-ann-text" style={{ transition: 'opacity .3s', flex: 1 }}>{announcements[annIndex]?.body || ''}</div>
            {announcements.length > 1 && (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 12 }}>
                {announcements.map((_, i) => (
                  <span key={i} onClick={() => setAnnIndex(i)} style={{ width: 8, height: 8, borderRadius: '50%', background: i === annIndex ? '#0F172A' : 'rgba(0,0,0,.2)', cursor: 'pointer', transition: 'background .2s' }} />
                ))}
              </div>
            )}
            <button onClick={() => setAnnDismissed(true)} style={{ background: 'none', border: 'none', color: 'rgba(0,0,0,.5)', fontSize: 18, cursor: 'pointer', padding: '4px 8px', marginLeft: 8, lineHeight: 1 }} aria-label="Dismiss announcement">×</button>
          </div>
        </div>
      )}

      {/* HERO */}
      <section className="ld-hero-sec">
        <div className="ld-hero-inner">
          <div className="ld-hero-in">
            <div className="ld-hero-kicker">{brand?.clinic_name || 'Bloomsdale Therapy Center'}{brand?.address ? ' · ' + brand.address : ' · Imus, Cavite'}</div>
            <h1 className="ld-hero-title">{(() => {
              const text = homepage?.headline || 'Every child deserves the chance to thrive.';
              const words = text.split(' ');
              if (words.length > 2) {
                return <>{words.slice(0, -2).join(' ')} <em>{words.slice(-2).join(' ')}</em></>;
              }
              return text;
            })()}</h1>
            <p className="ld-hero-sub">{homepage?.sub || 'We provide pediatric speech and occupational therapy in a warm, child-centered environment. Book sessions, follow your child\'s progress, and stay connected with our clinic, all in one place.'}</p>
            <div className="ld-hero-cta">
              <a href="#news" className="ld-cta-b" onClick={e => scrollToSection(e, 'news')}>Read the latest news →</a>
            </div>
          </div>
          <div className="ld-hero-photo ld-hero-photo-in">
            <img src={homepage?.photo ? (homepage.photo.startsWith('http') ? homepage.photo : '/' + homepage.photo) : '/KID INDEX HTML PICTURES 1.webp'} alt="A mother and her daughter laughing together" />
            <div className="ld-photo-caption">Families at the heart of everything we do</div>
          </div>
        </div>
      </section>

      {/* PROMISE SECTION */}
      <section className={'ld-promise ld-reveal' + (promiseVisible ? ' ld-reveal-in' : '')} id="promise" ref={promiseRef}>
        <div className="ld-promise-inner">
          <div className="ld-promise-img">
            <img src="/KID INDEX HTML PICTURES 2.jpg" alt="A parent holding a young child's hand outdoors" />
          </div>
          <div>
            <div className="ld-s-tag">Our Approach</div>
            <div className="ld-s-title" style={{ marginBottom: 16 }}>Small steps, <em>celebrated together.</em></div>
            <p className="ld-promise-lead">{homepage?.clinicServices || 'At Bloomsdale, therapy is a partnership with your family. Our therapists turn sessions into play, challenges into progress, and milestones into moments worth sharing.'}</p>
            <div className="ld-promise-points">
              <div className="ld-ppoint"><div className="ld-ppoint-num">01</div><div className="ld-ppoint-tx">Personalized speech and occupational therapy plans built around each child</div></div>
              <div className="ld-ppoint"><div className="ld-ppoint-num">02</div><div className="ld-ppoint-tx">Milestone tracking that parents can follow between sessions</div></div>
              <div className="ld-ppoint"><div className="ld-ppoint-num">03</div><div className="ld-ppoint-tx">A calm, sensory-friendly space where children feel safe to learn</div></div>
            </div>
          </div>
        </div>
      </section>

      {/* NEWS & ANNOUNCEMENTS */}
      <div id="news" className={'ld-reveal' + (newsVisible ? ' ld-reveal-in' : '')} ref={newsRef}>
        <div className="ld-section">
          <div className="ld-s-tag">News &amp; Announcements</div>
          <div className="ld-s-title">What's happening <em>at the clinic.</em></div>
          <p className="ld-s-sub">The latest news, program updates, and important announcements from Bloomsdale Therapy Center.</p>
          <div className="ld-news-grid">
            {cmsPosts.length > 0 ? cmsPosts.slice(newsPage * 3, newsPage * 3 + 3).map(post => (
              <div className="ld-news-card" key={post.id} onClick={() => setOpenPost(post)}>
                {post.image_url ? (
                  <div className="ld-news-thumb"><img src={post.image_url} alt={post.title} /></div>
                ) : (
                  <div className="ld-news-thumb placeholder">
                    <svg viewBox="0 0 24 24"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" /></svg>
                  </div>
                )}
                <div className="ld-news-body">
                  <span className="ld-news-cat">{post.category}</span>
                  <h3>{post.title}</h3>
                  <p>{post.body ? post.body.slice(0, 150) + (post.body.length > 150 ? '...' : '') : ''}</p>
                  <div className="ld-news-meta">{post.published_at ? new Date(post.published_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''}</div>
                </div>
              </div>
            )) : (
              <>
                <div className="ld-news-card" onClick={() => setOpenPost({ id: 'sample-1', category: 'Programs', title: 'New speech therapy program launched for ages 2–8', body: 'An expanded speech therapy program with specialized sessions for early language development in toddlers and young children.', published_at: '2026-06-22', image_url: '/KID INDEX HTML PICTURES 3.jfif' })}>
                  <div className="ld-news-thumb"><img src="/KID INDEX HTML PICTURES 3.jfif" alt="A mother and son talking together during a session" /></div>
                  <div className="ld-news-body">
                    <span className="ld-news-cat">Programs</span>
                    <h3>New speech therapy program launched for ages 2–8</h3>
                    <p>An expanded speech therapy program with specialized sessions for early language development in toddlers and young children.</p>
                    <div className="ld-news-meta">June 22, 2026</div>
                  </div>
                </div>
                <div className="ld-news-card" onClick={() => setOpenPost({ id: 'sample-2', category: 'Awards', title: 'Clinic recognized with Community Health Award 2026', body: 'Bloomsdale Therapy Center has been recognized for its contribution to pediatric occupational and speech therapy in Imus, Cavite.', published_at: '2026-06-15', image_url: null })}>
                  <div className="ld-news-thumb placeholder">
                    <svg viewBox="0 0 24 24"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" /></svg>
                  </div>
                  <div className="ld-news-body">
                    <span className="ld-news-cat">Awards</span>
                    <h3>Clinic recognized with Community Health Award 2026</h3>
                    <p>Bloomsdale Therapy Center has been recognized for its contribution to pediatric occupational and speech therapy in Imus, Cavite.</p>
                    <div className="ld-news-meta">June 15, 2026</div>
                  </div>
                </div>
                <div className="ld-news-card" onClick={() => setOpenPost({ id: 'sample-3', category: 'Events', title: 'Summer Therapy Camp 2026: registration now open', body: 'Runs July 1–31, 2026 with sensory integration activities, individual sessions, and parent workshops every Saturday.', published_at: '2026-06-10', image_url: null })}>
                  <div className="ld-news-thumb placeholder">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></svg>
                  </div>
                  <div className="ld-news-body">
                    <span className="ld-news-cat">Events</span>
                    <h3>Summer Therapy Camp 2026: registration now open</h3>
                    <p>Runs July 1–31, 2026 with sensory integration activities, individual sessions, and parent workshops every Saturday.</p>
                    <div className="ld-news-meta">June 10, 2026</div>
                  </div>
                </div>
              </>
            )}
          </div>
          {/* Navigation arrows for news */}
          {cmsPosts.length > 3 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16, marginTop: 24 }}>
              <button onClick={() => setNewsPage(p => Math.max(0, p - 1))} disabled={newsPage === 0} style={{ width: 40, height: 40, borderRadius: '50%', border: '1.5px solid #E2E8F0', background: newsPage === 0 ? '#F8FAFC' : '#fff', color: newsPage === 0 ? '#CBD5E1' : '#0F172A', cursor: newsPage === 0 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, transition: 'all .2s' }}>
                ←
              </button>
              <span style={{ fontSize: 13, color: '#64748B' }}>{newsPage + 1} / {Math.ceil(cmsPosts.length / 3)}</span>
              <button onClick={() => setNewsPage(p => Math.min(Math.ceil(cmsPosts.length / 3) - 1, p + 1))} disabled={newsPage >= Math.ceil(cmsPosts.length / 3) - 1} style={{ width: 40, height: 40, borderRadius: '50%', border: '1.5px solid #E2E8F0', background: newsPage >= Math.ceil(cmsPosts.length / 3) - 1 ? '#F8FAFC' : '#fff', color: newsPage >= Math.ceil(cmsPosts.length / 3) - 1 ? '#CBD5E1' : '#0F172A', cursor: newsPage >= Math.ceil(cmsPosts.length / 3) - 1 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, transition: 'all .2s' }}>
                →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* FOOTER */}
      <footer className="ld-footer" id="about">
        <div className="ld-foot-grid">
          <div className="ld-foot-brand">
            <div className="fn">{brand?.clinic_name || 'KID'}</div>
            <div className="fs">{homepage?.clinicAbout || 'AI-Assisted Information Management System for Pediatric Speech and Occupational Therapy Clinics.'}<br /><br />Lyceum of the Philippines University – Cavite<br />College of Information Technology and Computer Science<br />BS Information Technology: Web and Mobile Technology</div>
          </div>
          <div className="ld-foot-col">
            <h4>System</h4>
            <a href="#promise" onClick={e => scrollToSection(e, 'promise')}>Our Approach</a>
            <AuthLink preview={preview} to="/login">Guardian/Caretaker Portal</AuthLink>
          </div>
          <div className="ld-foot-col">
            <h4>Clinic</h4>
            <a href="#news" onClick={e => scrollToSection(e, 'news')}>News</a>
            <a href="#announcements" onClick={e => scrollToSection(e, 'announcements')}>Announcements</a>
            <a href="#about" onClick={e => scrollToSection(e, 'about')}>About the Clinic</a>
          </div>
        </div>
        <div className="ld-foot-bottom">
          <div className="ld-foot-copy">© 2026 KID: AI-Assisted Clinic Management System · LPU-Cavite CITCS</div>
          <div className="ld-foot-copy">{brand?.clinic_name || 'Bloomsdale Therapy Center'}{brand?.address ? ' · ' + brand.address : ' · Imus, Cavite'}</div>
        </div>
      </footer>

      {/* NEWS POST MODAL */}
      {openPost && (
        <div className="ld-post-modal-overlay" onClick={() => setOpenPost(null)}>
          <div className="ld-post-modal" onClick={e => e.stopPropagation()}>
            <button className="ld-post-modal-close" onClick={() => setOpenPost(null)} aria-label="Close">×</button>
            {openPost.image_url && (
              <div className="ld-post-modal-thumb">
                <img src={openPost.image_url.startsWith('http') || openPost.image_url.startsWith('/') ? openPost.image_url : '/' + openPost.image_url} alt={openPost.title} />
              </div>
            )}
            <div className="ld-post-modal-body">
              {openPost.category && <span className="ld-news-cat">{openPost.category}</span>}
              <h3>{openPost.title}</h3>
              <div className="ld-news-meta" style={{ marginBottom: 14 }}>
                {openPost.published_at ? new Date(openPost.published_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''}
              </div>
              <p className="ld-post-modal-text">{openPost.body}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
