import { Router } from 'express';
import multer from 'multer';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = Router();
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    // Reject anything that isn't a plain raster image up front, in particular
    // no SVG (can embed <script>) and no arbitrary file types hosted from our bucket.
    cb(null, ALLOWED_IMAGE_TYPES.has(file.mimetype));
  }
});

// Ensure the storage bucket exists on startup
(async () => {
  const { data: buckets } = await db.storage.listBuckets();
  const exists = (buckets || []).some(b => b.name === 'uploads');
  if (!exists) {
    const { error } = await db.storage.createBucket('uploads', { public: true });
    if (error) console.error('Could not create storage bucket:', error.message);
    else console.log('Created "uploads" storage bucket');
  }
})();

/** PUBLIC: GET /api/cms/public, published posts + active announcements for the landing page */
router.get('/public', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: posts }, { data: anns }, { data: homepageArr }] = await Promise.all([
    db.from('cms_posts').select('*').eq('status', 'published').neq('category', '_homepage').order('published_at', { ascending: false }).limit(6),
    db.from('announcements').select('*').eq('status', 'published')
      .lte('starts_on', today).or(`ends_on.gte.${today},ends_on.is.null`)
      .order('created_at', { ascending: false }),
    db.from('cms_posts').select('body').eq('category', '_homepage').eq('status', 'published').limit(1)
  ]);
  let homepage = null;
  try { if (homepageArr?.[0]?.body) homepage = JSON.parse(homepageArr[0].body); } catch (e) {}
  res.json({ posts: posts || [], announcements: anns || [], announcement: anns?.[0] || null, homepage });
});

router.use(requireAuth, requireRole('admin'));

/** POST /api/cms/upload, upload image to Supabase Storage */
router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Only JPEG, PNG, GIF, or WEBP images are allowed (max 5MB).' });

  // Extension derived from the validated MIME type, not the client-supplied
  // filename, avoids storing a file whose extension/content type disagree.
  const EXT_FOR_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  const ext = EXT_FOR_TYPE[req.file.mimetype] || 'jpg';
  const filename = `cms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const path = `cms/${filename}`;

  const { error } = await db.storage.from('uploads').upload(path, req.file.buffer, {
    contentType: req.file.mimetype,
    upsert: false
  });

  if (error) {
    console.error('Storage upload error:', error.message);
    return res.status(500).json({ error: 'Failed to upload: ' + error.message });
  }

  const { data: urlData } = db.storage.from('uploads').getPublicUrl(path);
  res.json({ url: urlData.publicUrl, path });
});

/** GET /api/cms/uploaded-photos, list all photos in the uploads bucket */
router.get('/uploaded-photos', async (req, res) => {
  try {
    const { data, error } = await db.storage.from('uploads').list('cms', { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
    if (error) return res.status(500).json({ error: error.message });
    const urls = (data || [])
      .filter(f => f.name && /\.(jpg|jpeg|png|gif|webp|jfif)$/i.test(f.name))
      .map(f => {
        const { data: urlData } = db.storage.from('uploads').getPublicUrl('cms/' + f.name);
        return urlData.publicUrl;
      });
    res.json(urls);
  } catch (e) {
    res.json([]);
  }
});

/** GET /api/cms/posts */
router.get('/posts', async (req, res) => {
  const { data, error } = await db.from('cms_posts').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** POST /api/cms/posts */
router.post('/posts', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: 'title is required' });
    const status = b.status || 'published';
    const row = {
      title: b.title, body: b.body || '', category: b.category || 'General',
      image_url: b.image_url || null, photo_credit: b.photo_credit || null, status,
      published_at: status === 'published' ? new Date().toISOString() : null
    };
    console.log('CMS POST insert:', JSON.stringify(row));
    const { data, error } = await db.from('cms_posts').insert(row).select();
    if (error) {
      console.error('CMS POST error:', error.message, error.details, error.hint);
      return res.status(500).json({ error: error.message });
    }
    const created = data?.[0] || row;

    await logAudit({
      table_name: 'cms_posts', record_id: created.id, action: 'create',
      description: `Created CMS post "${created.title}" (${created.category}), ${status}`,
      created_by: req.user.id
    });

    res.status(201).json(created);
  } catch (e) {
    console.error('CMS POST crash:', e);
    res.status(500).json({ error: e.message || 'Unexpected error' });
  }
});

/** PUT /api/cms/posts/:id */
router.put('/posts/:id', async (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of ['title','body','category','image_url','photo_credit','status']) if (k in b) patch[k] = b[k];
  if (b.status === 'published') patch.published_at = new Date().toISOString();
  const { data, error } = await db.from('cms_posts').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'cms_posts', record_id: req.params.id, action: 'update',
    description: `Updated CMS post "${data.title}"` + (patch.status ? `, status set to ${patch.status}` : ''),
    updated_by: req.user.id
  });

  res.json(data);
});

router.delete('/posts/:id', async (req, res) => {
  const { data: existing } = await db.from('cms_posts').select('title').eq('id', req.params.id).maybeSingle();
  const { error } = await db.from('cms_posts').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'cms_posts', record_id: req.params.id, action: 'delete',
    description: `Deleted CMS post${existing?.title ? ' "' + existing.title + '"' : ''}`,
    updated_by: req.user.id
  });

  res.json({ ok: true });
});

/** Announcements CRUD */
router.get('/announcements', async (req, res) => {
  const { data, error } = await db.from('announcements').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/announcements', async (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.body) return res.status(400).json({ error: 'title and body are required' });
  const { data, error } = await db.from('announcements').insert({
    title: b.title, body: b.body,
    starts_on: b.starts_on || new Date().toISOString().slice(0, 10),
    ends_on: b.ends_on || null,
    status: b.status || 'published'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'announcements', record_id: data.id, action: 'create',
    description: `Created announcement "${data.title}", ${data.status}`,
    created_by: req.user.id
  });

  res.status(201).json(data);
});

router.put('/announcements/:id', async (req, res) => {
  const patch = {};
  for (const k of ['title','body','starts_on','ends_on','status']) if (k in req.body) patch[k] = req.body[k];
  const { data, error } = await db.from('announcements').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'announcements', record_id: req.params.id, action: 'update',
    description: `Updated announcement "${data.title}"` + (patch.status ? `, status set to ${patch.status}` : ''),
    updated_by: req.user.id
  });

  res.json(data);
});

router.delete('/announcements/:id', async (req, res) => {
  const { data: existing } = await db.from('announcements').select('title').eq('id', req.params.id).maybeSingle();
  const { error } = await db.from('announcements').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'announcements', record_id: req.params.id, action: 'delete',
    description: `Deleted announcement${existing?.title ? ' "' + existing.title + '"' : ''}`,
    updated_by: req.user.id
  });

  res.json({ ok: true });
});

export default router;
