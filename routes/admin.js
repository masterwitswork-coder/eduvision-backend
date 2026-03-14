const router = require('express').Router();
const bcrypt = require('bcryptjs');
const supabase = require('../lib/supabase');
const { authMiddleware } = require('../middleware/auth');

const adminOnly = authMiddleware(['admin']);

// ══════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════
router.get('/dashboard', adminOnly, async (req, res) => {
  try {
    const [schools, courses, subs, pendingSubs] = await Promise.all([
      supabase.from('schools').select('id', { count: 'exact', head: true }),
      supabase.from('courses').select('id', { count: 'exact', head: true }),
      supabase.from('subscriptions').select('price').eq('status', 'active'),
      supabase.from('subscriptions').select(`id, price, created_at, schools(name, city), courses(name, class_name)`).eq('status', 'pending').order('created_at', { ascending: false }).limit(10)
    ]);
    const revenue = (subs.data || []).reduce((a, s) => a + parseFloat(s.price), 0);
    const recentSubs = await supabase.from('subscriptions')
      .select(`id, price, status, payment_date, created_at, schools(name), courses(name, class_name)`)
      .order('created_at', { ascending: false }).limit(10);

    res.json({
      stats: {
        totalSchools: schools.count || 0,
        totalCourses: courses.count || 0,
        totalRevenue: revenue,
        pendingPayments: (pendingSubs.data || []).length
      },
      recentSubscriptions: recentSubs.data || []
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════
// SCHOOLS
// ══════════════════════════════════════
router.get('/schools', adminOnly, async (req, res) => {
  try {
    const { data: schools, error } = await supabase
      .from('schools').select('id, name, contact_person, email, phone, city, state, is_active, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Get subscription counts
    const schoolIds = schools.map(s => s.id);
    const { data: subCounts } = await supabase
      .from('subscriptions').select('school_id, status').in('school_id', schoolIds);

    const enriched = schools.map(s => {
      const mySubs = (subCounts || []).filter(x => x.school_id === s.id);
      return { ...s, activeSubscriptions: mySubs.filter(x => x.status === 'active').length, totalSubscriptions: mySubs.length };
    });

    res.json({ schools: enriched });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/schools', adminOnly, async (req, res) => {
  try {
    const { name, contactPerson, email, password, phone, city, state } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });

    const existing = await supabase.from('schools').select('id').eq('email', email.toLowerCase()).single();
    if (existing.data) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase.from('schools').insert({
      name, contact_person: contactPerson, email: email.toLowerCase(),
      password_hash: hash, phone, city, state
    }).select('id, name, email, phone, city, created_at').single();

    if (error) throw error;
    await supabase.from('audit_logs').insert({ action: 'create_school', entity_type: 'school', entity_id: data.id, performed_by: req.user.email, details: { name } });
    res.status(201).json({ school: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.put('/schools/:id', adminOnly, async (req, res) => {
  try {
    const { name, contactPerson, phone, city, state, isActive, password } = req.body;
    const updates = { name, contact_person: contactPerson, phone, city, state, is_active: isActive };
    if (password) updates.password_hash = await bcrypt.hash(password, 10);
    Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);

    const { data, error } = await supabase.from('schools').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ school: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/schools/:id', adminOnly, async (req, res) => {
  try {
    await supabase.from('subscriptions').delete().eq('school_id', req.params.id);
    const { error } = await supabase.from('schools').delete().eq('id', req.params.id);
    if (error) throw error;
    await supabase.from('audit_logs').insert({ action: 'delete_school', entity_type: 'school', entity_id: req.params.id, performed_by: req.user.email });
    res.json({ message: 'School deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════
// COURSES
// ══════════════════════════════════════
router.get('/courses', adminOnly, async (req, res) => {
  try {
    const { data: courses, error } = await supabase
      .from('courses').select('*, videos(id, title, youtube_id, duration, sort_order)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ courses });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/courses', adminOnly, async (req, res) => {
  try {
    const { name, className, subject, language, price, description, emoji, videos } = req.body;
    if (!name || !className || !subject || !language || !price) return res.status(400).json({ error: 'Required fields missing' });

    const { data: course, error } = await supabase.from('courses').insert({
      name, class_name: className, subject, language, price: parseFloat(price), description, emoji: emoji || '📹'
    }).select().single();
    if (error) throw error;

    if (videos && videos.length > 0) {
      const videoRows = videos.map((v, i) => ({
        course_id: course.id, title: v.title, youtube_id: v.youtubeId, duration: v.duration || '20 min', sort_order: i
      }));
      await supabase.from('videos').insert(videoRows);
    }

    const { data: full } = await supabase.from('courses').select('*, videos(*)').eq('id', course.id).single();
    await supabase.from('audit_logs').insert({ action: 'create_course', entity_type: 'course', entity_id: course.id, performed_by: req.user.email, details: { name } });
    res.status(201).json({ course: full });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.put('/courses/:id', adminOnly, async (req, res) => {
  try {
    const { name, className, subject, language, price, description, emoji, isActive } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (className) updates.class_name = className;
    if (subject) updates.subject = subject;
    if (language) updates.language = language;
    if (price) updates.price = parseFloat(price);
    if (description !== undefined) updates.description = description;
    if (emoji) updates.emoji = emoji;
    if (isActive !== undefined) updates.is_active = isActive;

    const { data, error } = await supabase.from('courses').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ course: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/courses/:id', adminOnly, async (req, res) => {
  try {
    await supabase.from('videos').delete().eq('course_id', req.params.id);
    await supabase.from('subscriptions').delete().eq('course_id', req.params.id);
    const { error } = await supabase.from('courses').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Course deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Add video to course
router.post('/courses/:id/videos', adminOnly, async (req, res) => {
  try {
    const { title, youtubeId, duration } = req.body;
    if (!title || !youtubeId) return res.status(400).json({ error: 'Title and YouTube ID required' });
    const { count } = await supabase.from('videos').select('id', { count: 'exact', head: true }).eq('course_id', req.params.id);
    const { data, error } = await supabase.from('videos').insert({
      course_id: req.params.id, title, youtube_id: youtubeId, duration: duration || '20 min', sort_order: count || 0
    }).select().single();
    if (error) throw error;
    res.status(201).json({ video: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/videos/:id', adminOnly, async (req, res) => {
  try {
    const { error } = await supabase.from('videos').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Video deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════
// SUBSCRIPTIONS & PAYMENTS
// ══════════════════════════════════════
router.get('/subscriptions', adminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    let q = supabase.from('subscriptions')
      .select(`*, schools(id, name, email, city), courses(id, name, class_name, subject, language)`)
      .order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ subscriptions: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/subscriptions', adminOnly, async (req, res) => {
  try {
    const { schoolId, courseId, price } = req.body;
    if (!schoolId || !courseId) return res.status(400).json({ error: 'School and course required' });

    const exists = await supabase.from('subscriptions').select('id').eq('school_id', schoolId).eq('course_id', courseId).single();
    if (exists.data) return res.status(409).json({ error: 'Already assigned' });

    let finalPrice = price;
    if (!finalPrice) {
      const { data: course } = await supabase.from('courses').select('price').eq('id', courseId).single();
      finalPrice = course?.price || 0;
    }

    const { data, error } = await supabase.from('subscriptions').insert({
      school_id: schoolId, course_id: courseId, price: parseFloat(finalPrice), status: 'pending'
    }).select(`*, schools(name), courses(name)`).single();
    if (error) throw error;
    res.status(201).json({ subscription: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Activate (confirm payment)
router.post('/subscriptions/:id/activate', adminOnly, async (req, res) => {
  try {
    const { paymentRef, paymentDate, paymentMethod, notes } = req.body;
    if (!paymentRef) return res.status(400).json({ error: 'Payment reference required' });

    const pDate = paymentDate || new Date().toISOString().split('T')[0];
    const expiry = new Date(pDate);
    expiry.setFullYear(expiry.getFullYear() + 1);

    const { data, error } = await supabase.from('subscriptions').update({
      status: 'active',
      payment_ref: paymentRef,
      payment_date: pDate,
      payment_method: paymentMethod || 'bank_transfer',
      expiry_date: expiry.toISOString().split('T')[0],
      activated_by: req.user.email,
      activated_at: new Date().toISOString(),
      notes
    }).eq('id', req.params.id).select(`*, schools(name), courses(name)`).single();

    if (error) throw error;
    await supabase.from('audit_logs').insert({
      action: 'activate_subscription', entity_type: 'subscription', entity_id: req.params.id,
      performed_by: req.user.email, details: { paymentRef, amount: data.price }
    });
    res.json({ subscription: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Revoke access
router.post('/subscriptions/:id/revoke', adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase.from('subscriptions').update({
      status: 'revoked', payment_ref: null, expiry_date: null
    }).eq('id', req.params.id).select().single();
    if (error) throw error;
    await supabase.from('audit_logs').insert({ action: 'revoke_subscription', entity_type: 'subscription', entity_id: req.params.id, performed_by: req.user.email });
    res.json({ subscription: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/subscriptions/:id', adminOnly, async (req, res) => {
  try {
    const { error } = await supabase.from('subscriptions').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Subscription deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════
// SETTINGS — Classes, Subjects, Languages
// ══════════════════════════════════════
router.get('/settings', adminOnly, async (req, res) => {
  try {
    const [classes, subjects, languages] = await Promise.all([
      supabase.from('classes').select('*').order('sort_order'),
      supabase.from('subjects').select('*').order('name'),
      supabase.from('languages').select('*').order('name')
    ]);
    res.json({ classes: classes.data, subjects: subjects.data, languages: languages.data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/settings/classes', adminOnly, async (req, res) => {
  try {
    const { name, sortOrder } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const { data, error } = await supabase.from('classes').insert({ name, sort_order: sortOrder || 0 }).select().single();
    if (error) return res.status(409).json({ error: 'Class already exists' });
    res.status(201).json({ class: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/settings/classes/:id', adminOnly, async (req, res) => {
  try {
    await supabase.from('classes').delete().eq('id', req.params.id);
    res.json({ message: 'Class deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/settings/subjects', adminOnly, async (req, res) => {
  try {
    const { name, emoji } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const { data, error } = await supabase.from('subjects').insert({ name, emoji: emoji || '📚' }).select().single();
    if (error) return res.status(409).json({ error: 'Subject already exists' });
    res.status(201).json({ subject: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/settings/subjects/:id', adminOnly, async (req, res) => {
  try {
    await supabase.from('subjects').delete().eq('id', req.params.id);
    res.json({ message: 'Subject deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/settings/languages', adminOnly, async (req, res) => {
  try {
    const { name, flag } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const { data, error } = await supabase.from('languages').insert({ name, flag: flag || '🌐' }).select().single();
    if (error) return res.status(409).json({ error: 'Language already exists' });
    res.status(201).json({ language: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/settings/languages/:id', adminOnly, async (req, res) => {
  try {
    await supabase.from('languages').delete().eq('id', req.params.id);
    res.json({ message: 'Language deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Audit logs ──
router.get('/audit-logs', adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ logs: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
