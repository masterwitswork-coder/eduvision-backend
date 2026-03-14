const router = require('express').Router();
const supabase = require('../lib/supabase');
const { authMiddleware } = require('../middleware/auth');

const schoolOnly = authMiddleware(['school']);

// ── GET /api/school/dashboard ──
router.get('/dashboard', schoolOnly, async (req, res) => {
  try {
    const schoolId = req.user.id;
    const { data: school } = await supabase.from('schools').select('id, name, email, city, state, contact_person').eq('id', schoolId).single();
    const { data: subs } = await supabase.from('subscriptions')
      .select(`*, courses(id, name, class_name, subject, language, emoji, description)`)
      .eq('school_id', schoolId).order('created_at', { ascending: false });

    const activeSubs = (subs || []).filter(s => s.status === 'active');
    const pendingSubs = (subs || []).filter(s => s.status === 'pending');

    // Count total videos across active subscriptions
    const courseIds = activeSubs.map(s => s.course_id);
    let totalVideos = 0;
    if (courseIds.length > 0) {
      const { count } = await supabase.from('videos').select('id', { count: 'exact', head: true }).in('course_id', courseIds);
      totalVideos = count || 0;
    }

    res.json({ school, activeSubs, pendingSubs, totalVideos });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/school/subscriptions ──
router.get('/subscriptions', schoolOnly, async (req, res) => {
  try {
    const { data, error } = await supabase.from('subscriptions')
      .select(`*, courses(id, name, class_name, subject, language, emoji, price)`)
      .eq('school_id', req.user.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ subscriptions: data });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/school/subscriptions/request ── (School requests a course)
router.post('/subscriptions/request', schoolOnly, async (req, res) => {
  try {
    const { courseId } = req.body;
    if (!courseId) return res.status(400).json({ error: 'Course ID required' });

    const { data: course, error: cErr } = await supabase.from('courses').select('id, name, price, is_active').eq('id', courseId).single();
    if (cErr || !course) return res.status(404).json({ error: 'Course not found' });
    if (!course.is_active) return res.status(400).json({ error: 'Course is not available' });

    const exists = await supabase.from('subscriptions').select('id, status').eq('school_id', req.user.id).eq('course_id', courseId).single();
    if (exists.data) return res.status(409).json({ error: 'Already requested or subscribed' });

    const { data, error } = await supabase.from('subscriptions').insert({
      school_id: req.user.id, course_id: courseId, price: course.price, status: 'pending'
    }).select(`*, courses(name)`).single();
    if (error) throw error;

    await supabase.from('audit_logs').insert({ action: 'request_course', entity_type: 'subscription', entity_id: data.id, performed_by: req.user.email, details: { courseName: course.name } });
    res.status(201).json({ subscription: data, message: 'Request sent. Admin will activate after payment verification.' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/school/courses ── (All available courses with subscription status)
router.get('/courses', schoolOnly, async (req, res) => {
  try {
    const { className, language } = req.query;
    let q = supabase.from('courses').select('id, name, class_name, subject, language, price, description, emoji').eq('is_active', true);
    if (className && className !== 'All') q = q.eq('class_name', className);
    if (language && language !== 'All') q = q.eq('language', language);
    const { data: courses, error } = await q.order('class_name').order('name');
    if (error) throw error;

    // Get this school's subscriptions
    const { data: mySubs } = await supabase.from('subscriptions').select('course_id, status').eq('school_id', req.user.id);
    const subMap = {};
    (mySubs || []).forEach(s => { subMap[s.course_id] = s.status; });

    const enriched = (courses || []).map(c => ({ ...c, subscriptionStatus: subMap[c.id] || null }));
    res.json({ courses: enriched });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/school/courses/:id/videos ── (Only if active subscription)
router.get('/courses/:id/videos', schoolOnly, async (req, res) => {
  try {
    const courseId = req.params.id;

    // Check subscription
    const { data: sub, error: subErr } = await supabase.from('subscriptions')
      .select('status, expiry_date').eq('school_id', req.user.id).eq('course_id', courseId).single();

    if (subErr || !sub) return res.status(403).json({ error: 'No subscription found for this course' });
    if (sub.status !== 'active') return res.status(403).json({ error: 'Subscription not active. Please complete payment.' });

    // Check expiry
    if (sub.expiry_date && new Date(sub.expiry_date) < new Date()) {
      await supabase.from('subscriptions').update({ status: 'expired' }).eq('school_id', req.user.id).eq('course_id', courseId);
      return res.status(403).json({ error: 'Subscription has expired. Please renew.' });
    }

    const { data: course, error: cErr } = await supabase.from('courses').select('*, videos(id, title, youtube_id, duration, sort_order)').eq('id', courseId).single();
    if (cErr || !course) return res.status(404).json({ error: 'Course not found' });

    // Sort videos
    course.videos = (course.videos || []).sort((a, b) => a.sort_order - b.sort_order);

    await supabase.from('audit_logs').insert({ action: 'view_course', entity_type: 'course', entity_id: courseId, performed_by: req.user.email });
    res.json({ course, expiryDate: sub.expiry_date });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
