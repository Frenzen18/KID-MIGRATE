import { useState, useRef, useEffect } from 'react';
import { api } from '../../../api.js';

/* == page: cms == */

const PILLS = { Programs: 'pill-teal', Events: 'pill-amber', Awards: 'pill-blue', Insights: 'pill-blue' };

const POST_TITLE_LIMIT = 80;
const POST_BODY_LIMIT = 500;
const ANN_TITLE_LIMIT = 80;
const ANN_BODY_LIMIT = 200;

function CharCount({ length, limit }) {
  const atLimit = length >= limit;
  return (
    <div style={{ fontSize: 11, textAlign: 'right', marginTop: 4, color: atLimit ? '#EF4444' : '#94A3B8', fontWeight: atLimit ? 700 : 400 }}>
      {atLimit ? 'Character limit reached, ' : ''}{length}/{limit}
    </div>
  );
}

export default function Cms({ go, toast, openModal }) {
  /* ── Tab switching ── */
  const [tab, setTab] = useState('articles');

  /* ── News post state ── */
  const [postTitle, setPostTitle] = useState('');
  const [postText, setPostText] = useState('');
  const [postCat, setPostCat] = useState('Programs');
  const [currentPhoto, setCurrentPhoto] = useState('KID INDEX HTML PICTURES 3.jfif');
  const [addedPosts, setAddedPosts] = useState([]);
  const [dbPosts, setDbPosts] = useState([]);
  const [dbAnnouncements, setDbAnnouncements] = useState([]);
  const [editingPost, setEditingPost] = useState(null); // null = creating new, object = editing existing
  const [confirmDelete, setConfirmDelete] = useState(null); // { type: 'post'|'announcement', id, title }
  const nextId = useRef(1);
  const titleRef = useRef(null);
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadedPhotos, setUploadedPhotos] = useState([]);

  /* ── Announcement state ── */
  const [annTitle, setAnnTitle] = useState('');
  const [annText, setAnnText] = useState('');
  const [annStart, setAnnStart] = useState(new Date().toISOString().slice(0, 10));
  const [annEnd, setAnnEnd] = useState('');

  /* ── Homepage hero state ── */
  const [heroHeadline, setHeroHeadline] = useState('Every child deserves the chance to thrive.');
  const [heroSub, setHeroSub] = useState('We provide pediatric speech and occupational therapy in a warm, child-centered environment.');
  const [heroCta, setHeroCta] = useState('Get Started');
  const [heroPhoto, setHeroPhoto] = useState('KID INDEX HTML PICTURES 1.webp');
  const [clinicAbout, setClinicAbout] = useState('Bloomsdale Therapy Center provides expert pediatric speech and occupational therapy in Imus, Cavite. We serve children aged 1–12 with personalized, evidence-based care.');
  const [clinicServices, setClinicServices] = useState("We offer Occupational Therapy and Speech Therapy tailored to each child's developmental needs and goals.");

  /* ── Fetch real data from DB ── */
  useEffect(() => {
    api('/cms/posts').then(posts => {
      setDbPosts(posts);
      // Collect uploaded photo URLs from existing posts
      const urls = (posts || []).map(p => p.image_url).filter(u => u && u.startsWith('http'));
      setUploadedPhotos(prev => [...new Set([...prev, ...urls])]);
      // Load homepage settings if saved
      const homepagePost = (posts || []).find(p => p.category === '_homepage');
      if (homepagePost) {
        try {
          const settings = JSON.parse(homepagePost.body);
          if (settings.headline) setHeroHeadline(settings.headline);
          if (settings.sub) setHeroSub(settings.sub);
          if (settings.cta) setHeroCta(settings.cta);
          if (settings.photo) setHeroPhoto(settings.photo);
          if (settings.clinicAbout) setClinicAbout(settings.clinicAbout);
          if (settings.clinicServices) setClinicServices(settings.clinicServices);
        } catch (e) {}
      }
    }).catch(() => {});
    api('/cms/announcements').then(setDbAnnouncements).catch(() => {});
    // Also load all files from the uploads bucket
    api('/cms/uploaded-photos').then(photos => {
      if (photos && photos.length) setUploadedPhotos(prev => [...new Set([...prev, ...photos])]);
    }).catch(() => {});
  }, []);

  /* ── News post: live preview ── */
  const pvTitle = postTitle.trim() || 'Give your post a title…';
  const pvText = postText.trim() || 'Your post text will show up here as you type. Try it!';
  const pvCat = postCat;

  /* ── Clinic Descriptions: live preview, mirrors the same fallback text used on the public site ── */
  const pvClinicAbout = clinicAbout.trim() || 'AI-Assisted Information Management System for Pediatric Speech and Occupational Therapy Clinics.';
  const pvClinicServices = clinicServices.trim() || 'At Bloomsdale, therapy is a partnership with your family. Our therapists turn sessions into play, challenges into progress, and milestones into moments worth sharing.';

  function pickPhoto(src) {
    setCurrentPhoto(src);
  }

  async function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Please select an image file', 'fa-circle-exclamation');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast('Image must be under 5MB', 'fa-circle-exclamation');
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const token = localStorage.getItem('kid_token');
      const res = await fetch('/api/cms/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setCurrentPhoto(data.url);
      setUploadedPhotos(prev => prev.includes(data.url) ? prev : [...prev, data.url]);
      toast('Photo uploaded!', 'fa-check');
    } catch (err) {
      toast('Upload failed: ' + err.message, 'fa-circle-exclamation');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function publishPost() {
    const title = postTitle.trim();
    if (!title) {
      toast('Give your post a title first (Step 1)', 'fa-circle-exclamation');
      if (titleRef.current) titleRef.current.focus();
      return;
    }
    const text = postText.trim();
    const cat = postCat;
    const imageUrl = currentPhoto
      ? (currentPhoto.startsWith('http') ? currentPhoto : '/' + currentPhoto)
      : null;

    try {
      if (editingPost) {
        // Update existing post
        const updated = await api('/cms/posts/' + editingPost.id, {
          method: 'PUT',
          body: { title, body: text, category: cat, image_url: imageUrl, status: 'published' }
        });
        setDbPosts(prev => prev.map(p => p.id === editingPost.id ? updated : p));
        toast('Post updated and published!', 'fa-globe');
      } else {
        // Create new post
        const post = await api('/cms/posts', {
          method: 'POST',
          body: { title, body: text, category: cat, image_url: imageUrl, status: 'published' }
        });
        setDbPosts(prev => [post, ...prev]);
        toast('Your post is now live on the website!', 'fa-globe');
      }
      resetForm();
    } catch (e) {
      toast('Failed to publish: ' + (e.message || 'Unknown error'), 'fa-circle-exclamation');
    }
  }

  async function saveDraft() {
    const title = postTitle.trim();
    if (!title) {
      toast('Give your post a title first', 'fa-circle-exclamation');
      return;
    }
    const imageUrl = currentPhoto
      ? (currentPhoto.startsWith('http') ? currentPhoto : '/' + currentPhoto)
      : null;

    try {
      if (editingPost) {
        const updated = await api('/cms/posts/' + editingPost.id, {
          method: 'PUT',
          body: { title, body: postText.trim(), category: postCat, image_url: imageUrl, status: 'draft' }
        });
        setDbPosts(prev => prev.map(p => p.id === editingPost.id ? updated : p));
        toast('Draft updated', 'fa-floppy-disk');
      } else {
        const post = await api('/cms/posts', {
          method: 'POST',
          body: { title, body: postText.trim(), category: postCat, image_url: imageUrl, status: 'draft' }
        });
        setDbPosts(prev => [post, ...prev]);
        toast('Saved as draft', 'fa-floppy-disk');
      }
      resetForm();
    } catch (e) {
      toast('Failed to save draft: ' + (e.message || 'Unknown error'), 'fa-circle-exclamation');
    }
  }

  function resetForm() {
    setPostTitle('');
    setPostText('');
    setPostCat('Programs');
    setCurrentPhoto('KID INDEX HTML PICTURES 3.jfif');
    setEditingPost(null);
  }

  function editPost(post) {
    setPostTitle(post.title || '');
    setPostText(post.body || '');
    setPostCat(post.category || 'Programs');
    setCurrentPhoto(post.image_url ? (post.image_url.startsWith('/') ? post.image_url.slice(1) : post.image_url) : null);
    setEditingPost(post);
    setTab('articles');
    window.scrollTo(0, 0);
    toast('Editing "' + post.title + '"', 'fa-pen');
  }

  async function confirmDeleteAction() {
    if (!confirmDelete) return;
    const { type, id } = confirmDelete;
    try {
      if (type === 'post') {
        await api('/cms/posts/' + id, { method: 'DELETE' });
        setDbPosts(prev => prev.filter(x => x.id !== id));
        toast('Post deleted', 'fa-trash');
      } else {
        await api('/cms/announcements/' + id, { method: 'DELETE' });
        setDbAnnouncements(prev => prev.filter(a => a.id !== id));
        toast('Announcement deleted', 'fa-trash');
      }
    } catch (e) {
      toast('Failed: ' + e.message, 'fa-circle-exclamation');
    }
    setConfirmDelete(null);
  }

  async function publishHomepage() {
    const settings = {
      headline: heroHeadline.trim(),
      sub: heroSub.trim(),
      cta: heroCta.trim(),
      photo: heroPhoto,
      clinicAbout: clinicAbout.trim(),
      clinicServices: clinicServices.trim()
    };
    const existingHomepage = dbPosts.find(p => p.category === '_homepage');
    try {
      if (existingHomepage) {
        await api('/cms/posts/' + existingHomepage.id, {
          method: 'PUT',
          body: { title: 'Homepage Settings', body: JSON.stringify(settings), category: '_homepage', status: 'published' }
        });
      } else {
        const post = await api('/cms/posts', {
          method: 'POST',
          body: { title: 'Homepage Settings', body: JSON.stringify(settings), category: '_homepage', status: 'published' }
        });
        setDbPosts(prev => [...prev, post]);
      }
      toast('Homepage updated and live!', 'fa-globe');
    } catch (e) {
      toast('Failed to update homepage: ' + (e.message || 'Unknown error'), 'fa-circle-exclamation');
    }
  }

  async function publishAnnouncement() {
    if (!annTitle.trim() && !annText.trim()) {
      toast('Write a title or message first', 'fa-circle-exclamation');
      return;
    }
    try {
      const ann = await api('/cms/announcements', {
        method: 'POST',
        body: {
          title: annTitle.trim() || 'Announcement',
          body: annText.trim(),
          starts_on: annStart || new Date().toISOString().slice(0, 10),
          ends_on: annEnd || null,
          status: 'published'
        }
      });
      setDbAnnouncements(prev => [ann, ...prev]);
      toast('Announcement is now live on the website!', 'fa-bullhorn');
      setAnnTitle('');
      setAnnText('');
      setAnnEnd('');
    } catch (e) {
      toast('Failed to publish: ' + (e.message || 'Unknown error'), 'fa-circle-exclamation');
    }
  }

  async function saveDraftAnnouncement() {
    if (!annTitle.trim() && !annText.trim()) {
      toast('Write something first', 'fa-circle-exclamation');
      return;
    }
    try {
      const ann = await api('/cms/announcements', {
        method: 'POST',
        body: {
          title: annTitle.trim() || 'Announcement',
          body: annText.trim(),
          starts_on: annStart || new Date().toISOString().slice(0, 10),
          ends_on: annEnd || null,
          status: 'draft'
        }
      });
      setDbAnnouncements(prev => [ann, ...prev]);
      toast('Saved as draft', 'fa-floppy-disk');
      setAnnTitle('');
      setAnnText('');
      setAnnEnd('');
    } catch (e) {
      toast('Failed to save: ' + (e.message || 'Unknown error'), 'fa-circle-exclamation');
    }
  }

  /* ── Announcement: live preview ── */
  const pvAnn = annText.trim() || 'Your announcement message will appear here as you type…';

  /* ── Homepage hero: live preview ── */
  const h = heroHeadline.trim() || 'Every child deserves the chance to thrive.';
  const heroWords = h.split(' ');
  let pvHeadline;
  if (heroWords.length > 2) {
    const tail = heroWords.slice(-2).join(' ');
    const head = heroWords.slice(0, -2).join(' ');
    pvHeadline = <>{head} <em>{tail}</em></>;
  } else {
    pvHeadline = h;
  }
  const pvHeroSub = heroSub.trim() || ' ';
  const pvCta = heroCta.trim() || 'Get Started';

  function pickHeroPhoto(src) {
    setHeroPhoto(src);
  }

  return (
    <div className="spa-page" id="spa-cms">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Website Content</h1>
          <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Post news, announcements, and update the public homepage, with a live preview of how it will look.</p>
        </div>
        <a href="index.html" target="_blank" className="qa-btn" style={{ width: 'auto', padding: '10px 16px', fontSize: 13, textDecoration: 'none' }}>
          <i className="fa-solid fa-arrow-up-right-from-square" style={{ color: '#0D9488' }} /> Open Public Website
        </a>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className={'cms-tab-btn' + (tab === 'articles' ? ' active' : '')} onClick={() => setTab('articles')}><i className="fa-solid fa-newspaper" style={{ marginRight: 6 }} />News Post</button>
        <button className={'cms-tab-btn' + (tab === 'announcements' ? ' active' : '')} onClick={() => setTab('announcements')}><i className="fa-solid fa-bullhorn" style={{ marginRight: 6 }} />Announcement</button>
        <button className={'cms-tab-btn' + (tab === 'homepage' ? ' active' : '')} onClick={() => setTab('homepage')}><i className="fa-solid fa-panorama" style={{ marginRight: 6 }} />Homepage</button>
      </div>

      {/* ══════════ TAB: NEWS POST ══════════ */}
      <div id="tab-articles" style={{ display: tab === 'articles' ? '' : 'none' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 16, marginBottom: 24, alignItems: 'start' }}>

          {/* Composer */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ marginBottom: 20 }}>
              <div className="section-title" style={{ fontSize: 16 }}>{editingPost ? 'Edit Post' : 'Create a News Post'}</div>
              <div className="section-sub">{editingPost ? 'Update your post, the live preview shows how it will look.' : 'Fill in the three steps, the preview on the right shows exactly how it will appear on the website.'}</div>
            </div>

            {/* Step 1 */}
            <div style={{ marginBottom: 22 }}>
              <div className="step-row"><span className="step-num">1</span><div><div className="step-title">Write your post</div><div className="step-hint">A short title and one or two sentences is all you need.</div></div></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 36 }}>
                <div>
                  <input ref={titleRef} className="big-input" id="post-title" placeholder="Give your post a title…" maxLength={POST_TITLE_LIMIT} value={postTitle} onChange={e => setPostTitle(e.target.value)} />
                  <CharCount length={postTitle.length} limit={POST_TITLE_LIMIT} />
                </div>
                <div>
                  <textarea className="big-input" id="post-text" rows="3" maxLength={POST_BODY_LIMIT} placeholder="What would you like to tell parents and visitors?" value={postText} onChange={e => setPostText(e.target.value)} />
                  <CharCount length={postText.length} limit={POST_BODY_LIMIT} />
                </div>
                <select className="big-input" id="post-cat" style={{ cursor: 'pointer' }} value={postCat} onChange={e => setPostCat(e.target.value)}>
                  <option value="Programs">Category: Programs</option>
                  <option value="Events">Category: Events</option>
                  <option value="Awards">Category: Awards</option>
                  <option value="Insights">Category: Insights</option>
                </select>
              </div>
            </div>

            {/* Step 2 */}
            <div style={{ marginBottom: 22 }}>
              <div className="step-row"><span className="step-num">2</span><div><div className="step-title">Pick a photo</div><div className="step-hint">Tap one, or choose "no photo" for a simple card.</div></div></div>
              <div className="photo-pick" style={{ paddingLeft: 36 }}>
                <img className={'photo-opt' + (currentPhoto === 'KID INDEX HTML PICTURES 3.jfif' ? ' selected' : '')} src="KID INDEX HTML PICTURES 3.jfif" alt="Mother and son" onClick={() => pickPhoto('KID INDEX HTML PICTURES 3.jfif')} />
                <img className={'photo-opt' + (currentPhoto === 'KID INDEX HTML PICTURES 1.webp' ? ' selected' : '')} src="KID INDEX HTML PICTURES 1.webp" alt="Mother and daughter laughing" onClick={() => pickPhoto('KID INDEX HTML PICTURES 1.webp')} />
                <img className={'photo-opt' + (currentPhoto === 'KID INDEX HTML PICTURES 2.jpg' ? ' selected' : '')} src="KID INDEX HTML PICTURES 2.jpg" alt="Parent holding child's hand" onClick={() => pickPhoto('KID INDEX HTML PICTURES 2.jpg')} />
                {uploadedPhotos.map(url => (
                  <img key={url} className={'photo-opt' + (currentPhoto === url ? ' selected' : '')} src={url} alt="Uploaded" style={{ objectFit: 'cover' }} onClick={() => pickPhoto(url)} />
                ))}
                <div className={'photo-none' + (currentPhoto === null ? ' selected' : '')} onClick={() => pickPhoto(null)} title="No photo"><i className="fa-solid fa-image-slash" /></div>
                <div className="photo-none" onClick={() => fileInputRef.current?.click()} title="Upload new photo" style={{ opacity: uploading ? 0.5 : 1 }}><i className={'fa-solid ' + (uploading ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-up')} /></div>
                <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} style={{ display: 'none' }} />
              </div>
            </div>

            {/* Step 3 */}
            <div>
              <div className="step-row"><span className="step-num">3</span><div><div className="step-title">Publish it</div><div className="step-hint">Happy with the preview? One click and it's on the website.</div></div></div>
              <div style={{ display: 'flex', gap: 10, paddingLeft: 36, flexWrap: 'wrap' }}>
                <button className="btn-primary" style={{ padding: '12px 24px', fontSize: 14 }} onClick={publishPost}><i className="fa-solid fa-paper-plane" style={{ marginRight: 6 }} />{editingPost ? 'Update & Publish' : 'Publish to Website'}</button>
                <button className="btn-secondary" style={{ padding: '12px 18px' }} onClick={saveDraft}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />{editingPost ? 'Save Changes' : 'Save for Later'}</button>
                {editingPost && (
                  <button className="btn-secondary" style={{ padding: '12px 18px', color: '#EF4444' }} onClick={resetForm}><i className="fa-solid fa-xmark" style={{ marginRight: 5 }} />Cancel Edit</button>
                )}
              </div>
            </div>
          </div>

          {/* Live preview */}
          <div className="card" style={{ padding: '22px 20px', position: 'sticky', top: 80 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div><div className="section-title" style={{ fontSize: 15 }}>Live Preview</div><div className="section-sub">How it will look on the homepage news section</div></div>
              <span className="live-tag"><span className="dot" />LIVE</span>
            </div>
            <div className="browser-frame">
              <div className="browser-bar">
                <span className="b-dot" style={{ background: '#FCA5A5' }} /><span className="b-dot" style={{ background: '#FDE68A' }} /><span className="b-dot" style={{ background: '#86EFAC' }} />
                <span className="browser-url">bloomsdale-kid.ph, News & Announcements</span>
              </div>
              <div style={{ padding: '22px 16px', background: '#FDFCFA' }}>
                <div className="ix-card">
                  <div className="ix-thumb" id="pv-thumb">
                    {currentPhoto
                      ? <img id="pv-img" src={currentPhoto} alt="Post photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span className="ph"><i className="fa-regular fa-newspaper" /></span>}
                  </div>
                  <div className="ix-body">
                    <span className="ix-cat" id="pv-cat">{pvCat}</span>
                    <div className="ix-title" id="pv-title">{pvTitle}</div>
                    <p className="ix-p" id="pv-text">{pvText}</p>
                    <div className="ix-meta" id="pv-date">July 8, 2026</div>
                  </div>
                </div>
              </div>
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: '#94A3B8', textAlign: 'center' }}><i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />This matches the real news card design on the public website.</div>
          </div>
        </div>

        {/* Posts list */}
        <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }}>
          <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div><div className="section-title">Your Posts</div><div className="section-sub">Everything published or drafted so far</div></div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th style={{ paddingLeft: 24 }}>Title</th><th>Category</th><th>Published</th><th>Status</th><th style={{ textAlign: 'right', paddingRight: 24 }}>Actions</th></tr></thead>
              <tbody>
                {dbPosts.filter(p => p.category !== '_homepage').length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', padding: 20, color: '#94A3B8', fontSize: 13 }}>No posts yet. Create one above!</td></tr>
                )}
                {dbPosts.filter(p => p.category !== '_homepage').map(p => (
                  <tr key={p.id}>
                    <td style={{ paddingLeft: 24 }}><div style={{ fontWeight: 600, color: '#0F172A' }}>{p.title}</div><div style={{ fontSize: 11, color: '#94A3B8' }}>{p.body ? p.body.slice(0, 50) : ''}</div></td>
                    <td><span className={'pill ' + (PILLS[p.category] || 'pill-blue')}>{p.category}</span></td>
                    <td style={{ fontSize: 12.5 }}>{p.published_at ? new Date(p.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-'}</td>
                    <td><span className={p.status === 'published' ? 'pill pill-green' : p.status === 'draft' ? 'pill pill-amber' : 'pill pill-gray'}>{p.status === 'published' ? 'Published' : p.status === 'draft' ? 'Draft' : 'Archived'}</span></td>
                    <td style={{ textAlign: 'right', paddingRight: 24 }}>
                      <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end', alignItems: 'center' }}>
                        <button className="btn-edit" onClick={() => editPost(p)}><i className="fa-solid fa-pen" style={{ marginRight: 3 }} />Edit</button>
                        {p.status === 'draft' && (
                          <button className="btn-primary" style={{ padding: '5px 10px', fontSize: 11.5 }} onClick={async () => {
                            try {
                              const updated = await api('/cms/posts/' + p.id, { method: 'PUT', body: { status: 'published' } });
                              setDbPosts(prev => prev.map(x => x.id === p.id ? updated : x));
                              toast('Post published to the website!', 'fa-globe');
                            } catch (e) { toast('Failed: ' + e.message, 'fa-circle-exclamation'); }
                          }}>Publish</button>
                        )}
                        <button className="btn-danger" onClick={() => setConfirmDelete({ type: 'post', id: p.id, title: p.title })}><i className="fa-solid fa-trash" style={{ marginRight: 3 }} />Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '14px 24px', borderTop: '1px solid #F1F5F9' }}>
            <span style={{ fontSize: 12, color: '#64748B' }}>Showing {dbPosts.filter(p => p.category !== '_homepage').length} post{dbPosts.filter(p => p.category !== '_homepage').length !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>

      {/* ══════════ TAB: ANNOUNCEMENT ══════════ */}
      <div id="tab-announcements" style={{ display: tab === 'announcements' ? '' : 'none' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 16, marginBottom: 24, alignItems: 'start' }}>

          {/* Composer */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ marginBottom: 20 }}>
              <div className="section-title" style={{ fontSize: 16 }}>Post an Announcement</div>
              <div className="section-sub">Announcements appear in the yellow bar at the very top of the website, perfect for schedules and reminders.</div>
            </div>

            <div style={{ marginBottom: 22 }}>
              <div className="step-row"><span className="step-num">1</span><div><div className="step-title">Write your announcement</div><div className="step-hint">Keep it short, one sentence works best.</div></div></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 36 }}>
                <div>
                  <input className="big-input" placeholder="Short title (for your records)…" maxLength={ANN_TITLE_LIMIT} value={annTitle} onChange={e => setAnnTitle(e.target.value)} />
                  <CharCount length={annTitle.length} limit={ANN_TITLE_LIMIT} />
                </div>
                <div>
                  <textarea className="big-input" rows="3" maxLength={ANN_BODY_LIMIT} placeholder="Type the message visitors will see at the top of the website…" value={annText} onChange={e => setAnnText(e.target.value)} />
                  <CharCount length={annText.length} limit={ANN_BODY_LIMIT} />
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 22 }}>
              <div className="step-row"><span className="step-num">2</span><div><div className="step-title">When should it show?</div><div className="step-hint">It disappears automatically after the end date.</div></div></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, paddingLeft: 36 }}>
                <div><label className="form-label">Start showing</label><input className="big-input" type="date" value={annStart} onChange={e => setAnnStart(e.target.value)} /></div>
                <div><label className="form-label">Stop showing (optional)</label><input className="big-input" type="date" value={annEnd} onChange={e => setAnnEnd(e.target.value)} /></div>
              </div>
            </div>

            <div>
              <div className="step-row"><span className="step-num">3</span><div><div className="step-title">Publish it</div><div className="step-hint">It goes live at the top of every page instantly.</div></div></div>
              <div style={{ display: 'flex', gap: 10, paddingLeft: 36, flexWrap: 'wrap' }}>
                <button className="btn-primary" style={{ padding: '12px 24px', fontSize: 14 }} onClick={publishAnnouncement}><i className="fa-solid fa-bullhorn" style={{ marginRight: 6 }} />Publish Announcement</button>
                <button className="btn-secondary" style={{ padding: '12px 18px' }} onClick={saveDraftAnnouncement}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />Save for Later</button>
              </div>
            </div>
          </div>

          {/* Live preview */}
          <div className="card" style={{ padding: '22px 20px', position: 'sticky', top: 80 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div><div className="section-title" style={{ fontSize: 15 }}>Live Preview</div><div className="section-sub">The yellow bar at the top of the website</div></div>
              <span className="live-tag"><span className="dot" />LIVE</span>
            </div>
            <div className="browser-frame">
              <div className="browser-bar">
                <span className="b-dot" style={{ background: '#FCA5A5' }} /><span className="b-dot" style={{ background: '#FDE68A' }} /><span className="b-dot" style={{ background: '#86EFAC' }} />
                <span className="browser-url">bloomsdale-kid.ph, Home</span>
              </div>
              <div className="ix-band">
                <span className="ix-band-label">Announcement</span>
                <span className="ix-band-text" id="pv-ann">{pvAnn}</span>
                <span className="ix-band-more">Learn more</span>
              </div>
              <div style={{ padding: '18px 16px 22px', background: '#FDFCFA', fontFamily: "'Karla',sans-serif" }}>
                <div style={{ height: 8, width: '45%', background: '#E8E4DB', borderRadius: 4, marginBottom: 8 }} />
                <div style={{ height: 8, width: '70%', background: '#EFEBE2', borderRadius: 4, marginBottom: 8 }} />
                <div style={{ height: 8, width: '55%', background: '#EFEBE2', borderRadius: 4 }} />
              </div>
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: '#94A3B8', textAlign: 'center' }}><i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Shown above the homepage exactly like this.</div>
          </div>
        </div>

        {/* Existing announcements */}
        <div className="card" style={{ padding: '22px 20px', marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div><div className="section-title"><i className="fa-solid fa-bullhorn" style={{ color: '#818CF8', marginRight: 6 }} />Current Announcements</div><div className="section-sub">Edit or remove what's showing now</div></div>
          </div>
          {dbAnnouncements.length === 0 && (
            <div style={{ textAlign: 'center', padding: '20px 0', color: '#94A3B8', fontSize: 13 }}>No announcements yet. Create one above!</div>
          )}
          {dbAnnouncements.map(ann => (
            <div key={ann.id} className="ann-item" style={{ border: ann.status === 'draft' ? '1px solid #FEF9C3' : '1px solid #E2E8F0', background: ann.status === 'draft' ? '#FFFBEB' : '#F8FAFC', padding: 14, borderRadius: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{ann.title}</span>
                <span className={ann.status === 'published' ? 'pill pill-green' : 'pill pill-amber'} style={{ fontSize: 10, flexShrink: 0 }}>{ann.status === 'published' ? 'Live' : 'Draft'}</span>
              </div>
              <p style={{ fontSize: 12.5, color: '#64748B', margin: '0 0 10px', lineHeight: 1.5 }}>{ann.body}</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ fontSize: 11, color: '#94A3B8' }}>
                  {ann.status === 'published' ? 'Posted ' + new Date(ann.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Draft'}
                  {ann.ends_on ? ' · Expires ' + new Date(ann.ends_on + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ann.status === 'published' ? ' · No expiry' : ''}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {ann.status === 'draft' && (
                    <button className="btn-primary" style={{ padding: '5px 10px', fontSize: 11.5 }} onClick={async () => {
                      try {
                        const updated = await api('/cms/announcements/' + ann.id, { method: 'PUT', body: { status: 'published' } });
                        setDbAnnouncements(prev => prev.map(a => a.id === ann.id ? updated : a));
                        toast('Announcement is now live!', 'fa-globe');
                      } catch (e) { toast('Failed: ' + e.message, 'fa-circle-exclamation'); }
                    }}>Publish</button>
                  )}
                  <button className="btn-danger" onClick={() => setConfirmDelete({ type: 'announcement', id: ann.id, title: ann.title })}><i className="fa-solid fa-trash" style={{ marginRight: 3 }} />Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ══════════ TAB: HOMEPAGE ══════════ */}
      <div id="tab-homepage" style={{ display: tab === 'homepage' ? '' : 'none' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 16, marginBottom: 24, alignItems: 'start' }}>

          {/* Hero editor */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ marginBottom: 20 }}>
              <div className="section-title" style={{ fontSize: 16 }}>Homepage Welcome Section</div>
              <div className="section-sub">Change the big headline visitors see first, the preview updates as you type.</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label className="form-label">Headline</label>
                <input className="big-input" id="hero-headline" value={heroHeadline} onChange={e => setHeroHeadline(e.target.value)} />
              </div>
              <div>
                <label className="form-label">Short description</label>
                <textarea className="big-input" id="hero-sub" rows="2" value={heroSub} onChange={e => setHeroSub(e.target.value)} />
              </div>
              <div>
                <label className="form-label">Button text</label>
                <input className="big-input" id="hero-cta" value={heroCta} onChange={e => setHeroCta(e.target.value)} />
              </div>
              <div>
                <label className="form-label">Welcome photo</label>
                <div className="photo-pick">
                  <img className={'photo-opt' + (heroPhoto === 'KID INDEX HTML PICTURES 1.webp' ? ' selected' : '')} src="KID INDEX HTML PICTURES 1.webp" alt="Mother and daughter" onClick={() => pickHeroPhoto('KID INDEX HTML PICTURES 1.webp')} />
                  <img className={'photo-opt' + (heroPhoto === 'KID INDEX HTML PICTURES 2.jpg' ? ' selected' : '')} src="KID INDEX HTML PICTURES 2.jpg" alt="Holding hands" onClick={() => pickHeroPhoto('KID INDEX HTML PICTURES 2.jpg')} />
                  <img className={'photo-opt' + (heroPhoto === 'KID INDEX HTML PICTURES 3.jfif' ? ' selected' : '')} src="KID INDEX HTML PICTURES 3.jfif" alt="Mother and son" onClick={() => pickHeroPhoto('KID INDEX HTML PICTURES 3.jfif')} />
                  {uploadedPhotos.map(url => (
                    <img key={url} className={'photo-opt' + (heroPhoto === url ? ' selected' : '')} src={url} alt="Uploaded" style={{ objectFit: 'cover' }} onClick={() => pickHeroPhoto(url)} />
                  ))}
                  <div className="photo-none" onClick={() => fileInputRef.current?.click()} title="Upload new photo"><i className="fa-solid fa-cloud-arrow-up" /></div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                <button className="btn-primary" style={{ padding: '12px 24px', fontSize: 14 }} onClick={publishHomepage}><i className="fa-solid fa-globe" style={{ marginRight: 6 }} />Publish Changes</button>
              </div>
            </div>
          </div>

          {/* Live preview + extras */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="card" style={{ padding: '22px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div><div className="section-title" style={{ fontSize: 15 }}>Live Preview</div><div className="section-sub">The top of the public homepage</div></div>
                <span className="live-tag"><span className="dot" />LIVE</span>
              </div>
              <div className="browser-frame">
                <div className="browser-bar">
                  <span className="b-dot" style={{ background: '#FCA5A5' }} /><span className="b-dot" style={{ background: '#FDE68A' }} /><span className="b-dot" style={{ background: '#86EFAC' }} />
                  <span className="browser-url">bloomsdale-kid.ph, Home</span>
                </div>
                <div className="ix-hero">
                  <div>
                    <div className="ix-kicker">Bloomsdale Therapy Center · Imus, Cavite</div>
                    <div className="ix-h1" id="pv-headline">{pvHeadline}</div>
                    <div className="ix-sub" id="pv-herosub">{pvHeroSub}</div>
                    <span className="ix-btn" id="pv-cta">{pvCta}</span>
                  </div>
                  <img id="pv-heroimg" src={heroPhoto} alt="Hero photo" />
                </div>
              </div>
            </div>

            {/* Informational descriptions */}
            <div className="card" style={{ padding: '22px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div className="section-title"><i className="fa-solid fa-align-left" style={{ color: '#0D9488', marginRight: 7 }} />Clinic Descriptions</div>
                <span className="live-tag"><span className="dot" />LIVE</span>
              </div>
              <div className="section-sub" style={{ marginBottom: 14 }}>Short text used across the website</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label className="form-label">About the Clinic</label>
                  <textarea className="big-input" rows="3" value={clinicAbout} onChange={e => setClinicAbout(e.target.value)} />
                </div>
                <div>
                  <label className="form-label">Services Description</label>
                  <textarea className="big-input" rows="2" value={clinicServices} onChange={e => setClinicServices(e.target.value)} />
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn-primary" onClick={publishHomepage}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 4 }} />Save & Publish</button>
                </div>
              </div>

              {/* Separate preview, these two fields render in different parts of the
                  public site (footer + "Our Approach" section), not in the hero above. */}
              <div style={{ marginTop: 18 }}>
                <div className="browser-frame">
                  <div className="browser-bar">
                    <span className="b-dot" style={{ background: '#FCA5A5' }} /><span className="b-dot" style={{ background: '#FDE68A' }} /><span className="b-dot" style={{ background: '#86EFAC' }} />
                    <span className="browser-url">bloomsdale-kid.ph, Home</span>
                  </div>
                  <div style={{ padding: '18px 20px', background: '#fff' }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: '#0D9488', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 6 }}>Our Approach section</div>
                    <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>{pvClinicServices}</div>
                  </div>
                  <div style={{ height: 1, background: '#F1F5F9' }} />
                  <div style={{ padding: '18px 20px', background: '#0F172A' }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: '#5EEAD4', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 6 }}>Footer brand blurb</div>
                    <div style={{ fontSize: 12.5, color: '#CBD5E1', lineHeight: 1.6 }}>{pvClinicAbout}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Content Management</span></div>

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '32px 28px', width: '100%', maxWidth: 400, boxShadow: '0 24px 64px rgba(15,23,42,.3)', textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#FEE2E2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <i className="fa-solid fa-trash" style={{ fontSize: 22, color: '#EF4444' }} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>Delete {confirmDelete.type === 'post' ? 'Post' : 'Announcement'}?</div>
            <p style={{ fontSize: 13.5, color: '#64748B', lineHeight: 1.6, marginBottom: 24 }}>
              Are you sure you want to delete <strong>"{confirmDelete.title}"</strong>? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={() => setConfirmDelete(null)} style={{ padding: '10px 24px', background: '#F1F5F9', color: '#475569', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmDeleteAction} style={{ padding: '10px 24px', background: '#EF4444', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Yes, Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
