const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');
const { authMiddleware } = require('../middleware/auth');

// ── POST /api/auth/admin/login ──
router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data: admin, error } = await supabase
      .from('admins').select('*').eq('email', email.toLowerCase()).single();

    if (error || !admin) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: admin.id, email: admin.email, name: admin.name, role: 'admin', isSuper: admin.is_super_admin },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || '7d' }
    );

    // Audit log
    await supabase.from('audit_logs').insert({ action: 'admin_login', entity_type: 'admin', entity_id: admin.id, performed_by: admin.email });

    res.json({ token, user: { id: admin.id, name: admin.name, email: admin.email, role: 'admin' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/school/login ──
router.post('/school/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data: school, error } = await supabase
      .from('schools').select('*').eq('email', email.toLowerCase()).single();

    if (error || !school) return res.status(401).json({ error: 'Invalid credentials' });
    if (!school.is_active) return res.status(403).json({ error: 'Account is disabled. Contact admin.' });

    const valid = await bcrypt.compare(password, school.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: school.id, email: school.email, name: school.name, role: 'school' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || '7d' }
    );

    await supabase.from('audit_logs').insert({ action: 'school_login', entity_type: 'school', entity_id: school.id, performed_by: school.email });

    res.json({ token, user: { id: school.id, name: school.name, email: school.email, role: 'school', city: school.city } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/auth/me ──
router.get('/me', authMiddleware(), (req, res) => {
  res.json({ user: req.user });
});

// ── POST /api/auth/admin/change-password ──
router.post('/admin/change-password', authMiddleware(['admin']), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const { data: admin } = await supabase.from('admins').select('password_hash').eq('id', req.user.id).single();
    const valid = await bcrypt.compare(currentPassword, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    const hash = await bcrypt.hash(newPassword, 10);
    await supabase.from('admins').update({ password_hash: hash }).eq('id', req.user.id);
    res.json({ message: 'Password updated' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
